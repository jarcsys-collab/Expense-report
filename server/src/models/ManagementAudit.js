import mongoose from "mongoose";
import { toJSONOptions } from "./toJSON.js";

// Append-only record of Management changes: who changed what, from what, to what.
// Identity comes from the server session. The application never updates or deletes these.
const { Schema } = mongoose;
const managementAuditSchema = new Schema(
  {
    at: { type: Date, default: Date.now, required: true },
    action: { type: String, required: true, maxlength: 60 },
    targetType: { type: String, maxlength: 40 },
    targetId: { type: String, maxlength: 100 },
    targetName: { type: String, maxlength: 200 },
    actor: { type: new Schema({ id: String, name: String, role: String, provider: String }, { _id: false }), required: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
  },
  { collection: "managementAudit", versionKey: false, toJSON: toJSONOptions },
);
managementAuditSchema.index({ at: -1 });
managementAuditSchema.index({ targetType: 1, targetId: 1, at: -1 });

export const ManagementAudit = mongoose.model("ManagementAudit", managementAuditSchema);
