import { ZodError } from "zod";
import { redactSecrets as redact } from "../config/env.js";

// Throw this from routes for expected failures; the message is shown to users.
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function notFound(req, res) {
  res.status(404).json({ error: "NOT_FOUND", message: `No route for ${req.method} ${req.path}.` });
}

// Single JSON error format: { error: CODE, message, details? }.
// Stack traces, driver messages and connection details never reach the client.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let status = 500;
  let body = { error: "INTERNAL_ERROR", message: "Something went wrong. Please retry." };

  if (err instanceof HttpError) {
    status = err.status;
    body = { error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
  } else if (err instanceof ZodError) {
    status = 400;
    body = {
      error: "VALIDATION_ERROR",
      message: "Some fields are invalid.",
      details: err.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  } else if (err?.type === "entity.parse.failed") {
    status = 400;
    body = { error: "INVALID_JSON", message: "Request body must be valid JSON." };
  } else if (err?.type === "entity.too.large") {
    status = 413;
    body = { error: "PAYLOAD_TOO_LARGE", message: "Request body is too large." };
  } else if (err?.name === "CastError") {
    status = 400;
    body = { error: "INVALID_ID", message: "The id is not valid." };
  } else if (err?.name === "ValidationError") {
    status = 400;
    body = {
      error: "VALIDATION_ERROR",
      message: "Some fields are invalid.",
      details: Object.values(err.errors ?? {}).map((e) => ({ path: e.path, message: e.kind })),
    };
  } else if (err?.code === 11000) {
    status = 409;
    body = { error: "CONFLICT", message: "A record with the same unique value already exists." };
  } else if (["MongoNetworkError", "MongoServerSelectionError", "MongoNotConnectedError"].includes(err?.name)) {
    status = 503;
    body = { error: "DATABASE_UNAVAILABLE", message: "The database is unavailable. Please retry shortly." };
  }

  if (status >= 500 && !(err instanceof HttpError)) {
    console.error(`${req.method} ${req.originalUrl} -> ${status}: ${err?.name ?? "Error"}: ${redact(err?.message)}`);
  }
  res.status(status).json(body);
}
