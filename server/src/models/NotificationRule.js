import mongoose from "mongoose";
import { toJSONOptions } from "./toJSON.js";

// Who is told when an anomaly is found. Notification only: a rule never changes
// an expense's status and has nothing to do with approval routing.
export const RULE_SEVERITIES = ["any", "Informational", "Warning", "High Risk"];
// on_submission: the employee saved it to My Requests / submitted it.
// on_save: also every save the employee makes (never assistant-only incomplete drafts).
export const RULE_TRIGGERS = ["on_submission", "on_save"];
export const RULE_CHANNELS = ["in_app", "email"];
// user: one person from the users collection. finance_admins: everyone whose role
// is FINANCE_ADMIN when the notification is created. employee_manager: reserved;
// ReceiptFlow holds no manager data yet, so the API refuses it (see notificationCatalog).
export const RECIPIENT_TYPES = ["user", "finance_admins", "employee_manager"];

const { Schema } = mongoose;
const actorSchema = new Schema({ id: String, name: String }, { _id: false });
const recipientSchema = new Schema(
  {
    type: { type: String, enum: RECIPIENT_TYPES, required: true },
    // The user's stable identity (entraUserId), for type "user".
    userId: { type: String, maxlength: 100 },
  },
  { _id: false },
);

const notificationRuleSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    enabled: { type: Boolean, default: false },
    // Rule ids from services/anomaly/anomalyRules.js.
    anomalyTypes: { type: [String], required: true },
    severity: { type: String, enum: RULE_SEVERITIES, default: "any" },
    trigger: { type: String, enum: RULE_TRIGGERS, default: "on_submission" },
    channel: { type: String, enum: RULE_CHANNELS, default: "in_app" },
    recipients: { type: [recipientSchema], default: [] },
    // Tell these people too when an in-app notification is still unread after afterHours.
    escalation: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: false },
          afterHours: { type: Number, min: 1, max: 720, default: 24 },
          recipients: { type: [recipientSchema], default: [] },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    createdBy: { type: actorSchema },
    updatedBy: { type: actorSchema },
    // Removed from the Management page, kept for notification history and audit.
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "notificationRules", toJSON: toJSONOptions },
);

// __v is the edit version, used to refuse saving over someone else's change.
notificationRuleSchema.index({ deletedAt: 1, enabled: 1 });

export const NotificationRule = mongoose.model("NotificationRule", notificationRuleSchema);
