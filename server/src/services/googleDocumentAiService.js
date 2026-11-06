// Google Cloud Document AI (Expense Parser) through the official Node client
// (@google-cloud/documentai, v1 processDocument). Backend only.
//
// Authentication: a service-account key held in memory (from the sealed
// GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON variable in production, or the file named
// by GOOGLE_APPLICATION_CREDENTIALS locally). The key is never logged.
// Provider error text is logged only after redaction and never returned.
import documentai from "@google-cloud/documentai";
import { JWT } from "google-auth-library";
import { env, redactSecrets } from "../config/env.js";
import { HttpError } from "../middleware/errorHandler.js";
import { createCircuit, logOcrFailure, ocrError } from "./ocrErrors.js";

const PROVIDER = "google_document_ai";
// Document AI online processing accepts these; HEIC/HEIF is not supported.
export const SUPPORTED_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif", "image/tiff", "image/bmp"];

// gRPC status codes (https://grpc.github.io/grpc/core/md_doc_statuscodes.html).
const CODE = {
  CANCELLED: 1, UNKNOWN: 2, INVALID_ARGUMENT: 3, DEADLINE_EXCEEDED: 4, NOT_FOUND: 5, PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8, FAILED_PRECONDITION: 9, ABORTED: 10, INTERNAL: 13, UNAVAILABLE: 14, UNAUTHENTICATED: 16,
};
const CODE_NAME = Object.fromEntries(Object.entries(CODE).map(([name, value]) => [value, name]));
// Retried (bounded): the request never reached a working processor.
const TRANSIENT = new Set([CODE.UNAVAILABLE, CODE.INTERNAL, CODE.ABORTED, CODE.UNKNOWN]);
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1500];

const circuit = createCircuit();
let client;
// Test hook: inject a fake client / sleep instead of calling Google.
let clientFactory = createDocumentAiClient;
let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDocumentAiClient(config) {
  // An explicit service-account JWT client (Google's recommended form for
  // externally supplied keys); the key stays in memory only.
  const authClient = new JWT({
    email: config.credentials.client_email,
    key: config.credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return new documentai.v1.DocumentProcessorServiceClient({
    apiEndpoint: `${config.location}-documentai.googleapis.com`,
    projectId: config.projectId,
    authClient,
  });
}

export function __setTestHooks({ factory, sleepFn } = {}) {
  clientFactory = factory ?? createDocumentAiClient;
  sleep = sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  client = undefined;
  circuit.reset();
}

export function processorName(config = env.googleDocumentAi) {
  const base = `projects/${config.projectId}/locations/${config.location}/processors/${config.processorId}`;
  return config.processorVersion ? `${base}/processorVersions/${config.processorVersion}` : base;
}

export function ocrStatus() {
  if (!env.googleDocumentAi.configured) return "not_configured";
  return circuit.status() ?? "configured";
}

/** Error for a request that must not reach Google right now, or null. */
export function blockedError() {
  if (!env.googleDocumentAi.configured) return ocrError.notConfigured();
  return circuit.error();
}

/** Rejects file types Document AI cannot read, before a job is created. */
export function assertSupportedFile(mimeType) {
  if (SUPPORTED_MIME_TYPES.includes(mimeType)) return;
  if (/hei[cf]/.test(mimeType)) {
    throw ocrError.unsupportedFile(
      "HEIC photos can't be scanned yet. Use Edit on the photo (it saves as JPG), take a screenshot, or set your camera to \"Most Compatible\".",
    );
  }
  throw ocrError.unsupportedFile("This file type can't be scanned. Use JPG, PNG, WEBP or PDF.");
}

function describe(error) {
  // Messages and details, without metadata (which can carry request headers).
  const parts = [error?.message, error?.details, error?.reason, error?.response?.data?.error_description, error?.response?.data?.error];
  return parts.filter((part) => typeof part === "string" && part).join(" | ");
}

/** Maps a Google client error to a safe HttpError. Exported for tests. */
export function toSafeError(error) {
  const code = typeof error?.code === "number" ? error.code : undefined;
  const text = describe(error);
  const billing = /billing/i.test(text);
  const apiDisabled = /SERVICE_DISABLED|has not been used in project|is disabled|API not enabled/i.test(text);
  // Key problems surface from google-auth-library before any RPC is sent.
  const badKey = /invalid_grant|invalid_client|Invalid JWT|account not found|DECODER routines|PEM|private key|unsupported key/i.test(text);

  if (code === CODE.UNAUTHENTICATED || (code === undefined && badKey)) return ocrError.authFailed();
  if (code === CODE.PERMISSION_DENIED) return billing || apiDisabled ? ocrError.accountInactive() : ocrError.authFailed();
  if (code === CODE.FAILED_PRECONDITION) return billing || apiDisabled ? ocrError.accountInactive() : ocrError.misconfigured();
  if (code === CODE.NOT_FOUND) return ocrError.misconfigured();
  if (code === CODE.RESOURCE_EXHAUSTED) return ocrError.rateLimited();
  if (code === CODE.DEADLINE_EXCEEDED || /timeout|timed out|ETIMEDOUT/i.test(text)) return ocrError.timeout();
  if (code === CODE.INVALID_ARGUMENT) {
    // A wrong processor name or location is configuration, not the receipt.
    if (/processor|location|resource name|projects\//i.test(text)) return ocrError.misconfigured();
    return ocrError.documentRejected();
  }
  return ocrError.unavailable();
}

/**
 * Sends one receipt to the Expense Parser and returns the Document AI document.
 * @param {Buffer} buffer file contents
 * @param {string} mimeType validated upload type
 * @param {{ requestId?: string, maxAttempts?: number }} options requestId is logged with
 *   failures; maxAttempts (1-3) caps attempts, e.g. 1 for a single billable test request
 */
export async function extractReceipt(buffer, mimeType, { requestId, maxAttempts = MAX_ATTEMPTS } = {}) {
  const attemptsAllowed = Math.min(Math.max(1, Math.trunc(maxAttempts) || 1), MAX_ATTEMPTS);
  const blocked = blockedError();
  if (blocked) throw blocked;
  assertSupportedFile(mimeType);
  client ??= clientFactory(env.googleDocumentAi);

  const name = processorName();
  // One overall deadline for every attempt, so retries never exceed it.
  const deadline = Date.now() + env.googleDocumentAi.timeoutSeconds * 1000;
  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    const remaining = deadline - started;
    if (remaining < 1000) {
      const safe = ocrError.timeout();
      logOcrFailure({ provider: PROVIDER, requestId, code: "DEADLINE", attempt, detail: "overall deadline reached before retry" });
      throw safe;
    }
    try {
      const [result] = await client.processDocument(
        { name, rawDocument: { content: buffer, mimeType }, skipHumanReview: true },
        // The client's own retries are off; this loop retries transient errors only.
        { timeout: remaining, maxRetries: 0 },
      );
      return result?.document ?? {};
    } catch (error) {
      const code = typeof error?.code === "number" ? error.code : undefined;
      logOcrFailure({
        provider: PROVIDER,
        requestId,
        code: CODE_NAME[code] ?? code ?? error?.name ?? "error",
        attempt,
        durationMs: Date.now() - started,
        detail: redactSecrets(describe(error)).slice(0, 300),
      });
      if (TRANSIENT.has(code) && attempt < attemptsAllowed) {
        await sleep(BACKOFF_MS[attempt - 1] ?? 1500);
        continue;
      }
      const safe = error instanceof HttpError ? error : toSafeError(error);
      circuit.record(safe);
      throw safe;
    }
  }
}
