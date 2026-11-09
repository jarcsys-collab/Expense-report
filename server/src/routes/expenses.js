import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { validate, validateObjectId } from "../middleware/validate.js";
import { CLIENT_CREATE_STATUSES, EDITABLE_STATUSES, SAVED_PENDING_WORKFLOW_STATUS } from "../models/constants.js";
import { env } from "../config/env.js";
import { Category } from "../models/Category.js";
import { Expense } from "../models/Expense.js";
import { ReceiptJob } from "../models/ReceiptJob.js";
import { reportToViolations, runAnomalyCheck, VIOLATION_PREFIX } from "../services/anomaly/anomalyEngine.js";
import { employeeFromSession } from "../services/employeeIdentity.js";
import { assertExpenseAccess, expenseVisibilityFilter } from "../services/expenseAccess.js";
import {
  describeValue,
  OCR_FIELD_LABELS,
  syncOcrFieldReviews,
  unconfirmedOcrFields,
} from "../services/ocrFieldReview.js";
import { queueAnomalyNotifications } from "../services/notifications/notificationService.js";
import { buildOcrQuality } from "../services/ocrFieldStatus.js";
import { applyDateConfirmation, describeIsoDate } from "../services/receiptDate.js";
import { sendReceiptFile } from "../services/receiptFileStore.js";
import { expenseForViewer } from "../services/expenseView.js";
import { expenseCreateSchema, expenseListQuery, expenseUpdateSchema } from "../validation/expense.js";
import { missingForSubmission } from "../validation/submission.js";

export const expensesRouter = Router();
expensesRouter.use(requireDatabase);

const activity = (actor, action) => ({ id: randomUUID(), actor: actor || "Team member", action, createdAt: new Date() });

// Identity fields the browser may not change on an existing expense.
function withoutIdentity(expense, fields) {
  const { employee, employeeId, employeeName, ...rest } = fields;
  if (expense.employee?.provider === "entra") {
    delete rest.department;
    delete rest.position;
  }
  return expense.employee ? rest : fields;
}

// Records when the ExCom approval evidence details were provided (kept while unchanged).
function withEvidenceTimestamp(expense, fields) {
  if (!fields.excomEvidence) return fields;
  const before = expense?.excomEvidence;
  const same =
    before &&
    ["type", "reference", "fileName"].every((key) => (before[key] ?? "") === (fields.excomEvidence[key] ?? ""));
  return { ...fields, excomEvidence: { ...fields.excomEvidence, providedAt: same ? before.providedAt : new Date() } };
}

// Records which category (id and company policy key) the expense was saved
// under. Unknown names are left unlinked; submission validation rejects them.
async function linkCategory(expense) {
  const name = String(expense.category ?? "").trim();
  const category = name
    ? await Category.findOne({ name }, { policyKey: 1 }).collation({ locale: "en", strength: 2 }).lean()
    : null;
  expense.categoryId = category?._id;
  expense.policyKey = category ? (category.policyKey ?? null) : undefined;
}

// Loads an expense the signed-in user may see ("view") or change ("edit").
// Not visible → 404 (ids cannot be probed); visible but not changeable → 403.
async function findExpense(id, user, access = "view") {
  const expense = await Expense.findById(id);
  assertExpenseAccess(user, expense, access);
  return expense;
}

function assertEditable(expense) {
  if (!EDITABLE_STATUSES.includes(expense.status)) {
    throw new HttpError(409, "EXPENSE_LOCKED", `This request is ${expense.status.toLowerCase()} and can no longer be changed.`);
  }
}

async function findReceiptJob(receiptJobId) {
  if (!receiptJobId) return null;
  const job = await ReceiptJob.findById(receiptJobId);
  if (!job) throw new HttpError(400, "RECEIPT_JOB_NOT_FOUND", "The linked receipt scan was not found.");
  return job;
}

