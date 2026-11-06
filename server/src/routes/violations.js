import { Router } from "express";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { Expense } from "../models/Expense.js";
import { expenseVisibilityFilter } from "../services/expenseAccess.js";
import { expenseForViewer } from "../services/expenseView.js";

export const violationsRouter = Router();

// GET /api/violations: expenses that have policy/anomaly findings
// (used by the Expense Issues page). Read-only. Incomplete assistant drafts
// are left out: the employee has not saved or submitted them.
violationsRouter.get("/", requireDatabase, async (req, res) => {
  // Only expenses the signed-in user may see (own; assigned for approvers; all for Finance).
  const expenses = await Expense.find({
    $and: [{ "policyViolations.0": { $exists: true }, incompleteDraft: { $ne: true } }, expenseVisibilityFilter(req.user)],
  })
    .sort({ updatedAt: -1 })
    .limit(500);
  res.json({ expenses: expenses.map((expense) => expenseForViewer(expense, req.user)) });
});
