// /categories endpoints.
import { resolveEndpoint } from "../config/api";
import { apiRequest } from "./httpClient";
import {
  normalizeCategory,
  normalizeCategoryList,
  unwrapResponse,
} from "./normalizers";

// GET /categories
export async function getCategories() {
  return normalizeCategoryList(
    await apiRequest(resolveEndpoint("categories").path),
  );
}

// PUT /categories/{id}
export async function saveCategory(category) {
  const endpoint = resolveEndpoint("saveCategory", { id: category.id });
  return normalizeCategory(
    unwrapResponse(await apiRequest(endpoint.path, endpoint.method, category)),
  );
}
