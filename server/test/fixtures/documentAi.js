// Synthetic Document AI Expense Parser responses (no real receipt data).
const money = (amount, currencyCode = "PHP") => {
  const units = Math.trunc(amount);
  return { moneyValue: { currencyCode, units: String(units), nanos: Math.round((amount - units) * 1e9) }, text: `${currencyCode} ${amount}` };
};

export const SAMPLE_TEXT = [
  "SAMPLE COFFEE HOUSE",
  "123 Test Street, Makati City",
  "OR No: TEST-00042",
  "Date: 25/03/2026 14:32",
  "Americano          2 x 120.00   240.00",
  "Blueberry Muffin   1 x  95.50    95.50",
  "VATable Sales               299.55",
  "VAT 12%                      35.95",
  "TOTAL                    PHP 335.50",
  "VISA ****4242",
].join("\n");

export function sampleDocument() {
  return {
    text: SAMPLE_TEXT,
    pages: [{ pageNumber: 1 }],
    entities: [
      { type: "supplier_name", mentionText: "SAMPLE COFFEE HOUSE", confidence: 0.97 },
      { type: "supplier_name", mentionText: "Sample Coffee", confidence: 0.4 },
      { type: "supplier_address", mentionText: "123 Test Street,\nMakati City", confidence: 0.88 },
      { type: "receipt_id", mentionText: "TEST-00042", confidence: 0.81 },
      { type: "receipt_date", mentionText: "25/03/2026", confidence: 0.93, normalizedValue: { dateValue: { year: 2026, month: 3, day: 25 }, text: "2026-03-25" } },
      { type: "purchase_time", mentionText: "14:32", confidence: 0.9, normalizedValue: { text: "14:32" } },
      { type: "total_amount", mentionText: "PHP 335.50", confidence: 0.96, normalizedValue: money(335.5) },
      { type: "net_amount", mentionText: "299.55", confidence: 0.84, normalizedValue: money(299.55) },
      { type: "total_tax_amount", mentionText: "35.95", confidence: 0.86, normalizedValue: money(35.95) },
      { type: "currency", mentionText: "PHP", confidence: 0.92, normalizedValue: { text: "PHP" } },
      { type: "payment_type", mentionText: "VISA", confidence: 0.8 },
      { type: "credit_card_last_four_digits", mentionText: "4242", confidence: 0.85 },
      {
        type: "line_item",
        mentionText: "Americano 2 x 120.00 240.00",
        confidence: 0.9,
        properties: [
          { type: "line_item/description", mentionText: "Americano", confidence: 0.92 },
          { type: "line_item/quantity", mentionText: "2", confidence: 0.9 },
          { type: "line_item/unit_price", mentionText: "120.00", confidence: 0.88, normalizedValue: money(120) },
          { type: "line_item/amount", mentionText: "240.00", confidence: 0.91, normalizedValue: money(240) },
        ],
      },
      {
        type: "line_item",
        mentionText: "Blueberry Muffin 1 x 95.50 95.50",
        confidence: 0.85,
        properties: [
          { type: "line_item/description", mentionText: "Blueberry Muffin", confidence: 0.87 },
          { type: "line_item/amount", mentionText: "95.50", confidence: 0.89 },
        ],
      },
    ],
  };
}

/** Error shaped like the Google client's (gRPC status code + details). */
export function grpcError(code, details) {
  return Object.assign(new Error(`${code} ${details}`), { code, details });
}

// The synthetic receipt (test/fixtures/synthetic-receipt.jpg) as the live
// Expense Parser test returned it: no receipt-number entity, a currency entity
// without a normalized value, total without a currency code, and the
// "VATable Sales 299.55" line misread as a third line item.
export const SYNTHETIC_RECEIPT_TEXT = [
  "SAMPLE COFFEE HOUSE",
  "123 Test Street, Makati City",
  "TIN 000-000-000-000  (TEST)",
  "OFFICIAL RECEIPT",
  "OR No: TEST-00042",
  "Date: 25/03/2026   Time: 14:32",
  "Cashier: TEST",
  "--------------------------------",
  "Americano    2 x 120.00   240.00",
  "Blueberry Muffin 1 x 95.50  95.50",
  "--------------------------------",
  "VATable Sales            299.55",
  "VAT 12%                   35.95",
  "TOTAL               PHP  335.50",
  "Paid by: VISA **** 4242",
  "--------------------------------",
  "SYNTHETIC TEST RECEIPT",
  "NOT A REAL PURCHASE",
].join("\n");

const plainMoney = (amount) => {
  const units = Math.trunc(amount);
  return { moneyValue: { currencyCode: "", units: String(units), nanos: Math.round((amount - units) * 1e9) } };
};

export function liveShapedSyntheticDocument() {
  return {
    text: SYNTHETIC_RECEIPT_TEXT,
    pages: [{ pageNumber: 1 }],
    entities: [
      { type: "supplier_name", mentionText: "SAMPLE COFFEE HOUSE", confidence: 0.858 },
      { type: "supplier_address", mentionText: "123 Test Street, Makati City", confidence: 0.872 },
      { type: "supplier_phone", mentionText: "000-000-000-000", confidence: 0.31 },
      { type: "receipt_date", mentionText: "25/03/2026", confidence: 0.433, normalizedValue: { text: "2026-03-25", dateValue: { year: 2026, month: 3, day: 25 } } },
      { type: "purchase_time", mentionText: "14:32", confidence: 0.471 },
      { type: "total_amount", mentionText: "335.50", confidence: 0.953, normalizedValue: { text: "335.5", ...plainMoney(335.5) } },
      { type: "total_tax_amount", mentionText: "35.95", confidence: 0.667, normalizedValue: { text: "35.95", ...plainMoney(35.95) } },
      { type: "currency", mentionText: "PHP", confidence: 0.79 },
      { type: "payment_type", mentionText: "VISA", confidence: 0.849 },
      { type: "credit_card_last_four_digits", mentionText: "4242", confidence: 0 },
      {
        type: "line_item",
        mentionText: "Americano    2 x 120.00   240.00",
        confidence: 0.6,
        properties: [
          { type: "line_item/description", mentionText: "Americano", confidence: 0.634 },
          { type: "line_item/quantity", mentionText: "2", confidence: 0.249 },
          { type: "line_item/amount", mentionText: "240.00", confidence: 0.989, normalizedValue: plainMoney(240) },
        ],
      },
      {
        type: "line_item",
        mentionText: "Blueberry Muffin 1 x 95.50  95.50",
        confidence: 0.5,
        properties: [
          { type: "line_item/description", mentionText: "Blueberry Muffin", confidence: 0.489 },
          { type: "line_item/quantity", mentionText: "1", confidence: 0 },
          { type: "line_item/amount", mentionText: "95.50", confidence: 0.999, normalizedValue: plainMoney(95.5) },
        ],
      },
      {
        type: "line_item",
        mentionText: "299.55",
        confidence: 0.26,
        properties: [{ type: "line_item/amount", mentionText: "299.55", confidence: 0.264, normalizedValue: plainMoney(299.55) }],
      },
    ],
  };
}
