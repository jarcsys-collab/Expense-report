// Single entry point the UI uses for backend calls.
// Every call waits for the session check and fails with a clear message when
// no backend is connected or the user is not signed in.
import { config } from "../config/appConfig";
import { requireSession } from "./authService";
import * as categories from "./categoryService";
import * as expenses from "./expenseService";
import * as policy from "./policyService";
import * as receipts from "./receiptService";
import * as violations from "./violationService";

const methods = {
  getExpenses: expenses.getExpenses,
  getExpense: expenses.getExpense,
  createExpense: expenses.createExpense,
  updateExpense: expenses.updateExpense,
  deleteExpense: expenses.deleteExpense,
  submitExpense: expenses.submitExpense,
  approveExpense: expenses.approveExpense,
  rejectExpense: expenses.rejectExpense,
  requestChanges: expenses.requestChanges,
  addExpenseComment: expenses.addExpenseComment,
  resolveViolation: expenses.resolveViolation,
  deleteFile: expenses.deleteFile,
  getCategories: categories.getCategories,
  saveCategory: categories.saveCategory,
  getPolicy: policy.getPolicy,
  checkPolicy: policy.checkPolicy,
  getViolations: violations.getViolations,
  uploadReceipt: receipts.uploadReceipt,
  getOCRStatus: receipts.getOcrStatus,
  saveEditedFile: receipts.saveEditedFile,
};

export const api = Object.fromEntries(
  Object.entries(methods).map(([name, method]) => [
    name,
    (...args) =>
      // Deferred by a microtask on purpose: child components call the API from
      // effects that run before WorkspaceProvider's effect starts the session
      // check, and requireSession() must see that in-flight check.
      Promise.resolve().then(async () => {
        // Checked before the session so the message is the same as the deployed build.
        if (name === "uploadReceipt" && !config.receiptUploadEnabled) {
          throw new Error(receipts.RECEIPT_UPLOAD_DISABLED_MESSAGE);
        }
        await requireSession();
        return method(...args);
      }),
  ]),
);
