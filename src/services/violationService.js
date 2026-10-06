// /violations endpoint. Returns the expenses that have policy findings.
import { resolveEndpoint } from "../config/api";
import { apiRequest } from "./httpClient";
import { normalizeExpenseList } from "./normalizers";

// GET /violations
export async function getViolations() {
  return normalizeExpenseList(
    await apiRequest(resolveEndpoint("violations").path),
  );
}
