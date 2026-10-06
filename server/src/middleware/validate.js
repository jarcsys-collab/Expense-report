import { z } from "zod";
import { HttpError } from "./errorHandler.js";

export const objectIdPattern = /^[a-f\d]{24}$/i;
export const objectId = z.string().regex(objectIdPattern, "must be a valid id");

// Validates and replaces req.body / req.params; parsed query lives on
// req.validatedQuery because Express 5 makes req.query read-only.
// ZodErrors are turned into 400 responses by the error handler.
export function validate({ body, query, params } = {}) {
  return (req, res, next) => {
    if (params) req.params = params.parse(req.params);
    if (query) req.validatedQuery = query.parse(req.query);
    if (body) {
      if (req.body === undefined || req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
        throw new HttpError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
      }
      req.body = body.parse(req.body);
    }
    next();
  };
}

// For /:id routes backed by MongoDB documents.
export function validateObjectId(name = "id") {
  return (req, res, next) => {
    if (!objectIdPattern.test(req.params[name] ?? "")) {
      throw new HttpError(400, "INVALID_ID", `The ${name} is not a valid id.`);
    }
    next();
  };
}
