import { randomUUID } from "node:crypto";
import { z } from "zod";
import { objectId } from "../middleware/validate.js";
import { EXPENSE_STATUSES, VIOLATION_SEVERITIES, VIOLATION_STATUSES } from "../models/constants.js";
import { EXCOM_EVIDENCE_TYPES } from "../policy/expensePolicy.js";

// Accepts the payload the frontend sends (src/services/normalizers.js toExpensePayload).
// Unknown keys (client ids, comments, activity log, ...) are stripped: the server owns them.

const text = (max = 500) => z.string().trim().max(max);
// Number inputs can arrive as null (NaN serialized by JSON.stringify); treat as 0.
const money = z.preprocess((v) => (v === null || v === "" ? 0 : v), z.number().finite().min(0).max(1e12));
const confidence = z.number().min(0).max(1);
const isoDay = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")]);
const itemId = z.string().trim().min(1).max(100).optional().transform((v) => v || randomUUID());
const httpUrl = z.union([z.literal(""), z.url({ protocol: /^https?$/ }).max(2048)]);

const receiptFile = z.object({
  id: itemId,
  name: text(255).default(""),
  mimeType: text(100).default(""),
  size: money.default(0),
  url: httpUrl.optional(),
  pageNumber: z.number().int().min(1).max(500).default(1),
  uploadedAt: z.coerce.date().optional(),
});

const lineItem = z.object({
  id: itemId,
  description: text(500).default(""),
  quantity: money.default(1),
  unitPrice: money.default(0),
  total: money.default(0),
  confidence: confidence.optional(),
  fieldConfidence: z.record(z.string().max(50), confidence).optional(),
});

const violation = z.object({
  id: itemId,
  type: text(200).default(""),
  severity: z.enum(VIOLATION_SEVERITIES).default("Warning"),
  message: text(1000).default(""),
  status: z.enum(VIOLATION_STATUSES).default("Open"),
  createdAt: z.coerce.date().optional(),
  resolutionReason: text(1000).optional(),
});

const transactionMatch = z.object({
  id: text(100).default(""),
  merchant: text(200).default(""),
  amount: money.default(0),
  date: isoDay.default(""),
  confidence: confidence.default(0),
  status: z.enum(["Suggested", "Matched", "Dismissed"]).default("Suggested"),
});

const fields = {
  status: z.enum(EXPENSE_STATUSES),
  merchant: text(200),
  merchantAddress: text(500),
  receiptNumber: text(100),
  expenseDate: isoDay,
  expenseTime: z.union([z.literal(""), z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "must be HH:MM")]),
  currency: z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter currency code"),
  subtotal: money,
  tax: money,
  serviceCharge: money,
  tip: money,
  discount: money,
  amount: money,
  paymentMethod: text(100),
  cardLastFour: z.union([z.literal(""), z.string().regex(/^\d{4}$/, "must be 4 digits")]),
  category: text(100),
  purpose: text(1000),
  location: text(200),
  notes: text(2000),
  costCenter: text(100),
  project: text(100),
  employeeId: text(100),
  employeeName: text(200),
  position: text(200),
  department: text(200),
  assignedApproverId: text(100),
  receiptId: text(100),
  // Links the expense to the OCR job it came from (ReceiptJob id).
  receiptJobId: z.union([z.literal(""), objectId]),
  // Only the employee's confirmation is accepted; the rest of the date review comes from the receipt scan.
  dateReview: z.object({ confirmedDate: z.union([isoDay, z.null()]).optional() }),
  receiptFiles: z.array(receiptFile).max(20),
  lineItems: z.array(lineItem).max(200),
  ocrStatus: text(30),
  ocrConfidence: z.record(z.string().max(50), confidence),
  originalOCR: z.record(z.string().max(50), z.union([z.string().max(1000), z.number()])),
  policyViolations: z.array(violation).max(50),
  duplicateOverrideReason: text(1000),
  // Set by the Reimbursement Assistant when it saves a draft only to run the checks.
  incompleteDraft: z.boolean(),
  transactionMatch: transactionMatch,
  // Proof of ExCom approval (representations of PHP 5,000 and above): details only.
  excomEvidence: z.union([
    z.null(),
    z.object({
      type: z.enum(EXCOM_EVIDENCE_TYPES),
      reference: text(500).default(""),
      fileName: text(255).default(""),
      mimeType: text(100).default(""),
      size: z.number().int().min(0).max(1e10).default(0),
    }),
  ]),
};

// Also accept the generic names date/total/employee/confidence/violations.
const ALIASES = {
  date: "expenseDate",
  total: "amount",
  employee: "employeeName",
  confidence: "ocrConfidence",
  violations: "policyViolations",
};
const withAliases = (schema) =>
  z.preprocess((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const out = { ...input };
    for (const [alias, field] of Object.entries(ALIASES)) {
      if (out[alias] !== undefined && out[field] === undefined) out[field] = out[alias];
      delete out[alias];
    }
    return out;
  }, schema);

export const expenseCreateSchema = withAliases(z.object(fields).partial());
export const expenseUpdateSchema = withAliases(z.object(fields).partial());

export const expenseListQuery = z.object({
  status: z.enum(EXPENSE_STATUSES).optional(),
  category: text(100).optional(),
  employeeId: text(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
