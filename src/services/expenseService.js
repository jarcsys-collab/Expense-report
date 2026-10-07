// /expenses endpoints. Every response is normalized into the expense shape the UI uses.
import { resolveEndpoint } from "../config/api";
import { getActiveUser } from "./authService";
import { apiRequest } from "./httpClient";
import {
  normalizeExpense,
  normalizeExpenseList,
  toExpensePayload,
} from "./normalizers";

async function expenseAction(name, params = {}, body, fallback) {
  const user = getActiveUser();
  const endpoint = resolveEndpoint(name, params);
  const response = await apiRequest(endpoint.path, endpoint.method, body);
  return normalizeExpense(response, { saved: true, fallback, user });
}

// GET /expenses?filters
export async function getExpenses(filters = {}) {
  const endpoint = resolveEndpoint("expenses");
  const query = new URLSearchParams(filters).toString();
  const separator = endpoint.path.includes("?") ? "&" : "?";
  return normalizeExpenseList(
    await apiRequest(endpoint.path + (query ? separator + query : "")),
  );
}

// GET /expenses/{id}
export const getExpense = (id) => expenseAction("expense", { id });

// options.incompleteDraft: the Reimbursement Assistant is saving the draft only
// so the server can run its checks (see Expense.incompleteDraft on the server).
const withOptions = (expense, options = {}) => ({
  ...toExpensePayload(expense),
  ...(options.incompleteDraft ? { incompleteDraft: true } : {}),
});

// POST /expenses
export const createExpense = (expense, options) =>
  expenseAction("create", {}, withOptions(expense, options), expense);

// PATCH /expenses/{id}
export const updateExpense = (id, expense, options) =>
  expenseAction("update", { id }, withOptions(expense, options), expense);

// DELETE /expenses/{id}
export async function deleteExpense(id) {
  const endpoint = resolveEndpoint("delete", { id });
  await apiRequest(endpoint.path, endpoint.method, undefined);
}

// POST /expenses/{id}/submit
export const submitExpense = (id, expense) =>
  expenseAction(
    "submit",
    { id },
    expense ? { id, expense: toExpensePayload(expense) } : { id },
    expense,
  );

// POST /expenses/{id}/approve
export const approveExpense = (id) => expenseAction("approve", { id }, { id });

// POST /expenses/{id}/reject
export const rejectExpense = (id, reason) =>
  expenseAction("reject", { id }, { reason });

// POST /expenses/{id}/request-changes
export const requestChanges = (id, comment) =>
  expenseAction("changes", { id }, { comment });

// POST /expenses/{id}/comments
export const addExpenseComment = (id, message, parentId) =>
  expenseAction("comments", { id }, { message, parentId });

// POST /expenses/{id}/violations/{violationId}/resolve
export const resolveViolation = (expenseId, violationId, reason) =>
  expenseAction("resolveViolation", { id: expenseId, violationId }, { reason });

// DELETE /expenses/{id}/files/{fileId}
export const deleteFile = (expenseId, fileId) =>
  expenseAction("deleteFile", { id: expenseId, fileId });
