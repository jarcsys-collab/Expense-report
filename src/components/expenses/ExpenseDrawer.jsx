import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Check,
  Clock3,
  Download,
  FileText,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { useWorkspace } from "../../hooks/useWorkspace";
import { api } from "../../services/api";
import { downloadReceipt } from "../../services/receiptFiles";
import { formatCurrency, formatDate } from "../../utils/format";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { ErrorState } from "../common/ErrorState";
import { Modal } from "../common/Modal";
import { Spinner } from "../common/Spinner";
import { StatusBadge } from "../common/StatusBadge";
import { TableSkeleton } from "../common/TableSkeleton";
import { hasStoredFile } from "../receipts/ReceiptAssociation";
import { ReceiptPreviewModal } from "../receipts/ReceiptPreviewModal";
import { CommentThread } from "./CommentThread";
import { ExpenseCheck } from "./ExpenseCheck";

export function ExpenseDrawer({ base: basePath = "/requests" }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, run, upsert, notify, expenses, categories } = useWorkspace();
  const [expense, setExpense] = useState();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("Updates");
  const [draftComment, setDraftComment] = useState("");
  const [replyTo, setReplyTo] = useState();
  const [posting, setPosting] = useState(false);
  const [previewFile, setPreviewFile] = useState();
  const [pendingAction, setPendingAction] = useState();
  const [pendingFileDelete, setPendingFileDelete] = useState();
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setExpense(await api.getExpense(id));
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, [id]);
  const applyUpdate = (updated) => {
    setExpense(updated);
    upsert(updated);
  };
  const close = () => navigate(basePath);
  const canDecide =
    expense &&
    user.role !== "EMPLOYEE" &&
    expense.employeeId !== user.id &&
    (user.role === "FINANCE_ADMIN" || expense.assignedApproverId === user.id) &&
    ["Pending Approval", "Submitted"].includes(expense.status);
  const canEdit =
    expense &&
    ["Draft", "Needs Review", "Needs Correction", "Rejected"].includes(
      expense.status,
    ) &&
    (user.role === "FINANCE_ADMIN" || expense.employeeId === user.id);
  const daysInactive = expense
    ? Math.floor((Date.now() - new Date(expense.updatedAt).getTime()) / 864e5)
    : 0;
  return (
    <Modal title={expense?.purpose || "Expense details"} onClose={close}>
      <div className="drawer-marker" />
      <div className="drawer-meta">
        {expense && (
          <>
            <span>
              {expense.employeeName}
              {" · "}
              {formatCurrency(expense.amount, expense.currency)} {"· "}
              {formatDate(expense.expenseDate)}
            </span>
            <StatusBadge status={expense.category} />
          </>
        )}
      </div>
      <div className="drawer-tabs" role="tablist">
        {["Updates", "Files", "Activity Log"].map((item) => (
          <button
            key={item}
            role="tab"
            aria-selected={tab === item}
            className={tab === item ? "active" : ""}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="drawer-scroll">
        {loading ? (
          <TableSkeleton />
        ) : error ? (
          <ErrorState message={error} retry={() => void load()} />
        ) : (
          expense && (
            <>
              {tab === "Updates" && (
                <>
                  <div className="summary-card">
                    <h4>
                      {expense.merchant} <span>{expense.requestNumber}</span>
                    </h4>
                    <dl>
                      <div>
                        <dt>Employee</dt>
                        <dd>{expense.employeeName}</dd>
                      </div>
                      <div>
                        <dt>Date</dt>
                        <dd>{formatDate(expense.expenseDate)}</dd>
                      </div>
                      <div>
                        <dt>Amount</dt>
                        <dd>
                          {formatCurrency(expense.amount, expense.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt>Category</dt>
                        <dd>{expense.category}</dd>
                      </div>
                    </dl>
                    <p className="approval-purpose">
                      {expense.purpose || "No business purpose provided"}
                    </p>
                    <details>
                      <summary>More details</summary>
                      <dl>
                        {[
                          ["Merchant", expense.merchant],
                          ["Department", expense.department],
                          ["Position / role", expense.position],
                          ["Purpose", expense.purpose],
                          ["Location", expense.location],
                          ["Receipt number", expense.receiptNumber],
                          ["Created", formatDate(expense.createdAt)],
                          ["Updated", formatDate(expense.updatedAt)],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value || "—"}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                    <StatusBadge status={expense.status} incomplete={expense.incompleteDraft} />
                  </div>
                  <ExpenseCheck
                    expense={expense}
                    all={expenses}
                    categories={categories}
                  />
                  {expense.rejectionReason && (
                    <div className="warning-note">
                      <strong>Reviewer’s note</strong>
                      <p>{expense.rejectionReason}</p>
                    </div>
                  )}
                  <h3 className="section-label">
                    {"Update Log "}
                    <span>{expense.comments.length}</span>
                  </h3>
                  <form
                    className="comment-composer"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (!draftComment.trim() || posting) {
                        return;
                      }
                      setPosting(true);
                      const updated = await run(
                        () =>
                          api.addExpenseComment(
                            expense.id,
                            draftComment.trim(),
                            replyTo?.id,
                          ),
                        "Update posted",
                      );
                      if (updated) {
                        applyUpdate(updated);
                        setDraftComment("");
                        setReplyTo(undefined);
                      }
                      setPosting(false);
                    }}
                  >
                    {replyTo && (
                      <div className="replying">
                        {"Replying to "}
                        {replyTo.userName}
                        <button
                          type="button"
                          aria-label="Cancel reply"
                          onClick={() => setReplyTo(undefined)}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )}
                    <textarea
                      aria-label="Add a quick update"
                      placeholder="Add a quick update…"
                      value={draftComment}
                      onChange={(event) => setDraftComment(event.target.value)}
                      rows={2}
                      required
                    />
                    <button
                      className="button primary"
                      disabled={posting || !draftComment.trim()}
                    >
                      {posting ? <Spinner /> : <Send size={14} />}
                      {" Post Update"}
                    </button>
                  </form>
                  {daysInactive >= 5 &&
                    [
                      "Pending Approval",
                      "Needs Correction",
                      "Submitted",
                    ].includes(expense.status) && (
                      <div className="inactivity">
                        <span>
                          <Clock3 size={13} />
                          {" No updates since"} {formatDate(expense.updatedAt)}
                        </span>
                        <b>
                          {daysInactive}
                          {" DAYS INACTIVE"}
                        </b>
                      </div>
                    )}
                  {expense.comments.map((comment) => (
                    <CommentThread
                      key={comment.id}
                      comment={comment}
                      onReply={(event) => {
                        setReplyTo(event);
                        document
                          .querySelector(".comment-composer textarea")
                          ?.focus();
                      }}
                    />
                  ))}
                </>
              )}
              {tab === "Files" && (
                <div className="files-list">
                  {!expense.receiptFiles.length && (
                    <p className="muted">No receipt files attached.</p>
                  )}
                  {expense.receiptFiles.map((file) => (
                    <article key={file.id} className="file-card">
                      <FileText size={24} />
                      <div>
                        <strong>{file.name}</strong>
                        <small>
                          {(file.size / 1024).toFixed(1)}
                          {" KB ·"} {formatDate(file.uploadedAt)}
                        </small>
                        <small>
                          {"Uploaded by "}
                          {expense.employeeName}
                        </small>
                        {!hasStoredFile(file) && (
                          <small>
                            {expense.receiptJobId
                              ? "Linked to receipt scan · original file not stored"
                              : "Original file not stored"}
                          </small>
                        )}
                        <div className="file-actions">
                          {hasStoredFile(file) && (
                            <>
                              <button
                                className="text-button"
                                onClick={() => setPreviewFile(file)}
                              >
                                Preview
                              </button>
                              <button
                                className="text-button"
                                onClick={() =>
                                  void run(() => downloadReceipt(file))
                                }
                              >
                                <Download size={14} />
                                Download
                              </button>
                            </>
                          )}
                          {user.role === "FINANCE_ADMIN" && (
                            <button
                              className="text-button danger-text"
                              onClick={() => setPendingFileDelete(file.id)}
                            >
                              <Trash2 size={14} />
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {tab === "Activity Log" && (
                <div className="activity-list">
                  {expense.activityLog.map((entry) => (
                    <article key={entry.id}>
                      <span className="activity-dot" />
                      <div>
                        <strong>{entry.actor}</strong>
                        <p>{entry.action}</p>
                        <small>
                          {new Date(entry.createdAt).toLocaleString()}
                        </small>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>
          )
        )}
      </div>
      {expense && (
        <footer className="drawer-footer">
          {canDecide ? (
            <>
              <button
                className="button primary"
                onClick={() => setPendingAction("Approve")}
              >
                <Check size={17} />
                Approve
              </button>
              <button
                className="button"
                onClick={() => setPendingAction("Request Changes")}
              >
                Send Back
              </button>
              <button
                className="button danger-button"
                onClick={() => setPendingAction("Reject")}
              >
                Reject
              </button>
            </>
          ) : canEdit ? (
            <>
              <button
                className="button primary"
                onClick={() => navigate(`/review/${expense.id}`)}
              >
                Review & edit expense
              </button>
              <button
                className="icon-button"
                aria-label="Delete draft"
                onClick={() => setPendingAction("Delete")}
              >
                <Trash2 size={18} />
              </button>
            </>
          ) : (
            <div className="muted">
              {expense.employeeId === user.id &&
              expense.status === "Pending Approval"
                ? "Awaiting another approver’s review."
                : `This request is ${expense.status.toLowerCase()}.`}
            </div>
          )}
        </footer>
      )}
      {previewFile && (
        <ReceiptPreviewModal
          file={previewFile}
          onClose={() => setPreviewFile(undefined)}
        />
      )}
      {pendingAction && expense && (
        <ConfirmDialog
          title={
            pendingAction === "Delete"
              ? "Delete expense"
              : `${pendingAction} expense`
          }
          message={`${expense.employeeName} · ${formatCurrency(expense.amount, expense.currency)}${pendingAction === "Delete" ? ". This removes the draft and its history." : ". Review the receipt and policy flags before continuing."}`}
          reason={["Reject", "Request Changes"].includes(pendingAction)}
          danger={["Reject", "Delete"].includes(pendingAction)}
          onClose={() => setPendingAction(undefined)}
          onConfirm={async (event) => {
            if (pendingAction === "Delete") {
              if (
                await run(async () => {
                  await api.deleteExpense(expense.id);
                  return true;
                }, "Expense deleted")
              ) {
                setPendingAction(undefined);
                close();
                window.dispatchEvent(new Event("receiptflow-refresh"));
              }
              return;
            }
            const updated = await run(
              () =>
                pendingAction === "Approve"
                  ? api.approveExpense(expense.id)
                  : pendingAction === "Reject"
                    ? api.rejectExpense(expense.id, event)
                    : api.requestChanges(expense.id, event),
              "Request updated",
            );
            if (updated) {
              applyUpdate(updated);
              setPendingAction(undefined);
            }
          }}
        />
      )}
      {pendingFileDelete && expense && (
        <ConfirmDialog
          title="Delete receipt"
          message="This removes the attachment from the expense. Its audit entry remains."
          danger
          onClose={() => setPendingFileDelete(undefined)}
          onConfirm={async () => {
            const updated = await run(
              () => api.deleteFile(expense.id, pendingFileDelete),
              "Receipt removed",
            );
            if (updated) {
              applyUpdate(updated);
              setPendingFileDelete(undefined);
            } else {
              notify("Receipt was not removed.", true);
            }
          }}
        />
      )}
    </Modal>
  );
}
