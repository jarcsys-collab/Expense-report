// Receipt preparation logic and the OCR field display, loaded through Vite.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite;
let image;
let files;
let normalizers;
let summary;
let react;
let renderToStaticMarkup;

before(async () => {
  vite = await createServer({ logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
  image = await vite.ssrLoadModule("/src/utils/receiptImage.js");
  files = await vite.ssrLoadModule("/src/utils/receiptFile.js");
  normalizers = await vite.ssrLoadModule("/src/services/normalizers.js");
  summary = await vite.ssrLoadModule("/src/components/receipts/OcrFieldSummary.jsx");
  react = await import("react");
  ({ renderToStaticMarkup } = await import("react-dom/server"));
});
after(async () => vite?.close());

const MB = 1024 * 1024;

test("output scale: ordinary photos shrink, long receipts keep readable width, small images never grow", () => {
  assert.equal(image.outputScale(1200, 1600), 1);
  const photo = image.outputScale(3000, 4000);
  assert.ok(Math.abs(photo * 4000 - 2800) > 0 || photo <= 1);
  assert.equal(Math.round(3000 * photo), 2100, "a 12 MP photo keeps 2100 px across");
  const long = image.outputScale(1000, 5000);
  assert.equal(long, 1, "a long narrow receipt is not reduced");
  const wide = image.outputScale(3000, 9000);
  assert.ok(Math.round(3000 * wide) >= 1800 && Math.round(9000 * wide) <= 6000);
  const huge = image.outputScale(9000, 12000);
  assert.ok(9000 * huge * 12000 * huge <= 16_000_001, "stays within phone canvas limits");
});

test("crop: edges stay in range and cannot cross", () => {
  const moved = image.moveCropEdge(image.FULL_CROP, "left", 0.95);
  assert.ok(moved.left <= 0.9);
  const both = image.moveCropEdge({ left: 0.6, right: 0, top: 0, bottom: 0 }, "right", 0.6);
  assert.ok(1 - both.left - both.right >= 0.0999);
  assert.deepEqual(image.clampCrop({ left: -1, top: "x", right: 0.1, bottom: 2 }).left, 0);
  assert.ok(image.clampCrop({ left: 0, top: 0.5, right: 0, bottom: 0.8 }).top + image.clampCrop({ left: 0, top: 0.5, right: 0, bottom: 0.8 }).bottom <= 0.9001);
});

test("rotation keeps the crop on the same content", () => {
  const start = { left: 0.1, top: 0.2, right: 0.3, bottom: 0.05 };
  assert.deepEqual(image.rotateCropClockwise(start), { left: 0.05, top: 0.1, right: 0.2, bottom: 0.3 });
  let crop = start;
  for (let turn = 0; turn < 4; turn += 1) crop = image.rotateCropClockwise(crop);
  assert.deepEqual(crop, start, "four turns return to the start");
});

test("render geometry: rotation swaps sides; crop sets the offset and the output", () => {
  const plain = image.renderGeometry(1000, 2000);
  assert.deepEqual([plain.outputWidth, plain.outputHeight], [1000, 2000]);
  const turned = image.renderGeometry(1000, 2000, 90);
  assert.deepEqual([turned.outputWidth, turned.outputHeight], [2000, 1000]);
  const cropped = image.renderGeometry(1000, 2000, 0, { left: 0.1, top: 0.25, right: 0.1, bottom: 0.25 });
  assert.deepEqual([cropped.outputWidth, cropped.outputHeight, cropped.offsetX, cropped.offsetY], [800, 1000, 100, 500]);
});

test("enhancement: faded text gains contrast; a blank page is not distorted", () => {
  const faded = new Uint8ClampedArray(4 * 100);
  for (let i = 0; i < 100; i += 1) {
    const level = i < 20 ? 110 : 180;
    faded.set([level, level, level, 255], i * 4);
  }
  image.enhancePixels(faded);
  assert.equal(faded[0], 0, "the darkest text becomes black");
  assert.equal(faded[99 * 4], 255, "the paper becomes white");
  assert.equal(faded[3], 255, "alpha is untouched");
  const blank = new Uint8ClampedArray(4 * 10).fill(200);
  image.enhancePixels(blank);
  assert.equal(blank[0], 200);
});

test("an unedited small file is uploaded untouched, so duplicate detection still matches", async () => {
  const file = { name: "r.jpg", type: "image/jpeg", size: MB };
  assert.equal(image.needsProcessing(file, {}), false);
  const result = await image.prepareReceiptFile(file, {});
  assert.equal(result.file, file);
  assert.equal(result.processed, false);
});

test("what goes through the canvas", () => {
  const photo = { name: "r.jpg", type: "image/jpeg", size: MB };
  assert.equal(image.needsProcessing(photo, { rotation: 90 }), true);
  assert.equal(image.needsProcessing(photo, { enhance: true }), true);
  assert.equal(image.needsProcessing(photo, { crop: { left: 0.1, top: 0, right: 0, bottom: 0 } }), true);
  assert.equal(image.needsProcessing({ ...photo, size: 4 * MB }, {}), true, "large photos are compressed");
  const pdf = { name: "r.pdf", type: "application/pdf", size: 9 * MB };
  assert.equal(image.needsProcessing(pdf, { rotation: 90 }), false, "PDFs are never touched");
  const heic = { name: "IMG.HEIC", type: "", size: MB };
  assert.equal(image.isHeic(heic), true);
  assert.equal(image.needsProcessing(heic, {}, { acceptsHeic: false }), true, "converted for Google OCR");
  assert.equal(image.needsProcessing(heic, {}, { acceptsHeic: true }), false);
});

test("HEIC that can't be converted is explained; nothing is uploaded", async () => {
  globalThis.createImageBitmap = async () => {
    throw new Error("cannot decode");
  };
  try {
    await assert.rejects(() => image.prepareReceiptFile({ name: "a.heic", type: "image/heic", size: MB }, {}, { acceptsHeic: false }), /Most Compatible/);
  } finally {
    delete globalThis.createImageBitmap;
  }
  assert.match(image.HEIC_NOT_SUPPORTED_MESSAGE, /Google OCR/);
});

test("an oversized photo may be chosen because it gets compressed; a PDF may not; the limit stands", () => {
  const big = { name: "photo.jpg", type: "image/jpeg", size: 15 * MB };
  assert.throws(() => files.validateReceiptFile(big), /larger than 10 MB/);
  assert.doesNotThrow(() => files.validateReceiptFile(big, { allowOversizedImage: true }));
  assert.throws(() => files.validateReceiptFile({ name: "a.pdf", type: "application/pdf", size: 15 * MB }, { allowOversizedImage: true }), /larger than 10 MB/);
});

test("formatBytes", () => {
  assert.equal(image.formatBytes(512), "1 KB");
  assert.equal(image.formatBytes(4.25 * MB), "4.3 MB");
});

test("the camera uses the browser's file capture: no camera permission is requested", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const path of ["../src/pages/AssistantPage.jsx", "../src/components/receipts/ReceiptUploader.jsx", "../src/components/receipts/ReceiptPrepareModal.jsx"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /getUserMedia/);
  }
  assert.match(await readFile(new URL("../src/pages/AssistantPage.jsx", import.meta.url), "utf8"), /capture="environment"/);
});

