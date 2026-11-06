// Maps a Google Document AI Expense Parser document into ReceiptFlow's expense
// shape: the same fields normalizeVeryfiDocument produces, so the review
// screen, validation, policy and anomaly checks work unchanged.
//
// Fields the parser did not return are omitted, never guessed. Each field's
// confidence is the entity's own confidence (0-1).

import { interpretReceiptDate } from "./receiptDate.js";

const present = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
const str = (v, max = 500) => (present(v) ? String(v).replace(/\s+/g, " ").trim().slice(0, max) : undefined);
const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? round2(v) : undefined;
  if (typeof v !== "string") return undefined;
  // "1,234.50", "₱ 1 234.50", "(12.00)"; a lone comma decimal ("12,50") too.
  let text = v.replace(/[^\d.,()-]/g, "");
  if (/^\(?-?\d+,\d{2}\)?$/.test(text)) text = text.replace(",", ".");
  text = text.replace(/,/g, "");
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  const n = Number(text.replace(/[()-]/g, ""));
  return text && Number.isFinite(n) ? round2(negative ? -n : n) : undefined;
};
const confidenceOf = (entity) =>
  typeof entity?.confidence === "number" && entity.confidence >= 0 && entity.confidence <= 1 ? Math.round(entity.confidence * 1000) / 1000 : undefined;
const textOf = (entity) => str(entity?.normalizedValue?.text) ?? str(entity?.mentionText);
const int64 = (v) => (v === undefined || v === null ? 0 : Number(typeof v === "object" ? String(v) : v));

/** Money from normalizedValue.moneyValue {currencyCode, units, nanos}, else the printed text. */
function moneyOf(entity) {
  const money = entity?.normalizedValue?.moneyValue;
  if (money && (money.units !== undefined || money.nanos !== undefined)) {
    const value = int64(money.units) + int64(money.nanos) / 1e9;
    if (Number.isFinite(value)) return { amount: round2(value), currency: str(money.currencyCode, 3)?.toUpperCase() };
  }
  const amount = num(entity?.mentionText) ?? num(entity?.normalizedValue?.text);
  return amount === undefined ? undefined : { amount };
}

const pad = (n) => String(n).padStart(2, "0");
function dateOf(entity) {
  const d = entity?.normalizedValue?.dateValue;
  if (d?.year && d?.month && d?.day) return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
  const match = String(entity?.normalizedValue?.text ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1];
}
function timeOf(entity) {
  const dt = entity?.normalizedValue?.datetimeValue;
  if (dt && dt.hours !== undefined && dt.hours !== null) return `${pad(dt.hours)}:${pad(dt.minutes ?? 0)}`;
  const match = String(textOf(entity) ?? "").match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if (!match) return undefined;
  let hours = Number(match[1]);
  if (match[3]) hours = (hours % 12) + (/p/i.test(match[3]) ? 12 : 0);
  return hours < 24 ? `${pad(hours)}:${match[2]}` : undefined;
}

// Currency: ISO 4217 codes, plus symbols that identify exactly one currency.
// "$", "¥", "kr" and a bare "P" are shared by several currencies: never guessed.
const ISO_CURRENCIES = new Set(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : ["PHP", "USD", "EUR"]);
const CURRENCY_SYMBOLS = { "₱": "PHP", "€": "EUR", "£": "GBP", "₩": "KRW", "₹": "INR", "฿": "THB", "₫": "VND", "₪": "ILS" };
/** ISO code from text such as "PHP", "Php", "₱" or "PHP 335.50"; undefined when unclear. */
export function currencyCodeOf(value) {
  const text = str(value, 30);
  if (!text) return undefined;
  const letters = text.toUpperCase().replace(/[^A-Z]/g, "");
  if (letters.length === 3 && ISO_CURRENCIES.has(letters)) return letters;
  const fromSymbols = [...new Set([...text].map((ch) => CURRENCY_SYMBOLS[ch]).filter(Boolean))];
  return fromSymbols.length === 1 && (letters === "" || letters === fromSymbols[0]) ? fromSymbols[0] : undefined;
}

