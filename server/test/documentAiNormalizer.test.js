import "./setup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { isEmptyDocument, normalizeDocumentAiDocument } from "../src/services/documentAiNormalizer.js";
import { sampleDocument } from "./fixtures/documentAi.js";

test("maps Expense Parser entities to the ReceiptFlow expense shape", () => {
  const { expense, ocrMeta, audit } = normalizeDocumentAiDocument(sampleDocument());
  assert.equal(expense.merchant, "SAMPLE COFFEE HOUSE"); // most confident supplier_name wins
  assert.equal(expense.merchantAddress, "123 Test Street, Makati City");
  assert.equal(expense.receiptNumber, "TEST-00042");
  assert.equal(expense.expenseDate, "2026-03-25");
  assert.equal(expense.expenseTime, "14:32");
  assert.equal(expense.amount, 335.5);
  assert.equal(expense.subtotal, 299.55);
  assert.equal(expense.tax, 35.95);
  assert.equal(expense.currency, "PHP");
  assert.equal(expense.paymentMethod, "VISA");
  assert.equal(expense.cardLastFour, "4242");
  assert.equal(expense.category, undefined, "Document AI does not choose a category; the employee does");
  assert.deepEqual(expense.lineItems, [
    {
      id: "ocr-line-1",
      description: "Americano",
      quantity: 2,
      unitPrice: 120,
      total: 240,
      fieldConfidence: { description: 0.92, quantity: 0.9, unitPrice: 0.88, total: 0.91 },
    },
    { id: "ocr-line-2", description: "Blueberry Muffin", total: 95.5, fieldConfidence: { description: 0.87, total: 0.89 } },
  ]);
  assert.equal(expense.ocrConfidence.amount, 0.96);
  assert.equal(expense.ocrConfidence.merchant, 0.97);
  assert.equal(expense.originalOCR.amount, 335.5);
  assert.ok(expense.ocrText.includes("SAMPLE COFFEE HOUSE"));

  assert.equal(ocrMeta.provider, "google_document_ai");
  for (const field of ["merchant", "amount", "expenseDate"]) assert.ok(ocrMeta.fieldsExtracted.includes(field), field);
  assert.deepEqual(ocrMeta.unavailableSignals, ["provider_fraud_signal", "provider_duplicate_signal", "provider_document_check"]);
  assert.equal(ocrMeta.fraudColor, undefined);
  assert.equal(ocrMeta.isDuplicate, undefined);
  assert.equal(ocrMeta.pageCount, 1);
  assert.ok(audit.entityTypes.includes("line_item"));
});

test("omits fields the parser did not return (never guessed)", () => {
  const { expense, ocrMeta } = normalizeDocumentAiDocument({
    text: "SOME SHOP\nTOTAL 50.00",
    entities: [{ type: "total_amount", mentionText: "50.00", confidence: 0.7 }],
  });
  assert.equal(expense.amount, 50);
  for (const field of ["merchant", "expenseDate", "currency", "tax", "receiptNumber", "paymentMethod", "cardLastFour"]) {
    assert.equal(expense[field], undefined, field);
  }
  assert.deepEqual(expense.lineItems, []);
  assert.deepEqual(ocrMeta.fieldsExtracted, ["amount"]);
});

test("currency falls back to the total's currency code", () => {
  const doc = sampleDocument();
  doc.entities = doc.entities.filter((e) => e.type !== "currency");
  assert.equal(normalizeDocumentAiDocument(doc).expense.currency, "PHP");
});

test("an ambiguous numeric date needs the employee's confirmation", () => {
  const { expense } = normalizeDocumentAiDocument({
    text: "SHOP\nDate: 10/03/2026\nTOTAL 20.00",
    entities: [
      { type: "receipt_date", mentionText: "10/03/2026", confidence: 0.95, normalizedValue: { dateValue: { year: 2026, month: 10, day: 3 } } },
    ],
  });
  assert.equal(expense.dateReview?.ambiguous, true);
  assert.equal(expense.ocrConfidence.expenseDate, 0);
});

test("parses printed amounts when no normalized money value is present", () => {
  const amount = (mentionText) => normalizeDocumentAiDocument({ text: "x", entities: [{ type: "total_amount", mentionText }] }).expense.amount;
  assert.equal(amount("₱1,234.50"), 1234.5);
  assert.equal(amount("PHP 12,50"), 12.5);
  assert.equal(amount("(15.00)"), -15);
  assert.equal(amount("n/a"), undefined);
});

test("12-hour purchase times are converted", () => {
  const time = (text) => normalizeDocumentAiDocument({ text: "x", entities: [{ type: "purchase_time", mentionText: text }] }).expense.expenseTime;
  assert.equal(time("02:05 PM"), "14:05");
  assert.equal(time("12:10 am"), "00:10");
});

test("detects an empty (unreadable) document", () => {
  assert.equal(isEmptyDocument({ text: "", entities: [] }), true);
  assert.equal(isEmptyDocument({}), true);
  assert.equal(isEmptyDocument(sampleDocument()), false);
});
