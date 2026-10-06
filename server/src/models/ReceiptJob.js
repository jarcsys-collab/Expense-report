import mongoose from "mongoose";
import { RECEIPT_JOB_STATUSES } from "./constants.js";
import { toJSONOptions } from "./toJSON.js";

// One OCR run for an uploaded receipt. Filled in once Veryfi is connected.
const receiptJobSchema = new mongoose.Schema(
  {
    status: { type: String, enum: RECEIPT_JOB_STATUSES, default: "queued", index: true },
    originalFileName: { type: String, trim: true, maxlength: 255, required: true },
    mimeType: { type: String, trim: true, maxlength: 100, required: true },
    size: { type: Number, min: 0 },
    // Optional link to the expense created from this receipt.
    expenseId: { type: mongoose.Schema.Types.ObjectId, ref: "Expense" },
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

export const ReceiptJob = mongoose.model("ReceiptJob", receiptJobSchema);
