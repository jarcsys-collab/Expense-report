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
  // Temporary: saved to My Requests while approval routing is switched off on
  // the server (APPROVAL_WORKFLOW_ENABLED=false). Still editable.
  "Pending Workflow Setup",
];

export const SAVED_PENDING_WORKFLOW_STATUS = "Pending Workflow Setup";
// Statuses the owner (or Finance) may still edit (matches the server's EDITABLE_STATUSES).
export const EDITABLE_STATUSES = ["Draft", "Needs Review", "Needs Correction", "Rejected", SAVED_PENDING_WORKFLOW_STATUS];
