// `incomplete`: a draft the Reimbursement Assistant saved for its checks that
// the employee has not saved or submitted yet.
export function StatusBadge({ status, incomplete = false }) {
  return (
    <span
      className={`badge ${["Approved", "Reimbursed", "Resolved", "Ready"].includes(status) ? "success" : ["Rejected", "Failed"].includes(status) ? "danger" : ["Needs Review", "Needs Correction", "Open"].includes(status) ? "warning" : status === "Pending Approval" ? "pending" : ""}`}
    >
      <i />
      {status}
      {incomplete && status === "Draft" && (
        <span title="Started in the Reimbursement Assistant and not saved or submitted yet">
          {" · Incomplete"}
        </span>
      )}
    </span>
  );
}
