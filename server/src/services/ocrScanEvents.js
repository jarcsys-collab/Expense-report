// Records what happened to each receipt upload for the OCR dashboard, and estimates
// its cost. Estimates only: they are not Google Cloud billing data.
//
// Billing rule (Google Document AI pricing page, confirmed 2026-11-09):
//   Expense Parser USD 0.10 per "count"; 1 count = up to 10 pages of a document.
//   "You are not billed for failed requests (4xx or 5xx response codes)."
// A request that timed out on our side may still have been processed by Google, so
// it counts as "unknown": left out of the estimate and shown separately.
//
// Recording can never break a scan: every failure here is only logged.
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { OcrScanEvent } from "../models/OcrScanEvent.js";

/** Whether a failed scan was billed. `responded`: the provider did return a result. */
export function billabilityOfFailure(errorCode, responded) {
  if (responded) return "yes";
  return errorCode === "OCR_TIMEOUT" ? "unknown" : "no";
}

/** @returns {{ units: number, costUsd: number|null }} costUsd null: no price configured. */
export function estimateOcrCost({ provider, pageCount, pricing = env.ocrCost }) {
  if (provider === "google_document_ai") {
    const pages = Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 1;
    const units = Math.ceil(pages / pricing.googlePagesPerUnit);
    return { units, costUsd: Math.round(units * pricing.googleUsdPerUnit * 1e6) / 1e6 };
  }
  if (provider === "veryfi") {
    return { units: 1, costUsd: pricing.veryfiUsdPerDocument > 0 ? pricing.veryfiUsdPerDocument : null };
  }
  return { units: 1, costUsd: null };
}

/**
 * @param {object} event outcome, provider, jobId, durationMs, pageCount, errorCode, billable, ocrMeta
 * @param {object} [user] the signed-in user (req.user)
 */
export async function recordScanEvent({ outcome, provider, jobId, durationMs, pageCount, errorCode, billable = "no", ocrMeta }, user) {
  try {
    if (mongoose.connection.readyState !== 1) return;
    const { units, costUsd } = billable === "yes" ? estimateOcrCost({ provider, pageCount }) : { units: 0, costUsd: 0 };
    const scores = Object.entries(ocrMeta?.confidence ?? {})
      .filter(([, score]) => typeof score === "number")
      .map(([field, score]) => ({ field, score }));
    await OcrScanEvent.create({
      outcome,
      provider,
      jobId,
      durationMs,
      pageCount,
      errorCode,
      billable,
      billableUnits: units,
      estimatedCostUsd: costUsd,
      employeeId: user?.id,
      employeeName: user?.name,
      department: user?.department || "",
      ...(scores.length ? { confidence: scores } : {}),
      ...(ocrMeta?.missingFields?.length ? { missingFields: ocrMeta.missingFields } : {}),
    });
  } catch (error) {
    console.error(`[ocr-analytics] event not recorded: ${error.name}`);
  }
}
