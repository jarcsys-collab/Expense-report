// Philippine receipt reading, VAT consistency and field statuses. Mocked documents
// only: no Google request, no database.
import "./setup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { IMPORTANT_FIELDS, isSummaryLabel, normalizeDocumentAiDocument, receiptNumberFromText } from "../src/services/documentAiNormalizer.js";
import { buildOcrQuality } from "../src/services/ocrFieldStatus.js";
import { receiptConsistencyIssues } from "../src/services/receiptConsistency.js";
import { anomalyRules } from "../src/services/anomaly/anomalyRules.js";
import { inconsistentVatReceipt, restaurantVatReceipt, textOnlyReceipt } from "./fixtures/philippineReceipts.js";

const codes = (expense) => receiptConsistencyIssues(expense).map((issue) => issue.code);
const clarity = anomalyRules.find((rule) => rule.id === "unclear_or_inconsistent_details");

test("VAT summary lines are figures, not purchases", () => {
  const { expense, ocrMeta } = normalizeDocumentAiDocument(restaurantVatReceipt());
  assert.deepEqual(expense.lineItems.map((item) => item.description), ["Sinigang", "Rice"]);
  assert.equal(ocrMeta.droppedLineItems, 5);
  assert.deepEqual(expense.vatBreakdown, { vatableSales: 500, vatExemptSales: 0, zeroRatedSales: 0 });
  assert.equal(expense.tax, 60);
  assert.equal(expense.amount, 560);
  assert.equal(expense.currency, "PHP");
  assert.equal(expense.receiptNumber, "0012345");
});

test("a VAT summary that adds up raises nothing", () => {
  const { expense, ocrMeta } = normalizeDocumentAiDocument(restaurantVatReceipt());
  assert.deepEqual(ocrMeta.flags, []);
  assert.deepEqual(codes(expense), []);
});

test("inconsistent VAT figures are flagged, and never changed", () => {
  const { expense, ocrMeta } = normalizeDocumentAiDocument(inconsistentVatReceipt());
  assert.deepEqual(codes(expense).sort(), ["vat_breakdown_mismatch", "vat_rate_mismatch"]);
  assert.ok(ocrMeta.flags.some((flag) => flag.code === "vat_breakdown_mismatch"));
  assert.equal(expense.vatBreakdown.vatableSales, 400, "the printed value is kept");
  assert.equal(expense.amount, 560);
  const outcome = clarity.evaluate({ expense, stage: "extraction", today: "2026-11-09" });
  assert.equal(outcome.status, "needs_review");
  assert.match(outcome.message, /VAT breakdown adds up to 460\.00/);
});

test("a VAT breakdown that was not printed is not checked and not assumed to be zero", () => {
  const { expense } = normalizeDocumentAiDocument({ text: "SHOP\nTOTAL 100.00", entities: [] });
  assert.equal(expense.vatBreakdown, undefined);
  assert.deepEqual(codes({ amount: 100, tax: 12 }), []);
});

test("discounts and service charges can explain a VAT summary", () => {
  const breakdown = { vatableSales: 500 };
  assert.deepEqual(codes({ amount: 610, tax: 60, serviceCharge: 50, vatBreakdown: breakdown }), []);
  assert.deepEqual(codes({ amount: 510, tax: 60, discount: 50, vatBreakdown: breakdown }), []);
  assert.deepEqual(codes({ amount: 700, tax: 60, vatBreakdown: breakdown }), ["vat_breakdown_mismatch"]);
});

test("tax that is not less than the total is flagged", () => {
  assert.deepEqual(codes({ amount: 50, tax: 60 }), ["tax_not_less_than_total"]);
});

test("figures only printed in the text get confidence 0 and need the employee", () => {
  const { expense, ocrMeta } = normalizeDocumentAiDocument(textOnlyReceipt());
  assert.equal(expense.amount, 1400);
  assert.equal(expense.subtotal, 1250);
  assert.equal(expense.tax, 150);
  assert.equal(expense.receiptNumber, "000777");
  for (const field of ["amount", "subtotal", "tax", "receiptNumber"]) assert.equal(expense.ocrConfidence[field], 0, field);
  assert.equal(ocrMeta.confidence.amount, 0, "the total must be confirmed by the employee");
  assert.equal(ocrMeta.averageConfidence, 0.9, "ReceiptFlow's own readings are not provider scores");
  assert.equal(expense.currency, undefined, "PHP on the total line is left for the employee to confirm");
});

test("a total is never taken from a look-alike line or a conflicting pair", () => {
  const read = (text) => normalizeDocumentAiDocument({ text, entities: [] }).expense.amount;
  assert.equal(read("Total Items 12.00\nTotal Qty 3.00"), undefined);
  assert.equal(read("TOTAL 100.00\nTOTAL 200.00"), undefined);
  assert.equal(read("nothing here"), undefined);
});

test("peso amounts in common forms; odd separators are not guessed", () => {
  const total = (mentionText) =>
    normalizeDocumentAiDocument({ text: "x", entities: [{ type: "total_amount", mentionText, confidence: 0.9 }] }).expense.amount;
  assert.equal(total("PHP 1,234.50"), 1234.5);
  assert.equal(total("₱1,234,567.00"), 1234567);
  assert.equal(total("Php 335.5"), 335.5);
  assert.equal(total("₱ 1 234.50"), 1234.5);
  assert.equal(total("12,50"), 12.5);
  assert.equal(total("1.234,50"), undefined);
  assert.equal(total("1,23,4.00"), undefined);
});

