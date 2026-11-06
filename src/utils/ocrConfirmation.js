// Low-confidence OCR fields the employee must confirm or correct before
// submitting (merchant, receipt date, total). The server is the authority: it
// keeps the review records (expense.ocrFieldReviews) with the original OCR value
// and score, and records who confirmed and when. The browser only sends
// `ocrConfirmations: { field: value }` for the value currently on the expense.
import { config } from "../config/appConfig";

export const KEY_OCR_FIELDS = ["merchant", "expenseDate", "amount"];
export const OCR_FIELD_LABELS = { merchant: "Merchant", expenseDate: "Receipt date", amount: "Total", currency: "Currency" };
const CONFIRMABLE_FIELDS = [...KEY_OCR_FIELDS, "currency"];

function comparable(field, value) {
  if (value === undefined || value === null || value === "") return null;
  if (field === "amount") {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 100) : null;
  }
  if (field === "currency") {
    const code = String(value).trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : null;
  }
  const text = String(value).trim();
  return text === "" ? null : text;
}
// Saved expenses carry the server's MongoDB id; unsaved ones a browser UUID.
const isSavedOnServer = (expense) => /^[a-f0-9]{24}$/i.test(String(expense?.id ?? ""));

export const sameOcrValue = (field, a, b) => {
  const left = comparable(field, a);
  return left !== null && left === comparable(field, b);
};

/**
 * One entry per key field that needs (or had) confirmation:
 * { field, label, ocrValue, ocrConfidence, status, confirmedBy, confirmedAt, unsaved }
 * status: "needs_confirmation" | "confirmed" | "corrected"
 */
export function ocrFieldStates(expense) {
  if (!expense) return [];
  const serverReviews = Array.isArray(expense.ocrFieldReviews) ? expense.ocrFieldReviews : null;
  let pending;
  if (serverReviews || isSavedOnServer(expense)) {
    // Saved expense: the server's list is the truth.
    pending = (serverReviews ?? []).map((review) => ({ ...review }));
  } else if (expense.receiptJobId) {
    // Fresh scan, not saved yet: predicted from the scan's confidence; the
    // server rebuilds the real list from the stored scan when it is saved.
    pending = KEY_OCR_FIELDS.filter(
      (field) =>
        typeof expense.ocrConfidence?.[field] === "number" &&
        expense.ocrConfidence[field] < config.confidence &&
        comparable(field, expense.originalOCR?.[field]) !== null,
    ).map((field) => ({ field, reason: "low_confidence", ocrValue: expense.originalOCR[field], ocrConfidence: expense.ocrConfidence[field] }));
    // No currency on the scan: the employee provides it (the form defaults to PHP).
    if (comparable("currency", expense.originalOCR?.currency) === null) {
      pending.push({ field: "currency", reason: "not_read", ocrValue: null, ocrConfidence: null });
    }
  } else {
    pending = [];
  }
  return pending.map((review) => {
    const { field } = review;
    const current = expense[field];
    const local = expense.ocrConfirmations?.[field];
    const reason = review.reason ?? "low_confidence";
    const base = { field, reason, label: OCR_FIELD_LABELS[field], ocrValue: review.ocrValue, ocrConfidence: review.ocrConfidence };
    if (local !== undefined && sameOcrValue(field, local, current)) {
      const status = reason === "not_read" ? "provided" : sameOcrValue(field, current, review.ocrValue) ? "confirmed" : "corrected";
      return { ...base, status, unsaved: true };
    }
    if (review.status && review.status !== "needs_confirmation" && sameOcrValue(field, review.confirmedValue, current)) {
      return { ...base, status: review.status, confirmedBy: review.confirmedBy, confirmedAt: review.confirmedAt, unsaved: false };
    }
    return { ...base, status: "needs_confirmation", unsaved: false };
  });
}

export const ocrFieldState = (expense, field) => ocrFieldStates(expense).find((state) => state.field === field);
export const fieldsNeedingOcrConfirmation = (expense) =>
  ocrFieldStates(expense).filter((state) => state.status === "needs_confirmation");

/** The employee confirms the value currently on the expense (or a correction they made). */
export function confirmOcrFields(expense, fields) {
  const confirmations = { ...(expense.ocrConfirmations ?? {}) };
  for (const field of fields) {
    if (comparable(field, expense[field]) !== null) confirmations[field] = expense[field];
  }
  return { ...expense, ocrConfirmations: confirmations };
}

/** Confirmations still matching the current values, in the API's types (sent with saves). */
export function ocrConfirmationsPayload(expense) {
  const entries = Object.entries(expense?.ocrConfirmations ?? {})
    .filter(([field, value]) => CONFIRMABLE_FIELDS.includes(field) && sameOcrValue(field, value, expense[field]))
    .map(([field, value]) => [field, field === "amount" ? Number(value) : field === "currency" ? String(value).trim().toUpperCase() : String(value).trim()]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export const confidenceText = (score) =>
  typeof score === "number" && score > 0 ? `${Math.round(score * 100)}% confidence` : "low confidence";

export function describeOcrValue(field, value, currency) {
  if (value === undefined || value === null || value === "") return "nothing";
  if (field === "amount") {
    return `${currency || ""} ${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
  }
  return String(value);
}
