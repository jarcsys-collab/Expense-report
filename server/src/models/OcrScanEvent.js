import mongoose from "mongoose";
import { toJSONOptions } from "./toJSON.js";

// What happened to one receipt upload, for the OCR dashboard. Append-only.
// Holds no receipt image and no receipt content (no merchant, amounts or text):
// only who, when, the outcome, timing and per-field confidence scores.
export const OCR_SCAN_OUTCOMES = [
  "success", // the provider read it
  "failed", // the provider was called and the scan failed
  "duplicate_retry", // same file, answered from a recent or running scan
  "duplicate_reused", // same file, reading reused from an earlier scan
  "skipped_unsupported", // refused before any provider call (file type)
];
// yes: the provider charged for it. no: not billed (or never called).
// unknown: the provider may have processed it (the request timed out on our side).
export const OCR_BILLABLE = ["yes", "no", "unknown"];

const ocrScanEventSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true, default: Date.now },
    outcome: { type: String, enum: OCR_SCAN_OUTCOMES, required: true },
    provider: { type: String, maxlength: 50 },
    employeeId: { type: String, maxlength: 100 },
    employeeName: { type: String, maxlength: 200 },
    department: { type: String, maxlength: 200, default: "" },
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: "ReceiptJob" },
    durationMs: { type: Number, min: 0 },
    pageCount: { type: Number, min: 0 },
    billable: { type: String, enum: OCR_BILLABLE, default: "no" },
    billableUnits: { type: Number, min: 0, default: 0 },
    // Estimate at the price configured when the scan happened, so a later price
    // change does not rewrite history. Null: no price is configured for the provider.
    estimatedCostUsd: { type: Number, min: 0, default: null },
    errorCode: { type: String, maxlength: 50 },
    // Per-field scores, as an array so they can be aggregated.
    confidence: { type: [new mongoose.Schema({ field: String, score: Number }, { _id: false })], default: undefined },
    missingFields: { type: [String], default: undefined },
  },
  { collection: "ocrScanEvents", versionKey: false, toJSON: toJSONOptions },
);

ocrScanEventSchema.index({ at: -1 });
ocrScanEventSchema.index({ employeeId: 1, at: -1 });
ocrScanEventSchema.index({ department: 1, at: -1 });
ocrScanEventSchema.index({ provider: 1, outcome: 1, at: -1 });

export const OcrScanEvent = mongoose.model("OcrScanEvent", ocrScanEventSchema);
