// Required details for submitting an expense (Save Draft accepts incomplete
// expenses). This is the server's own check: the frontend runs the same rules
// for instant feedback, and the messages match so the form can point at the
// field. Checked on the server's copy of the expense, never on client claims.
import { Category } from "../models/Category.js";

const isRealDay = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const blank = (value) => !String(value ?? "").trim();

// Returns [{ path, message }] for every missing or invalid required detail.
export async function missingForSubmission(expense) {
  // A verified Microsoft identity is read-only: an empty department or job
  // title in the Microsoft profile cannot be fixed by the employee, so it does
  // not block submission. Other identities must provide them.
  const verified = expense.employee?.provider === "entra";
  // Only active categories can be chosen for a submission.
  const category = blank(expense.category)
    ? null
    : await Category.exists({ name: expense.category.trim(), active: { $ne: false } });
  const hasReceipt = Boolean(expense.receiptJobId) || (expense.receiptFiles?.length ?? 0) > 0;
  return [
    blank(expense.employeeName) && ["employeeName", "Employee name is required."],
    !verified && blank(expense.position) && ["position", "Position / role is required."],
    !verified && blank(expense.department) && ["department", "Department is required."],
    !isRealDay(expense.expenseDate) && ["expenseDate", "A valid receipt date is required."],
    !category && ["category", "Choose a valid category."],
    !(Number.isFinite(expense.amount) && expense.amount > 0) && ["amount", "Total must be greater than zero."],
    blank(expense.purpose) && ["purpose", "Business purpose is required."],
    blank(expense.location) && ["location", "Location is required."],
    !hasReceipt && ["receipt", "A receipt is required."],
  ]
    .filter(Boolean)
    .map(([path, message]) => ({ path, message }));
}
