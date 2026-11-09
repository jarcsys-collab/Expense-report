// The original receipt: kept through OCR, linked to the expense, served only after an
// access check. No database and no OCR provider: models and GridFS are in-memory fakes.
import "./setup.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import express from "express";
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { createApp } from "../src/app.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { Category } from "../src/models/Category.js";
import { Expense } from "../src/models/Expense.js";
import { OcrScanEvent } from "../src/models/OcrScanEvent.js";
import { ReceiptJob } from "../src/models/ReceiptJob.js";
import { expensesRouter } from "../src/routes/expenses.js";
import { receiptsRouter } from "../src/routes/receipts.js";
import { __setTestHooks } from "../src/services/googleDocumentAiService.js";
import { createJobFromPriorScan } from "../src/services/receiptProcessing.js";
import { liveShapedSyntheticDocument } from "./fixtures/documentAi.js";

const JPG = readFileSync(new URL("./fixtures/synthetic-receipt.jpg", import.meta.url));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("synthetic-png")]);
const WEBP = Buffer.from("RIFF0000WEBPsynthetic-webp", "latin1");
const PDF = Buffer.from("%PDF-1.4 synthetic", "latin1");
const USERS = {
  owner: { id: "emp-1", name: "Owner", provider: "beta", role: "EMPLOYEE" },
  other: { id: "emp-2", name: "Another Employee", provider: "beta", role: "EMPLOYEE" },
  approver: { id: "appr-1", name: "Assigned Approver", provider: "beta", role: "APPROVER" },
  approver2: { id: "appr-2", name: "Other Approver", provider: "beta", role: "APPROVER" },
  finance: { id: "fin-1", name: "Finance", provider: "beta", role: "FINANCE_ADMIN" },
};
const newId = () => new mongoose.Types.ObjectId();

// A Mongoose query stand-in: awaitable, with the chain methods the app calls.
const query = (value) => {
  const chain = { then: (ok, fail) => Promise.resolve(value).then(ok, fail), catch: (fail) => Promise.resolve(value).catch(fail) };
  for (const name of ["lean", "select", "sort", "limit", "collation"]) chain[name] = () => chain;
  return chain;
};

let files; // GridFS: id -> { buffer, filename, metadata }
let expenses;
let jobs;
let downloads;
let ocrCalls;
let server;
let api;
const realDb = Object.getOwnPropertyDescriptor(mongoose.connection, "db");

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = USERS[req.get("x-test-user") ?? "owner"];
    next();
  });
  app.use("/api/expenses", expensesRouter);
  app.use("/api/receipts", receiptsRouter);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  api = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
});

beforeEach(() => {
  files = new Map();
  expenses = new Map();
  jobs = new Map();
  downloads = 0;
  ocrCalls = 0;
  env.mongoUri = "memory://not-a-database";
  Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => 1 });
  Object.defineProperty(mongoose.connection, "db", { configurable: true, value: { collection: () => ({}) } });
  const Bucket = mongoose.mongo.GridFSBucket.prototype;
  mock.method(Bucket, "find", ({ _id }) => ({
    limit: () => ({
      toArray: async () => (files.has(String(_id)) ? [{ _id, length: files.get(String(_id)).buffer.length }] : []),
    }),
  }));
  mock.method(Bucket, "openDownloadStream", (id) => {
    downloads += 1;
    return Readable.from([files.get(String(id)).buffer]);
  });
  mock.method(Bucket, "openUploadStream", (filename, options) => {
    const id = newId();
    const chunks = [];
    const stream = new Writable({
      write(chunk, encoding, done) {
        chunks.push(chunk);
        done();
      },
      final(done) {
        files.set(String(id), { buffer: Buffer.concat(chunks), filename, metadata: options.metadata });
        done();
      },
    });
    stream.id = id;
    return stream;
  });
  mock.method(Expense, "findById", (id) => query(expenses.get(String(id)) ?? null));
  mock.method(Expense, "find", () => query([]));
  mock.method(Expense, "exists", ({ receiptJobId } = {}) =>
    query([...expenses.values()].some((expense) => String(expense.receiptJobId) === String(receiptJobId)) ? { _id: newId() } : null),
  );
  mock.method(Expense.prototype, "save", async function save() {
    expenses.set(String(this._id), this);
    return this;
  });
  mock.method(ReceiptJob, "findById", (id) => query(jobs.get(String(id)) ?? null));
  mock.method(ReceiptJob, "findOne", () => query(null));
  mock.method(ReceiptJob, "create", async (fields) => {
    const job = new ReceiptJob(fields);
    job.createdAt = new Date();
    jobs.set(String(job._id), job);
    return job;
  });
  mock.method(ReceiptJob.prototype, "save", async function save() {
    jobs.set(String(this._id), this);
    return this;
  });
  mock.method(Category, "find", () => query([{ name: "Meals", active: true }]));
  mock.method(Category, "findOne", () => query({ _id: newId(), name: "Meals", policyKey: null }));
  mock.method(OcrScanEvent, "create", async () => ({}));
  __setTestHooks({
    factory: () => ({
      processDocument: async () => {
        ocrCalls += 1;
        return [{ document: liveShapedSyntheticDocument() }];
      },
    }),
  });
});

