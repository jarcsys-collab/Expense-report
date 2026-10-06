import { z } from "zod";

// Matches what the Categories page sends (id is ignored; it comes from the URL).
export const categorySchema = z.object({
  name: z.string().trim().min(1, "Enter a category name.").max(100),
  limit: z.number().finite().min(0).max(1e12),
  currency: z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter currency code").default("PHP"),
  receiptRequired: z.boolean().default(true),
  purposeRequired: z.boolean().default(true),
});

// New categories arrive with a client-generated UUID (crypto.randomUUID()).
export const clientUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
