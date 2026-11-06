// Employee confirmation of key receipt fields that OCR read with low confidence.
//
// Three different situations are kept apart:
//   1. OCR uncertainty: a key field (merchant, date, total) read below the
//      confidence threshold. The employee must confirm or correct it before
//      submitting (ocrFieldReviews, status needs_confirmation → confirmed/corrected).
//   2. Unresolved OCR problems: a key field the scan could not read at all, or a
//      provider warning. These stay with the receipt-clarity check for review.
//   3. Policy anomalies (limits, duplicates, corrected totals, ...): anomaly
//      rules, unaffected by any confirmation.
//
// Everything here is derived on the server: the original OCR value and score
// come from the stored receipt scan (ReceiptJob), the identity from the signed-in
// session, the time from the server clock. The browser only says "I confirm the
// value currently on the expense", and that confirmation counts only for that
// exact value.
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errorHandler.js";

export const OCR_CONFIDENCE_THRESHOLD = 0.8;
export const KEY_OCR_FIELDS = ["merchant", "expenseDate", "amount"];
export const OCR_FIELD_LABELS = { merchant: "merchant", expenseDate: "receipt date", amount: "total", currency: "currency" };

/** Value in a form that can be compared exactly (amount in cents), or null when empty. */
export function comparableValue(field, value) {
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
export const sameValue = (field, a, b) => {
  const left = comparableValue(field, a);
  return left !== null && left === comparableValue(field, b);
};

const percent = (score) => `${Math.round(score * 100)}%`;
export function describeValue(field, value, currency) {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (field === "currency") return String(value);
  if (field === "amount") return `${currency ? `${currency} ` : ""}${Number(value).toFixed(2)}`;
  return `"${value}"`;
}

/** Key fields the stored scan read with low confidence (server data only). */
export function lowConfidenceOcrFields(job) {
  const meta = job?.ocrMeta;
  const result = job?.result;
  if (!meta || !result) return [];
  return KEY_OCR_FIELDS.filter(
    (field) =>
      meta.fieldsExtracted?.includes(field) &&
      typeof meta.confidence?.[field] === "number" &&
      meta.confidence[field] < OCR_CONFIDENCE_THRESHOLD,
  ).map((field) => ({ field, reason: "low_confidence", ocrValue: result[field] ?? null, ocrConfidence: meta.confidence[field] }));
}

/**
 * Everything the employee must confirm or provide for this scan: low-confidence
 * key fields, plus the currency when the scan found none (the expense would
 * otherwise silently default to PHP). A missing currency is not an anomaly.
 */
export function ocrFieldsNeedingConfirmation(job) {
  const fields = lowConfidenceOcrFields(job);
  if (job?.ocrMeta && job?.result && comparableValue("currency", job.result.currency) === null) {
    fields.push({ field: "currency", reason: "not_read", ocrValue: null, ocrConfidence: null });
  }
  return fields;
}

/**
 * Rebuilds expense.ocrFieldReviews from the linked scan and applies the
 * employee's requested confirmations. Call after every change to the expense.
 * @param {object} expense Mongoose Expense document (already holding the new values)
 * @param {object|null} job linked ReceiptJob
 * @param {{ id: string, name: string }} user signed-in user (req.user)
 * @param {Record<string, unknown>} [requested] { field: value the employee confirms }
 * @returns {string[]} activity-log lines describing what changed
 */
export function syncOcrFieldReviews(expense, job, user, requested = {}) {
  const pending = ocrFieldsNeedingConfirmation(job);
  // Confirmations for fields that need none (read confidently, or no scan) are
  // ignored: they create no record. The browser predicts the list before the
  // first save, so it may confirm a field the scan read confidently.
  const requestedFields = Object.keys(requested ?? {}).filter(
    (field) => requested[field] !== undefined && pending.some((p) => p.field === field),
  );
  // Only the employee who owns the expense can vouch for its receipt details.
  if (requestedFields.length && (!user?.id || String(expense.employeeId ?? "") !== String(user.id))) {
    throw new HttpError(403, "OCR_CONFIRMATION_FORBIDDEN", "Only the employee who owns this expense can confirm its receipt details.");
  }

  const jobId = job?._id ? String(job._id) : null;
  const previous = new Map((expense.ocrFieldReviews ?? []).map((review) => [review.field, review]));
  const log = [];
  const now = new Date();
  const currency = expense.currency;

  const reviews = pending.map(({ field, reason, ocrValue, ocrConfidence }) => {
    const label = OCR_FIELD_LABELS[field];
    const current = expense[field];
    const prior = previous.get(field);
    // A confirmation belongs to one scan, one value and one person.
    const priorValid =
      prior?.confirmedAt &&
      String(prior.receiptJobId ?? "") === jobId &&
      sameValue(field, prior.confirmedValue, current);

    let confirmation = null;
    if (requestedFields.includes(field)) {
      if (!sameValue(field, requested[field], current)) {
        throw new HttpError(
          409,
          "OCR_CONFIRMATION_MISMATCH",
          `The ${label} you confirmed does not match the value on the expense. Review it and confirm again.`,
          [{ path: field, message: `Confirm the ${label} again.` }],
        );
      }
      if (priorValid && prior.confirmedBy?.id === user.id) {
        confirmation = { value: prior.confirmedValue, by: prior.confirmedBy, at: prior.confirmedAt };
      } else {
        confirmation = { value: current, by: { id: String(user.id), name: String(user.name ?? "") }, at: now };
        log.push(
          reason === "not_read"
            ? `Provided the ${label} ${describeValue(field, current, currency)} (not found on the receipt scan).`
            : sameValue(field, current, ocrValue)
            ? `Confirmed the ${label} ${describeValue(field, current, currency)} (OCR confidence ${percent(ocrConfidence)}).`
            : `Corrected the ${label}: OCR read ${describeValue(field, ocrValue, currency)} (confidence ${percent(ocrConfidence)}), confirmed ${describeValue(field, current, currency)}.`,
        );
      }
    } else if (priorValid) {
      confirmation = { value: prior.confirmedValue, by: prior.confirmedBy, at: prior.confirmedAt };
    } else if (prior?.confirmedAt) {
      log.push(`Confirmation of the ${label} cleared: the value changed after it was confirmed.`);
    }

    return {
      field,
      reason,
      receiptJobId: job._id,
      ocrValue,
      ocrConfidence,
      status: !confirmation
        ? "needs_confirmation"
        : reason === "not_read"
          ? "provided"
          : sameValue(field, confirmation.value, ocrValue)
            ? "confirmed"
            : "corrected",
      confirmedValue: confirmation?.value ?? null,
      confirmedBy: confirmation?.by ?? null,
      confirmedAt: confirmation?.at ?? null,
    };
  });

  expense.ocrFieldReviews = reviews.length ? reviews : undefined;
  return log;
}

/** Reviews still waiting for the employee (blocks submission). */
export function unconfirmedOcrFields(expense) {
  return (expense?.ocrFieldReviews ?? []).filter((review) => review.status === "needs_confirmation");
}

/**
 * Whether a change from the scanned total to the submitted total needs review.
 * Within tolerance only when the difference is within BOTH the amount and the
 * percentage limit. Both default to 0: any change is material.
 */
export function isMaterialTotalCorrection(ocrTotal, submittedTotal, tolerance = env.ocrTotalCorrectionTolerance) {
  const differenceCents = Math.abs(Math.round(submittedTotal * 100) - Math.round(ocrTotal * 100));
  if (differenceCents === 0) return false;
  const amountLimitCents = Math.round((tolerance?.amount ?? 0) * 100);
  const percentLimitCents = Math.floor((Math.abs(ocrTotal) * 100 * (tolerance?.percent ?? 0)) / 100);
  return differenceCents > amountLimitCents || differenceCents > percentLimitCents;
}
