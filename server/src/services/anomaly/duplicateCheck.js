// "Possible duplicate claim detected" → "ai crosschecks previous submissions"
// (Anomalies_reference.pdf). Deterministic match against saved expenses.
import { Expense } from "../../models/Expense.js";

const caseInsensitive = { locale: "en", strength: 2 };

/**
 * Previous expenses that look like the same claim:
 *   same merchant AND (same receipt/invoice number OR same date + amount + currency),
 *   or, without a merchant, same receipt number + amount.
 * Returns [] when nothing matches, or null when the check could not run.
 */
export async function findPossibleDuplicates(expense, { excludeId } = {}) {
  const merchant = String(expense.merchant || "").trim();
  const receiptNumber = String(expense.receiptNumber || "").trim();
  const amount = Number(expense.amount);
  const hasAmount = Number.isFinite(amount) && amount > 0;
  const sameDayAmount =
    expense.expenseDate && hasAmount ? { expenseDate: expense.expenseDate, amount, currency: expense.currency } : null;

  let query;
  if (merchant) {
    const alternatives = [receiptNumber ? { receiptNumber } : null, sameDayAmount].filter(Boolean);
    if (!alternatives.length) return [];
    query = { merchant, $or: alternatives };
  } else if (receiptNumber && hasAmount) {
    query = { receiptNumber, amount };
  } else {
    return [];
  }
  if (excludeId) query._id = { $ne: excludeId };

  try {
    const matches = await Expense.find(query)
      .collation(caseInsensitive)
      .sort({ createdAt: -1 })
      .limit(5)
      .select("requestNumber merchant amount currency expenseDate receiptNumber status");
    return matches.map((m) => ({
      id: String(m._id),
      requestNumber: m.requestNumber,
      merchant: m.merchant,
      amount: m.amount,
      currency: m.currency,
      expenseDate: m.expenseDate,
      receiptNumber: m.receiptNumber,
      status: m.status,
    }));
  } catch (error) {
    console.error(`Duplicate check failed: ${error.name}`);
    return null;
  }
}
