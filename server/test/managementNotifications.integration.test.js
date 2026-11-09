// Management, notification rules and delivery, OCR analytics and duplicate prevention,
// through the real routes on a throwaway in-memory MongoDB. Google is mocked: no
// billable call, no email, no webhook.
import "./setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { env } from "../src/config/env.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { Category } from "../src/models/Category.js";
import { Expense } from "../src/models/Expense.js";
import { ManagementAudit } from "../src/models/ManagementAudit.js";
import { NotificationEvent } from "../src/models/NotificationEvent.js";
import { NotificationRule } from "../src/models/NotificationRule.js";
import { OcrScanEvent } from "../src/models/OcrScanEvent.js";
import { ReceiptJob } from "../src/models/ReceiptJob.js";
import { User } from "../src/models/User.js";
import { MANAGEMENT_POLICY, managementAllows, requireManagementAccess } from "../src/middleware/managementAccess.js";
import { createApp } from "../src/app.js";
import { expensesRouter } from "../src/routes/expenses.js";
import { managementRouter } from "../src/routes/management.js";
import { notificationsRouter } from "../src/routes/notifications.js";
import { receiptsRouter } from "../src/routes/receipts.js";
import { anomalyRules } from "../src/services/anomaly/anomalyRules.js";
import { __setTestHooks } from "../src/services/googleDocumentAiService.js";
import { NEVER_FIRES } from "../src/services/notifications/catalog.js";
import { anomalyFingerprint, queueAnomalyNotifications, ruleMatches } from "../src/services/notifications/notificationService.js";
import { __setProviders, nextRetryDelay, processEscalations, processOutbox } from "../src/services/notifications/outbox.js";
import { billabilityOfFailure, estimateOcrCost } from "../src/services/ocrScanEvents.js";
import { cleanupAbandonedReceiptFiles } from "../src/services/receiptCleanup.js";
import { liveShapedSyntheticDocument } from "./fixtures/documentAi.js";
import { grpcError } from "./fixtures/documentAi.js";

const RECEIPT_JPG = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/synthetic-receipt.jpg"));
const USERS = {
  alice: { id: "oid-alice", name: "Alice Employee", provider: "entra", role: "EMPLOYEE", department: "Sales", jobTitle: "" },
  bob: { id: "oid-bob", name: "Bob Employee", provider: "entra", role: "EMPLOYEE", department: "Service", jobTitle: "" },
  approver: { id: "oid-appr", name: "Amy Approver", provider: "entra", role: "APPROVER" },
  finance: { id: "oid-fin", name: "Fay Finance", provider: "entra", role: "FINANCE_ADMIN", department: "Finance" },
  // A session that still says FINANCE_ADMIN, for someone whose role was removed.
  demoted: { id: "oid-demoted", name: "Dan Demoted", provider: "entra", role: "FINANCE_ADMIN" },
  beta: { id: "beta-user", name: "ReceiptFlow Beta User", provider: "beta", role: "FINANCE_ADMIN" },
};

let mongo;
let server;
let api;
let googleCalls = 0;
let googleImpl;

before(async () => {
  mongo = await MongoMemoryServer.create();
  env.mongoUri = mongo.getUri();
  await mongoose.connect(env.mongoUri, { dbName: "receiptflow-mgmt-test" });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = USERS[req.get("x-test-user") ?? "alice"];
    next();
  });
  app.use("/api/expenses", expensesRouter);
  app.use("/api/receipts", receiptsRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/management", managementRouter);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  api = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await mongoose.disconnect();
  await mongo?.stop();
  env.mongoUri = "";
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  for (const model of [ReceiptJob, NotificationEvent, NotificationRule, OcrScanEvent, User, ManagementAudit]) await model.syncIndexes();
  await Category.create({ name: "Meals", active: true });
  await User.create([
    { name: "Alice Employee", email: "alice@example.test", entraUserId: "oid-alice", role: "EMPLOYEE", department: "Sales" },
    { name: "Bob Employee", email: "bob@example.test", entraUserId: "oid-bob", role: "EMPLOYEE", department: "Service" },
    { name: "Amy Approver", email: "amy@example.test", entraUserId: "oid-appr", role: "APPROVER" },
    { name: "Fay Finance", email: "fay@example.test", entraUserId: "oid-fin", role: "FINANCE_ADMIN", department: "Finance" },
    { name: "Dan Demoted", email: "dan@example.test", entraUserId: "oid-demoted", role: "EMPLOYEE" },
  ]);
  env.approvalWorkflowEnabled = false;
  env.notifications.enabled = true;
  env.notifications.emailProvider = "none";
  env.isProduction = false;
  env.ocrReusePriorScanDays = 30;
  env.ocrCost.monthlyBudgetUsd = 0;
  __setProviders();
  googleCalls = 0;
  googleImpl = async () => [{ document: liveShapedSyntheticDocument() }];
  __setTestHooks({
    factory: () => ({
      processDocument: async (...args) => {
        googleCalls += 1;
        return googleImpl(...args);
      },
    }),
  });
});

