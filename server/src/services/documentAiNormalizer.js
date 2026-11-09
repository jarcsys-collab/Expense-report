// Maps a Google Document AI Expense Parser document into ReceiptFlow's expense
// shape: the same fields normalizeVeryfiDocument produces, so the review
// screen, validation, policy and anomaly checks work unchanged.
//
// Fields the parser did not return are omitted, never guessed. Each field's
// confidence is the entity's own confidence (0-1).

import { interpretReceiptDate } from "./receiptDate.js";
import { receiptConsistencyIssues } from "./receiptConsistency.js";

// Raised when the mapping changes, so an old reading is not reused for a re-upload.
export const NORMALIZER_VERSION = 2;
// Reported as "missing" in analytics when the scan did not read them.
export const IMPORTANT_FIELDS = ["merchant", "merchantAddress", "expenseDate", "receiptNumber", "currency", "amount", "subtotal", "tax", "vatableSales", "paymentMethod", "lineItems"];
const hasValue = (expense, field) => {
  if (field === "vatableSales") return expense.vatBreakdown?.vatableSales !== undefined;
  if (field === "lineItems") return (expense.lineItems?.length ?? 0) > 0;
  return expense[field] !== undefined && expense[field] !== "";
};

const present = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
const str = (v, max = 500) => (present(v) ? String(v).replace(/\s+/g, " ").trim().slice(0, max) : undefined);
const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? round2(v) : undefined;
  if (typeof v !== "string") return undefined;
  // "1,234.50", "₱ 1 234.50", "PHP1,234.50", "(12.00)"; a lone comma decimal ("12,50") too.
  let text = v.replace(/[^\d.,()-]/g, "");
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  text = text.replace(/[()-]/g, "");
  if (/^\d+,\d{2}$/.test(text)) text = text.replace(",", ".");
  // Anything else with separators in odd places ("1.234,50", "1,23,4") is not
  // guessed: a misread amount would be worse than asking the employee.
  else if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return undefined;
  const n = Number(text.replace(/,/g, ""));
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
// The long labels may also go straight to the value: "Invoice: SI-00123".
const RECEIPT_NUMBER_COLON_LABEL =
  /(?:^|[^A-Za-z])(?:official\s+receipt|sales\s+invoice|receipt|invoice)\s*:\s*([A-Za-z0-9][A-Za-z0-9/-]{1,24})(?![A-Za-z0-9/-])(\.\d)?/gi;
// A label alone on its line, with the value on the next line.
const RECEIPT_NUMBER_LABEL_ONLY =
  /^\s*(?:official\s+receipt|sales\s+invoice|o\.?\s?r\.?|s\.?\s?i\.?|receipt|invoice)\s*(?:no\.?|number|num\.?|#)\s*[:.#-]?\s*$/i;
const LONE_VALUE = /^\s*([A-Za-z0-9][A-Za-z0-9/-]{1,24})\s*$/;
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
  const values = receiptNumbersInText(text);
  return values.size === 1 ? [...values][0] : undefined;
}
function receiptNumbersInText(text) {
  const values = new Set();
  const add = (raw, decimal) => {
    const value = raw.replace(/[/-]+$/, "");
    if (!looksLikeNotAReceiptNumber(value, decimal)) values.add(value.toUpperCase());
  };
  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(RECEIPT_NUMBER_LABEL)) add(match[1], match[2]);
    for (const match of line.matchAll(RECEIPT_NUMBER_COLON_LABEL)) add(match[1], match[2]);
    if (RECEIPT_NUMBER_LABEL_ONLY.test(line)) {
      const next = LONE_VALUE.exec(lines[index + 1] ?? "");
      if (next) add(next[1]);
    }
  });
  return values;
}

// ---------------------------------------------------------------------------
// Philippine VAT summary lines (the Expense Parser has no entity for these).
// ---------------------------------------------------------------------------

