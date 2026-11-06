// Chooses the OCR provider from OCR_PROVIDER (veryfi | google_document_ai).
// Both return the same normalized { expense, ocrMeta, audit }, so the rest of
// the receipt pipeline does not depend on the provider.
import { env } from "../config/env.js";
import { isEmptyDocument, normalizeDocumentAiDocument } from "./documentAiNormalizer.js";
import * as google from "./googleDocumentAiService.js";
import { ocrError } from "./ocrErrors.js";
import { normalizeVeryfiDocument } from "./receiptNormalizer.js";
import * as veryfi from "./veryfiService.js";

const isGoogle = () => env.ocrProvider === "google_document_ai";

export const activeOcrProvider = () => env.ocrProvider;

/** configured | not_configured | auth_failed | account_inactive | misconfigured */
export const ocrStatus = () => (isGoogle() ? google.ocrStatus() : veryfi.ocrStatus());

/** Error to return before reading an upload when OCR cannot run, or null. */
export const ocrBlockedError = () => (isGoogle() ? google.blockedError() : veryfi.blockedError());

/** Throws a 415 for file types the active provider cannot read. */
export function assertOcrSupportsFile(mimeType) {
  if (isGoogle()) google.assertSupportedFile(mimeType);
}

/**
 * Reads one receipt with the active provider.
 * @param {{ buffer: Buffer, mimetype: string }} file
 * @param {{ fileName: string, categories?: string[], requestId?: string, dateOrder?: string, maxAttempts?: number }} options
 */
export async function readReceipt(file, { fileName, categories, requestId, dateOrder = env.receiptDateOrder, maxAttempts }) {
  if (isGoogle()) {
    const document = await google.extractReceipt(file.buffer, file.mimetype, { requestId, maxAttempts });
    if (isEmptyDocument(document)) throw ocrError.unreadable();
    return normalizeDocumentAiDocument(document, { dateOrder });
  }
  const document = await veryfi.extractReceipt(file.buffer, fileName, { categories, requestId });
  return normalizeVeryfiDocument(document, { dateOrder });
}