async function call(method, route, body, user = "finance") {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function upload(bytes = RECEIPT_JPG, user = "alice") {
  const form = new FormData();
  form.append("receipt", new Blob([bytes], { type: "image/jpeg" }), "synthetic-receipt.jpg");
  const response = await fetch(`${api}/receipts/upload`, { method: "POST", headers: { "x-test-user": user }, body: form });
  return { status: response.status, body: await response.json() };
}
const validRule = (overrides = {}) => ({
  name: "Corrected totals to Finance",
  enabled: true,
  anomalyTypes: ["ocr_total_corrected"],
  recipients: [{ type: "finance_admins" }],
  ...overrides,
});
// A request saved from the mocked scan, with the total changed so an anomaly is found.
async function scannedRequest(user = "alice", changes = { amount: 400 }) {
  const scan = await upload(RECEIPT_JPG, user);
  const { status, jobId, id, ...extracted } = scan.body.expense;
  const created = await call(
    "POST",
    "/expenses",
    {
      ...extracted,
      receiptJobId: scan.body.jobId,
      category: "Meals",
      purpose: "Client lunch",
      location: "Makati",
      position: "Engineer",
      department: "Sales",
      ocrConfirmations: { expenseDate: extracted.expenseDate, currency: extracted.currency },
      ...changes,
    },
    user,
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}
const submit = (id, user = "alice", expense) => call("POST", `/expenses/${id}/submit`, expense ? { expense } : {}, user);
const realEvents = () => NotificationEvent.find({ test: { $ne: true } }).lean();

describe("Authorization", () => {
  const ruleRoutes = [
    ["GET", "/management/catalog"],
    ["GET", "/management/directory?q=bob"],
    ["GET", "/management/notification-rules"],
    ["GET", "/management/notification-events"],
    ["GET", "/management/audit"],
  ];
  for (const who of ["alice", "approver", "finance", "demoted"]) {
    test(`${who} may use notification management`, async () => {
      for (const [method, route] of ruleRoutes) assert.equal((await call(method, route, undefined, who)).status, 200, `${method} ${route}`);
    });
  }

  test("an ordinary employee can create, edit, disable and delete a rule, and is named in the audit trail", async () => {
    const created = await call("POST", "/management/notification-rules", validRule({ recipients: [{ type: "user", userId: "oid-bob" }] }), "alice");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.createdBy.name, "Alice Employee");
    const edited = await call("PUT", `/management/notification-rules/${created.body.id}`, { ...validRule({ enabled: false, name: "Changed by Bob" }), version: created.body.version }, "bob");
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.updatedBy.name, "Bob Employee");
    assert.equal((await call("DELETE", `/management/notification-rules/${created.body.id}`, undefined, "alice")).status, 204);
    const entries = await ManagementAudit.find().sort({ at: 1 }).lean();
    assert.deepEqual(entries.map((entry) => [entry.action, entry.actor.id]), [
      ["notification_rule.created", "oid-alice"],
      ["notification_rule.updated", "oid-bob"],
      ["notification_rule.deleted", "oid-alice"],
    ]);
    assert.equal(entries[1].before.enabled, true);
    assert.equal(entries[1].after.enabled, false);
  });

  test("input is still validated for everyone", async () => {
    assert.equal((await call("POST", "/management/notification-rules", validRule({ anomalyTypes: ["made_up"] }), "alice")).status, 400);
    assert.equal((await call("POST", "/management/notification-rules", validRule({ recipients: [{ type: "user", userId: "oid-nobody" }] }), "alice")).body.error, "RECIPIENT_NOT_FOUND");
    assert.equal((await call("POST", "/management/notification-rules", validRule({ updatedBy: { id: "someone-else" } }), "alice")).status, 400);
  });

  test("the shared beta account is refused everywhere, whatever its role", async () => {
    for (const [method, route, body] of [...ruleRoutes, ["POST", "/management/notification-rules", validRule()], ["GET", "/management/ocr-analytics"]]) {
      const response = await call(method, route, body, "beta");
      assert.equal(response.status, 403, `${method} ${route}`);
    }
    assert.equal(await NotificationRule.countDocuments(), 0);
    await assert.rejects(
      () => requireManagementAccess({ user: USERS.beta }, {}, () => {}),
      (error) => error.status === 403,
    );
  });

  test("OCR analytics stays with Finance; a stale session cannot keep it", async () => {
    for (const who of ["alice", "approver", "demoted", "beta"]) {
      assert.equal((await call("GET", "/management/ocr-analytics", undefined, who)).status, 403, who);
    }
    assert.equal((await call("GET", "/management/ocr-analytics")).status, 200);
    await User.updateOne({ entraUserId: "oid-fin" }, { role: "EMPLOYEE" });
    assert.equal((await call("GET", "/management/ocr-analytics")).status, 403);
  });

  test("someone removed from the users collection loses access at once", async () => {
    await User.deleteOne({ entraUserId: "oid-alice" });
    assert.equal((await call("GET", "/management/catalog", undefined, "alice")).status, 403);
  });

  test("restrictions live in one table, so a role can be required again without touching the routes", () => {
    assert.equal(managementAllows(USERS.alice, "rules"), true);
    assert.equal(managementAllows(USERS.alice, "ocrAnalytics"), false);
    assert.equal(managementAllows(USERS.finance, "ocrAnalytics"), true);
    assert.equal(managementAllows(USERS.beta, "rules"), false);
    assert.deepEqual(Object.keys(MANAGEMENT_POLICY).sort(), ["audit", "delivery", "directory", "ocrAnalytics", "rules"]);
    assert.ok(Object.isFrozen(MANAGEMENT_POLICY));
  });

  test("expense access did not change: Management never opens another employee's expense", async () => {
    await call("POST", "/management/notification-rules", validRule({ recipients: [{ type: "user", userId: "oid-bob" }] }), "bob");
    const request = await scannedRequest("alice");
    await submit(request.id);
    await processOutbox();
    assert.equal((await call("GET", `/expenses/${request.id}`, undefined, "bob")).status, 404);
    assert.equal((await call("GET", `/expenses/${request.id}/receipt`, undefined, "bob")).status, 404);
    assert.equal((await call("PATCH", `/expenses/${request.id}`, { purpose: "x" }, "bob")).status, 404);
    assert.equal((await call("GET", `/receipts/${request.receiptJobId}/status`, undefined, "bob")).status, 404);
    assert.equal((await Expense.findById(request.id).lean()).status, "Pending Workflow Setup");
  });
});

describe("The real application stack", () => {
  let appServer;
  let base;
  before(async () => {
    appServer = createApp().listen(0);
    await new Promise((resolve) => appServer.once("listening", resolve));
    base = `http://127.0.0.1:${appServer.address().port}/api`;
  });
  after(async () => {
    env.betaAuth.enabled = false;
    await new Promise((resolve) => appServer?.close(resolve));
  });

  test("every Management and inbox route needs a session", async () => {
    for (const route of ["/management/catalog", "/management/notification-rules", "/management/ocr-analytics", "/management/audit", "/notifications"]) {
      assert.equal((await fetch(`${base}${route}`)).status, 401, route);
    }
  });

  test("beta sign-in with an admin role gets no Management, in the session flags or the API", async () => {
    Object.assign(env.betaAuth, { enabled: true, username: "beta-tester", password: "synthetic-password", role: "FINANCE_ADMIN" });
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "beta-tester", password: "synthetic-password" }) });
    const { sessionToken, features } = await login.json();
    assert.equal(features.management, false);
    assert.equal(features.ocrAnalytics, false);
    assert.equal(features.approvalWorkflow, false);
    const headers = { authorization: `Bearer ${sessionToken}` };
    for (const route of ["/management/catalog", "/management/directory?q=alice", "/management/notification-rules", "/management/audit", "/management/ocr-analytics"]) {
      assert.equal((await fetch(`${base}${route}`, { headers })).status, 403, route);
    }
  });
});

describe("Catalog", () => {
  test("anomaly types come from the engine; nothing is invented", async () => {
    const { body } = await call("GET", "/management/catalog");
    assert.deepEqual(body.anomalyTypes.map((type) => type.id), anomalyRules.map((rule) => rule.id));
    assert.ok(body.anomalyTypes.find((type) => type.id === "ocr_total_corrected").available);
    assert.equal(body.anomalyTypes.find((type) => type.id === "meals_charged_while_on_leave").available, false);
  });

  test("rules marked as never firing really only report not_evaluated", async () => {
    for (const id of Object.keys(NEVER_FIRES)) {
      const rule = anomalyRules.find((item) => item.id === id);
      assert.ok(rule, id);
      for (const ocr of [null, { unavailableSignals: ["provider_fraud_signal"] }]) {
        assert.equal(rule.evaluate({ ocr, expense: {} }).status, "not_evaluated", id);
      }
    }
  });

  test("the manager option and email are shown as unavailable, not as working", async () => {
    const { body } = await call("GET", "/management/catalog");
    const manager = body.recipientTypes.find((type) => type.id === "employee_manager");
    assert.equal(manager.available, false);
    assert.match(manager.unavailableReason, /Requires configuration/);
    assert.equal(body.channels.find((channel) => channel.id === "email").available, false);
    assert.equal(body.channels.find((channel) => channel.id === "in_app").available, true);
  });

  test("the directory is searchable, escapes patterns and holds no tokens", async () => {
    const { body } = await call("GET", "/management/directory?q=bob");
    assert.deepEqual(body.people, [{ id: "oid-bob", name: "Bob Employee", email: "bob@example.test", department: "Service" }]);
    assert.equal((await call("GET", "/management/directory?q=.*")).body.people.length, 0);
    assert.equal((await call("GET", "/management/directory", undefined, "alice")).body.people.length, 0, "the list cannot simply be read out");
    assert.equal((await call("GET", "/management/directory?q=a", undefined, "alice")).body.people.length, 0);
  });
});

