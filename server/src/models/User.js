import mongoose from "mongoose";
import { ROLES } from "./constants.js";
import { toJSONOptions } from "./toJSON.js";

// ReceiptFlow users. Created on Microsoft Entra ID sign-in, keyed by the Entra
// object id (entraUserId). Profile fields are refreshed from Microsoft Graph at
// every sign-in. No passwords or Microsoft tokens are stored here.
// The temporary beta account is not stored as a user.
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    email: { type: String, trim: true, lowercase: true, maxlength: 320 },
    role: { type: String, enum: ROLES, default: "EMPLOYEE" },
    department: { type: String, trim: true, maxlength: 200, default: "" },
    position: { type: String, trim: true, maxlength: 200, default: "" },
    // Identity-provider subject for other sign-in providers.
    externalId: { type: String, trim: true, maxlength: 200 },
    authProvider: { type: String, enum: ["entra"], default: undefined },
    // Microsoft Entra ID object id (oid): the stable identity.
    entraUserId: { type: String, trim: true, maxlength: 100 },
    tenantId: { type: String, trim: true, maxlength: 100 },
    displayName: { type: String, trim: true, maxlength: 200 },
    jobTitle: { type: String, trim: true, maxlength: 200, default: "" },
    lastLoginAt: Date,
  },
  { timestamps: true, collection: "users", toJSON: toJSONOptions },
);

userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });
userSchema.index({ externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } });
userSchema.index({ entraUserId: 1 }, { unique: true, partialFilterExpression: { entraUserId: { $type: "string" } } });

export const User = mongoose.model("User", userSchema);
