import { FileText, ScanLine } from "lucide-react";
import { formatDate } from "../../utils/format";

const formatSize = (bytes) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`;

// Whether ReceiptFlow can show the original file right now. Saved expenses
// keep only file details and the OCR scan, so their files have no link.
export const hasStoredFile = (file) => /^https?:\/\//.test(file?.url || "");
const hasPreview = (file) => /^(https?:|blob:|data:)/.test(file?.url || "");

// What receipt this expense is linked to: the file details, the OCR scan and
// whether the original image/PDF is kept. ReceiptFlow does not store original
// receipt files yet, and this says so instead of offering a broken link.
export function ReceiptAssociation({ expense }) {
  const files = expense.receiptFiles;
  if (!files.length && !expense.receiptJobId) {
    return (
      <p className="receipt-association no-receipt" id="expense-receipt-link">
        No receipt attached. Attach a receipt before submitting.
      </p>
    );
  }
  const temporary = files.some((file) => hasPreview(file) && !hasStoredFile(file));
  const notStored = files.some((file) => !hasStoredFile(file));
  return (
    <div className="receipt-association" id="expense-receipt-link">
      {files.map((file) => (
        <p key={file.id}>
          <FileText size={15} aria-hidden="true" />
          <span>
            <strong>{file.name}</strong>
            <small>
              {[
                file.mimeType === "application/pdf"
                  ? "PDF"
                  : file.mimeType.replace(/^image\//, "").toUpperCase(),
                file.size ? formatSize(file.size) : "",
                file.uploadedAt ? formatDate(file.uploadedAt) : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
          </span>
        </p>
      ))}
      {expense.receiptJobId && (
        <p>
          <ScanLine size={15} aria-hidden="true" />
          <span>
            <strong>Linked to receipt scan</strong>
            <small>The extracted details come from this receipt.</small>
          </span>
        </p>
      )}
      {notStored && (
        <p className="receipt-storage-note">
          {temporary
            ? "The preview is available until you leave this page. ReceiptFlow saves the file details and scanned data, not the original image or PDF."
            : "Original image or PDF not stored. ReceiptFlow keeps the file details and scanned data only."}
        </p>
      )}
    </div>
  );
}
