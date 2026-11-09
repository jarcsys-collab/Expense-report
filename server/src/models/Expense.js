import mongoose from "mongoose";
import {
  EXPENSE_STATUSES,
  VIOLATION_SEVERITIES,
  VIOLATION_STATUSES,
} from "./constants.js";
import { EXCOM_EVIDENCE_TYPES, POLICY_CATEGORY_KEYS } from "../policy/expensePolicy.js";
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
    // Whether the match is the same employee's request. Other employees'
    // matches are shown only to Finance (services/expenseView.js).
    sameEmployee: { type: Boolean },
    employeeName: text(200),
  },
  embedded,
);

// Who owns the expense, taken from the server session when it is created
// (never from the browser). provider "entra" means a verified Microsoft account.
const employeeSchema = new Schema(
  {
    provider: { type: String, enum: ["entra", "beta", "dev"] },
    entraUserId: text(100),
    displayName: text(200),
    email: text(320),
    department: text(200),
    jobTitle: text(200),
  },
  embedded,
);

// Employee confirmation of a key receipt field OCR read with low confidence
// (services/ocrFieldReview.js). Server-maintained: the original OCR value and
// score come from the receipt scan, the identity from the session, the time
// from the server. Never accepted from the browser.
const ocrFieldReviewSchema = new Schema(
  {
    field: { type: String, enum: ["merchant", "expenseDate", "amount", "currency"], required: true },
    // low_confidence: read below the threshold; not_read: missing from the scan (currency).
    reason: { type: String, enum: ["low_confidence", "not_read"] },
    receiptJobId: { type: Schema.Types.ObjectId, ref: "ReceiptJob" },
    ocrValue: { type: Schema.Types.Mixed },
    ocrConfidence: { type: Number, min: 0, max: 1 },
    status: { type: String, enum: ["needs_confirmation", "confirmed", "corrected", "provided"], required: true },
    confirmedValue: { type: Schema.Types.Mixed },
    confirmedBy: { type: new Schema({ id: text(100), name: text(200) }, embedded), default: null },
    confirmedAt: { type: Date, default: null },
  },
  embedded,
);

// What the employee provides as proof of ExCom approval for representations of
// PHP 5,000 and above. Only these details are kept: ReceiptFlow does not store
// the file itself yet and does not verify its content.
const excomEvidenceSchema = new Schema(
  {
    type: { type: String, enum: EXCOM_EVIDENCE_TYPES },
    reference: text(500),
    fileName: text(255),
    mimeType: text(100),
    size: { type: Number, min: 0, default: 0 },
    providedAt: Date,
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
    // Server-maintained link to the category as it was when the expense was
    // saved: its id and company policy key. Kept as filed, so renaming,
    // remapping or deactivating a category later does not change history.
    categoryId: { type: Schema.Types.ObjectId, ref: "Category" },
    policyKey: { type: String, enum: [...POLICY_CATEGORY_KEYS, null] },
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
    // Server-controlled (never from the request body). Existing values are kept and
    // still give that approver read access. Future: set on submit by the server
    // from the employee's manager (e.g. Microsoft Graph /users/{id}/manager).
    assignedApproverId: text(100),
    employee: { type: employeeSchema },
    excomEvidence: { type: excomEvidenceSchema },

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
    // Low-confidence key fields and the employee's confirmations. Absent on
    // expenses without such fields (and on all older expenses).
    ocrFieldReviews: { type: [ocrFieldReviewSchema], default: undefined },
    // VAT figures as printed on the scanned receipt (VATable, exempt, zero-rated).
    // Server-maintained from the scan, never from the browser. Only figures that
    // were actually printed are present: absent is not the same as zero.
    vatBreakdown: { type: Schema.Types.Mixed },
    // How each scanned field ended up (extracted, confirmed, corrected, provided,
    // missing), for the review screen and OCR quality analytics. Server-maintained.
    // Absent on manual expenses and all older expenses.
    ocrQuality: { type: Schema.Types.Mixed },

    // Review and workflow
    policyViolations: { type: [violationSchema], default: [] },
    // Latest anomaly check (services/anomaly), including checks that could not
    // run and the routing decision (manager_approval | finance). Server-computed.
    anomalyReport: { type: Schema.Types.Mixed },
    possibleDuplicates: { type: [possibleDuplicateSchema], default: [] },
    comments: { type: [commentSchema], default: [] },
    activityLog: { type: [activitySchema], default: [] },
    duplicateOverrideReason: text(1000),
    // A draft the Reimbursement Assistant saved only so the server could run its
    // checks; the employee has not saved or submitted it yet. Cleared when the
    // employee saves it themselves or submits it. Incomplete drafts are not
    // counted as earlier expenses by the duplicate check and are left out of
    // Expense Issues. (Monthly policy totals never count drafts.)
    incompleteDraft: { type: Boolean },
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
expenseSchema.index({ "employee.entraUserId": 1, createdAt: -1 }, { partialFilterExpression: { "employee.entraUserId": { $type: "string" } } });
// OCR quality analytics: only expenses that carry a quality record are indexed.
expenseSchema.index({ createdAt: -1, "ocrQuality.provider": 1 }, { partialFilterExpression: { ocrQuality: { $type: "object" } } });

export const Expense = mongoose.model("Expense", expenseSchema);
