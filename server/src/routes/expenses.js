import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { validate, validateObjectId } from "../middleware/validate.js";
import { CLIENT_CREATE_STATUSES, EDITABLE_STATUSES } from "../models/constants.js";
import { Expense } from "../models/Expense.js";
import { ReceiptJob } from "../models/ReceiptJob.js";
import { reportToViolations, runAnomalyCheck, VIOLATION_PREFIX } from "../services/anomaly/anomalyEngine.js";
import { applyDateConfirmation, describeIsoDate } from "../services/receiptDate.js";
import { expenseCreateSchema, expenseListQuery, expenseUpdateSchema } from "../validation/expense.js";

export const expensesRouter = Router();
expensesRouter.use(requireDatabase);

const activity = (actor, action) => ({ id: randomUUID(), actor: actor || "Team member", action, createdAt: new Date() });

// Expense ownership comes from the server session, never from the browser.
// Verified Microsoft accounts own their name, email, department and job title;
// the temporary beta account still types department and position itself.
function employeeFromSession(user, fields) {
  const verified = user.provider === "entra";
  const department = verified ? user.department : fields.department || "";
  const jobTitle = verified ? user.jobTitle : fields.position || "";
  return {
    employeeId: user.id,
    employeeName: user.name,
    department,
    position: jobTitle,
    employee: {
      provider: user.provider,
      entraUserId: verified ? user.id : "",
      displayName: user.name,
      email: user.email || "",
      department,
      jobTitle,
    },
  };
}

// Identity fields the browser may not change on an existing expense.
function withoutIdentity(expense, fields) {
  const { employee, employeeId, employeeName, ...rest } = fields;
  if (expense.employee?.provider === "entra") {
    delete rest.department;
    delete rest.position;
  }
  return expense.employee ? rest : fields;
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
    ...fields,
    ...employeeFromSession(req.user, fields),
    receiptJobId: job?._id,
    status: CLIENT_CREATE_STATUSES.includes(status) ? status : "Draft",
  });
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
  expense.set(withoutIdentity(expense, fields));
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
    expense.set(withoutIdentity(expense, fields));
    clientDateReview = dateReview;
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
