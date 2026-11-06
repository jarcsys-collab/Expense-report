import { SYNTHETIC_KEY } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { __setTestHooks, extractReceipt, ocrStatus, processorName, toSafeError } from "../src/services/googleDocumentAiService.js";
import { grpcError, sampleDocument } from "./fixtures/documentAi.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
let calls;
let configSeen;
let sleeps;

/** Fake Document AI client answering with the given responses (Error = thrown). */
function useResponses(...responses) {
  calls = [];
  sleeps = [];
  __setTestHooks({
    factory: (config) => {
      configSeen = config;
      return {
        processDocument: async (request, options) => {
          calls.push({ request, options });
          const next = responses.shift();
          if (next instanceof Error) throw next;
          return [next];
        },
      };
    },
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });
}

/** Runs fn with console.error captured. */
async function quietly(fn) {
  const original = console.error;
  const lines = [];
  console.error = (line) => lines.push(String(line));
  try {
    return { result: await fn(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    console.error = original;
  }
}

beforeEach(() => useResponses());

test("sends the receipt to the configured Expense Parser and returns the document", async () => {
  useResponses({ document: sampleDocument() });
  const document = await extractReceipt(JPEG, "image/jpeg", { requestId: "job-1" });
  assert.equal(document.entities.length, 14);
  assert.equal(calls.length, 1);
  const { request, options } = calls[0];
  assert.equal(request.name, "projects/receiptflow-ocr/locations/asia-southeast1/processors/f4d7fd3749cd9873");
  assert.equal(request.rawDocument.mimeType, "image/jpeg");
  assert.ok(Buffer.isBuffer(request.rawDocument.content));
  assert.equal(options.maxRetries, 0, "the client's own retries are disabled");
  assert.ok(options.timeout > 0 && options.timeout <= 60_000);
  assert.equal(configSeen.location, "asia-southeast1");
  assert.equal(processorName(), request.name);
});

test("authentication failure: admin error, then no further calls (circuit open)", async () => {
  useResponses(grpcError(16, "Request had invalid authentication credentials."));
  const first = await quietly(() => extractReceipt(JPEG, "image/jpeg", { requestId: "job-2" }));
  assert.equal(first.error.code, "OCR_AUTH_FAILED");
  assert.equal(first.error.status, 502);
  assert.match(first.lines[0], /provider=google_document_ai requestId=job-2 code=UNAUTHENTICATED attempt=1/);
  assert.equal(ocrStatus(), "auth_failed");
  const second = await quietly(() => extractReceipt(JPEG, "image/jpeg"));
  assert.equal(second.error.code, "OCR_AUTH_FAILED");
  assert.equal(calls.length, 1, "invalid credentials are not retried or re-sent");
});

test("billing disabled and API disabled are reported as an account problem, not retried", async () => {
  for (const details of [
    "This API method requires billing to be enabled. Please enable billing on project #123",
    "Cloud Document AI API has not been used in project 123 before or it is disabled.",
  ]) {
    useResponses(grpcError(7, details));
    const { error } = await quietly(() => extractReceipt(JPEG, "image/jpeg"));
    assert.equal(error.code, "OCR_ACCOUNT_INACTIVE");
    assert.equal(calls.length, 1);
    assert.equal(ocrStatus(), "account_inactive");
  }
});

test("missing IAM permission is an authorization failure", async () => {
  useResponses(grpcError(7, "Permission 'documentai.processors.processOnline' denied on resource"));
  const { error } = await quietly(() => extractReceipt(JPEG, "image/jpeg"));
  assert.equal(error.code, "OCR_AUTH_FAILED");
});

test("wrong processor or region is a configuration error", async () => {
  useResponses(grpcError(5, "Processor not found"));
  const { error } = await quietly(() => extractReceipt(JPEG, "image/jpeg"));
  assert.equal(error.code, "OCR_MISCONFIGURED");
  assert.equal(ocrStatus(), "misconfigured");
});

test("quota exhaustion: retry-later message, not retried, circuit stays closed", async () => {
  useResponses(grpcError(8, "Quota exceeded for quota metric 'Online process requests'"));
  const { error } = await quietly(() => extractReceipt(JPEG, "image/jpeg"));
  assert.equal(error.code, "OCR_RATE_LIMITED");
  assert.equal(error.status, 503);
  assert.equal(calls.length, 1);
  assert.equal(ocrStatus(), "configured");
});

test("timeout: safe retry message, not retried automatically", async () => {
  useResponses(grpcError(4, "Deadline exceeded"));
  const { error } = await quietly(() => extractReceipt(JPEG, "image/jpeg"));
  assert.equal(error.code, "OCR_TIMEOUT");
  assert.equal(error.status, 504);
  assert.equal(calls.length, 1);
});

test("transient outage is retried with bounded backoff and can recover", async () => {
  useResponses(grpcError(14, "Service unavailable"), grpcError(13, "Internal error"), { document: sampleDocument() });
  const { result } = await quietly(() => extractReceipt(JPEG, "image/jpeg"));
  assert.ok(result.entities.length);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [500, 1500]);
});

test("persistent outage stops after 3 attempts with a temporary-service error", async () => {
  useResponses(grpcError(14, "a"), grpcError(14, "b"), grpcError(14, "c"), { document: sampleDocument() });
  const { error } = await quietly(() => extractReceipt(JPEG, "image/jpeg"));
  assert.equal(error.code, "OCR_UNAVAILABLE");
  assert.equal(calls.length, 3);
  assert.equal(ocrStatus(), "configured", "an outage does not block later requests");
});

test("maxAttempts: 1 sends exactly one request, even on a transient error", async () => {
  useResponses(grpcError(14, "Service unavailable"), { document: sampleDocument() });
  const { error } = await quietly(() => extractReceipt(JPEG, "image/jpeg", { maxAttempts: 1 }));
  assert.equal(error.code, "OCR_UNAVAILABLE");
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(calls[0].options.maxRetries, 0);
});

test("credential, billing and configuration failures stay blocked (no automatic retry)", async () => {
  useResponses(grpcError(9, "Billing account for project is disabled"), { document: sampleDocument() });
  const first = await quietly(() => extractReceipt(JPEG, "image/jpeg"));
  assert.equal(first.error.code, "OCR_ACCOUNT_INACTIVE");
  for (let i = 0; i < 3; i += 1) {
    const again = await quietly(() => extractReceipt(JPEG, "image/jpeg"));
    assert.equal(again.error.code, "OCR_ACCOUNT_INACTIVE");
  }
  assert.equal(calls.length, 1, "the provider is not called again until an administrator restarts the service");
});

test("an unreadable or invalid document is rejected with a re-upload message", async () => {
  useResponses(grpcError(3, "Unsupported input file format."));
  const { error } = await quietly(() => extractReceipt(JPEG, "image/jpeg"));
  assert.equal(error.code, "OCR_DOCUMENT_REJECTED");
  assert.equal(error.status, 422);
});

test("HEIC is refused before any request", async () => {
  const { error } = await quietly(() => extractReceipt(Buffer.from("x"), "image/heic"));
  assert.equal(error.code, "OCR_UNSUPPORTED_FILE");
  assert.equal(error.status, 415);
  assert.equal(calls.length, 0);
});

test("a rejected service-account key (no gRPC code) is an auth failure", () => {
  assert.equal(toSafeError(new Error("invalid_grant: Invalid JWT Signature.")).code, "OCR_AUTH_FAILED");
  assert.equal(toSafeError(new Error("error:1E08010C:DECODER routines::unsupported")).code, "OCR_AUTH_FAILED");
});

test("failure logs never contain the private key or access tokens", async () => {
  const leaky = grpcError(
    16,
    `bad ${SYNTHETIC_KEY.private_key} Bearer ya29.abcdefghijklmnopqrstuvwxyz0123 id ${SYNTHETIC_KEY.private_key_id}`,
  );
  useResponses(leaky);
  const { lines } = await quietly(() => extractReceipt(JPEG, "image/jpeg"));
  const log = lines.join("\n");
  assert.ok(log.length > 0);
  assert.ok(!log.includes("PRIVATE KEY"), "PEM markers redacted");
  assert.ok(!log.includes(SYNTHETIC_KEY.private_key.slice(60, 120)));
  assert.ok(!log.includes(SYNTHETIC_KEY.private_key_id));
  assert.ok(!log.includes("ya29.abcdefghijklmnop"));
});
