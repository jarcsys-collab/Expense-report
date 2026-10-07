import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowDownUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  MessageSquare,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { EXPENSE_STATUSES } from "../../config/constants";
import { useWorkspace } from "../../hooks/useWorkspace";
import { api } from "../../services/api";
import { formatCurrency, formatDate, initials } from "../../utils/format";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { EmptyState } from "../common/EmptyState";
import { Modal } from "../common/Modal";
import { StatusBadge } from "../common/StatusBadge";
import { ReceiptPreviewModal } from "../receipts/ReceiptPreviewModal";
import { FindingBadge } from "./FindingBadge";

export function ExpenseTable({
  data: expenses,
  approvals = false,
  compact = false,
}) {
  const { user, run, upsert, categories } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (location.state?.statusFilter) {
      setStatusFilter(location.state.statusFilter);
    }
  }, [location.state]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(
    approvals ? "Pending Approval" : "",
  );
  const [severityFilter, setSeverityFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("date-desc");
  const [selectedIds, setSelectedIds] = useState([]);
  const [previewFile, setPreviewFile] = useState();
  const [pendingAction, setPendingAction] = useState();
  const pageSize = compact ? 7 : 10;
  const filtered = useMemo(
    () =>
      expenses
        .filter(
          (expense) =>
            (!statusFilter ||
              (statusFilter === "Needs Attention"
                ? ["Needs Review", "Needs Correction", "Rejected"].includes(
                    expense.status,
                  ) ||
                  expense.policyViolations.some(
                    (violation) => violation.status === "Open",
                  )
                : statusFilter === "Submitted"
                  ? ["Submitted", "Pending Approval"].includes(expense.status)
                  : expense.status === statusFilter)) &&
            (!severityFilter ||
              expense.policyViolations.some(
                (violation) =>
                  violation.status === "Open" &&
                  violation.severity === severityFilter,
              )) &&
            (!categoryFilter || expense.category === categoryFilter) &&
            (!currencyFilter || expense.currency === currencyFilter) &&
            (!departmentFilter || expense.department === departmentFilter) &&
            (!fromDate || expense.expenseDate >= fromDate) &&
            (!toDate || expense.expenseDate <= toDate) &&
            (!minAmount || expense.amount >= Number(minAmount)) &&
            (!maxAmount || expense.amount <= Number(maxAmount)) &&
            [
              String(expense.amount),
              formatCurrency(expense.amount, expense.currency),
              expense.employeeName,
              expense.merchant,
              expense.receiptNumber,
              expense.purpose,
              expense.category,
              expense.department,
              expense.requestNumber,
            ]
              .join(" ")
              .toLowerCase()
              .includes(search.trim().toLowerCase()),
        )
        .sort((a, b) =>
          sort === "amount-desc"
            ? b.amount - a.amount
            : sort === "amount-asc"
              ? a.amount - b.amount
              : sort === "date-asc"
                ? a.expenseDate.localeCompare(b.expenseDate)
                : b.expenseDate.localeCompare(a.expenseDate),
        ),
    [
      expenses,
      severityFilter,
      statusFilter,
      categoryFilter,
      currencyFilter,
      departmentFilter,
      fromDate,
      toDate,
      minAmount,
      maxAmount,
      search,
      sort,
    ],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageItems = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  useEffect(() => {
    setPage(1);
    setSelectedIds([]);
  }, [
    search,
    severityFilter,
    statusFilter,
    categoryFilter,
    currencyFilter,
    departmentFilter,
    fromDate,
    toDate,
    minAmount,
    maxAmount,
  ]);
  useEffect(() => {
    setSelectedIds((current) =>
      current.filter((item) => expenses.some((expense) => expense.id === item)),
    );
  }, [expenses]);
  const canDecide = (expense) =>
    ["Pending Approval", "Submitted"].includes(expense.status) &&
    expense.employeeId !== user.id &&
    (user.role === "FINANCE_ADMIN" ||
      (user.role === "APPROVER" && expense.assignedApproverId === user.id));
  const toggleSelected = (id) =>
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  const eligibleSelected = expenses.filter(
    (expense) => selectedIds.includes(expense.id) && canDecide(expense),
  );
  const openExpense = (expense) =>
    navigate(`${approvals ? "/approvals" : "/requests"}/${expense.id}`);
  return (
    <section className="expenses-section">
      <div className="table-toolbar">
        <div className="toolbar-left">
          {compact ? (
            <h3>
              {"Recent requests "}
              <span className="count">{expenses.length}</span>
            </h3>
          ) : (
            <div
              className="segmented expense-status-tabs"
              aria-label="Expense status filters"
            >
              {["", "Needs Attention", "Draft", "Submitted", "Approved"].map(
                (item) => (
                  <button
                    key={item}
                    className={
                      statusFilter === item ||
                      (item === "Submitted" &&
                        statusFilter === "Pending Approval")
                        ? "active"
                        : ""
                    }
                    onClick={() => setStatusFilter(item)}
                  >
                    {item || "All"}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
        <div className="toolbar-actions">
          <label className="search">
            <Search size={16} />
            <input
              aria-label="Search expenses"
              placeholder="Merchant, employee, amount…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && (
              <button aria-label="Clear search" onClick={() => setSearch("")}>
                <X size={14} />
              </button>
            )}
          </label>
          <button
            className={`button ${filtersOpen ? "selected" : ""}`}
            onClick={() => setFiltersOpen(!filtersOpen)}
            aria-expanded={filtersOpen}
          >
            <SlidersHorizontal size={15} />
            <span>Filters</span>
          </button>
          <label className="sort-control" title="Sort expenses">
            <ArrowDownUp size={15} />
            <select
              aria-label="Sort expenses"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="date-desc">Newest first</option>
              <option value="date-asc">Oldest first</option>
              <option value="amount-desc">Highest amount</option>
              <option value="amount-asc">Lowest amount</option>
            </select>
          </label>
        </div>
      </div>
      {filtersOpen && (
        <Modal title="Filter expenses" onClose={() => setFiltersOpen(false)}>
          <div className="filter-panel expense-filter-sheet">
            <label>
              Status
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="">All statuses</option>
                <option>Needs Attention</option>
                {EXPENSE_STATUSES.map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </label>
            <label>
              Finding severity
              <select
                aria-label="Finding severity"
                value={severityFilter}
                onChange={(event) => setSeverityFilter(event.target.value)}
              >
                <option value="">All findings</option>
                {["High Risk", "Warning", "Informational"].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              Category
              <select
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
              >
                <option value="">All categories</option>
                {categories.map((category) => (
                  <option key={category.id}>{category.name}</option>
                ))}
              </select>
            </label>
            <label>
              Department
              <select
                value={departmentFilter}
                onChange={(event) => setDepartmentFilter(event.target.value)}
              >
                <option value="">All departments</option>
                {[
                  ...new Set(expenses.map((expense) => expense.department)),
                ].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              Currency
              <select
                value={currencyFilter}
                aria-label="Currency"
                onChange={(event) => setCurrencyFilter(event.target.value)}
              >
                <option value="">All currencies</option>
                {[...new Set(expenses.map((expense) => expense.currency))]
                  .sort()
                  .map((item) => (
                    <option key={item}>{item}</option>
                  ))}
              </select>
            </label>
            <label>
              From
              <input
                aria-label="From date"
                type="date"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
              />
            </label>
            <label>
              To
              <input
                aria-label="To date"
                type="date"
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
              />
            </label>
            <label>
              Min amount
              <input
                type="number"
                min="0"
                value={minAmount}
                onChange={(event) => setMinAmount(event.target.value)}
              />
            </label>
            <label>
              Max amount
              <input
                type="number"
                min="0"
                value={maxAmount}
                onChange={(event) => setMaxAmount(event.target.value)}
              />
            </label>
            <button
              className="text-button"
              onClick={() => {
                setSeverityFilter("");
                setStatusFilter("");
                setCategoryFilter("");
                setCurrencyFilter("");
                setDepartmentFilter("");
                setFromDate("");
                setToDate("");
                setMinAmount("");
                setMaxAmount("");
              }}
            >
              Reset filters
            </button>
          </div>
          <footer>
            <button
              className="button primary"
              onClick={() => setFiltersOpen(false)}
            >
              {"Show "}
              {filtered.length}
              {" expenses"}
            </button>
          </footer>
        </Modal>
      )}
      {selectedIds.length > 0 && (
        <div className="selection-bar">
          <span>
            {selectedIds.length}
            {" selected"}
          </span>
          {approvals && (
            <>
              <button
                className="button primary"
                disabled={!eligibleSelected.length}
                title={
                  eligibleSelected.length
                    ? undefined
                    : "Select a pending request assigned to you. Your own expenses need another approver."
                }
                onClick={() =>
                  setPendingAction({
                    kind: "Approve",
                    items: expenses.filter(
                      (expense) =>
                        selectedIds.includes(expense.id) && canDecide(expense),
                    ),
                  })
                }
              >
                Approve eligible
              </button>
              <button
                className="button"
                disabled={!eligibleSelected.length}
                title={
                  eligibleSelected.length
                    ? undefined
                    : "Select a pending request assigned to you. Your own expenses need another approver."
                }
                onClick={() =>
                  setPendingAction({
                    kind: "Reject",
                    items: expenses.filter(
                      (expense) =>
                        selectedIds.includes(expense.id) && canDecide(expense),
                    ),
                  })
                }
              >
                Reject eligible
              </button>
              <button
                className="button"
                disabled={!eligibleSelected.length}
                title={
                  eligibleSelected.length
                    ? undefined
                    : "Select a pending request assigned to you. Your own expenses need another approver."
                }
                onClick={() =>
                  setPendingAction({
                    kind: "Request Changes",
                    items: expenses.filter(
                      (expense) =>
                        selectedIds.includes(expense.id) && canDecide(expense),
                    ),
                  })
                }
              >
                Request changes
              </button>
            </>
          )}
          <button className="text-button" onClick={() => setSelectedIds([])}>
            Clear selection
          </button>
        </div>
      )}
      {pageItems.length ? (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="check-cell">
                    <input
                      type="checkbox"
                      aria-label="Select page"
                      checked={
                        pageItems.length > 0 &&
                        pageItems.every((expense) =>
                          selectedIds.includes(expense.id),
                        )
                      }
                      onChange={() =>
                        setSelectedIds(
                          pageItems.every((expense) =>
                            selectedIds.includes(expense.id),
                          )
                            ? selectedIds.filter(
                                (selectedId) =>
                                  !pageItems.some(
                                    (expense) => expense.id === selectedId,
                                  ),
                              )
                            : [
                                ...new Set([
                                  ...selectedIds,
                                  ...pageItems.map((expense) => expense.id),
                                ]),
                              ],
                        )
                      }
                    />
                  </th>
                  <th>Employee name</th>
                  <th className="low-priority">Position / role</th>
                  <th className="medium-priority">Department</th>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Amount</th>
                  <th className="medium-priority">Purpose</th>
                  <th className="low-priority">Location</th>
                  <th>{approvals ? "Approval" : "Status"}</th>
                  <th>Expense Check</th>
                  <th>Receipt</th>
                  <th>
                    <span className="sr-only">Comments</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((expense) => (
                  <tr
                    key={expense.id}
                    className={
                      selectedIds.includes(expense.id) ? "selected-row" : ""
                    }
                  >
                    <td className="check-cell">
                      <input
                        type="checkbox"
                        aria-label={`Select ${expense.requestNumber}`}
                        checked={selectedIds.includes(expense.id)}
                        onChange={() => toggleSelected(expense.id)}
                      />
                    </td>
                    <td>
                      <button
                        className="row-name"
                        onClick={() => openExpense(expense)}
                      >
                        {expense.employeeName}
                        <small className="table-merchant">
                          {expense.merchant}
                        </small>
                      </button>
                    </td>
                    <td className="low-priority">{expense.position}</td>
                    <td className="medium-priority">{expense.department}</td>
                    <td>{formatDate(expense.expenseDate)}</td>
                    <td>{expense.category}</td>
                    <td className="amount">
                      {formatCurrency(expense.amount, expense.currency)}
                    </td>
                    <td className="medium-priority">
                      {expense.purpose || "—"}
                    </td>
                    <td className="low-priority">{expense.location}</td>
                    <td>
                      {approvals && canDecide(expense) ? (
                        <div className="approval-icons">
                          <button
                            className="approve-icon"
                            title="Approve"
                            aria-label={`Approve ${expense.requestNumber}`}
                            onClick={() =>
                              setPendingAction({
                                kind: "Approve",
                                items: [expense],
                              })
                            }
                          >
                            <Check size={14} />
                          </button>
                          <button
                            className="reject-icon"
                            title="Reject"
                            aria-label={`Reject ${expense.requestNumber}`}
                            onClick={() =>
                              setPendingAction({
                                kind: "Reject",
                                items: [expense],
                              })
                            }
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <StatusBadge status={expense.status} incomplete={expense.incompleteDraft} />
                      )}
                    </td>
                    <td>
                      <FindingBadge expense={expense} />
                    </td>
                    <td>
                      {expense.receiptFiles[0] ? (
                        <button
                          className="receipt-link"
                          onClick={() =>
                            setPreviewFile(expense.receiptFiles[0])
                          }
                        >
                          <FileText size={13} />
                          <span>{expense.receiptFiles[0].name}</span>
                        </button>
                      ) : (
                        <span className="muted">Missing</span>
                      )}
                    </td>
                    <td>
                      <button
                        className="icon-button comment-icon"
                        aria-label={`Comments for ${expense.requestNumber}`}
                        onClick={() => openExpense(expense)}
                      >
                        <MessageSquare size={15} />
                        {expense.comments.length > 0 && <i />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="expense-cards">
            {pageItems.map((expense) => (
              <button
                key={expense.id}
                className="expense-card"
                onClick={() => openExpense(expense)}
              >
                <div className="expense-card-top">
                  <span className="merchant-avatar">
                    {initials(expense.merchant)}
                  </span>
                  <div>
                    <strong>{expense.merchant}</strong>
                    <small>
                      {formatDate(expense.expenseDate)}
                      {" · "}
                      {expense.category}
                    </small>
                  </div>
                  <b>{formatCurrency(expense.amount, expense.currency)}</b>
                </div>
                <FindingBadge expense={expense} />
                <div className="expense-card-bottom">
                  <StatusBadge status={expense.status} incomplete={expense.incompleteDraft} />
                  <span>
                    <FileText size={13} />
                    {expense.receiptFiles.length
                      ? "Receipt attached"
                      : "Missing receipt"}
                    <ChevronRight size={15} />
                  </span>
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          title={
            expenses.length
              ? "No matching expenses"
              : approvals
                ? "No approvals waiting"
                : "No expenses yet"
          }
          message={
            expenses.length
              ? "Try another search or adjust your filters."
              : approvals
                ? "New requests awaiting your review will appear here."
                : "Scan your first receipt to extract expense information and review findings."
          }
        >
          {!approvals && !expenses.length && (
            <button
              className="button primary"
              onClick={() =>
                navigate("/upload", {
                  state: {
                    scan: Date.now(),
                  },
                })
              }
            >
              Scan Receipt
            </button>
          )}
        </EmptyState>
      )}
      <div className="pagination">
        <span>
          {"Showing "}
          {filtered.length ? (currentPage - 1) * pageSize + 1 : 0}–
          {Math.min(currentPage * pageSize, filtered.length)}
          {" of "}
          {filtered.length} requests
        </span>
        <div>
          <button
            aria-label="First page"
            disabled={currentPage === 1}
            onClick={() => setPage(1)}
          >
            <ChevronsLeft size={15} />
          </button>
          <button
            aria-label="Previous page"
            disabled={currentPage === 1}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={15} />
          </button>
          {Array.from(
            {
              length: pageCount,
            },
            (_, index) => (
              <button
                key={index}
                className={currentPage === index + 1 ? "active" : ""}
                aria-label={`Page ${index + 1}`}
                aria-current={currentPage === index + 1 ? "page" : undefined}
                onClick={() => setPage(index + 1)}
              >
                {index + 1}
              </button>
            ),
          )}
          <button
            aria-label="Next page"
            disabled={currentPage === pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size={15} />
          </button>
          <button
            aria-label="Last page"
            disabled={currentPage === pageCount}
            onClick={() => setPage(pageCount)}
          >
            <ChevronsRight size={15} />
          </button>
        </div>
      </div>
      {previewFile && (
        <ReceiptPreviewModal
          file={previewFile}
          onClose={() => setPreviewFile(undefined)}
        />
      )}
      {pendingAction && (
        <ConfirmDialog
          title={`${pendingAction.kind} ${pendingAction.items.length === 1 ? "expense" : `${pendingAction.items.length} expenses`}`}
          message={
            pendingAction.items.length
              ? `${pendingAction.items.map((item) => `${item.employeeName} · ${formatCurrency(item.amount, item.currency)}`).join("; ")}. ${pendingAction.kind === "Approve" ? "Confirm that receipts and policy warnings have been reviewed." : ""}`
              : "No selected requests are eligible. Own expenses require another approver."
          }
          reason={pendingAction.kind !== "Approve"}
          danger={pendingAction.kind === "Reject"}
          onClose={() => setPendingAction(undefined)}
          onConfirm={async (event) => {
            if (!pendingAction.items.length) {
              setPendingAction(undefined);
              return;
            }
            for (const item of pendingAction.items) {
              const updated = await run(
                () =>
                  pendingAction.kind === "Approve"
                    ? api.approveExpense(item.id)
                    : pendingAction.kind === "Reject"
                      ? api.rejectExpense(item.id, event)
                      : api.requestChanges(item.id, event),
                pendingAction.kind === "Approve"
                  ? "Expense approved"
                  : pendingAction.kind === "Reject"
                    ? "Expense rejected"
                    : "Changes requested",
              );
              if (!updated) {
                setPendingAction((current) =>
                  current
                    ? {
                        ...current,
                        items: current.items.filter(
                          (remaining) =>
                            remaining.id === item.id ||
                            pendingAction.items.indexOf(remaining) >
                              pendingAction.items.indexOf(item),
                        ),
                      }
                    : undefined,
                );
                return;
              }
              upsert(updated);
              setSelectedIds((current) =>
                current.filter((item) => item !== updated.id),
              );
            }
            setSelectedIds([]);
            setPendingAction(undefined);
          }}
        />
      )}
    </section>
  );
}
