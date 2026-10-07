import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { validate } from "../middleware/validate.js";
import { Expense } from "../models/Expense.js";
import { expensePolicy } from "../policy/expensePolicy.js";
import { evaluateExpensePolicy } from "../policy/policyService.js";
import { employeeFromSession } from "../services/employeeIdentity.js";
import { expenseUpdateSchema } from "../validation/expense.js";

export const policyRouter = Router();

// GET /api/policy: the company expense policy, for display (category keys and
// labels, ExCom evidence types). The server remains the only place it is applied.
policyRouter.get("/", (req, res) => {
  res.json({ policy: expensePolicy });
});

const checkSchema = z.object({
  expenseId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  expense: expenseUpdateSchema,
});

// POST /api/policy/check  { expenseId?, expense }
// Previews the company policy result for the values on the review screen,
// without saving. The owner's job title always comes from the server: the
// stored expense's owner, or the signed-in user for a new expense.
policyRouter.post("/check", requireDatabase, validate({ body: checkSchema }), async (req, res) => {
  const { expenseId, expense: fields } = req.body;
  let owner;
  if (expenseId) {
    const stored = await Expense.findById(expenseId).lean();
    if (!stored) throw new HttpError(404, "EXPENSE_NOT_FOUND", "Expense not found.");
    if (stored.employeeId !== req.user.id && req.user.role === "EMPLOYEE") {
      throw new HttpError(403, "FORBIDDEN", "You do not have permission to do this.");
    }
    owner = { employeeId: stored.employeeId, employee: stored.employee, position: stored.position };
  } else {
    const { employeeId, employee, position } = employeeFromSession(req.user, fields);
    owner = { employeeId, employee, position };
  }
  const expense = {
    category: fields.category ?? "",
    amount: fields.amount,
    currency: fields.currency || expensePolicy.currency,
    expenseDate: fields.expenseDate ?? "",
    excomEvidence: fields.excomEvidence ?? null,
    ...owner,
  };
  const result = await evaluateExpensePolicy({ expense, stage: "submission", excludeId: expenseId });
  res.json(result);
});