// Receipt number printed with an explicit label: OR No., SI No., Receipt No.,
// Invoice No. (also "#", "Number", "Official Receipt", "Sales Invoice").
const RECEIPT_NUMBER_LABEL =
  /(?:^|[^A-Za-z])(?:official\s+receipt|sales\s+invoice|o\.?\s?r\.?|s\.?\s?i\.?|receipt|invoice)\s*(?:no\.?|number|num\.?|#)\s*[:.#-]?\s*([A-Za-z0-9][A-Za-z0-9/-]{1,24})(?![A-Za-z0-9/-])(\.\d)?/gi;
function looksLikeNotAReceiptNumber(value, trailingDecimal) {
  if (!/\d/.test(value)) return true; // words such as "Copy"
  if (trailingDecimal) return true; // an amount like 335.50
  if (/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(value)) return true; // a date
  const digitsOnly = value.replace(/-/g, "");
  if (/^\d{13,19}$/.test(digitsOnly)) return true; // card-number length
  if (/^(?:63|0)9\d{9}$/.test(digitsOnly)) return true; // Philippine mobile number
  if (/^\d{3}-\d{3}-\d{3}(?:-\d{3,5})?$/.test(value)) return true; // TIN pattern
  return false;
}
/**
 * Conservative fallback: the one value printed after a receipt-number label.
 * No value, or two different values, returns undefined (never guessed).
 */
export function receiptNumberFromText(text) {
  const values = new Set();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    for (const match of line.matchAll(RECEIPT_NUMBER_LABEL)) {
      const value = match[1].replace(/[/-]+$/, "");
      if (!looksLikeNotAReceiptNumber(value, match[2])) values.add(value.toUpperCase());
    }
  }
  return values.size === 1 ? [...values][0] : undefined;
}