test("receipt numbers: more label forms, and non-numbers stay rejected", () => {
  assert.equal(receiptNumberFromText("Invoice: SI-00123"), "SI-00123");
  assert.equal(receiptNumberFromText("OR No.\n00123"), "00123");
  assert.equal(receiptNumberFromText("Sales Invoice #\nA-77"), "A-77");
  assert.equal(receiptNumberFromText("Receipt: Copy"), undefined);
  assert.equal(receiptNumberFromText("TIN 000-111-222-00000\nInvoice No 09171234567"), undefined);
  assert.equal(receiptNumberFromText("OR No: 111\nSI No: 222"), undefined);
});

test("two printed receipt numbers are flagged as ambiguous, not chosen between", () => {
  const { expense, ocrMeta } = normalizeDocumentAiDocument({ text: "OR No: 111\nSI No: 222", entities: [] });
  assert.equal(expense.receiptNumber, undefined);
  assert.ok(ocrMeta.flags.some((flag) => flag.code === "receipt_number_ambiguous"));
});

test("a parser 'receipt number' that is really a date or phone number is not used", () => {
  const read = (mentionText, text = "x") =>
    normalizeDocumentAiDocument({ text, entities: [{ type: "receipt_id", mentionText, confidence: 0.95 }] });
  for (const bad of ["25/03/2026", "09171234567", "000-111-222"]) {
    const { expense, ocrMeta } = read(bad);
    assert.equal(expense.receiptNumber, undefined, bad);
    assert.ok(ocrMeta.flags.some((flag) => flag.code === "receipt_number_rejected"), bad);
  }
  assert.equal(read("25/03/2026", "OR No: 555").expense.receiptNumber, "555", "the labelled value is used instead");
});

test("a parser number that disagrees with the labelled one is flagged", () => {
  const { expense, ocrMeta } = normalizeDocumentAiDocument({ text: "OR No: 555", entities: [{ type: "receipt_id", mentionText: "999", confidence: 0.9 }] });
  assert.equal(expense.receiptNumber, "999");
  assert.ok(ocrMeta.flags.some((flag) => flag.code === "receipt_number_conflict"));
});

test("summary labels are recognized; real purchases are kept", () => {
  for (const label of ["VATable Sales", "VAT-Exempt Sales", "Zero-Rated Sales", "Non-VAT Sales", "Total Items", "Amount Tendered", "Less SC Discount"]) {
    assert.equal(isSummaryLabel(label), true, label);
  }
  for (const label of ["Total Gym Pass", "Tax Guide Book", "Vat of Soup", "Change Purse"]) assert.equal(isSummaryLabel(label), false, label);
});

test("original OCR values and scores are preserved; missing fields are listed, not invented", () => {
  const { expense, ocrMeta } = normalizeDocumentAiDocument(restaurantVatReceipt());
  assert.equal(expense.originalOCR.amount, 560);
  assert.equal(expense.ocrConfidence.amount, 0.97);
  assert.equal(ocrMeta.confidence.merchant, 0.95);
  assert.deepEqual(ocrMeta.missingFields, ["subtotal"]);
  assert.ok(IMPORTANT_FIELDS.includes("vatableSales"));
  assert.ok(!("subtotal" in expense), "an unread subtotal stays absent");
});

test("field status: extracted, confirmed, corrected, provided and missing are told apart", () => {
  const { expense: result, ocrMeta } = normalizeDocumentAiDocument(textOnlyReceipt());
  const job = { result, ocrMeta };
  const expense = {
    merchant: result.merchant, // unchanged
    merchantAddress: "Typed by the employee", // the scan had none
    expenseDate: "", // nobody has one
    receiptNumber: result.receiptNumber,
    currency: "PHP", // the schema default, not confirmed
    amount: 1500, // changed
    subtotal: result.subtotal,
    tax: result.tax,
    paymentMethod: "",
    ocrFieldReviews: [{ field: "tax", status: "confirmed" }],
  };
  const statuses = Object.fromEntries(buildOcrQuality(expense, job).fields.map((item) => [item.field, item.status]));
  assert.equal(statuses.merchant, "extracted");
  assert.equal(statuses.merchantAddress, "provided");
  assert.equal(statuses.expenseDate, "missing");
  assert.equal(statuses.amount, "corrected");
  assert.equal(statuses.paymentMethod, "missing");
  assert.equal(statuses.currency, "missing", "a defaulted currency does not count as read");
  assert.equal(statuses.tax, "confirmed");
});

test("field status: a defaulted money 0 is not a value; manual expenses have none", () => {
  const job = { result: { amount: 100 }, ocrMeta: { confidence: {} } };
  const status = buildOcrQuality({ amount: 100, subtotal: 0, tax: 0 }, job).fields;
  assert.equal(status.find((item) => item.field === "subtotal").status, "missing");
  assert.equal(buildOcrQuality({ amount: 100 }, null), undefined);
});
