import mongoose from "mongoose";
import { toJSONOptions } from "./toJSON.js";

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    // Spending limit in `currency`; the frontend warns when an expense exceeds it.
    limit: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/, default: "PHP" },
    receiptRequired: { type: Boolean, default: true },
    purposeRequired: { type: Boolean, default: true },
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