// Receipt summary lines that are not purchased items (subtotal, VAT, discounts,
// totals, payment and change). Compared against the whole label, so an item
// such as "Total Gym Pass" or "Tax Guide Book" is kept.
const SUMMARY_LABEL = new RegExp(
  "^(?:" +
    [
      "sub ?total",
      "vat(?:able)?(?: sales)?",
      "vat (?:amount|inclusive|exclusive)",
      "vat exempt(?: sales)?",
      "zero rated(?: sales)?",
      "less(?: vat)?",
      "(?:total )?(?:vat|tax|taxes)",
      "sales tax",
      "(?:senior citizen |senior |sc |pwd |employee |promo )?discount",
      "(?:grand )?total(?: amount| due| sales| payable)?",
      "amount (?:due|payable)",
      "balance(?: due)?",
      "change",
      "cash(?: tendered)?",
      "tendered",
      "service charge",
      "net (?:amount|sales|total)",
    ].join("|") +
    ")$",
  "i",
);
export function isSummaryLabel(text) {
  const label = String(text ?? "")
    .toLowerCase()
    .replace(/\b(?:php|usd|peso|pesos)\b/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return label !== "" && SUMMARY_LABEL.test(label);
}
const amountPatterns = (amount) => {
  const fixed = Math.abs(amount).toFixed(2);
  return [...new Set([fixed, Number(fixed).toLocaleString("en-US", { minimumFractionDigits: 2 })])];
};
/**
 * A line item the parser took from a summary line: its own text is a summary
 * label, or it has no words and every OCR line printing its amount is one.
 */
function isSummaryLineItem({ description, mentionText, total }, ocrLines) {
  if (isSummaryLabel(description) || isSummaryLabel(mentionText)) return true;
  if (/[a-z]/i.test(description ?? "") || total === undefined) return false;
  const patterns = amountPatterns(total);
  const lines = ocrLines.filter((line) => patterns.some((p) => line.includes(p)));
  return lines.length > 0 && lines.every((line) => isSummaryLabel(line));
}

// Entity types the Expense Parser may use for the receipt/invoice number.
const RECEIPT_NUMBER_TYPES = ["receipt_id", "receipt_number", "invoice_id", "transaction_id"];
// Veryfi-only screening signals that Document AI does not provide.
export const UNAVAILABLE_SIGNALS = [
  { id: "provider_fraud_signal", label: "fraud-risk screening of the document" },
  { id: "provider_duplicate_signal", label: "the provider's own duplicate-document check" },
  { id: "provider_document_check", label: "the provider's receipt/not-a-receipt check" },
];

/**
 * @param {object} doc Document AI document ({ text, entities[] })
 * @returns {{ expense: object, ocrMeta: object, audit: object }}
 */
export function normalizeDocumentAiDocument(doc, { dateOrder = "DMY" } = {}) {
  const entities = Array.isArray(doc?.entities) ? doc.entities : [];
  // The most confident entity of each type (single-valued fields).
  const best = {};
  for (const entity of entities) {
    const type = entity?.type;
    if (!type || type === "line_item") continue;
    if (!best[type] || (confidenceOf(entity) ?? 0) > (confidenceOf(best[type]) ?? 0)) best[type] = entity;
  }
  const first = (...types) => types.map((t) => best[t]).find(Boolean);

  const expense = {};
  const confidence = {};
  const set = (field, entity, value) => {
    if (value === undefined) return;
    expense[field] = value;
    const score = confidenceOf(entity);
    if (score !== undefined) confidence[field] = score;
  };

  const ocrText = str(doc?.text, 20000) && String(doc.text).slice(0, 20000);

  set("merchant", best.supplier_name, str(textOf(best.supplier_name), 200));
  set("merchantAddress", best.supplier_address, str(textOf(best.supplier_address), 500));

  // Date: same re-reading of the printed date as for Veryfi (receiptDate.js).
  const providerDate = dateOf(best.receipt_date);
  const dateInfo = interpretReceiptDate({ providerDate, ocrText, preferredOrder: dateOrder });
  set("expenseDate", best.receipt_date, dateInfo.expenseDate);
  if (dateInfo.review) {
    expense.dateReview = dateInfo.review;
    if (dateInfo.review.ambiguous) confidence.expenseDate = 0;
  }
  set("expenseTime", first("purchase_time", "receipt_time"), timeOf(first("purchase_time", "receipt_time")));

  const total = moneyOf(best.total_amount);
  set("subtotal", best.net_amount, moneyOf(best.net_amount)?.amount);
  set("tax", best.total_tax_amount, moneyOf(best.total_tax_amount)?.amount);
  set("tip", best.tip_amount, moneyOf(best.tip_amount)?.amount);
  const discount = moneyOf(first("discount_amount", "discount"))?.amount;
  set("discount", first("discount_amount", "discount"), discount !== undefined ? Math.abs(discount) : undefined);
  set("amount", best.total_amount, total?.amount);

  // Currency, from the first clear evidence: the currency entity's normalized
  // value, its printed text ("PHP", "₱"), the total's currency code, then the
  // total's printed text. Nothing clear: left empty for the employee.
  const currencySources = [
    [best.currency, best.currency?.normalizedValue?.text],
    [best.currency, best.currency?.mentionText],
    [best.total_amount, total?.currency],
    [best.total_amount, best.total_amount?.mentionText],
  ];
  const currencyFound = currencySources.map(([entity, text]) => [entity, currencyCodeOf(text)]).find(([, code]) => code);
  set("currency", currencyFound?.[0], currencyFound?.[1]);

  set("paymentMethod", best.payment_type, str(textOf(best.payment_type), 100));
  const card = String(textOf(best.credit_card_last_four_digits) ?? "").replace(/\D/g, "");
  set("cardLastFour", best.credit_card_last_four_digits, card.length >= 4 ? card.slice(-4) : undefined);

  const receiptNumberEntity = first(...RECEIPT_NUMBER_TYPES);
  set("receiptNumber", receiptNumberEntity, str(textOf(receiptNumberEntity), 100));
  // The Expense Parser has no OR/SI number field: fall back to a value printed
  // after an explicit label. Confidence 0 = "Needs review": the employee confirms it.
  const textFallbackFields = [];
  if (expense.receiptNumber === undefined) {
    const fromText = receiptNumberFromText(ocrText);
    if (fromText) {
      expense.receiptNumber = fromText;
      confidence.receiptNumber = 0;
      textFallbackFields.push("receiptNumber");
    }
  }

  // Line items: parent "line_item" entities with "line_item/..." properties.
  const ocrLines = String(ocrText ?? "").split(/\r?\n/);
  let droppedLineItems = 0;
  expense.lineItems = entities
    .filter((entity) => entity?.type === "line_item")
    .slice(0, 200)
    .map((item) => {
      const props = {};
      for (const prop of Array.isArray(item.properties) ? item.properties : []) {
        const key = String(prop?.type ?? "").replace(/^line_item\//, "");
        if (key && !props[key]) props[key] = prop;
      }
      const description = str(textOf(props.description) ?? item.mentionText, 500) ?? "";
      const quantity = num(textOf(props.quantity));
      const unitPrice = moneyOf(props.unit_price)?.amount;
      const lineTotal = moneyOf(props.amount)?.amount;
      const fieldConfidence = {};
      for (const [key, prop] of [["description", props.description], ["quantity", props.quantity], ["unitPrice", props.unit_price], ["total", props.amount]]) {
        const score = confidenceOf(prop);
        if (score !== undefined) fieldConfidence[key] = score;
      }
      if (isSummaryLineItem({ description, mentionText: item.mentionText, total: lineTotal }, ocrLines)) {
        droppedLineItems += 1;
        return null;
      }
      return {
        description,
        ...(quantity !== undefined ? { quantity } : {}),
        ...(unitPrice !== undefined ? { unitPrice } : {}),
        ...(lineTotal !== undefined ? { total: lineTotal } : {}),
        ...(Object.keys(fieldConfidence).length ? { fieldConfidence } : {}),
      };
    })
    .filter(Boolean)
    .map((item, index) => ({ id: `ocr-line-${index + 1}`, ...item }));

  expense.ocrConfidence = confidence;
  expense.originalOCR = Object.fromEntries(
    Object.entries(expense).filter(([, v]) => typeof v === "string" || typeof v === "number"),
  );
  if (dateInfo.review?.raw) expense.originalOCR.expenseDateRaw = dateInfo.review.raw;
  if (ocrText) expense.ocrText = ocrText;

  const providerDateScore = confidenceOf(best.receipt_date);
  const providerConfidence = {
    ...confidence,
    ...(providerDateScore !== undefined && "expenseDate" in confidence ? { expenseDate: providerDateScore } : {}),
  };
  // Values read by ReceiptFlow from the text are not provider scores.
  for (const field of textFallbackFields) delete providerConfidence[field];
  const scores = Object.values(providerConfidence);
  const entityTypes = [...new Set(entities.map((e) => e?.type).filter(Boolean))].sort();
  const ocrMeta = {
    provider: "google_document_ai",
    providerDocumentId: undefined,
    fieldsExtracted: Object.keys(expense.originalOCR),
    averageConfidence: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000 : undefined,
    confidence: providerConfidence,
    // Not provided by Document AI: left undefined, listed in unavailableSignals,
    // and reported as "not evaluated" by the anomaly check (never as passed).
    isDuplicate: undefined,
    isDocument: undefined,
    fraudColor: undefined,
    unavailableSignals: UNAVAILABLE_SIGNALS.map((s) => s.id),
    documentType: "receipt",
    pageCount: Array.isArray(doc?.pages) ? doc.pages.length : undefined,
    entityTypes,
    // Fields ReceiptFlow read from the OCR text itself; they need the employee's confirmation.
    textFallbackFields,
    droppedLineItems,
  };

  const audit = {
    provider: "google_document_ai",
    entityTypes,
    supplier: { name: textOf(best.supplier_name), address: textOf(best.supplier_address) },
    receipt_date: textOf(best.receipt_date),
    receipt_number: textOf(receiptNumberEntity) ?? (textFallbackFields.includes("receiptNumber") ? expense.receiptNumber : undefined),
    receipt_number_source: receiptNumberEntity ? "provider" : textFallbackFields.includes("receiptNumber") ? "ocr_text_label" : undefined,
    currency: expense.currency,
    dropped_summary_line_items: droppedLineItems,
    net_amount: moneyOf(best.net_amount)?.amount,
    total_tax_amount: moneyOf(best.total_tax_amount)?.amount,
    tip_amount: moneyOf(best.tip_amount)?.amount,
    total_amount: total?.amount,
    payment_type: textOf(best.payment_type),
    line_item_count: expense.lineItems.length,
    confidence,
  };

  return { expense, ocrMeta, audit };
}

/** True when the parser found no text and no entities (blank or unreadable image). */
export function isEmptyDocument(doc) {
  return !str(doc?.text) && !(Array.isArray(doc?.entities) && doc.entities.length);
}
