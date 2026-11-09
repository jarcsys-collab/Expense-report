// How each scanned field ended up on the expense. Built on the server from the
// stored scan and the expense, so the browser cannot change it:
//   extracted  the scan read it and the value is unchanged
//   confirmed  the scan was unsure; the employee checked it and kept it
//   corrected  the employee changed what the scan read
//   provided   the scan did not read it; the employee entered it
//   missing    neither the scan nor the employee has a value
import { comparableValue, ocrFieldsNeedingConfirmation } from "./ocrFieldReview.js";

export const TRACKED_FIELDS = ["merchant", "merchantAddress", "expenseDate", "receiptNumber", "currency", "amount", "subtotal", "tax", "paymentMethod"];
const MONEY = new Set(["amount", "subtotal", "tax"]);

// The expense schema defaults money to 0, so 0 means "no value" unless the scan printed 0.
function value(field, raw) {
  if (MONEY.has(field)) {
    const number = Number(raw);
    return Number.isFinite(number) && number !== 0 ? Math.round(number * 100) : null;
  }
  return comparableValue(field === "amount" ? "amount" : field, raw);
}

/** @returns {{ provider: string|undefined, fields: {field: string, status: string, confidence: number|null}[] } | undefined} */
export function buildOcrQuality(expense, job) {
  if (!job?.result || !job?.ocrMeta) return undefined;
  const reviews = new Map((expense.ocrFieldReviews ?? []).map((review) => [review.field, review]));
  const awaitingCurrency = ocrFieldsNeedingConfirmation(job).some((item) => item.field === "currency");
  const fields = TRACKED_FIELDS.map((field) => {
    const scanned = value(field, job.result[field]);
    const current = value(field, expense[field]);
    const review = reviews.get(field);
    let status;
    if (field === "currency" && awaitingCurrency) {
      // The schema defaults currency to PHP: without a confirmation it is still missing.
      status = review?.status === "provided" ? "provided" : "missing";
    } else if (scanned === null) status = current === null ? "missing" : "provided";
    else if (current === null || current !== scanned) status = "corrected";
    else if (review?.status === "confirmed" || (field === "expenseDate" && expense.dateReview?.status === "confirmed")) status = "confirmed";
    else status = "extracted";
    const score = job.ocrMeta.confidence?.[field];
    return { field, status, confidence: typeof score === "number" ? score : null };
  });
  return { provider: job.ocrMeta.provider ?? job.ocrProvider, fields };
}
