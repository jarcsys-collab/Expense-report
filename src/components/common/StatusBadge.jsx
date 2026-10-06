export function StatusBadge({ status }) {
  return (
    <span
      className={`badge ${["Approved", "Reimbursed", "Resolved", "Ready"].includes(status) ? "success" : ["Rejected", "Failed"].includes(status) ? "danger" : ["Needs Review", "Needs Correction", "Open"].includes(status) ? "warning" : status === "Pending Approval" ? "pending" : ""}`}
    >
      <i />
      {status}
    </span>
  );
}
