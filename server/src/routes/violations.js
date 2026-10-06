import { Router } from "express";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { Expense } from "../models/Expense.js";

export const violationsRouter = Router();

// GET /api/violations: expenses that have policy/anomaly findings
// (used by the Expense Issues page). Read-only.
violationsRouter.get("/", requireDatabase, async (req, res) => {
  const expenses = await Expense.find({ "policyViolations.0": { $exists: true } })
    .sort({ updatedAt: -1 })
    .limit(500);
  res.json({ expenses });
});
