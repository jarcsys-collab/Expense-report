// OCR field confirmation through the real expense routes, against a throwaway
// in-memory MongoDB (mongodb-memory-server). No production database, no Google.
import "./setup.js";
import assert from "node:assert/strict";
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
import { normalizeDocumentAiDocument } from "../src/services/documentAiNormalizer.js";
import { liveShapedSyntheticDocument } from "./fixtures/documentAi.js";

const USERS = {
  owner: { id: "emp-owner", name: "Test Employee", provider: "beta", role: "EMPLOYEE" },
  other: { id: "emp-other", name: "Other Employee", provider: "beta", role: "EMPLOYEE" },
  finance: { id: "fin-1", name: "Finance Admin", provider: "beta", role: "FINANCE_ADMIN" },
};

/** Runs fn with approval routing switched on (routing assertions), then restores it. */
async function withRouting(fn) {
  const previous = env.approvalWorkflowEnabled;
  env.approvalWorkflowEnabled = true;
  try {
    return await fn();
  } finally {
    env.approvalWorkflowEnabled = previous;
  }
}

let mongo;
let server;
let base;

before(async () => {
  mongo = await MongoMemoryServer.create();
  env.mongoUri = mongo.getUri();
  await mongoose.connect(env.mongoUri, { dbName: "receiptflow-test" });
  const app = express();
  app.use(express.json());
  // Stand-in for requireAuth: the signed-in user comes from the server, never the body.
  app.use((req, res, next) => {
    req.user = USERS[req.get("x-test-user") ?? "owner"];
    next();
  });
  app.use("/api/expenses", expensesRouter);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/expenses`;
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await mongoose.disconnect();
  await mongo?.stop();
  env.mongoUri = "";
});

beforeEach(async () => {
  await Promise.all([Expense.deleteMany({}), ReceiptJob.deleteMany({}), Category.deleteMany({})]);
  await Category.create({ name: "Meals", active: true });
});

async function call(method, path, body, user = "owner") {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** A stored scan of the synthetic receipt as the live test read it (date 43%). */
async function createScan(adjust = (doc) => doc) {
  const { expense, ocrMeta, audit } = normalizeDocumentAiDocument(adjust(liveShapedSyntheticDocument()));
  return ReceiptJob.create({
    status: "needs_review",
    originalFileName: "synthetic-receipt.jpg",
    mimeType: "image/jpeg",
    size: 1000,
    uploadedBy: USERS.owner.id,
    ocrProvider: "google_document_ai",
    result: expense,
    ocrMeta,
    audit,
  });
}

async function createDraft(job, overrides = {}) {
  const { status, ...extracted } = job.result;
  const { body, status: code } = await call("POST", "", {
    ...extracted,
    receiptJobId: String(job._id),
    category: "Meals",
    purpose: "Synthetic test lunch",
    location: "Makati",
    position: "Tester",
    department: "QA",
    ...overrides,
  });
  assert.equal(code, 201, JSON.stringify(body));
  return body;
}

const ruleStatus = (expense, id) => expense.anomalyReport.anomalies.find((a) => a.ruleId === id)?.status;

describe("OCR field confirmation", () => {
  test("a low-confidence date creates a server-side review needing confirmation", async () => {
    const draft = await createDraft(await createScan());
    assert.equal(draft.ocrFieldReviews.length, 1);
    const [review] = draft.ocrFieldReviews;
    assert.equal(review.field, "expenseDate");
    assert.equal(review.ocrValue, "2026-03-25");
    assert.equal(review.ocrConfidence, 0.433);
    assert.equal(review.status, "needs_confirmation");
    assert.equal(review.confirmedBy, null);
    assert.equal(ruleStatus(draft, "receipt_unclear_or_invalid"), "needs_review");
  });

  test("submission is blocked until the low-confidence field is confirmed", async () => {
    const draft = await createDraft(await createScan());
    const { status, body } = await call("POST", `/${draft.id}/submit`, {});
    assert.equal(status, 400);
    assert.equal(body.error, "OCR_FIELDS_NOT_CONFIRMED");
    assert.equal(body.details[0].path, "expenseDate");
    assert.match(body.details[0].message, /43% confidence/);
    assert.equal((await Expense.findById(draft.id)).status, "Draft");
  });

  test("confirming records server identity and time; uncertainty alone no longer routes to a manager", async () => {
    const draft = await createDraft(await createScan());
    const before = Date.now();
    const { status, body } = await withRouting(() =>
      call("POST", `/${draft.id}/submit`, { expense: { ocrConfirmations: { expenseDate: "2026-03-25" } } }),
    );
    assert.equal(status, 200, JSON.stringify(body));
    const [review] = body.ocrFieldReviews;
    assert.equal(review.status, "confirmed");
    assert.equal(review.confirmedValue, "2026-03-25");
    assert.deepEqual(review.confirmedBy, { id: USERS.owner.id, name: USERS.owner.name });
    assert.ok(Date.parse(review.confirmedAt) >= before - 1000);
    assert.equal(review.ocrValue, "2026-03-25", "original OCR value preserved");
    assert.equal(review.ocrConfidence, 0.433, "original OCR confidence preserved");
    assert.equal(ruleStatus(body, "receipt_unclear_or_invalid"), "passed");
    assert.match(body.anomalyReport.anomalies.find((a) => a.ruleId === "receipt_unclear_or_invalid").message, /confirmed by Test Employee/);
    assert.ok(body.activityLog.some((entry) => /Confirmed the receipt date "2026-03-25" \(OCR confidence 43%\)/.test(entry.action)));
    // The scan itself is untouched (audit).
    const job = await ReceiptJob.findById(draft.receiptJobId).lean();
    assert.equal(job.ocrMeta.confidence.expenseDate, 0.433);
    // Remaining findings are not caused by the confirmed field.
    const blocking = body.anomalyReport.anomalies.filter((a) => a.status === "flagged" || a.status === "needs_review");
    assert.deepEqual(blocking.map((a) => a.ruleId), [], "no finding remains for a clean, confirmed receipt");
    assert.equal(body.anomalyReport.route, "finance");
    assert.equal(body.status, "Submitted");
  });

  test("forged reviews, identities, timestamps and OCR values in the request are ignored", async () => {
    const draft = await createDraft(await createScan());
    const forged = {
      ocrFieldReviews: [
        { field: "expenseDate", status: "confirmed", ocrValue: "1999-01-01", ocrConfidence: 1, confirmedValue: "2026-03-25", confirmedBy: { id: "boss", name: "Boss" }, confirmedAt: "2020-01-01T00:00:00Z" },
      ],
      originalOCR: { expenseDate: "1999-01-01" },
      ocrConfidence: { expenseDate: 1 },
    };
    const patched = await call("PATCH", `/${draft.id}`, forged);
    assert.equal(patched.status, 200);
    assert.equal(patched.body.ocrFieldReviews[0].status, "needs_confirmation");
    assert.equal(patched.body.ocrFieldReviews[0].ocrValue, "2026-03-25");
    assert.equal(patched.body.ocrFieldReviews[0].ocrConfidence, 0.433);
    const sneaky = await call("PATCH", `/${draft.id}`, { ocrConfirmations: { expenseDate: "2026-03-25", confirmedBy: "boss" } });
    assert.equal(sneaky.status, 400, "unknown keys in ocrConfirmations are rejected");
    const submit = await call("POST", `/${draft.id}/submit`, { expense: forged });
    assert.equal(submit.body.error, "OCR_FIELDS_NOT_CONFIRMED");
  });

  test("only the expense owner can confirm", async () => {
    const draft = await createDraft(await createScan());
    // Another employee cannot even see it.
    const other = await call("PATCH", `/${draft.id}`, { ocrConfirmations: { expenseDate: "2026-03-25" } }, "other");
    assert.equal(other.status, 404);
    // Finance may edit the expense but cannot vouch for the employee's receipt.
    const { status, body } = await call("PATCH", `/${draft.id}`, { ocrConfirmations: { expenseDate: "2026-03-25" } }, "finance");
    assert.equal(status, 403);
    assert.equal(body.error, "OCR_CONFIRMATION_FORBIDDEN");
    assert.equal((await Expense.findById(draft.id)).ocrFieldReviews[0].status, "needs_confirmation");
  });

  test("a confirmation must match the current value", async () => {
    const draft = await createDraft(await createScan());
    const { status, body } = await call("PATCH", `/${draft.id}`, { ocrConfirmations: { expenseDate: "2026-03-24" } });
    assert.equal(status, 409);
    assert.equal(body.error, "OCR_CONFIRMATION_MISMATCH");
  });

  test("changing a confirmed value invalidates the confirmation", async () => {
    const draft = await createDraft(await createScan());
    const confirmed = await call("PATCH", `/${draft.id}`, { ocrConfirmations: { expenseDate: "2026-03-25" } });
    assert.equal(confirmed.body.ocrFieldReviews[0].status, "confirmed");
    const changed = await call("PATCH", `/${draft.id}`, { expenseDate: "2026-03-24" });
    assert.equal(changed.body.ocrFieldReviews[0].status, "needs_confirmation");
    assert.equal(changed.body.ocrFieldReviews[0].confirmedBy, null);
    assert.ok(changed.body.activityLog.some((e) => /Confirmation of the receipt date cleared/.test(e.action)));
    const corrected = await call("PATCH", `/${draft.id}`, { ocrConfirmations: { expenseDate: "2026-03-24" } });
    assert.equal(corrected.body.ocrFieldReviews[0].status, "corrected");
    assert.ok(corrected.body.activityLog.some((e) => /Corrected the receipt date: OCR read "2026-03-25"/.test(e.action)));
  });

  test("a confirmation for a confidently read field creates no record", async () => {
    const draft = await createDraft(await createScan());
    const { status, body } = await call("PATCH", `/${draft.id}`, { ocrConfirmations: { amount: 335.5 } });
    assert.equal(status, 200);
    assert.deepEqual(body.ocrFieldReviews.map((r) => r.field), ["expenseDate"]);
    assert.equal(body.ocrFieldReviews[0].status, "needs_confirmation");
    assert.ok(!body.activityLog.some((e) => /Confirmed the total/.test(e.action)));
    // A non-owner cannot reach the expense at all.
    const other = await call("PATCH", `/${draft.id}`, { ocrConfirmations: { amount: 335.5 } }, "other");
    assert.equal(other.status, 404);
  });

  test("a corrected total keeps both amounts and needs review even when confirmed", async () => {
    // Total read at 60%: the employee must confirm it; they change it.
    const job = await createScan((doc) => {
      doc.entities.find((e) => e.type === "total_amount").confidence = 0.6;
      return doc;
    });
    const draft = await createDraft(job);
    assert.deepEqual(draft.ocrFieldReviews.map((r) => r.field).sort(), ["amount", "expenseDate"]);
    const { status, body } = await withRouting(() =>
      call("POST", `/${draft.id}/submit`, {
        expense: { amount: 353.5, ocrConfirmations: { amount: 353.5, expenseDate: "2026-03-25" } },
      }),
    );
    assert.equal(status, 200, JSON.stringify(body));
    const total = body.ocrFieldReviews.find((r) => r.field === "amount");
    assert.equal(total.status, "corrected");
    assert.equal(total.ocrValue, 335.5);
    assert.equal(total.confirmedValue, 353.5);
    const finding = body.anomalyReport.anomalies.find((a) => a.ruleId === "ocr_total_corrected");
    assert.equal(finding.status, "needs_review");
    assert.deepEqual(finding.details, { scannedTotal: 335.5, submittedTotal: 353.5, difference: 18 });
    assert.equal(body.anomalyReport.route, "manager_approval");
    assert.equal(body.status, "Pending Approval");
  });

  test("a total changed on a confidently read scan is also flagged (default tolerance 0)", async () => {
    const draft = await createDraft(await createScan(), { amount: 335.51 });
    const finding = draft.anomalyReport.anomalies.find((a) => a.ruleId === "ocr_total_corrected");
    assert.equal(finding.status, "needs_review");
  });

  test("confirmation does not override missing required details", async () => {
    const draft = await createDraft(await createScan(), { purpose: "" });
    const { status, body } = await call("POST", `/${draft.id}/submit`, {
      expense: { ocrConfirmations: { expenseDate: "2026-03-25" } },
    });
    assert.equal(status, 400);
    assert.equal(body.error, "SUBMISSION_INCOMPLETE");
  });

  test("confirmation does not override duplicate detection", async () => {
    const first = await createDraft(await createScan());
    await call("POST", `/${first.id}/submit`, { expense: { ocrConfirmations: { expenseDate: "2026-03-25" } } });
    const second = await createDraft(await createScan());
    const { body } = await call("POST", `/${second.id}/submit`, { expense: { ocrConfirmations: { expenseDate: "2026-03-25" } } });
    assert.equal(ruleStatus(body, "possible_duplicate_claim"), "flagged");
    assert.equal(ruleStatus(body, "receipt_unclear_or_invalid"), "passed");
    assert.equal(body.anomalyReport.route, "manager_approval");
  });

  test("an unread key field stays an unresolved OCR problem (not confirmable)", async () => {
    const job = await createScan((doc) => {
      doc.entities = doc.entities.filter((e) => e.type !== "supplier_name");
      return doc;
    });
    const draft = await createDraft(job, { merchant: "Typed By Employee" });
    assert.ok(!draft.ocrFieldReviews.some((r) => r.field === "merchant"));
    const { body } = await call("POST", `/${draft.id}/submit`, { expense: { ocrConfirmations: { expenseDate: "2026-03-25" } } });
    const finding = body.anomalyReport.anomalies.find((a) => a.ruleId === "receipt_unclear_or_invalid");
    assert.equal(finding.status, "needs_review");
    assert.match(finding.message, /merchant could not be read/);
    assert.equal(body.anomalyReport.route, "manager_approval");
  });

  test("expenses without OCR (manual) and older expenses are unaffected", async () => {
    const { status, body } = await call("POST", "", {
      merchant: "Manual Shop", expenseDate: "2026-03-20", amount: 100, currency: "PHP", category: "Meals",
      purpose: "Manual test", location: "Makati", position: "Tester", department: "QA",
      receiptFiles: [{ id: "f1", name: "r.pdf", mimeType: "application/pdf", size: 10, url: "https://example.test/r.pdf" }],
    });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.ocrFieldReviews, undefined);
    const submit = await call("POST", `/${body.id}/submit`, {});
    assert.equal(submit.status, 200, JSON.stringify(submit.body));
    // An older stored expense without the new field still loads and saves.
    await Expense.collection.updateOne({ _id: new mongoose.Types.ObjectId(body.id) }, { $unset: { ocrFieldReviews: "" } });
    assert.equal((await call("GET", `/${body.id}`)).status, 200);
  });
});
