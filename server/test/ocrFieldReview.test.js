import "./setup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "../src/config/env.js";
import {
  comparableValue,
  isMaterialTotalCorrection,
  lowConfidenceOcrFields,
  OCR_CONFIDENCE_THRESHOLD,
  sameValue,
} from "../src/services/ocrFieldReview.js";
import { LOW_CONFIDENCE } from "../src/services/anomaly/anomalyRules.js";

test("threshold unchanged at 0.80 and shared with the anomaly rules", () => {
  assert.equal(OCR_CONFIDENCE_THRESHOLD, 0.8);
  assert.equal(LOW_CONFIDENCE, 0.8);
});

test("only key fields read below 0.80 need confirmation; unread fields do not", () => {
  const job = {
    result: { merchant: "M", expenseDate: "2026-03-25", amount: 10 },
    ocrMeta: { fieldsExtracted: ["merchant", "expenseDate", "amount", "tax"], confidence: { merchant: 0.8, expenseDate: 0.79, amount: 0.2, tax: 0.1 } },
  };
  assert.deepEqual(lowConfidenceOcrFields(job), [
    { field: "expenseDate", reason: "low_confidence", ocrValue: "2026-03-25", ocrConfidence: 0.79 },
    { field: "amount", reason: "low_confidence", ocrValue: 10, ocrConfidence: 0.2 },
  ]);
  assert.deepEqual(lowConfidenceOcrFields({ result: {}, ocrMeta: { fieldsExtracted: [], confidence: {} } }), []);
  assert.deepEqual(lowConfidenceOcrFields(null), []);
});

test("exact-value comparison: amounts to the cent, text exactly (trimmed)", () => {
  assert.equal(sameValue("amount", 335.5, "335.50"), true);
  assert.equal(sameValue("amount", 335.5, 335.51), false);
  assert.equal(sameValue("merchant", " Shop ", "Shop"), true);
  assert.equal(sameValue("merchant", "Shop", "shop"), false);
  assert.equal(sameValue("expenseDate", "", ""), false, "an empty value is never confirmed");
  assert.equal(comparableValue("amount", "abc"), null);
});

test("total tolerance: default 0 flags any change", () => {
  assert.deepEqual(env.ocrTotalCorrectionTolerance, { amount: 0, percent: 0 });
  assert.equal(isMaterialTotalCorrection(335.5, 335.5), false);
  assert.equal(isMaterialTotalCorrection(335.5, 335.51), true);
  assert.equal(isMaterialTotalCorrection(335.5, 300), true);
});

test("total tolerance (proposal): within tolerance only when within BOTH limits", () => {
  const tolerance = { amount: 1, percent: 0.5 }; // example values only, pending Finance approval
  assert.equal(isMaterialTotalCorrection(335.5, 336.5, tolerance), false, "1.00 ≤ 1.00 and ≤ 1.67 (0.5%)");
  assert.equal(isMaterialTotalCorrection(335.5, 336.51, tolerance), true, "1.01 over the amount limit");
  assert.equal(isMaterialTotalCorrection(100, 100.9, tolerance), true, "0.90 over 0.5% of 100 (0.50)");
  assert.equal(isMaterialTotalCorrection(100, 99.5, tolerance), false, "0.50 within both");
});
