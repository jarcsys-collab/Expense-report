export const asObject = (value) =>
  value !== null && typeof value == "object" && !Array.isArray(value)
    ? value
    : {};
export const hasOwn = (object, key) =>
  Object.prototype.hasOwnProperty.call(object, key);
export const unwrapValue = (value) =>
  hasOwn(asObject(value), "value") ? asObject(value).value : value;
export const toText = (value, fallback = "") =>
  typeof unwrapValue(value) == "string" || typeof unwrapValue(value) == "number"
    ? String(unwrapValue(value))
    : fallback;
export function toNumber(value, fallback = 0) {
  let raw = unwrapValue(value);
  if (typeof raw == "string") {
    let text = raw.trim().replace(/[^\d.,()\-]/g, "");
    if (!text) {
      return fallback;
    }
    if (
      text.includes(",") &&
      text.includes(".") &&
      text.lastIndexOf(",") > text.lastIndexOf(".")
    ) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      text = text.replace(/,/g, "");
    }
    if (text.startsWith("(")) {
      text = "-" + text.replace(/[()]/g, "");
    }
    raw = Number(text);
  }
  return typeof raw == "number" && Number.isFinite(raw) ? raw : fallback;
}
export function toConfidence(value) {
  if (value == null || value === "") {
    return;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100
    ? number > 1
      ? number / 100
      : number
    : undefined;
}
