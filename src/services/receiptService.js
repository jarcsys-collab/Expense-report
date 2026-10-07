// /receipts endpoints: OCR upload, OCR job status and edited receipt files.
import { resolveEndpoint } from "../config/api";
import { config } from "../config/appConfig";
import { sanitizeFileName } from "../utils/format";
import { getActiveUser } from "./authService";
import { apiRequest, createAbortError } from "./httpClient";
import {
  normalizeFile,
  normalizeOcrResult,
  unwrapResponse,
} from "./normalizers";

export const RECEIPT_UPLOAD_DISABLED_MESSAGE =
  "Receipt scanning service is not configured.";

// POST /receipts/upload (multipart, one or more files in the "receipt" field).
// Returns either a finished OCR result or { status: "processing", jobId } to poll.
// Disabled until VITE_RECEIPT_UPLOAD_ENABLED=true and the backend OCR route exists.
export async function uploadReceipt(files, options = {}) {
  if (!config.receiptUploadEnabled) {
    throw new Error(RECEIPT_UPLOAD_DISABLED_MESSAGE);
  }
  const form = new FormData();
  for (const file of files) {
    form.append(config.uploadField, file, sanitizeFileName(file.name));
  }
  if (options.receiptId) {
    form.append("receiptId", options.receiptId);
  }
  const endpoint = resolveEndpoint("upload");
  const response = await apiRequest(endpoint.path, endpoint.method, form, {
    signal: options.signal,
    timeout: config.ocrTimeout,
  });
  return normalizeOcrResult(response, { ...options, user: getActiveUser() });
}

// GET /receipts/{jobId}/status
export async function getOcrStatus(jobId, options = {}) {
  const endpoint = resolveEndpoint("ocr", { jobId });
  const response = await apiRequest(endpoint.path, endpoint.method, undefined, {
    signal: options.signal,
  });
  const payload = unwrapResponse(response);
  const result = normalizeOcrResult(
    { ...payload, jobId: payload.jobId ?? jobId },
    { ...options, user: getActiveUser() },
  );
  return { ...result, jobId: result.jobId || jobId };
}

// POST /receipts/files: stores an added or edited receipt image and returns its file record.
export async function saveEditedFile(file, pageNumber) {
  const form = new FormData();
  form.append("file", file, sanitizeFileName(file.name));
  const endpoint = resolveEndpoint("editedFile");
  return normalizeFile(
    unwrapResponse(await apiRequest(endpoint.path, endpoint.method, form)),
    pageNumber - 1,
  );
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(createAbortError());
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Polls an OCR job until it is ready, fails, times out or is cancelled.
export async function waitForOcr(initialStatus, options) {
  let status = initialStatus;
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  options.signal.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal.aborted) {
    controller.abort();
  }
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeout ?? config.ocrTimeout);
  try {
    while (status.status === "processing") {
      if (controller.signal.aborted) {
        throw createAbortError();
      }
      options.onStatus?.(status);
      await delay(options.interval ?? config.pollInterval, controller.signal);
      status = await options.poll(status.jobId, controller.signal);
    }
    if (controller.signal.aborted) {
      throw createAbortError();
    }
    if (status.status === "failed") {
      throw new Error(
        status.error || "OCR processing failed. Retry the receipt.",
      );
    }
    if (!status.expense) {
      throw new Error("Invalid OCR response: extracted fields are missing.");
    }
    return status;
  } catch (error) {
    throw timedOut
      ? new Error("OCR processing timed out. Retry to check the existing job.")
      : error;
  } finally {
    clearTimeout(timeoutId);
    options.signal.removeEventListener("abort", forwardAbort);
  }
}

// Upload (or resume) one receipt scan and wait for its OCR result: the same
// ReceiptFlow → API → Veryfi process for the upload queue and the
// Reimbursement Assistant. `onStage` reports what is really happening:
// "uploading" while the file is sent, "processing" while the API reports the
// OCR job as still running.
export async function scanReceipt({ upload, poll, files, jobId, signal, receiptId, previews, onStage, onJob }) {
  const options = { signal, receiptId, files: previews };
  onStage?.(jobId ? "processing" : "uploading");
  const initial = jobId ? await poll(jobId, options) : await upload(files, options);
  if (signal.aborted) throw createAbortError();
  onJob?.(initial.jobId || undefined);
  const result = await waitForOcr(initial, {
    signal,
    interval: config.pollInterval,
    poll: (id, pollSignal) => poll(id, { ...options, signal: pollSignal }),
    onStatus: (status) => onStage?.("processing", status),
  });
  const expense = result.expense;
  expense.originalOCR ??= {
    merchant: expense.merchant,
    amount: expense.amount,
    expenseDate: expense.expenseDate,
    receiptNumber: expense.receiptNumber,
    subtotal: expense.subtotal,
    tax: expense.tax,
  };
  return result;
}
