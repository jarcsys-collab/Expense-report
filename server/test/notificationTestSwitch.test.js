// The off switch for test notifications, through the real Management router over HTTP.
// No database: the connection check is faked and the few model calls are replaced, so
// any unexpected query would fail rather than reach a server. Nothing is sent anywhere.
import "./setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import express from "express";
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ManagementAudit } from "../src/models/ManagementAudit.js";
import { NotificationEvent } from "../src/models/NotificationEvent.js";
import { NotificationRule } from "../src/models/NotificationRule.js";
import { User } from "../src/models/User.js";
import { managementRouter } from "../src/routes/management.js";

const RULE_ID = "6aed640cbeb1f481c06d018b";
const USERS = {
  employee: { id: "oid-employee", name: "Synthetic Employee", provider: "entra", role: "EMPLOYEE" },
  finance: { id: "oid-finance", name: "Synthetic Finance", provider: "entra", role: "FINANCE_ADMIN" },
  beta: { id: "beta-user", name: "Beta", provider: "beta", role: "FINANCE_ADMIN" },
};
const RECIPIENTS = [{ name: "Synthetic Recipient", email: "recipient@example.test", entraUserId: "oid-recipient", role: "FINANCE_ADMIN" }];
const lean = (value) => ({ lean: async () => value });
const synthetic = () => ({ _id: RULE_ID, name: "Synthetic rule", anomalyTypes: ["ocr_total_corrected"], channel: "in_app", recipients: [{ type: "finance_admins" }] });

const originals = {};
const replace = (model, method, implementation) => {
  (originals[model.modelName] ??= {})[method] ??= model[method];
  model[method] = implementation;
};

let server;
let base;
let calls;

