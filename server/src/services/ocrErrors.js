// Safe, provider-neutral OCR errors shown to employees, plus a pause after
// failures only an administrator can fix (credentials, billing, configuration).
// Provider error bodies are logged only after redaction and never returned.
import { HttpError } from "../middleware/errorHandler.js";

export const ocrError = {
  notConfigured: () =>
    new HttpError(503, "OCR_NOT_CONFIGURED", "Receipt scanning is not configured yet. Create the expense manually with New expense."),
  authFailed: () =>
    new HttpError(502, "OCR_AUTH_FAILED", "The OCR service rejected the configured credentials. Contact your administrator."),
  accountInactive: () =>
    new HttpError(
      502,
      "OCR_ACCOUNT_INACTIVE",
      "The OCR service account needs attention (billing, plan or API access). Contact your administrator. You can still create the expense manually.",
    ),
  misconfigured: () =>
    new HttpError(502, "OCR_MISCONFIGURED", "Receipt scanning is misconfigured on the server. Contact your administrator."),
  rateLimited: () => new HttpError(503, "OCR_RATE_LIMITED", "The OCR service is busy. Please retry in a minute."),
  timeout: () => new HttpError(504, "OCR_TIMEOUT", "Receipt scanning took too long. Please retry."),
  unavailable: () => new HttpError(503, "OCR_UNAVAILABLE", "The OCR service is temporarily unavailable. Please retry shortly."),
  documentRejected: () =>
    new HttpError(422, "OCR_DOCUMENT_REJECTED", "The OCR service could not read this file. Upload a clearer photo or a PDF."),
  unreadable: () =>
    new HttpError(422, "OCR_UNREADABLE", "No receipt text could be read. Upload a clearer, well-lit photo of the whole receipt."),
  unsupportedFile: (message) => new HttpError(415, "OCR_UNSUPPORTED_FILE", message),
};

// Permanent problems only an administrator can fix (credentials, permissions,
// billing/API access, processor or region). Transient errors never block.
const BLOCKING = { OCR_AUTH_FAILED: "auth_failed", OCR_ACCOUNT_INACTIVE: "account_inactive", OCR_MISCONFIGURED: "misconfigured" };

/**
 * One per provider. After a permanent failure, every request fails fast with
 * the administrator message and the provider is not called again (no repeated
 * failing or billable requests) until an administrator fixes the cause and
 * restarts the service (changing Railway variables redeploys it). There is no
 * automatic retry. /api/health shows the blocked status meanwhile.
 */
export function createCircuit() {
  let blockedCode = null;
  return {
    record(error) {
      if (!blockedCode && error instanceof HttpError && BLOCKING[error.code]) blockedCode = error.code;
    },
    /** @returns {string|null} status name while blocked */
    status() {
      return blockedCode ? BLOCKING[blockedCode] : null;
    },
    error() {
      if (!blockedCode) return null;
      return blockedCode === "OCR_AUTH_FAILED" ? ocrError.authFailed() : blockedCode === "OCR_ACCOUNT_INACTIVE" ? ocrError.accountInactive() : ocrError.misconfigured();
    },
    /** Test hook only: forget a recorded failure. */
    reset() {
      blockedCode = null;
    },
  };
}

export function logOcrFailure({ provider, requestId, code, attempt, durationMs, detail }) {
  console.error(
    `[ocr] ${new Date().toISOString()} provider=${provider} requestId=${requestId ?? "-"} code=${code}` +
      `${attempt ? ` attempt=${attempt}` : ""}${durationMs !== undefined ? ` durationMs=${durationMs}` : ""} ${detail ?? ""}`.trimEnd(),
  );
}
