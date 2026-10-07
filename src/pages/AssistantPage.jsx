import { useEffect, useReducer, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Camera, FileText, RefreshCw, Save, Send } from "lucide-react";
import {
  BUSY_STEPS,
  findingKind,
  firstName,
  initialState,
  money,
  QUESTIONS,
  reducer,
  reportFindings,
  STEPS,
} from "../components/assistant/assistantFlow";
import {
  AssistantMessage,
  ChecksMessage,
  ErrorMessage,
  ExtractedDetails,
  ProgressSteps,
  ResultsMessage,
  StatusMessage,
  SubmittedMessage,
  SummaryMessage,
  UserMessage,
} from "../components/assistant/ConversationParts";
import { Spinner } from "../components/common/Spinner";
import { ExcomEvidence } from "../components/expenses/PolicyExceptions";
import { config } from "../config/appConfig";
import { useWorkspace } from "../hooks/useWorkspace";
import { api } from "../services/api";
import { isAbortError } from "../services/httpClient";
import { scanReceipt } from "../services/receiptService";
import { createId, formatDate, nowIso, sanitizeFileName } from "../utils/format";
import { validateReceiptFile } from "../utils/receiptFile";

const RECEIPT_TYPES = ".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf";
const CURRENCIES = ["PHP", "USD", "EUR", "GBP", "SGD", "JPY", "AUD", "CAD"];

// The signed-in employee, as the review screen sets it for a new expense. A
// verified Microsoft identity is read-only; the server sets the same values
// from its session when the expense is saved.
function withEmployee(expense, user) {
  const verified = user.provider === "entra";
  return {
    ...expense,
    status: "Draft",
    employeeId: user.id,
    employeeName: user.name,
    employeeEmail: user.email || "",
    identityVerified: verified,
    department: verified ? user.department || "" : expense.department || user.department || "",
    position: verified ? user.position || "" : expense.position || user.position || "",
  };
}

const errorKindOf = (error) => (error?.status === 401 ? { auth: true } : {});