// Linking a receipt scan to an expense: only the account that uploaded it may
// link it. The file details recorded on the expense come from the scan itself.
// The original image/PDF stays with the scan in GridFS (never public), so the file
// entry has no URL: GET /api/expenses/:id/receipt serves it after an access check.
function linkReceiptJob(expense, job, user) {
  if (job.uploadedBy && job.uploadedBy !== user.id) {
    throw new HttpError(403, "RECEIPT_JOB_FORBIDDEN", "This receipt scan was uploaded by another account.");
  }
  expense.receiptJobId = job._id;
  const jobFileId = `job-${job._id.toHexString()}`;
  if (!expense.receiptFiles.some((file) => file.id === jobFileId)) {
    expense.receiptFiles = [
      {
        id: jobFileId,
        name: job.originalFileName,
        mimeType: job.mimeType,
        size: job.size ?? 0,
        url: "",
        pageNumber: 1,
        uploadedAt: job.createdAt,
      },
      // Browser-side copies of the same scan only carry a temporary preview link.
      ...expense.receiptFiles.filter((file) => /^https?:\/\//.test(file.url ?? "")),
    ];
  }
}

// The date review (printed date, readings) always comes from the receipt scan;
// the client can only confirm a date. A confirmation counts for that exact date.
function applyDateReview(expense, job, clientReview) {
  const scanned = job?.result?.dateReview;
  if (!scanned) {
    expense.dateReview = undefined;
    return;
  }
  const previous = expense.dateReview;
  const confirmedDate = clientReview?.confirmedDate !== undefined ? clientReview.confirmedDate : previous?.confirmedDate;
  expense.dateReview = applyDateConfirmation(
    { ...scanned, confirmedDate: previous?.confirmedDate ?? null, confirmedAt: previous?.confirmedAt },
    expense.expenseDate,
    confirmedDate,
  );
}

// Re-runs the anomaly check on the server's copy of the expense (the client's
// findings are never trusted) and stores the report, findings and duplicates.
async function applyAnomalyCheck(expense, job) {
  await linkCategory(expense);
  // From the stored scan, never the browser: VAT figures as printed, and how each
  // scanned field ended up (extracted, confirmed, corrected, provided or missing).
  expense.vatBreakdown = job?.result?.vatBreakdown;
  expense.ocrQuality = buildOcrQuality(expense, job);
  const report = await runAnomalyCheck({
    expense: expense.toObject(),
    stage: "submission",
    ocr: job?.ocrMeta ?? null,
    // Values as originally scanned (server copy), e.g. to detect a corrected total.
    ocrResult: job?.result ?? null,
    excludeId: expense._id,
  });
  const kept = expense.policyViolations.filter((v) => !v.id.startsWith(VIOLATION_PREFIX));
  expense.policyViolations = [...kept, ...reportToViolations(report, expense.policyViolations)];
  expense.possibleDuplicates = report.possibleDuplicates;
  expense.anomalyReport = report;
  return report;
}

// GET /api/expenses?status=&category=&employeeId=&limit=
expensesRouter.get("/", validate({ query: expenseListQuery }), async (req, res) => {
  const { limit, ...filters } = req.validatedQuery;
  const query = Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined));
  // Client filters only narrow what the user may see; they never widen it.
  const expenses = await Expense.find({ $and: [query, expenseVisibilityFilter(req.user)] })
    .sort({ createdAt: -1 })
    .limit(limit);
  res.json({ expenses: expenses.map((expense) => expenseForViewer(expense, req.user)) });
});

// POST /api/expenses
expensesRouter.post("/", validate({ body: expenseCreateSchema }), async (req, res) => {
  const { status, dateReview, ocrConfirmations, ...fields } = req.body;
  const job = await findReceiptJob(fields.receiptJobId);
  const expense = new Expense({
    ...withEvidenceTimestamp(null, fields),
    ...employeeFromSession(req.user, fields),
    receiptJobId: undefined,
    status: CLIENT_CREATE_STATUSES.includes(status) ? status : "Draft",
  });
  if (job) linkReceiptJob(expense, job, req.user);
  expense.incompleteDraft = fields.incompleteDraft === true && expense.status === "Draft" ? true : undefined;
  expense.requestNumber = `RF-${expense._id.toHexString().slice(-6).toUpperCase()}`;
  expense.activityLog.push(activity(req.user.name, job ? "Created expense from scanned receipt" : "Created expense"));
  applyDateReview(expense, job, dateReview);
  applyOcrFieldReviews(expense, job, req.user, ocrConfirmations);
  const report = await applyAnomalyCheck(expense, job);
  await expense.save();
  if (job && !job.expenseId) {
    job.expenseId = expense._id;
    await job.save();
  }
  await queueAnomalyNotifications({ expense, report, trigger: "save" });
  res.status(201).json(expenseForViewer(expense, req.user));
});

// GET /api/expenses/:id
expensesRouter.get("/:id", validateObjectId(), async (req, res) => {
  res.json(expenseForViewer(await findExpense(req.params.id, req.user), req.user));
});

