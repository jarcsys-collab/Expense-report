import { config } from "../config/appConfig";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "APIError";
  }
}
export function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}
export function createAbortError() {
  return new DOMException("Operation cancelled.", "AbortError");
}
export async function apiRequest(path, method = "GET", body, options = {}) {
  if (!config.apiBase && !/^https?:\/\//i.test(path)) {
    throw new ApiError(
      "Workspace service is not configured. Contact your administrator.",
    );
  }
  let url;
  try {
    url = new URL(
      /^https?:\/\//i.test(path) ? path : `${config.apiBase}${path}`,
      globalThis.location?.href,
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (globalThis.location?.protocol === "https:" && url.protocol !== "https:")
    ) {
      throw new Error();
    }
  } catch {
    throw new ApiError(
      "The service URL is invalid or insecure. Contact your administrator.",
    );
  }
  if (options.signal?.aborted) {
    throw createAbortError();
  }
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener("abort", forwardAbort, {
    once: true,
  });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeout ?? config.requestTimeout);
  try {
    const response = await fetch(url.href, {
      method,
      credentials: config.credentials,
      signal: controller.signal,
      headers:
        body === undefined || body instanceof FormData
          ? undefined
          : {
              "Content-Type": "application/json",
            },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
    if (!response.ok) {
      let errorMessage = "";
      try {
        const json = await response.json();
        const serverMessage = json?.message || json?.error;
        errorMessage = typeof serverMessage == "string" ? serverMessage : "";
      } catch {}
      throw new ApiError(
        response.status === 401
          ? "You’re signed out. Sign in to continue."
          : errorMessage ||
              `Request failed (${response.status}). Please retry.`,
        response.status,
      );
    }
    if (response.status === 204) {
      return;
    }
    try {
      const data = await response.json();
      if (data && typeof data == "object" && data.success === false) {
        throw new ApiError(
          typeof data.message == "string"
            ? data.message
            : "The service could not complete this request.",
        );
      }
      return data;
    } catch {
      throw new ApiError(
        "Invalid server response: expected JSON. Check the webhook response configuration.",
      );
    }
  } catch (error) {
    throw options.signal?.aborted
      ? createAbortError()
      : timedOut
        ? new ApiError("The request timed out. Please retry.")
        : error instanceof TypeError
          ? new ApiError(
              "Network request failed. Check your connection and the backend CORS configuration.",
            )
          : error;
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}
