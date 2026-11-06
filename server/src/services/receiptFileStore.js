// Original receipt files (image/PDF) kept in MongoDB GridFS (bucket
// "receiptFiles"), so employees can reopen the scanned receipt from My Requests.
// Files are served only through routes that check access to the receipt scan
// or its expense; they are never public.
import mongoose from "mongoose";

const BUCKET = "receiptFiles";
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });

/** Stores the uploaded file for a receipt job and returns the GridFS file id. */
export function storeReceiptFile(job, file) {
  return new Promise((resolve, reject) => {
    const upload = bucket().openUploadStream(job.originalFileName, {
      metadata: { receiptJobId: job._id, uploadedBy: job.uploadedBy ?? null, contentType: file.mimetype },
    });
    upload.once("error", reject);
    upload.once("finish", () => resolve(upload.id));
    upload.end(file.buffer);
  });
}

/**
 * Streams the stored file of a receipt job to the response, or returns false
 * when the job has no stored file (scans made before files were kept).
 */
// Only these types are ever served (the upload already checked each file's
// leading bytes against its type: middleware/receiptUpload.js). Never HTML/SVG.
export const SERVABLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]);

/** A filename safe for Content-Disposition (no quotes, control characters or path parts). */
export function safeDownloadName(name) {
  const base = String(name ?? "")
    .split(/[\\/]/)
    .pop()
    .replace(/[^\w.() -]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 150);
  return base || "receipt";
}

export async function sendReceiptFile(job, res) {
  if (!job?.fileId) return false;
  if (!SERVABLE_TYPES.has(job.mimeType)) {
    console.error(`[receipt-file] refused to serve job ${job._id}: unexpected type`);
    return false;
  }
  const [stored] = await bucket().find({ _id: job.fileId }).limit(1).toArray();
  if (!stored) return false;
  res.setHeader("Content-Type", job.mimeType);
  res.setHeader("Content-Length", String(stored.length));
  res.setHeader("Content-Disposition", `inline; filename="${safeDownloadName(job.originalFileName)}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Readable by the app through CORS fetch only; never embeddable by other sites.
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  // A stored PDF/image never runs scripts in the API's origin.
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  await new Promise((resolve, reject) => {
    bucket().openDownloadStream(job.fileId).once("error", reject).once("end", resolve).pipe(res);
  });
  return true;
}
