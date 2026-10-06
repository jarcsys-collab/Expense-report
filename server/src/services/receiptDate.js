// Receipt date interpretation.
//
// Numeric dates such as 10/03/2026 can mean 10 March (day/month, the usual
// Philippine order) or 3 October (month/day). The OCR provider picks one
// silently, so ReceiptFlow re-reads the printed date from the OCR text:
//   - only one valid reading (e.g. 25/03/2026) → use it
//   - two valid readings → suggest the preferred order (RECEIPT_DATE_ORDER,
//     default DMY) but require the employee to confirm before submission
// The printed text, the provider's reading and both candidates are kept.

const DATE_TOKEN = /\b(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})\b/g;

function isoDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
    ? d.toISOString().slice(0, 10)
    : null;
}

function readToken([raw, a, separator, b, y]) {
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const dayMonthYear = isoDate(year, Number(b), Number(a));
  const monthDayYear = isoDate(year, Number(a), Number(b));
  return { raw, separator, dayMonthYear, monthDayYear };
}

/**
 * @param {object} input
 * @param {string} [input.providerDate] YYYY-MM-DD as read by the OCR provider
 * @param {string} [input.ocrText]      full OCR text of the receipt
 * @param {"DMY"|"MDY"} [input.preferredOrder]
 * @returns {{ expenseDate?: string, review?: object }}
 */
export function interpretReceiptDate({ providerDate, ocrText, preferredOrder = "DMY" }) {
  const tokens = typeof ocrText === "string" ? [...ocrText.matchAll(DATE_TOKEN)].map(readToken) : [];
  // The printed date the provider used: the token one of whose readings equals its date.
  const token = providerDate
    ? tokens.find((t) => t.dayMonthYear === providerDate || t.monthDayYear === providerDate)
    : tokens.find((t) => t.dayMonthYear || t.monthDayYear);
  if (!token) return providerDate ? { expenseDate: providerDate } : {};

  const readings = [...new Set([token.dayMonthYear, token.monthDayYear].filter(Boolean))];
  const base = {
    field: "expenseDate",
    raw: token.raw,
    providerDate: providerDate ?? null,
    candidates: { dayMonthYear: token.dayMonthYear, monthDayYear: token.monthDayYear },
  };
  if (readings.length === 1) {
    return { expenseDate: readings[0], review: { ...base, ambiguous: false, status: "not_required", suggested: readings[0], confirmedDate: null } };
  }

  // Ambiguous. Another date on the same receipt that can only be read one way
  // shows the receipt's format; otherwise use the configured preference.
  const evidence = tokens.find((t) => t !== token && t.separator === token.separator && Boolean(t.dayMonthYear) !== Boolean(t.monthDayYear));
  const order = evidence ? (evidence.dayMonthYear ? "DMY" : "MDY") : preferredOrder;
  const suggested = order === "DMY" ? token.dayMonthYear : token.monthDayYear;
  return {
    expenseDate: suggested,
    review: {
      ...base,
      ambiguous: true,
      status: "needs_confirmation",
      suggested,
      suggestedOrder: order,
      orderSource: evidence ? `another date on the receipt (${evidence.raw})` : "configured preference",
      confirmedDate: null,
    },
  };
}

// Applies an employee confirmation to a stored review. The confirmation only
// counts for the exact date it was given for.
export function applyDateConfirmation(review, expenseDate, confirmedDate) {
  if (!review) return undefined;
  const { confirmedAt, ...rest } = review;
  if (!review.ambiguous) return { ...rest, status: "not_required", confirmedDate: null };
  const confirmed = Boolean(confirmedDate) && confirmedDate === expenseDate;
  if (!confirmed) return { ...rest, status: "needs_confirmation", confirmedDate: null };
  return {
    ...rest,
    status: "confirmed",
    confirmedDate,
    confirmedAt: review.confirmedDate === confirmedDate && confirmedAt ? confirmedAt : new Date().toISOString(),
  };
}

export const describeIsoDate = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-PH", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