describe("Notification rules", () => {
  test("create: validated, attributed to the session, audited", async () => {
    const { status, body } = await call("POST", "/management/notification-rules", validRule());
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.updatedBy.name, "Fay Finance");
    assert.ok(body.updatedAt);
    assert.equal(body.recipients[0].resolvable, true);
    const [entry] = await ManagementAudit.find().lean();
    assert.equal(entry.action, "notification_rule.created");
    assert.equal(entry.actor.id, "oid-fin");
    assert.equal(entry.after.name, "Corrected totals to Finance");
  });

  const refused = [
    ["unknown anomaly type", { anomalyTypes: ["made_up_anomaly"] }, "VALIDATION_ERROR"],
    ["no anomaly type", { anomalyTypes: [] }, "VALIDATION_ERROR"],
    ["empty name", { name: "  " }, "VALIDATION_ERROR"],
    ["unknown recipient type", { recipients: [{ type: "everyone" }] }, "VALIDATION_ERROR"],
    ["enabled without recipients", { recipients: [] }, "RECIPIENTS_REQUIRED"],
    ["a person who does not exist", { recipients: [{ type: "user", userId: "oid-nobody" }] }, "RECIPIENT_NOT_FOUND"],
    ["a person without an id", { recipients: [{ type: "user" }] }, "RECIPIENT_INVALID"],
    ["the manager, which needs configuration", { recipients: [{ type: "employee_manager" }] }, "RECIPIENT_NOT_AVAILABLE"],
    ["email, which is not connected", { channel: "email" }, "CHANNEL_NOT_AVAILABLE"],
    ["escalation with nobody to escalate to", { escalation: { enabled: true, afterHours: 4, recipients: [] } }, "ESCALATION_RECIPIENTS_REQUIRED"],
  ];
  for (const [label, overrides, code] of refused) {
    test(`refused: ${label}`, async () => {
      const { status, body } = await call("POST", "/management/notification-rules", validRule(overrides));
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(body.error, code);
    });
  }

  test("duplicate recipients are removed", async () => {
    const { body } = await call(
      "POST",
      "/management/notification-rules",
      validRule({ recipients: [{ type: "user", userId: "oid-bob" }, { type: "user", userId: "oid-bob" }, { type: "finance_admins" }, { type: "finance_admins" }] }),
    );
    assert.equal(body.recipients.length, 2);
  });

  test("a disabled rule may be saved without recipients; names are unique", async () => {
    assert.equal((await call("POST", "/management/notification-rules", validRule({ enabled: false, recipients: [] }))).status, 201);
    const duplicate = await call("POST", "/management/notification-rules", validRule({ name: "CORRECTED TOTALS TO FINANCE" }));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, "RULE_NAME_TAKEN");
  });

  test("update: audited with before and after; a stale edit is refused", async () => {
    const created = (await call("POST", "/management/notification-rules", validRule())).body;
    const first = await call("PUT", `/management/notification-rules/${created.id}`, { ...validRule({ enabled: false }), version: created.version });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.enabled, false);
    const stale = await call("PUT", `/management/notification-rules/${created.id}`, { ...validRule(), version: created.version });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "RULE_CHANGED");
    const entry = await ManagementAudit.findOne({ action: "notification_rule.updated" }).lean();
    assert.equal(entry.before.enabled, true);
    assert.equal(entry.after.enabled, false);
  });

  test("delete keeps history but the rule no longer matches", async () => {
    const created = (await call("POST", "/management/notification-rules", validRule())).body;
    assert.equal((await call("DELETE", `/management/notification-rules/${created.id}`)).status, 204);
    assert.equal((await call("GET", "/management/notification-rules")).body.rules.length, 0);
    const stored = await NotificationRule.findById(created.id).lean();
    assert.ok(stored.deletedAt);
    const request = await scannedRequest();
    assert.equal((await submit(request.id)).status, 200);
    assert.equal((await realEvents()).length, 0);
  });

  test("a recipient who has since gone missing is shown as unresolved", async () => {
    await call("POST", "/management/notification-rules", validRule({ recipients: [{ type: "user", userId: "oid-bob" }] }));
    await User.deleteOne({ entraUserId: "oid-bob" });
    const [rule] = (await call("GET", "/management/notification-rules")).body.rules;
    assert.equal(rule.recipients[0].resolvable, false);
    assert.equal(rule.deliverable, false);
  });
});