// GET /api/expenses/:id/receipt: the original scanned receipt of an expense,
// for anyone who may view the expense (owner, assigned approver, Finance).
expensesRouter.get("/:id/receipt", validateObjectId(), async (req, res) => {
  const expense = await findExpense(req.params.id, req.user);
  const job = expense.receiptJobId ? await ReceiptJob.findById(expense.receiptJobId) : null;
  if (!(await sendReceiptFile(job, res))) {
    throw new HttpError(404, "RECEIPT_FILE_NOT_FOUND", "The original receipt file is not available for this request.");
  }
});

// PATCH /api/expenses/:id
// Only drafts and requests returned for correction can change. Status is
// owned by the workflow, so a status sent by the client is ignored here.
expensesRouter.patch("/:id", validateObjectId(), validate({ body: expenseUpdateSchema }), async (req, res) => {
  const expense = await findExpense(req.params.id, req.user, "edit");
  assertEditable(expense);
  const { status, dateReview, ocrConfirmations, ...fields } = req.body;
  if (fields.receiptJobId === "") delete fields.receiptJobId;
  const newJobId = fields.receiptJobId && fields.receiptJobId !== String(expense.receiptJobId ?? "") ? fields.receiptJobId : null;
  delete fields.receiptJobId;
  expense.set(withEvidenceTimestamp(expense, withoutIdentity(expense, fields)));
  // Any save the assistant does not mark as a check is the employee saving it.
  expense.incompleteDraft = fields.incompleteDraft === true && expense.status === "Draft" ? true : undefined;
  if (newJobId) linkReceiptJob(expense, await findReceiptJob(newJobId), req.user);
  const job = await findReceiptJob(expense.receiptJobId);
  applyDateReview(expense, job, dateReview);
  expense.activityLog.push(activity(req.user.name, "Updated expense"));
  applyOcrFieldReviews(expense, job, req.user, ocrConfirmations);
  const report = await applyAnomalyCheck(expense, job);
  await expense.save();
  await queueAnomalyNotifications({ expense, report, trigger: "save" });
  res.json(expenseForViewer(expense, req.user));
});

// Rebuilds the low-confidence OCR field reviews from the receipt scan and
// records the employee's confirmations (server identity and time) in the log.
function applyOcrFieldReviews(expense, job, user, ocrConfirmations) {
  // A currency change against the scan is kept in the audit trail (both values).
  const scannedCurrency = job?.result?.currency;
  // Only changes to an existing request (a new one starts from the scan).
  if (scannedCurrency && !expense.isNew && expense.isModified("currency")) {
    expense.activityLog.push(
      activity(
        user.name,
        expense.currency === scannedCurrency
          ? `Currency set to ${expense.currency}, matching the scanned receipt.`
          : `Currency changed from ${scannedCurrency} (scanned) to ${expense.currency}.`,
      ),
    );
  }
  for (const line of syncOcrFieldReviews(expense, job, user, ocrConfirmations)) {
    expense.activityLog.push(activity(user.name, line));
  }
}

