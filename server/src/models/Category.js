import mongoose from "mongoose";
import { POLICY_CATEGORY_KEYS } from "../policy/expensePolicy.js";
import { toJSONOptions } from "./toJSON.js";

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    // Spending limit in `currency`; expenses above it are flagged. null means
    // Finance has not set a limit, and the limit check reports "not evaluated"
    // instead of comparing against an invented value.
    limit: { type: Number, min: 0, default: null },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/, default: "PHP" },
    receiptRequired: { type: Boolean, default: true },
    purposeRequired: { type: Boolean, default: true },
    // Inactive categories stay for history (expenses keep the stored name) but
    // cannot be chosen for new submissions.
    active: { type: Boolean, default: true },
    // Which company expense policy applies (policy/expensePolicy.js), chosen by
    // a finance admin. null: no company policy limit for this category.
    policyKey: { type: String, enum: [...POLICY_CATEGORY_KEYS, null], default: null },
    // The frontend creates categories with a client-generated UUID and saves
    // them with PUT /categories/:uuid. That id is kept here so repeated saves
    // update the same category instead of creating duplicates.
    clientId: { type: String, maxlength: 100 },
  },
  {
    timestamps: true,
    collection: "categories",
    toJSON: {
      ...toJSONOptions,
      transform(doc, ret) {
        toJSONOptions.transform(doc, ret);
        delete ret.clientId;
        return ret;
      },
    },
  },
);

// Names are unique regardless of letter case.
categorySchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });
categorySchema.index({ clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: "string" } } });

export const Category = mongoose.model("Category", categorySchema);