describe("Notification triggering", () => {
  test("anomaly → rule → recipient → delivered in-app, without routing or status changes", async () => {
    await call("POST", "/management/notification-rules", validRule());
    const request = await scannedRequest();
    assert.equal((await realEvents()).length, 0, "a save does not fire an on_submission rule");
    const saved = await submit(request.id);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.status, "Pending Workflow Setup", "no Manager or Finance routing");
    assert.equal(saved.body.assignedApproverId, "");
    const events = await realEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].recipientId, "oid-fin");
    assert.equal(events[0].anomalyType, "ocr_total_corrected");
    assert.ok(["queued", "sending", "delivered"].includes(events[0].status));
    await processOutbox();
    assert.equal((await NotificationEvent.findById(events[0]._id).lean()).status, "delivered");
    const stored = await Expense.findById(request.id).lean();
    assert.equal(stored.status, "Pending Workflow Setup", "delivery does not touch the expense");
  });

  test("content holds no merchant, amount or anomaly details", async () => {
    await call("POST", "/management/notification-rules", validRule());
    const request = await scannedRequest();
    await submit(request.id);
    const [event] = await realEvents();
    const text = `${event.title} ${event.body}`;
    assert.match(text, new RegExp(request.requestNumber));
    assert.doesNotMatch(text, /SAMPLE COFFEE|400|335|Alice/);
  });

  test("saving repeatedly does not notify again; a materially new anomaly does", async () => {
    await call("POST", "/management/notification-rules", validRule({ trigger: "on_save" }));
    const request = await scannedRequest();
    assert.equal((await realEvents()).length, 1);
    await call("PATCH", `/expenses/${request.id}`, { purpose: "Client lunch, updated" }, "alice");
    await call("PATCH", `/expenses/${request.id}`, { purpose: "Client lunch, updated again" }, "alice");
    assert.equal((await realEvents()).length, 1, "same anomaly, same state");
    await call("PATCH", `/expenses/${request.id}`, { amount: 500 }, "alice");
    assert.equal((await realEvents()).length, 2, "a different changed total is new");
  });

  test("concurrent saves produce one notification", async () => {
    await call("POST", "/management/notification-rules", validRule({ trigger: "on_save" }));
    const request = await scannedRequest();
    await NotificationEvent.deleteMany({});
    const expense = await Expense.findById(request.id);
    const report = expense.anomalyReport;
    await Promise.all(Array.from({ length: 5 }, () => queueAnomalyNotifications({ expense, report, trigger: "save" })));
    assert.equal((await realEvents()).length, 1);
  });

  test("assistant-only incomplete drafts never notify", async () => {
    await call("POST", "/management/notification-rules", validRule({ trigger: "on_save" }));
    await scannedRequest("alice", { amount: 400, incompleteDraft: true });
    assert.equal((await realEvents()).length, 0);
  });

  test("disabled rules, other anomaly types and other severities do not match", async () => {
    await call("POST", "/management/notification-rules", validRule({ enabled: false, name: "Off" }));
    await call("POST", "/management/notification-rules", validRule({ anomalyTypes: ["possible_duplicate_claim"], name: "Other type" }));
    await call("POST", "/management/notification-rules", validRule({ severity: "High Risk", name: "Other severity" }));
    const request = await scannedRequest();
    await submit(request.id);
    assert.equal((await realEvents()).length, 0);
    assert.equal(ruleMatches({ anomalyTypes: ["x"], severity: "Warning", trigger: "on_submission" }, { ruleId: "x", severity: "warning" }, "save"), false);
    assert.equal(ruleMatches({ anomalyTypes: ["x"], severity: "Warning", trigger: "on_save" }, { ruleId: "x", severity: "warning" }, "save"), true);
  });

  test("everything is off behind NOTIFICATIONS_ENABLED", async () => {
    env.notifications.enabled = false;
    await call("POST", "/management/notification-rules", validRule());
    const request = await scannedRequest();
    const saved = await submit(request.id);
    assert.equal(saved.status, 200);
    assert.equal((await realEvents()).length, 0);
  });

  test("a notification failure never blocks saving an expense", async () => {
    await call("POST", "/management/notification-rules", validRule({ trigger: "on_save" }));
    const original = NotificationRule.find;
    NotificationRule.find = () => {
      throw new Error("database hiccup");
    };
    try {
      const request = await scannedRequest();
      assert.ok(request.id);
      assert.ok(await Expense.findById(request.id));
    } finally {
      NotificationRule.find = original;
    }
  });

  test("a missing recipient is on record as skipped, and others still get theirs", async () => {
    await call("POST", "/management/notification-rules", validRule({ recipients: [{ type: "user", userId: "oid-bob" }, { type: "finance_admins" }] }));
    await User.deleteOne({ entraUserId: "oid-bob" });
    const request = await scannedRequest();
    await submit(request.id);
    const events = await realEvents();
    assert.equal(events.find((event) => event.recipientId === "oid-bob").status, "skipped");
    assert.equal(events.find((event) => event.recipientId === "oid-bob").lastErrorCode, "RECIPIENT_NOT_FOUND");
    assert.ok(events.find((event) => event.recipientId === "oid-fin"));
  });

  test("fingerprint: volatile details are ignored, real changes are not", () => {
    const base = { ruleId: "company_policy_limit", status: "flagged", details: { policyLimit: 100, submittedAmount: 120, monthlyTotal: 500, previousAmount: 380 } };
    assert.equal(anomalyFingerprint(base), anomalyFingerprint({ ...base, details: { ...base.details, monthlyTotal: 900, previousAmount: 780 } }));
    assert.notEqual(anomalyFingerprint(base), anomalyFingerprint({ ...base, details: { ...base.details, submittedAmount: 130 } }));
    assert.notEqual(anomalyFingerprint(base), anomalyFingerprint({ ...base, status: "needs_review" }));
  });
});

describe("Delivery and retries", () => {
  async function queued(overrides = {}) {
    return NotificationEvent.create({ idempotencyKey: `k-${Math.random()}`, channel: "in_app", recipientId: "oid-fin", title: "t", body: "b", ...overrides });
  }

  test("a failure retries with backoff, records only a safe code, then gives up", async () => {
    __setProviders({
      in_app: async () => {
        throw Object.assign(new Error("smtp://user:secret@host refused"), { code: "provider said: secret" });
      },
    });
    const event = await queued({ maxAttempts: 2 });
    const now = new Date();
    assert.equal((await processOutbox({ now })).retrying, 1);
    let stored = await NotificationEvent.findById(event._id).lean();
    assert.equal(stored.status, "queued");
    assert.equal(stored.attempts, 1);
    assert.equal(stored.lastErrorCode, "DELIVERY_FAILED");
    assert.equal(stored.nextAttemptAt.getTime(), now.getTime() + nextRetryDelay(1));
    assert.ok(!JSON.stringify(stored).includes("secret"));
    assert.equal((await processOutbox({ now })).retrying, 0, "not before its time");
    assert.equal((await processOutbox({ now: new Date(now.getTime() + 3600_000) })).failed, 1);
    stored = await NotificationEvent.findById(event._id).lean();
    assert.equal(stored.status, "failed");
  });

  test("a retry can succeed", async () => {
    let attempts = 0;
    __setProviders({
      in_app: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("x"), { code: "TEMPORARY" });
        return { provider: "in_app" };
      },
    });
    const event = await queued();
    await processOutbox();
    await processOutbox({ now: new Date(Date.now() + 3600_000) });
    const stored = await NotificationEvent.findById(event._id).lean();
    assert.equal(stored.status, "delivered");
    assert.equal(stored.attempts, 2);
    assert.ok(stored.deliveredAt);
  });

  test("email without a transport is recorded as skipped, not delivered", async () => {
    const event = await queued({ channel: "email" });
    assert.equal((await processOutbox()).skipped, 1);
    const stored = await NotificationEvent.findById(event._id).lean();
    assert.equal(stored.status, "skipped");
    assert.equal(stored.lastErrorCode, "EMAIL_NOT_CONFIGURED");
  });

  test("concurrent workers deliver a record once", async () => {
    let deliveries = 0;
    __setProviders({
      in_app: async () => {
        deliveries += 1;
        return {};
      },
    });
    await queued();
    await Promise.all([processOutbox(), processOutbox(), processOutbox()]);
    assert.equal(deliveries, 1);
  });

  test("a claim left by a stopped server is retried", async () => {
    const event = await queued({ status: "sending", lockedAt: new Date(Date.now() - 3600_000) });
    await processOutbox();
    assert.equal((await NotificationEvent.findById(event._id).lean()).status, "delivered");
  });

  test("escalation: an unread notification is followed up once; a read one is not", async () => {
    const rule = (
      await call(
        "POST",
        "/management/notification-rules",
        validRule({ escalation: { enabled: true, afterHours: 4, recipients: [{ type: "user", userId: "oid-appr" }] } }),
      )
    ).body;
    const request = await scannedRequest();
    await submit(request.id);
    await processOutbox();
    const [original] = await realEvents();
    assert.ok(original.escalateAfter);
    assert.equal(await processEscalations({ now: new Date(original.escalateAfter.getTime() - 1000) }), 0, "not yet");
    const later = new Date(original.escalateAfter.getTime() + 1000);
    assert.equal(await processEscalations({ now: later }), 1);
    assert.equal(await processEscalations({ now: later }), 0, "only once");
    const follow = await NotificationEvent.findOne({ escalationOf: original._id }).lean();
    assert.equal(follow.recipientId, "oid-appr");
    assert.match(follow.title, /^Escalated/);
    assert.ok(rule.id);
    // Read in time: no follow-up.
    await NotificationEvent.deleteMany({});
    const other = await NotificationEvent.create({ idempotencyKey: "read", channel: "in_app", recipientId: "x", status: "delivered", readAt: new Date(), escalateAfter: new Date(0), ruleId: rule.id });
    assert.equal(await processEscalations(), 0);
    assert.ok(other);
  });
});