afterEach(() => {
  mock.restoreAll();
  __setTestHooks({});
  env.mongoUri = "";
  delete mongoose.connection.readyState;
  if (realDb) Object.defineProperty(mongoose.connection, "db", realDb);
  else delete mongoose.connection.db;
});

function storedFile(buffer) {
  const id = newId();
  files.set(String(id), { buffer });
  return id;
}

/** A saved expense as production stores it, with its scan and (unless told not to) a file. */
function savedExpense({ mimeType = "image/jpeg", name = "image.jpg", buffer = JPG, withFile = true, withJob = true, ...fields } = {}) {
  const job = new ReceiptJob({
    status: "ready",
    originalFileName: name,
    mimeType,
    size: buffer.length,
    uploadedBy: USERS.owner.id,
    ...(withFile ? { fileId: storedFile(buffer) } : {}),
  });
  if (withJob) jobs.set(String(job._id), job);
  const expense = Expense.hydrate({
    _id: newId(),
    status: "Draft",
    employeeId: USERS.owner.id,
    activityLog: [],
    receiptFiles: withJob ? [{ id: `job-${job._id}`, name, mimeType, size: buffer.length, url: "" }] : [],
    ...(withJob ? { receiptJobId: job._id } : {}),
    ...fields,
  });
  expenses.set(String(expense._id), expense);
  return { expense, job };
}

const getReceipt = (expense, user = "owner") => fetch(`${api}/expenses/${expense._id}/receipt`, { headers: { "x-test-user": user } });

async function upload(buffer = JPG, name = "image.jpg", type = "image/jpeg") {
  const form = new FormData();
  form.append("receipt", new Blob([buffer], { type }), name);
  const response = await fetch(`${api}/receipts/upload`, { method: "POST", headers: { "x-test-user": "owner" }, body: form });
  return { status: response.status, body: await response.json() };
}

test("upload: the original is stored once and is still referenced after OCR succeeds", async () => {
  const { status, body } = await upload();
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(ocrCalls, 1, "the stubbed provider was read once");
  const job = jobs.get(body.jobId);
  assert.ok(["ready", "needs_review"].includes(job.status));
  assert.ok(job.fileId, "the scan keeps its file reference");
  assert.equal(files.size, 1);
  assert.deepEqual(files.get(String(job.fileId)).buffer, JPG, "the exact uploaded bytes are stored");
  assert.equal(body.expense.receiptJobId, body.jobId, "the response names the scan the expense must link to");
});

