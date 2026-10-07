// Reimbursement Assistant: the conversation's states, transitions and message
// templates, in one place. Deterministic: every message is a fixed template
// filled with the user's answers and the server's results. No AI service, no
// free-form text understanding.
//
// The server stays authoritative for identity, policy limits, role groups,
// duplicates, anomalies and approval routing. The flow only decides which
// question to ask next; what the server reports is shown as it was returned.

export const STEPS = {
  WELCOME: "WELCOME",
  WAITING_FOR_RECEIPT: "WAITING_FOR_RECEIPT",
  UPLOADING: "UPLOADING",
  OCR_PROCESSING: "OCR_PROCESSING",
  REVIEW_EXTRACTED_DATA: "REVIEW_EXTRACTED_DATA",
  CONFIRM_DATE: "CONFIRM_DATE",
  COLLECT_MISSING_INFORMATION: "COLLECT_MISSING_INFORMATION",
  RUNNING_POLICY_CHECKS: "RUNNING_POLICY_CHECKS",
  SHOW_POLICY_RESULTS: "SHOW_POLICY_RESULTS",
  REVIEW_SUMMARY: "REVIEW_SUMMARY",
  SUBMITTING: "SUBMITTING",
  SUBMITTED: "SUBMITTED",
  DRAFT_SAVED: "DRAFT_SAVED",
  STATUS_TRACKING: "STATUS_TRACKING",
  ERROR: "ERROR",
};

// Steps during which the employee waits and the reply area is disabled.
export const BUSY_STEPS = [
  STEPS.UPLOADING,
  STEPS.OCR_PROCESSING,
  STEPS.RUNNING_POLICY_CHECKS,
  STEPS.SUBMITTING,
];

export const firstName = (name) => String(name ?? "").trim().split(/\s+/)[0] || "";