describe("Test notifications", () => {
  test("locally: mock provider, labelled TEST, in no inbox, no expense touched", async () => {
    const rule = (await call("POST", "/management/notification-rules", validRule())).body;
    const before = await Expense.countDocuments();
    const { status, body } = await call("POST", `/management/notification-rules/${rule.id}/test`, {});
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.status, "mocked");
    assert.equal(body.sent, false);
    const [event] = await NotificationEvent.find({ test: true }).lean();
    assert.equal(event.provider, "mock");
    assert.match(event.title, /^\[TEST\]/);
    assert.equal(event.expenseId, undefined);
    assert.equal(await Expense.countDocuments(), before);
    assert.equal((await call("GET", "/notifications", undefined, "finance")).body.notifications.length, 0);
    assert.equal((await realEvents()).length, 0, "kept apart from real notifications");
    assert.equal((await call("GET", "/management/notification-events")).body.total, 0);
    assert.equal((await call("GET", "/management/notification-events?test=true")).body.total, 1);
    assert.ok(await ManagementAudit.findOne({ action: "notification_rule.tested" }));
  });

  test("in production it needs explicit confirmation, then is labelled in the inbox", async () => {
    const rule = (await call("POST", "/management/notification-rules", validRule())).body;
    env.isProduction = true;
    try {
      const refused = await call("POST", `/management/notification-rules/${rule.id}/test`, {});
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, "CONFIRMATION_REQUIRED");
      assert.equal(await NotificationEvent.countDocuments(), 0);
      const sent = await call("POST", `/management/notification-rules/${rule.id}/test`, { confirm: true });
      assert.equal(sent.body.status, "delivered", JSON.stringify(sent.body));
      const inbox = (await call("GET", "/notifications", undefined, "finance")).body;
      assert.equal(inbox.notifications.length, 1);
      assert.equal(inbox.notifications[0].test, true);
      assert.equal(inbox.notifications[0].expenseId, null);
    } finally {
      env.isProduction = false;
    }
  });

  test("an unconnected channel says so instead of claiming it was sent", async () => {
    env.notifications.emailProvider = "mock";
    const rule = (await call("POST", "/management/notification-rules", validRule({ channel: "email" }))).body;
    env.notifications.emailProvider = "none";
    const { body } = await call("POST", `/management/notification-rules/${rule.id}/test`, {});
    assert.equal(body.status, "not_configured");
    assert.equal(body.sent, false);
    assert.match(body.message, /Nothing was sent/);
    assert.equal((await NotificationEvent.findOne({ test: true }).lean()).status, "skipped");
  });

  test("no reachable recipient is an error, not a silent success", async () => {
    const rule = (await call("POST", "/management/notification-rules", validRule({ enabled: false, recipients: [] }))).body;
    const { status, body } = await call("POST", `/management/notification-rules/${rule.id}/test`, {});
    assert.equal(status, 400);
    assert.equal(body.error, "NO_RECIPIENTS");
  });
});

describe("Inbox and isolation", () => {
  async function delivered() {
    await call("POST", "/management/notification-rules", validRule({ recipients: [{ type: "user", userId: "oid-bob" }, { type: "finance_admins" }] }));
    const request = await scannedRequest();
    await submit(request.id);
    await processOutbox();
    return request;
  }

  test("each person sees only their own; another person's id is not found", async () => {
    await delivered();
    const finance = (await call("GET", "/notifications", undefined, "finance")).body;
    assert.equal(finance.notifications.length, 1);
    assert.equal(finance.unread, 1);
    assert.equal((await call("GET", "/notifications", undefined, "alice")).body.notifications.length, 0);
    const id = finance.notifications[0].id;
    assert.equal((await call("POST", `/notifications/${id}/read`, {}, "alice")).status, 404);
    assert.equal((await call("GET", "/notifications", undefined, "finance")).body.unread, 1);
    assert.equal((await call("POST", `/notifications/${id}/read`, {}, "finance")).status, 204);
    assert.equal((await call("GET", "/notifications/unread-count", undefined, "finance")).body.unread, 0);
  });

  test("a recipient who may not view the request gets no link, and still no access", async () => {
    const request = await delivered();
    const bob = (await call("GET", "/notifications", undefined, "bob")).body.notifications[0];
    assert.equal(bob.expenseId, null);
    assert.equal((await call("GET", `/expenses/${request.id}`, undefined, "bob")).status, 404);
    assert.doesNotMatch(JSON.stringify(bob), /SAMPLE COFFEE|Alice|recipientEmail/);
    const finance = (await call("GET", "/notifications", undefined, "finance")).body.notifications[0];
    assert.equal(finance.expenseId, request.id);
  });

  test("delivery history hides other employees' requests, unless the viewer may open them", async () => {
    const request = await delivered();
    const text = (history) => JSON.stringify(history);
    const finance = (await call("GET", "/management/notification-events")).body;
    assert.equal(finance.total, 2);
    assert.equal(finance.events[0].requestNumber, request.requestNumber);
    assert.ok(!text(finance).includes("idempotencyKey"));
    assert.ok(!text(finance).includes("recipientEmail"));
    const bob = (await call("GET", "/management/notification-events", undefined, "bob")).body;
    assert.equal(bob.total, 2);
    for (const event of bob.events) {
      assert.equal(event.requestHidden, true);
      assert.equal(event.requestNumber, undefined);
      assert.equal(event.title, undefined);
      assert.equal(event.body, undefined);
      assert.equal(event.expenseId, undefined);
    }
    assert.ok(!text(bob).includes(request.requestNumber));
    assert.doesNotMatch(text(bob), /SAMPLE COFFEE|Alice/);
    const owner = (await call("GET", "/management/notification-events", undefined, "alice")).body;
    assert.equal(owner.events[0].requestNumber, request.requestNumber, "the employee's own request is shown");
  });

  test("rule views and the audit trail hold no recipient emails or roles", async () => {
    await call("POST", "/management/notification-rules", validRule({ recipients: [{ type: "user", userId: "oid-bob" }] }), "alice");
    const { rules } = (await call("GET", "/management/notification-rules", undefined, "alice")).body;
    assert.deepEqual(rules[0].recipients, [{ type: "user", userId: "oid-bob", name: "Bob Employee", resolvable: true }]);
    const audit = (await call("GET", "/management/audit", undefined, "bob")).body;
    assert.doesNotMatch(JSON.stringify(audit), /bob@example|alice@example/);
  });

  test("anyone can send a test; it stays a mock outside production", async () => {
    const rule = (await call("POST", "/management/notification-rules", validRule(), "alice")).body;
    const sent = await call("POST", `/management/notification-rules/${rule.id}/test`, {}, "bob");
    assert.equal(sent.body.status, "mocked");
    assert.equal((await NotificationEvent.findOne({ test: true }).lean()).testBy.id, "oid-bob");
    assert.equal((await realEvents()).length, 0);
  });
});