test("choosing a file does not start a scan: only confirming the preview does", async () => {
  const { readFile } = await import("node:fs/promises");
  const assistant = await readFile(new URL("../src/pages/AssistantPage.jsx", import.meta.url), "utf8");
  const start = assistant.slice(assistant.indexOf("function startScan"), assistant.indexOf("function beginScan"));
  assert.doesNotMatch(start, /runScan|uploadReceipt|UPLOAD_STARTED/);
  assert.match(start, /setPendingFile\(file\)/);
  const uploader = await readFile(new URL("../src/components/receipts/ReceiptUploader.jsx", import.meta.url), "utf8");
  const review = uploader.slice(uploader.indexOf("function reviewFiles"), uploader.indexOf("function nextPending"));
  assert.doesNotMatch(review, /addFiles/);
  assert.equal((uploader.match(/addFiles\(/g) ?? []).length, 2, "the two confirm actions are the only callers");
});

test("field statuses and VAT figures are shown as told by the server", () => {
  const expense = normalizers.normalizeExpense({
    id: "6aed640cbeb1f481c06d018b",
    merchant: "M",
    amount: 560,
    currency: "PHP",
    vatBreakdown: { vatableSales: 500, vatExemptSales: 0 },
    ocrQuality: {
      provider: "google_document_ai",
      fields: [
        { field: "merchant", status: "extracted", confidence: 0.95 },
        { field: "amount", status: "corrected", confidence: 0.9 },
        { field: "subtotal", status: "missing", confidence: null },
        { field: "expenseDate", status: "confirmed", confidence: 0.43 },
        { field: "merchantAddress", status: "provided", confidence: null },
      ],
    },
  });
  const html = renderToStaticMarkup(react.createElement(summary.OcrFieldSummary, { expense }));
  for (const text of ["Read from receipt", "Corrected", "Missing", "Confirmed", "Entered by employee", "95% confidence", "VATable sales", "VAT-exempt sales"]) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(!html.includes("Zero-rated"), "a figure that was not printed is not shown as zero");
  assert.equal(renderToStaticMarkup(react.createElement(summary.OcrFieldSummary, { expense: { merchant: "M" } })), "");
});

test("server-held OCR records are never sent back", () => {
  const payload = normalizers.toExpensePayload({ id: "x", vatBreakdown: { vatableSales: 1 }, ocrQuality: { fields: [] }, receiptFiles: [] });
  assert.equal(payload.vatBreakdown, undefined);
  assert.equal(payload.ocrQuality, undefined);
});
