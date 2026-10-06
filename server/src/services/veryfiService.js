// Veryfi OCR through the official Node SDK (@veryfi/veryfi-sdk, API v8,
// POST /api/v8/partner/documents/). Backend only.
//
// Errors are converted to safe codes; Veryfi's raw error bodies are only
// logged after secret redaction and never returned to clients.
import Client from "@veryfi/veryfi-sdk";
import { env, redactSecrets } from "../config/env.js";
import { HttpError } from "../middleware/errorHandler.js";

let client;
// After Veryfi rejects the credentials, stop calling it until the server restarts
// (avoids repeated failing or billable requests).
let authFailed = false;

export function ocrStatus() {
  if (!env.veryfi.configured) return "not_configured";
  return authFailed ? "auth_failed" : "configured";
}

function getClient() {
  if (!client) {
    const { clientId, clientSecret, username, apiKey, baseUrl, timeoutSeconds } = env.veryfi;
    client = new Client(clientId, clientSecret, username, apiKey, baseUrl, timeoutSeconds);
  }
  return client;
}

function toSafeError(error) {
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
  console.error(`Veryfi request failed: ${status ?? error?.name ?? "error"} ${redactSecrets(providerMessage || text).slice(0, 300)}`);

  if (status === 401 || status === 403) {
    authFailed = true;
    return new HttpError(502, "OCR_AUTH_FAILED", "The OCR service rejected the configured credentials. Contact your administrator.");
  }
  if (status === 429) return new HttpError(503, "OCR_RATE_LIMITED", "The OCR service is busy. Please retry in a minute.");
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return new HttpError(422, "OCR_DOCUMENT_REJECTED", "The OCR service could not read this file. Upload a clearer photo or a PDF.");
  }
  if (/timed out/i.test(text)) return new HttpError(504, "OCR_TIMEOUT", "Receipt scanning took too long. Please retry.");
  return new HttpError(502, "OCR_UNAVAILABLE", "The OCR service is unavailable. Please retry shortly.");
}

/**
 * Sends one receipt to Veryfi and returns the raw extraction.
 * @param {Buffer} buffer file contents
 * @param {string} fileName original file name (Veryfi uses the extension)
 * @param {{ categories?: string[] }} options categories Veryfi may choose from
 */
export async function extractReceipt(buffer, fileName, { categories } = {}) {
  if (!env.veryfi.configured) {
    throw new HttpError(503, "OCR_NOT_CONFIGURED", "Receipt scanning is not configured yet. Create the expense manually with New expense.");
  }
  if (authFailed) {
    throw new HttpError(502, "OCR_AUTH_FAILED", "The OCR service rejected the configured credentials. Contact your administrator.");
  }
  try {
    return await getClient().process_document_from_base64(
      buffer.toString("base64"),
      fileName,
      categories?.length ? categories : null,
      false,
      // Per-field confidence scores; used to mark fields that need review.
      { confidence_details: true },
    );
  } catch (error) {
    throw toSafeError(error);
  }
}
