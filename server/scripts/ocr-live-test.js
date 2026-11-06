// One real OCR request with the SYNTHETIC test receipt, using the provider and
// credentials from server/.env. Billable (1 page). Does not touch MongoDB.
// Prints extracted fields only, never credentials.
//
//   cd server
//   node scripts/ocr-live-test.js --confirm-billable [path/to/synthetic.jpg]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../src/config/env.js";
import { __setTestHooks, createDocumentAiClient } from "../src/services/googleDocumentAiService.js";
import { activeOcrProvider, ocrStatus, readReceipt } from "../src/services/ocrProvider.js";

// Exactly one processing request: retries off (maxAttempts 1 below, client
// maxRetries 0), and the real client is wrapped so a second call is refused.
let processCalls = 0;
__setTestHooks({
  factory: (config) => {
    const real = createDocumentAiClient(config);
    return {
      processDocument: (...callArgs) => {
        processCalls += 1;
        if (processCalls > 1) throw new Error("Refusing a second billable processDocument call.");
        return real.processDocument(...callArgs);
      },
      close: () => real.close(),
    };
  },
});

const args = process.argv.slice(2);
if (!args.includes("--confirm-billable")) {
  console.error("Refusing to run: this sends one billable OCR request. Re-run with --confirm-billable.");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(here, "../test/fixtures/synthetic-receipt.jpg"));
const mimeType = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".pdf": "application/pdf", ".webp": "image/webp" }[path.extname(file).toLowerCase()];
if (!mimeType) throw new Error("Use a JPG, PNG, WEBP or PDF test file.");

console.log(`Provider: ${activeOcrProvider()} (status: ${ocrStatus()})`);
if (activeOcrProvider() === "google_document_ai") {
  const g = env.googleDocumentAi;
  console.log(`Processor: ${g.projectId} / ${g.location} / ${g.processorId}; credentials from ${g.credentialsSource ?? "none"}`);
}
const started = Date.now();
try {
  const { expense, ocrMeta, audit } = await readReceipt(
    { buffer: fs.readFileSync(file), mimetype: mimeType },
    { fileName: path.basename(file), requestId: `live-test-${started}`, maxAttempts: 1 },
  );
  const { ocrText, originalOCR, ocrConfidence, lineItems, ...fields } = expense;
  console.log(`OK in ${Date.now() - started} ms`);
  console.log("Fields:", fields);
  console.log("Line items:", lineItems);
  console.log("Confidence:", ocrConfidence);
  console.log("Entity types returned:", audit.entityTypes ?? audit.topLevelKeys);
  console.log("Unavailable provider signals:", ocrMeta.unavailableSignals ?? "none");
} catch (error) {
  console.error(`FAILED in ${Date.now() - started} ms: ${error.code ?? error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  console.log(`Document AI processDocument calls made: ${processCalls}`);
}

// Close open gRPC channels so the script ends after reporting.
process.exit(process.exitCode ?? 0);
