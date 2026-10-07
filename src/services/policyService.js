// Company expense policy. The server applies it; the UI only displays the
// configuration (GET /policy) and the server's result for an expense
// (POST /policy/check), so no policy values live in the frontend.
import { resolveEndpoint } from "../config/api";
import { apiRequest } from "./httpClient";

// GET /policy
export async function getPolicy() {
  const response = await apiRequest(resolveEndpoint("policy").path);
  return response?.policy ?? null;
}

// POST /policy/check: the policy result for the values being reviewed.
export async function checkPolicy(expense, expenseId) {
  const endpoint = resolveEndpoint("policyCheck");
  return apiRequest(endpoint.path, endpoint.method, {
    ...(expenseId ? { expenseId } : {}),
    expense: {
      category: expense.category,
      amount: expense.amount,
      currency: expense.currency,
      expenseDate: expense.expenseDate,
      excomEvidence: expense.excomEvidence ?? null,
    },
  });
}
