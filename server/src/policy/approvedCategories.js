// The company's approved initial expense categories, each mapped to a company
// policy key (expensePolicy.js holds the limits; they are not copied here).
// ensureApprovedCategories() makes sure they exist so employees can use
// ReceiptFlow without a Finance admin setting categories up first.
import { Category } from "../models/Category.js";
import { POLICY_CATEGORY_KEYS } from "./expensePolicy.js";

export const APPROVED_CATEGORIES = [
  { name: "Hotel & Lodging", policyKey: "HOTEL_LODGING" },
  { name: "In-based meals", policyKey: "IN_BASED_MEALS" },
  { name: "Out-based meals", policyKey: "OUT_BASED_MEALS" },
  { name: "Work with meals", policyKey: "WORK_WITH_MEALS" },
  { name: "Special operation meals", policyKey: "SPECIAL_OPERATION_MEALS" },
  {
    name: "Product Presentations, Training & evaluation | Gifts for medical Assoc.",
    policyKey: "PRODUCT_PRESENTATION_TRAINING_GIFTS",
  },
  { name: "Representations", policyKey: "REPRESENTATION" },
];

const byName = { locale: "en", strength: 2 };

// Creates the approved categories that are missing. Idempotent and safe to run
// on every start: a category whose name already exists (any letter case) is
// left exactly as it is, including any changes a Finance admin made to it.
// Inserts are atomic upserts guarded by the unique name index, so concurrent
// starts cannot create duplicates. Returns the names it created.
export async function ensureApprovedCategories() {
  const invalid = APPROVED_CATEGORIES.filter((c) => !POLICY_CATEGORY_KEYS.includes(c.policyKey));
  if (invalid.length) {
    // Never create a category with a policy key the policy engine does not know.
    throw new Error(`Approved categories reference unknown policy keys: ${invalid.map((c) => c.policyKey).join(", ")}.`);
  }
  const created = [];
  for (const { name, policyKey } of APPROVED_CATEGORIES) {
    try {
      const result = await Category.updateOne(
        { name },
        {
          $setOnInsert: {
            name,
            policyKey,
            description: "",
            limit: null,
            currency: "PHP",
            receiptRequired: true,
            purposeRequired: true,
            active: true,
          },
        },
        { upsert: true, collation: byName },
      );
      if (result.upsertedCount) created.push(name);
    } catch (error) {
      // Another instance inserted it at the same moment: it exists, nothing to do.
      if (error?.code !== 11000) throw error;
    }
  }
  return created;
}
