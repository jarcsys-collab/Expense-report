// My Requests workflow, expense ownership (IDOR), currency checks, disabled
// approval routing and original-receipt storage, through the real routes against
// a throwaway in-memory MongoDB. Google Document AI is mocked (no billable calls).
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
import { ReceiptJob } from "../src/models/ReceiptJob.js";
import { expensesRouter } from "../src/routes/expenses.js";
import { policyRouter } from "../src/routes/policy.js";
import { receiptsRouter } from "../src/routes/receipts.js";
import { violationsRouter } from "../src/routes/violations.js";
import { normalizeDocumentAiDocument } from "../src/services/documentAiNormalizer.js";
import { __setTestHooks } from "../src/services/googleDocumentAiService.js";
import { liveShapedSyntheticDocument } from "./fixtures/documentAi.js";

const RECEIPT_JPG = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/synthetic-receipt.jpg"));
const USERS = {
  owner: { id: "emp-owner", name: "Test Employee", provider: "beta", role: "EMPLOYEE" },
  other: { id: "emp-other", name: "Other Employee", provider: "beta", role: "EMPLOYEE" },
  approver: { id: "appr-1", name: "Assigned Approver", provider: "beta", role: "APPROVER" },
  approver2: { id: "appr-2", name: "Unassigned Approver", provider: "beta", role: "APPROVER" },
  finance: { id: "fin-1", name: "Finance Admin", provider: "beta", role: "FINANCE_ADMIN" },
};

let mongo;
let server;
let api;
let googleCalls = 0;

before(async () => {
  mongo = await MongoMemoryServer.create();
  env.mongoUri = mongo.getUri();
  await mongoose.connect(env.mongoUri, { dbName: "receiptflow-test" });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = USERS[req.get("x-test-user") ?? "owner"];
    next();
  });
  app.use("/api/expenses", expensesRouter);
  app.use("/api/receipts", receiptsRouter);
  app.use("/api/violations", violationsRouter);
  app.use("/api/policy", policyRouter);
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
  await Category.create({ name: "Meals", active: true });
  env.approvalWorkflowEnabled = false;
  googleCalls = 0;
  __setTestHooks({
    factory: () => ({
      processDocument: async () => {
        googleCalls += 1;
        return [{ document: liveShapedSyntheticDocument() }];
      },
    }),
  });
});

async function call(method, route, body, user = "owner") {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    headers: response.headers,
    body: type.includes("json") ? await response.json() : response.status === 204 ? null : Buffer.from(await response.arrayBuffer()),
  };
}

async function upload(user = "owner") {
  const form = new FormData();
  form.append("receipt", new Blob([RECEIPT_JPG], { type: "image/jpeg" }), "synthetic-receipt.jpg");
  const response = await fetch(`${api}/receipts/upload`, { method: "POST", headers: { "x-test-user": user }, body: form });
  return { status: response.status, body: await response.json() };
}

/** A stored scan of the synthetic receipt (no upload), optionally adjusted. */
async function createScan(adjust = (doc) => doc, uploadedBy = USERS.owner.id) {
  const { expense, ocrMeta, audit } = normalizeDocumentAiDocument(adjust(liveShapedSyntheticDocument()));
  return ReceiptJob.create({
    status: "needs_review", originalFileName: "synthetic-receipt.jpg", mimeType: "image/jpeg", size: 1000,
    uploadedBy, ocrProvider: "google_document_ai", result: expense, ocrMeta, audit,
  });
}
const confident = (doc) => {
  doc.entities.find((e) => e.type === "receipt_date").confidence = 0.95;
  return doc;
};

async function createRequest(jobOrResult, overrides = {}, user = "owner") {
  const { status: jobStatus, ...extracted } = jobOrResult.result ?? jobOrResult.expense ?? {};
  const response = await call("POST", "/expenses", {
    ...extracted,
    receiptJobId: String(jobOrResult._id ?? jobOrResult.jobId),
    category: "Meals", purpose: "Synthetic test lunch", location: "Makati", position: "Tester", department: "QA",
    ...overrides,
  }, user);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}
/** Stands in for future server-side approver assignment (not settable through the API). */
const assignApprover = (id, approverId = USERS.approver.id) =>
  Expense.updateOne({ _id: id }, { $set: { assignedApproverId: approverId } });
