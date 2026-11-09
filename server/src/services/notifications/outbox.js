// Delivers the MongoDB-backed outbox (notificationEvents). Safe on several server
// instances: a record is claimed atomically before it is delivered, and a claim left
// behind by a stopped server expires and is retried.
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { NotificationEvent } from "../../models/NotificationEvent.js";
import { NotificationRule } from "../../models/NotificationRule.js";
import { resolveRecipients } from "./recipients.js";

export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];
const STALE_CLAIM_MS = 5 * 60_000;

class DeliveryError extends Error {
  constructor(code, { permanent = false } = {}) {
    super(code);
    this.code = code;
    this.permanent = permanent;
  }
}

// In-app: the record itself is what the recipient's inbox shows.
// Email: no real transport is connected. "mock" records only; nothing leaves the server.
const defaultProviders = {
  in_app: async () => ({ provider: "in_app" }),
  email: async () => {
    if (env.notifications.emailProvider === "mock") return { provider: "mock" };
    throw new DeliveryError("EMAIL_NOT_CONFIGURED", { permanent: true });
  },
};
let providers = defaultProviders;

/** Test hook: replace a delivery provider. */
export function __setProviders(overrides) {
  providers = overrides ? { ...defaultProviders, ...overrides } : defaultProviders;
}

// Codes only: a provider's own error text can contain addresses or credentials.
const safeCode = (error) => (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,48}$/.test(error.code) ? error.code : "DELIVERY_FAILED");

export function nextRetryDelay(attempts) {
  return RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
}

async function deliver(event, now) {
  const provider = providers[event.channel];
  try {
    if (!provider) throw new DeliveryError("CHANNEL_UNKNOWN", { permanent: true });
    const result = await provider(event);
    await NotificationEvent.updateOne(
      { _id: event._id, status: "sending" },
      { $set: { status: "delivered", deliveredAt: new Date(), provider: result?.provider ?? event.channel }, $unset: { lockedAt: 1, lastErrorCode: 1 } },
    );
    return "delivered";
  } catch (error) {
    const code = safeCode(error);
    const final = error.permanent ? "skipped" : event.attempts >= event.maxAttempts ? "failed" : null;
    await NotificationEvent.updateOne(
      { _id: event._id, status: "sending" },
      final
        ? { $set: { status: final, lastErrorCode: code }, $unset: { lockedAt: 1 } }
        : { $set: { status: "queued", lastErrorCode: code, nextAttemptAt: new Date(now.getTime() + nextRetryDelay(event.attempts)) }, $unset: { lockedAt: 1 } },
    );
    console.error(`[notifications] delivery ${final ?? "will retry"} for ${event._id}: ${code}`);
    return final ?? "retrying";
  }
}

/** Follow-ups for in-app notifications still unread after the rule's waiting time. */
export async function processEscalations({ now = new Date(), limit = 25 } = {}) {
  let created = 0;
  for (let i = 0; i < limit; i += 1) {
    const original = await NotificationEvent.findOneAndUpdate(
      { escalateAfter: { $lte: now }, status: "delivered", readAt: null, escalatedAt: null, test: { $ne: true } },
      { $set: { escalatedAt: now }, $unset: { escalateAfter: 1 } },
      { returnDocument: "after" },
    );
    if (!original) break;
    const rule = await NotificationRule.findOne({ _id: original.ruleId, enabled: true, deletedAt: null, "escalation.enabled": true }).lean();
    if (!rule) continue;
    const { people } = await resolveRecipients(rule.escalation.recipients);
    for (const person of people) {
      if (person.id === original.recipientId) continue;
      const key = createHash("sha256").update(`escalation|${original._id}|${person.id}`).digest("hex");
      const updated = await NotificationEvent.updateOne(
        { idempotencyKey: key },
        {
          $setOnInsert: {
            idempotencyKey: key,
            test: false,
            ruleId: original.ruleId,
            ruleName: original.ruleName,
            expenseId: original.expenseId,
            requestNumber: original.requestNumber,
            anomalyType: original.anomalyType,
            anomalyName: original.anomalyName,
            severity: original.severity,
            channel: original.channel,
            recipientId: person.id,
            recipientName: person.name,
            recipientEmail: person.email,
            title: `Escalated: ${original.title}`.slice(0, 200),
            body: original.body,
            escalationOf: original._id,
            status: "queued",
            attempts: 0,
            maxAttempts: 5,
            nextAttemptAt: now,
          },
        },
        { upsert: true },
      );
      created += updated.upsertedCount ?? 0;
    }
  }
  return created;
}

/** @returns {Promise<{ delivered: number, retrying: number, failed: number, skipped: number }>} */
export async function processOutbox({ now = new Date(), limit = 50, onlyIds } = {}) {
  const summary = { delivered: 0, retrying: 0, failed: 0, skipped: 0 };
  await NotificationEvent.updateMany(
    { status: "sending", lockedAt: { $lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
    { $set: { status: "queued" }, $unset: { lockedAt: 1 } },
  );
  for (let i = 0; i < limit; i += 1) {
    const event = await NotificationEvent.findOneAndUpdate(
      { status: "queued", nextAttemptAt: { $lte: now }, ...(onlyIds ? { _id: { $in: onlyIds } } : {}) },
      { $set: { status: "sending", lockedAt: now }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, returnDocument: "after" },
    );
    if (!event) break;
    summary[await deliver(event, now)] += 1;
  }
  return summary;
}

let running = false;
async function runOnce() {
  if (running || mongoose.connection.readyState !== 1) return;
  running = true;
  try {
    await processEscalations();
    await processOutbox();
  } catch (error) {
    console.error(`[notifications] worker run failed: ${error.name}`);
  } finally {
    running = false;
  }
}

/** Delivers soon after an anomaly is queued, without making the employee's request wait. */
export function kickOutbox() {
  setImmediate(runOnce).unref?.();
}

let started = false;
export function startNotificationWorker() {
  if (!env.notifications.enabled || started) return;
  started = true;
  console.info(`[notifications] outbox worker every ${env.notifications.workerIntervalSeconds} s (email provider: ${env.notifications.emailProvider}).`);
  setInterval(runOnce, env.notifications.workerIntervalSeconds * 1000).unref();
  void runOnce();
}
