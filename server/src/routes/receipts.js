import { Router } from "express";
import { HttpError } from "../middleware/errorHandler.js";
import { receiptUpload } from "../middleware/receiptUpload.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { validateObjectId } from "../middleware/validate.js";
import { ReceiptJob } from "../models/ReceiptJob.js";
import { createReceiptJob, jobToResponse, processReceiptJob } from "../services/receiptProcessing.js";
import { ocrStatus } from "../services/veryfiService.js";

export const receiptsRouter = Router();

// Refuse before reading the upload when OCR cannot run.
function requireOcr(req, res, next) {
  const status = ocrStatus();
  if (status === "not_configured") {
    throw new HttpError(503, "OCR_NOT_CONFIGURED", "Receipt scanning is not configured yet. Create the expense manually with New expense.");
  }
  if (status === "auth_failed") {
    throw new HttpError(502, "OCR_AUTH_FAILED", "The OCR service rejected the configured credentials. Contact your administrator.");
  }
  next();
}

// POST /api/receipts/upload  (multipart/form-data, file in field "receipt")
// Creates a ReceiptJob, extracts the receipt with Veryfi, runs the anomaly
// check and returns the job with the extracted expense.
receiptsRouter.post("/upload", requireDatabase, requireOcr, receiptUpload, async (req, res) => {
  const receiptId = typeof req.body?.receiptId === "string" ? req.body.receiptId.slice(0, 100) : undefined;
  const job = await createReceiptJob(req.receiptFile, { uploadedBy: req.user?.id });
  await processReceiptJob(job, req.receiptFile);
  res.status(201).json(jobToResponse(job, { receiptId }));
});

// GET /api/receipts/:jobId/status
receiptsRouter.get("/:jobId/status", requireDatabase, validateObjectId("jobId"), async (req, res) => {
  const job = await ReceiptJob.findById(req.params.jobId);
  if (!job) throw new HttpError(404, "RECEIPT_JOB_NOT_FOUND", "Receipt job not found.");
  res.json(jobToResponse(job));
});
