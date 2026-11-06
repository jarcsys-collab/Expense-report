// Pre-deployment hardening: 10 MB upload limit, duplicate privacy, server-only
// approver assignment, receipt-file access and abandoned-upload cleanup.
// Real routes, throwaway in-memory MongoDB, mocked Google (no billable calls).
import "./setup.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
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
import { receiptsRouter } from "../src/routes/receipts.js";
import { violationsRouter } from "../src/routes/violations.js";
import { normalizeDocumentAiDocument } from "../src/services/documentAiNormalizer.js";
import { __setTestHooks } from "../src/services/googleDocumentAiService.js";
import { cleanupAbandonedReceiptFiles } from "../src/services/receiptCleanup.js";
import { safeDownloadName, storeReceiptFile } from "../src/services/receiptFileStore.js";
import { liveShapedSyntheticDocument } from "./fixtures/documentAi.js";

const RECEIPT_JPG = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/synthetic-receipt.jpg"));
const USERS = {
  alice: { id: "emp-alice", name: "Alice Employee", provider: "beta", role: "EMPLOYEE" },
  bob: { id: "emp-bob", name: "Bob Employee", provider: "beta", role: "EMPLOYEE" },
  approver: { id: "appr-1", name: "Assigned Approver", provider: "beta", role: "APPROVER" },
  finance: { id: "fin-1", name: "Finance Admin", provider: "beta", role: "FINANCE_ADMIN" },
};
const DAY = 24 * 60 * 60 * 1000;

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
    req.user = USERS[req.get("x-test-user") ?? "alice"];
    next();
  });
  app.use("/api/expenses", expensesRouter);
  app.use("/api/receipts", receiptsRouter);
  app.use("/api/violations", violationsRouter);
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

async function call(method, route, body, user = "alice") {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    headers: response.headers,
    raw: type.includes("json") ? null : Buffer.from(await response.arrayBuffer()),
    body: type.includes("json") ? await response.json() : null,
  };
}
async function upload(bytes, name = "synthetic-receipt.jpg", user = "alice") {
  const form = new FormData();
  form.append("receipt", new Blob([bytes], { type: "image/jpeg" }), name);
  const response = await fetch(`${api}/receipts/upload`, { method: "POST", headers: { "x-test-user": user }, body: form });
  return { status: response.status, body: await response.json() };
}
async function createScan(uploadedBy, { createdAt, status = "needs_review", withFile = false } = {}) {
  const doc = liveShapedSyntheticDocument();
  doc.entities.find((e) => e.type === "receipt_date").confidence = 0.95;
  const { expense, ocrMeta, audit } = normalizeDocumentAiDocument(doc);
  const job = await ReceiptJob.create({
    status, originalFileName: "synthetic-receipt.jpg", mimeType: "image/jpeg", size: RECEIPT_JPG.length,
    uploadedBy, ocrProvider: "google_document_ai", result: expense, ocrMeta, audit,
  });
  if (withFile) job.fileId = await storeReceiptFile(job, { buffer: RECEIPT_JPG, mimetype: "image/jpeg" });
  await job.save();
  if (createdAt) {
    await ReceiptJob.collection.updateOne({ _id: job._id }, { $set: { createdAt } });
    if (job.fileId) await mongoose.connection.db.collection("receiptFiles.files").updateOne({ _id: job.fileId }, { $set: { uploadDate: createdAt } });
  }
  return job;
}
async function saveRequest(job, user, overrides = {}) {
  const { status, ...extracted } = job.result;
  const created = await call("POST", "/expenses", {
    ...extracted, receiptJobId: String(job._id), category: "Meals", purpose: "Synthetic", location: "Makati",
    position: "Tester", department: "QA", ...overrides,
  }, user);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const saved = await call("POST", `/expenses/${created.body.id}/submit`, {}, user);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return saved.body;
}
const fileCount = () => mongoose.connection.db.collection("receiptFiles.files").countDocuments();
const chunkCount = () => mongoose.connection.db.collection("receiptFiles.chunks").countDocuments();

