import { createHash } from "node:crypto";
import { Router } from "express";
import { receiptUpload } from "../middleware/receiptUpload.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { validateObjectId } from "../middleware/validate.js";
import { ReceiptJob } from "../models/ReceiptJob.js";
import { assertReceiptJobAccess } from "../services/expenseAccess.js";
import { assertOcrSupportsFile, ocrBlockedError } from "../services/ocrProvider.js";
import { createReceiptJob, findReusableReceiptJob, jobToResponse, processReceiptJob } from "../services/receiptProcessing.js";
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
  assertOcrSupportsFile(req.receiptFile.mimetype);
  const fileSha256 = createHash("sha256").update(req.receiptFile.buffer).digest("hex");
  const existing = await findReusableReceiptJob({ uploadedBy: req.user?.id, fileSha256 });
  if (existing) {
    res.status(existing.status === "processing" ? 202 : 200).json(jobForViewer(existing, req.user, { receiptId }));
    return;
  }
  const job = await createReceiptJob(req.receiptFile, { uploadedBy: req.user?.id, fileSha256 });
  // Keep the original so the employee can reopen it from My Requests.
  job.fileId = await storeReceiptFile(job, req.receiptFile);
  await job.save();
  await processReceiptJob(job, req.receiptFile);
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
