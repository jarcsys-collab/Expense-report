import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useWorkspace } from "../../hooks/useWorkspace";

export function Modal({ title, onClose, children, wide = false }) {
  const { toasts } = useWorkspace();
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      {children}
      <div className="modal-notifications" aria-live="polite">
        {toasts
          .filter((toast) => toast.error)
          .map((toast) => (
            <div key={toast.id} className="toast error" role="alert">
              {toast.message}
            </div>
          ))}
      </div>
    </dialog>
  );
}