describe("Duplicate prevention", () => {
  test("cost estimate: per count of up to 10 pages, at the configured price", () => {
    const pricing = { googleUsdPerUnit: 0.1, googlePagesPerUnit: 10, veryfiUsdPerDocument: 0 };
    assert.deepEqual(estimateOcrCost({ provider: "google_document_ai", pageCount: 1, pricing }), { units: 1, costUsd: 0.1 });
    assert.deepEqual(estimateOcrCost({ provider: "google_document_ai", pageCount: 10, pricing }), { units: 1, costUsd: 0.1 });
    assert.deepEqual(estimateOcrCost({ provider: "google_document_ai", pageCount: 11, pricing }), { units: 2, costUsd: 0.2 });
    assert.deepEqual(estimateOcrCost({ provider: "google_document_ai", pricing }), { units: 1, costUsd: 0.1 });
    assert.deepEqual(estimateOcrCost({ provider: "google_document_ai", pageCount: 1, pricing: { ...pricing, googleUsdPerUnit: 0.08 } }), { units: 1, costUsd: 0.08 });
    assert.equal(estimateOcrCost({ provider: "veryfi", pricing }).costUsd, null, "no price, no invented estimate");
  });

  test("billability: failed requests are not billed, a timeout is unknown", () => {
    assert.equal(billabilityOfFailure("OCR_UNAVAILABLE", false), "no");
    assert.equal(billabilityOfFailure("OCR_TIMEOUT", false), "unknown");
    assert.equal(billabilityOfFailure("OCR_PROCESSING_FAILED", true), "yes");
  });

  test("concurrent uploads of one file: one provider call, one stored file", async () => {
    googleImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return [{ document: liveShapedSyntheticDocument() }];
    };
    const responses = await Promise.all(Array.from({ length: 5 }, () => upload()));
    assert.equal(googleCalls, 1);
    assert.equal(new Set(responses.map((r) => r.body.jobId)).size, 1, "all answered with one scan");
    assert.equal(responses.filter((r) => r.status === 201).length, 1);
    assert.equal(await ReceiptJob.countDocuments(), 1);
    assert.equal(await mongoose.connection.db.collection("receiptFiles.files").countDocuments(), 1);
    const job = await ReceiptJob.findOne().lean();
    assert.equal(job.inFlightKey, undefined, "the claim is released");
    assert.equal(await OcrScanEvent.countDocuments({ outcome: "success" }), 1);
    assert.equal(await OcrScanEvent.countDocuments({ outcome: "duplicate_retry" }), 4);
  });

  test("two employees uploading one file: separate readings, nothing shared", async () => {
    const [alice, bob] = [await upload(RECEIPT_JPG, "alice"), await upload(RECEIPT_JPG, "bob")];
    assert.equal(googleCalls, 2, "OCR results are not reused across employees");
    assert.notEqual(alice.body.jobId, bob.body.jobId);
    assert.equal(bob.body.duplicateUpload, undefined, "Bob is told nothing about Alice's upload");
    const [aliceJob, bobJob] = await Promise.all([ReceiptJob.findById(alice.body.jobId).lean(), ReceiptJob.findById(bob.body.jobId).lean()]);
    assert.notEqual(String(aliceJob.fileId), String(bobJob.fileId), "files are not shared across employees");
    assert.equal((await call("GET", `/receipts/${alice.body.jobId}/status`, undefined, "bob")).status, 404);
    assert.equal((await call("GET", `/receipts/${alice.body.jobId}/file`, undefined, "bob")).status, 404);
  });

  test("one employee's earlier scan never answers another's, even when concurrent", async () => {
    googleImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return [{ document: liveShapedSyntheticDocument() }];
    };
    await Promise.all([upload(RECEIPT_JPG, "alice"), upload(RECEIPT_JPG, "bob")]);
    assert.equal(googleCalls, 2);
  });

  test("re-scanning a file already used by an expense: no OCR request, a scan of its own, duplicate still flagged", async () => {
    const first = await scannedRequest("alice", {});
    assert.equal(googleCalls, 1);
    const again = await upload();
    assert.equal(googleCalls, 1, "no second billable request");
    assert.equal(again.status, 201);
    assert.notEqual(again.body.jobId, first.receiptJobId);
    assert.equal(again.body.duplicateUpload.kind, "same_account_reused");
    assert.match(again.body.expense.extractionNotes[0], /scanned this exact file before/);
    const job = await ReceiptJob.findById(again.body.jobId).lean();
    assert.equal(String(job.reusedFromJobId), first.receiptJobId);
    assert.equal(await mongoose.connection.db.collection("receiptFiles.files").countDocuments(), 1, "the identical file is stored once");
    assert.equal(await OcrScanEvent.countDocuments({ outcome: "duplicate_reused", billable: "no" }), 1);
    // The second expense still goes through the claim check.
    const { status, jobId, id, ...extracted } = again.body.expense;
    const second = await call("POST", "/expenses", { ...extracted, receiptJobId: again.body.jobId, category: "Meals", purpose: "Again", location: "Makati" }, "alice");
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const duplicate = second.body.anomalyReport.anomalies.find((a) => a.ruleId === "possible_duplicate_claim");
    assert.equal(duplicate.status, "flagged");
    assert.equal((await fetch(`${api}/receipts/${again.body.jobId}/file`, { headers: { "x-test-user": "alice" } })).status, 200, "the shared file still opens");
  });

  test("failed scans are not reused: a retry reads again", async () => {
    googleImpl = async () => {
      throw grpcError(14, "unavailable");
    };
    const failed = await upload();
    assert.equal(failed.status, 503);
    const attempts = googleCalls;
    googleImpl = async () => [{ document: liveShapedSyntheticDocument() }];
    const retried = await upload();
    assert.equal(retried.status, 201);
    assert.equal(googleCalls, attempts + 1);
  });

  test("a claim left by a stopped server does not block the file forever", async () => {
    const stale = await ReceiptJob.create({ status: "processing", originalFileName: "x.jpg", mimeType: "image/jpeg", uploadedBy: "oid-alice" });
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(RECEIPT_JPG).digest("hex");
    await ReceiptJob.collection.updateOne(
      { _id: stale._id },
      { $set: { fileSha256: sha, ocrProvider: "google_document_ai", inFlightKey: `oid-alice:google_document_ai:${sha}`, createdAt: new Date(Date.now() - 3600_000) } },
    );
    const response = await upload();
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(googleCalls, 1);
    const released = await ReceiptJob.findById(stale._id).lean();
    assert.equal(released.status, "failed");
    assert.equal(released.errorCode, "OCR_INTERRUPTED");
    assert.equal(released.inFlightKey, undefined);
  });

  test("a reading stays reusable just inside the 30-day window", async () => {
    const request = await scannedRequest("alice", {});
    await ReceiptJob.collection.updateOne({ _id: new mongoose.Types.ObjectId(request.receiptJobId) }, { $set: { createdAt: new Date(Date.now() - 29 * 86400_000) } });
    await upload();
    assert.equal(googleCalls, 1);
    await ReceiptJob.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 31 * 86400_000) } });
    await upload();
    assert.equal(googleCalls, 2, "and not just outside it");
  });

  test("another employee's earlier scan is never reused", async () => {
    await scannedRequest("alice", {});
    const bob = await upload(RECEIPT_JPG, "bob");
    assert.equal(googleCalls, 2);
    assert.equal(bob.body.duplicateUpload, undefined);
    assert.equal((await ReceiptJob.findById(bob.body.jobId).lean()).reusedFromJobId, undefined);
  });

  test("OCR_REUSE_PRIOR_SCAN_DAYS=0 keeps the short retry window only", async () => {
    env.ocrReusePriorScanDays = 0;
    await scannedRequest("alice", {});
    await upload();
    assert.equal(googleCalls, 2);
  });

  test("readings older than the window are not reused", async () => {
    const request = await scannedRequest("alice", {});
    await ReceiptJob.collection.updateOne({ _id: new mongoose.Types.ObjectId(request.receiptJobId) }, { $set: { createdAt: new Date(Date.now() - 40 * 86400_000) } });
    await upload();
    assert.equal(googleCalls, 2);
  });

  test("cleanup keeps a stored file another scan still uses", async () => {
    const first = await scannedRequest("alice", {});
    const reused = await upload();
    await ReceiptJob.collection.updateOne({ _id: new mongoose.Types.ObjectId(reused.body.jobId) }, { $set: { createdAt: new Date(Date.now() - 30 * 86400_000) } });
    const log = () => {};
    const dry = await cleanupAbandonedReceiptFiles({ olderThanDays: 7, dryRun: true, log });
    assert.equal(dry.sharedFileKept, 1);
    assert.equal(dry.wouldDelete, 0);
    const run = await cleanupAbandonedReceiptFiles({ olderThanDays: 7, dryRun: false, log });
    assert.equal(run.sharedFileKept, 1);
    assert.equal(run.deleted, 0);
    assert.equal(await mongoose.connection.db.collection("receiptFiles.files").countDocuments(), 1);
    assert.equal((await ReceiptJob.findById(reused.body.jobId).lean()).fileId, undefined, "the abandoned scan lets go of it");
    const original = await ReceiptJob.findById(first.receiptJobId).lean();
    assert.ok(original.fileId, "the expense's scan keeps it");
  });

  test("upload failures while reserving a claim: HEIC is refused before any provider call", async () => {
    const form = new FormData();
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(32)]);
    form.append("receipt", new Blob([heic], { type: "image/heic" }), "photo.heic");
    const response = await fetch(`${api}/receipts/upload`, { method: "POST", headers: { "x-test-user": "alice" }, body: form });
    assert.equal(response.status, 415);
    assert.equal(googleCalls, 0);
    assert.equal(await ReceiptJob.countDocuments(), 0);
    const [event] = await OcrScanEvent.find().lean();
    assert.equal(event.outcome, "skipped_unsupported");
    assert.equal(event.billable, "no");
  });
});

