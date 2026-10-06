import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { ErrorState } from "../components/common/ErrorState";
import { TableSkeleton } from "../components/common/TableSkeleton";
import { ExpenseDrawer } from "../components/expenses/ExpenseDrawer";
import { ExpenseTable } from "../components/expenses/ExpenseTable";
import { ReceiptUploader } from "../components/receipts/ReceiptUploader";
import { config } from "../config/appConfig";
import { useWorkspace } from "../hooks/useWorkspace";

export function ExpensesPage({ upload = false, approvals = false }) {
  const { expenses, loading, error, refresh, user } = useWorkspace();
  const { id } = useParams();
  useEffect(() => {
    const onRefresh = () => void refresh();
    window.addEventListener("receiptflow-refresh", onRefresh);
    return () => window.removeEventListener("receiptflow-refresh", onRefresh);
  }, [refresh]);
  if (approvals && config.apiBase && user.role === "EMPLOYEE") {
    return (
      <div className="empty">
        <h2>Approver access required</h2>
        <Link to="/requests">View your requests</Link>
      </div>
    );
  }
  const visibleExpenses = approvals
    ? expenses.filter(
        (expense) =>
          user.role === "FINANCE_ADMIN" ||
          expense.assignedApproverId === user.id,
      )
    : upload
      ? expenses
      : expenses.filter((expense) => expense.employeeId === user.id);
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">
            WORKSPACE /{" "}
            {approvals ? "REVIEW" : upload ? "RECEIPTS" : "EXPENSES"}
          </div>
          <h1>
            {upload
              ? "Scan a receipt"
              : approvals
                ? "Approvals"
                : "My Requests"}
          </h1>
          <p>
            {approvals
              ? "Review expenses. Keep everything moving."
              : upload
                ? "Upload a receipt to extract expense details and review your organization’s expense rules."
                : "Your expenses, from receipt to reimbursement."}
          </p>
        </div>
        <Link className={upload ? "button" : "button primary"} to="/review/new">
          <Plus size={17} />
          New expense
        </Link>
      </header>
      {upload && (
        <>
          <div className="workflow-strip" aria-label="Receipt workflow">
            <strong>1. Scan receipt</strong>
            <span>2. Verify & check</span>
            <span>3. Submit</span>
          </div>
          <ReceiptUploader />
          {!loading && !error && visibleExpenses.length > 0 && (
            <div className="operational-summary">
              {["Draft", "Pending Approval", "Needs Correction"].map((item) => (
                <Link
                  key={item}
                  to="/requests"
                  state={{
                    statusFilter: item,
                  }}
                >
                  <strong>
                    {
                      visibleExpenses.filter(
                        (expense) =>
                          expense.employeeId === user.id &&
                          expense.status === item,
                      ).length
                    }
                  </strong>
                  <span>
                    {item === "Needs Correction" ? "Needs attention" : item}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
      {loading ? (
        <TableSkeleton />
      ) : error ? (
        <ErrorState message={error} retry={() => void refresh()} />
      ) : (
        <ExpenseTable
          data={visibleExpenses}
          compact={upload}
          approvals={approvals}
        />
      )}
      <div className="page-footnote">
        <span>ReceiptFlow · Expense workspace</span>
        <span>All amounts shown in their original currency</span>
      </div>
      {id && (
        <ExpenseDrawer
          key={`${id}-${user.role}`}
          base={approvals ? "/approvals" : "/requests"}
        />
      )}
    </>
  );
}
