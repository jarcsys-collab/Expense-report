import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { validate, validateObjectId } from "../middleware/validate.js";
import { CLIENT_CREATE_STATUSES, EDITABLE_STATUSES } from "../models/constants.js";
import { Category } from "../models/Category.js";
import { Expense } from "../models/Expense.js";
import { ReceiptJob } from "../models/ReceiptJob.js";
import { reportToViolations, runAnomalyCheck, VIOLATION_PREFIX } from "../services/anomaly/anomalyEngine.js";
import { employeeFromSession } from "../services/employeeIdentity.js";
import { applyDateConfirmation, describeIsoDate } from "../services/receiptDate.js";
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

async function findExpense(id) {
  const expense = await Expense.findById(id);
  if (!expense) throw new HttpError(404, "EXPENSE_NOT_FOUND", "Expense not found.");
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
// The original image/PDF is not stored by ReceiptFlow (only these details and
// the OCR job), so the file entry has no URL.
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
  const report = await runAnomalyCheck({
    expense: expense.toObject(),
    stage: "submission",
    ocr: job?.ocrMeta ?? null,
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
  const expenses = await Expense.find(query).sort({ createdAt: -1 }).limit(limit);
  res.json({ expenses });
});

// POST /api/expenses
expensesRouter.post("/", validate({ body: expenseCreateSchema }), async (req, res) => {
  const { status, dateReview, ...fields } = req.body;
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
  await applyAnomalyCheck(expense, job);
  await expense.save();
  if (job && !job.expenseId) {
    job.expenseId = expense._id;
    await job.save();
  }
  res.status(201).json(expense);
});

// GET /api/expenses/:id
expensesRouter.get("/:id", validateObjectId(), async (req, res) => {
  res.json(await findExpense(req.params.id));
});

// PATCH /api/expenses/:id
// Only drafts and requests returned for correction can change. Status is
// owned by the workflow, so a status sent by the client is ignored here.
expensesRouter.patch("/:id", validateObjectId(), validate({ body: expenseUpdateSchema }), async (req, res) => {
  const expense = await findExpense(req.params.id);
  assertEditable(expense);
  const { status, dateReview, ...fields } = req.body;
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
  await applyAnomalyCheck(expense, job);
  await expense.save();
  res.json(expense);
});

// POST /api/expenses/:id/submit  { id, expense? }
// "Employee confirms → System runs anomaly check → Any anomaly?" (Anomalies_reference.pdf)
//   anomaly or unclear details → Pending Approval (route to Manager Approval)
//   none                       → Submitted (skip manager, route to Finance)
// Checks that could not run stay listed in anomalyReport.notEvaluated.
const submitSchema = z.object({ id: z.string().optional(), expense: expenseUpdateSchema.optional() });
expensesRouter.post("/:id/submit", validateObjectId(), validate({ body: submitSchema }), async (req, res) => {
  const expense = await findExpense(req.params.id);
  assertEditable(expense);
  let clientDateReview;
  if (req.body.expense) {
    const { status, dateReview, ...fields } = req.body.expense;
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
  // An ambiguous receipt date must be confirmed by the employee before submission.
  if (expense.dateReview?.status === "needs_confirmation") {
    const { raw, candidates } = expense.dateReview;
    throw new HttpError(
      400,
      "DATE_NOT_CONFIRMED",
      `Confirm the receipt date before submitting. The receipt shows "${raw}", which can be ${describeIsoDate(candidates.dayMonthYear)} or ${describeIsoDate(candidates.monthDayYear)}.`,
    );
  }
  expense.incompleteDraft = undefined;
  const report = await applyAnomalyCheck(expense, job);
  const toManager = report.route === "manager_approval";
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
  await expense.save();
  res.json(expense);
});

// DELETE /api/expenses/:id
expensesRouter.delete("/:id", validateObjectId(), async (req, res) => {
  const expense = await findExpense(req.params.id);
  assertEditable(expense);
  await expense.deleteOne();
  res.status(204).end();
});