before(async () => {
  // The router's connection check sees "connected"; no connection exists or is opened,
  // and this placeholder address is never contacted.
  env.mongoUri = "mongodb://not-used.invalid";
  Object.defineProperty(mongoose.connection, "readyState", { get: () => 1, configurable: true });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = USERS[req.get("x-test-user")];
    next();
  });
  app.use("/api/management", managementRouter);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/management`;
});

after(async () => {
  delete mongoose.connection.readyState;
  env.mongoUri = "";
  await new Promise((resolve) => server?.close(resolve));
});

beforeEach(() => {
  calls = { ruleLookups: 0, inserted: [], audited: [] };
  env.isProduction = false;
  env.notifications.enabled = false;
  replace(User, "findOne", () => lean({ role: "EMPLOYEE" }));
  replace(User, "find", () => lean(RECIPIENTS));
  replace(NotificationRule, "findOne", async () => {
    calls.ruleLookups += 1;
    return synthetic();
  });
  replace(NotificationEvent, "insertMany", async (events) => {
    calls.inserted.push(...events);
    return events.map((event, index) => ({ ...event, _id: `event-${index}` }));
  });
  replace(ManagementAudit, "create", async (entry) => {
    calls.audited.push(entry);
    return entry;
  });
});

afterEach(() => {
  env.isProduction = false;
  env.notifications.enabled = false;
  for (const model of [User, NotificationRule, NotificationEvent, ManagementAudit]) {
    for (const [method, original] of Object.entries(originals[model.modelName] ?? {})) model[method] = original;
  }
});

const sendTest = (user, body = {}) =>
  fetch(`${base}/notification-rules/${RULE_ID}/test`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": user }, body: JSON.stringify(body) });

describe("While notifications are off", () => {
  for (const [label, production, body] of [
    ["outside production", false, {}],
    ["in production", true, {}],
    ["in production, even when confirmed", true, { confirm: true }],
  ]) {
    test(`a test is refused ${label}, and nothing happens`, async () => {
      env.isProduction = production;
      const response = await sendTest("employee", body);
      assert.equal(response.status, 409);
      const answer = await response.json();
      assert.equal(answer.error, "NOTIFICATIONS_DISABLED");
      assert.match(answer.message, /switched off/);
      assert.match(answer.message, /Nothing was sent/);
      assert.equal(calls.ruleLookups, 0, "no rule is read");
      assert.deepEqual(calls.inserted, [], "no notification is recorded");
      assert.deepEqual(calls.audited, [], "no test is claimed in the audit trail");
    });
  }

  test("Finance is refused too: this is a switch, not a permission", async () => {
    env.isProduction = true;
    const response = await sendTest("finance", { confirm: true });
    assert.equal(response.status, 409);
    assert.deepEqual(calls.inserted, []);
  });

  test("refused attempts do not use up the sender's rate limit", async () => {
    for (let attempt = 0; attempt < 25; attempt += 1) assert.equal((await sendTest("employee")).status, 409);
  });

  test("the shared beta account still gets its own refusal first", async () => {
    const response = await sendTest("beta");
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "FORBIDDEN");
  });

  test("the catalog tells the frontend, for every employee", async () => {
    const response = await fetch(`${base}/catalog`, { headers: { "x-test-user": "employee" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).delivery.notificationsEnabled, false);
  });

  test("unset behaves as off: the server's default", () => {
    const config = fs.readFileSync(new URL("../src/config/env.js", import.meta.url), "utf8");
    assert.match(config, /NOTIFICATIONS_ENABLED: z\s*\.enum\(\["true", "false", ""\]\)\s*\.default\("false"\)\s*\.transform\(\(value\) => value === "true"\)/);
  });
});

describe("When notifications are switched on", () => {
  beforeEach(() => {
    env.notifications.enabled = true;
  });

  test("outside production a test is still recorded through the mock, and audited", async () => {
    const response = await sendTest("employee");
    const answer = await response.json();
    assert.equal(response.status, 200, JSON.stringify(answer));
    assert.equal(answer.status, "mocked");
    assert.equal(answer.sent, false);
    assert.equal(calls.inserted.length, 1);
    assert.equal(calls.inserted[0].test, true);
    assert.equal(calls.inserted[0].provider, "mock");
    assert.match(calls.inserted[0].title, /^\[TEST\]/);
    assert.equal(calls.inserted[0].testBy.id, "oid-employee");
    assert.equal(calls.audited[0].action, "notification_rule.tested");
    assert.equal(calls.audited[0].actor.id, "oid-employee");
  });

  test("in production a test still needs explicit confirmation", async () => {
    env.isProduction = true;
    const response = await sendTest("employee");
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "CONFIRMATION_REQUIRED");
    assert.deepEqual(calls.inserted, []);
  });

  test("the beta account is still refused, and the catalog reports notifications on", async () => {
    assert.equal((await sendTest("beta")).status, 403);
    const catalog = await (await fetch(`${base}/catalog`, { headers: { "x-test-user": "employee" } })).json();
    assert.equal(catalog.delivery.notificationsEnabled, true);
  });

  test("the rate limit still applies, and is per person", async () => {
    let limited;
    for (let attempt = 0; attempt < 25 && !limited; attempt += 1) {
      const response = await sendTest("finance");
      if (response.status === 429) limited = attempt;
    }
    assert.ok(limited !== undefined, "a sender is eventually limited");
    assert.ok(limited <= 20);
    // The route's limiter counts tests this person really attempted, so another person is unaffected.
    assert.notEqual((await sendTest("employee")).status, 429);
  });
});

describe("Rule management is not affected by the switch", () => {
  test("listing rules works while notifications are off", async () => {
    replace(NotificationRule, "find", () => ({ sort: () => lean([]) }));
    const response = await fetch(`${base}/notification-rules`, { headers: { "x-test-user": "employee" } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).rules, []);
  });

  test("the switch is only on the test route", () => {
    const guarded = managementRouter.stack
      .filter((layer) => layer.route?.stack.some((step) => step.name === "requireNotificationsEnabled"))
      .map((layer) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`);
    assert.deepEqual(guarded, ["post /notification-rules/:id/test"]);
  });
});