// The last amount on a line: "VATable Sales   299.55", "VAT 12%  35.95".
const lineAmount = (line) => {
  const matches = [...String(line).matchAll(/(?:₱|PHP|P)?\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})(?!\d)/gi)];
  return matches.length ? num(matches[matches.length - 1][1]) : undefined;
};
const VAT_LINE_LABELS = {
  vatableSales: /^\s*(?:vat\s*-?\s*able(?:\s+(?:sales?|amount))?|vatable)\b/i,
  vatExemptSales: /^\s*(?:vat\s*-?\s*exempt(?:ed)?(?:\s+sales?)?|non\s*-?\s*vat(?:\s+sales?)?)\b/i,
  zeroRatedSales: /^\s*(?:(?:vat\s+)?zero\s*-?\s*rated(?:\s+sales?)?)\b/i,
};
// One clear value per label; two different printed values are left out, not chosen between.
function labelledAmount(lines, pattern) {
  const found = new Set();
  for (const line of lines) {
    if (pattern.test(line)) {
      const amount = lineAmount(line);
      if (amount !== undefined) found.add(amount);
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}
const VAT_AMOUNT_LINE = /^\s*(?:(?:12\s*%\s*)?vat(?:\s*\(?\s*12\s*%\s*\)?)?(?:\s+amount)?|total\s+vat)\s*[:₱]?\s*(?:php\s*)?[\d.,\s]+$/i;
const SUBTOTAL_LINE = /^\s*sub\s*-?\s*total\b/i;
const TOTAL_LINE = /^\s*(?:grand\s+total|total\s+amount(?:\s+due)?|total\s+due|amount\s+due|total)\b(?!\s+(?:items?|qty|quantity|vat|tax|discount|sales))/i;

// Receipt summary lines that are not purchased items (subtotal, VAT, discounts,
// totals, payment and change). Compared against the whole label, so an item
// such as "Total Gym Pass" or "Tax Guide Book" is kept.
const SUMMARY_LABEL = new RegExp(
  "^(?:" +
    [
      "sub ?total",
      "vat(?:able)?(?: sales| amount)?",
      "vat (?:amount|inclusive|exclusive|sales)",
      "vat exempt(?:ed)?(?: sales)?",
      "non vat(?:able)?(?: sales)?",
      "(?:vat )?zero rated(?: sales)?",
      "less(?: vat)?",
      "(?:total )?(?:vat|tax|taxes)",
      "sales tax",
      "(?:less )?(?:senior citizen |senior |sc |pwd |sc pwd |employee |promo )?discount",
      "(?:grand )?total(?: amount(?: due)?| due| sales| payable| items?| qty| quantity| payment)?",
      "amount (?:due|payable|tendered|received|paid)",
      "balance(?: due)?",
      "change(?: due)?",
      "cash(?: tendered| received)?",
      "tendered",
      "service charge",
      "net (?:amount|sales|total)",
      "(?:no |number )?of items?",
      "items?",
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

  // Fields read from the OCR text by their printed label, not by the parser. Each
  // has confidence 0 ("Needs review"), so the employee checks it against the receipt.
  const textFallbackFields = [];
  const ocrTextLines = String(ocrText ?? "").split(/\r?\n/);
  const fromLabel = (field, value) => {
    if (expense[field] !== undefined || value === undefined) return;
    expense[field] = value;
    confidence[field] = 0;
    textFallbackFields.push(field);
  };
  fromLabel("amount", labelledAmount(ocrTextLines, TOTAL_LINE));
  fromLabel("subtotal", labelledAmount(ocrTextLines, SUBTOTAL_LINE));
  fromLabel("tax", labelledAmount(ocrTextLines, VAT_AMOUNT_LINE));

  // VATable, exempt and zero-rated figures, kept apart from purchases and from the
  // subtotal. Absent when not printed: never assumed to be zero.
  const vatBreakdown = {};
  for (const [field, pattern] of Object.entries(VAT_LINE_LABELS)) {
    const value = labelledAmount(ocrTextLines, pattern);
    if (value !== undefined) vatBreakdown[field] = value;
  }
  if (Object.keys(vatBreakdown).length) expense.vatBreakdown = vatBreakdown;

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

  const flags = [];
  const receiptNumberEntity = first(...RECEIPT_NUMBER_TYPES);
  const providerReceiptNumber = str(textOf(receiptNumberEntity), 100);
  // A date, phone number, TIN or card number the parser labelled as the receipt
  // number is not used.
  const providerNumberUsable =
    providerReceiptNumber !== undefined && !looksLikeNotAReceiptNumber(providerReceiptNumber.replace(/\s+/g, ""));
  if (providerNumberUsable) set("receiptNumber", receiptNumberEntity, providerReceiptNumber);
  else if (providerReceiptNumber !== undefined) flags.push({ code: "receipt_number_rejected", message: "The value read as the receipt number looks like a date, phone, TIN or card number, so it was not used." });
  // The Expense Parser has no OR/SI number field: fall back to a value printed
  // after an explicit label. Confidence 0 = "Needs review": the employee confirms it.
  const printedNumbers = receiptNumbersInText(ocrText);
  if (expense.receiptNumber === undefined) {
    const fromText = printedNumbers.size === 1 ? [...printedNumbers][0] : undefined;
    if (fromText) {
      expense.receiptNumber = fromText;
      confidence.receiptNumber = 0;
      textFallbackFields.push("receiptNumber");
    } else if (printedNumbers.size > 1) {
      flags.push({ code: "receipt_number_ambiguous", message: "The receipt shows more than one receipt/invoice number. Enter the correct one." });
    }
  } else if (printedNumbers.size && !printedNumbers.has(String(expense.receiptNumber).toUpperCase())) {
    flags.push({ code: "receipt_number_conflict", message: "The receipt number read by OCR differs from the number printed next to its label. Check it against the receipt." });
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
  // Values read by ReceiptFlow from the text are not provider scores: they stay
  // out of the average. A key field keeps its 0, so the employee must confirm it.
  for (const field of textFallbackFields) delete providerConfidence[field];
  const scores = Object.values(providerConfidence);
  if (textFallbackFields.includes("amount")) providerConfidence.amount = 0;
  const entityTypes = [...new Set(entities.map((e) => e?.type).filter(Boolean))].sort();
  for (const issue of receiptConsistencyIssues(expense)) flags.push(issue);
  const missingFields = IMPORTANT_FIELDS.filter((field) => !hasValue(expense, field));
  const ocrMeta = {
    provider: "google_document_ai",
    normalizerVersion: NORMALIZER_VERSION,
    // Ambiguous or inconsistent figures for a person to check, and what was not read.
    flags,
    missingFields,
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
    vat_breakdown: expense.vatBreakdown,
    text_fallback_fields: textFallbackFields,
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