describe("Upload size limit (10 MB)", () => {
  test("a file over 10 MB is refused before any OCR or storage, with a clear message", async () => {
    const big = Buffer.concat([RECEIPT_JPG.subarray(0, 4), Buffer.alloc(10 * 1024 * 1024 + 1)]);
    const response = await upload(big);
    assert.equal(response.status, 413);
    assert.equal(response.body.error, "FILE_TOO_LARGE");
    assert.match(response.body.message, /larger than 10 MB/);
    assert.equal(googleCalls, 0);
    assert.equal(await ReceiptJob.countDocuments(), 0);
    assert.equal(await fileCount(), 0);
  });

  test("a file just under 10 MB is accepted", async () => {
    const fits = Buffer.concat([RECEIPT_JPG, Buffer.alloc(10 * 1024 * 1024 - RECEIPT_JPG.length - 10)]);
    assert.equal((await upload(fits)).status, 201);
  });

  test("HEIC is refused for Google Document AI with a clear message", async () => {
    const form = new FormData();
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(32)]);
    form.append("receipt", new Blob([heic], { type: "image/heic" }), "photo.heic");
    const response = await fetch(`${api}/receipts/upload`, { method: "POST", headers: { "x-test-user": "alice" }, body: form });
    const body = await response.json();
    assert.equal(response.status, 415);
    assert.match(body.message, /HEIC/);
    assert.equal(googleCalls, 0);
  });
});

describe("Duplicate detection privacy", () => {
  test("another employee's duplicate is reported generically, never identified", async () => {
    const alices = await saveRequest(await createScan(USERS.alice.id), "alice");
    const bobs = await saveRequest(await createScan(USERS.bob.id), "bob");
    const finding = bobs.anomalyReport.anomalies.find((a) => a.ruleId === "possible_duplicate_claim");
    assert.equal(finding.status, "flagged");
    assert.match(finding.message, /submitted by another employee/);
    assert.deepEqual(finding.details.matches, []);
    assert.equal(finding.details.otherEmployeeMatches, 1);
    assert.deepEqual(bobs.possibleDuplicates, [{ id: "other-employee", otherEmployee: true }]);
    const everything = JSON.stringify(bobs);
    for (const secret of [alices.requestNumber, alices.id, "Alice Employee", USERS.alice.id]) {
      assert.ok(!everything.includes(secret), `Bob's response must not contain ${secret}`);
    }
    // Every other way Bob can read it.
    for (const route of [`/expenses/${bobs.id}`, "/expenses", "/violations"]) {
      const text = JSON.stringify((await call("GET", route, undefined, "bob")).body);
      assert.ok(!text.includes(alices.requestNumber) && !text.includes("Alice Employee"), route);
    }
    assert.equal(bobs.anomalyReport.route, "manager_approval", "still flagged for review");
  });

  test("the upload response hides other employees' duplicates too", async () => {
    const alices = await saveRequest(await createScan(USERS.alice.id), "alice");
    const scan = await upload(RECEIPT_JPG, "synthetic-receipt.jpg", "bob");
    assert.equal(scan.status, 201);
    const text = JSON.stringify(scan.body);
    assert.ok(!text.includes(alices.requestNumber) && !text.includes("Alice Employee"));
    assert.deepEqual(scan.body.expense.possibleDuplicates, [{ id: "other-employee", otherEmployee: true }]);
  });

  test("an employee's own earlier request is named, as before", async () => {
    const first = await saveRequest(await createScan(USERS.alice.id), "alice");
    const second = await saveRequest(await createScan(USERS.alice.id), "alice");
    const finding = second.anomalyReport.anomalies.find((a) => a.ruleId === "possible_duplicate_claim");
    assert.match(finding.message, new RegExp(`of yours found: ${first.requestNumber}`));
    assert.equal(second.possibleDuplicates[0].requestNumber, first.requestNumber);
  });

  test("Finance sees the full duplicate details", async () => {
    const alices = await saveRequest(await createScan(USERS.alice.id), "alice");
    const bobs = await saveRequest(await createScan(USERS.bob.id), "bob");
    const view = await call("GET", `/expenses/${bobs.id}`, undefined, "finance");
    assert.equal(view.body.possibleDuplicates[0].requestNumber, alices.requestNumber);
    assert.equal(view.body.possibleDuplicates[0].employeeName, "Alice Employee");
    assert.equal(view.body.possibleDuplicates[0].sameEmployee, false);
  });

  test("records saved before this change are redacted for employees", async () => {
    const alices = await saveRequest(await createScan(USERS.alice.id), "alice");
    const bobs = await saveRequest(await createScan(USERS.bob.id), "bob");
    const legacyMessage = `Similar previous expense found: ${alices.requestNumber}.`;
    await Expense.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(bobs.id) },
      {
        $set: {
          possibleDuplicates: [{ id: alices.id, requestNumber: alices.requestNumber, merchant: "SAMPLE COFFEE HOUSE", amount: 335.5 }],
          "anomalyReport.anomalies.$[a].message": legacyMessage,
          "anomalyReport.anomalies.$[a].details": { matches: [alices.id] },
          "policyViolations.$[v].message": legacyMessage,
        },
      },
      { arrayFilters: [{ "a.ruleId": "possible_duplicate_claim" }, { "v.id": "anomaly-possible_duplicate_claim" }] },
    );
    const view = await call("GET", `/expenses/${bobs.id}`, undefined, "bob");
    const text = JSON.stringify(view.body);
    assert.ok(!text.includes(alices.requestNumber), "legacy message and matches are not shown to the employee");
    assert.ok(!text.includes(alices.id));
    const financeView = await call("GET", `/expenses/${bobs.id}`, undefined, "finance");
    assert.ok(JSON.stringify(financeView.body).includes(alices.requestNumber));
  });
});

