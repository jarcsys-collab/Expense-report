// Maps a Veryfi document into ReceiptFlow's expense shape (the same field
// names the frontend uses). This is the only place that knows Veryfi fields.
//
// Fields Veryfi did not return are omitted, never guessed. With
// confidence_details=true Veryfi returns fields as { value, score, ocr_score };
// plain values are handled too.

import { interpretReceiptDate } from "./receiptDate.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const valueOf = (field) => (isObj(field) && "value" in field ? field.value : field);
const scoreOf = (field) => {
  if (!isObj(field)) return undefined;
  const score = field.score ?? field.ocr_score;
  return typeof score === "number" && score >= 0 && score <= 1 ? score : undefined;
};
const present = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
const num = (v) => {
  const n = typeof v === "string" ? Number(v.replace(/[^\d.-]/g, "")) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
};
const str = (v, max = 500) => (present(v) ? String(v).trim().slice(0, max) : undefined);

function splitDate(raw) {
  const match = typeof raw === "string" && raw.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  return match ? { date: match[1], time: match[2] } : {};
}

/**
 * @returns {{
 *   expense: object,          // frontend expense fields + ocrConfidence + originalOCR + lineItems
 *   ocrMeta: object,          // confidence summary + Veryfi signals used by anomaly rules
 *   audit: object             // trimmed copy of the provider response for debugging
 * }}
 */
