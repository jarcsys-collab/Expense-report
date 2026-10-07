// Messages and cards of the Reimbursement Assistant conversation. They only
// present the expense being prepared and the results the server returned.
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  FileText,
  Info,
  MessageCircle,
  TriangleAlert,
} from "lucide-react";
import { config } from "../../config/appConfig";
import { formatDate } from "../../utils/format";
import { Spinner } from "../common/Spinner";
import { ReceiptAssociation } from "../receipts/ReceiptAssociation";
import {
  findingKind,
  FINDING_TITLES,
  money,
  reportFindings,
  resultsHeadline,
  routeSentence,
  STATUS_LABELS,
  statusTimeline,
} from "./assistantFlow";

export function AssistantMessage({ children, card = false, itemRef }) {
  return (
    <li className="chat-row assistant" ref={itemRef}>
      <span className="chat-avatar" aria-hidden="true">
        <MessageCircle size={16} />
      </span>
      <div className={`chat-bubble${card ? " chat-card" : ""}`}>
        <span className="sr-only">Reimbursement Assistant: </span>
        {children}
      </div>
    </li>
  );
}

export function UserMessage({ text, itemRef }) {
  return (
    <li className="chat-row user" ref={itemRef}>
      <div className="chat-bubble">
        <span className="sr-only">You: </span>
        {text}
      </div>
    </li>
  );
}