const rule = (expense, id) => expense.anomalyReport.anomalies.find((a) => a.ruleId === id);

describe("My Requests: save without approval routing (APPROVAL_WORKFLOW_ENABLED=false)", () => {
  test("upload → review → save: stored with owner, receipt, OCR details, checks and history; not routed", async () => {
    const uploaded = await upload();
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(googleCalls, 1);
    const job = await ReceiptJob.findById(uploaded.body.jobId);
    assert.ok(job.fileId, "original receipt stored");
    const draft = await createRequest(uploaded.body);
    const saved = await call("POST", `/expenses/${draft.id}/submit`, { expense: { ocrConfirmations: { expenseDate: "2026-03-25" } } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const body = saved.body;
    assert.equal(body.status, "Pending Workflow Setup");
    assert.equal(body.submittedAt, undefined, "not submitted to anyone");
    assert.equal(body.employeeId, USERS.owner.id);
    assert.equal(body.receiptJobId, uploaded.body.jobId);
    assert.ok(body.receiptFiles.some((f) => f.id === `job-${uploaded.body.jobId}`));
    assert.equal(body.merchant, "SAMPLE COFFEE HOUSE");
    assert.equal(body.currency, "PHP");
    assert.equal(body.receiptNumber, "TEST-00042");
    assert.equal(body.ocrFieldReviews[0].status, "confirmed");
    assert.ok(body.anomalyReport.anomalies.length > 0);
    assert.equal(body.anomalyReport.route, "finance", "routing recommendation kept for later");
    assert.ok(body.createdAt && body.updatedAt);
    assert.ok(body.activityLog.some((e) => /Saved to My Requests\. Approval routing is not set up yet/.test(e.action)));
    // Listed in My Requests.
    const list = await call("GET", "/expenses");
    assert.deepEqual(list.body.expenses.map((e) => e.id), [draft.id]);
  });

  test("saved requests can be edited and saved again without duplicating the record", async () => {
    const draft = await createRequest(await createScan(confident));
    await call("POST", `/expenses/${draft.id}/submit`, {});
    const edited = await call("PATCH", `/expenses/${draft.id}`, { purpose: "Corrected purpose" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.status, "Pending Workflow Setup");
    const again = await call("POST", `/expenses/${draft.id}/submit`, {});
    assert.equal(again.status, 200);
    assert.equal(again.body.purpose, "Corrected purpose");
    assert.equal(await Expense.countDocuments(), 1);
  });

  test("the client cannot force routing (status or flags in the request are ignored)", async () => {
    const draft = await createRequest(await createScan(confident), { status: "Submitted" });
    assert.equal(draft.status, "Draft");
    const saved = await call("POST", `/expenses/${draft.id}/submit`, {
      expense: { status: "Submitted", approvalWorkflow: true, approvalWorkflowEnabled: true },
    });
    assert.equal(saved.body.status, "Pending Workflow Setup");
  });

  test("enabling routing later does not move saved requests; an explicit submit routes them", async () => {
    const draft = await createRequest(await createScan(confident));
    await call("POST", `/expenses/${draft.id}/submit`, {});
    env.approvalWorkflowEnabled = true;
    assert.equal((await call("GET", `/expenses/${draft.id}`)).body.status, "Pending Workflow Setup");
    const routed = await call("POST", `/expenses/${draft.id}/submit`, {});
    assert.equal(routed.status, 200);
    assert.equal(routed.body.status, "Submitted");
    assert.ok(routed.body.submittedAt);
  });

  test("existing submitted requests are unchanged and stay locked", async () => {
    const draft = await createRequest(await createScan(confident));
    await Expense.updateOne({ _id: draft.id }, { $set: { status: "Pending Approval", submittedAt: new Date() } });
    const patch = await call("PATCH", `/expenses/${draft.id}`, { purpose: "x" });
    assert.equal(patch.status, 409);
    assert.equal((await Expense.findById(draft.id)).status, "Pending Approval");
  });

  test("required details, OCR confirmation, duplicate and anomaly checks still run before saving", async () => {
    const incomplete = await createRequest(await createScan(), { purpose: "" });
    assert.equal((await call("POST", `/expenses/${incomplete.id}/submit`, {})).body.error, "SUBMISSION_INCOMPLETE");
    const unconfirmed = await createRequest(await createScan());
    assert.equal((await call("POST", `/expenses/${unconfirmed.id}/submit`, {})).body.error, "OCR_FIELDS_NOT_CONFIRMED");
    const first = await createRequest(await createScan(confident));
    await call("POST", `/expenses/${first.id}/submit`, {});
    const second = await createRequest(await createScan(confident));
    const dup = await call("POST", `/expenses/${second.id}/submit`, {});
    assert.equal(rule(dup.body, "possible_duplicate_claim").status, "flagged");
    assert.equal(dup.body.status, "Pending Workflow Setup");
    assert.equal(dup.body.anomalyReport.route, "manager_approval");
  });

  test("an identical re-upload reuses the scan: no second OCR request, no second stored file", async () => {
    const first = await upload();
    const second = await upload();
    assert.equal(second.status, 200);
    assert.equal(second.body.jobId, first.body.jobId);
    assert.equal(googleCalls, 1);
    assert.equal(await mongoose.connection.db.collection("receiptFiles.files").countDocuments(), 1);
  });
});

describe("Original receipt file", () => {
  test("owner, assigned approver and Finance can open it; others cannot", async () => {
    const uploaded = await upload();
    const draft = await createRequest(uploaded.body);
    await assignApprover(draft.id); // server-side only (the API ignores client values)
    const own = await call("GET", `/expenses/${draft.id}/receipt`);
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("content-type"), "image/jpeg");
    assert.equal(own.headers.get("x-content-type-options"), "nosniff");
    assert.ok(Buffer.compare(own.body, RECEIPT_JPG) === 0, "the exact uploaded bytes");
    assert.equal((await call("GET", `/expenses/${draft.id}/receipt`, undefined, "approver")).status, 200);
    assert.equal((await call("GET", `/expenses/${draft.id}/receipt`, undefined, "finance")).status, 200);
    assert.equal((await call("GET", `/expenses/${draft.id}/receipt`, undefined, "other")).status, 404);
    assert.equal((await call("GET", `/expenses/${draft.id}/receipt`, undefined, "approver2")).status, 404);
    assert.equal((await call("GET", `/receipts/${uploaded.body.jobId}/file`)).status, 200);
    assert.equal((await call("GET", `/receipts/${uploaded.body.jobId}/file`, undefined, "other")).status, 404);
    assert.equal((await call("GET", `/receipts/${uploaded.body.jobId}/status`, undefined, "other")).status, 404);
  });

  test("older scans without a stored file answer a clear 404", async () => {
    const draft = await createRequest(await createScan(confident));
    const response = await call("GET", `/expenses/${draft.id}/receipt`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error, "RECEIPT_FILE_NOT_FOUND");
  });
});

describe("Expense ownership (IDOR)", () => {
  test("another employee cannot see, list, edit, submit, delete or preview someone else's request", async () => {
    const draft = await createRequest(await createScan(confident));
    const id = draft.id;
    assert.equal((await call("GET", `/expenses/${id}`, undefined, "other")).status, 404);
    assert.equal((await call("PATCH", `/expenses/${id}`, { purpose: "hijack" }, "other")).status, 404);
    assert.equal((await call("POST", `/expenses/${id}/submit`, {}, "other")).status, 404);
    assert.equal((await call("DELETE", `/expenses/${id}`, undefined, "other")).status, 404);
    assert.equal((await call("POST", "/policy/check", { expenseId: id, expense: { amount: 1 } }, "other")).status, 404);
    assert.deepEqual((await call("GET", "/expenses", undefined, "other")).body.expenses, []);
    assert.deepEqual((await call("GET", `/expenses?employeeId=${USERS.owner.id}`, undefined, "other")).body.expenses, []);
    assert.deepEqual((await call("GET", "/violations", undefined, "other")).body.expenses, []);
    const stored = await Expense.findById(id);
    assert.equal(stored.purpose, "Synthetic test lunch");
    assert.equal(stored.status, "Draft");
  });

  test("the owner can view, edit, save and delete their own request", async () => {
    const draft = await createRequest(await createScan(confident));
    assert.equal((await call("GET", `/expenses/${draft.id}`)).status, 200);
    assert.equal((await call("PATCH", `/expenses/${draft.id}`, { purpose: "Mine" })).status, 200);
    assert.equal((await call("POST", `/expenses/${draft.id}/submit`, {})).status, 200);
    assert.equal((await call("DELETE", `/expenses/${draft.id}`)).status, 204);
  });

  test("an assigned approver can view (read-only); an unassigned approver cannot", async () => {
    const draft = await createRequest(await createScan(confident));
    await assignApprover(draft.id);
    assert.equal((await call("GET", `/expenses/${draft.id}`, undefined, "approver")).status, 200);
    assert.equal((await call("GET", "/expenses", undefined, "approver")).body.expenses.length, 1);
    assert.equal((await call("PATCH", `/expenses/${draft.id}`, { purpose: "x" }, "approver")).status, 403);
    assert.equal((await call("DELETE", `/expenses/${draft.id}`, undefined, "approver")).status, 403);
    assert.equal((await call("GET", `/expenses/${draft.id}`, undefined, "approver2")).status, 404);
    assert.equal((await call("GET", "/expenses", undefined, "approver2")).body.expenses.length, 0);
  });

  test("Finance can see every request and edit or save editable ones", async () => {
    const mine = await createRequest(await createScan(confident));
    const theirs = await createRequest(await createScan(confident, USERS.other.id), {}, "other");
    const list = await call("GET", "/expenses", undefined, "finance");
    assert.deepEqual(list.body.expenses.map((e) => e.id).sort(), [mine.id, theirs.id].sort());
    assert.equal((await call("PATCH", `/expenses/${mine.id}`, { notes: "Checked by Finance" }, "finance")).status, 200);
    const saved = await call("POST", `/expenses/${mine.id}/submit`, {}, "finance");
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.employeeId, USERS.owner.id, "ownership unchanged");
  });

  test("ownership comes from the session, never from the request", async () => {
    const draft = await createRequest(await createScan(confident), { employeeId: USERS.other.id, employeeName: "Spoofed" });
    assert.equal(draft.employeeId, USERS.owner.id);
    const patched = await call("PATCH", `/expenses/${draft.id}`, { employeeId: USERS.other.id });
    assert.equal(patched.body.employeeId, USERS.owner.id);
  });
});

describe("Currency changes", () => {
  test("a currency changed from the scan is flagged for review and kept in the audit trail", async () => {
    const draft = await createRequest(await createScan(confident));
    const changed = await call("PATCH", `/expenses/${draft.id}`, { currency: "USD" });
    assert.ok(changed.body.activityLog.some((e) => /Currency changed from PHP \(scanned\) to USD/.test(e.action)));
    const finding = rule(changed.body, "ocr_currency_changed");
    assert.equal(finding.status, "needs_review");
    assert.deepEqual(finding.details, { scannedCurrency: "PHP", submittedCurrency: "USD" });
    env.approvalWorkflowEnabled = true;
    const routed = await call("POST", `/expenses/${draft.id}/submit`, {});
    assert.equal(routed.body.status, "Pending Approval");
  });

  test("an unchanged currency passes", async () => {
    const draft = await createRequest(await createScan(confident));
    assert.equal(rule(draft, "ocr_currency_changed").status, "passed");
  });

  test("a scan without a currency needs the employee's input, but is not a currency-change anomaly", async () => {
    const job = await createScan((doc) => {
      confident(doc);
      doc.entities = doc.entities.filter((e) => e.type !== "currency");
      return doc;
    });
    assert.equal(job.result.currency, undefined);
    const draft = await createRequest(job, { currency: "PHP" });
    const review = draft.ocrFieldReviews.find((r) => r.field === "currency");
    assert.equal(review.reason, "not_read");
    assert.equal(review.status, "needs_confirmation");
    const blocked = await call("POST", `/expenses/${draft.id}/submit`, {});
    assert.equal(blocked.body.error, "OCR_FIELDS_NOT_CONFIRMED");
    assert.equal(blocked.body.details[0].path, "currency");
    const saved = await call("POST", `/expenses/${draft.id}/submit`, { expense: { ocrConfirmations: { currency: "PHP" } } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.ocrFieldReviews.find((r) => r.field === "currency").status, "provided");
    assert.equal(rule(saved.body, "ocr_currency_changed").status, "not_evaluated");
    assert.equal(saved.body.anomalyReport.route, "finance");
    assert.ok(saved.body.activityLog.some((e) => /Provided the currency PHP \(not found on the receipt scan\)/.test(e.action)));
  });
});
