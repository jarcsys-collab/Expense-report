// Central API configuration: base URL and every backend route the app calls.
//
// Each route has a REST path (the Node.js/Express API) and the legacy n8n
// webhook path. The active style comes from VITE_API_STYLE (default "rest").
// Any single route can be overridden with VITE_<NAME>_PATH, for example
// VITE_SAVE_CATEGORY_PATH=/v2/categories/{id}. Overrides must be relative paths.
import { config } from "./appConfig";

export const API_BASE_URL = config.apiBase;

export const AUTH_ENDPOINTS = {
  session: config.sessionPath,
  logout: config.logoutPath,
  // Microsoft Entra ID sign-in: exchanges verified Microsoft tokens for a session.
  entra: "/auth/entra",
  // TEMPORARY controlled-beta sign-in (fallback while Entra is verified).
  login: "/auth/login",
};

export const ENDPOINTS = {
  expenses: { rest: "/expenses", n8n: "/webhook/expenses" },
  expense: { rest: "/expenses/{id}", n8n: "/webhook/expense?id={id}" },
  create: { rest: "/expenses", n8n: "/webhook/expense-save", method: "POST" },
  update: {
    rest: "/expenses/{id}",
    n8n: "/webhook/expense-save",
    method: "PATCH",
  },
  delete: {
    rest: "/expenses/{id}",
    n8n: "/webhook/expense-delete",
    method: "DELETE",
  },
  submit: {
    rest: "/expenses/{id}/submit",
    n8n: "/webhook/expense-submit",
    method: "POST",
  },
  approve: {
    rest: "/expenses/{id}/approve",
    n8n: "/webhook/expense-approve",
    method: "POST",
  },
  reject: {
    rest: "/expenses/{id}/reject",
    n8n: "/webhook/expense-reject",
    method: "POST",
  },
  changes: {
    rest: "/expenses/{id}/request-changes",
    n8n: "/webhook/expense-request-changes",
    method: "POST",
  },
  comments: {
    rest: "/expenses/{id}/comments",
    n8n: "/webhook/expense-comment",
    method: "POST",
  },
  categories: { rest: "/categories", n8n: "/webhook/categories" },
  // Company expense policy (read-only) and the server's policy result for an expense.
  policy: { rest: "/policy", n8n: "/webhook/policy" },
  policyCheck: { rest: "/policy/check", n8n: "/webhook/policy-check", method: "POST" },
  saveCategory: {
    rest: "/categories/{id}",
    n8n: "/webhook/category-save",
    method: "PUT",
  },
  violations: { rest: "/violations", n8n: "/webhook/violations" },
  resolveViolation: {
    rest: "/expenses/{id}/violations/{violationId}/resolve",
    n8n: "/webhook/violation-resolve",
    method: "POST",
  },
  deleteFile: {
    rest: "/expenses/{id}/files/{fileId}",
    n8n: "/webhook/receipt-delete",
    method: "DELETE",
  },
  upload: {
    rest: "/receipts/upload",
    n8n: "/webhook/receipt-upload",
    method: "POST",
  },
  ocr: {
    rest: "/receipts/{jobId}/status",
    n8n: "/webhook/receipt-status?jobId={jobId}",
  },
  editedFile: {
    rest: "/receipts/files",
    n8n: "/webhook/receipt-file",
    method: "POST",
  },
};

// Returns { path, method } for a named endpoint, with {params} URL-encoded.
export function resolveEndpoint(name, params = {}) {
  const endpoint = ENDPOINTS[name];
  const envKey = `VITE_${name.replace(/[A-Z]/g, (letter) => "_" + letter).toUpperCase()}_PATH`;
  const template = String(import.meta.env[envKey] || endpoint[config.apiStyle]);
  if (
    !template.startsWith("/") ||
    template.startsWith("//") ||
    /https?:/i.test(template)
  ) {
    throw new Error(`${envKey} must be a relative path starting with /.`);
  }
  return {
    path: template.replace(/\{(\w+)\}/g, (match, key) => {
      if (params[key] === undefined) {
        throw new Error(`Missing endpoint parameter: ${key}`);
      }
      return encodeURIComponent(params[key]);
    }),
    method: endpoint.method || "GET",
  };
}
