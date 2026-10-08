import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Camera, CircleCheck, FileText, RefreshCw, Save, Send } from "lucide-react";
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

  // ---------- keeping the current question in view ----------
  // The newest message (usually the current question) is placed right above
  // the reply area, so the question and its answer control are seen together.
  // Someone reading earlier messages is only brought back down when a new
  // step asks them for something.
  const composerRef = useRef(null);
  const readingEarlier = useRef(false);
  // A scroll the assistant makes itself, so it is not mistaken for the employee's.
  const autoScroll = useRef(false);
  const pendingReveal = useRef(undefined);
  useEffect(() => {
    const onScroll = () => {
      const gap = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
      readingEarlier.current = gap > 240;
      // The employee scrolled: drop any follow-up adjustment still waiting.
      if (!autoScroll.current) clearTimeout(pendingReveal.current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  function revealCurrent() {
    const target = lastMessage.current;
    const composer = composerRef.current;
    if (!target || !composer) return;
    const viewport = window.visualViewport;
    const viewTop = (viewport?.offsetTop ?? 0) + 8;
    let viewBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    // Phone bottom navigation (hidden while the keyboard is open).
    const nav = document.querySelector(".mobile-rail");
    const navBox = nav?.getBoundingClientRect();
    if (navBox && navBox.height > 0 && navBox.width > navBox.height) {
      viewBottom = Math.min(viewBottom, navBox.top);
    }
    const sticky = getComputedStyle(composer).position === "sticky";
    const limit = (sticky ? Math.min(composer.getBoundingClientRect().top, viewBottom) : viewBottom) - 12;
    const box = target.getBoundingClientRect();
    let delta = 0;
    if (box.height > limit - viewTop || box.top < viewTop) delta = box.top - viewTop;
    else if (box.bottom > limit) delta = box.bottom - limit;
    if (Math.abs(delta) > 1) {
      autoScroll.current = true;
      window.scrollBy({ top: delta, behavior: "auto" });
      // The scroll event fires before the next frames; ours ends after them.
      requestAnimationFrame(() => requestAnimationFrame(() => (autoScroll.current = false)));
    }
  }
  const messageCount = state.messages.length;
  useLayoutEffect(() => {
    if (messageCount < 2 || (readingEarlier.current && busy)) return undefined;
    revealCurrent();
    // Once more after late layout (images, fonts, the reply area's height),
    // cancelled if the employee scrolls in the meantime.
    pendingReveal.current = setTimeout(revealCurrent, 120);
    return () => clearTimeout(pendingReveal.current);
  }, [messageCount, state.step, state.draftNote]);
  // Phone keyboard: when it opens over an answer field, keep the question above it.
  useEffect(() => {
    const viewport = window.visualViewport;
    const keepVisible = () => {
      if (composerRef.current?.contains(document.activeElement)) setTimeout(revealCurrent, 60);
    };
    viewport?.addEventListener("resize", keepVisible);
    document.addEventListener("focusin", keepVisible);
    return () => {
      viewport?.removeEventListener("resize", keepVisible);
      document.removeEventListener("focusin", keepVisible);
    };
  }, []);

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
        // Saved as an incomplete draft until the employee saves (Save Draft) or submits it.
        const options = { incompleteDraft: !state.userSaved };
        const saved = state.savedId
          ? await api.updateExpense(state.savedId, state.expense, options)
          : await api.createExpense(state.expense, options);
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

  // Save Draft: the existing draft save (POST, or PATCH once saved) as a
  // normal draft. The conversation continues where it was.
  async function saveDraft() {
    if (state.draftNote?.saving) return;
    dispatch({ type: "DRAFT_SAVING" });
    try {
      const saved = state.savedId
        ? await api.updateExpense(state.savedId, state.expense)
        : await api.createExpense(state.expense);
      upsert(saved);
      dispatch({ type: "DRAFT_SAVED", expense: saved });
    } catch (error) {
      dispatch({ type: "DRAFT_FAILED", message: error.message, auth: error?.status === 401 });
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
      upsert(await api.updateExpense(state.savedId, state.expense, { incompleteDraft: !state.userSaved }));
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
        composerRef={composerRef}
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
  const { state, busy, composerRef } = props;
  const content = composerContent(props);
  const large = [STEPS.REVIEW_EXTRACTED_DATA, STEPS.SHOW_POLICY_RESULTS].includes(state.step) && content.large;
  return (
    <section
      ref={composerRef}
      className={`assistant-composer${large ? " is-form" : ""}`}
      aria-label="Your reply"
      aria-busy={busy || undefined}
    >
      <DraftNote note={state.draftNote} />
      {content.node}
    </section>
  );
}

// Steps where the expense has enough to be saved as a draft.
const DRAFT_STEPS = [
  STEPS.REVIEW_EXTRACTED_DATA,
  STEPS.CONFIRM_DATE,
  STEPS.COLLECT_MISSING_INFORMATION,
  STEPS.SHOW_POLICY_RESULTS,
  STEPS.REVIEW_SUMMARY,
];

function SaveDraftButton({ state, onSaveDraft }) {
  if (!DRAFT_STEPS.includes(state.step) || !state.expense) return null;
  const saving = Boolean(state.draftNote?.saving);
  return (
    <button type="button" className="button save-draft" disabled={saving} onClick={onSaveDraft}>
      {saving ? <Spinner /> : <Save size={16} aria-hidden="true" />}
      {saving ? "Saving…" : "Save Draft"}
    </button>
  );
}

function DraftNote({ note }) {
  if (!note || note.saving) return null;
  if (note.error) {
    return (
      <p className="composer-draft-note error" role="alert">
        {note.auth ? (
          <>
            Draft not saved: your session has expired. <Link to="/profile">Sign in again</Link> to continue.
          </>
        ) : (
          `Draft not saved: ${note.error}`
        )}
      </p>
    );
  }
  return (
    <p className="composer-draft-note" role="status">
      <CircleCheck size={15} aria-hidden="true" />
      <span>Draft saved ({note.requestNumber}). You can keep going, or finish it later from My Requests.</span>
    </p>
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
        <p className="composer-wait" role="status">
          <Spinner />
          {text}
        </p>
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
                <SaveDraftButton {...props} />
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
    case STEPS.STATUS_TRACKING:
      return {
        node: (
          <div className="composer-actions">
            <button className="button primary" onClick={() => props.onViewRequest(state.result.id)}>
              View Request
            </button>
            <button
              className="button"
              onClick={() =>
                props.onTrack(state.result.id, state.step === STEPS.STATUS_TRACKING ? "Refresh status" : "Track status")
              }
            >
              <RefreshCw size={16} aria-hidden="true" />
              {state.step === STEPS.STATUS_TRACKING ? "Refresh status" : "Track status"}
            </button>
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

function DateChoice(props) {
  const { state, dispatch } = props;
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
      <SaveDraftButton {...props} />
    </div>
  );
}

// Answer placeholders: what to enter, never an example answer.
const PLACEHOLDERS = {
  purpose: "Enter purpose",
  location: "Enter location",
  merchant: "Enter merchant",
  amount: "Enter amount",
  position: "Enter position or role",
  department: "Enter department",
};

function Answer(props) {
  const { state, dispatch, categories } = props;
  const field = state.question;
  const expense = state.expense;
  const active = categories.filter((category) => category.active);
  // Every answer starts empty: the employee types or picks the value.
  const [value, setValue] = useState("");
  const inputRef = useRef(null);
  useEffect(() => {
    // Focus with a mouse or trackpad; on touch screens a programmatic focus
    // would throw the keyboard up unasked, so the employee taps the field.
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus({ preventScroll: true });
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
          placeholder={PLACEHOLDERS[field]}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      <div className="composer-answer-actions">
        <button className="button primary" type="submit" disabled={!valid}>
          {field === "category" ? "Confirm category" : "Continue"}
        </button>
        <SaveDraftButton {...props} />
      </div>
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

function ResultActions(props) {
  const { state, dispatch, policy, onFullDetails } = props;
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
        <SaveDraftButton {...props} />
        <button className="button" onClick={onFullDetails}>
          Review full details
        </button>
      </div>
    </div>
  );
}

function SummaryActions(props) {
  const { state, dispatch, onSubmit, onFullDetails } = props;
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
        <SaveDraftButton {...props} />
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
