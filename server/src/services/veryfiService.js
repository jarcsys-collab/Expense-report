// Veryfi OCR through the official Node SDK (@veryfi/veryfi-sdk, API v8,
// POST /api/v8/partner/documents/). Backend only.
//
// Errors are converted to safe codes; Veryfi's raw error bodies are only
// logged after secret redaction and never returned to clients.
import Client from "@veryfi/veryfi-sdk";
import { env, redactSecrets } from "../config/env.js";
import { HttpError } from "../middleware/errorHandler.js";
import { createCircuit, logOcrFailure, ocrError } from "./ocrErrors.js";

let client;
// After Veryfi rejects the credentials or the account, stop calling it until an
// administrator fixes it and restarts the service (no repeated failing or billable requests).
const circuit = createCircuit();

export function ocrStatus() {
  if (!env.veryfi.configured) return "not_configured";
  return circuit.status() ?? "configured";
}

/** Error for a request that must not reach Veryfi right now, or null. */
export function blockedError() {
  if (!env.veryfi.configured) return ocrError.notConfigured();
  return circuit.error();
}

function getClient() {
  if (!client) {
    const { clientId, clientSecret, username, apiKey, baseUrl, timeoutSeconds } = env.veryfi;
    client = new Client(clientId, clientSecret, username, apiKey, baseUrl, timeoutSeconds);
  }
  return client;
}

export function toSafeError(error, { requestId } = {}) {
  const text = String(error?.message ?? "");
  const match = text.match(/^Error: (\d{3}) ([\s\S]*)$/);
  const status = match ? Number(match[1]) : undefined;
  let providerMessage = "";
  if (match) {
    try {
      const body = JSON.parse(match[2]);
      providerMessage = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "";
    } catch {}
  }
  logOcrFailure({
    provider: "veryfi",
    requestId,
    code: status ?? error?.name ?? "error",
    detail: redactSecrets(providerMessage || text).slice(0, 300),
  });

  if (status === 401 || status === 403) {
    // Veryfi answers 403 when the trial or plan has ended, with valid credentials.
    if (/trial|upgrade|plan|billing|subscription|suspend/i.test(providerMessage)) return ocrError.accountInactive();
    return ocrError.authFailed();
  }
  if (status === 429) return ocrError.rateLimited();
  if (status === 400 || status === 413 || status === 415 || status === 422) return ocrError.documentRejected();
  if (/timed out/i.test(text)) return ocrError.timeout();
  return ocrError.unavailable();
}

/**
 * Sends one receipt to Veryfi and returns the raw extraction.
 * @param {Buffer} buffer file contents
 * @param {string} fileName original file name (Veryfi uses the extension)
 * @param {{ categories?: string[], requestId?: string }} options categories Veryfi may choose from
 */
export async function extractReceipt(buffer, fileName, { categories, requestId } = {}) {
  const blocked = blockedError();
  if (blocked) throw blocked;
  try {
    const document = await getClient().process_document_from_base64(
      buffer.toString("base64"),
      fileName,
      categories?.length ? categories : null,
      false,
      // Per-field confidence scores; used to mark fields that need review.
      { confidence_details: true },
    );
    return document;
  } catch (error) {
    const safe = error instanceof HttpError ? error : toSafeError(error, { requestId });
    circuit.record(safe);
    throw safe;
  }
}
