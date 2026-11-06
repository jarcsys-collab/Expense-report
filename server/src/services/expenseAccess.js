// Who may see and change which expense. Identity and role always come from the
// authenticated server session (req.user), never from the request.
//
//   EMPLOYEE       own expenses only
//   APPROVER       own expenses, plus (read-only) expenses assigned to them
//                  (assignedApproverId), as the Approvals page shows
//   FINANCE_ADMIN  every expense; may edit, submit or delete editable ones
//                  (matches the frontend's ReviewPage / ExpenseDrawer rules)
//
// An expense the user may not see answers 404 (not 403), so ids cannot be
// probed. One they may see but not change answers 403.
import { HttpError } from "../middleware/errorHandler.js";

const isFinance = (user) => user?.role === "FINANCE_ADMIN";
const sameId = (a, b) => Boolean(a) && Boolean(b) && String(a) === String(b);

export const isOwner = (user, expense) => sameId(expense?.employeeId, user?.id);

export function canViewExpense(user, expense) {
  if (!user?.id || !expense) return false;
  if (isFinance(user) || isOwner(user, expense)) return true;
  return user.role === "APPROVER" && sameId(expense.assignedApproverId, user.id);
}

export function canEditExpense(user, expense) {
  if (!user?.id || !expense) return false;
  return isFinance(user) || isOwner(user, expense);
}

/** MongoDB filter limiting a list to the expenses this user may see. */
export function expenseVisibilityFilter(user) {
  if (!user?.id) return { _id: null }; // matches nothing
  if (isFinance(user)) return {};
  if (user.role === "APPROVER") return { $or: [{ employeeId: user.id }, { assignedApproverId: user.id }] };
  return { employeeId: user.id };
}

/** Throws 404 when the user may not see the expense, 403 when they may see but not change it. */
export function assertExpenseAccess(user, expense, access = "view") {
  if (!expense || !canViewExpense(user, expense)) {
    throw new HttpError(404, "EXPENSE_NOT_FOUND", "Expense not found.");
  }
  if (access === "edit" && !canEditExpense(user, expense)) {
    throw new HttpError(403, "FORBIDDEN", "You do not have permission to change this expense.");
  }
}

/** Receipt scans: the uploader, or Finance. Others get 404. */
export function assertReceiptJobAccess(user, job) {
  if (!job || !(isFinance(user) || sameId(job.uploadedBy, user?.id))) {
    throw new HttpError(404, "RECEIPT_JOB_NOT_FOUND", "Receipt job not found.");
  }
}