test("save: the expense references the scan and never holds the file itself", async () => {
  const { body: scan } = await upload();
  const response = await fetch(`${api}/expenses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      merchant: "Sample",
      receiptJobId: scan.jobId,
      // What the browser sends: its own preview entry, with the blob link removed.
      receiptFiles: [{ id: "browser-preview-1", name: "image.jpg", mimeType: "image/jpeg", size: JPG.length }],
    }),
  });
  const saved = await response.json();
  assert.equal(response.status, 201, JSON.stringify(saved));
  assert.deepEqual(
    saved.receiptFiles.map((file) => [file.id, file.url]),
    [[`job-${scan.jobId}`, ""]],
  );
  assert.equal(saved.receiptJobId, scan.jobId);
  assert.ok(!JSON.stringify(saved).includes(JPG.toString("base64").slice(0, 200)), "no image data in the expense");
  assert.equal(String(jobs.get(scan.jobId).expenseId), saved.id, "the scan points back at the expense");
  assert.equal(files.size, 1, "saving stores no second copy");

  // Reloading, or signing in again: a new request with only the expense id.
  const reopened = await getReceipt({ _id: saved.id });
  assert.equal(reopened.status, 200);
  assert.deepEqual(Buffer.from(await reopened.arrayBuffer()), JPG);
});

for (const [label, mimeType, name, buffer] of [
  ["JPG", "image/jpeg", "image.jpg", JPG],
  ["PNG", "image/png", "receipt.png", PNG],
  ["WEBP", "image/webp", "receipt.webp", WEBP],
  ["PDF", "application/pdf", "receipt.pdf", PDF],
]) {
  test(`retrieval: a stored ${label} comes back byte for byte, private and not script-capable`, async () => {
    const { expense } = savedExpense({ mimeType, name, buffer });
    const response = await getReceipt(expense);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), mimeType);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy"), /sandbox/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), buffer);
  });
}

test("ownership: only the owner, the assigned approver and Finance can read the file", async () => {
  const { expense } = savedExpense({ assignedApproverId: USERS.approver.id });
  for (const user of ["owner", "approver", "finance"]) {
    const response = await getReceipt(expense, user);
    assert.equal(response.status, 200, user);
    await response.arrayBuffer();
  }
  const allowed = downloads;
  for (const user of ["other", "approver2"]) {
    const response = await getReceipt(expense, user);
    assert.equal(response.status, 404, user);
    assert.equal((await response.json()).error, "EXPENSE_NOT_FOUND", user);
  }
  assert.equal(downloads, allowed, "a refused request never opens the file");
});

test("authentication: without a session the real app refuses the file (401)", async () => {
  const running = createApp().listen(0);
  await new Promise((resolve) => running.once("listening", resolve));
  try {
    const { expense } = savedExpense();
    const response = await fetch(`http://127.0.0.1:${running.address().port}/api/expenses/${expense._id}/receipt`);
    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve) => running.close(resolve));
  }
});

test("missing files: every older or broken record answers a clear 404, never a crash", async () => {
  const noScan = savedExpense({ withJob: false }).expense;
  const noFile = savedExpense({ withFile: false }).expense;
  const { expense: fileGone, job } = savedExpense();
  files.delete(String(job.fileId));
  const scanGone = savedExpense();
  jobs.delete(String(scanGone.job._id));
  for (const [label, expense] of Object.entries({ noScan, noFile, fileGone, scanGone: scanGone.expense })) {
    const response = await getReceipt(expense);
    assert.equal(response.status, 404, label);
    assert.equal((await response.json()).error, "RECEIPT_FILE_NOT_FOUND", label);
  }
});

test("a stored file of an unexpected type is refused, not served", async (t) => {
  t.mock.method(console, "error", () => {});
  const { expense } = savedExpense({ mimeType: "text/html", name: "x.html", buffer: Buffer.from("<script>") });
  assert.equal((await getReceipt(expense)).status, 404);
});

const priorScan = (fileId) =>
  new ReceiptJob({
    status: "ready",
    originalFileName: "image.jpg",
    mimeType: "image/jpeg",
    uploadedBy: USERS.owner.id,
    result: { merchant: "Sample", amount: 10 },
    ocrMeta: {},
    ...(fileId ? { fileId } : {}),
  });
const incoming = { originalname: "image.jpg", mimetype: "image/jpeg", size: JPG.length, buffer: JPG };
const identity = { uploadedBy: USERS.owner.id, fileSha256: "a".repeat(64) };

test("duplicate OCR reuse: a scan linked to an expense shares its file, with no copy and no OCR call", async () => {
  const fileId = storedFile(JPG);
  const prior = priorScan(fileId);
  expenses.set("linked", Expense.hydrate({ _id: newId(), status: "Draft", receiptJobId: prior._id }));
  let stores = 0;
  const job = await createJobFromPriorScan(prior, incoming, identity, async () => {
    stores += 1;
    return newId();
  });
  assert.equal(String(job.fileId), String(fileId));
  assert.equal(String(job.reusedFromJobId), String(prior._id));
  assert.equal(stores, 0);
  assert.equal(ocrCalls, 0);
});

test("duplicate OCR reuse: a scan with no expense, or no file, does not share: this upload stores its own", async () => {
  const ownCopy = newId();
  for (const prior of [priorScan(storedFile(JPG)), priorScan()]) {
    const job = await createJobFromPriorScan(prior, incoming, identity, async () => ownCopy);
    assert.equal(String(job.fileId), String(ownCopy));
  }
  assert.equal(ocrCalls, 0);
});
