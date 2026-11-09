// Which receipts are loaded from the server and what the viewer says, loaded through Vite.
// The full preview flow in a real browser is tests/e2e/receiptPreview.mjs.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite;
let source;
let normalizers;
let viewer;
let react;
let renderToStaticMarkup;

before(async () => {
  vite = await createServer({ logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
  source = await vite.ssrLoadModule("/src/utils/receiptSource.js");
  normalizers = await vite.ssrLoadModule("/src/services/normalizers.js");
  viewer = await vite.ssrLoadModule("/src/components/receipts/ReceiptViewer.jsx");
  react = await import("react");
  ({ renderToStaticMarkup } = await import("react-dom/server"));
});
after(async () => vite?.close());

const JOB = "65f000000000000000000001";
const SAVED = { id: "65f000000000000000000002", receiptJobId: JOB };
const scanFile = (url = "") => ({ id: `job-${JOB}`, name: "image.jpg", mimeType: "image/jpeg", url });

test("a saved scan is loaded from the server, including one with a leftover blob link", () => {
  assert.equal(source.isStoredScanFile(scanFile(), SAVED), true);
  assert.equal(source.isStoredScanFile(scanFile("blob:http://app/old"), SAVED), true);
});

test("everything else keeps its own link or its details", () => {
  assert.equal(source.isStoredScanFile(scanFile("https://files.example.test/r.jpg"), SAVED), false, "a real link is used as it is");
  assert.equal(source.isStoredScanFile(scanFile("blob:http://app/new"), { id: "4b1f7a9e-unsaved", receiptJobId: JOB }), false, "an unsaved scan shows its local preview");
  assert.equal(source.isStoredScanFile({ id: "manual-1", url: "" }, SAVED), false, "another file of the expense");
  assert.equal(source.isStoredScanFile(scanFile(), { id: SAVED.id }), false, "no scan on the expense");
  assert.equal(source.isStoredScanFile({ id: "job-65f000000000000000000099", url: "" }, SAVED), false, "another scan's entry");
  assert.equal(source.isStoredScanFile(scanFile(), undefined), false, "no expense given");
  assert.equal(source.isStoredScanFile(undefined, SAVED), false, "no file given");
});

test("failed loads are told apart: only a genuinely absent file says it isn't available", () => {
  const absent = source.describeReceiptLoadFailure({ status: 404, code: "RECEIPT_FILE_NOT_FOUND" });
  assert.match(absent.message, /isn’t available/);
  assert.equal(absent.canRetry, false);
  const signedOut = source.describeReceiptLoadFailure({ status: 401 });
  assert.match(signedOut.message, /signed out/i);
  assert.equal(signedOut.canRetry, true);
  for (const error of [{ status: 403 }, { status: 404, code: "EXPENSE_NOT_FOUND" }]) {
    const refused = source.describeReceiptLoadFailure(error);
    assert.match(refused.message, /don’t have access/);
    assert.equal(refused.canRetry, false);
  }
  for (const error of [{ status: 500 }, { status: 503 }, new Error("Network request failed"), undefined]) {
    const passing = source.describeReceiptLoadFailure(error);
    assert.match(passing.message, /couldn’t be loaded/);
    assert.equal(passing.canRetry, true);
    assert.doesNotMatch(passing.message, /not stored|isn’t available/, "a passing failure never claims the file is gone");
  }
});

test("the viewer starts by loading a saved scan, never by saying it isn't stored", () => {
  const html = renderToStaticMarkup(react.createElement(viewer.ReceiptViewer, { file: scanFile(), expense: SAVED }));
  assert.match(html, /Loading the original receipt/);
  assert.doesNotMatch(html, /not stored/);
  assert.match(html, /image\.jpg/);
});

test("a saved expense keeps its scan link, and blob links are never sent to the server", () => {
  const expense = normalizers.normalizeExpense(
    { id: SAVED.id, status: "Draft", receiptJobId: JOB, receiptFiles: [{ id: `job-${JOB}`, name: "image.jpg", mimeType: "image/jpeg", size: 10, url: "" }] },
    { saved: true },
  );
  assert.equal(source.isStoredScanFile(expense.receiptFiles[0], expense), true, "after a reload the preview still finds the server copy");
  const payload = normalizers.toExpensePayload({ ...expense, receiptFiles: [scanFile("blob:http://app/x")] });
  assert.equal(payload.receiptFiles[0].url, undefined);
  assert.equal(payload.receiptJobId, JOB);
});
