// Frontend-safe runtime configuration.
//
// Everything here ends up in the public JavaScript bundle. Only put values in
// VITE_* variables that are safe for anyone to read (URLs, feature flags,
// display settings). Never put API keys, database URLs or other secrets here.
const env = import.meta.env;

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && value !== "" && value !== undefined
    ? Math.min(max, Math.max(min, number))
    : fallback;
};

export const config = {
  appName: "ReceiptFlow",
  defaultCurrency: "PHP",
  accountName: "JARCTECH",
  accountEmail: "",
  // Base URL of the Node.js/Express API, e.g. https://api.example.com
  // Empty means "not connected": the UI shows the not-configured banner.
  apiBase: (env.VITE_API_BASE_URL || "").replace(/\/$/, ""),
  // "rest" uses /expenses-style routes; "n8n" uses the legacy /webhook/* routes.
  apiStyle: env.VITE_API_STYLE === "n8n" ? "n8n" : "rest",
  credentials: ["include", "omit", "same-origin"].includes(
    env.VITE_API_CREDENTIALS,
  )
    ? env.VITE_API_CREDENTIALS
    : "include",
  sessionPath: "/auth/session",
  logoutPath: "/auth/logout",
  // Organization sign-in page. Empty keeps "Sign in" disabled.
  signInUrl: env.VITE_SIGN_IN_URL || "",
  // Receipt upload stays disabled until the backend OCR endpoint is live.
  receiptUploadEnabled: env.VITE_RECEIPT_UPLOAD_ENABLED === "true",
  uploadField: "receipt",
  // OCR confidence below this marks a field as "Needs review".
  confidence: 0.8,
  maxFileSize: 20 * 1024 * 1024,
  pollInterval: clamp(env.VITE_OCR_POLL_INTERVAL_MS, 2e3, 4e3, 2500),
  ocrTimeout: clamp(env.VITE_OCR_TIMEOUT_MS, 1e4, 6e5, 18e4),
  requestTimeout: Math.max(
    1e3,
    clamp(env.VITE_REQUEST_TIMEOUT_MS, 1e3, Infinity, 3e4),
  ),
};
