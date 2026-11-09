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
import { NORMALIZER_VERSION } from "./documentAiNormalizer.js";
import { billabilityOfFailure, recordScanEvent } from "./ocrScanEvents.js";

const inFlightKeyFor = (uploadedBy, fileSha256) =>
  uploadedBy && fileSha256 ? `${uploadedBy}:${activeOcrProvider()}:${fileSha256}` : undefined;

function newJobFields(file, { uploadedBy, fileSha256 }) {
  return {
    originalFileName: file.originalname.slice(0, 255),
    mimeType: file.mimetype,
    size: file.size,
    uploadedBy,
    fileSha256,
    ocrProvider: activeOcrProvider(),
  };
}

export async function createReceiptJob(file, { uploadedBy, fileSha256 } = {}) {
  return ReceiptJob.create({
    ...newJobFields(file, { uploadedBy, fileSha256 }),
    status: "processing",
    inFlightKey: inFlightKeyFor(uploadedBy, fileSha256),
  });
}

/**
 * Creates the job that will call the provider, or returns the job already reading
 * this file. The unique inFlightKey index decides between concurrent uploads, so
 * only one of them can ever reach the billable provider.
 * @returns {Promise<{ job: object, existing: boolean }>}
 */
export async function claimReceiptJob(file, identity) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { job: await createReceiptJob(file, identity), existing: false };
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    const key = inFlightKeyFor(identity.uploadedBy, identity.fileSha256);
    const holder = await ReceiptJob.findOne({ inFlightKey: key });
    if (holder && Date.now() - holder.createdAt.getTime() <= inFlightMs()) return { job: holder, existing: true };
    // The server stopped while reading it: release the claim and try once more.
    if (holder) {
      await ReceiptJob.updateOne(
        { _id: holder._id, inFlightKey: key },
        {
          $unset: { inFlightKey: 1 },
          $set: { status: "failed", errorCode: "OCR_INTERRUPTED", errorMessage: "Receipt processing was interrupted. Please retry." },
        },
      );
    }
  }
  throw new HttpError(503, "OCR_BUSY", "This receipt is already being read. Please retry in a moment.");
}

/** Releases a claim when the scan could not start (e.g. the file could not be stored). */
export async function abandonReceiptJob(job) {
  job.status = "failed";
  job.errorCode = "OCR_PROCESSING_FAILED";
  job.errorMessage = "Receipt processing failed. Please retry.";
  job.inFlightKey = undefined;
  await job.save().catch(() => {});
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

/**
 * An earlier successful scan of this file by the SAME account, to answer without a
 * new OCR request. Never looks across accounts. Only readings made by the current
 * provider and the current field mapping are reused.
 */
export async function findPriorScan({ uploadedBy, fileSha256 }) {
  const days = env.ocrReusePriorScanDays;
  if (!uploadedBy || !fileSha256 || !days) return null;
  return ReceiptJob.findOne({
    uploadedBy,
    fileSha256,
    ocrProvider: activeOcrProvider(),
    status: { $in: ["ready", "needs_review"] },
    result: { $type: "object" },
    "ocrMeta.normalizerVersion": activeOcrProvider() === "google_document_ai" ? NORMALIZER_VERSION : { $exists: false },
    createdAt: { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
  }).sort({ createdAt: -1 });
}

/**
 * A new scan record from an earlier reading: no provider call. It stays a scan of
 * its own, so a second expense goes through the normal duplicate-claim check. The
 * stored file is shared only with a scan linked to an expense (those files are never
 * cleaned up); otherwise this upload stores its own copy.
 */
export async function createJobFromPriorScan(prior, file, { uploadedBy, fileSha256 }, storeFile) {
  const report = await runAnomalyCheck({
    expense: prior.result,
    stage: "extraction",
    ocr: prior.ocrMeta,
    ocrResult: prior.result,
    receiptUploaded: true,
    ownerId: uploadedBy,
  });
  const job = new ReceiptJob({
    ...newJobFields(file, { uploadedBy, fileSha256 }),
    status: report.needsReview ? "needs_review" : "ready",
    reusedFromJobId: prior._id,
    providerJobId: prior.providerJobId,
    result: prior.result,
    ocrMeta: prior.ocrMeta,
    audit: prior.audit,
    anomalyReport: report,
  });
  const priorLinked = prior.fileId && (prior.expenseId || (await Expense.exists({ receiptJobId: prior._id })));
  job.fileId = priorLinked ? prior.fileId : await storeFile(job, file);
  await job.save();
  return job;
}

export async function processReceiptJob(job, file, { user } = {}) {
  const started = Date.now();
  let responded = false;
  try {
    const categories = (await Category.find().select("name").lean()).map((c) => c.name);
    const { expense, ocrMeta, audit } = await readReceipt(file, {
      fileName: job.originalFileName,
      categories,
      requestId: String(job._id),
      dateOrder: env.receiptDateOrder,
    });
    responded = true;
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
    job.inFlightKey = undefined;
    await job.save();
    await recordScanEvent(
      {
        outcome: "success",
        provider: ocrMeta.provider ?? job.ocrProvider,
        jobId: job._id,
        durationMs: Date.now() - started,
        pageCount: ocrMeta.pageCount,
        billable: "yes",
        ocrMeta,
      },
      user,
    );
    return job;
  } catch (error) {
    job.status = "failed";
    job.errorCode = error instanceof HttpError ? error.code : "OCR_PROCESSING_FAILED";
    job.errorMessage = error instanceof HttpError ? error.message : "Receipt processing failed. Please retry.";
    job.inFlightKey = undefined;
    await job.save().catch(() => {});
    // An unreadable document is still a successful (billed) provider response.
    await recordScanEvent(
      {
        outcome: "failed",
        provider: job.ocrProvider,
        jobId: job._id,
        durationMs: Date.now() - started,
        errorCode: job.errorCode,
        billable: billabilityOfFailure(job.errorCode, responded || job.errorCode === "OCR_UNREADABLE"),
      },
      user,
    );
    throw error instanceof HttpError ? error : new HttpError(500, "OCR_PROCESSING_FAILED", "Receipt processing failed. Please retry.");
  }
}

// Response shape the frontend's OCR handling expects (normalizeOcrResult):
// { jobId, status, error?, expense? } with expense in the frontend field names.
// Notes shown with the extracted details: an earlier scan of this exact file by the
// same account, and figures OCR could not read with certainty.
function scanNotes(job, duplicateUpload) {
  const notes = [];
  if (duplicateUpload?.reused) {
    notes.push("You scanned this exact file before, so the earlier reading was used (no new OCR request). Check that this is not a duplicate claim.");
  }
  for (const flag of job.ocrMeta?.flags ?? []) {
    if (/^receipt_number_/.test(flag?.code ?? "")) notes.push(flag.message);
  }
  return notes;
}

export function jobToResponse(job, { receiptId, duplicateUpload } = {}) {
  const body = {
    jobId: String(job._id),
    status: job.status,
    originalFileName: job.originalFileName,
    mimeType: job.mimeType,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(receiptId ? { receiptId } : {}),
    ...(duplicateUpload ? { duplicateUpload } : {}),
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
            extractionNotes: [...scanNotes(job, duplicateUpload), ...reportToNotes(report)],
          }
        : {}),
    };
  }
  return body;
}