// Reimbursement Assistant: the employee's New Expense flow as a guided
// conversation over the existing receipt scan, expense, policy and anomaly
// endpoints. Messages come from fixed templates (assistantFlow.js).
export function AssistantPage() {
  const { user, authenticated, loading, categories, upsert, upsertCategory } = useWorkspace();
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [policy, setPolicy] = useState(null);
  const controller = useRef(null);
  const receipt = useRef(null);
  const objectUrls = useRef([]);
  const running = useRef(false);
  const lastMessage = useRef(null);
  const cameraInput = useRef(null);
  const fileInput = useRef(null);
  const busy = BUSY_STEPS.includes(state.step);

  useEffect(() => {
    if (!authenticated) return undefined;
    let active = true;
    api.getPolicy().then(
      (value) => active && setPolicy(value),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [authenticated]);

  useEffect(
    () => () => {
      controller.current?.abort();
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  // Show each new message from its start.
  const messageCount = state.messages.length;
  useEffect(() => {
    if (messageCount > 1) {
      lastMessage.current?.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    }
  }, [messageCount]);

  // ---------- receipt scan (ReceiptFlow → API → Veryfi) ----------
  async function runScan() {
    const { file, previews, jobId } = receipt.current;
    controller.current?.abort();
    const scan = new AbortController();
    controller.current = scan;
    try {
      if (!navigator.onLine) {
        throw new Error("You’re offline. Reconnect, then retry.");
      }
      const result = await scanReceipt({
        upload: api.uploadReceipt,
        poll: api.getOCRStatus,
        files: [file],
        jobId,
        signal: scan.signal,
        receiptId: receipt.current.id,
        previews,
        onJob: (id) => {
          receipt.current.jobId = id;
        },
        onStage: (stage) => stage === "processing" && dispatch({ type: "OCR_PROCESSING" }),
      });
      dispatch({ type: "OCR_DONE", expense: withEmployee(result.expense, user) });
    } catch (error) {
      if (!isAbortError(error)) {
        dispatch({ type: "FAILED", kind: "ocr", message: error.message, ...errorKindOf(error) });
      }
    }
  }

  function startScan(files) {
    const file = files[0];
    if (!file) return;
    try {
      validateReceiptFile(file);
    } catch (error) {
      dispatch({ type: "FAILED", kind: "file", message: error.message });
      return;
    }
    const url = URL.createObjectURL(file);
    objectUrls.current.push(url);
    const id = createId();
    receipt.current = {
      id,
      file,
      previews: [
        {
          id: `${id}-1`,
          name: sanitizeFileName(file.name),
          mimeType: file.type,
          size: file.size,
          url,
          pageNumber: 1,
          uploadedAt: nowIso(),
        },
      ],
    };
    dispatch({
      type: "UPLOAD_STARTED",
      fileName: sanitizeFileName(file.name),
      file: { name: sanitizeFileName(file.name), previewUrl: url, mimeType: file.type },
    });
    void runScan();
  }

  // ---------- server checks: saving runs the anomaly and policy checks ----------
  useEffect(() => {
    if (state.step !== STEPS.RUNNING_POLICY_CHECKS || running.current) return;
    running.current = true;
    (async () => {
      try {
        // Saved as an incomplete draft until the employee saves or submits it.
        const saved = state.savedId
          ? await api.updateExpense(state.savedId, state.expense, { incompleteDraft: true })
          : await api.createExpense(state.expense, { incompleteDraft: true });
        upsert(saved);
        dispatch({ type: "CHECKS_DONE", expense: saved });
      } catch (error) {
        dispatch({ type: "FAILED", kind: "checks", message: error.message, ...errorKindOf(error) });
      } finally {
        running.current = false;
      }
    })();
    // Runs once per entry into RUNNING_POLICY_CHECKS.
  }, [state.step]);

  async function submit(label) {
    dispatch({ type: "SUBMIT_STARTED", label });
    try {
      const result = await api.submitExpense(state.savedId, state.expense);
      upsert(result);
      dispatch({ type: "SUBMITTED", expense: result });
    } catch (error) {
      if (error.code === "SUBMISSION_INCOMPLETE" && error.details?.length) {
        // A category Finance has just deactivated: offer the current list.
        if (error.details.some((detail) => detail.path === "category")) {
          await api.getCategories().then(
            (list) => {
              list.forEach(upsertCategory);
              // Employees only receive active categories: any missing one is no longer selectable.
              categories
                .filter((category) => !list.some((item) => item.id === category.id))
                .forEach((category) => upsertCategory({ ...category, active: false }));
            },
            () => {},
          );
        }
        dispatch({ type: "SUBMIT_INCOMPLETE", details: error.details });
      } else if (error.code === "DATE_NOT_CONFIRMED" && state.expense.dateReview?.ambiguous) {
        dispatch({ type: "DATE_REJECTED" });
      } else {
        dispatch({ type: "FAILED", kind: "submit", message: error.message, ...errorKindOf(error), retry: label });
      }
    }
  }

  async function saveDraft() {
    try {
      const saved = await api.updateExpense(state.savedId, state.expense);
      upsert(saved);
      dispatch({ type: "DRAFT_SAVED", expense: saved });
    } catch (error) {
      dispatch({ type: "FAILED", kind: "save", message: error.message, ...errorKindOf(error) });
    }
  }

  async function track(id, label) {
    try {
      dispatch({ type: "TRACK", expense: await api.getExpense(id), label });
    } catch (error) {
      dispatch({ type: "FAILED", kind: "status", message: error.message, ...errorKindOf(error) });
    }
  }

  // The existing detailed review screen, with everything answered so far.
  async function openFullDetails() {
    if (!state.savedId) {
      navigate("/review/new", { state: { expense: state.expense } });
      return;
    }
    try {
      upsert(await api.updateExpense(state.savedId, state.expense, { incompleteDraft: true }));
      navigate(`/review/${state.savedId}`);
    } catch (error) {
      dispatch({ type: "FAILED", kind: "save", message: error.message, ...errorKindOf(error) });
    }
  }

  function retry() {
    const { kind, retry: label } = state.error;
    if (kind === "ocr") {
      dispatch({ type: "RETRY", step: STEPS.UPLOADING });
      void runScan();
    } else if (kind === "checks") {
      dispatch({ type: "RETRY", step: STEPS.RUNNING_POLICY_CHECKS });
    } else if (kind === "submit") {
      void submit(label);
    } else if (kind === "save") {
      void saveDraft();
    } else if (kind === "status") {
      void track(state.result?.id ?? state.savedId, "Refresh status");
    }
  }

  // ---------- conversation ----------
  function renderMessage(message, itemRef) {
    if (message.from === "user") return <UserMessage key={message.id} text={message.text} itemRef={itemRef} />;
    // Earlier progress cards keep the state they ended in; the newest one is live.
    const live = message.snapshot ?? state;
    const content = (() => {
      switch (message.type) {
        case "welcome":
          return message.again ? (
            <p>Let’s start another expense. Upload or take a photo of your receipt.</p>
          ) : (
            <>
              <h2 className="chat-greeting">
                {firstName(user.name) && authenticated ? `Hi, ${firstName(user.name)}!` : "Hi!"}
              </h2>
              <p>I’m your Reimbursement Assistant.</p>
              <p>
                {authenticated || loading || !config.apiBase
                  ? "Upload or take a photo of your receipt to get started."
                  : "Sign in with your Microsoft account to start a new expense."}
              </p>
            </>
          );
        case "progress":
          return (
            <ProgressSteps
              ocrStage={live.ocrStage}
              ocrFailedAt={live.ocrFailedAt}
              checkStage={live.checkStage}
              file={message.file}
            />
          );
        case "checks":
          return <ChecksMessage checkStage={live.checkStage} />;
        case "extracted":
          return <ExtractedDetails expense={message.expense} updated={message.updated} />;
        case "date":
          return (
            <p>
              The receipt shows <strong>{message.review.raw}</strong>. Please confirm the intended date.
            </p>
          );
        case "question":
          return <p>{message.text}</p>;
        case "results":
          return <ResultsMessage saved={message.saved} policy={policy} />;
        case "summary":
          return <SummaryMessage expense={message.expense} saved={message.saved} />;
        case "submitted":
          return <SubmittedMessage expense={message.expense} />;
        case "status":
          return (
            <>
              <p>Here’s the status of your expense.</p>
              <StatusMessage expense={message.expense} />
            </>
          );
        case "error":
          return <ErrorMessage kind={message.kind} message={message.message} auth={message.auth} />;
        default:
          return <p>{message.text}</p>;
      }
    })();
    const card = !["text", "question", "date"].includes(message.type);
    return (
      <AssistantMessage key={message.id} card={card} itemRef={itemRef}>
        {content}
      </AssistantMessage>
    );
  }

  return (
    <div className="assistant-page">
      <header className="page-header assistant-header">
        <div>
          <div className="eyebrow">WORKSPACE / NEW EXPENSE</div>
          <h1>New expense</h1>
          <p>Reimbursement Assistant · guides you from receipt to submission.</p>
        </div>
        <Link className="button" to="/requests">
          My Requests
        </Link>
      </header>
      <section className="conversation" aria-label="Conversation with the Reimbursement Assistant">
        <ol className="chat-log" role="log" aria-live="polite" aria-relevant="additions">
          {state.messages.map((message, index) =>
            renderMessage(message, index === state.messages.length - 1 ? lastMessage : undefined),
          )}
        </ol>
      </section>
      <Composer
        state={state}
        busy={busy}
        user={user}
        authenticated={authenticated}
        loading={loading}
        categories={categories}
        policy={policy}
        dispatch={dispatch}
        onTakePhoto={() => cameraInput.current?.click()}
        onDropFiles={startScan}
        onChooseFile={() => fileInput.current?.click()}
        onRetry={retry}
        onSubmit={submit}
        onSaveDraft={saveDraft}
        onTrack={track}
        onFullDetails={openFullDetails}
        onViewRequest={(id) => navigate(`/requests/${id}`)}
      />
      <input
        ref={cameraInput}
        hidden
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => {
          startScan(Array.from(event.target.files || []));
          event.target.value = "";
        }}
      />
      <input
        ref={fileInput}
        hidden
        type="file"
        accept={RECEIPT_TYPES}
        onChange={(event) => {
          startScan(Array.from(event.target.files || []));
          event.target.value = "";
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reply area: only the actions the current step supports
// ---------------------------------------------------------------------------

function Composer(props) {
  const { state, busy } = props;
  const content = composerContent(props);
  const large = [STEPS.REVIEW_EXTRACTED_DATA, STEPS.SHOW_POLICY_RESULTS].includes(state.step) && content.large;
  return (
    <section
      className={`assistant-composer${large ? " is-form" : ""}`}
      aria-label="Your reply"
      aria-busy={busy || undefined}
    >
      {content.node}
    </section>
  );
}

function composerContent(props) {
  const { state, busy, authenticated, loading, dispatch } = props;
  if (busy) {
    const text = {
      [STEPS.UPLOADING]: "Reading your receipt…",
      [STEPS.OCR_PROCESSING]: "Extracting the details…",
      [STEPS.RUNNING_POLICY_CHECKS]: "Checking company policies…",
      [STEPS.SUBMITTING]: "Submitting your expense…",
    }[state.step];
    return {
      node: (
        <div className="composer-wait" role="status">
          <Spinner />
          <input aria-label="Reply" disabled placeholder={text} />
        </div>
      ),
    };
  }
  switch (state.step) {
    case STEPS.WELCOME:
    case STEPS.WAITING_FOR_RECEIPT:
      return { node: <ReceiptActions {...props} disabled={!authenticated || loading || !config.apiBase} /> };
    case STEPS.REVIEW_EXTRACTED_DATA:
      return state.editing
        ? { large: true, node: <EditDetails {...props} /> }
        : {
            node: (
              <div className="composer-actions">
                <button className="button primary" onClick={() => dispatch({ type: "DETAILS_CONFIRMED" })}>
                  Looks right, continue
                </button>
                <button className="button" onClick={() => dispatch({ type: "EDIT_MODE", editing: true })}>
                  Edit details
                </button>
                <button className="text-button" onClick={props.onFullDetails}>
                  Review full details
                </button>
              </div>
            ),
          };
    case STEPS.CONFIRM_DATE:
      return { node: <DateChoice {...props} /> };
    case STEPS.COLLECT_MISSING_INFORMATION:
      return { node: <Answer key={`${state.question}-${state.messages.length}`} {...props} /> };
    case STEPS.SHOW_POLICY_RESULTS:
      return { large: true, node: <ResultActions {...props} /> };
    case STEPS.REVIEW_SUMMARY:
      return { node: <SummaryActions {...props} /> };
    case STEPS.SUBMITTED:
    case STEPS.DRAFT_SAVED:
    case STEPS.STATUS_TRACKING:
      return {
        node: (
          <div className="composer-actions">
            <button className="button primary" onClick={() => props.onViewRequest(state.result.id)}>
              View Request
            </button>
            {state.step !== STEPS.DRAFT_SAVED && (
              <button
                className="button"
                onClick={() =>
                  props.onTrack(state.result.id, state.step === STEPS.STATUS_TRACKING ? "Refresh status" : "Track status")
                }
              >
                <RefreshCw size={16} aria-hidden="true" />
                {state.step === STEPS.STATUS_TRACKING ? "Refresh status" : "Track status"}
              </button>
            )}
            <button className="button" onClick={() => dispatch({ type: "RESET" })}>
              Submit Another Expense
            </button>
          </div>
        ),
      };
    case STEPS.ERROR:
      return { node: <ErrorActions {...props} /> };
    default:
      return { node: null };
  }
}

function ReceiptActions({ onTakePhoto, onChooseFile, onDropFiles, disabled }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`composer-receipt${dragging ? " dragging" : ""}`}
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (disabled) return;
        event.preventDefault();
        setDragging(false);
        onDropFiles(Array.from(event.dataTransfer.files || []));
      }}
    >
      <p className="composer-drop-hint">Drag and drop a receipt here, or</p>
      {disabled && !config.apiBase ? null : disabled ? (
        <Link className="button primary" to="/profile">
          Sign in to continue
        </Link>
      ) : null}
      <div className="composer-actions">
        <button className="button primary" disabled={disabled} onClick={onTakePhoto}>
          <Camera size={18} aria-hidden="true" />
          Take Photo
        </button>
        <button className="button" disabled={disabled} onClick={onChooseFile}>
          <FileText size={18} aria-hidden="true" />
          Choose Photo / File
        </button>
      </div>
      <small className="composer-hint">
        JPG, PNG, WEBP, HEIC or PDF · up to 20 MB ·{" "}
        <Link to="/upload/batch">Scan several receipts or a long receipt</Link>
      </small>
    </div>
  );
}

function DateChoice({ state, dispatch }) {
  const review = state.expense.dateReview;
  const { dayMonthYear, monthDayYear } = review.candidates;
  const current = state.expense.expenseDate;
  const options = [
    [dayMonthYear, "day/month"],
    [monthDayYear, "month/day"],
    ...(current && current !== dayMonthYear && current !== monthDayYear ? [[current, "as entered"]] : []),
  ];
  return (
    <div className="composer-actions" role="group" aria-label="Confirm receipt date">
      {options.map(([date, how]) => (
        <button
          key={date}
          className="button"
          onClick={() => dispatch({ type: "DATE_CONFIRMED", date, label: `${formatDate(date)} (${how})` })}
        >
          {formatDate(date)} <small>({how})</small>
        </button>
      ))}
    </div>
  );
}

function Answer({ state, dispatch, categories }) {
  const field = state.question;
  const expense = state.expense;
  const active = categories.filter((category) => category.active);
  const initial =
    field === "category"
      ? active.some((category) => category.name === expense.category)
        ? expense.category
        : ""
      : field === "amount"
        ? expense.amount > 0
          ? String(expense.amount)
          : ""
        : String(expense[field] ?? "");
  const [value, setValue] = useState(initial);
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  const label = QUESTIONS[field].label;
  const valid =
    field === "amount"
      ? Number(value) > 0
      : field === "expenseDate"
        ? /^\d{4}-\d{2}-\d{2}$/.test(value)
        : value.trim() !== "";
  function send(event) {
    event.preventDefault();
    if (!valid) return;
    const answer = field === "amount" ? Number(value) : value.trim();
    dispatch({
      type: "ANSWERED",
      field,
      value: answer,
      label:
        field === "amount"
          ? money(answer, expense.currency)
          : field === "expenseDate"
            ? formatDate(answer)
            : answer,
    });
  }
  const id = `assistant-${field}`;
  return (
    <form className="composer-answer" onSubmit={send}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      {field === "category" ? (
        active.length ? (
          <select id={id} ref={inputRef} value={value} onChange={(event) => setValue(event.target.value)}>
            <option value="">Select category</option>
            {active.map((category) => (
              <option key={category.id}>{category.name}</option>
            ))}
          </select>
        ) : (
          <p className="composer-hint" id={id}>
            No expense categories are available yet. Finance sets them up; you can save this as a draft
            from the full details screen.
          </p>
        )
      ) : (
        <input
          id={id}
          ref={inputRef}
          type={field === "amount" ? "number" : field === "expenseDate" ? "date" : "text"}
          inputMode={field === "amount" ? "decimal" : undefined}
          step={field === "amount" ? ".01" : undefined}
          min={field === "amount" ? "0" : undefined}
          maxLength={field === "amount" || field === "expenseDate" ? undefined : 500}
          placeholder={
            { purpose: "e.g. Client meeting with ACME", location: "e.g. Makati City" }[field] ?? ""
          }
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      <button className="button primary" type="submit" disabled={!valid}>
        {field === "category" ? "Confirm category" : "Continue"}
      </button>
    </form>
  );
}

function EditDetails({ state, dispatch, categories }) {
  const [draft, setDraft] = useState(state.expense);
  const set = (field) => (event) =>
    setDraft((current) => ({
      ...current,
      [field]: field === "amount" ? Number(event.target.value) : event.target.value,
    }));
  const active = categories.filter((category) => category.active);
  const text = (field, label, type = "text") => (
    <label className="field" key={field}>
      <span>{label}</span>
      <input
        id={`assistant-edit-${field}`}
        type={type}
        step={type === "number" ? ".01" : undefined}
        min={type === "number" ? "0" : undefined}
        value={String(draft[field] ?? "")}
        onChange={set(field)}
      />
    </label>
  );
  return (
    <form
      className="composer-edit"
      onSubmit={(event) => {
        event.preventDefault();
        dispatch({ type: "EDIT_MODE", editing: false });
        dispatch({ type: "DETAILS_EDITED", expense: draft });
      }}
    >
      <h2 className="composer-title">Edit details</h2>
      <div className="form-grid">
        {text("merchant", "Merchant")}
        {text("expenseDate", "Date", "date")}
        {text("amount", "Amount", "number")}
        <label className="field">
          <span>Currency</span>
          <select id="assistant-edit-currency" value={draft.currency} onChange={set("currency")}>
            {[...new Set([draft.currency, ...CURRENCIES])].filter(Boolean).map((currency) => (
              <option key={currency}>{currency}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Category</span>
          <select id="assistant-edit-category" value={active.some((c) => c.name === draft.category) ? draft.category : ""} onChange={set("category")}>
            <option value="">Select category</option>
            {active.map((category) => (
              <option key={category.id}>{category.name}</option>
            ))}
          </select>
        </label>
        {text("purpose", "Purpose")}
        {text("location", "Location")}
      </div>
      <p className="composer-hint">Employee details come from your Microsoft profile and can’t be edited.</p>
      <div className="composer-actions">
        <button className="button primary" type="submit">
          Save changes
        </button>
        <button className="button" type="button" onClick={() => dispatch({ type: "EDIT_MODE", editing: false })}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ResultActions({ state, dispatch, policy, onFullDetails }) {
  const findings = reportFindings(state.report);
  const excom = findings.find((finding) => findingKind(finding) === "excom");
  const duplicate = findings.find((finding) => findingKind(finding) === "duplicate");
  const [evidence, setEvidence] = useState(state.expense.excomEvidence ?? null);
  const [reason, setReason] = useState(state.expense.duplicateOverrideReason ?? "");
  const evidenceChanged = JSON.stringify(evidence ?? null) !== JSON.stringify(state.expense.excomEvidence ?? null);
  return (
    <div className="composer-results">
      {excom && (
        <section className="composer-section" aria-labelledby="composer-excom">
          <h2 className="composer-title" id="composer-excom">
            ExCom approval evidence
          </h2>
          <ExcomEvidence
            evidence={evidence}
            types={policy?.representationRules?.evidenceTypes ?? {}}
            onChange={setEvidence}
          />
          <button
            className="button"
            disabled={!evidenceChanged || !evidence?.type}
            onClick={() =>
              dispatch({ type: "RECHECK", changes: { excomEvidence: evidence }, label: "I added the ExCom approval evidence." })
            }
          >
            Save evidence and check again
          </button>
        </section>
      )}
      {duplicate && (
        <section className="composer-section" aria-labelledby="composer-duplicate">
          <h2 className="composer-title" id="composer-duplicate">
            Not a duplicate?
          </h2>
          <label className="field">
            <span>Explain why this is a separate expense</span>
            <textarea
              id="assistant-duplicate-reason"
              value={reason}
              maxLength={1000}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            className="button"
            disabled={reason.trim().length < 3 || reason.trim() === (state.expense.duplicateOverrideReason ?? "")}
            onClick={() =>
              dispatch({
                type: "RECHECK",
                changes: { duplicateOverrideReason: reason.trim() },
                label: `Not a duplicate: ${reason.trim()}`,
              })
            }
          >
            Record explanation and check again
          </button>
        </section>
      )}
      <div className="composer-actions">
        <button className="button primary" onClick={() => dispatch({ type: "SHOW_SUMMARY" })}>
          Continue
        </button>
        <button className="button" onClick={onFullDetails}>
          Review full details
        </button>
      </div>
    </div>
  );
}

function SummaryActions({ state, dispatch, onSubmit, onSaveDraft, onFullDetails }) {
  const findings = reportFindings(state.report);
  const toManager = state.report?.route === "manager_approval";
  const label = toManager ? "Submit for Approval" : "Submit";
  const duplicateUnexplained =
    findings.some((finding) => findingKind(finding) === "duplicate") && !state.expense.duplicateOverrideReason;
  return (
    <div className="composer-summary">
      {duplicateUnexplained && (
        <p className="composer-hint" id="assistant-submit-note">
          Explain the possible duplicate before submitting. Choose Edit details, or use Review full details.
        </p>
      )}
      <div className="composer-actions">
        <button
          className="button primary"
          disabled={duplicateUnexplained}
          aria-describedby={duplicateUnexplained ? "assistant-submit-note" : undefined}
          onClick={() => onSubmit(label)}
        >
          <Send size={16} aria-hidden="true" />
          {label}
        </button>
        <button className="button" onClick={onSaveDraft}>
          <Save size={16} aria-hidden="true" />
          Save as Draft
        </button>
        <button className="button" onClick={() => dispatch({ type: "EDIT_AGAIN" })}>
          Edit details
        </button>
        <button className="text-button" onClick={onFullDetails}>
          Review full details
        </button>
      </div>
    </div>
  );
}

function ErrorActions({ state, dispatch, onRetry, onTakePhoto, onChooseFile }) {
  const { kind, auth } = state.error;
  if (auth) {
    return (
      <div className="composer-actions">
        <Link className="button primary" to="/profile">
          Sign in again
        </Link>
        {state.savedId && <p className="composer-hint">Your expense was saved as a draft at the last check.</p>}
      </div>
    );
  }
  if (kind === "file" || kind === "ocr") {
    return (
      <div className="composer-actions">
        {kind === "ocr" && (
          <button className="button primary" onClick={onRetry}>
            <RefreshCw size={16} aria-hidden="true" />
            Retry
          </button>
        )}
        <button
          className="button"
          onClick={() => {
            dispatch({ type: "CHOOSE_ANOTHER" });
          }}
        >
          Choose another receipt
        </button>
        {kind === "file" && (
          <>
            <button className="button" onClick={onTakePhoto}>
              <Camera size={18} aria-hidden="true" />
              Take Photo
            </button>
            <button className="button" onClick={onChooseFile}>
              <FileText size={18} aria-hidden="true" />
              Choose Photo / File
            </button>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="composer-actions">
      <button className="button primary" onClick={onRetry}>
        <RefreshCw size={16} aria-hidden="true" />
        Retry
      </button>
      {state.savedId && ["checks", "submit", "save"].includes(kind) && (
        <button className="button" onClick={() => dispatch({ type: "EDIT_AGAIN" })}>
          Edit details
        </button>
      )}
    </div>
  );
}
