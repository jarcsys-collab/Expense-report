// Regression tests from the live Expense Parser test on the synthetic receipt:
// currency, receipt-number fallback and summary-line cleanup.
import "./setup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  currencyCodeOf,
  isSummaryLabel,
  normalizeDocumentAiDocument,
  receiptNumberFromText,
} from "../src/services/documentAiNormalizer.js";
import { anomalyRules } from "../src/services/anomaly/anomalyRules.js";
import { liveShapedSyntheticDocument, sampleDocument } from "./fixtures/documentAi.js";

test("synthetic receipt (live shape): PHP, TEST-00042 and exactly the two purchased items", () => {
  const { expense, ocrMeta, audit } = normalizeDocumentAiDocument(liveShapedSyntheticDocument());
  assert.equal(expense.currency, "PHP");
  assert.equal(expense.ocrConfidence.currency, 0.79, "confidence of the currency entity that supplied it");
  assert.equal(expense.receiptNumber, "TEST-00042");
  assert.equal(expense.ocrConfidence.receiptNumber, 0, "text fallback is shown as Needs review");
  assert.deepEqual(ocrMeta.textFallbackFields, ["receiptNumber"]);
  assert.equal(ocrMeta.confidence.receiptNumber, undefined, "not reported as a provider score");
  assert.equal(audit.receipt_number_source, "ocr_text_label");
  assert.deepEqual(
    expense.lineItems.map(({ id, description, quantity, total }) => ({ id, description, quantity, total })),
    [
      { id: "ocr-line-1", description: "Americano", quantity: 2, total: 240 },
      { id: "ocr-line-2", description: "Blueberry Muffin", quantity: 1, total: 95.5 },
    ],
  );
  assert.equal(ocrMeta.droppedLineItems, 1);
  // Unchanged fields from the live result.
  assert.equal(expense.merchant, "SAMPLE COFFEE HOUSE");
  assert.equal(expense.expenseDate, "2026-03-25");
  assert.equal(expense.amount, 335.5);
  assert.equal(expense.tax, 35.95);
  assert.equal(expense.cardLastFour, "4242");
  assert.equal(expense.originalOCR.receiptNumber, "TEST-00042");
});

test("currency: ISO codes and single-currency symbols only; ambiguous evidence is not guessed", () => {
  assert.equal(currencyCodeOf("PHP"), "PHP");
  assert.equal(currencyCodeOf("Php"), "PHP");
  assert.equal(currencyCodeOf("₱"), "PHP");
  assert.equal(currencyCodeOf("₱ 335.50"), "PHP");
  assert.equal(currencyCodeOf("PHP 335.50"), "PHP");
  assert.equal(currencyCodeOf("usd"), "USD");
  assert.equal(currencyCodeOf("€"), "EUR");
  for (const unclear of ["$", "¥", "P", "P335.50", "TOTAL", "XYZ", "", undefined, "TOTAL PHP 335.50"]) {
    assert.equal(currencyCodeOf(unclear), undefined, String(unclear));
  }
});

test("currency: no clear evidence leaves the field empty", () => {
  const doc = liveShapedSyntheticDocument();
  doc.entities = doc.entities.filter((e) => e.type !== "currency");
  doc.entities.find((e) => e.type === "total_amount").mentionText = "$335.50";
  const { expense } = normalizeDocumentAiDocument(doc);
  assert.equal(expense.currency, undefined);
});

test("currency: printed total such as '₱335.50' is used when no currency entity exists", () => {
  const doc = liveShapedSyntheticDocument();
  doc.entities = doc.entities.filter((e) => e.type !== "currency");
  doc.entities.find((e) => e.type === "total_amount").mentionText = "₱335.50";
  assert.equal(normalizeDocumentAiDocument(doc).expense.currency, "PHP");
});

test("receipt number: labelled values are found", () => {
  assert.equal(receiptNumberFromText("OR No: TEST-00042"), "TEST-00042");
  assert.equal(receiptNumberFromText("O.R. No. 0000123456"), "0000123456");
  assert.equal(receiptNumberFromText("SI No.: 004512"), "004512");
  assert.equal(receiptNumberFromText("S.I. # A-7781"), "A-7781");
  assert.equal(receiptNumberFromText("Receipt No 88213"), "88213");
  assert.equal(receiptNumberFromText("Invoice Number: INV-2026/0042"), "INV-2026/0042");
  assert.equal(receiptNumberFromText("Official Receipt No. 991"), "991");
  assert.equal(receiptNumberFromText("Sales Invoice #12-55"), "12-55");
});

