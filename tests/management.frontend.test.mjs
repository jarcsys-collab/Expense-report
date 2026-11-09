// Management form logic, navigation and rendering of the analytics chart, through Vite.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite;
let rules;
let nav;
let analytics;
let react;
let renderToStaticMarkup;

before(async () => {
  vite = await createServer({ logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
  rules = await vite.ssrLoadModule("/src/utils/notificationRules.js");
  nav = await vite.ssrLoadModule("/src/components/layout/navItems.js");
  analytics = await vite.ssrLoadModule("/src/components/management/AnalyticsPanel.jsx");
  react = await import("react");
  ({ renderToStaticMarkup } = await import("react-dom/server"));
});
after(async () => vite?.close());

const valid = () => ({ ...rules.emptyRule(), name: "Rule", anomalyTypes: ["ocr_total_corrected"] });

test("new rules start disabled and need a name and an anomaly type", () => {
  const empty = rules.emptyRule();
  assert.equal(empty.enabled, false);
  const errors = rules.validateRuleDraft(empty);
  assert.match(errors.name, /rule name/);
  assert.match(errors.anomalyTypes, /anomaly type/);
  assert.deepEqual(rules.validateRuleDraft(valid()), {}, "a disabled rule may have no recipients");
});

test("an enabled rule needs a recipient; escalation is checked", () => {
  assert.match(rules.validateRuleDraft({ ...valid(), enabled: true }).recipients, /recipient/);
  const withEscalation = (escalation, extra = {}) => ({ ...valid(), ...extra, escalation: { enabled: true, afterHours: 24, recipients: [{ type: "finance_admins" }], ...escalation } });
  assert.deepEqual(rules.validateRuleDraft(withEscalation({})), {});
  assert.match(rules.validateRuleDraft(withEscalation({ recipients: [] })).escalation, /escalate to/);
  assert.match(rules.validateRuleDraft(withEscalation({ afterHours: 0 })).escalation, /1 to 720/);
  assert.match(rules.validateRuleDraft(withEscalation({}, { channel: "email" })).escalation, /in-app/);
});

test("the payload carries ids and types only, never names or roles", () => {
  const payload = rules.draftToPayload({
    ...valid(),
    name: "  Trim me ",
    recipients: [
      { type: "user", userId: "oid-1", name: "Someone", role: "FINANCE_ADMIN", resolvable: true },
      { type: "finance_admins", name: "All", count: 3 },
    ],
  });
  assert.equal(payload.name, "Trim me");
  assert.deepEqual(payload.recipients, [{ type: "user", userId: "oid-1" }, { type: "finance_admins" }]);
  assert.equal(payload.version, undefined);
  assert.equal(rules.draftToPayload({ ...valid(), version: 3 }).version, 3);
});

test("recipients cannot be added twice and can be removed", () => {
  const person = { type: "user", userId: "a" };
  let list = rules.addRecipient([], person);
  assert.equal(rules.addRecipient(list, { ...person, name: "again" }).length, 1);
  list = rules.addRecipient(list, { type: "user", userId: "b" });
  list = rules.addRecipient(list, { type: "finance_admins" });
  assert.equal(list.length, 3);
  assert.deepEqual(rules.removeRecipient(list, person).map((r) => r.userId ?? r.type), ["b", "finance_admins"]);
});

const ruleRow = (overrides = {}) => ({
  id: "1",
  name: "Duplicates",
  description: "For finance",
  enabled: true,
  anomalyTypes: ["possible_duplicate_claim"],
  anomalies: [{ id: "possible_duplicate_claim", name: "Possible duplicate claim", available: true }],
  recipients: [{ type: "user", userId: "a", name: "Fay Finance", resolvable: true }],
  deliverable: true,
  ...overrides,
});

test("search and filters on the rules table", () => {
  const off = ruleRow({ id: "2", name: "Totals", description: "", enabled: false, anomalyTypes: ["ocr_total_corrected"], anomalies: [{ id: "ocr_total_corrected", name: "Total changed", available: true }], recipients: [] });
  const list = [ruleRow(), off];
  assert.equal(rules.filterRules(list, { search: "fay" }).length, 1);
  assert.equal(rules.filterRules(list, { search: "TOTAL CHANGED" })[0].id, "2");
  assert.equal(rules.filterRules(list, { status: "on" })[0].id, "1");
  assert.equal(rules.filterRules(list, { status: "off" })[0].id, "2");
  assert.equal(rules.filterRules(list, { anomalyType: "ocr_total_corrected" })[0].id, "2");
  assert.equal(rules.filterRules(list, {}).length, 2);
  assert.equal(rules.filterRules(list, { search: "nothing" }).length, 0);
});

test("a rule that can't do its job says so", () => {
  assert.equal(rules.ruleWarning(ruleRow()), "");
  assert.equal(rules.ruleWarning(ruleRow({ recipients: [] })), "No recipients");
  assert.equal(rules.ruleWarning(ruleRow({ deliverable: false, recipients: [{ resolvable: false }] })), "No recipient can be reached");
  assert.match(rules.ruleWarning(ruleRow({ recipients: [{ resolvable: true }, { resolvable: false }] })), /can't be reached/);
  assert.match(rules.ruleWarning(ruleRow({ anomalies: [{ available: false }] })), /can't raise findings/);
});

test("audit entries list what changed", () => {
  assert.equal(rules.auditActionLabel("notification_rule.updated"), "Changed rule");
  assert.deepEqual(rules.auditChanges({ before: { enabled: true, name: "A", recipients: [] }, after: { enabled: false, name: "A", recipients: [{ type: "finance_admins" }] } }), ["enabled", "recipients"]);
  assert.deepEqual(rules.auditChanges({ after: { name: "A" } }), []);
});

test("delivery results read plainly, and skipped is not shown as sent", () => {
  assert.equal(rules.DELIVERY_STATUS.skipped.label, "Not sent");
  assert.equal(rules.deliveryErrorText("EMAIL_NOT_CONFIGURED"), "Email delivery is not connected");
  assert.equal(rules.deliveryErrorText("SOMETHING_NEW"), "SOMETHING_NEW");
  assert.equal(rules.deliveryErrorText(undefined), "");
});

test("number formats never invent a value", () => {
  assert.equal(rules.formatUsd(0.1), "US$0.10");
  assert.equal(rules.formatUsd(null), "No estimate");
  assert.equal(rules.formatRate(0.125), "12.5%");
  assert.equal(rules.formatRate(null), "Not enough data");
  assert.equal(rules.formatDuration(1500), "1.5 s");
  assert.equal(rules.formatDuration(null), "Not enough data");
  assert.deepEqual(rules.lastDays(30, new Date(2026, 10, 9)), { from: "2026-10-11", to: "2026-11-09" });
});

test("Management appears for every employee the server grants it to, whatever their role", () => {
  const has = (...args) => nav.getNavItems(...args).some((item) => item.to === "/management");
  assert.equal(has("EMPLOYEE", true, true), true);
  assert.equal(has("APPROVER", true, true), true);
  assert.equal(has("FINANCE_ADMIN", true, true), true);
  assert.equal(has("FINANCE_ADMIN", true, false), false, "a shared beta admin is told no by the server");
  assert.equal(has("EMPLOYEE", false), false, "not before sign-in");
});

test("OCR analytics is listed only when the server allows it", () => {
  const ids = (user) => rules.visibleManagementSections(user).map((section) => section.id);
  assert.deepEqual(ids({ managementAccess: true, ocrAnalyticsAccess: false }), ["notifications", "delivery", "audit"]);
  assert.deepEqual(ids({ managementAccess: true, ocrAnalyticsAccess: true }), ["notifications", "delivery", "ocr", "audit"]);
  assert.deepEqual(ids({ managementAccess: true, role: "FINANCE_ADMIN" }), ["notifications", "delivery", "audit"], "from the server's flag, not the role");
});

test("session flags come from the server", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../src/services/authService.js", import.meta.url), "utf8");
  assert.match(source, /managementAccess: payload\?\.features\?\.management === true/);
  assert.match(source, /ocrAnalyticsAccess: payload\?\.features\?\.ocrAnalytics === true/);
});

test("approval routing stays off in the session flags and no approval controls were added", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const path of ["../src/components/management/RulesPanel.jsx", "../src/components/management/RuleForm.jsx", "../src/pages/ManagementPage.jsx"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /approveExpense|rejectExpense|submitExpense|approvalWorkflow/);
  }
});

const bucket = (day, scans, estimatedCostUsd) => ({ start: `${day}T00:00:00.000Z`, scans, estimatedCostUsd });

test("the chart shows one measure, labelled, with its table", () => {
  const html = renderToStaticMarkup(
    react.createElement(analytics.BucketChart, { title: "Scans by day", unit: "day", measure: "scans", buckets: [bucket("2026-03-09", 4, 0.4), bucket("2026-03-10", 2, 0.2)] }),
  );
  assert.ok(html.includes("Scans by day"));
  assert.ok(html.includes("Highest: 4"));
  assert.ok(html.includes("height:100%"), "the tallest bar fills the plot");
  assert.ok(html.includes("height:50%"));
  assert.ok(html.includes("Show as a table"));
  assert.ok(html.includes("US$0.40"));
});

test("the cost chart is labelled as money; an empty one says so", () => {
  const cost = renderToStaticMarkup(react.createElement(analytics.BucketChart, { title: "Estimated cost by month", unit: "month", measure: "cost", buckets: [bucket("2026-03-01", 4, 0.4)] }));
  assert.ok(cost.includes("Highest: US$0.40"));
  const empty = renderToStaticMarkup(react.createElement(analytics.BucketChart, { title: "Scans by day", unit: "day", measure: "scans", buckets: [] }));
  assert.ok(empty.includes("Nothing to show"));
});
