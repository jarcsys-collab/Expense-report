import { isDatabaseConfigured, isDatabaseConnected } from "../config/database.js";
import { HttpError } from "./errorHandler.js";

// Data routes answer 503 quickly instead of hanging when MongoDB is unavailable.
export function requireDatabase(req, res, next) {
  if (!isDatabaseConfigured()) {
    throw new HttpError(503, "DATABASE_NOT_CONFIGURED", "The database is not configured yet.");
  }
  if (!isDatabaseConnected()) {
    throw new HttpError(503, "DATABASE_UNAVAILABLE", "The database is unavailable. Please retry shortly.");
  }
  next();
}
