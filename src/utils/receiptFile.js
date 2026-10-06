import { config } from "../config/appConfig";

export function validateReceiptFile(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "application/pdf",
  ];
  if (
    !extension ||
    !["jpg", "jpeg", "png", "webp", "heic", "heif", "pdf"].includes(extension)
  ) {
    throw new Error(`${file.name}: use JPG, PNG, WEBP, HEIC or PDF.`);
  }
  if (file.type && !allowedTypes.includes(file.type)) {
    throw new Error(`${file.name}: unsupported file type.`);
  }
  const typesByExtension = {
    jpg: ["image/jpeg"],
    jpeg: ["image/jpeg"],
    png: ["image/png"],
    webp: ["image/webp"],
    heic: ["image/heic", "image/heif"],
    heif: ["image/heic", "image/heif"],
    pdf: ["application/pdf"],
  };
  if (file.type && !typesByExtension[extension].includes(file.type)) {
    throw new Error(`${file.name}: file extension and MIME type do not match.`);
  }
  if (file.size > config.maxFileSize) {
    throw new Error(`${file.name}: maximum size is 20 MB.`);
  }
  if (!file.size) {
    throw new Error(`${file.name}: this file is empty.`);
  }
}
