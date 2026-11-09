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
import { imageTools } from "../../utils/image";
import { prepareReceiptFile } from "../../utils/receiptImage";
import { validateReceiptFile } from "../../utils/receiptFile";
import { Modal } from "../common/Modal";
import { Spinner } from "../common/Spinner";
import { FileThumbnail } from "./FileThumbnail";
import { ReceiptPrepareModal } from "./ReceiptPrepareModal";

export function ReceiptUploader() {
  const { notify, user } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const [scanOptionsOpen, setScanOptionsOpen] = useState(false);
  useEffect(() => {
    if (location.state?.scan) {
      setScanOptionsOpen(true);
      navigate(location.pathname, {
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
  const [startingScan, setStartingScan] = useState(false);
  // Files waiting for the employee to check them; nothing is uploaded before that.
  const [pending, setPending] = useState({ files: [], index: 0 });
  const currentPending = pending.files[pending.index];
  function reviewFiles(files) {
    const accepted = [];
    for (const file of files) {
      try {
        validateReceiptFile(file, { allowOversizedImage: true });
        accepted.push(file);
      } catch (error) {
        notify(error.message, true);
      }
    }
    if (accepted.length) setPending({ files: accepted, index: 0 });
  }
  function nextPending() {
    setPending((current) => (current.index + 1 < current.files.length ? { ...current, index: current.index + 1 } : { files: [], index: 0 }));
  }
  async function startSections() {
    if (startingScan) return;
    setStartingScan(true);
    try {
      const prepared = await Promise.all(sections.map(async (section) => (await prepareReceiptFile(section, {}, { acceptsHeic: user.ocrAcceptsHeic })).file));
      addFiles(prepared, true);
      setCaptureOpen(false);
      setSections([]);
    } catch (error) {
      notify(error.message, true);
    } finally {
      setStartingScan(false);
    }
  }
  async function addSections(files) {
    for (const file of files)
      try {
        validateReceiptFile(file, { allowOversizedImage: true });
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
          reviewFiles([...event.dataTransfer.files]);
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
          <small>JPG, PNG, WEBP, HEIC or PDF · up to 10 MB</small>
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
                  className={`progress ${!item.expense && item.status !== "Failed" && !(item.status === "Uploading" && item.progress > 0) ? "indeterminate" : ""}`}
                  role="progressbar"
                  aria-label={`${item.files[0].name}: ${item.status}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={item.expense ? 100 : item.status === "Uploading" ? item.progress : undefined}
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
          reviewFiles(Array.from(event.target.files || []));
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
                  onClick={() => setEditingIndex(index)}
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
              disabled={!sections.length || startingScan}
              onClick={startSections}
            >
              {startingScan ? <Spinner /> : <Upload size={16} />}
              Start scan
            </button>
          </footer>
        </Modal>
      )}
      {editingIndex !== undefined && sections[editingIndex] && (
        <ReceiptPrepareModal
          file={sections[editingIndex]}
          acceptsHeic={user.ocrAcceptsHeic}
          confirmLabel="Use photo"
          onCancel={() => setEditingIndex(undefined)}
          onConfirm={(prepared) => {
            setSections((current) => current.map((item, index) => (index === editingIndex ? prepared : item)));
            setEditingIndex(undefined);
          }}
        />
      )}
      {currentPending && (
        <ReceiptPrepareModal
          key={`${currentPending.name}-${pending.index}`}
          file={currentPending}
          acceptsHeic={user.ocrAcceptsHeic}
          position={pending.files.length > 1 ? { index: pending.index + 1, total: pending.files.length } : undefined}
          onCancel={nextPending}
          onConfirm={(prepared) => {
            addFiles([prepared]);
            nextPending();
          }}
        />
      )}
    </>
  );
}
