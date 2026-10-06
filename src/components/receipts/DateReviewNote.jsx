import { formatDate } from "../../utils/format";

// Shown under the receipt date on the review screen. Displays the date exactly
// as printed on the receipt and, when it can be read two ways (e.g. 10/03/2026),
// lets the employee pick or confirm the correct date. Submission stays blocked
// until the confirmed date matches the date in the field.
export function DateReviewNote({ review, value, disabled, onConfirm }) {
  if (!review?.raw) return null;
  if (!review.ambiguous) {
    return (
      <small className="date-review muted">Receipt shows “{review.raw}”.</small>
    );
  }
  const { dayMonthYear, monthDayYear } = review.candidates;
  const confirmed = Boolean(value) && review.confirmedDate === value;
  return (
    <span
      className="date-review"
      role="group"
      aria-label="Confirm receipt date"
    >
      <small className="muted">
        Receipt shows “{review.raw}”: {formatDate(dayMonthYear)} (day/month) or{" "}
        {formatDate(monthDayYear)} (month/day).
      </small>
      {confirmed ? (
        <small className="date-confirmed">
          ✓ Date confirmed: {formatDate(value)}
        </small>
      ) : (
        <span className="date-review-actions">
          {[dayMonthYear, monthDayYear].map((date) => (
            <button
              key={date}
              type="button"
              className="text-button"
              disabled={disabled}
              onClick={() => onConfirm(date)}
            >
              Use {formatDate(date)}
            </button>
          ))}
          {value && value !== dayMonthYear && value !== monthDayYear && (
            <button
              type="button"
              className="text-button"
              disabled={disabled}
              onClick={() => onConfirm(value)}
            >
              Confirm {formatDate(value)}
            </button>
          )}
        </span>
      )}
    </span>
  );
}
