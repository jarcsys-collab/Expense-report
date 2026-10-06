import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import { EmptyState } from "../components/common/EmptyState";
import { ErrorState } from "../components/common/ErrorState";
import { StatusBadge } from "../components/common/StatusBadge";
import { TableSkeleton } from "../components/common/TableSkeleton";
import { config } from "../config/appConfig";
import { useWorkspace } from "../hooks/useWorkspace";
import { api } from "../services/api";
import { formatCurrency, formatDate } from "../utils/format";

export function ViolationsPage() {
  const { user, run, upsert } = useWorkspace();
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("Open");
  const [severityFilter, setSeverityFilter] = useState("");
  const [search, setSearch] = useState("");
  const [resolving, setResolving] = useState();
  const navigate = useNavigate();
  const load = async () => {
    setLoading(true);
    try {
      setExpenses(config.apiBase ? await api.getViolations() : []);
      setError("");
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, [user]);
  const openViolations = expenses
    .flatMap((expense) => expense.policyViolations)
    .filter((item) => item.status === "Open");
  const rows = expenses
    .flatMap((expense) =>
      expense.policyViolations.map((violation) => ({
        e: expense,
        v: violation,
      })),
    )
    .filter(
      ({ e: expense, v: violation }) =>
        (!statusFilter || violation.status === statusFilter) &&
        (!severityFilter || violation.severity === severityFilter) &&
        `${expense.requestNumber} ${expense.employeeName} ${expense.merchant} ${violation.type} ${violation.message} ${violation.resolutionReason || ""}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    );
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">WORKSPACE / POLICY</div>
          <h1>Expense Issues</h1>
          <p>Review policy exceptions and help your team resolve them.</p>
        </div>
        <ShieldCheck className="muted" size={28} />
      </header>
      {!loading && !error && (
        <div className="operational-summary" aria-label="Issue summary">
          {[
            ["Open", ""],
            ["High Risk", "High Risk"],
            ["Warnings", "Warning"],
          ].map(([label, severity]) => (
            <button
              key={label}
              onClick={() => {
                setStatusFilter("Open");
                setSeverityFilter(severity);
              }}
            >
              <strong>
                {
                  openViolations.filter(
                    (violation) => !severity || violation.severity === severity,
                  ).length
                }
              </strong>
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="table-toolbar">
        <div className="segmented">
          {["Open", "Resolved", ""].map((item) => (
            <button
              key={item}
              className={statusFilter === item ? "active" : ""}
              onClick={() => setStatusFilter(item)}
            >
              {item || "All flags"}
            </button>
          ))}
        </div>
        <div className="toolbar-actions">
          <input
            aria-label="Search violations"
            placeholder="Search violations…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            aria-label="Severity"
            value={severityFilter}
            onChange={(event) => setSeverityFilter(event.target.value)}
          >
            <option value="">All severities</option>
            {["Informational", "Warning", "High Risk"].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </div>
      </div>
      {loading ? (
        <TableSkeleton />
      ) : error ? (
        <ErrorState message={error} retry={() => void load()} />
      ) : rows.length ? (
        <div className="violations-list">
          {rows.map(({ e: expense, v: violation }) => (
            <article
              key={`${expense.id}-${violation.id}`}
              className="panel violation-card"
            >
              <span
                className={`violation-symbol ${violation.severity === "High Risk" ? "danger-text" : ""}`}
              >
                <ShieldCheck size={22} />
              </span>
              <div>
                <div className="violation-title">
                  <h3>{violation.type}</h3>
                  <StatusBadge status={violation.status} />
                </div>
                <p>
                  <strong>
                    {expense.merchant}
                    {" · "}
                    {formatCurrency(expense.amount, expense.currency)}
                  </strong>
                </p>
                <p>{violation.message}</p>
                <small>
                  {expense.employeeName}
                  {" · "}
                  {expense.requestNumber}
                  {" · "}
                  {formatDate(violation.createdAt)}
                  {" ·"} {violation.severity}
                </small>
                {violation.resolutionReason && (
                  <p>
                    {"Resolution: "}
                    {violation.resolutionReason}
                  </p>
                )}
              </div>
              <div className="violation-actions">
                <button
                  className="button"
                  onClick={() => navigate(`/requests/${expense.id}`)}
                >
                  View request
                </button>
                {violation.status === "Open" &&
                  user.role === "FINANCE_ADMIN" && (
                    <button
                      className="button primary"
                      onClick={() =>
                        setResolving({
                          expense: expense.id,
                          id: violation.id,
                        })
                      }
                    >
                      Resolve
                    </button>
                  )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title={
            statusFilter === "Open" && !search && !severityFilter
              ? "No open violations"
              : "No matching issues"
          }
          message={
            statusFilter === "Open" && !search && !severityFilter
              ? "There are currently no reported expenses requiring policy review."
              : "Try another search or adjust your filters."
          }
        />
      )}
      {resolving && (
        <ConfirmDialog
          title="Resolve violation"
          reason
          message="Record how this policy exception was reviewed and resolved."
          onClose={() => setResolving(undefined)}
          onConfirm={async (event) => {
            const updated = await run(
              () =>
                api.resolveViolation(resolving.expense, resolving.id, event),
              "Violation resolved",
            );
            if (updated) {
              upsert(updated);
              setExpenses((current) =>
                current.map((item) =>
                  item.id === updated.id ? updated : item,
                ),
              );
              setResolving(undefined);
            }
          }}
        />
      )}
    </>
  );
}
