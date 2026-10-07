import { z } from "zod";
import { POLICY_CATEGORY_KEYS } from "../policy/expensePolicy.js";

// Matches what the Categories page sends (id is ignored; it comes from the URL).
export const categorySchema = z.object({
  name: z.string().trim().min(1, "Enter a category name.").max(100),
  description: z.string().trim().max(500).default(""),
  // null = no limit set by Finance yet.
  limit: z.number().finite().min(0).max(1e12).nullable().default(null),
  currency: z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter currency code").default("PHP"),
  receiptRequired: z.boolean().default(true),
  purposeRequired: z.boolean().default(true),
  active: z.boolean().default(true),
  // Required: a company policy key, or null when a finance admin deliberately
  // chooses "No company policy limit".
  policyKey: z.enum(POLICY_CATEGORY_KEYS, { message: "Choose a valid company policy." }).nullable(),
});

// New categories arrive with a client-generated UUID (crypto.randomUUID()).
export const clientUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
