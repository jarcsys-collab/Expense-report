// Preparing a receipt photo before upload: rotate, crop, optional enhancement and
// compression. The sizing and pixel logic is pure so it can be tested without a browser.
import { config } from "../config/appConfig";

// Keep small text readable: a long, narrow receipt keeps its width, and only the long
// side of an ordinary photo is reduced. Canvas area is capped for phones (iOS Safari).
const LONG_SIDE_TARGET = 2800;
const SHORT_SIDE_TARGET = 1800;
const LONG_SIDE_MAX = 6000;
const MAX_CANVAS_AREA = 16_000_000;
// Below this, an unedited file is uploaded exactly as it is.
export const COMPRESS_ABOVE_BYTES = 3 * 1024 * 1024;
const TARGET_BYTES = 4 * 1024 * 1024;
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.7, 0.6];
export const FULL_CROP = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });
const MIN_VISIBLE = 0.1;

export const isHeic = (file) => /hei[cf]/i.test(file?.type ?? "") || /\.hei[cf]$/i.test(file?.name ?? "");
export const isPdf = (file) => file?.type === "application/pdf" || /\.pdf$/i.test(file?.name ?? "");
export const isImage = (file) => !isPdf(file) && (/^image\//.test(file?.type ?? "") || /\.(jpe?g|png|webp|hei[cf])$/i.test(file?.name ?? ""));

export const HEIC_NOT_SUPPORTED_MESSAGE =
  "This HEIC photo can't be read by the receipt scanner (Google OCR does not accept HEIC), and this browser can't convert it. On iPhone, set Settings > Camera > Formats to \"Most Compatible\", or take a screenshot of the photo and upload that.";

export const formatBytes = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Scale for the output image (at most 1): keeps text readable and stays within canvas limits. */
export function outputScale(width, height) {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (!long || !short) return 1;
  const readable = Math.max(LONG_SIDE_TARGET / long, SHORT_SIDE_TARGET / short);
  return Math.min(1, readable, LONG_SIDE_MAX / long, Math.sqrt(MAX_CANVAS_AREA / (width * height)));
}

/** Crop fractions cut from each edge, kept in range with at least 10% of the image left. */
export function clampCrop(crop) {
  const edge = (value) => Math.min(1, Math.max(0, Number(value) || 0));
  const next = { left: edge(crop.left), top: edge(crop.top), right: edge(crop.right), bottom: edge(crop.bottom) };
  const fit = (a, b) => {
    const over = next[a] + next[b] - (1 - MIN_VISIBLE);
    if (over > 0) {
      const total = next[a] + next[b];
      next[a] -= (over * next[a]) / total;
      next[b] -= (over * next[b]) / total;
    }
  };
  fit("left", "right");
  fit("top", "bottom");
  return next;
}

/** Moves one edge of the crop, stopping before it meets the opposite edge. */
export function moveCropEdge(crop, edge, value) {
  const opposite = { left: "right", right: "left", top: "bottom", bottom: "top" }[edge];
  return clampCrop({ ...crop, [edge]: Math.min(Math.max(0, value), 1 - MIN_VISIBLE - crop[opposite]) });
}

/** The same crop after the image turns 90° clockwise, so it stays on the same content. */
export const rotateCropClockwise = ({ left, top, right, bottom }) => ({ left: bottom, top: left, right: top, bottom: right });

/** Pixel geometry for an image rotated by `rotation` and cropped by `crop` (in rotated view). */
export function renderGeometry(width, height, rotation = 0, crop = FULL_CROP) {
  const sideways = rotation % 180 !== 0;
  const rotatedWidth = sideways ? height : width;
  const rotatedHeight = sideways ? width : height;
  const safe = clampCrop(crop);
  const cropWidth = rotatedWidth * (1 - safe.left - safe.right);
  const cropHeight = rotatedHeight * (1 - safe.top - safe.bottom);
  const scale = outputScale(cropWidth, cropHeight);
  return {
    rotatedWidth,
    rotatedHeight,
    offsetX: rotatedWidth * safe.left,
    offsetY: rotatedHeight * safe.top,
    scale,
    outputWidth: Math.max(1, Math.round(cropWidth * scale)),
    outputHeight: Math.max(1, Math.round(cropHeight * scale)),
  };
}

/**
 * Optional enhancement: grayscale with the contrast stretched between the 1st and 99th
 * percentile of brightness (RGBA pixels, changed in place). Faded thermal receipts gain
 * contrast; a blank or flat image is left as it is.
 */
export function enhancePixels(data) {
  const histogram = new Uint32Array(256);
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    histogram[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])] += 1;
  }
  const percentile = (share) => {
    let seen = 0;
    for (let level = 0; level < 256; level += 1) {
      seen += histogram[level];
      if (seen >= pixels * share) return level;
    }
    return 255;
  };
  const low = percentile(0.01);
  const high = percentile(0.99);
  const range = high - low;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const value = range >= 16 ? Math.min(255, Math.max(0, ((gray - low) * 255) / range)) : gray;
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  return data;
}

