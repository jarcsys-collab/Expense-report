// Synthetic Philippine receipts as the Expense Parser could return them. Every name,
// number and amount is made up; these are never sent to Google.
const money = (amount) => {
  const units = Math.trunc(amount);
  return { moneyValue: { currencyCode: "", units: String(units), nanos: Math.round((amount - units) * 1e9) } };
};
const entity = (type, mentionText, confidence, normalizedValue) => ({ type, mentionText, confidence, ...(normalizedValue ? { normalizedValue } : {}) });
const item = (description, amount) => ({
  type: "line_item",
  mentionText: `${description} ${amount.toFixed(2)}`,
  confidence: 0.9,
  properties: [entity("line_item/description", description, 0.9), entity("line_item/amount", amount.toFixed(2), 0.95, money(amount))],
});

/** VAT-inclusive restaurant receipt with a full BIR-style VAT summary. */
export function restaurantVatReceipt() {
  return {
    text: [
      "KAINAN NI TEST INC.",
      "45 Sample Ave, Quezon City",
      "VAT REG TIN 000-111-222-00000",
      "SI No: 0012345",
      "Date: 25/03/2026",
      "Sinigang   450.00",
      "Rice        110.00",
      "VATable Sales      500.00",
      "VAT-Exempt Sales     0.00",
      "Zero-Rated Sales     0.00",
      "VAT 12%             60.00",
      "TOTAL AMOUNT DUE  ₱560.00",
      "Cash              1,000.00",
      "Change              440.00",
    ].join("\n"),
    pages: [{ pageNumber: 1 }],
    entities: [
      entity("supplier_name", "KAINAN NI TEST INC.", 0.95),
      entity("supplier_address", "45 Sample Ave, Quezon City", 0.9),
      entity("receipt_date", "25/03/2026", 0.95, { dateValue: { year: 2026, month: 3, day: 25 }, text: "2026-03-25" }),
      entity("total_amount", "₱560.00", 0.97, money(560)),
      entity("total_tax_amount", "60.00", 0.9, money(60)),
      entity("currency", "₱", 0.9),
      entity("payment_type", "Cash", 0.85),
      item("Sinigang", 450),
      item("Rice", 110),
      // Summary lines the parser misreads as purchases.
      item("VATable Sales", 500),
      item("VAT 12%", 60),
      item("Vat-Exempt Sales", 0),
      item("Total Amount Due", 560),
      item("Change", 440),
    ],
  };
}

/** The parser found almost nothing; the figures are only printed in the text. */
export function textOnlyReceipt() {
  return {
    text: [
      "SARI-SARI TEST STORE",
      "Official Receipt No. 000777",
      "Sub Total      1,250.00",
      "VAT Amount       150.00",
      "TOTAL        PHP 1,400.00",
    ].join("\n"),
    pages: [{ pageNumber: 1 }],
    entities: [entity("supplier_name", "SARI-SARI TEST STORE", 0.9)],
  };
}

/** VAT figures that do not add up. */
export function inconsistentVatReceipt() {
  const doc = restaurantVatReceipt();
  doc.text = doc.text.replace("VATable Sales      500.00", "VATable Sales      400.00");
  return doc;
}