// POST /api/expenses/:id/submit  { id, expense? }
// "Employee confirms → System runs anomaly check → Any anomaly?" (Anomalies_reference.pdf)
//   anomaly or unclear details → Pending Approval (route to Manager Approval)
//   none                       → Submitted (skip manager, route to Finance)
// Checks that could not run stay listed in anomalyReport.notEvaluated.
const submitSchema = z.object({ id: z.string().optional(), expense: expenseUpdateSchema.optional() });
expensesRouter.post("/:id/submit", validateObjectId(), validate({ body: submitSchema }), async (req, res) => {
  const expense = await findExpense(req.params.id, req.user, "edit");
  assertEditable(expense);
  // Duplicate-submission guard: the final save only applies while the expense is
  // still in the status read here, so a second concurrent submit (double click,
  // Retry after a lost response) cannot submit or log it twice.
  const statusAtStart = expense.status;
  let clientDateReview;
  let clientOcrConfirmations;
  if (req.body.expense) {
    const { status, dateReview, ocrConfirmations, ...fields } = req.body.expense;
    clientOcrConfirmations = ocrConfirmations;
    if (fields.receiptJobId === "") delete fields.receiptJobId;
    const newJobId = fields.receiptJobId && fields.receiptJobId !== String(expense.receiptJobId ?? "") ? fields.receiptJobId : null;
    delete fields.receiptJobId;
    expense.set(withEvidenceTimestamp(expense, withoutIdentity(expense, fields)));
    if (newJobId) linkReceiptJob(expense, await findReceiptJob(newJobId), req.user);
    clientDateReview = dateReview;
  }
  // Required details are checked by the server before anything is submitted.
  const missing = await missingForSubmission(expense);
  if (missing.length) {
    throw new HttpError(
      400,
      "SUBMISSION_INCOMPLETE",
      `Complete the required details before submitting. ${missing.map((item) => item.message).join(" ")}`,
      missing,
    );
  }
  const job = await findReceiptJob(expense.receiptJobId);
  applyDateReview(expense, job, clientDateReview);
  applyOcrFieldReviews(expense, job, req.user, clientOcrConfirmations);
  // An ambiguous receipt date must be confirmed by the employee before submission.
  if (expense.dateReview?.status === "needs_confirmation") {
    const { raw, candidates } = expense.dateReview;
    throw new HttpError(
      400,
      "DATE_NOT_CONFIRMED",
      `Confirm the receipt date before submitting. The receipt shows "${raw}", which can be ${describeIsoDate(candidates.dayMonthYear)} or ${describeIsoDate(candidates.monthDayYear)}.`,
    );
  }
  // Key receipt fields OCR was unsure about must be confirmed or corrected by the employee.
  const unconfirmed = unconfirmedOcrFields(expense);
  if (unconfirmed.length) {
    throw new HttpError(
      400,
      "OCR_FIELDS_NOT_CONFIRMED",
      `Confirm the receipt details that were hard to read before submitting: ${unconfirmed.map((r) => OCR_FIELD_LABELS[r.field]).join(", ")}.`,
      unconfirmed.map((review) => ({
        path: review.field,
        message: `Check the ${OCR_FIELD_LABELS[review.field]} against the receipt: it was read as ${describeValue(review.field, review.ocrValue, expense.currency)} with ${Math.round(review.ocrConfidence * 100)}% confidence.`,
        ocrValue: review.ocrValue,
        ocrConfidence: review.ocrConfidence,
      })),
    );
  }
  expense.incompleteDraft = undefined;
  const report = await applyAnomalyCheck(expense, job);
  const toManager = report.route === "manager_approval";
  if (!env.approvalWorkflowEnabled) {
    // Routing is switched off: every check above has run and its results are
    // kept, but the request is only saved to My Requests. It is never routed
    // automatically; once routing is enabled the employee submits it again.
    expense.status = SAVED_PENDING_WORKFLOW_STATUS;
    const pendingChecks = report.notEvaluated.length ? ` ${report.notEvaluated.length} check(s) could not run yet.` : "";
    expense.activityLog.push(
      activity(
        req.user.name,
        `Saved to My Requests. Approval routing is not set up yet, so it was not sent to a manager or Finance (the anomaly check would route it to ${toManager ? "Manager Approval" : "Finance"}).${pendingChecks}`,
      ),
    );
    expense.$where = { status: statusAtStart };
    try {
      await expense.save();
    } catch (error) {
      if (error?.name === "DocumentNotFoundError" || error?.name === "VersionError") {
        throw new HttpError(409, "ALREADY_SUBMITTED", "This request was already saved or changed. Refresh to see its current status.");
      }
      throw error;
    }
    await queueAnomalyNotifications({ expense, report, trigger: "submission" });
    res.json(expenseForViewer(expense, req.user));
    return;
  }
  expense.status = toManager ? "Pending Approval" : "Submitted";
  expense.submittedAt = new Date();
  const pending = report.notEvaluated.length ? ` ${report.notEvaluated.length} check(s) could not run yet.` : "";
  expense.activityLog.push(
    activity(
      req.user.name,
      toManager
        ? `Submitted. Anomaly check found items to review: routed to Manager Approval.${pending}`
        : `Submitted. No anomalies found in the checks that ran: manager review skipped, routed to Finance.${pending}`,
    ),
  );
  expense.$where = { status: statusAtStart };
  try {
    await expense.save();
  } catch (error) {
    // No match on {_id, status[, __v]}: another request already submitted or changed it.
    if (error?.name === "DocumentNotFoundError" || error?.name === "VersionError") {
      throw new HttpError(409, "ALREADY_SUBMITTED", "This expense was already submitted. Refresh to see its current status.");
    }
    throw error;
  }
  await queueAnomalyNotifications({ expense, report, trigger: "submission" });
  res.json(expenseForViewer(expense, req.user));
});

// DELETE /api/expenses/:id
expensesRouter.delete("/:id", validateObjectId(), async (req, res) => {
  const expense = await findExpense(req.params.id, req.user, "edit");
  assertEditable(expense);
  await expense.deleteOne();
  res.status(204).end();
});
