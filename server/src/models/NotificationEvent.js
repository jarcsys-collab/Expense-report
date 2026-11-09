import mongoose from "mongoose";
import { toJSONOptions } from "./toJSON.js";

// The notification outbox and its history: one record per recipient. Created in
// the same request that found the anomaly, delivered by services/notifications/outbox.js.
//
// Content is deliberately minimal (request number, anomaly name, severity). It never
// holds the merchant, amounts, the anomaly's full message or anyone's duplicate
// details: whoever opens the request goes through the normal expense access check.
export const NOTIFICATION_STATUSES = ["queued", "sending", "delivered", "failed", "skipped"];

const { Schema } = mongoose;
const notificationEventSchema = new Schema(
  {
    // Unique: the same anomaly, on the same request, for the same person and
    // channel, in the same state, is only ever notified once.
    idempotencyKey: { type: String, required: true, maxlength: 128 },
    // TEST notifications (synthetic, from Management) are kept apart from real ones.
    test: { type: Boolean, default: false },
    testBy: { type: new Schema({ id: String, name: String }, { _id: false }) },
    ruleId: { type: Schema.Types.ObjectId, ref: "NotificationRule" },
    ruleName: { type: String, maxlength: 120 },
    expenseId: { type: Schema.Types.ObjectId, ref: "Expense" },
    requestNumber: { type: String, maxlength: 50 },
    anomalyType: { type: String, maxlength: 100 },
    anomalyName: { type: String, maxlength: 200 },
    severity: { type: String, maxlength: 30 },
    recipientId: { type: String, maxlength: 100 },
    recipientName: { type: String, maxlength: 200 },
    recipientEmail: { type: String, maxlength: 320 },
    channel: { type: String, maxlength: 20, required: true },
    title: { type: String, maxlength: 200 },
    body: { type: String, maxlength: 500 },
    status: { type: String, enum: NOTIFICATION_STATUSES, default: "queued" },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextAttemptAt: { type: Date, default: Date.now },
    lockedAt: { type: Date },
    deliveredAt: { type: Date },
    readAt: { type: Date },
    provider: { type: String, maxlength: 30 },
    // A safe code (never a provider's response text).
    lastErrorCode: { type: String, maxlength: 50 },
    // Escalation: which notification this one follows up; escalatedAt on the original.
    escalationOf: { type: Schema.Types.ObjectId, ref: "NotificationEvent" },
    escalatedAt: { type: Date },
    escalateAfter: { type: Date },
  },
  { timestamps: true, collection: "notificationEvents", versionKey: false, toJSON: toJSONOptions },
);

notificationEventSchema.index({ idempotencyKey: 1 }, { unique: true });
notificationEventSchema.index({ status: 1, nextAttemptAt: 1 });
// Employee inbox (own notifications only).
notificationEventSchema.index({ recipientId: 1, test: 1, status: 1, createdAt: -1 });
notificationEventSchema.index({ test: 1, createdAt: -1 });
notificationEventSchema.index({ escalateAfter: 1 }, { partialFilterExpression: { escalateAfter: { $type: "date" } } });

export const NotificationEvent = mongoose.model("NotificationEvent", notificationEventSchema);
