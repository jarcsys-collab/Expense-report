// Company expense policy: the single place for role groups, limits, monthly
// limits and the representation rule. Change policy values here only; the
// policy service, the anomaly rules and the frontend (via GET /api/policy) all
// read from this file.
//
// Amounts are in `currency`. A limit is breached only when amount > limit
// (an expense exactly at the limit is within policy).

export const expensePolicy = {
  currency: "PHP",

  // Policy categories. Each ReceiptFlow category is linked to at most one of
  // these keys by a finance admin (Category.policyKey); the employee-confirmed
  // category decides which policy applies, never OCR text.
  categories: {
    HOTEL_LODGING: { label: "Hotel & Lodging", period: "per_expense" },
    IN_BASED_MEALS: { label: "In-based meals", period: "per_expense" },
    OUT_BASED_MEALS: { label: "Out-based meals", period: "per_expense" },
    WORK_WITH_MEALS: { label: "Work with meals", period: "per_expense" },
    SPECIAL_OPERATION_MEALS: { label: "Special operation meals", period: "per_expense" },
    PRODUCT_PRESENTATION_TRAINING_GIFTS: {
      label: "Product Presentations / Training & Evaluation / Gifts for Medical Assoc.",
      period: "monthly",
    },
    REPRESENTATION: { label: "Representation", period: "per_expense" },
  },

  // Microsoft Entra job titles in each policy group, as written in the policy.
  // Titles are compared after normalization (see policyService.normalizeJobTitle);
  // anything else is POLICY_ROLE_UNMAPPED.
  roleGroups: {
    A: { label: "Group A", titles: ["SME", "Service Eng.", "Service Engineer", "App Specialist", "Application Specialist"] },
    B: { label: "Group B", titles: ["Asst. BU Head", "Assistant BU Head", "Manager"] },
    C: {
      label: "Group C",
      titles: ["BU Head", "Gen. Manager", "General Manager", "Asst. Director", "Assistant Director"],
    },
  },

  // Per-expense limits by policy group.
  categoryLimits: {
    A: { HOTEL_LODGING: 1800, IN_BASED_MEALS: 200, OUT_BASED_MEALS: 400, WORK_WITH_MEALS: 400, SPECIAL_OPERATION_MEALS: 500 },
    B: { HOTEL_LODGING: 2000, IN_BASED_MEALS: 200, OUT_BASED_MEALS: 400, WORK_WITH_MEALS: 450, SPECIAL_OPERATION_MEALS: 550 },
    C: { HOTEL_LODGING: 2500, IN_BASED_MEALS: 200, OUT_BASED_MEALS: 400, WORK_WITH_MEALS: 500, SPECIAL_OPERATION_MEALS: 600 },
  },

  // Calendar-month limits by policy group: earlier qualifying expenses of the
  // same employee in the same month (by receipt date) + the current expense.
  monthlyLimits: {
    PRODUCT_PRESENTATION_TRAINING_GIFTS: { A: 1000, B: 4000, C: 5000 },
  },
  // Expense statuses counted in monthly totals: submitted or later in the
  // approval flow. Not counted: Draft, Processing and Needs Review (never
  // submitted), Rejected, and Needs Correction (returned; counted again when
  // resubmitted). Deleted expenses no longer exist.
  monthlyCountedStatuses: ["Submitted", "Pending Approval", "Approved", "Reimbursed"],

  // Representations of PHP 5,000.00 and above need proof of ExCom approval.
  representationRules: {
    category: "REPRESENTATION",
    excomApprovalThreshold: 5000,
    evidenceTypes: {
      email: "Email",
      letter: "Letter",
      viber: "Viber message",
      teams: "Teams message",
    },
  },
};

export const POLICY_CATEGORY_KEYS = Object.keys(expensePolicy.categories);
export const EXCOM_EVIDENCE_TYPES = Object.keys(expensePolicy.representationRules.evidenceTypes);
