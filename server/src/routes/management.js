// Management: notification rules, delivery history, OCR analytics and audit history.
// Who may use each part is decided in one table (middleware/managementAccess.js).
// Rules only decide who is told about an anomaly: nothing here changes an expense,
// its status or its routing.
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errorHandler.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { requireManagementAccess, requireManagementPermission } from "../middleware/managementAccess.js";
import { objectId, validate, validateObjectId } from "../middleware/validate.js";
import { Expense } from "../models/Expense.js";
import { ManagementAudit } from "../models/ManagementAudit.js";
import { NOTIFICATION_STATUSES, NotificationEvent } from "../models/NotificationEvent.js";
import { NotificationRule, RECIPIENT_TYPES, RULE_CHANNELS, RULE_SEVERITIES, RULE_TRIGGERS } from "../models/NotificationRule.js";
import { OCR_SCAN_OUTCOMES } from "../models/OcrScanEvent.js";
import { User } from "../models/User.js";
import { ANOMALY_TYPE_IDS, anomalyById, anomalyTypes, channelAvailable, channelOptions, recipientTypeOptions, SEVERITY_LABEL } from "../services/notifications/catalog.js";
import { idempotencyKey, notificationContent } from "../services/notifications/notificationService.js";
import { processOutbox } from "../services/notifications/outbox.js";
import { describeRecipients, resolveRecipients, validateRecipients } from "../services/notifications/recipients.js";
import { canViewExpense } from "../services/expenseAccess.js";
import { analyticsFilterOptions, buildOcrAnalytics } from "../services/ocrAnalytics.js";

export const managementRouter = Router();
managementRouter.use(requireDatabase, requireManagementAccess);
managementRouter.use("/directory", requireManagementPermission("directory"));
managementRouter.use("/notification-rules", requireManagementPermission("rules"));
managementRouter.use("/notification-events", requireManagementPermission("delivery"));
managementRouter.use("/audit", requireManagementPermission("audit"));
managementRouter.use("/ocr-analytics", requireManagementPermission("ocrAnalytics"));

const actorOf = (user) => ({ id: user.id, name: user.name });

async function audit(user, action, target, { before, after } = {}) {
  await ManagementAudit.create({
    action,
    targetType: target.type,
    targetId: String(target.id),
    targetName: target.name,
    actor: { id: user.id, name: user.name, role: user.role, provider: user.provider },
    before,
    after,
  });
}

// ---------------------------------------------------------------------------
// What can be configured
// ---------------------------------------------------------------------------

// GET /api/management/catalog
managementRouter.get("/catalog", (req, res) => {
  res.json({
    anomalyTypes: anomalyTypes(),
    severities: RULE_SEVERITIES,
    triggers: [
      { id: "on_submission", label: "When saved to My Requests or submitted" },
      { id: "on_save", label: "On every save by the employee" },
    ],
    channels: channelOptions(),
    recipientTypes: recipientTypeOptions(),
    delivery: { notificationsEnabled: env.notifications.enabled, emailProvider: env.notifications.emailProvider },
    environment: { production: env.isProduction },
  });
});

// GET /api/management/directory?q=  People who can be chosen as recipients, by search
// only (at least 2 characters), so the list cannot simply be read out. They appear once
// they have signed in to ReceiptFlow. Holds only what is needed to tell people apart.
const directoryQuery = z.object({ q: z.string().trim().max(100).default("") });
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
managementRouter.get("/directory", validate({ query: directoryQuery }), async (req, res) => {
  const { q } = req.validatedQuery;
  if (q.length < 2) {
    res.json({ people: [] });
    return;
  }
  const pattern = new RegExp(escapeRegex(q), "i");
  const users = await User.find({
    entraUserId: { $type: "string" },
    $or: [{ name: pattern }, { displayName: pattern }, { email: pattern }, { department: pattern }],
  })
    .sort({ name: 1 })
    .limit(20)
    .lean();
  res.json({
    people: users.map((user) => ({
      id: user.entraUserId,
      name: user.displayName || user.name,
      email: user.email || "",
      department: user.department || "",
    })),
  });
});

// ---------------------------------------------------------------------------
// Notification rules
// ---------------------------------------------------------------------------