function Rows({ rows }) {
  return (
    <dl className="chat-rows">
      {rows
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Progress (tied to the real upload, OCR and check states)
// ---------------------------------------------------------------------------

const STATE_TEXT = { done: "done", active: "in progress", pending: "not started", failed: "failed" };

function StepIcon({ state }) {
  if (state === "done") return <CircleCheck size={17} aria-hidden="true" />;
  if (state === "active") return <Spinner />;
  if (state === "failed") return <CircleX size={17} aria-hidden="true" />;
  return <CircleDashed size={17} aria-hidden="true" />;
}

const SCAN_STATUS = {
  uploading: "Reading receipt…",
  processing: "Extracting details…",
  done: "Details extracted",
  failed: "Could not be processed",
};

// The receipt being scanned: its preview (images only, from this browser),
// name and the real scan state.
function ScanFile({ file, ocrStage }) {
  const busy = ocrStage === "uploading" || ocrStage === "processing";
  return (
    <div className="scan-file">
      {file.previewUrl && file.mimeType?.startsWith("image/") ? (
        <img src={file.previewUrl} alt="" />
      ) : (
        <span className="scan-file-icon">
          <FileText size={22} aria-hidden="true" />
        </span>
      )}
      <span className="scan-file-text">
        <strong>{file.name}</strong>
        <small>{SCAN_STATUS[ocrStage] ?? ""}</small>
        {ocrStage !== "failed" && (
          <span
            className={`progress ${busy ? "indeterminate" : ""}`}
            role="progressbar"
            aria-label={`${file.name}: ${SCAN_STATUS[ocrStage] ?? ""}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={busy ? undefined : 100}
          >
            <i style={{ width: busy ? "0%" : "100%" }} />
          </span>
        )}
      </span>
    </div>
  );
}

export function ProgressSteps({ ocrStage, ocrFailedAt, checkStage, file }) {
  const ocr = (activeAt, doneAfter) => {
    if (ocrStage === "failed") {
      const order = ["uploading", "processing"];
      const failedIndex = order.indexOf(ocrFailedAt);
      const mine = order.indexOf(activeAt);
      return mine < failedIndex ? "done" : mine === failedIndex ? "failed" : "pending";
    }
    if (ocrStage === "done") return "done";
    if (ocrStage === activeAt) return "active";
    return doneAfter.includes(ocrStage) ? "done" : "pending";
  };
  const steps = [
    ["Reading receipt", ocr("uploading", ["processing"])],
    ["Extracting details", ocr("processing", [])],
    ["Checking required information", ocrStage === "done" ? "done" : ocrStage === "failed" ? "pending" : "pending"],
    [
      "Checking company policies",
      checkStage === "done" ? "done" : checkStage === "failed" ? "failed" : checkStage ? "active" : "pending",
    ],
  ];
  return (
    <>
    {file && <ScanFile file={file} ocrStage={ocrStage} />}
    <ul className="progress-steps" aria-label="Receipt processing">
      {steps.map(([label, state]) => (
        <li key={label} data-state={state}>
          <StepIcon state={state} />
          <span>
            {label}
            <span className="sr-only"> ({STATE_TEXT[state]})</span>
            {label === "Checking company policies" && state === "pending" && ocrStage !== "failed" && (
              <small> · after you confirm the details</small>
            )}
          </span>
        </li>
      ))}
    </ul>
    </>
  );
}

export function ChecksMessage({ checkStage }) {
  const state = checkStage === "done" ? "done" : checkStage === "failed" ? "failed" : "active";
  return (
    <>
      <ul className="progress-steps" aria-label="Policy checks">
        <li data-state={state}>
          <StepIcon state={state} />
          <span>
            Checking company policies and expense rules
            <span className="sr-only"> ({STATE_TEXT[state]})</span>
          </span>
        </li>
      </ul>
      <p className="chat-note">
        Your expense is saved as an incomplete draft so the checks can run on it. It stays incomplete until
        you save or submit it.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Extracted details
// ---------------------------------------------------------------------------

const lowConfidence = (expense, field) =>
  expense.ocrConfidence?.[field] !== undefined && expense.ocrConfidence[field] < config.confidence;

function detail(expense, field, value, missingText = "Not found · I'll ask you") {
  if (value === undefined || value === null || value === "") {
    return <span className="chat-missing">{missingText}</span>;
  }
  return lowConfidence(expense, field) ? (
    <>
      {value}{" "}
      <span className="chat-check">
        <TriangleAlert size={13} aria-hidden="true" /> Check this
      </span>
    </>
  ) : (
    value
  );
}

export function ExtractedDetails({ expense, updated }) {
  const review = expense.dateReview;
  const date = expense.expenseDate ? formatDate(expense.expenseDate) : "";
  const dateNote =
    review?.ambiguous && review.confirmedDate !== expense.expenseDate
      ? ` · receipt shows “${review.raw}”, please confirm`
      : "";
  return (
    <>
      <h3>{updated ? "Updated details" : "Receipt details"}</h3>
      <Rows
        rows={[
          ["Merchant", detail(expense, "merchant", expense.merchant)],
          ["Date", detail(expense, "expenseDate", date && `${date}${dateNote}`)],
          [
            "Amount",
            detail(
              expense,
              "amount",
              Number.isFinite(expense.amount) && expense.amount > 0
                ? money(expense.amount, expense.currency)
                : "",
            ),
          ],
          ["Category", detail(expense, "category", expense.category, "To confirm")],
          ["Purpose", detail(expense, "purpose", expense.purpose)],
          ["Location", detail(expense, "location", expense.location)],
        ]}
      />
      <h3>Employee</h3>
      <Rows
        rows={[
          ["Employee name", expense.employeeName || "Not provided"],
          ["Position / role", expense.position || "Not provided in Microsoft profile"],
          ["Department", expense.department || "Not provided in Microsoft profile"],
        ]}
      />
      {expense.identityVerified && (
        <p className="chat-note">From your Microsoft profile. These details can’t be edited here.</p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Policy and anomaly results (exactly as the server returned them)
// ---------------------------------------------------------------------------

const reviewStatus = (finding) =>
  finding.status === "flagged" ? "Manager approval required" : "Manager review required";

function categoryLabel(details, policy, expense) {
  return policy?.categories?.[details?.category]?.label ?? expense.category;
}

function position(details, policy) {
  if (!details?.employeeRole) return undefined;
  const group = policy?.roleGroups?.[details.policyGroup]?.label;
  return group ? `${details.employeeRole} (${group})` : details.employeeRole;
}

export function FindingCard({ finding, policy, report, expense }) {
  const kind = findingKind(finding);
  const d = finding.details ?? {};
  const currency = policy?.currency ?? "PHP";
  const toManager = report?.route === "manager_approval";
  const routing = toManager
    ? " It will be submitted to your manager for approval. It is not automatically rejected."
    : "";
  let rows = [];
  let text = finding.message;
  if (kind === "limit") {
    rows = [
      ["Category", categoryLabel(d, policy, expense)],
      ["Your position", position(d, policy)],
      ["Policy limit", money(d.policyLimit, currency)],
      ["Submitted amount", money(d.submittedAmount, currency)],
      ["Exceeded by", money(d.excessAmount, currency)],
    ];
    text = `This expense exceeds the applicable limit by ${money(d.excessAmount, currency)}.${routing}`;
  } else if (kind === "monthly") {
    rows = [
      ["Category", categoryLabel(d, policy, expense)],
      ["Your position", position(d, policy)],
      ["This expense", money(d.submittedAmount, currency)],
      ["Earlier this month", money(d.previousAmount, currency)],
      [`Total for ${d.month}`, money(d.monthlyTotal, currency)],
      ["Monthly limit", money(d.policyLimit, currency)],
      ["Exceeded by", money(d.excessAmount, currency)],
    ];
    text = `Your ${categoryLabel(d, policy, expense)} expenses for ${d.month} exceed the monthly limit by ${money(d.excessAmount, currency)}.${routing}`;
  } else if (kind === "excom") {
    const provided = d.evidenceStatus === "provided";
    rows = [
      ["Category", categoryLabel(d, policy, expense)],
      ["Amount", money(d.submittedAmount, currency)],
      ["ExCom approval needed from", money(d.threshold, currency)],
      ["ExCom approval evidence", provided ? "Evidence provided (not verified by ReceiptFlow)" : "Evidence missing"],
    ];
    text = provided
      ? "ExCom approval evidence is required for this expense. You provided evidence; ReceiptFlow does not verify it, so your manager reviews it."
      : "ExCom approval evidence is required for this expense. Add the evidence below.";
  } else if (kind === "duplicate") {
    const matches = report?.possibleDuplicates ?? [];
    return (
      <article className="finding-card" aria-labelledby={`finding-${finding.ruleId}`}>
        <FindingHeader id={`finding-${finding.ruleId}`} title={FINDING_TITLES.duplicate} />
        <p>{finding.message}</p>
        {matches.length > 0 && (
          <ul className="finding-matches">
            {matches.map((match) => (
              <li key={match.id}>
                <a href={`#/requests/${match.id}`} target="_blank" rel="noopener">
                  {match.requestNumber || "Earlier expense"}
                </a>
                {[match.merchant, match.amount !== undefined && money(match.amount, match.currency), match.expenseDate && formatDate(match.expenseDate)]
                  .filter(Boolean)
                  .map((part) => ` · ${part}`)}
              </li>
            ))}
          </ul>
        )}
        <Rows rows={[["Status", reviewStatus(finding)]]} />
      </article>
    );
  }
  return (
    <article className="finding-card" aria-labelledby={`finding-${finding.ruleId}`}>
      <FindingHeader
        id={`finding-${finding.ruleId}`}
        title={FINDING_TITLES[kind] ?? finding.name}
      />
      <Rows rows={[...rows, ["Status", reviewStatus(finding)]]} />
      <p>{text}</p>
    </article>
  );
}

