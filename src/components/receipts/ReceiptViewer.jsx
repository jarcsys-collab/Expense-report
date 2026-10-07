import { useEffect, useState } from "react";
import {
  Download,
  ExternalLink,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useWorkspace } from "../../hooks/useWorkspace";
import { downloadReceipt, openReceipt } from "../../services/receiptFiles";

export function ReceiptViewer({ file }) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const { run } = useWorkspace();
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => {
    setPreviewFailed(false);
    setZoom(1);
    setRotation(0);
  }, [file.id]);
  const isPdf = file.mimeType === "application/pdf";
  // Saved expenses keep only the file details (the original is not stored).
  if (!/^(https?:|blob:|data:)/.test(file.url || "")) {
    return (
      <div className="receipt-view">
        <div className="receipt-canvas receipt-not-stored">
          <p>
            Original receipt not stored. ReceiptFlow keeps the file details and
            the scanned data only.
          </p>
        </div>
        <small className="muted">{file.name}</small>
      </div>
    );
  }
  return (
    <div className="receipt-view">
      <div className="preview-toolbar">
        <button
          className="icon-button"
          title={
            isPdf
              ? "Use the PDF viewer controls or open the original"
              : "Zoom out"
          }
          disabled={isPdf}
          aria-label="Zoom out"
          onClick={() => setZoom((current) => Math.max(0.5, current - 0.25))}
        >
          <ZoomOut size={18} />
        </button>
        <span>{isPdf ? "PDF" : `${Math.round(zoom * 100)}%`}</span>
        <button
          className="icon-button"
          title={
            isPdf
              ? "Use the PDF viewer controls or open the original"
              : "Zoom in"
          }
          disabled={isPdf}
          aria-label="Zoom in"
          onClick={() => setZoom((current) => Math.min(3, current + 0.25))}
        >
          <ZoomIn size={18} />
        </button>
        <button
          className="icon-button"
          title={
            isPdf
              ? "Use the PDF viewer controls or open the original"
              : "Rotate preview"
          }
          disabled={isPdf}
          aria-label="Rotate preview"
          onClick={() => setRotation((current) => current + 90)}
        >
          <RotateCw size={18} />
        </button>
        <button
          className="icon-button"
          title="Download receipt"
          aria-label="Download receipt"
          onClick={() => void run(() => downloadReceipt(file))}
        >
          <Download size={18} />
        </button>
        <button
          className="icon-button"
          title="Open original"
          aria-label="Open original"
          onClick={() => void run(() => openReceipt(file))}
        >
          <ExternalLink size={18} />
        </button>
      </div>
      <div className="receipt-canvas">
        {isPdf ? (
          <object data={file.url} type="application/pdf" aria-label={file.name}>
            <p>
              PDF preview unavailable.{" "}
              <button
                className="text-button"
                onClick={() => void run(() => openReceipt(file))}
              >
                Open PDF
              </button>
            </p>
          </object>
        ) : previewFailed ? (
          <p>
            This image format cannot be previewed here. Use Open Original or
            download to view it.
          </p>
        ) : (
          <img
            alt={`Receipt: ${file.name}`}
            src={file.url}
            onError={() => setPreviewFailed(true)}
            style={{
              width: `${zoom * 100}%`,
              maxWidth: "none",
              transform: `rotate(${rotation}deg)`,
            }}
          />
        )}
      </div>
      <small className="muted">{file.name}</small>
    </div>
  );
}
