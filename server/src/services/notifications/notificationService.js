// Anomaly found → matching rules → recipients → duplicate check → outbox.
//
// Only ever writes notification records. It never changes the expense, its status or
// its routing, and nothing here triggers a save or an anomaly check, so a notification
// cannot cause another one. Failures are logged and never stop the expense being saved.
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { NotificationEvent } from "../../models/NotificationEvent.js";
import { NotificationRule } from "../../models/NotificationRule.js";
import { SEVERITY_LABEL } from "./catalog.js";
import { kickOutbox } from "./outbox.js";
import { resolveRecipients } from "./recipients.js";

const FINDING_STATUSES = new Set(["flagged", "needs_review"]);

// Details that change without the anomaly itself changing: running monthly totals, or
// how many details are still missing while the employee fills them in.
const VOLATILE_DETAILS = new Set(["previousAmount", "monthlyTotal", "countedExpenses", "excessAmount", "missing", "confirmedFields", "dateReview"]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !VOLATILE_DETAILS.has(key))
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

/** Identifies what an anomaly says, so an unchanged one is not notified twice and a changed one is. */
export function anomalyFingerprint(anomaly) {
  return JSON.stringify([anomaly.ruleId, anomaly.status, stable(anomaly.details ?? {})]);
}

export const idempotencyKey = (...parts) => createHash("sha256").update(parts.map(String).join("|")).digest("hex");

export function ruleMatches(rule, anomaly, trigger) {
  if (!rule.anomalyTypes.includes(anomaly.ruleId)) return false;
  if (rule.severity !== "any" && rule.severity !== (SEVERITY_LABEL[anomaly.severity] ?? "Warning")) return false;
  return rule.trigger === "on_save" || trigger === "submission";
}

// The minimum needed to act on it: no merchant, amounts, message text or employee
// details. The recipient opens the request, which applies the normal access rules.
export function notificationContent({ requestNumber, anomalyName, severity, test = false }) {
  const prefix = test ? "[TEST] " : "";
  return {
    title: `${prefix}Expense check: ${anomalyName}`.slice(0, 200),
    body: (test
      ? `This is a TEST with made-up details. No expense is affected. Request ${requestNumber} · ${anomalyName} (${severity}).`
      : `Request ${requestNumber} needs attention: ${anomalyName} (${severity}). Open ReceiptFlow to review it.`
    ).slice(0, 500),
  };
}

async function insertEvents(events) {
  if (!events.length) return 0;
  try {
    return (await NotificationEvent.insertMany(events, { ordered: false })).length;
  } catch (error) {
    // Records already notified are refused by the unique key; the others are saved.
    if (error?.code === 11000 || error?.writeErrors?.every?.((item) => item.code === 11000)) {
      return error.insertedDocs?.length ?? error.result?.insertedCount ?? 0;
    }
    throw error;
  }
}

/** @returns {Promise<{ queued: number, disabled?: boolean }>} never throws */
export async function queueAnomalyNotifications({ expense, report, trigger }) {
  try {
    if (!env.notifications.enabled) return { queued: 0, disabled: true };
    if (mongoose.connection.readyState !== 1 || !report || expense.incompleteDraft) return { queued: 0 };
    const resolved = new Set(
      (expense.policyViolations ?? []).filter((v) => v.status === "Resolved").map((v) => String(v.id).replace(/^anomaly-/, "")),
    );
    const anomalies = report.anomalies.filter((a) => FINDING_STATUSES.has(a.status) && !resolved.has(a.ruleId));
    if (!anomalies.length) return { queued: 0 };
    const rules = await NotificationRule.find({ enabled: true, deletedAt: null, anomalyTypes: { $in: anomalies.map((a) => a.ruleId) } }).lean();

    const events = [];
    for (const rule of rules) {
      const matching = anomalies.filter((anomaly) => ruleMatches(rule, anomaly, trigger));
      if (!matching.length) continue;
      const { people, unresolved } = await resolveRecipients(rule.recipients);
      for (const anomaly of matching) {
        const fingerprint = anomalyFingerprint(anomaly);
        const severity = SEVERITY_LABEL[anomaly.severity] ?? "Warning";
        const shared = {
          test: false,
          ruleId: rule._id,
          ruleName: rule.name,
          expenseId: expense._id,
          requestNumber: expense.requestNumber,
          anomalyType: anomaly.ruleId,
          anomalyName: anomaly.name,
          severity,
          channel: rule.channel,
          ...notificationContent({ requestNumber: expense.requestNumber, anomalyName: anomaly.name, severity }),
        };
        const key = (who) => idempotencyKey(rule._id, expense._id, fingerprint, who, rule.channel);
        for (const recipient of people) {
          events.push({
            ...shared,
            idempotencyKey: key(recipient.id),
            recipientId: recipient.id,
            recipientName: recipient.name,
            recipientEmail: recipient.email,
            ...(rule.escalation?.enabled && rule.channel === "in_app"
              ? { escalateAfter: new Date(Date.now() + rule.escalation.afterHours * 3600 * 1000) }
              : {}),
          });
        }
        // A person who no longer exists is on record, not silently dropped.
        for (const missing of unresolved) {
          events.push({
            ...shared,
            idempotencyKey: key(`${missing.type}:${missing.userId ?? ""}`),
            recipientId: missing.userId,
            recipientName: missing.type === "user" ? "Person not found" : "No recipient available",
            status: "skipped",
            lastErrorCode: missing.code,
          });
        }
      }
    }
    const queued = await insertEvents(events);
    if (queued) kickOutbox();
    return { queued };
  } catch (error) {
    console.error(`[notifications] could not queue for ${expense?.requestNumber ?? "expense"}: ${error.name}`);
    return { queued: 0, error: true };
  }
}