export const money = (amount, currency = "PHP") =>
  `${currency} ${Number(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// ---------------------------------------------------------------------------
// Questions for details the receipt did not provide
// ---------------------------------------------------------------------------

export const QUESTIONS = {
  amount: { label: "Amount", text: "I couldn't read the total amount. How much was this expense?" },
  expenseDate: { label: "Date", text: "I couldn't read the date on the receipt. When did this expense happen?" },
  merchant: { label: "Merchant", text: "I couldn't read the merchant's name. Who issued this receipt?" },
  purpose: { label: "Purpose", text: "Please confirm the purpose of this expense." },
  location: { label: "Location", text: "Where did this expense occur?" },
  category: { label: "Category", text: "Please confirm the expense category." },
  position: { label: "Position / role", text: "What is your position or role?" },
  department: { label: "Department", text: "Which department do you belong to?" },
};

// Server field paths (SUBMISSION_INCOMPLETE details) → questions.
const SERVER_FIELDS = {
  expenseDate: "expenseDate",
  category: "category",
  amount: "amount",
  purpose: "purpose",
  location: "location",
  position: "position",
  department: "department",
  merchant: "merchant",
};

const isValidDate = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

export const dateNeedsConfirmation = (expense) =>
  Boolean(expense?.dateReview?.ambiguous) &&
  expense.dateReview.confirmedDate !== expense.expenseDate;

// The next details to ask for, in a fixed order. The category is always
// confirmed once, because it decides which company policy applies.
export function missingFields(state) {
  const e = state.expense;
  const blank = (value) => !String(value ?? "").trim();
  const fromServer = new Set(state.serverMissing);
  return [
    (!(Number.isFinite(e.amount) && e.amount > 0) || fromServer.has("amount")) && "amount",
    (!isValidDate(e.expenseDate) || fromServer.has("expenseDate")) && "expenseDate",
    (blank(e.merchant) || fromServer.has("merchant")) && "merchant",
    (blank(e.purpose) || fromServer.has("purpose")) && "purpose",
    (blank(e.location) || fromServer.has("location")) && "location",
    (!state.categoryConfirmed || fromServer.has("category")) && "category",
    !e.identityVerified && (blank(e.position) || fromServer.has("position")) && "position",
    !e.identityVerified && (blank(e.department) || fromServer.has("department")) && "department",
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Server results → what the conversation shows
// ---------------------------------------------------------------------------

// Findings the server reported for this expense (anomaly report, as returned).
export const reportFindings = (report) =>
  (report?.anomalies ?? []).filter((a) => a.status === "flagged" || a.status === "needs_review");

const POLICY_KINDS = {
  POLICY_LIMIT_EXCEEDED: "limit",
  MONTHLY_POLICY_LIMIT_EXCEEDED: "monthly",
  POLICY_ROLE_UNMAPPED: "unmapped",
  POLICY_CURRENCY_UNSUPPORTED: "currency",
  EXCOM_APPROVAL_REQUIRED: "excom",
  EXCOM_APPROVAL_EVIDENCE_MISSING: "excom",
};
const RULE_KINDS = {
  possible_duplicate_claim: "duplicate",
  receipt_unclear_or_invalid: "receipt",
  unclear_or_inconsistent_details: "details",
  missing_receipt: "missing-receipt",
  exceeded_budget_or_policy_limit: "category-limit",
};
export const FINDING_TITLES = {
  limit: "Policy limit exceeded",
  monthly: "Monthly policy limit exceeded",
  unmapped: "Policy role not mapped",
  currency: "Currency not covered by the policy",
  excom: "ExCom approval required",
  duplicate: "Possible duplicate",
  receipt: "Receipt may be unclear",
  details: "Details need clarification",
  "missing-receipt": "No receipt attached",
  "category-limit": "Category limit exceeded",
};

export const findingKind = (finding) =>
  POLICY_KINDS[finding.details?.type] ?? RULE_KINDS[finding.ruleId] ?? "other";

const POLICY_FINDING_KINDS = ["limit", "monthly", "unmapped", "currency", "excom", "category-limit"];

// "I found 1 policy exception for this expense." / "I found 3 items that need attention."
export function resultsHeadline(findings) {
  if (!findings.length) return "Your expense is within the currently applicable policy checks.";
  if (findings.length === 1) {
    return POLICY_FINDING_KINDS.includes(findingKind(findings[0]))
      ? "I found 1 policy exception for this expense."
      : "I found 1 item that needs attention.";
  }
  return `I found ${findings.length} items that need attention.`;
}

// Where the server says the expense goes when submitted (anomalyReport.route).
export function routeSentence(report) {
  if (report?.route === "manager_approval") {
    return "When you submit, it will go to your manager for approval. It is not automatically rejected.";
  }
  if (report?.route === "finance") {
    return "When you submit, it goes directly to Finance.";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Status tracking: only statuses the server records
// ---------------------------------------------------------------------------

export const STATUS_LABELS = {
  Submitted: "Submitted · with Finance",
  "Pending Approval": "Pending Manager Approval",
};

// The steps an expense passes through, from the server's status and route.
// Upcoming steps are never shown as completed.
export function statusTimeline(expense) {
  const status = expense.status;
  const viaManager = expense.anomalyReport?.route === "manager_approval" || status === "Pending Approval";
  const order = ["Submitted", ...(viaManager ? ["Pending Approval"] : []), "Approved", "Reimbursed"];
  const labels = {
    Submitted: "Submitted",
    "Pending Approval": "Pending Manager Approval",
    Approved: "Approved",
    Reimbursed: "Reimbursed",
  };
  if (status === "Rejected" || status === "Needs Correction") {
    return [
      { key: "Submitted", label: "Submitted", state: "done" },
      ...(viaManager ? [{ key: "Pending Approval", label: "Manager review", state: "done" }] : []),
      { key: status, label: status, state: "attention" },
    ];
  }
  const index = order.indexOf(status);
  return order.map((key, i) => ({
    key,
    label: key === "Submitted" && !viaManager && index === 0 ? "Submitted · with Finance" : labels[key],
    state: index < 0 ? "upcoming" : i < index ? "done" : i === index ? (key === "Reimbursed" ? "done" : "current") : "upcoming",
  }));
}

// ---------------------------------------------------------------------------
// State and transitions
// ---------------------------------------------------------------------------

let messageCount = 0;
// A progress card stops following the live state once a newer one replaces it.
const freeze = (messages, type, state) =>
  messages.map((m) =>
    m.type === type && !m.snapshot
      ? { ...m, snapshot: { ocrStage: state.ocrStage, ocrFailedAt: state.ocrFailedAt, checkStage: state.checkStage } }
      : m,
  );

const message = (from, type, data = {}) => ({ id: `m${++messageCount}`, from, type, ...data });
const say = (type, data) => message("assistant", type, data);
const reply = (text) => message("user", "text", { text });

export function initialState() {
  return {
    step: STEPS.WELCOME,
    messages: [say("welcome")],
    expense: null,
    savedId: null,
    report: null,
    ocrStage: null,
    checkStage: null,
    categoryConfirmed: false,
    askedForMore: false,
    serverMissing: [],
    question: null,
    error: null,
    result: null,
  };
}

// After any answer: confirm an ambiguous date, then ask for what is missing,
// then run the server's checks.
function askNext(state) {
  if (dateNeedsConfirmation(state.expense)) {
    if (state.step === STEPS.CONFIRM_DATE) return state;
    return {
      ...state,
      step: STEPS.CONFIRM_DATE,
      question: null,
      messages: [...state.messages, say("date", { review: state.expense.dateReview })],
    };
  }
  const [field, ...rest] = missingFields(state);
  if (field) {
    const intro = state.askedForMore
      ? []
      : [say("text", { text: "I need a little more information before you can submit." })];
    const serverNote = state.serverMessages?.[field];
    return {
      ...state,
      step: STEPS.COLLECT_MISSING_INFORMATION,
      question: field,
      askedForMore: true,
      remaining: rest.length,
      messages: [
        ...state.messages,
        ...intro,
        say("question", { field, text: serverNote ? `${serverNote} ${QUESTIONS[field].text}` : QUESTIONS[field].text }),
      ],
    };
  }
  return {
    ...state,
    step: STEPS.RUNNING_POLICY_CHECKS,
    question: null,
    checkStage: "saving",
    messages: [
      ...freeze(state.messages, "checks", state),
      say("text", { text: "Thanks! I'm checking your expense against the company policies." }),
      say("checks"),
    ],
  };
}

export function reducer(state, action) {
  switch (action.type) {
    case "RESET":
      return { ...initialState(), messages: [say("welcome", { again: true })] };

    case "CHOOSE_ANOTHER":
      return {
        ...initialState(),
        step: STEPS.WAITING_FOR_RECEIPT,
        messages: [...state.messages, say("text", { text: "Okay. Upload or take a photo of another receipt." })],
      };

    case "UPLOAD_STARTED":
      return {
        ...state,
        step: STEPS.UPLOADING,
        ocrStage: "uploading",
        checkStage: null,
        error: null,
        fileName: action.fileName,
        receiptInfo: action.file,
        messages: [
          ...freeze(state.messages, "progress", state),
          reply(`📎 ${action.fileName}`),
          say("text", { text: "Thanks! I've received your receipt and I'm extracting the details." }),
          say("progress", { file: action.file }),
        ],
      };

    case "OCR_PROCESSING":
      return state.step === STEPS.UPLOADING || state.step === STEPS.OCR_PROCESSING
        ? { ...state, step: STEPS.OCR_PROCESSING, ocrStage: "processing" }
        : state;

    case "OCR_DONE":
      return {
        ...state,
        step: STEPS.REVIEW_EXTRACTED_DATA,
        ocrStage: "done",
        expense: action.expense,
        messages: [
          ...state.messages,
          say("text", { text: "I found the following information from your receipt. Please confirm or edit if needed." }),
          say("extracted", { expense: action.expense }),
        ],
      };

    case "FAILED":
      return {
        ...state,
        step: STEPS.ERROR,
        ocrStage: action.kind === "ocr" ? "failed" : state.ocrStage,
        ocrFailedAt: action.kind === "ocr" ? state.ocrStage : state.ocrFailedAt,
        checkStage: action.kind === "checks" ? "failed" : state.checkStage,
        error: { kind: action.kind, message: action.message, auth: action.auth, retry: action.retry },
        messages: [...state.messages, say("error", { kind: action.kind, message: action.message, auth: action.auth })],
      };

    case "RETRY":
      return {
        ...state,
        step: action.step,
        error: null,
        ocrStage: action.step === STEPS.UPLOADING ? "uploading" : state.ocrStage,
        checkStage: action.step === STEPS.RUNNING_POLICY_CHECKS ? "saving" : state.checkStage,
        messages: [
          ...freeze(freeze(state.messages, "progress", state), "checks", state),
          reply("Retry"),
          ...(action.step === STEPS.RUNNING_POLICY_CHECKS ? [say("checks")] : []),
          ...(action.step === STEPS.UPLOADING ? [say("progress", { file: state.receiptInfo })] : []),
        ],
      };

    case "DETAILS_CONFIRMED":
      return askNext({ ...state, messages: [...state.messages, reply("The details look right.")] });

    case "DETAILS_EDITED": {
      const next = { ...state, expense: action.expense, serverMissing: [], serverMessages: {} };
      return askNext({
        ...next,
        // Edited values are confirmed by the employee, category included.
        categoryConfirmed: Boolean(action.expense.category),
        messages: [
          ...state.messages,
          reply("I updated the details."),
          say("extracted", { expense: action.expense, updated: true }),
        ],
      });
    }

    case "DATE_CONFIRMED": {
      const expense = {
        ...state.expense,
        expenseDate: action.date,
        dateReview: { ...state.expense.dateReview, confirmedDate: action.date },
      };
      return askNext({
        ...state,
        step: STEPS.COLLECT_MISSING_INFORMATION,
        expense,
        messages: [...state.messages, reply(action.label)],
      });
    }

    case "ANSWERED": {
      const expense = { ...state.expense, [action.field]: action.value };
      const serverMessages = { ...state.serverMessages };
      delete serverMessages[action.field];
      return askNext({
        ...state,
        expense,
        categoryConfirmed: state.categoryConfirmed || action.field === "category",
        serverMissing: state.serverMissing.filter((f) => f !== action.field),
        serverMessages,
        messages: [...state.messages, reply(action.label)],
      });
    }

    case "CHECKS_SAVED":
      return { ...state, savedId: action.expense.id, checkStage: "checking" };

    case "CHECKS_DONE":
      return {
        ...state,
        step: STEPS.SHOW_POLICY_RESULTS,
        checkStage: "done",
        savedId: action.expense.id,
        saved: action.expense,
        report: action.expense.anomalyReport ?? null,
        expense: { ...state.expense, ...pickServerFields(action.expense) },
        messages: [...state.messages, say("results", { saved: action.expense })],
      };

    case "RECHECK":
      return {
        ...state,
        step: STEPS.RUNNING_POLICY_CHECKS,
        checkStage: "saving",
        expense: { ...state.expense, ...action.changes },
        messages: [...freeze(state.messages, "checks", state), reply(action.label), say("checks")],
      };

    case "SHOW_SUMMARY":
      return {
        ...state,
        step: STEPS.REVIEW_SUMMARY,
        messages: [
          ...state.messages,
          reply("Continue"),
          say("text", { text: "Here's a summary of your expense. Please review and submit." }),
          say("summary", { expense: state.expense, saved: state.saved }),
        ],
      };

    case "EDIT_AGAIN":
      return {
        ...state,
        step: STEPS.REVIEW_EXTRACTED_DATA,
        editing: true,
        messages: [...state.messages, reply("Edit details")],
      };

    case "EDIT_MODE":
      return { ...state, editing: action.editing };

    case "SUBMIT_STARTED":
      return {
        ...state,
        step: STEPS.SUBMITTING,
        messages: [...state.messages, reply(action.label)],
      };

    case "SUBMIT_INCOMPLETE": {
      const fields = action.details.map((d) => SERVER_FIELDS[d.path]).filter(Boolean);
      const serverMessages = Object.fromEntries(
        action.details.filter((d) => SERVER_FIELDS[d.path]).map((d) => [SERVER_FIELDS[d.path], String(d.message)]),
      );
      return askNext({
        ...state,
        askedForMore: false,
        serverMissing: fields,
        serverMessages,
        categoryConfirmed: state.categoryConfirmed && !fields.includes("category"),
      });
    }

    case "DATE_REJECTED":
      // The server still needs the date confirmed: ask again.
      return askNext({
        ...state,
        step: STEPS.COLLECT_MISSING_INFORMATION,
        expense: { ...state.expense, dateReview: { ...state.expense.dateReview, confirmedDate: null } },
      });

    case "SUBMITTED":
      return {
        ...state,
        step: STEPS.SUBMITTED,
        result: action.expense,
        messages: [...state.messages, say("submitted", { expense: action.expense })],
      };

    case "DRAFT_SAVED":
      return {
        ...state,
        step: STEPS.DRAFT_SAVED,
        result: action.expense,
        messages: [
          ...state.messages,
          reply("Save as Draft"),
          say("text", {
            text: `Saved as a draft (${action.expense.requestNumber}). You can finish it later from My Requests.`,
          }),
        ],
      };

    case "TRACK":
      return {
        ...state,
        step: STEPS.STATUS_TRACKING,
        result: action.expense,
        messages: [
          ...state.messages,
          ...(action.label ? [reply(action.label)] : []),
          say("status", { expense: action.expense }),
        ],
      };

    default:
      return state;
  }
}

// Values the server decides or normalizes, kept for the summary.
function pickServerFields(saved) {
  const { id, requestNumber, status, employeeName, position, department, employeeEmail, identityVerified, receiptFiles, receiptJobId, anomalyReport, possibleDuplicates, excomEvidence } = saved;
  return { id, requestNumber, status, employeeName, position, department, employeeEmail, identityVerified, receiptFiles, receiptJobId, anomalyReport, possibleDuplicates, excomEvidence };
}
