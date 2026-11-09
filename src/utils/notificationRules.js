// Form and display logic for the Management page. No React here, so it can be tested
// directly. The server validates everything again; these checks only give quick feedback.

const MANAGEMENT_SECTIONS = [
  { id: "notifications", label: "Notification rules", intro: "Choose who is told when an expense check finds something." },
  { id: "delivery", label: "Delivery history", intro: "What was sent, to whom, and what happened." },
  { id: "ocr", label: "OCR analytics", intro: "Receipt scanning use, quality and estimated cost.", needs: "ocrAnalyticsAccess" },
  { id: "audit", label: "Audit history", intro: "Every change made in Management." },
];
/** The sections this person's session allows. The server enforces the same rules. */
export const visibleManagementSections = (user) => MANAGEMENT_SECTIONS.filter((section) => !section.needs || user?.[section.needs] === true);

export const emptyRule = () => ({
  name: "",
  description: "",
  enabled: false,
  anomalyTypes: [],
  severity: "any",
  trigger: "on_submission",
  channel: "in_app",
  recipients: [],
  escalation: { enabled: false, afterHours: 24, recipients: [] },
});

export const ruleToDraft = (rule) => ({
  id: rule.id,
  version: rule.version,
  name: rule.name,
  description: rule.description ?? "",
  enabled: rule.enabled,
  anomalyTypes: [...rule.anomalyTypes],
  severity: rule.severity,
  trigger: rule.trigger,
  channel: rule.channel,
  recipients: rule.recipients,
  escalation: { enabled: rule.escalation?.enabled ?? false, afterHours: rule.escalation?.afterHours ?? 24, recipients: rule.escalation?.recipients ?? [] },
});

/** Field problems as { field: message }. */
export function validateRuleDraft(draft) {
  const errors = {};
  if (!draft.name.trim()) errors.name = "Enter a rule name.";
  if (!draft.anomalyTypes.length) errors.anomalyTypes = "Choose at least one anomaly type.";
  if (draft.enabled && !draft.recipients.length) errors.recipients = "Add at least one recipient before enabling this rule.";
  if (draft.escalation.enabled) {
    if (!draft.escalation.recipients.length) errors.escalation = "Add at least one person to escalate to, or turn escalation off.";
    else if (!(Number.isInteger(draft.escalation.afterHours) && draft.escalation.afterHours >= 1 && draft.escalation.afterHours <= 720)) {
      errors.escalation = "Enter a waiting time from 1 to 720 hours.";
    }
    if (draft.channel !== "in_app") errors.escalation = "Escalation needs in-app notifications.";
  }
  return errors;
}

// Only what the API accepts: the browser sends types and ids, never names or roles.
const recipientPayload = ({ type, userId }) => (type === "user" ? { type, userId } : { type });
export function draftToPayload(draft) {
  return {
    ...(draft.version !== undefined ? { version: draft.version } : {}),
    name: draft.name.trim(),
    description: draft.description.trim(),
    enabled: draft.enabled,
    anomalyTypes: draft.anomalyTypes,
    severity: draft.severity,
    trigger: draft.trigger,
    channel: draft.channel,
    recipients: draft.recipients.map(recipientPayload),
    escalation: { enabled: draft.escalation.enabled, afterHours: draft.escalation.afterHours, recipients: draft.escalation.recipients.map(recipientPayload) },
  };
}

const sameRecipient = (a, b) => a.type === b.type && (a.userId ?? "") === (b.userId ?? "");
/** Adds a recipient once; returns the same list when it is already there. */
export const addRecipient = (list, recipient) => (list.some((item) => sameRecipient(item, recipient)) ? list : [...list, recipient]);
export const removeRecipient = (list, recipient) => list.filter((item) => !sameRecipient(item, recipient));

/** Search box and filters on the rules table. */
export function filterRules(rules, { search = "", status = "all", anomalyType = "" } = {}) {
  const text = search.trim().toLowerCase();
  return rules.filter((rule) => {
    if (status === "on" && !rule.enabled) return false;
    if (status === "off" && rule.enabled) return false;
    if (anomalyType && !rule.anomalyTypes.includes(anomalyType)) return false;
    if (!text) return true;
    return [rule.name, rule.description, ...rule.anomalies.map((a) => a.name), ...rule.recipients.map((r) => r.name)].some((value) => String(value ?? "").toLowerCase().includes(text));
  });
}

/** What needs an administrator's attention on a rule, if anything. */
export function ruleWarning(rule) {
  if (!rule.recipients.length) return "No recipients";
  if (rule.enabled && !rule.deliverable) return "No recipient can be reached";
  if (rule.recipients.some((recipient) => !recipient.resolvable)) return "A recipient can't be reached";
  if (rule.anomalies.every((anomaly) => anomaly.available === false)) return "These checks can't raise findings yet";
  return "";
}

const AUDIT_LABELS = {
  "notification_rule.created": "Created rule",
  "notification_rule.updated": "Changed rule",
  "notification_rule.deleted": "Deleted rule",
  "notification_rule.tested": "Sent a test",
};
export const auditActionLabel = (action) => AUDIT_LABELS[action] ?? action;

const FIELD_NAMES = { name: "name", description: "description", enabled: "enabled", anomalyTypes: "anomaly types", severity: "severity", trigger: "trigger", channel: "channel", recipients: "recipients", escalation: "escalation" };
/** The settings an audit entry changed, in words. */
export function auditChanges(entry) {
  if (!entry.before || !entry.after) return [];
  return Object.keys(FIELD_NAMES).filter((key) => JSON.stringify(entry.before[key]) !== JSON.stringify(entry.after[key])).map((key) => FIELD_NAMES[key]);
}

export const DELIVERY_STATUS = {
  queued: { label: "Queued", tone: "pending" },
  sending: { label: "Sending", tone: "pending" },
  delivered: { label: "Delivered", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  skipped: { label: "Not sent", tone: "warning" },
};
const ERROR_TEXT = {
  RECIPIENT_NOT_FOUND: "The person was not found",
  NO_FINANCE_ADMINS: "There are no Finance administrators",
  RECIPIENT_REQUIRES_CONFIGURATION: "This recipient requires configuration",
  EMAIL_NOT_CONFIGURED: "Email delivery is not connected",
  CHANNEL_NOT_CONFIGURED: "This channel is not connected",
  DELIVERY_FAILED: "Delivery failed",
};
export const deliveryErrorText = (code) => (code ? (ERROR_TEXT[code] ?? code) : "");

export const formatUsd = (value) =>
  value === null || value === undefined ? "No estimate" : `US$${Number(value).toFixed(2)}`;
export const formatRate = (rate) => (rate === null || rate === undefined ? "Not enough data" : `${Math.round(rate * 1000) / 10}%`);
export const formatDuration = (ms) => (ms === null || ms === undefined ? "Not enough data" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

const pad = (n) => String(n).padStart(2, "0");
export const dayInput = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** Date inputs for the last `days` days, ending today. */
export function lastDays(days, now = new Date()) {
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  return { from: dayInput(start), to: dayInput(now) };
}