function FindingHeader({ id, title }) {
  return (
    <header>
      <TriangleAlert size={16} aria-hidden="true" />
      <span className="finding-eyebrow">Needs attention</span>
      <h4 id={id}>{title}</h4>
    </header>
  );
}

export function ResultsMessage({ saved, policy }) {
  const report = saved.anomalyReport;
  const findings = reportFindings(report);
  const notRun = (report?.anomalies ?? []).filter((a) => a.status === "not_evaluated");
  return (
    <div className="chat-results">
      <h3 className={findings.length ? "results-headline attention" : "results-headline clear"}>
        {findings.length ? (
          <CircleAlert size={17} aria-hidden="true" />
        ) : (
          <CircleCheck size={17} aria-hidden="true" />
        )}
        {resultsHeadline(findings)}
      </h3>
      {findings.length > 0 && (
        <div className="finding-list">
          {findings.map((finding) => (
            <FindingCard
              key={finding.ruleId}
              finding={finding}
              policy={policy}
              report={report}
              expense={saved}
            />
          ))}
        </div>
      )}
      {routeSentence(report) && (
        <p className="chat-info">
          <Info size={15} aria-hidden="true" />
          <span>{routeSentence(report)}</span>
        </p>
      )}
      {notRun.length > 0 && (
        <p className="chat-note">
          {notRun.length === 1 ? "1 check" : `${notRun.length} checks`} could not run yet because the data
          they need isn’t connected: {notRun.map((a) => a.name.toLowerCase()).join("; ")}.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary, submission and status
// ---------------------------------------------------------------------------

export function SummaryMessage({ expense, saved }) {
  const report = saved?.anomalyReport;
  const findings = reportFindings(report);
  return (
    <>
      <h3>Employee</h3>
      <Rows
        rows={[
          ["Employee", expense.employeeName],
          ["Position / role", expense.position || "Not provided"],
          ["Department", expense.department || "Not provided"],
        ]}
      />
      <h3>Expense</h3>
      <Rows
        rows={[
          ["Merchant", expense.merchant],
          ["Date", expense.expenseDate && formatDate(expense.expenseDate)],
          ["Category", expense.category],
          ["Amount", money(expense.amount, expense.currency)],
          ["Purpose", expense.purpose],
          ["Location", expense.location],
        ]}
      />
      <h3>Receipt</h3>
      <ReceiptAssociation expense={expense} />
      <h3>Policy status</h3>
      <p>{resultsHeadline(findings)}</p>
      {findings.length > 0 && (
        <ul className="summary-findings">
          {findings.map((finding) => (
            <li key={finding.ruleId}>
              <TriangleAlert size={14} aria-hidden="true" />
              {FINDING_TITLES[findingKind(finding)] ?? finding.name} · {reviewStatus(finding)}
            </li>
          ))}
        </ul>
      )}
      {expense.duplicateOverrideReason && (
        <p className="chat-note">Your explanation: “{expense.duplicateOverrideReason}”</p>
      )}
    </>
  );
}

const dateTime = (value) =>
  value
    ? new Date(value).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

// Where the server sent the expense, in words (from its status).
const STATUS_NOTES = {
  "Pending Approval": "Your expense is with your manager for approval.",
  Submitted: "Your expense was sent directly to Finance.",
  "Needs Correction": "Your expense needs a correction. Open the request for details.",
  Rejected: "Your expense was rejected. Open the request for details.",
};

function StatusPill({ status }) {
  const tone = { "Pending Approval": "pending", Approved: "success", Reimbursed: "success", Rejected: "danger", "Needs Correction": "warning" }[status] ?? "";
  return (
    <span className={`badge ${tone}`}>
      <i />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function SubmittedMessage({ expense }) {
  return (
    <>
      <div className="chat-success">
        <CircleCheck size={20} aria-hidden="true" />
        <div>
          <h3>Expense submitted!</h3>
          {STATUS_NOTES[expense.status] && <p>{STATUS_NOTES[expense.status]}</p>}
        </div>
      </div>
      <Rows
        rows={[
          ["Request ID", expense.requestNumber],
          ["Amount", money(expense.amount, expense.currency)],
          ["Category", expense.category],
          ["Submitted", dateTime(expense.submittedAt)],
          ["Current status", <StatusPill status={expense.status} />],
        ]}
      />
    </>
  );
}

const TIMELINE_TEXT = { done: "completed", current: "current", upcoming: "upcoming", attention: "current" };

export function StatusMessage({ expense }) {
  const steps = statusTimeline(expense);
  return (
    <>
      <h3>
        {expense.requestNumber} · {money(expense.amount, expense.currency)}
      </h3>
      <ol className="status-timeline" aria-label="Expense status">
        {steps.map((step) => (
          <li key={step.key} data-state={step.state} aria-current={step.state === "current" || step.state === "attention" ? "step" : undefined}>
            {step.state === "done" ? (
              <CircleCheck size={17} aria-hidden="true" />
            ) : step.state === "attention" ? (
              <CircleAlert size={17} aria-hidden="true" />
            ) : (
              <CircleDashed size={17} aria-hidden="true" />
            )}
            <span className="timeline-text">
              <span className="timeline-label">
                {step.label}
                <span className="sr-only"> ({TIMELINE_TEXT[step.state]})</span>
              </span>
              {step.key === "Submitted" && expense.submittedAt && <small>{dateTime(expense.submittedAt)}</small>}
              {(step.state === "current" || step.state === "attention") && step.key !== "Submitted" && STATUS_NOTES[expense.status] && (
                <small>{STATUS_NOTES[expense.status]}</small>
              )}
              {step.state === "current" && step.key === "Submitted" && STATUS_NOTES.Submitted && (
                <small>{STATUS_NOTES.Submitted}</small>
              )}
            </span>
          </li>
        ))}
      </ol>
      <p className="chat-note">
        Current status: {STATUS_LABELS[expense.status] ?? expense.status}
        {expense.updatedAt ? ` · updated ${dateTime(expense.updatedAt)}` : ""}
      </p>
    </>
  );
}

const ERROR_TITLES = {
  ocr: "I couldn't process this receipt.",
  file: "I can't use this file.",
  checks: "I couldn't check this expense right now.",
  submit: "I couldn't submit this expense.",
  save: "I couldn't save this expense.",
  status: "I couldn't load the status right now.",
};

export function ErrorMessage({ kind, message, auth }) {
  return (
    <>
      <h3 className="results-headline attention">
        <CircleAlert size={17} aria-hidden="true" />
        {auth ? "Your session has expired. Sign in again to continue." : ERROR_TITLES[kind]}
      </h3>
      {!auth && message && <p>{message}</p>}
    </>
  );
}
