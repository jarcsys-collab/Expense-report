import { config } from "../config/appConfig";
import { sanitizeFileName } from "../utils/format";

export async function downloadReceipt(file) {
  const url = URL.createObjectURL(await fetchReceiptBlob(file));
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeFileName(file.name);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
export async function fetchReceiptBlob(file) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.requestTimeout);
  try {
    const response = await fetch(file.url, {
      credentials: /^(data:|blob:)/.test(file.url)
        ? "omit"
        : config.credentials,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error("Unable to download this receipt.");
    }
    const blob = await response.blob();
    const mimeType =
      blob.type === "application/octet-stream" ? file.mimeType : blob.type;
    if (
      ![
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/heic",
        "image/heif",
        "application/pdf",
      ].includes(mimeType.split(";")[0])
    ) {
      throw new Error("The receipt service returned an unsupported file type.");
    }
    return blob.type === mimeType
      ? blob
      : new Blob([blob], {
          type: mimeType,
        });
  } catch (error) {
    throw controller.signal.aborted
      ? new Error("Receipt download timed out. Please retry.")
      : error instanceof TypeError
        ? new Error("Unable to download this receipt. Check your connection.")
        : error;
  } finally {
    clearTimeout(timeoutId);
  }
}
export async function openReceipt(file) {
  const popup = window.open("about:blank", "_blank");
  if (!popup) {
    throw new Error(
      "Allow pop-ups for this workspace to open the original receipt.",
    );
  }
  popup.opener = null;
  try {
    const url = URL.createObjectURL(await fetchReceiptBlob(file));
    popup.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 6e4);
  } catch (error) {
    popup.close();
    throw error;
  }
}
