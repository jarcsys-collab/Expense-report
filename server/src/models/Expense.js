import mongoose from "mongoose";
import {
  EXPENSE_STATUSES,
  VIOLATION_SEVERITIES,
  VIOLATION_STATUSES,
} from "./constants.js";
import { toJSONOptions } from "./toJSON.js";

// Field names follow the frontend's expense shape (src/services/normalizers.js):
// expenseDate (receipt date), amount (receipt total), employeeName (employee),
// ocrConfidence (per-field OCR confidence), policyViolations (policy findings).
// Embedded items keep the frontend's string `id` instead of a Mongo `_id`.
const embedded = { _id: false, id: false };
const { Schema } = mongoose;
const money = { type: Number, min: 0, default: 0 };
const text = (maxlength = 500) => ({ type: String, trim: true, maxlength, default: "" });

const receiptFileSchema = new Schema(
  {
    id: { type: String, required: true },
    name: text(255),
    mimeType: text(100),
    size: { type: Number, min: 0, default: 0 },
    url: text(2048),
    pageNumber: { type: Number, min: 1, default: 1 },
    uploadedAt: { type: Date, default: Date.now },
  },
  embedded,
);

const lineItemSchema = new Schema(
  {
    id: { type: String, required: true },
    description: text(500),
    quantity: { type: Number, min: 0, default: 1 },
    unitPrice: money,
    total: money,
    confidence: { type: Number, min: 0, max: 1 },
    fieldConfidence: { type: Map, of: Number },
  },
  embedded,
);

const commentSchema = new Schema(
  {
    id: { type: String, required: true },
    userId: text(100),
    userName: text(200),
    role: text(50),
    message: text(4000),
    createdAt: { type: Date, default: Date.now },
  },
  embedded,
);
commentSchema.add({ replies: { type: [commentSchema], default: [] } });

const violationSchema = new Schema(
  {
    id: { type: String, required: true },
    type: text(200),
    severity: { type: String, enum: VIOLATION_SEVERITIES, default: "Warning" },
    message: text(1000),
    status: { type: String, enum: VIOLATION_STATUSES, default: "Open" },
    createdAt: { type: Date, default: Date.now },
    resolutionReason: text(1000),
  },
  embedded,
);

const activitySchema = new Schema(
  {
    id: { type: String, required: true },
    actor: text(200),
    action: text(500),
    createdAt: { type: Date, default: Date.now },
  },
  embedded,
);

const transactionMatchSchema = new Schema(
  {
    id: text(100),
    merchant: text(200),
    amount: money,
    date: text(10),
    confidence: { type: Number, min: 0, max: 1, default: 0 },
    status: { type: String, enum: ["Suggested", "Matched", "Dismissed"], default: "Suggested" },
  },
  embedded,
);

const possibleDuplicateSchema = new Schema(
  {
    id: text(100),
    requestNumber: text(50),
    merchant: text(200),
    amount: money,
    currency: text(3),
    expenseDate: text(10),
    receiptNumber: text(100),
  },
  embedded,
);

const expenseSchema = new Schema(
  {
    requestNumber: { type: String, trim: true, maxlength: 50 },
    status: { type: String, enum: EXPENSE_STATUSES, default: "Draft", index: true },

    // Receipt details
    merchant: text(200),
    merchantAddress: text(500),
    receiptNumber: text(100),
    expenseDate: text(10), // YYYY-MM-DD, kept as a string like the frontend
    expenseTime: text(10),
    currency: { type: String, match: /^[A-Z]{3}$/, default: "PHP" },
    subtotal: money,
    tax: money,
    serviceCharge: money,
    tip: money,
    discount: money,
    amount: money,
    paymentMethod: text(100),
    cardLastFour: text(4),

    // Business context
    category: text(100),
    purpose: text(1000),
    location: text(200),
    notes: text(2000),
    costCenter: text(100),
    project: text(100),

    // Employee
    employeeId: text(100),
    employeeName: text(200),
    position: text(200),
    department: text(200),
    assignedApproverId: text(100),

    receiptId: text(100),
    receiptFiles: { type: [receiptFileSchema], default: [] },
    lineItems: { type: [lineItemSchema], default: [] },

    // OCR
    ocrStatus: text(30),
    ocrConfidence: { type: Map, of: Number, default: {} },
    originalOCR: { type: Schema.Types.Mixed },
    receiptJobId: { type: Schema.Types.ObjectId, ref: "ReceiptJob" },
    // Receipt date as printed, its possible readings and the employee's
    // confirmation (services/receiptDate.js). Server-maintained.
    dateReview: { type: Schema.Types.Mixed },

    // Review and workflow
    policyViolations: { type: [violationSchema], default: [] },
    // Latest anomaly check (services/anomaly), including checks that could not
    // run and the routing decision (manager_approval | finance). Server-computed.
    anomalyReport: { type: Schema.Types.Mixed },
    possibleDuplicates: { type: [possibleDuplicateSchema], default: [] },
    comments: { type: [commentSchema], default: [] },
    activityLog: { type: [activitySchema], default: [] },
    duplicateOverrideReason: text(1000),
    transactionMatch: { type: transactionMatchSchema },
    submittedAt: Date,
    approvedAt: Date,
    approvedBy: text(200),
    rejectedAt: Date,
    rejectedBy: text(200),
    rejectionReason: text(1000),
  },
  { timestamps: true, collection: "expenses", toJSON: toJSONOptions },
);

expenseSchema.index({ createdAt: -1 });
expenseSchema.index({ employeeId: 1, createdAt: -1 });

export const Expense = mongoose.model("Expense", expenseSchema);
