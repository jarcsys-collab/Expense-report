// Seeds the SYNTHETIC test receipt (test/fixtures) as a finished receipt scan in a
// throwaway LOCAL MongoDB: the stored file, the extraction as Google Document AI
// returned it in the live test (date read at 43%), no real employee data and no
// OCR request. Refuses any non-local database (scripts/localOnly.js).
//
//   cd server
//   MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/seed-local-synthetic-receipt.js [--user dev-user] [--db receiptflow-local]
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import mongoose from "mongoose";
import { assertLocalMongo } from "./localOnly.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SYNTHETIC_RECEIPT_PATH = path.join(here, "../test/fixtures/synthetic-receipt.jpg");

/** Creates the scan (ReceiptJob + stored file) for `uploadedBy` on the current connection. */
export async function seedSyntheticReceiptScan({ uploadedBy = "dev-user" } = {}) {
  const { ReceiptJob } = await import("../src/models/ReceiptJob.js");
  const { normalizeDocumentAiDocument } = await import("../src/services/documentAiNormalizer.js");
  const { storeReceiptFile } = await import("../src/services/receiptFileStore.js");
  const { liveShapedSyntheticDocument } = await import("../test/fixtures/documentAi.js");
  const buffer = fs.readFileSync(SYNTHETIC_RECEIPT_PATH);
  const { expense, ocrMeta, audit } = normalizeDocumentAiDocument(liveShapedSyntheticDocument());
  const job = await ReceiptJob.create({
    status: "needs_review",
    originalFileName: "synthetic-receipt.jpg",
    mimeType: "image/jpeg",
    size: buffer.length,
    uploadedBy,
    ocrProvider: "google_document_ai",
    fileSha256: createHash("sha256").update(buffer).digest("hex"),
    result: expense,
    ocrMeta,
    audit,
  });
  job.fileId = await storeReceiptFile(job, { buffer, mimetype: "image/jpeg" });
  await job.save();
  return job;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const uri = process.env.MONGODB_URI;
  const dbName = arg("db", "receiptflow-local");
  assertLocalMongo(uri, dbName);
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 5000 });
  const job = await seedSyntheticReceiptScan({ uploadedBy: arg("user", "dev-user") });
  console.log(`Seeded synthetic receipt scan ${job._id} for user "${job.uploadedBy}" in local database "${dbName}".`);
  await mongoose.disconnect();
}
