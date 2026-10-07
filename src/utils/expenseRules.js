import { config } from "../config/appConfig";
import { normalizeExpense } from "../services/normalizers";

export function findDuplicate(expense, expenses) {
  return (
    expenses.find(
      (candidate) =>
        !!expense.merchant.trim() &&
        candidate.id !== expense.id &&
        candidate.merchant.trim().toLowerCase() ===
          expense.merchant.trim().toLowerCase() &&
        ((candidate.expenseDate === expense.expenseDate &&
          candidate.amount === expense.amount &&
          candidate.currency === expense.currency) ||
          (!!expense.receiptNumber &&
            candidate.receiptNumber === expense.receiptNumber)),
    ) || expense.possibleDuplicates?.[0]
  );
}
export function validateExpense(expense, categories) {
  const category = categories.find(
    (category) => category.name === expense.category,
  );
  return [
    !expense.employeeName.trim() && "Employee name is required.",
    // A verified Microsoft identity is read-only: an empty department or job
    // title in the Microsoft profile cannot be typed in by the employee.
    !expense.identityVerified &&
      !expense.position.trim() &&
      "Position / role is required.",
    !expense.identityVerified &&
      !expense.department.trim() &&
      "Department is required.",
    !expense.location.trim() && "Location is required.",
    !expense.merchant.trim() && "Merchant is required.",
    (!/^\d{4}-\d{2}-\d{2}$/.test(expense.expenseDate) ||
      !Number.isFinite(Date.parse(expense.expenseDate)) ||
      new Date(expense.expenseDate).toISOString().slice(0, 10) !==
        expense.expenseDate) &&
      "A valid receipt date is required.",
    // A printed date like 10/03/2026 can be read two ways; the employee must pick one.
    expense.dateReview?.ambiguous &&
      expense.dateReview.confirmedDate !== expense.expenseDate &&
      "Confirm the receipt date: the printed date can be read as day/month or month/day.",
    (!Number.isFinite(expense.amount) || expense.amount <= 0) &&
      "Total must be greater than zero.",
    !expense.currency && "Currency is required.",
    !category && "Choose a valid category.",
    category?.purposeRequired &&
      !expense.purpose.trim() &&
      "Business purpose is required.",
    category?.receiptRequired &&
      !expense.receiptFiles.length &&
      "A receipt is required.",
    expense.lineItems.some(
      (lineItem) =>
        !lineItem.description.trim() ||
        !Number.isFinite(lineItem.quantity) ||
        lineItem.quantity <= 0 ||
        !Number.isFinite(lineItem.unitPrice) ||
        lineItem.unitPrice < 0 ||
        !Number.isFinite(lineItem.total) ||
        lineItem.total < 0,
    ) &&
      "Each line item needs a description, positive quantity and valid nonnegative prices.",
  ].filter(Boolean);
}
export function validateCategory(category, categories) {
  return [
    !category.name.trim() && "Enter a category name.",
    categories.some(
      (category2) =>
        category2.id !== category.id &&
        category2.name.trim().toLowerCase() ===
          category.name.trim().toLowerCase(),
    ) && "A category with this name already exists.",
    (!Number.isFinite(category.limit) || category.limit < 0) &&
      "Enter a valid limit of zero or more.",
    !/^[A-Z]{3}$/.test(category.currency) && "Choose a valid currency.",
  ].filter(Boolean);
}
export function runPolicyChecks(expense, expenses, categories) {
  const category = categories.find(
    (category) => category.name === expense.category,
  );
  const duplicate = findDuplicate(expense, expenses);
  const calculatedTotal =
    expense.subtotal +
    expense.tax +
    expense.serviceCharge +
    expense.tip -
    expense.discount;
  const checks = [
    {
      ruleId: "receipt",
      name: "Missing receipt",
      severity: "Warning",
      message: "Attach a receipt before submitting this expense.",
      passed: !category?.receiptRequired || expense.receiptFiles.length > 0,
    },
    {
      ruleId: "purpose",
      name: "Missing purpose",
      severity: "Informational",
      message: "Add the business reason for this expense.",
      passed: !category?.purposeRequired || !!expense.purpose.trim(),
    },
    {
      ruleId: "category",
      name: "Out-of-policy category",
      severity: "Warning",
      message: "Choose a category recognized by your organization.",
      passed: !!category,
    },
    {
      ruleId: "ocr",
      name: "OCR uncertainty",
      severity: "Informational",
      message:
        "Check the fields marked Needs review against the original receipt. You can continue after reviewing them.",
      passed: !Object.values(expense.ocrConfidence).some(
        (value) => value < config.confidence,
      ),
    },
    {
      ruleId: "future",
      name: "Future receipt date",
      severity: "Warning",
      message: "Receipt date is in the future.",
      passed: expense.expenseDate <= new Date().toISOString().slice(0, 10),
    },
    {
      ruleId: "age",
      name: "Expense age limit",
      severity: "Warning",
      message: "Receipt is more than 30 days old.",
      passed:
        Date.now() - new Date(expense.expenseDate).getTime() <= 30 * 864e5,
    },
    {
      ruleId: "total",
      name: "Total discrepancy",
      severity: "Warning",
      message: "Subtotal, tax, charges and discounts do not match the total.",
      passed: Math.abs(calculatedTotal - expense.amount) < 0.02,
    },
    {
      ruleId: "limit",
      name: "Category limit",
      severity: "Warning",
      message: `Amount exceeds the ${category?.name} policy limit.`,
      passed:
        !category ||
        category.currency !== expense.currency ||
        expense.amount <= category.limit,
    },
    {
      ruleId: "duplicate",
      name: "Possible duplicate receipt",
      severity: "Warning",
      message: duplicate
        ? `Potential match: ${duplicate.requestNumber}, ${duplicate.merchant}, ${duplicate.expenseDate}.`
        : "",
      passed: !duplicate || !!expense.duplicateOverrideReason,
    },
  ];
  const hasBreakdown = [
    expense.subtotal,
    expense.tax,
    expense.serviceCharge,
    expense.tip,
    expense.discount,
  ].some((item) => item !== 0);
  return checks.filter((check) => check.ruleId !== "total" || hasBreakdown);
}
export function focusExpenseField(field) {
  const element = document.getElementById(`expense-${field}`);
  if (!element) {
    return;
  }
  let parent = element.parentElement;
  while (parent) {
    if (parent instanceof HTMLDetailsElement) {
      parent.open = true;
    }
    parent = parent.parentElement;
  }
  element.scrollIntoView({
    behavior: "smooth",
    block: "center",
  });
  element.focus({
    preventScroll: true,
  });
}
export const RULE_FIELDS = {
  receipt: "receipt",
  purpose: "purpose",
  category: "category",
  ocr: "merchant",
  future: "expenseDate",
  age: "expenseDate",
  total: "subtotal",
  limit: "amount",
  duplicate: "duplicate",
};
export function fieldForMessage(message) {
  return (
    [
      ["Employee", "employeeName"],
      ["Position", "position"],
      ["Department", "department"],
      ["Location", "location"],
      ["Merchant", "merchant"],
      ["receipt date", "expenseDate"],
      ["Total", "amount"],
      ["Currency", "currency"],
      ["category", "category"],
      ["purpose", "purpose"],
      ["duplicate", "duplicate"],
      ["receipt", "receipt"],
      ["line item", "lineItems"],
    ].find(([keyword]) => message.includes(keyword))?.[1] || "details"
  );
}
export function createBlankExpense(user) {
  const expense = normalizeExpense(
    {
      status: "Draft",
      merchant: "",
      amount: 0,
      expenseDate: "",
      category: "",
      purpose: "",
      location: "",
      position: user.position || "",
    },
    {
      user,
    },
  );
  expense.requestNumber = "Unsaved expense";
  expense.ocrStatus = "not_scanned";
  expense.ocrConfidence = {};
  return expense;
}
