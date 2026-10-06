// Receipt pipeline: Veryfi extraction → normalization → anomaly check → ReceiptJob.
// V1 runs inside the upload request. processReceiptJob only needs the job and
// the file, so it can move to a background worker later; the frontend already
// polls GET /receipts/:jobId/status while a job is "processing".
import { Category } from "../models/Category.js";
import { ReceiptJob } from "../models/ReceiptJob.js";
import { HttpError } from "../middleware/errorHandler.js";
import { reportToNotes, reportToViolations, runAnomalyCheck } from "./anomaly/anomalyEngine.js";
import { normalizeVeryfiDocument } from "./receiptNormalizer.js";
import { extractReceipt } from "./veryfiService.js";
import { env } from "../config/env.js";

export async function createReceiptJob(file, { uploadedBy } = {}) {
  return ReceiptJob.create({
    status: "processing",
    originalFileName: file.originalname.slice(0, 255),
    mimeType: file.mimetype,
    size: file.size,
    uploadedBy,
  });
}

export async function processReceiptJob(job, file) {
  try {
    const categories = (await Category.find().select("name").lean()).map((c) => c.name);
    const document = await extractReceipt(file.buffer, job.originalFileName, { categories });
    const { expense, ocrMeta, audit } = normalizeVeryfiDocument(document, { dateOrder: env.receiptDateOrder });
    const report = await runAnomalyCheck({ expense, stage: "extraction", ocr: ocrMeta, receiptUploaded: true });

    job.result = expense;
    job.ocrMeta = ocrMeta;
    job.audit = audit;
    job.providerJobId = ocrMeta.providerDocumentId;
    job.anomalyReport = report;
    job.status = report.needsReview ? "needs_review" : "ready";
    job.errorMessage = undefined;
    await job.save();
    return job;
  } catch (error) {
    job.status = "failed";
    job.errorCode = error instanceof HttpError ? error.code : "OCR_PROCESSING_FAILED";
    job.errorMessage = error instanceof HttpError ? error.message : "Receipt processing failed. Please retry.";
    await job.save().catch(() => {});
    throw error instanceof HttpError ? error : new HttpError(500, "OCR_PROCESSING_FAILED", "Receipt processing failed. Please retry.");
  }
}

// Response shape the frontend's OCR handling expects (normalizeOcrResult):
// { jobId, status, error?, expense? } with expense in the frontend field names.
export function jobToResponse(job, { receiptId } = {}) {
  const body = {
    jobId: String(job._id),
    status: job.status,
    originalFileName: job.originalFileName,
    mimeType: job.mimeType,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(receiptId ? { receiptId } : {}),
  };
  if (job.status === "processing" || job.status === "queued" || job.status === "pending") {
    body.message = "Reading receipt…";
  }
  if (job.status === "failed") body.error = job.errorMessage || "OCR processing failed.";
  if (["ready", "needs_review"].includes(job.status) && job.result && typeof job.result === "object") {
    const { status, jobId, id, _id, ...fields } = job.result;
    const report = job.anomalyReport;
    body.expense = {
      ...fields,
      receiptJobId: String(job._id),
      ...(report
        ? {
            anomalyReport: report,
            policyViolations: reportToViolations(report),
            possibleDuplicates: report.possibleDuplicates ?? [],
            extractionNotes: reportToNotes(report),
          }
        : {}),
    };
  }
  return body;
}
