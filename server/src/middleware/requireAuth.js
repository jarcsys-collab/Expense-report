import { resolveUser } from "../services/authSession.js";
import { HttpError } from "./errorHandler.js";

// Protects data routes: anonymous requests get 401 before any data or upload is read.
export async function requireAuth(req, res, next) {
  const user = await resolveUser(req);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  req.user = user;
  next();
}
