import { User } from "../models/User.js";
import { HttpError } from "./errorHandler.js";

// Who may use which part of Management. This table is the only place that decides it.
//
// TEMPORARY business decision: every signed-in employee may manage notification rules
// and recipients. To restore a restriction, replace SIGNED_IN with a list of roles,
// e.g. rules: ["FINANCE_ADMIN"]. Nothing else needs to change: routes and the frontend's
// session flags both read this table.
//
// ocrAnalytics stays restricted: it is not configuration, and it shows each employee's
// scanning activity and estimated spend.
const SIGNED_IN = "signed_in";
export const MANAGEMENT_POLICY = Object.freeze({
  rules: SIGNED_IN,
  directory: SIGNED_IN,
  delivery: SIGNED_IN,
  audit: SIGNED_IN,
  ocrAnalytics: ["FINANCE_ADMIN"],
});

const roleAllows = (permission, role) => {
  const allowed = MANAGEMENT_POLICY[permission];
  return allowed === SIGNED_IN || (Array.isArray(allowed) && allowed.includes(role));
};

const forbidden = () => new HttpError(403, "FORBIDDEN", "You do not have permission to do this.");

// The shared beta account never qualifies, whatever BETA_AUTH_ROLE says: its changes could
// not be attributed to a person, and anyone holding the login would see the staff directory.
/** Display hints for the frontend; the middleware below is what enforces them. */
export const canUseManagement = (user) => Boolean(user?.id) && user.provider !== "beta";
export const managementAllows = (user, permission) => canUseManagement(user) && roleAllows(permission, user.role);

// After requireAuth. For Microsoft accounts the role is read again from the users
// collection, so a removed user or a changed role applies at once, not when the session ends.
export async function requireManagementAccess(req, res, next) {
  if (!canUseManagement(req.user)) throw forbidden();
  req.managementRole = req.user.role;
  if (req.user.provider === "entra") {
    const record = await User.findOne({ entraUserId: req.user.id }, { role: 1 }).lean();
    if (!record) throw forbidden();
    req.managementRole = record.role;
  }
  next();
}

export const requireManagementPermission = (permission) => (req, res, next) => {
  if (!roleAllows(permission, req.managementRole)) throw forbidden();
  next();
};
