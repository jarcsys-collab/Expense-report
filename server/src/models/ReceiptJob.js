import mongoose from "mongoose";
import { RECEIPT_JOB_STATUSES } from "./constants.js";
import { toJSONOptions } from "./toJSON.js";

// One OCR run for an uploaded receipt.
const receiptJobSchema = new mongoose.Schema(
  {
    status: { type: String, enum: RECEIPT_JOB_STATUSES, default: "queued", index: true },
    originalFileName: { type: String, trim: true, maxlength: 255, required: true },
    mimeType: { type: String, trim: true, maxlength: 100, required: true },
    size: { type: Number, min: 0 },
    // Optional link to the expense created from this receipt.
    expenseId: { type: mongoose.Schema.Types.ObjectId, ref: "Expense" },
    // OCR provider that read it (veryfi | google_document_ai); absent on older jobs.
    ocrProvider: { type: String, maxlength: 50 },
    // SHA-256 of the uploaded file, so an identical re-upload is answered from the
    // existing job instead of a second OCR request. Absent on older jobs.
    fileSha256: { type: String, maxlength: 64 },
    // Set only while OCR is running: account + provider + file hash, unique, so two
    // concurrent uploads of one file can never both reach the (billable) provider.
    // Absent on finished and older jobs, so the index builds on existing data.
    inFlightKey: { type: String, maxlength: 250 },
    // This job reuses the reading of an earlier scan by the same account: no OCR
    // request was made for it. fileId may then point at that scan's stored file.
    reusedFromJobId: { type: mongoose.Schema.Types.ObjectId, ref: "ReceiptJob" },
    // The original file in GridFS (bucket receiptFiles); absent on older jobs.
    fileId: { type: mongoose.Schema.Types.ObjectId },
    // Abandoned-upload cleanup (services/receiptCleanup.js): when the stored file
    // was removed, and a short-lived claim so two runs never act on one scan.
    fileDeletedAt: { type: Date },
    cleanupClaimedAt: { type: Date },
    // Provider job/document id (e.g. Veryfi document id).
    providerJobId: { type: String, maxlength: 200 },
    errorMessage: { type: String, maxlength: 1000 },
    errorCode: { type: String, maxlength: 50 },
    uploadedBy: { type: String, maxlength: 100 },
    // Extracted fields in the frontend's expense shape (merchant, amount, lineItems, ...).
    result: { type: mongoose.Schema.Types.Mixed },
    // Confidence summary and provider signals used by the anomaly rules.
    ocrMeta: { type: mongoose.Schema.Types.Mixed },
    // Trimmed provider response for debugging/audit (no image URLs).
    audit: { type: mongoose.Schema.Types.Mixed },
    // Anomaly check at the extraction stage (services/anomaly).
    anomalyReport: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true, collection: "receiptJobs", toJSON: toJSONOptions },
);
// Finds an identical recent upload (receipts route). Additive; existing jobs are unchanged.
receiptJobSchema.index({ uploadedBy: 1, fileSha256: 1, createdAt: -1 });
receiptJobSchema.index({ inFlightKey: 1 }, { unique: true, partialFilterExpression: { inFlightKey: { $type: "string" } } });
receiptJobSchema.index({ fileId: 1 }, { partialFilterExpression: { fileId: { $type: "objectId" } } });

export const ReceiptJob = mongoose.model("ReceiptJob", receiptJobSchema);
