// Provider switch, anomaly rules on OCR output, Veryfi regression, credential
// parsing, the time-limited circuit and identical-upload reuse. No network or DB.
import { SYNTHETIC_KEY } from "./setup.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { env, parseGoogleCredentials } from "../src/config/env.js";
import { Expense } from "../src/models/Expense.js";
import { ReceiptJob } from "../src/models/ReceiptJob.js";
import { anomalyRules } from "../src/services/anomaly/anomalyRules.js";
import { __setTestHooks } from "../src/services/googleDocumentAiService.js";
import { createCircuit, ocrError } from "../src/services/ocrErrors.js";
import { activeOcrProvider, assertOcrSupportsFile, ocrStatus, readReceipt } from "../src/services/ocrProvider.js";
import { findReusableReceiptJob } from "../src/services/receiptProcessing.js";
import { normalizeVeryfiDocument } from "../src/services/receiptNormalizer.js";
import { toSafeError as veryfiSafeError } from "../src/services/veryfiService.js";
import { sampleDocument } from "./fixtures/documentAi.js";

const rule = (id) => anomalyRules.find((r) => r.id === id);
const silence = () => {
  const original = console.error;
  console.error = () => {};
  return () => (console.error = original);
};
const originalProvider = env.ocrProvider;
afterEach(() => {
  env.ocrProvider = originalProvider;
});

test("OCR_PROVIDER selects Google Document AI", () => {
  assert.equal(activeOcrProvider(), "google_document_ai");
  assert.equal(ocrStatus(), "configured");
});

test("Google pipeline: provider document → normalized expense in the existing shape", async () => {
  __setTestHooks({ factory: () => ({ processDocument: async () => [{ document: sampleDocument() }] }) });
  const file = { buffer: Buffer.from([0xff, 0xd8, 0xff]), mimetype: "image/jpeg" };
  const { expense, ocrMeta } = await readReceipt(file, { fileName: "sample.jpg", requestId: "t" });
  assert.equal(expense.merchant, "SAMPLE COFFEE HOUSE");
  assert.equal(expense.amount, 335.5);
  assert.equal(ocrMeta.provider, "google_document_ai");
});

test("Google pipeline: a blank image is reported as unreadable", async () => {
  __setTestHooks({ factory: () => ({ processDocument: async () => [{ document: { text: "", entities: [] } }] }) });
  await assert.rejects(readReceipt({ buffer: Buffer.from("x"), mimetype: "image/png" }, { fileName: "blank.png" }), { code: "OCR_UNREADABLE", status: 422 });
});

test("file-type check applies to Google only (Veryfi still accepts HEIC)", () => {
  assert.throws(() => assertOcrSupportsFile("image/heic"), { code: "OCR_UNSUPPORTED_FILE" });
  assertOcrSupportsFile("application/pdf");
  env.ocrProvider = "veryfi";
  assertOcrSupportsFile("image/heic");
});

test("anomaly: Google's missing fraud/duplicate signals are 'not evaluated', never passed", () => {
  const { ocrMeta } = normalizeDocumentAi();
  const outcome = rule("ocr_provider_screening").evaluate({ ocr: ocrMeta });
  assert.equal(outcome.status, "not_evaluated");
  assert.match(outcome.message, /fraud-risk screening/);
  assert.deepEqual(outcome.details.unavailableSignals, ["provider_fraud_signal", "provider_duplicate_signal", "provider_document_check"]);
});

test("anomaly: receipt clarity and ReceiptFlow's own duplicate check still run on Google output", () => {
  const { ocrMeta, expense } = normalizeDocumentAi();
  assert.equal(rule("receipt_unclear_or_invalid").evaluate({ ocr: ocrMeta }).status, "passed");
  const low = { ...ocrMeta, confidence: { ...ocrMeta.confidence, amount: 0.2 } };
  assert.equal(rule("receipt_unclear_or_invalid").evaluate({ ocr: low }).status, "needs_review");
  const dup = rule("possible_duplicate_claim").evaluate({ expense, ocr: ocrMeta, duplicates: [{ id: "e1", requestNumber: "EXP-1" }] });
  assert.equal(dup.status, "flagged");
  assert.equal(rule("possible_duplicate_claim").evaluate({ expense, ocr: ocrMeta, duplicates: [] }).status, "passed");
});

test("anomaly (Veryfi regression): its fraud and duplicate signals still apply", () => {
  const veryfiMeta = normalizeVeryfiDocument(veryfiDoc({ meta: { fraud: { color: "red" } }, is_duplicate: true })).ocrMeta;
  assert.equal(rule("ocr_provider_screening").evaluate({ ocr: veryfiMeta }).status, "passed");
  const clarity = rule("receipt_unclear_or_invalid").evaluate({ ocr: veryfiMeta });
  assert.equal(clarity.status, "needs_review");
  assert.match(clarity.message, /fraud-risk/);
  assert.equal(rule("possible_duplicate_claim").evaluate({ expense: {}, ocr: veryfiMeta, duplicates: [] }).status, "flagged");
  assert.equal(rule("ocr_provider_screening").evaluate({ ocr: null }).status, "not_evaluated");
});

