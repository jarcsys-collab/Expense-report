import { HttpError } from "./errorHandler.js";

// Allows the request only for the given roles (after requireAuth). The role
// comes from the server session: the users collection for Microsoft accounts,
// BETA_AUTH_ROLE for the temporary beta account.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      throw new HttpError(403, "FORBIDDEN", "You do not have permission to do this.");
    }
    next();
  };
}
