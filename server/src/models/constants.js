// Values shared with the frontend (src/config/constants.js and normalizers).
export const EXPENSE_STATUSES = [
  "Draft",
  "Processing",
  "Needs Review",
  "Submitted",
  "Pending Approval",
  "Approved",
  "Rejected",
  "Needs Correction",
  "Reimbursed",
];

// Statuses the employee may still edit or delete (matches the frontend's canEdit rule).
export const EDITABLE_STATUSES = ["Draft", "Needs Review", "Needs Correction", "Rejected"];

// Statuses a client may choose when creating an expense. Every other status is
// reached through workflow actions (submit/approve/reject) on the server.
export const CLIENT_CREATE_STATUSES = ["Draft", "Needs Review"];

export const ROLES = ["EMPLOYEE", "APPROVER", "FINANCE_ADMIN"];

export const VIOLATION_SEVERITIES = ["Informational", "Warning", "High Risk"];
export const VIOLATION_STATUSES = ["Open", "Resolved"];

export const RECEIPT_JOB_STATUSES = ["queued", "processing", "pending", "ready", "needs_review", "failed"];
