import { createHash } from "node:crypto";
import { Router } from "express";
import { receiptUpload } from "../middleware/receiptUpload.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { validateObjectId } from "../middleware/validate.js";
import { ReceiptJob } from "../models/ReceiptJob.js";
import { assertReceiptJobAccess } from "../services/expenseAccess.js";
import { activeOcrProvider, assertOcrSupportsFile, ocrBlockedError } from "../services/ocrProvider.js";
import { recordScanEvent } from "../services/ocrScanEvents.js";
import {
  abandonReceiptJob,
  claimReceiptJob,
  createJobFromPriorScan,
  findPriorScan,
  findReusableReceiptJob,
  jobToResponse,
  processReceiptJob,
} from "../services/receiptProcessing.js";
import { sendReceiptFile, storeReceiptFile } from "../services/receiptFileStore.js";
import { HttpError } from "../middleware/errorHandler.js";
import { redactExpenseForViewer } from "../services/expenseView.js";

// The scan response as this viewer may see it (no other employees' duplicate details).
function jobForViewer(job, user, options) {
  const body = jobToResponse(job, options);
  if (body.expense) body.expense = redactExpenseForViewer(body.expense, user);
  return body;
}

export const receiptsRouter = Router();

// Refuse before reading the upload when OCR cannot run (not configured, or
// paused after a credential/billing/configuration failure).
function requireOcr(req, res, next) {
  const blocked = ocrBlockedError();
  if (blocked) throw blocked;
  next();
}

// POST /api/receipts/upload  (multipart/form-data, file in field "receipt")
// Creates a ReceiptJob, extracts the receipt with the configured OCR provider,
// runs the anomaly check and returns the job with the extracted expense.
// An identical file from the same account is answered from its existing job
// (still processing: the frontend polls it) instead of a second OCR request.
receiptsRouter.post("/upload", requireDatabase, requireOcr, receiptUpload, async (req, res) => {
  const receiptId = typeof req.body?.receiptId === "string" ? req.body.receiptId.slice(0, 100) : undefined;
  const provider = activeOcrProvider();
  try {
    assertOcrSupportsFile(req.receiptFile.mimetype);
  } catch (error) {
    await recordScanEvent({ outcome: "skipped_unsupported", provider, errorCode: error.code }, req.user);
    throw error;
  }
  const identity = { uploadedBy: req.user?.id, fileSha256: createHash("sha256").update(req.receiptFile.buffer).digest("hex") };
  // Every duplicate lookup is scoped to this account: another employee's identical
  // file is never found here, and is read separately (its reading is not shared).
  const answerRetry = async (existing) => {
    await recordScanEvent({ outcome: "duplicate_retry", provider, jobId: existing._id }, req.user);
    const duplicateUpload = { kind: "same_account_retry" };
    res.status(existing.status === "processing" ? 202 : 200).json(jobForViewer(existing, req.user, { receiptId, duplicateUpload }));
  };
  // 1. A double click, network retry or a scan still being read.
  const existing = await findReusableReceiptJob(identity);
  if (existing) return answerRetry(existing);
  // 2. The same file scanned earlier by this account.
  const prior = await findPriorScan(identity);
  if (prior) {
    const job = await createJobFromPriorScan(prior, req.receiptFile, identity, storeReceiptFile);
    // No scores here: the earlier scan already counted them once in the quality figures.
    await recordScanEvent({ outcome: "duplicate_reused", provider, jobId: job._id }, req.user);
    const duplicateUpload = { kind: "same_account_reused", reused: true, previousScanAt: prior.createdAt };
    res.status(201).json(jobForViewer(job, req.user, { receiptId, duplicateUpload }));
    return;
  }
  // 3. A new reading. The unique claim lets only one concurrent upload call the provider.
  const { job, existing: claimedBy } = await claimReceiptJob(req.receiptFile, identity);
  if (claimedBy) return answerRetry(job);
  try {
    // Keep the original so the employee can reopen it from My Requests.
    job.fileId = await storeReceiptFile(job, req.receiptFile);
    await job.save();
  } catch (error) {
    await abandonReceiptJob(job);
    throw error;
  }
  await processReceiptJob(job, req.receiptFile, { user: req.user });
  res.status(201).json(jobForViewer(job, req.user, { receiptId }));
});

// GET /api/receipts/:jobId/status
receiptsRouter.get("/:jobId/status", requireDatabase, validateObjectId("jobId"), async (req, res) => {
  const job = await ReceiptJob.findById(req.params.jobId);
  // Only the uploader (or Finance) may read a scan's extracted details.
  assertReceiptJobAccess(req.user, job);
  res.json(jobForViewer(job, req.user));
});

// GET /api/receipts/:jobId/file: the original file, for the uploader (or Finance).
receiptsRouter.get("/:jobId/file", requireDatabase, validateObjectId("jobId"), async (req, res) => {
  const job = await ReceiptJob.findById(req.params.jobId);
  assertReceiptJobAccess(req.user, job);
  if (!(await sendReceiptFile(job, res))) {
    throw new HttpError(404, "RECEIPT_FILE_NOT_FOUND", "The original receipt file is not available for this scan.");
  }
});
