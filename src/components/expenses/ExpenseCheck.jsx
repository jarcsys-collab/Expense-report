import { CircleCheck, Info, TriangleAlert } from "lucide-react";
import {
  RULE_FIELDS,
  fieldForMessage,
  findDuplicate,
  focusExpenseField,
  runPolicyChecks,
  validateExpense,
} from "../../utils/expenseRules";
import { formatCurrency } from "../../utils/format";

export function ExpenseCheck({
  expense,
  all: expenses,
  categories,
  editable = false,
}) {
  const missingDetails = editable ? validateExpense(expense, categories) : [];
  const duplicate = findDuplicate(expense, expenses);
  const failedChecks = editable
    ? runPolicyChecks(expense, expenses, categories).filter(
        (item) => !item.passed,
      )
    : [];
  const reportedFindings = expense.policyViolations.filter(
    (violation) =>
      violation.status === "Open" &&
      (!editable || !violation.id.startsWith("policy-")),
  );
  const findingCount = failedChecks.length + reportedFindings.length;
  const category = categories.find(
    (category) => category.name === expense.category,
  );
  const focusField = (field) => focusExpenseField(field);
  return (
    <section
      className="expense-check panel form-panel"
      id="expense-check"
      tabIndex={-1}
      aria-label="Expense Check"
    >
      <div className="form-title">
        <h3>
          <TriangleAlert size={18} />
          {" Expense Check"}
        </h3>
        <span className="muted">
          {findingCount
            ? `${findingCount} ${findingCount === 1 ? "finding" : "findings"}`
            : "No reported findings"}
        </span>
      </div>
      {editable && (
        <div className="health-summary">
          <button type="button" onClick={() => focusField("receipt")}>
            <Info size={16} />
            <span>
              Receipt
              <strong>
                {expense.receiptFiles.length
                  ? "Attached · verify image"
                  : "Not attached"}
              </strong>
            </span>
          </button>
          <button type="button" onClick={() => focusField("details")}>
            {missingDetails.length ? (
              <TriangleAlert size={16} />
            ) : (
              <CircleCheck size={16} />
            )}
            <span>
              Required details
              <strong>
                {missingDetails.length
                  ? `${missingDetails.length} need attention`
                  : "Complete"}
              </strong>
            </span>
          </button>
          <button
            type="button"
            onClick={() => focusField(duplicate ? "duplicate" : "check")}
          >
            <Info size={16} />
            <span>
              Duplicate review
              <strong>
                {duplicate
                  ? expense.duplicateOverrideReason
                    ? "Override recorded"
                    : "Possible match"
                  : "No match in available records"}
              </strong>
            </span>
          </button>
        </div>
      )}
      <p className="check-scope">
        {editable
          ? "Checks use loaded category policies and available expenses. The service validates submission; attachment does not confirm readability."
          : "Findings reported for this expense. Review the receipt before making a decision."}
      </p>
      {editable &&
        ![
          expense.subtotal,
          expense.tax,
          expense.serviceCharge,
          expense.tip,
          expense.discount,
        ].some((item) => item !== 0) && (
          <p className="check-scope">
            Total reconciliation is unavailable until a receipt breakdown is
            entered. Compare the total with your receipt.
          </p>
        )}
      {editable && category && category.currency !== expense.currency && (
        <p className="check-scope">
          {"Category limit is in "}
          {category.currency}
          {"; this "}
          {expense.currency} expense cannot be compared without a
          service-provided currency conversion.
        </p>
      )}
      {missingDetails.length > 0 && (
        <details className="check-finding blocking">
          <summary>
            <TriangleAlert size={16} />
            {" Required information"} <span>Blocks submission</span>
          </summary>
          <ul>
            {missingDetails.map((message) => (
              <li key={message}>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => focusField(fieldForMessage(message))}
                >
                  {message}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {failedChecks.map((check) => (
        <details
          key={check.ruleId}
          className={`check-finding ${check.ruleId === "duplicate" ? "blocking" : check.severity === "Informational" ? "neutral" : "warning"}`}
          open={check.ruleId === "duplicate" || check.ruleId === "limit"}
        >
          <summary>
            <TriangleAlert size={16} />
            {check.name}
            <span>
              {check.ruleId === "duplicate"
                ? "Review before submitting"
                : check.severity}
            </span>
          </summary>
          <p>{check.message}</p>
          {check.ruleId === "limit" && category && (
            <p>
              {"Receipt: "}
              {formatCurrency(expense.amount, expense.currency)}
              {" · Limit:"} {formatCurrency(category.limit, category.currency)}
              {" · Over by"}{" "}
              {formatCurrency(
                expense.amount - category.limit,
                expense.currency,
              )}
              .
            </p>
          )}
          {check.ruleId === "total" && (
            <p>
              Calculated:{" "}
              {formatCurrency(
                expense.subtotal +
                  expense.tax +
                  expense.serviceCharge +
                  expense.tip -
                  expense.discount,
                expense.currency,
              )}{" "}
              {"· Receipt total: "}
              {formatCurrency(expense.amount, expense.currency)}.
            </p>
          )}
          {["age", "future"].includes(check.ruleId) && (
            <p>
              {"Receipt date: "}
              {expense.expenseDate}. This is an application review check.
            </p>
          )}
          <button
            type="button"
            className="text-button"
            onClick={() => focusField(RULE_FIELDS[check.ruleId] || "details")}
          >
            {check.ruleId === "duplicate"
              ? "Compare expenses"
              : "Review affected information"}
          </button>
        </details>
      ))}
      {reportedFindings.map((finding) => (
        <details
          key={finding.id}
          className={`check-finding ${finding.severity === "High Risk" ? "risk" : finding.severity === "Warning" ? "warning" : "neutral"}`}
        >
          <summary>
            <TriangleAlert size={16} />
            {finding.type}
            <span>{finding.severity}</span>
          </summary>
          <p>{finding.message}</p>
          <p className="muted">
            Reported expense finding · Review the receipt and supporting
            details. Finance can record a resolution in Expense Issues.
          </p>
        </details>
      ))}
      {!findingCount && (
        <p className="check-scope">
          No issues reported by these checks. This does not certify that every
          organization rule or receipt quality check has run.
        </p>
      )}
    </section>
  );
}
