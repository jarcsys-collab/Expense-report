// Validates and resolves notification recipients against the users collection.
// The browser only ever sends a recipient type and a user id: names, emails and
// roles always come from here. Identity is the same one sessions use (entraUserId).
import { HttpError } from "../../middleware/errorHandler.js";
import { User } from "../../models/User.js";

const recipientKey = (recipient) => `${recipient.type}:${recipient.userId ?? ""}`;

export function dedupeRecipients(recipients = []) {
  const seen = new Map();
  for (const recipient of recipients) seen.set(recipientKey(recipient), { type: recipient.type, ...(recipient.type === "user" ? { userId: recipient.userId } : {}) });
  return [...seen.values()];
}

/** Throws a 400 for recipients that cannot be used, naming which one. Returns the clean list. */
export async function validateRecipients(recipients = []) {
  const clean = dedupeRecipients(recipients);
  for (const recipient of clean) {
    if (recipient.type === "employee_manager") {
      throw new HttpError(400, "RECIPIENT_NOT_AVAILABLE", "The employee's manager cannot be selected yet: ReceiptFlow does not hold manager information. It requires configuration.");
    }
    if (recipient.type === "user" && !recipient.userId) {
      throw new HttpError(400, "RECIPIENT_INVALID", "Choose a person for this recipient.");
    }
  }
  const ids = clean.filter((r) => r.type === "user").map((r) => r.userId);
  if (ids.length) {
    const found = await User.find({ entraUserId: { $in: ids } }, { entraUserId: 1 }).lean();
    const known = new Set(found.map((user) => user.entraUserId));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new HttpError(400, "RECIPIENT_NOT_FOUND", "One of the selected people was not found. They must sign in to ReceiptFlow once before they can be selected.");
    }
  }
  return clean;
}

const person = (user) => ({ id: user.entraUserId, name: user.displayName || user.name, email: user.email || "", role: user.role, department: user.department || "" });

/**
 * People these recipients mean right now.
 * @returns {Promise<{ people: object[], unresolved: {type: string, userId?: string, code: string}[] }>}
 */
export async function resolveRecipients(recipients = []) {
  const people = new Map();
  const unresolved = [];
  const ids = recipients.filter((r) => r.type === "user").map((r) => r.userId);
  const users = ids.length ? await User.find({ entraUserId: { $in: ids } }).lean() : [];
  const byId = new Map(users.map((user) => [user.entraUserId, user]));
  for (const recipient of recipients) {
    if (recipient.type === "user") {
      const user = byId.get(recipient.userId);
      if (user) people.set(user.entraUserId, person(user));
      else unresolved.push({ type: "user", userId: recipient.userId, code: "RECIPIENT_NOT_FOUND" });
    } else if (recipient.type === "finance_admins") {
      const admins = await User.find({ role: "FINANCE_ADMIN", entraUserId: { $type: "string" } }).lean();
      if (!admins.length) unresolved.push({ type: "finance_admins", code: "NO_FINANCE_ADMINS" });
      for (const admin of admins) people.set(admin.entraUserId, person(admin));
    } else {
      unresolved.push({ type: recipient.type, code: "RECIPIENT_REQUIRES_CONFIGURATION" });
    }
  }
  return { people: [...people.values()], unresolved };
}

/** Recipients for the Management page: who each one is and whether it can be resolved now. */
export async function describeRecipients(recipients = []) {
  const ids = recipients.filter((r) => r.type === "user").map((r) => r.userId);
  const users = ids.length ? await User.find({ entraUserId: { $in: ids } }).lean() : [];
  const byId = new Map(users.map((user) => [user.entraUserId, person(user)]));
  return Promise.all(
    recipients.map(async (recipient) => {
      if (recipient.type === "user") {
        const found = byId.get(recipient.userId);
        return found
          ? { type: "user", userId: recipient.userId, name: found.name, resolvable: true }
          : { type: "user", userId: recipient.userId, name: "Person not found", resolvable: false };
      }
      if (recipient.type === "finance_admins") {
        const count = await User.countDocuments({ role: "FINANCE_ADMIN", entraUserId: { $type: "string" } });
        return { type: recipient.type, name: "All Finance administrators", count, resolvable: count > 0 };
      }
      return { type: recipient.type, name: "Employee's manager", resolvable: false };
    }),
  );
}