export function normalizeVeryfiDocument(doc, { dateOrder = "DMY" } = {}) {
  const expense = {};
  const confidence = {};
  const set = (field, raw, value) => {
    if (value === undefined) return;
    expense[field] = value;
    const score = scoreOf(raw);
    if (score !== undefined) confidence[field] = score;
  };

  const vendor = isObj(valueOf(doc.vendor)) ? valueOf(doc.vendor) : doc.vendor ?? {};
  set("merchant", vendor.name, str(valueOf(vendor.name), 200));
  set("merchantAddress", vendor.address, str(valueOf(vendor.address), 500));

  // Date: re-read the printed date from the OCR text (see receiptDate.js).
  const { date: providerDate, time } = splitDate(valueOf(doc.date));
  const dateInfo = interpretReceiptDate({ providerDate, ocrText: valueOf(doc.ocr_text), preferredOrder: dateOrder });
  set("expenseDate", doc.date, dateInfo.expenseDate);
  if (dateInfo.review) {
    expense.dateReview = dateInfo.review;
    // An ambiguous date is not a confident reading, whatever the provider scored it.
    // On the review screen an ambiguous date shows "Needs review" (confidence 0).
    // The provider's own score is kept in ocrMeta: ambiguity is not a reading problem.
    if (dateInfo.review.ambiguous) confidence.expenseDate = 0;
  }
  set("expenseTime", doc.date, time);

  set("subtotal", doc.subtotal, num(valueOf(doc.subtotal)));
  set("tax", doc.tax, num(valueOf(doc.tax)));
  set("tip", doc.tip, num(valueOf(doc.tip)));
  set("discount", doc.discount, num(valueOf(doc.discount)) !== undefined ? Math.abs(num(valueOf(doc.discount))) : undefined);
  set("amount", doc.total, num(valueOf(doc.total)));

  const currency = str(valueOf(doc.currency_code), 3)?.toUpperCase();
  set("currency", doc.currency_code, /^[A-Z]{3}$/.test(currency ?? "") ? currency : undefined);

  const payment = isObj(valueOf(doc.payment)) ? valueOf(doc.payment) : {};
  set("paymentMethod", payment.type, str(valueOf(payment.display_name) ?? valueOf(payment.type), 100));
  const card = String(valueOf(payment.card_number) ?? "").replace(/\D/g, "");
  set("cardLastFour", payment.card_number, card.length >= 4 ? card.slice(-4) : undefined);

  set("category", doc.category, str(valueOf(doc.category), 100));
  set("receiptNumber", doc.invoice_number, str(valueOf(doc.invoice_number), 100));

  // line_items_with_scores carries per-field scores; line_items is the plain fallback.
  const rawLineItems = Array.isArray(doc.line_items_with_scores) ? doc.line_items_with_scores : Array.isArray(doc.line_items) ? doc.line_items : [];
  expense.lineItems = rawLineItems.slice(0, 200).map((item, index) => {
    const description = str(valueOf(item.description) ?? valueOf(item.text), 500) ?? "";
    const quantity = num(valueOf(item.quantity));
    const unitPrice = num(valueOf(item.price));
    const total = num(valueOf(item.total));
    const fieldConfidence = {};
    for (const [key, raw] of [["description", item.description], ["quantity", item.quantity], ["unitPrice", item.price], ["total", item.total]]) {
      const score = scoreOf(raw);
      if (score !== undefined) fieldConfidence[key] = score;
    }
    return {
      id: `ocr-line-${index + 1}`,
      description,
      ...(quantity !== undefined ? { quantity } : {}),
      ...(unitPrice !== undefined ? { unitPrice } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(Object.keys(fieldConfidence).length ? { fieldConfidence } : {}),
    };
  });

  expense.ocrConfidence = confidence;
  // Extracted values as first read, so later edits stay traceable.
  expense.originalOCR = Object.fromEntries(
    Object.entries(expense).filter(([, v]) => typeof v === "string" || typeof v === "number"),
  );
  // The date exactly as printed, kept next to the normalized reading.
  if (dateInfo.review?.raw) expense.originalOCR.expenseDateRaw = dateInfo.review.raw;
  const ocrText = str(valueOf(doc.ocr_text), 20000);
  if (ocrText) expense.ocrText = ocrText;

  const providerDateScore = scoreOf(doc.date);
  const providerConfidence = { ...confidence, ...(providerDateScore !== undefined && "expenseDate" in confidence ? { expenseDate: providerDateScore } : {}) };
  const scores = Object.values(providerConfidence);
  const ocrMeta = {
    provider: "veryfi",
    providerDocumentId: doc.id !== undefined ? String(doc.id) : undefined,
    fieldsExtracted: Object.keys(expense.originalOCR),
    averageConfidence: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000 : undefined,
    confidence: providerConfidence,
    // Signals reported by Veryfi itself; only used when present.
    isDuplicate: typeof doc.is_duplicate === "boolean" ? doc.is_duplicate : undefined,
    isDocument: typeof doc.is_document === "boolean" ? doc.is_document : undefined,
    fraudColor: str(valueOf(doc.meta?.fraud?.color), 20),
    documentType: str(valueOf(doc.document_type), 50),
    providerWarnings: Array.isArray(doc.warnings) ? doc.warnings.filter((w) => typeof w === "string").slice(0, 20) : undefined,
  };

  const audit = {
    id: doc.id,
    created_date: doc.created_date,
    vendor: { name: valueOf(vendor.name), address: valueOf(vendor.address) },
    date: valueOf(doc.date),
    invoice_number: valueOf(doc.invoice_number),
    currency_code: valueOf(doc.currency_code),
    subtotal: valueOf(doc.subtotal),
    tax: valueOf(doc.tax),
    tip: valueOf(doc.tip),
    discount: valueOf(doc.discount),
    total: valueOf(doc.total),
    category: valueOf(doc.category),
    payment: { type: valueOf(payment.type), display_name: valueOf(payment.display_name) },
    line_items: (doc.line_items ?? []).slice(0, 200).map((i) => ({
      description: valueOf(i.description),
      quantity: valueOf(i.quantity),
      price: valueOf(i.price),
      total: valueOf(i.total),
    })),
    is_duplicate: doc.is_duplicate,
    is_document: doc.is_document,
    meta: { fraud: doc.meta?.fraud ? { color: valueOf(doc.meta.fraud.color), score: valueOf(doc.meta.fraud.score) } : undefined },
    confidence,
    topLevelKeys: Object.keys(doc).sort(),
  };

  return { expense, ocrMeta, audit };
}
