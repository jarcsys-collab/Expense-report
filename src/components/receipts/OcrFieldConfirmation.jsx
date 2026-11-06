import { CircleCheck, TriangleAlert } from "lucide-react";
import { confidenceText, describeOcrValue } from "../../utils/ocrConfirmation";

// Status of a key receipt field that OCR read with low confidence:
// needs confirmation (with a Confirm button), confirmed, or corrected.
// `state` comes from ocrFieldStates(expense).
export function OcrFieldStatus({ state, currency, onConfirm, disabled = false }) {
  if (!state) return null;
  if (state.status === "needs_confirmation") {
    return (
      <span className="ocr-status needs-confirmation">
        <TriangleAlert size={13} aria-hidden="true" />
        <span>
          {state.reason === "not_read"
            ? "Not found on the receipt · choose it and confirm"
            : `Check against receipt · read with ${confidenceText(state.ocrConfidence)}`}
        </span>
        {onConfirm && (
          <button
            type="button"
            className="ocr-confirm-button"
            disabled={disabled}
            onClick={(event) => {
              // Inside a <label>: do not move focus to the input.
              event.preventDefault();
              onConfirm();
            }}
          >
            Confirm
          </button>
        )}
      </span>
    );
  }
  const who = state.unsaved ? "you (saved with the expense)" : state.confirmedBy?.name || "the employee";
  return (
    <span className={`ocr-status ${state.status}`}>
      <CircleCheck size={13} aria-hidden="true" />
      <span>
        {state.status === "corrected"
          ? `Corrected by ${who} · scan read ${describeOcrValue(state.field, state.ocrValue, currency)}`
          : state.status === "provided"
            ? `Provided by ${who}`
            : `Confirmed by ${who}`}
      </span>
    </span>
  );
}