describe("Approver assignment is server-controlled", () => {
  test("employees cannot assign an approver when creating, editing or saving", async () => {
    const job = await createScan(USERS.alice.id);
    const { status, ...extracted } = job.result;
    const created = await call("POST", "/expenses", { ...extracted, receiptJobId: String(job._id), assignedApproverId: USERS.bob.id });
    assert.equal(created.body.assignedApproverId, "");
    const patched = await call("PATCH", `/expenses/${created.body.id}`, { assignedApproverId: USERS.bob.id });
    assert.equal(patched.body.assignedApproverId, "");
    await call("POST", `/expenses/${created.body.id}/submit`, { expense: { assignedApproverId: USERS.bob.id } });
    assert.equal((await Expense.findById(created.body.id)).assignedApproverId, "");
    // So Bob gains no access.
    assert.equal((await call("GET", `/expenses/${created.body.id}`, undefined, "bob")).status, 404);
  });

  test("existing assignments are preserved and keep giving that approver read access", async () => {
    const saved = await saveRequest(await createScan(USERS.alice.id), "alice");
    await Expense.updateOne({ _id: saved.id }, { $set: { assignedApproverId: USERS.approver.id } });
    await call("PATCH", `/expenses/${saved.id}`, { purpose: "Changed", assignedApproverId: USERS.bob.id });
    assert.equal((await Expense.findById(saved.id)).assignedApproverId, USERS.approver.id);
    assert.equal((await call("GET", `/expenses/${saved.id}`, undefined, "approver")).status, 200);
    assert.equal((await call("PATCH", `/expenses/${saved.id}`, { purpose: "x" }, "approver")).status, 403);
  });
});