describe("OCR analytics", () => {
  const seed = async (event) =>
    OcrScanEvent.create({ at: new Date("2026-03-10T04:00:00Z"), provider: "google_document_ai", employeeId: "oid-alice", employeeName: "Alice Employee", department: "Sales", ...event });

  test("counts, cost and rates from real scans; failed calls cost nothing", async () => {
    await scannedRequest("alice", { amount: 400 });
    await upload(); // duplicate: reused
    await upload(Buffer.concat([RECEIPT_JPG, Buffer.from("different")]), "bob");
    googleImpl = async () => {
      throw grpcError(3, "bad document");
    };
    await upload(Buffer.concat([RECEIPT_JPG, Buffer.from("other")]), "bob");
    const { status, body } = await call("GET", "/management/ocr-analytics");
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.usage.total, 4);
    assert.equal(body.usage.success, 2);
    assert.equal(body.usage.failed, 1);
    assert.equal(body.usage.duplicates, 1);
    assert.equal(body.cost.isEstimate, true);
    assert.match(body.cost.note, /not Google Cloud billing/);
    assert.equal(body.cost.estimatedCostUsd, 0.2, "two successes at USD 0.10; failed and duplicates are free");
    assert.equal(body.cost.billableUnits, 2);
    assert.equal(body.cost.monthToDateUsd, 0.2);
    assert.equal(body.usage.byProvider[0].provider, "google_document_ai");
    assert.ok(body.usage.averageDurationMs >= 0);
    const amount = body.quality.fields.find((field) => field.field === "amount");
    assert.equal(amount.corrected, 1);
    assert.equal(amount.averageConfidence, 0.953);
    assert.equal(body.quality.expensesMeasured, 1);
    assert.ok(body.quality.correctionRate > 0);
    assert.equal(body.quality.failures[0].code, "OCR_DOCUMENT_REJECTED");
  });

  test("filters narrow the results and dates use Manila days", async () => {
    await seed({ outcome: "success", billable: "yes", billableUnits: 1, estimatedCostUsd: 0.1 });
    await seed({ outcome: "failed", employeeId: "oid-bob", employeeName: "Bob Employee", department: "Service", errorCode: "OCR_UNAVAILABLE" });
    await seed({ outcome: "success", provider: "veryfi", estimatedCostUsd: null, billable: "yes", billableUnits: 1 });
    // 2026-03-10 23:30 in UTC is already 11 March in Manila.
    await seed({ outcome: "success", at: new Date("2026-03-10T23:30:00Z"), billable: "yes", billableUnits: 1, estimatedCostUsd: 0.1 });
    const query = async (text) => (await call("GET", `/management/ocr-analytics?from=2026-03-10&to=2026-03-10${text}`)).body;
    assert.equal((await query("")).usage.total, 3);
    assert.equal((await query("&employeeId=oid-bob")).usage.total, 1);
    assert.equal((await query("&department=Service")).usage.failed, 1);
    assert.equal((await query("&provider=veryfi")).usage.total, 1);
    assert.equal((await query("&outcome=failed")).usage.total, 1);
    const all = await query("");
    assert.equal(all.cost.scansWithoutPrice, 1, "a provider with no price is reported, not costed");
    assert.deepEqual(all.options.providers, ["google_document_ai", "veryfi"]);
    const eleventh = (await call("GET", "/management/ocr-analytics?from=2026-03-11&to=2026-03-11")).body;
    assert.equal(eleventh.usage.total, 1);
    assert.equal(eleventh.usage.byDay.length, 1);
  });

  test("a timed-out request is reported as unknown billing, outside the estimate", async () => {
    await seed({ outcome: "failed", billable: "unknown", errorCode: "OCR_TIMEOUT" });
    const { body } = await call("GET", "/management/ocr-analytics?from=2026-03-10&to=2026-03-10");
    assert.equal(body.cost.unknownBilling, 1);
    assert.equal(body.cost.estimatedCostUsd, 0);
  });

  test("budget alert is optional and uses this month", async () => {
    await OcrScanEvent.create({ at: new Date(), provider: "google_document_ai", outcome: "success", billable: "yes", billableUnits: 1, estimatedCostUsd: 0.9 });
    assert.equal((await call("GET", "/management/ocr-analytics")).body.cost.budget, null);
    env.ocrCost.monthlyBudgetUsd = 1;
    assert.deepEqual((await call("GET", "/management/ocr-analytics")).body.cost.budget, { monthlyUsd: 1, usedRate: 0.9, exceeded: false, warning: true });
    env.ocrCost.monthlyBudgetUsd = 0.5;
    assert.equal((await call("GET", "/management/ocr-analytics")).body.cost.budget.exceeded, true);
  });

  test("rates are exact: corrections, missing fields and confirmations", async () => {
    const quality = (fields) => ({ provider: "google_document_ai", fields: fields.map(([field, status]) => ({ field, status, confidence: 0.9 })) });
    const at = new Date("2026-03-10T04:00:00Z");
    const insert = (employeeId, fields, reviews) => Expense.collection.insertOne({ employeeId, department: "Sales", createdAt: at, updatedAt: at, status: "Draft", ocrQuality: quality(fields), ocrFieldReviews: reviews });
    await insert("oid-alice", [["amount", "corrected"], ["merchant", "extracted"], ["tax", "missing"], ["expenseDate", "confirmed"]], [{ field: "expenseDate", status: "confirmed" }]);
    await insert("oid-bob", [["amount", "extracted"], ["merchant", "corrected"], ["tax", "extracted"], ["expenseDate", "extracted"]], [{ field: "amount", status: "needs_confirmation" }]);
    await Expense.collection.insertOne({ employeeId: "oid-alice", createdAt: at, updatedAt: at, status: "Draft", incompleteDraft: true, ocrQuality: quality([["amount", "corrected"]]) });
    const { body } = await call("GET", "/management/ocr-analytics?from=2026-03-10&to=2026-03-10");
    assert.equal(body.quality.expensesMeasured, 2, "incomplete drafts are left out");
    assert.equal(body.quality.correctionRate, 0.25, "2 of 8 reviewed fields");
    assert.equal(body.quality.missingRate, 0.125, "1 of 8");
    assert.equal(body.quality.confirmationRate, 0.5, "1 answered, 1 waiting");
    const byField = Object.fromEntries(body.quality.fields.map((field) => [field.field, field]));
    assert.equal(byField.amount.corrected, 1);
    assert.equal(byField.amount.correctionRate, 0.5);
    const alice = (await call("GET", "/management/ocr-analytics?from=2026-03-10&to=2026-03-10&employeeId=oid-alice")).body;
    assert.equal(alice.quality.expensesMeasured, 1);
    assert.equal(alice.quality.correctionRate, 0.25);
  });

  test("a reused reading does not count its scores or missing fields twice", async () => {
    await scannedRequest("alice", {});
    await upload();
    const events = await OcrScanEvent.find().sort({ at: 1 }).lean();
    assert.deepEqual(events.map((event) => event.outcome), ["success", "duplicate_reused"]);
    assert.equal(events[1].confidence, undefined);
    assert.equal(events[1].missingFields, undefined);
    const { body } = await call("GET", "/management/ocr-analytics");
    const subtotal = body.quality.fields.find((field) => field.field === "subtotal");
    assert.equal(subtotal.missingFromScanRate, 1, "never above 100%");
    assert.equal(body.cost.estimatedCostUsd, 0.1, "only the first read costs anything");
  });

  test("no receipt content, images or credentials in the response", async () => {
    await scannedRequest("alice", {});
    const { body } = await call("GET", "/management/ocr-analytics");
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /SAMPLE COFFEE|TEST-00042|Makati|fileId|ocrText|private_key|client_email/);
  });

  test("invalid dates are refused", async () => {
    assert.equal((await call("GET", "/management/ocr-analytics?from=2026-03-11&to=2026-03-10")).body.error, "INVALID_DATE_RANGE");
    assert.equal((await call("GET", "/management/ocr-analytics?from=yesterday")).status, 400);
  });
});

