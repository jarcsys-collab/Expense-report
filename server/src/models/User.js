import mongoose from "mongoose";
import { ROLES } from "./constants.js";
import { toJSONOptions } from "./toJSON.js";

// Prepared for organization sign-in. Not used by any route yet.
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    email: { type: String, trim: true, lowercase: true, maxlength: 320 },
    role: { type: String, enum: ROLES, default: "EMPLOYEE" },
    department: { type: String, trim: true, maxlength: 200, default: "" },
    position: { type: String, trim: true, maxlength: 200, default: "" },
    // Identity-provider subject once SSO is connected.
    externalId: { type: String, trim: true, maxlength: 200 },
  },
  { timestamps: true, collection: "users", toJSON: toJSONOptions },
);

userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });
userSchema.index({ externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } });

export const User = mongoose.model("User", userSchema);