test("receipt number: dates, totals, phones, cards, TINs and unlabelled numbers are not taken", () => {
  const notReceiptNumbers = [
    "Date: 25/03/2026\nTOTAL 335.50\nTel 09171234567",
    "OR No: 25/03/2026",
    "Receipt No: 335.50",
    "Invoice No: 09171234567",
    "Invoice No: 4111111111111111",
    "OR No: 000-000-000-000",
    "TIN No: 123-456-789",
    "VISA **** 4242",
    "Store or no refund policy",
    "Pepsi No 2",
    "Vendor No: 55",
    "Card No: 4242",
    "Transaction 12345",
  ];
  for (const text of notReceiptNumbers) assert.equal(receiptNumberFromText(text), undefined, text);
});

test("receipt number: two different labelled values are ambiguous and not guessed", () => {
  assert.equal(receiptNumberFromText("OR No: 1001\nSI No: 2002"), undefined);
  assert.equal(receiptNumberFromText("OR No: 1001\nOR No: 1001 (copy)"), "1001");
});

test("receipt number: a provider entity wins over the text fallback (provider confidence kept)", () => {
  const doc = liveShapedSyntheticDocument();
  doc.entities.push({ type: "receipt_id", mentionText: "PROV-1", confidence: 0.9 });
  const { expense, ocrMeta } = normalizeDocumentAiDocument(doc);
  assert.equal(expense.receiptNumber, "PROV-1");
  assert.equal(expense.ocrConfidence.receiptNumber, 0.9);
  assert.deepEqual(ocrMeta.textFallbackFields, []);
});

test("summary labels: subtotal, VAT, discounts, tax and totals are recognised", () => {
  for (const label of [
    "VATable Sales 299.55",
    "VAT 12% 35.95",
    "VAT-Exempt Sales 0.00",
    "Zero-Rated Sales",
    "Subtotal",
    "SUB-TOTAL 299.55",
    "Discount -10.00",
    "Senior Citizen Discount",
    "PWD Discount (20%)",
    "Sales Tax",
    "Tax",
    "TOTAL PHP 335.50",
    "Grand Total",
    "Amount Due",
    "Cash Tendered 500.00",
    "Change 164.50",
    "Service Charge",
  ]) {
    assert.equal(isSummaryLabel(label), true, label);
  }
  for (const item of ["Americano", "Blueberry Muffin", "Total Gym Pass", "Tax Guide Book", "Discount Voucher Book", "Cash Register Tape", "Vatican Postcard", "2 x 120.00"]) {
    assert.equal(isSummaryLabel(item), false, item);
  }
});

test("line items: summary lines are dropped, real items kept with quantities and prices", () => {
  const doc = sampleDocument();
  doc.text += "\nSubtotal 335.50\nDiscount 10.00";
  doc.entities.push(
    { type: "line_item", mentionText: "Subtotal 335.50", properties: [{ type: "line_item/description", mentionText: "Subtotal" }] },
    { type: "line_item", mentionText: "Discount 10.00", properties: [{ type: "line_item/amount", mentionText: "10.00" }] },
    { type: "line_item", mentionText: "Total Gym Pass 500.00", properties: [{ type: "line_item/description", mentionText: "Total Gym Pass" }, { type: "line_item/amount", mentionText: "500.00" }] },
  );
  const { expense, ocrMeta } = normalizeDocumentAiDocument(doc);
  assert.deepEqual(
    expense.lineItems.map((i) => [i.description, i.quantity, i.unitPrice, i.total]),
    [
      ["Americano", 2, 120, 240],
      ["Blueberry Muffin", undefined, undefined, 95.5],
      ["Total Gym Pass", undefined, undefined, 500],
    ],
  );
  assert.equal(ocrMeta.droppedLineItems, 2);
  assert.deepEqual(expense.lineItems.map((i) => i.id), ["ocr-line-1", "ocr-line-2", "ocr-line-3"]);
});

test("line items: a number-only item is kept when no summary line prints that amount", () => {
  const doc = sampleDocument();
  doc.entities.push({ type: "line_item", mentionText: "77.00", properties: [{ type: "line_item/amount", mentionText: "77.00" }] });
  const { expense } = normalizeDocumentAiDocument(doc);
  assert.equal(expense.lineItems.length, 3, "kept for the employee to review rather than silently removed");
});

test("anomaly (threshold unchanged at 0.80): the live receipt's 0.43 date confidence needs review", () => {
  const { ocrMeta } = normalizeDocumentAiDocument(liveShapedSyntheticDocument());
  const outcome = anomalyRules.find((r) => r.id === "receipt_unclear_or_invalid").evaluate({ ocr: ocrMeta });
  assert.equal(outcome.status, "needs_review");
  assert.match(outcome.message, /date was read with low confidence \(43%\)/);
});