describe("Receipt file access", () => {
  test("safe headers on the original file", async () => {
    const saved = await saveRequest(await createScan(USERS.alice.id, { withFile: true }), "alice");
    const file = await call("GET", `/expenses/${saved.id}/receipt`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "image/jpeg");
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.equal(file.headers.get("cache-control"), "private, no-store");
    assert.equal(file.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.match(file.headers.get("content-security-policy"), /default-src 'none'.*sandbox/);
    assert.match(file.headers.get("content-disposition"), /^inline; filename="synthetic-receipt\.jpg"$/);
    assert.ok(Buffer.compare(file.raw, RECEIPT_JPG) === 0);
  });

  test("hostile stored names are neutralised", () => {
    assert.equal(safeDownloadName('evil"\r\nSet-Cookie: x=1.jpg'), "evil___Set-Cookie_ x_1.jpg");
    assert.equal(safeDownloadName("../../etc/passwd"), "passwd");
    assert.equal(safeDownloadName("..\\..\\win.ini"), "win.ini");
    assert.equal(safeDownloadName(""), "receipt");
  });

  test("a stored file with an unexpected type is never served", async () => {
    const job = await createScan(USERS.alice.id, { withFile: true });
    const saved = await saveRequest(job, "alice");
    await ReceiptJob.updateOne({ _id: job._id }, { $set: { mimeType: "text/html" } });
    assert.equal((await call("GET", `/expenses/${saved.id}/receipt`)).status, 404);
    assert.equal((await call("GET", `/receipts/${job._id}/file`)).status, 404);
  });

  test("no IDOR: other employees and unassigned approvers cannot download by id", async () => {
    const job = await createScan(USERS.alice.id, { withFile: true });
    const saved = await saveRequest(job, "alice");
    for (const user of ["bob", "approver"]) {
      assert.equal((await call("GET", `/expenses/${saved.id}/receipt`, undefined, user)).status, 404, user);
      assert.equal((await call("GET", `/receipts/${job._id}/file`, undefined, user)).status, 404, user);
    }
    assert.equal((await call("GET", `/expenses/${saved.id}/receipt`, undefined, "finance")).status, 200);
    assert.equal((await call("GET", `/expenses/${new mongoose.Types.ObjectId()}/receipt`)).status, 404);
    assert.equal((await call("GET", "/expenses/not-an-id/receipt")).status, 400);
  });
});

describe("Abandoned receipt cleanup", () => {
  async function scenario() {
    const now = new Date();
    const old = new Date(now.getTime() - 8 * DAY);
    const abandoned = await createScan(USERS.alice.id, { createdAt: old, withFile: true });
    const savedJob = await createScan(USERS.alice.id, { createdAt: old, withFile: true });
    await saveRequest(savedJob, "alice"); // saved request
    const draftJob = await createScan(USERS.bob.id, { createdAt: old, withFile: true });
    const { status, ...extracted } = draftJob.result;
    const draft = await call("POST", "/expenses", { ...extracted, receiptJobId: String(draftJob._id) }, "bob");
    await ReceiptJob.updateOne({ _id: draftJob._id }, { $unset: { expenseId: 1 } }); // only the expense points to it
    const processing = await createScan(USERS.alice.id, { createdAt: old, withFile: true, status: "processing" });
    const recent = await createScan(USERS.alice.id, { createdAt: new Date(now.getTime() - 2 * DAY), withFile: true });
    // An orphan file (no scan points to it), old.
    const orphanJob = await createScan(USERS.alice.id, { createdAt: old, withFile: true });
    await ReceiptJob.deleteOne({ _id: orphanJob._id });
    return { now, abandoned, savedJob, draftJob, draft: draft.body, processing, recent, orphanFileId: orphanJob.fileId };
  }
  const silent = () => {};

  test("dry run reports and deletes nothing", async () => {
    const s = await scenario();
    const before = await fileCount();
    const summary = await cleanupAbandonedReceiptFiles({ now: s.now, log: silent });
    assert.equal(summary.dryRun, true);
    assert.equal(summary.wouldDelete, 1);
    assert.deepEqual(summary.jobIds, [String(s.abandoned._id)]);
    assert.equal(summary.orphanFilesWouldDelete, 1);
    assert.equal(await fileCount(), before);
  });

  test("removes only abandoned and orphaned files; keeps saved, draft, processing and recent ones", async () => {
    const s = await scenario();
    const before = await fileCount();
    const lines = [];
    const summary = await cleanupAbandonedReceiptFiles({ now: s.now, dryRun: false, log: (l) => lines.push(l) });
    assert.equal(summary.deleted, 1);
    assert.equal(summary.orphanFilesDeleted, 1);
    assert.equal(summary.skippedReferenced, 1, "the draft's scan is kept");
    assert.equal(summary.errors, 0);
    assert.equal(await fileCount(), before - 2);
    const abandoned = await ReceiptJob.findById(s.abandoned._id);
    assert.equal(abandoned.fileId, undefined);
    assert.ok(abandoned.fileDeletedAt, "scan record kept, deletion noted");
    for (const job of [s.savedJob, s.draftJob, s.processing, s.recent]) {
      assert.ok((await ReceiptJob.findById(job._id)).fileId, `${job._id} keeps its file`);
    }
    // Chunks are gone too; the saved request still opens its receipt.
    const savedExpense = await Expense.findOne({ receiptJobId: s.savedJob._id });
    assert.equal((await call("GET", `/expenses/${savedExpense.id}/receipt`)).status, 200);
    assert.equal(await chunkCount(), await fileCount());
    assert.match(lines.at(-1), /\[receipt-cleanup\] .*deleted 1 file\(s\) of 2 abandoned scan\(s\); kept 1 linked to an expense/);
  });

  test("idempotent: a second run deletes nothing more", async () => {
    const s = await scenario();
    await cleanupAbandonedReceiptFiles({ now: s.now, dryRun: false, log: silent });
    const again = await cleanupAbandonedReceiptFiles({ now: s.now, dryRun: false, log: silent });
    assert.equal(again.deleted, 0);
    assert.equal(again.orphanFilesDeleted, 0);
    assert.equal(again.errors, 0);
  });

  test("concurrent runs delete each file once, without errors", async () => {
    const s = await scenario();
    const runs = await Promise.all([1, 2, 3].map(() => cleanupAbandonedReceiptFiles({ now: s.now, dryRun: false, log: silent })));
    assert.equal(runs.reduce((n, r) => n + r.deleted, 0), 1);
    assert.equal(runs.reduce((n, r) => n + r.errors, 0), 0);
  });

  test("a file already missing is treated as deleted", async () => {
    const s = await scenario();
    await new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "receiptFiles" }).delete(s.abandoned.fileId);
    const summary = await cleanupAbandonedReceiptFiles({ now: s.now, dryRun: false, log: silent });
    assert.equal(summary.deleted, 1);
    assert.equal(summary.errors, 0);
  });
});

describe("Request body hardening (body-parser 2.4)", () => {
  const post = (body, encoding) =>
    fetch(`${api}/expenses`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": encoding, "x-test-user": "alice" }, body });

  test("a valid gzip-compressed JSON body still works", async () => {
    const response = await post(gzipSync(JSON.stringify({ merchant: "Gzip Shop", amount: 1, currency: "PHP" })), "gzip");
    assert.equal(response.status, 201);
    assert.equal((await response.json()).merchant, "Gzip Shop");
  });

  test("a compressed body with trailing bytes is rejected as a client error, not a server error", async () => {
    const response = await post(Buffer.concat([gzipSync("{}"), Buffer.alloc(2048, 7)]), "gzip");
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "INVALID_REQUEST_BODY", message: "The request body could not be read." });
  });

  test("an unsupported content encoding is a 415 without echoing parser internals", async () => {
    const response = await post(Buffer.from("{}"), "compress");
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error, "UNSUPPORTED_MEDIA_TYPE");
  });
});
