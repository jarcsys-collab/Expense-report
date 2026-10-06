import { useRef, useState } from "react";
import { CircleCheck } from "lucide-react";
import { Modal } from "./Modal";
import { Spinner } from "./Spinner";

export function ConfirmDialog({
  title,
  message,
  onClose,
  onConfirm,
  reason: requiresReason = false,
  danger = false,
}) {
  const [reasonText, setReasonText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!submitting) {
          onClose();
        }
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!(
            submittingRef.current ||
            (requiresReason && reasonText.trim().length < 3)
          )) {
            submittingRef.current = true;
            setSubmitting(true);
            try {
              await onConfirm(reasonText.trim());
            } finally {
              submittingRef.current = false;
              setSubmitting(false);
            }
          }
        }}
      >
        <p className="muted">{message}</p>
        {requiresReason && (
          <label className="field">
            Reason
            <textarea
              autoFocus
              required
              minLength={3}
              value={reasonText}
              onChange={(event) => setReasonText(event.target.value)}
              placeholder="Explain the reason…"
            />
          </label>
        )}
        <footer>
          <button
            type="button"
            className="button"
            disabled={submitting}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={`button ${danger ? "danger-button" : "primary"}`}
            disabled={
              submitting || (requiresReason && reasonText.trim().length < 3)
            }
          >
            {submitting ? <Spinner /> : <CircleCheck size={16} />} {title}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