describe("Release safeguards", () => {
  const source = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");

  test("notifications, receipt cleanup and approval routing are off, and OCR reuse is 30 days, unless configured", () => {
    const config = source("../src/config/env.js");
    for (const name of ["NOTIFICATIONS_ENABLED", "RECEIPT_CLEANUP_ENABLED", "APPROVAL_WORKFLOW_ENABLED"]) {
      assert.match(config, new RegExp(name + ': z\\s*\\.enum\\(\\["true", "false", ""\\]\\)\\s*\\.default\\("false"\\)'), name);
    }
    assert.match(config, /OCR_REUSE_PRIOR_SCAN_DAYS: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.max\(365\)\.default\(30\)/);
  });

  test("no notification rules are created automatically", () => {
    for (const file of ["../src/config/database.js", "../src/server.js", "../src/policy/approvedCategories.js", "../src/services/notifications/notificationService.js", "../src/services/notifications/outbox.js"]) {
      assert.doesNotMatch(source(file), /NotificationRule\.(create|insertMany|updateOne|findOneAndUpdate)/, file);
    }
    assert.equal((source("../src/routes/management.js").match(/NotificationRule\.create\(/g) ?? []).length, 1, "only the API route an employee calls");
  });

  test("notification code never changes an expense or its routing", () => {
    for (const file of ["../src/services/notifications/notificationService.js", "../src/services/notifications/outbox.js", "../src/routes/management.js"]) {
      assert.doesNotMatch(source(file), /Expense\.(update|findOneAndUpdate|findByIdAndUpdate|create|delete)|expense\.save|approvalWorkflowEnabled/, file);
    }
  });
});

describe("Scanned expense details", () => {
  test("VAT figures and field statuses come from the scan; the browser cannot set them", async () => {
    const request = await scannedRequest("alice", { amount: 400, vatBreakdown: { vatableSales: 1 }, ocrQuality: { fields: [] } });
    assert.equal(request.vatBreakdown.vatableSales, 299.55);
    const amount = request.ocrQuality.fields.find((field) => field.field === "amount");
    assert.equal(amount.status, "corrected");
    assert.equal(request.ocrQuality.provider, "google_document_ai");
  });

  test("a manual expense has neither", async () => {
    const { body } = await call("POST", "/expenses", { merchant: "Manual", amount: 10, category: "Meals" }, "alice");
    assert.equal(body.vatBreakdown, undefined);
    assert.equal(body.ocrQuality, undefined);
  });
});
