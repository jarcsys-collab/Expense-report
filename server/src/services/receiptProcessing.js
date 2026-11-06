// Receipt pipeline: OCR extraction (OCR_PROVIDER) → normalization → anomaly check → ReceiptJob.
// V1 runs inside the upload request. processReceiptJob only needs the job and
// the file, so it can move to a background worker later; the frontend already
// polls GET /receipts/:jobId/status while a job is "processing".
import { Category } from "../models/Category.js";
import { ReceiptJob } from "../models/ReceiptJob.js";
import { HttpError } from "../middleware/errorHandler.js";
import { reportToNotes, reportToViolations, runAnomalyCheck } from "./anomaly/anomalyEngine.js";
import { Expense } from "../models/Expense.js";
import { activeOcrProvider, readReceipt } from "./ocrProvider.js";
import { env } from "../config/env.js";

export async function createReceiptJob(file, { uploadedBy, fileSha256 } = {}) {
  return ReceiptJob.create({
    status: "processing",
    originalFileName: file.originalname.slice(0, 255),
    mimeType: file.mimetype,
    size: file.size,
    uploadedBy,
    fileSha256,
    ocrProvider: activeOcrProvider(),
  });
}

// How long an identical upload is answered from an existing job instead of a new
// (billable) OCR request: a job still being read, or a finished one that no
// expense uses yet (double-click, lost response, Retry after a network error).
const inFlightMs = () => (Math.max(env.veryfi.timeoutSeconds, env.googleDocumentAi.timeoutSeconds) + 30) * 1000;
const REUSE_FINISHED_MS = 15 * 60 * 1000;

/** Existing job for the same file from the same account that can be reused, or null. */
export async function findReusableReceiptJob({ uploadedBy, fileSha256 }) {
  if (!uploadedBy || !fileSha256) return null;
  const now = Date.now();
  const job = await ReceiptJob.findOne({
    uploadedBy,
    fileSha256,
    ocrProvider: activeOcrProvider(),
    status: { $in: ["processing", "ready", "needs_review"] },
    createdAt: { $gte: new Date(now - Math.max(inFlightMs(), REUSE_FINISHED_MS)) },
  }).sort({ createdAt: -1 });
  if (!job) return null;
  if (job.status === "processing") return now - job.createdAt.getTime() <= inFlightMs() ? job : null;
  // A scan already linked to an expense is not reused: a second expense gets its
  // own scan, and the duplicate-claim check compares the two expenses.
  const linked = job.expenseId || (await Expense.exists({ receiptJobId: job._id }));
  return linked ? null : job;
}

export async function processReceiptJob(job, file) {
  try {
    const categories = (await Category.find().select("name").lean()).map((c) => c.name);
    const { expense, ocrMeta, audit } = await readReceipt(file, {
      fileName: job.originalFileName,
      categories,
      requestId: String(job._id),
      dateOrder: env.receiptDateOrder,
    });
    const report = await runAnomalyCheck({
      expense,
      stage: "extraction",
      ocr: ocrMeta,
      ocrResult: expense,
      receiptUploaded: true,
      ownerId: job.uploadedBy,
    });

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
