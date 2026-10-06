import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Camera,
  Check,
  CloudUpload,
  FileText,
  ImagePlus,
  Plus,
  RotateCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useUploadQueue } from "../../hooks/useUploadQueue";
import { useWorkspace } from "../../hooks/useWorkspace";
import { imageTools, transformImage } from "../../utils/image";
import { validateReceiptFile } from "../../utils/receiptFile";
import { Modal } from "../common/Modal";
import { Spinner } from "../common/Spinner";
import { FileThumbnail } from "./FileThumbnail";

export function ReceiptUploader() {
  const { notify } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const [scanOptionsOpen, setScanOptionsOpen] = useState(false);
  useEffect(() => {
    if (location.state?.scan) {
      setScanOptionsOpen(true);
      navigate("/upload", {
        replace: true,
        state: null,
      });
    }
  }, [location.state, navigate]);
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const photoInputRef = useRef(null);
  const {
    queue,
    remove: removeFromQueue,
    process: processItem,
    add: addFiles,
  } = useUploadQueue();
  const [dragging, setDragging] = useState(false);
  const [sections, setSections] = useState([]);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState();
  const [trim, setTrim] = useState(0);
  const [editingUrl, setEditingUrl] = useState("");
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (editingIndex === undefined || !sections[editingIndex]) {
      setEditingUrl("");
      return;
    }
    const objectUrl = URL.createObjectURL(sections[editingIndex]);
    setEditingUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [editingIndex, sections]);
  async function addSections(files) {
    for (const file of files)
      try {
        validateReceiptFile(file);
        (await imageTools.analyze(file)).forEach((item) => notify(item));
        setSections((current) => [...current, file]);
      } catch (error) {
        notify(error.message, true);
      }
    setCaptureOpen(true);
  }
  const readyItems = queue.filter((item) => item.expense);
  function openReview(item) {
    if (item.expense) {
      navigate("/review/new", {
        state: {
          expense: item.expense,
          queueId: item.id,
        },
      });
    }
  }
  return (
    <>
      <section
        className={`upload-hero ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles([...event.dataTransfer.files]);
        }}
      >
        <div className="dropzone">
          <div className="upload-symbol">
            <CloudUpload size={30} strokeWidth={1.5} />
          </div>
          <strong className="desktop-upload-text">
            Drop your receipt here
          </strong>
          <strong className="mobile-upload-text">Capture your receipt</strong>
          <p className="capture-hint mobile-upload-text">
            Keep the full receipt in frame, with clear text and no glare.
          </p>
          <span className="desktop-upload-text">or</span>
          <button
            className="button browse-button desktop-upload-text"
            onClick={() => {
              return fileInputRef.current?.click();
            }}
          >
            Choose Receipt
          </button>
          <button
            className="button camera-button mobile-upload-text"
            onClick={() => {
              return cameraInputRef.current?.click();
            }}
          >
            <Camera size={19} />
            {" Take Photo"}
          </button>
          <div className="mobile-file-options">
            <button
              onClick={() => {
                return photoInputRef.current?.click();
              }}
            >
              <ImagePlus size={18} aria-hidden="true" />
              {" Choose Photo"}
            </button>
            <button
              onClick={() => {
                return fileInputRef.current?.click();
              }}
            >
              <FileText size={18} aria-hidden="true" />
              {" Browse Files"}
            </button>
          </div>
          <small>JPG, PNG, WEBP, HEIC or PDF · up to 20 MB</small>
        </div>
        <div className="upload-queue">
          {queue.length ? (
            queue.map((item) => (
              <div
                key={item.id}
                className="queue-item"
                data-status={item.status}
              >
                <div>
                  <FileThumbnail file={item.files[0]} />
                  <span title={item.files[0].name}>
                    {item.files[0].name}
                    {item.files.length > 1
                      ? ` + ${item.files.length - 1} sections`
                      : ""}
                  </span>
                  <small className="queue-status">{item.status}</small>
                  {item.status === "Failed" ? (
                    <button
                      className="icon-button"
                      aria-label="Retry upload"
                      onClick={() => void processItem(item)}
                    >
                      <RotateCw size={15} />
                    </button>
                  ) : item.expense ? (
                    <button
                      className="icon-button"
                      aria-label="Review receipt"
                      onClick={() => openReview(item)}
                    >
                      <ArrowRight size={16} />
                    </button>
                  ) : (
                    <Spinner />
                  )}
                  <button
                    className="icon-button"
                    aria-label="Remove from queue"
                    title="Remove receipt and cancel active processing"
                    onClick={() => removeFromQueue(item.id)}
                  >
                    <X size={14} />
                  </button>
                </div>
                <div
                  className={`progress ${!item.expense && item.status !== "Failed" ? "indeterminate" : ""}`}
                  role="progressbar"
                  aria-label={`${item.files[0].name}: ${item.status}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={item.expense ? 100 : undefined}
                >
                  <i
                    style={{
                      width: `${item.progress}%`,
                    }}
                  />
                </div>
                {item.message && (
                  <p className="queue-caption" role="status">
                    {item.message}
                  </p>
                )}
                {item.error && <p className="queue-error">{item.error}</p>}
              </div>
            ))
          ) : (
            <div className="queue-empty">
              <div className="queue-illustration">
                <FileText size={21} />
                <span />
                <Check size={16} />
              </div>
              <h3>Your next step: verify the details.</h3>
              <p>
                Add receipts to extract the details.
                <br />
                You’ll review everything before submitting.
              </p>
            </div>
          )}
          <div className="queue-actions">
            <button
              className="button light-button"
              disabled={!readyItems.length}
              title={
                readyItems.length
                  ? "Review extracted receipt details"
                  : "Upload a receipt and wait for extraction before reviewing"
              }
              onClick={() => openReview(readyItems[0])}
            >
              {"Review receipts "}
              <ArrowRight size={16} />
            </button>
            <button
              className="text-button"
              onClick={() => {
                setSections([]);
                setCaptureOpen(true);
              }}
            >
              <Plus size={15} />
              {" Long receipt"}
            </button>
          </div>
          <small className="queue-caption">
            {queue.length
              ? `${readyItems.length} ready to review · ${queue.filter((item) => !item.expense && item.status !== "Failed").length} processing`
              : "Review extracted details before submission"}
          </small>
        </div>
      </section>
      <input
        ref={fileInputRef}
        hidden
        type="file"
        accept=".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf"
        multiple
        onChange={(event) => {
          addFiles(Array.from(event.target.files || []));
          event.target.value = "";
        }}
      />
      <input
        ref={cameraInputRef}
        hidden
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => {
          addSections(Array.from(event.target.files || []));
          event.target.value = "";
        }}
      />
      <input
        ref={photoInputRef}
        hidden
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        multiple
        onChange={(event) => {
          addSections(Array.from(event.target.files || []));
          event.target.value = "";
        }}
      />
      {scanOptionsOpen && (
        <Modal title="Add a receipt" onClose={() => setScanOptionsOpen(false)}>
          <p className="muted">
            Photograph a receipt or select an existing image or PDF.
          </p>
          <div className="scan-options">
            <button
              className="button primary"
              onClick={() => {
                setScanOptionsOpen(false);
                cameraInputRef.current?.click();
              }}
            >
              <Camera size={20} />
              {" Take Photo"}
            </button>
            <button
              className="button"
              onClick={() => {
                setScanOptionsOpen(false);
                photoInputRef.current?.click();
              }}
            >
              <ImagePlus size={20} />
              {" Choose Photo"}
            </button>
            <button
              className="button"
              onClick={() => {
                setScanOptionsOpen(false);
                fileInputRef.current?.click();
              }}
            >
              <FileText size={20} />
              {" Browse Files"}
            </button>
          </div>
        </Modal>
      )}
      {captureOpen && (
        <Modal title="Capture receipt" onClose={() => setCaptureOpen(false)}>
          <p className="muted">
            Position the receipt inside the camera frame. Use good lighting and
            keep all edges visible.
          </p>
          <div className="capture-sections">
            {sections.map((section, index) => (
              <div key={`${section.name}-${index}`} className="section-row">
                <FileThumbnail file={section} />
                <span>
                  {"Section "}
                  {index + 1}
                  <small>{section.name}</small>
                </span>
                <button
                  className="icon-button"
                  aria-label={`Move section ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() =>
                    setSections((current) => {
                      const next = [...current];
                      [next[index], next[index - 1]] = [
                        next[index - 1],
                        next[index],
                      ];
                      return next;
                    })
                  }
                >
                  <ArrowUp size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Move section ${index + 1} down`}
                  disabled={index === sections.length - 1}
                  onClick={() =>
                    setSections((current) => {
                      const next = [...current];
                      [next[index], next[index + 1]] = [
                        next[index + 1],
                        next[index],
                      ];
                      return next;
                    })
                  }
                >
                  <ArrowDown size={16} />
                </button>
                <button
                  className="text-button"
                  onClick={() => {
                    setEditingIndex(index);
                    setTrim(0);
                  }}
                >
                  Preview / edit
                </button>
                <button
                  className="icon-button"
                  aria-label={`Delete section ${index + 1}`}
                  onClick={() =>
                    setSections((current) =>
                      current.filter((item, index2) => index2 !== index),
                    )
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
          <div className="capture-options">
            <button
              className="button"
              onClick={() => {
                return cameraInputRef.current?.click();
              }}
            >
              <Camera size={18} />
              {sections.length ? "Add another section" : "Take Photo"}
            </button>
            <button
              className="button"
              onClick={() => {
                return photoInputRef.current?.click();
              }}
            >
              <ImagePlus size={18} />
              Gallery
            </button>
          </div>
          <footer>
            <button className="button" onClick={() => setCaptureOpen(false)}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={!sections.length}
              onClick={() => {
                addFiles(sections, true);
                setCaptureOpen(false);
                setSections([]);
              }}
            >
              <Upload size={16} />
              Start scan
            </button>
          </footer>
        </Modal>
      )}
      {editingIndex !== undefined && sections[editingIndex] && (
        <Modal title="Review photo" onClose={() => setEditingIndex(undefined)}>
          <div className="capture-preview">
            <img
              src={editingUrl}
              alt="Captured receipt"
              style={{
                clipPath: `inset(${trim * 100}%)`,
              }}
            />
          </div>
          <label className="field">
            Trim edges ({Math.round(trim * 100)}%)
            <input
              type="range"
              min="0"
              max="0.2"
              step=".01"
              value={trim}
              onChange={(event) => setTrim(Number(event.target.value))}
            />
          </label>
          <p className="muted">
            Trim applies evenly to each edge. Check that receipt text remains
            visible.
          </p>
          <footer>
            <button
              className="button"
              onClick={() => {
                setSections((current) =>
                  current.filter((item, index) => index !== editingIndex),
                );
                setEditingIndex(undefined);
                cameraInputRef.current?.click();
              }}
            >
              Retake
            </button>
            <button
              className="button"
              disabled={editing}
              onClick={async () => {
                setEditing(true);
                try {
                  const rotated = await transformImage(
                    sections[editingIndex],
                    90,
                  );
                  setSections((current) =>
                    current.map((item, index) =>
                      index === editingIndex ? rotated : item,
                    ),
                  );
                } catch {
                  notify(
                    "This format cannot be rotated in your browser. Use the original or retake.",
                    true,
                  );
                } finally {
                  setEditing(false);
                }
              }}
            >
              <RotateCw size={16} />
              Rotate
            </button>
            <button
              className="button primary"
              disabled={editing}
              onClick={async () => {
                setEditing(true);
                try {
                  if (trim) {
                    const cropped = await transformImage(
                      sections[editingIndex],
                      0,
                      trim,
                    );
                    setSections((current) =>
                      current.map((item, index) =>
                        index === editingIndex ? cropped : item,
                      ),
                    );
                  }
                  setEditingIndex(undefined);
                } catch {
                  notify(
                    "Unable to crop this format. Continue with the original.",
                    true,
                  );
                } finally {
                  setEditing(false);
                }
              }}
            >
              Use Photo
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
