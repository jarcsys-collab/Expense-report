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
import { api } from "../../services/api";
import { describeReceiptLoadFailure, isStoredScanFile } from "../../utils/receiptSource";

// `expense` is the expense the file belongs to. Without it (or for an expense not
// saved yet) the file is shown from its own link.
export function ReceiptViewer({ file, expense }) {
  const fromServer = isStoredScanFile(file, expense);
  const [attempt, setAttempt] = useState(0);
  // A result only counts for the load it came from, so changing file never shows
  // the previous file's image or error.
  const loadKey = fromServer ? `${expense.id}:${file.id}:${attempt}` : "";
  const [stored, setStored] = useState({ key: "", url: "", failure: null });
  useEffect(() => {
    if (!loadKey) return undefined;
    let cancelled = false;
    let objectUrl = "";
    api.getReceiptFile(expense.id).then(
      (blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setStored({ key: loadKey, url: objectUrl, failure: null });
      },
      (error) => {
        if (!cancelled) setStored({ key: loadKey, url: "", failure: describeReceiptLoadFailure(error) });
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [loadKey]);
  if (!fromServer) return <ReceiptFileViewer file={file} />;
  const current = stored.key === loadKey ? stored : null;
  if (current?.url) return <ReceiptFileViewer file={{ ...file, url: current.url }} />;
  return (
    <div className="receipt-view">
      <div className="receipt-canvas receipt-not-stored" role={current ? "alert" : "status"}>
        <p>{current ? current.failure.message : "Loading the original receipt…"}</p>
        {current?.failure.canRetry && (
          <button type="button" className="button" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        )}
      </div>
      <small className="muted">{file.name}</small>
    </div>
  );
}

function ReceiptFileViewer({ file }) {
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
  // A file entry with no link and no receipt scan behind it: only its details exist.
  if (!/^(https?:|blob:|data:)/.test(file.url || "")) {
    return (
      <div className="receipt-view">
        <div className="receipt-canvas receipt-not-stored">
          <p>
            Original receipt not stored. Only the file details were saved for
            this attachment.
          </p>
        </div>
        <small className="muted">{file.name}</small>
      </div>
    );
  }
  const pdfFallback = (
    <p>
      PDF preview unavailable.{" "}
      <button
        type="button"
        className="text-button"
        onClick={() => void run(() => openReceipt(file))}
      >
        Open PDF
      </button>
    </p>
  );
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
          // Most phone browsers cannot show a PDF inside a page: offer it directly.
          navigator.pdfViewerEnabled === false ? (
            pdfFallback
          ) : (
            <object data={file.url} type="application/pdf" aria-label={file.name}>
              {pdfFallback}
            </object>
          )
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
