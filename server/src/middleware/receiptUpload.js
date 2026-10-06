import multer from "multer";
import { HttpError } from "./errorHandler.js";

// Matches the frontend (src/utils/receiptFile.js): JPG, PNG, WEBP, HEIC/HEIF or PDF, up to 20 MB.
export const MAX_RECEIPT_BYTES = 20 * 1024 * 1024;
const TYPES_BY_EXTENSION = {
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  webp: ["image/webp"],
  heic: ["image/heic", "image/heif"],
  heif: ["image/heic", "image/heif"],
  pdf: ["application/pdf"],
};

// Checks the file's leading bytes so a renamed or corrupt file is rejected
// before it is sent to the OCR provider.
function signatureMatches(buffer, mimeType) {
  const head = buffer.subarray(0, 16);
  const ascii = (start, end) => head.subarray(start, end).toString("latin1");
  switch (mimeType) {
    case "image/jpeg":
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "image/png":
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "image/heic":
    case "image/heif":
      return ascii(4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(ascii(8, 12));
    case "application/pdf":
      return ascii(0, 5) === "%PDF-";
    default:
      return false;
  }
}

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_BYTES, files: 10, fields: 5, fieldSize: 1024, parts: 15 },
}).array("receipt", 10);

// Parses multipart/form-data with the receipt in the "receipt" field
// (the frontend's config.uploadField) and validates it.
export function receiptUpload(req, res, next) {
  if (!req.is("multipart/form-data")) {
    return next(new HttpError(400, "MISSING_FILE", "Send the receipt as multipart/form-data in the \"receipt\" field."));
  }
  parser(req, res, (error) => {
    if (error) {
      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
          return next(new HttpError(413, "FILE_TOO_LARGE", "The receipt is larger than 20 MB."));
        }
        if (error.code === "LIMIT_UNEXPECTED_FILE") {
          return next(new HttpError(400, "UNEXPECTED_FIELD", "Upload the file in the \"receipt\" field."));
        }
        return next(new HttpError(400, "MALFORMED_UPLOAD", "The upload could not be read. Please retry."));
      }
      return next(new HttpError(400, "MALFORMED_UPLOAD", "The upload could not be read. Please retry."));
    }
    const files = req.files ?? [];
    if (!files.length) return next(new HttpError(400, "MISSING_FILE", "No receipt file was uploaded."));
    // TODO(long receipts): the frontend's "Long receipt" flow sends several photo
    // sections of one receipt in a single request. V1 rejects this instead of
    // guessing. Future support: combine the sections into one multi-page PDF (or
    // use a provider multi-page option) so the receipt is billed and extracted as
    // ONE document, then keep each section's page number on the expense.
    if (files.length > 1) {
      return next(
        new HttpError(400, "MULTIPLE_FILES_NOT_SUPPORTED", "Scanning a receipt in several sections is not supported yet. Upload one photo or a PDF."),
      );
    }
    const file = files[0];
    const extension = file.originalname.split(".").pop()?.toLowerCase();
    const allowed = TYPES_BY_EXTENSION[extension];
    if (!allowed) return next(new HttpError(415, "UNSUPPORTED_FILE_TYPE", "Use JPG, PNG, WEBP, HEIC or PDF."));
    if (!allowed.includes(file.mimetype)) {
      return next(new HttpError(415, "UNSUPPORTED_FILE_TYPE", "The file type does not match its extension."));
    }
    if (!file.size) return next(new HttpError(400, "EMPTY_FILE", "The receipt file is empty."));
    if (!signatureMatches(file.buffer, file.mimetype)) {
      return next(new HttpError(400, "MALFORMED_UPLOAD", "The file content does not match its type, or the file is damaged."));
    }
    req.receiptFile = file;
    next();
  });
}
