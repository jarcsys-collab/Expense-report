import { useEffect, useRef, useState } from "react";
import { FileText, RotateCw, ScanLine, TriangleAlert } from "lucide-react";
import { imageTools } from "../../utils/image";
import {
  clampCrop,
  decodeImage,
  drawImageTo,
  formatBytes,
  FULL_CROP,
  HEIC_NOT_SUPPORTED_MESSAGE,
  hasEdits,
  isHeic,
  isImage,
  moveCropEdge,
  prepareReceiptFile,
  rotateCropClockwise,
} from "../../utils/receiptImage";
import { Modal } from "../common/Modal";
import { Spinner } from "../common/Spinner";

const PREVIEW_SIDE = 1100;
const KEY_STEP = 0.02;
const EDGES = [
  ["top", "Top edge"],
  ["right", "Right edge"],
  ["bottom", "Bottom edge"],
  ["left", "Left edge"],
];

// One crop edge: drag it, or focus it and use the arrow keys.
function CropHandle({ edge, label, crop, frameRef, onChange }) {
  const dragging = useRef(false);
  const vertical = edge === "top" || edge === "bottom";
  const fromPointer = (event) => {
    const box = frameRef.current.getBoundingClientRect();
    const position = vertical ? (event.clientY - box.top) / box.height : (event.clientX - box.left) / box.width;
    onChange(moveCropEdge(crop, edge, edge === "top" || edge === "left" ? position : 1 - position));
  };
  return (
    <button
      type="button"
      className={`crop-handle crop-handle-${edge}`}
      style={{ [edge]: `${crop[edge] * 100}%` }}
      role="slider"
      aria-label={`Crop: ${label}`}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={0}
      aria-valuemax={90}
      aria-valuenow={Math.round(crop[edge] * 100)}
      aria-valuetext={`${Math.round(crop[edge] * 100)}% removed`}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => dragging.current && fromPointer(event)}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onKeyDown={(event) => {
        const inward = { top: "ArrowDown", bottom: "ArrowUp", left: "ArrowRight", right: "ArrowLeft" }[edge];
        const outward = { top: "ArrowUp", bottom: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" }[edge];
        if (event.key === inward || event.key === outward) {
          event.preventDefault();
          onChange(moveCropEdge(crop, edge, crop[edge] + (event.key === inward ? KEY_STEP : -KEY_STEP)));
        }
      }}
    >
      <i aria-hidden="true" />
    </button>
  );
}

/**
 * Shows the receipt before anything leaves the device. The only way forward is the
 * explicit confirm button: no image goes to the OCR service without it.
 */
export function ReceiptPrepareModal({ file, acceptsHeic = false, position, confirmLabel = "Scan receipt", onConfirm, onCancel }) {
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const submitted = useRef(false);
  const [bitmap, setBitmap] = useState(null);
  const [decoding, setDecoding] = useState(() => isImage(file));
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [crop, setCrop] = useState(FULL_CROP);
  const [enhance, setEnhance] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState([]);
  const image = isImage(file);
  const heicBlocked = isHeic(file) && !acceptsHeic && decodeFailed;

  useEffect(() => {
    if (!image) return undefined;
    let active = true;
    let decoded;
    decodeImage(file)
      .then((result) => {
        if (!active) {
          result.close?.();
          return;
        }
        decoded = result;
        setBitmap(result);
      })
      .catch(() => active && setDecodeFailed(true))
      .finally(() => active && setDecoding(false));
    imageTools.analyze(file).then((warnings) => active && setNotes(warnings), () => {});
    return () => {
      active = false;
      decoded?.close?.();
    };
  }, [file, image]);

  useEffect(() => {
    if (bitmap && canvasRef.current) drawImageTo(canvasRef.current, bitmap, { rotation, enhance }, PREVIEW_SIDE);
  }, [bitmap, rotation, enhance]);

  const edits = { rotation, crop, enhance };
  async function confirm() {
    if (submitted.current || heicBlocked) return;
    submitted.current = true;
    setWorking(true);
    setError("");
    try {
      const prepared = await prepareReceiptFile(file, edits, { acceptsHeic });
      await onConfirm(prepared.file, prepared);
    } catch (problem) {
      submitted.current = false;
      setError(problem instanceof Error ? problem.message : "The photo could not be prepared.");
      setWorking(false);
    }
  }

  return (
    <Modal title={position ? `Check receipt ${position.index} of ${position.total}` : "Check your receipt"} onClose={() => !working && onCancel()} wide>
      <p className="muted prepare-note">
        Nothing is sent until you choose <strong>{confirmLabel}</strong>.
      </p>
      {image && !decodeFailed ? (
        <div className="prepare-stage">
          {decoding && <Spinner />}
          <div ref={frameRef} className="prepare-frame" hidden={decoding}>
            <canvas ref={canvasRef} role="img" aria-label="Receipt preview" />
            <div className="crop-shade" aria-hidden="true">
              <div
                className="crop-window"
                style={{
                  top: `${crop.top * 100}%`,
                  right: `${crop.right * 100}%`,
                  bottom: `${crop.bottom * 100}%`,
                  left: `${crop.left * 100}%`,
                }}
              />
            </div>
            {EDGES.map(([edge, label]) => (
              <CropHandle key={edge} edge={edge} label={label} crop={crop} frameRef={frameRef} onChange={(next) => setCrop(clampCrop(next))} />
            ))}
          </div>
        </div>
      ) : (
        <div className="prepare-file">
          {heicBlocked ? <TriangleAlert size={28} aria-hidden="true" /> : <FileText size={28} aria-hidden="true" />}
          <div>
            <strong>{file.name}</strong>
            <small>{formatBytes(file.size)}</small>
          </div>
        </div>
      )}
      {heicBlocked && (
        <p className="prepare-problem" role="alert">
          {HEIC_NOT_SUPPORTED_MESSAGE}
        </p>
      )}
      {image && decodeFailed && !heicBlocked && <p className="muted">Preview isn’t available on this device. You can still scan the original file.</p>}
      {bitmap && (
        <>
          <div className="prepare-tools">
            <button
              type="button"
              className="button"
              disabled={working}
              onClick={() => {
                setRotation((current) => (current + 90) % 360);
                setCrop((current) => rotateCropClockwise(current));
              }}
            >
              <RotateCw size={16} aria-hidden="true" />
              Rotate
            </button>
            <button type="button" className="button" disabled={working || !hasEdits({ crop, rotation, enhance })} onClick={() => {
              setRotation(0);
              setCrop(FULL_CROP);
              setEnhance(false);
            }}>
              Reset
            </button>
            <label className="checkbox-label">
              <input type="checkbox" checked={enhance} disabled={working} onChange={(event) => setEnhance(event.target.checked)} />
              Enhance text (black and white, more contrast)
            </label>
          </div>
          <p className="muted prepare-hint">Drag the edges of the frame to crop out the background, or focus an edge and use the arrow keys. Keep all the text inside.</p>
        </>
      )}
      {notes.map((note) => (
        <p key={note} className="muted">
          {note}
        </p>
      ))}
      {error && (
        <p className="prepare-problem" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button type="button" className="button" disabled={working} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button primary" disabled={working || decoding || heicBlocked} onClick={confirm}>
          {working ? <Spinner /> : <ScanLine size={16} aria-hidden="true" />}
          {working ? "Preparing…" : confirmLabel}
        </button>
      </footer>
    </Modal>
  );
}