const recipientSchema = z
  .object({
    type: z.enum(RECIPIENT_TYPES),
    userId: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const ruleFields = {
  name: z.string().trim().min(1, "Enter a rule name.").max(120),
  description: z.string().trim().max(500).default(""),
  enabled: z.boolean().default(false),
  anomalyTypes: z.array(z.enum(ANOMALY_TYPE_IDS)).min(1, "Choose at least one anomaly type.").max(ANOMALY_TYPE_IDS.length),
  severity: z.enum(RULE_SEVERITIES).default("any"),
  trigger: z.enum(RULE_TRIGGERS).default("on_submission"),
  channel: z.enum(RULE_CHANNELS).default("in_app"),
  recipients: z.array(recipientSchema).max(50).default([]),
  escalation: z
    .object({
      enabled: z.boolean().default(false),
      afterHours: z.number().int().min(1).max(720).default(24),
      recipients: z.array(recipientSchema).max(50).default([]),
    })
    .strict()
    .default({ enabled: false, afterHours: 24, recipients: [] }),
};
const ruleCreateSchema = z.object(ruleFields).strict();
const ruleUpdateSchema = z.object({ ...ruleFields, version: z.number().int().min(0) }).strict();

// Checks that need the database or more than one field. Returns clean values.
async function checkRule(input, { existingId } = {}) {
  if (!channelAvailable(input.channel)) {
    throw new HttpError(400, "CHANNEL_NOT_AVAILABLE", "This notification channel is not connected yet. Use in-app notifications.");
  }
  const recipients = await validateRecipients(input.recipients);
  const escalationRecipients = await validateRecipients(input.escalation.recipients);
  if (input.enabled && !recipients.length) {
    throw new HttpError(400, "RECIPIENTS_REQUIRED", "Add at least one recipient before enabling this rule.");
  }
  if (input.escalation.enabled) {
    if (input.channel !== "in_app") {
      throw new HttpError(400, "ESCALATION_NOT_SUPPORTED", "Escalation needs in-app notifications, which record whether they were read.");
    }
    if (!escalationRecipients.length) {
      throw new HttpError(400, "ESCALATION_RECIPIENTS_REQUIRED", "Add at least one person to escalate to, or turn escalation off.");
    }
  }
  const sameName = await NotificationRule.findOne({ name: input.name, deletedAt: null, ...(existingId ? { _id: { $ne: existingId } } : {}) })
    .collation({ locale: "en", strength: 2 })
    .lean();
  if (sameName) throw new HttpError(409, "RULE_NAME_TAKEN", "A notification rule with this name already exists.");
  return {
    ...input,
    anomalyTypes: [...new Set(input.anomalyTypes)],
    recipients,
    escalation: { ...input.escalation, recipients: escalationRecipients },
  };
}

// The rule's settings for the audit trail.
const ruleSnapshot = (rule) => ({
  name: rule.name,
  description: rule.description,
  enabled: rule.enabled,
  anomalyTypes: [...rule.anomalyTypes],
  severity: rule.severity,
  trigger: rule.trigger,
  channel: rule.channel,
  recipients: rule.recipients.map((r) => ({ type: r.type, ...(r.userId ? { userId: r.userId } : {}) })),
  escalation: {
    enabled: Boolean(rule.escalation?.enabled),
    afterHours: rule.escalation?.afterHours,
    recipients: (rule.escalation?.recipients ?? []).map((r) => ({ type: r.type, ...(r.userId ? { userId: r.userId } : {}) })),
  },
});

async function ruleView(rule) {
  const plain = rule.toObject ? rule.toObject() : rule;
  const recipients = await describeRecipients(plain.recipients);
  const escalationRecipients = await describeRecipients(plain.escalation?.recipients ?? []);
  const known = new Map(anomalyTypes().map((type) => [type.id, type]));
  return {
    id: String(plain._id),
    version: plain.__v ?? 0,
    ...ruleSnapshot(plain),
    recipients,
    escalation: { enabled: Boolean(plain.escalation?.enabled), afterHours: plain.escalation?.afterHours ?? 24, recipients: escalationRecipients },
    anomalies: plain.anomalyTypes.map((id) => known.get(id) ?? { id, name: id, available: false }),
    // A rule that is on but nobody could currently receive anything from it.
    deliverable: recipients.some((recipient) => recipient.resolvable),
    createdBy: plain.createdBy,
    updatedBy: plain.updatedBy,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
}

async function findRule(id) {
  const rule = await NotificationRule.findOne({ _id: id, deletedAt: null });
  if (!rule) throw new HttpError(404, "RULE_NOT_FOUND", "Notification rule not found.");
  return rule;
}

// GET /api/management/notification-rules
managementRouter.get("/notification-rules", async (req, res) => {
  const rules = await NotificationRule.find({ deletedAt: null }).sort({ name: 1 }).lean();
  res.json({ rules: await Promise.all(rules.map(ruleView)) });
});

// POST /api/management/notification-rules
managementRouter.post("/notification-rules", validate({ body: ruleCreateSchema }), async (req, res) => {
  const values = await checkRule(req.body);
  const rule = await NotificationRule.create({ ...values, createdBy: actorOf(req.user), updatedBy: actorOf(req.user) });
  await audit(req.user, "notification_rule.created", { type: "notification_rule", id: rule._id, name: rule.name }, { after: ruleSnapshot(rule) });
  res.status(201).json(await ruleView(rule));
});

// PUT /api/management/notification-rules/:id  Refused when someone else saved first.
managementRouter.put("/notification-rules/:id", validateObjectId(), validate({ body: ruleUpdateSchema }), async (req, res) => {
  const rule = await findRule(req.params.id);
  const { version, ...input } = req.body;
  if (rule.__v !== version) {
    throw new HttpError(409, "RULE_CHANGED", "Someone else changed this rule. Reload it and make your change again.");
  }
  const values = await checkRule(input, { existingId: rule._id });
  const before = ruleSnapshot(rule);
  const updated = await NotificationRule.findOneAndUpdate(
    { _id: rule._id, __v: version, deletedAt: null },
    { $set: { ...values, updatedBy: actorOf(req.user) }, $inc: { __v: 1 } },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw new HttpError(409, "RULE_CHANGED", "Someone else changed this rule. Reload it and make your change again.");
  await audit(req.user, "notification_rule.updated", { type: "notification_rule", id: rule._id, name: updated.name }, { before, after: ruleSnapshot(updated) });
  res.json(await ruleView(updated));
});

// DELETE /api/management/notification-rules/:id  Kept for history; no longer listed or matched.
managementRouter.delete("/notification-rules/:id", validateObjectId(), async (req, res) => {
  const rule = await findRule(req.params.id);
  const before = ruleSnapshot(rule);
  rule.deletedAt = new Date();
  rule.enabled = false;
  rule.updatedBy = actorOf(req.user);
  await rule.save();
  await audit(req.user, "notification_rule.deleted", { type: "notification_rule", id: rule._id, name: rule.name }, { before });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Test notifications
// ---------------------------------------------------------------------------

const testLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // Per person: everyone in an office can share one IP address.
  keyGenerator: (req) => `user:${req.user.id}`,
  handler: (req, res) => res.status(429).json({ error: "RATE_LIMITED", message: "Too many test notifications. Please wait and retry." }),
});
const testSchema = z.object({ confirm: z.boolean().default(false) }).strict();

// POST /api/management/notification-rules/:id/test
// Made-up details only: no expense is read, created or changed. Outside production
// nothing reaches anyone (recorded through the mock provider). In production it needs
// { confirm: true } and goes to the rule's recipients, clearly labelled TEST.
managementRouter.post("/notification-rules/:id/test", testLimiter, validateObjectId(), validate({ body: testSchema }), async (req, res) => {
  const rule = await findRule(req.params.id);
  const { people, unresolved } = await resolveRecipients(rule.recipients);
  if (!people.length) {
    throw new HttpError(400, "NO_RECIPIENTS", "This rule has no recipient who can be reached right now. Add one, then test again.");
  }
  const anomaly = anomalyById.get(rule.anomalyTypes[0]);
  const severity = SEVERITY_LABEL[anomaly?.severity] ?? "Warning";
  const requestNumber = "RF-TEST00";
  const anomalyName = anomaly?.name ?? rule.anomalyTypes[0];

  const channelReady = channelAvailable(rule.channel);
  const mock = !env.isProduction;
  if (channelReady && !mock && !req.body.confirm) {
    throw new HttpError(409, "CONFIRMATION_REQUIRED", `This sends a real TEST notification to ${people.length} ${people.length === 1 ? "person" : "people"}. Confirm to send it.`, [
      { path: "confirm", message: "Confirmation required", recipients: people.length },
    ]);
  }
  const testRun = randomUUID();
  const now = new Date();
  const events = people.map((person) => ({
    idempotencyKey: idempotencyKey("test", testRun, person.id),
    test: true,
    testBy: actorOf(req.user),
    ruleId: rule._id,
    ruleName: rule.name,
    requestNumber,
    anomalyType: rule.anomalyTypes[0],
    anomalyName,
    severity,
    recipientId: person.id,
    recipientName: person.name,
    recipientEmail: person.email,
    channel: rule.channel,
    ...notificationContent({ requestNumber, anomalyName, severity, test: true }),
    ...(!channelReady
      ? { status: "skipped", lastErrorCode: "CHANNEL_NOT_CONFIGURED" }
      : mock
        ? { status: "delivered", provider: "mock", deliveredAt: now }
        : { status: "queued" }),
  }));
  const saved = await NotificationEvent.insertMany(events);
  await audit(req.user, "notification_rule.tested", { type: "notification_rule", id: rule._id, name: rule.name }, {
    after: { channel: rule.channel, recipients: people.length, mode: !channelReady ? "not_configured" : mock ? "mock" : "live" },
  });
  if (!channelReady) {
    res.json({ status: "not_configured", sent: false, message: "Nothing was sent: this channel is not connected yet.", recipients: people.length, unresolved: unresolved.length });
    return;
  }
  if (mock) {
    res.json({ status: "mocked", sent: false, message: `TEST recorded for ${people.length} recipient(s) with the mock provider. Nothing was sent.`, recipients: people.length, unresolved: unresolved.length });
    return;
  }
  const outcome = await processOutbox({ onlyIds: saved.map((event) => event._id) });
  res.json({ status: outcome.delivered === people.length ? "delivered" : "partial", sent: outcome.delivered > 0, message: `TEST delivered to ${outcome.delivered} of ${people.length} recipient(s).`, recipients: people.length, unresolved: unresolved.length });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const eventsQuery = z.object({
  test: z.enum(["true", "false"]).default("false"),
  status: z.enum(NOTIFICATION_STATUSES).optional(),
  ruleId: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).max(100000).default(0),
});

// A notification about a request this viewer may not open shows that it happened, not
// which request it was. Finance may open every request, so sees them all.
async function eventsForViewer(docs, viewer) {
  const events = docs.map((doc) => doc.toJSON());
  if (viewer.role === "FINANCE_ADMIN") return events;
  const ids = events.map((event) => event.expenseId).filter(Boolean);
  const expenses = ids.length ? await Expense.find({ _id: { $in: ids } }, { employeeId: 1, assignedApproverId: 1 }).lean() : [];
  const viewable = new Set(expenses.filter((expense) => canViewExpense(viewer, expense)).map((expense) => String(expense._id)));
  return events.map((event) => {
    if (!event.expenseId || viewable.has(String(event.expenseId))) return event;
    const { requestNumber, title, body, expenseId, ...rest } = event;
    return { ...rest, requestHidden: true };
  });
}

// GET /api/management/notification-events  Real and TEST activity are listed separately.
managementRouter.get("/notification-events", validate({ query: eventsQuery }), async (req, res) => {
  const { test, status, ruleId, limit, skip } = req.validatedQuery;
  const filter = { test: test === "true" ? true : { $ne: true }, ...(status ? { status } : {}), ...(ruleId ? { ruleId } : {}) };
  const [docs, total] = await Promise.all([
    NotificationEvent.find(filter, { idempotencyKey: 0, recipientEmail: 0, lockedAt: 0 }).sort({ createdAt: -1 }).skip(skip).limit(limit),
    NotificationEvent.countDocuments(filter),
  ]);
  res.json({ events: await eventsForViewer(docs, { ...req.user, role: req.managementRole }), total });
});

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).max(100000).default(0),
  targetId: z.string().trim().max(100).optional(),
});

// GET /api/management/audit
managementRouter.get("/audit", validate({ query: auditQuery }), async (req, res) => {
  const { limit, skip, targetId } = req.validatedQuery;
  const filter = targetId ? { targetId } : {};
  const [entries, total] = await Promise.all([ManagementAudit.find(filter).sort({ at: -1 }).skip(skip).limit(limit), ManagementAudit.countDocuments(filter)]);
  res.json({ entries, total });
});

// ---------------------------------------------------------------------------
// OCR analytics
// ---------------------------------------------------------------------------

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const analyticsQuery = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
  employeeId: z.string().trim().min(1).max(100).optional(),
  department: z.string().trim().min(1).max(200).optional(),
  provider: z.string().trim().min(1).max(50).optional(),
  outcome: z.enum(OCR_SCAN_OUTCOMES).optional(),
});

// GET /api/management/ocr-analytics  Default: the last 30 days.
managementRouter.get("/ocr-analytics", validate({ query: analyticsQuery }), async (req, res) => {
  const day = (date) => date.toISOString().slice(0, 10);
  const to = req.validatedQuery.to ?? day(new Date(Date.now() + 8 * 3600 * 1000));
  const from = req.validatedQuery.from ?? day(new Date(new Date(`${to}T00:00:00Z`).getTime() - 29 * 24 * 3600 * 1000));
  if (from > to) throw new HttpError(400, "INVALID_DATE_RANGE", "The start date must be on or before the end date.");
  const [report, options] = await Promise.all([buildOcrAnalytics({ ...req.validatedQuery, from, to }), analyticsFilterOptions()]);
  res.json({ ...report, options });
});