export const hasEdits = ({ rotation = 0, crop = FULL_CROP, enhance = false } = {}) =>
  Boolean(rotation % 360 || enhance || crop.left || crop.top || crop.right || crop.bottom);

/** Whether a file must go through the canvas before upload. */
export function needsProcessing(file, edits, { acceptsHeic = false } = {}) {
  if (!isImage(file)) return false;
  if (isHeic(file) && !acceptsHeic) return true;
  return hasEdits(edits) || file.size > COMPRESS_ABOVE_BYTES;
}

export async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return createImageBitmap(file);
  }
}

/** Draws the image rotated and cropped at a given overall scale. */
export function drawImageTo(canvas, bitmap, { rotation = 0, crop = FULL_CROP, enhance = false } = {}, maxOutputSide) {
  const geometry = renderGeometry(bitmap.width, bitmap.height, rotation, crop);
  const limit = maxOutputSide ? Math.min(1, maxOutputSide / Math.max(geometry.outputWidth, geometry.outputHeight)) : 1;
  const scale = geometry.scale * limit;
  canvas.width = Math.max(1, Math.round(geometry.outputWidth * limit));
  canvas.height = Math.max(1, Math.round(geometry.outputHeight * limit));
  const context = canvas.getContext("2d", { willReadFrequently: enhance });
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  context.translate(-geometry.offsetX, -geometry.offsetY);
  context.translate(geometry.rotatedWidth / 2, geometry.rotatedHeight / 2);
  context.rotate((rotation * Math.PI) / 180);
  context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  if (enhance) {
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    enhancePixels(image.data);
    context.putImageData(image, 0, 0);
  }
  return canvas;
}

const toBlob = (canvas, quality) =>
  new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The photo could not be prepared."))), "image/jpeg", quality));

/**
 * The file to upload. Untouched when no edit is needed, so its bytes (and duplicate
 * detection) stay the same; otherwise a JPEG under the size limit.
 * @returns {Promise<{ file: File, processed: boolean, originalSize: number }>}
 */
export async function prepareReceiptFile(file, edits = {}, { acceptsHeic = false } = {}) {
  const originalSize = file.size;
  if (!needsProcessing(file, edits, { acceptsHeic })) return { file, processed: false, originalSize };
  let bitmap;
  try {
    bitmap = await decodeImage(file);
  } catch {
    if (isHeic(file) && !acceptsHeic) throw new Error(HEIC_NOT_SUPPORTED_MESSAGE);
    // Not decodable here but allowed as it is: the server checks it.
    if (file.size <= config.maxFileSize && !hasEdits(edits)) return { file, processed: false, originalSize };
    throw new Error("This photo can't be edited or compressed in your browser. Retake it closer to the receipt, or use a smaller file.");
  }
  const canvas = drawImageTo(document.createElement("canvas"), bitmap, edits);
  bitmap.close?.();
  let blob;
  for (const quality of QUALITY_STEPS) {
    blob = await toBlob(canvas, quality);
    if (blob.size <= TARGET_BYTES) break;
  }
  // Compression that gains nothing is dropped, unless the file had to change anyway.
  if (!hasEdits(edits) && !isHeic(file) && blob.size >= file.size && file.size <= config.maxFileSize) {
    return { file, processed: false, originalSize };
  }
  if (blob.size > config.maxFileSize) {
    throw new Error("This photo is still larger than 10 MB after compression. Retake it closer to the receipt.");
  }
  const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
  return { file: new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified }), processed: true, originalSize };
}