test("Veryfi normalizer regression: field mapping unchanged", () => {
  const { expense, ocrMeta } = normalizeVeryfiDocument(veryfiDoc());
  assert.equal(expense.merchant, "Sample Store");
  assert.equal(expense.amount, 112);
  assert.equal(expense.tax, 12);
  assert.equal(expense.currency, "PHP");
  assert.equal(expense.receiptNumber, "INV-1");
  assert.equal(expense.expenseDate, "2026-03-25");
  assert.equal(expense.lineItems[0].total, 100);
  assert.equal(ocrMeta.provider, "veryfi");
  assert.equal(ocrMeta.unavailableSignals, undefined);
});

test("Veryfi errors: an ended trial is an account problem; other 401/403 are credentials", () => {
  const restore = silence();
  try {
    const trial = new Error('Error: 403 {"status":"fail","error":"You trial has ended please contact support@veryfi.com to upgrade your account."}');
    assert.equal(veryfiSafeError(trial).code, "OCR_ACCOUNT_INACTIVE");
    assert.equal(veryfiSafeError(new Error('Error: 401 {"error":"Not Authorized"}')).code, "OCR_AUTH_FAILED");
    assert.equal(veryfiSafeError(new Error("Error: 429 {}")).code, "OCR_RATE_LIMITED");
    assert.equal(veryfiSafeError(new Error("timeout of 90000ms exceeded, timed out")).code, "OCR_TIMEOUT");
  } finally {
    restore();
  }
});

test("circuit: permanent failures block until an administrator acts; no automatic retry", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const circuit = createCircuit();
  for (const transient of [ocrError.rateLimited(), ocrError.timeout(), ocrError.unavailable(), ocrError.documentRejected()]) {
    circuit.record(transient);
  }
  assert.equal(circuit.status(), null, "transient errors never block");
  circuit.record(ocrError.accountInactive());
  circuit.record(ocrError.authFailed()); // the first cause is kept
  assert.equal(circuit.status(), "account_inactive");
  assert.equal(circuit.error().code, "OCR_ACCOUNT_INACTIVE");
  t.mock.timers.tick(7 * 24 * 60 * 60_000); // a week later, still blocked
  assert.equal(circuit.status(), "account_inactive");
  const misconfigured = createCircuit();
  misconfigured.record(ocrError.misconfigured());
  assert.equal(misconfigured.error().code, "OCR_MISCONFIGURED");
});

test("credentials: raw JSON and base64 accepted; malformed keys rejected without echoing them", () => {
  const json = JSON.stringify(SYNTHETIC_KEY);
  assert.equal(parseGoogleCredentials(json).credentials.client_email, SYNTHETIC_KEY.client_email);
  assert.equal(parseGoogleCredentials(Buffer.from(json).toString("base64")).credentials.client_email, SYNTHETIC_KEY.client_email);
  for (const bad of ["{not json", JSON.stringify({ ...SYNTHETIC_KEY, type: "authorized_user" }), JSON.stringify({ ...SYNTHETIC_KEY, private_key: "" })]) {
    const { credentials, error } = parseGoogleCredentials(bad);
    assert.equal(credentials, null);
    assert.ok(error && !error.includes("PRIVATE KEY"));
  }
  assert.equal(env.googleDocumentAi.credentialsSource, "GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON", "the sealed variable takes precedence");
});

test("identical upload: a job still processing or an unlinked finished job is reused", async (t) => {
  const job = (status, ageMs, extra = {}) => ({ _id: "job1", status, createdAt: new Date(Date.now() - ageMs), ...extra });
  let found;
  let linked = null;
  t.mock.method(ReceiptJob, "findOne", (query) => {
    assert.equal(query.fileSha256, "abc");
    assert.equal(query.uploadedBy, "user-1");
    assert.equal(query.ocrProvider, "google_document_ai");
    return { sort: async () => found };
  });
  t.mock.method(Expense, "exists", async () => linked);
  const reuse = () => findReusableReceiptJob({ uploadedBy: "user-1", fileSha256: "abc" });

  found = job("processing", 5_000);
  assert.equal((await reuse())?.status, "processing");
  found = job("processing", 10 * 60_000); // stuck far beyond the OCR timeout
  assert.equal(await reuse(), null);
  found = job("ready", 60_000);
  assert.equal((await reuse())?.status, "ready");
  linked = { _id: "expense1" };
  assert.equal(await reuse(), null, "a scan already used by an expense is never reused");
  assert.equal(await findReusableReceiptJob({ uploadedBy: undefined, fileSha256: "abc" }), null);
});

function normalizeDocumentAi() {
  return normalizeDocumentAiDocumentSync(sampleDocument());
}
import { normalizeDocumentAiDocument as normalizeDocumentAiDocumentSync } from "../src/services/documentAiNormalizer.js";

function veryfiDoc(extra = {}) {
  return {
    id: 1,
    vendor: { name: { value: "Sample Store", score: 0.9 } },
    date: { value: "2026-03-25 10:00:00", score: 0.9 },
    total: { value: 112, score: 0.95 },
    tax: { value: 12, score: 0.9 },
    currency_code: { value: "PHP", score: 0.9 },
    invoice_number: { value: "INV-1", score: 0.8 },
    ocr_text: "Sample Store\n25/03/2026\nTOTAL 112.00",
    line_items: [{ description: "Item", total: 100 }],
    ...extra,
  };
}
