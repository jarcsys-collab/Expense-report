import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Check, Plus, Save, Send, Trash2 } from "lucide-react";
import { ErrorState } from "../components/common/ErrorState";
import { Spinner } from "../components/common/Spinner";
import { TableSkeleton } from "../components/common/TableSkeleton";
import { ExpenseCheck } from "../components/expenses/ExpenseCheck";
import { ImageEditModal } from "../components/receipts/ImageEditModal";
import { DateReviewNote } from "../components/receipts/DateReviewNote";
import { ReceiptViewer } from "../components/receipts/ReceiptViewer";
import { config } from "../config/appConfig";
import { useUploadQueue } from "../hooks/useUploadQueue";
import { useWorkspace } from "../hooks/useWorkspace";
import { api } from "../services/api";
import {
  createBlankExpense,
  fieldForMessage,
  findDuplicate,
  focusExpenseField,
  runPolicyChecks,
  validateExpense,
} from "../utils/expenseRules";
import { createId, formatCurrency } from "../utils/format";
import { validateReceiptFile } from "../utils/receiptFile";

export function ReviewPage() {
  const { id } = useParams();
  const location = useLocation();
  const { complete: completeQueueItem } = useUploadQueue();
  const navigate = useNavigate();
  const { expenses, categories, user, run, upsert } = useWorkspace();
  const [expense, setExpense] = useState(
    location.state?.expense ||
      (id === "new" ? createBlankExpense(user) : undefined),
  );
  const [savedId, setSavedId] = useState(id !== "new" ? id : undefined);
  const [submitted, setSubmitted] = useState();
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const attachInputRef = useRef(null);
  const [validationErrors, setValidationErrors] = useState([]);
  const [fileIndex, setFileIndex] = useState(0);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [imageEditorOpen, setImageEditorOpen] = useState(false);
  useEffect(() => {
    if (id !== "new") {
      api
        .getExpense(id)
        .then(setExpense)
        .catch((error) => setLoadError(error.message));
    }
  }, [id]);
  useEffect(() => {
    if (id === "new" && user.id) {
      setExpense((current) =>
        current && !current.employeeId
          ? {
              ...current,
              employeeId: user.id,
              employeeName: user.name,
              department: current.department || user.department,
              position: current.position || user.position || "",
            }
          : current,
      );
    }
  }, [id, user.id, user.name, user.department, user.position]);
  if (loadError) {
    return (
      <ErrorState message={loadError} retry={() => window.location.reload()} />
    );
  }
  if (!expense) {
    return id === "new" ? (
      <div className="empty">
        <h2>No receipt selected</h2>
        <button className="button primary" onClick={() => navigate("/upload")}>
          Upload a receipt
        </button>
      </div>
    ) : (
      <TableSkeleton />
    );
  }
  if (submitted) {
    return (
      <section className="submission-success panel" role="status">
        <Check size={38} />
        <h1>Expense submitted</h1>
        <p>
          {"Your "}
          {formatCurrency(submitted.amount, submitted.currency)}
          {" expense from"} {submitted.merchant}
          {" was sent for approval."}
        </p>
        <div className="capture-options">
          <button
            className="button primary"
            onClick={() => navigate(`/requests/${submitted.id}`)}
          >
            View Expense
          </button>
          <button className="button" onClick={() => navigate("/upload")}>
            Scan Another Receipt
          </button>
        </div>
      </section>
    );
  }
  if (!(
    ["Draft", "Needs Review", "Needs Correction", "Rejected"].includes(
      expense.status,
    ) &&
    (expense.employeeId === user.id || user.role === "FINANCE_ADMIN")
  )) {
    return (
      <div className="empty">
        <h2>This expense is read-only</h2>
        <p>
          Only drafts and requests needing review or correction can be edited.
        </p>
        <button
          className="button"
          onClick={() => navigate(`/requests/${expense.id}`)}
        >
          View request
        </button>
      </div>
    );
  }
  const setField = (field, value) =>
    setExpense((current) => ({
      ...current,
      [field]: value,
    }));
  const failedChecks = runPolicyChecks(expense, expenses, categories).filter(
    (item) => !item.passed,
  );
  const duplicate = findDuplicate(expense, expenses);
  const dateConfirmed =
    Boolean(expense.dateReview?.ambiguous) &&
    Boolean(expense.expenseDate) &&
    expense.dateReview.confirmedDate === expense.expenseDate;
  // The employee picks or confirms the receipt date; the confirmation is tied to that date.
  const confirmDate = (date) =>
    setExpense((current) => ({
      ...current,
      expenseDate: date,
      dateReview: { ...current.dateReview, confirmedDate: date },
    }));
  const renderField = (labelText, field, type = "text", required = false) => {
    return (
      <label
        key={field}
        className={`field ${expense.ocrConfidence[field] !== undefined && expense.ocrConfidence[field] < config.confidence ? "low-confidence" : ""}`}
      >
        <span>
          {labelText}
          {required && " *"}
          {expense.ocrConfidence[field] !== undefined &&
            expense.ocrConfidence[field] >= config.confidence &&
            expense.originalOCR?.[field] === expense[field] && (
              <small className="detected-label">Auto-detected</small>
            )}
          {expense.ocrConfidence[field] !== undefined &&
            expense.ocrConfidence[field] < config.confidence &&
            !(field === "expenseDate" && dateConfirmed) && (
              <small>● Needs review</small>
            )}
        </span>
        <input
          aria-invalid={
            validationErrors.some(
              (message) => fieldForMessage(message) === field,
            ) || undefined
          }
          aria-describedby={
            validationErrors.some(
              (message) => fieldForMessage(message) === field,
            )
              ? `error-${field}`
              : undefined
          }
          id={`expense-${field}`}
          type={type}
          disabled={saving}
          required={required}
          step={type === "number" ? ".01" : undefined}
          min={type === "number" ? "0" : undefined}
          value={String(expense[field] ?? "")}
          onChange={(event) =>
            setField(
              field,
              type === "number"
                ? Number(event.target.value)
                : event.target.value,
            )
          }
        />
        {field === "expenseDate" && (
          <DateReviewNote
            review={expense.dateReview}
            value={expense.expenseDate}
            disabled={saving}
            onConfirm={confirmDate}
          />
        )}
      </label>
    );
  };
  async function save(submit) {
    if (savingRef.current) {
      return;
    }
    const errors = submit ? validateExpense(expense, categories) : [];
    if (submit && duplicate && !expense.duplicateOverrideReason) {
      errors.push(
        "Review the possible duplicate and provide an override reason before submitting.",
      );
    }
    if (errors.length) {
      setValidationErrors(errors);
      return;
    }
    setValidationErrors([]);
    savingRef.current = true;
    setSaving(true);
    const saved = await run(
      async () => {
        const payload = {
          ...expense,
          policyViolations: [
            ...expense.policyViolations.filter(
              (violation) => !violation.id.startsWith("policy-"),
            ),
            ...failedChecks.map((check) => ({
              id: `policy-${check.ruleId}`,
              type: check.name,
              severity: check.severity,
              message: check.message,
              status: "Open",
              createdAt: new Date().toISOString(),
            })),
          ],
        };
        let result = savedId
          ? await api.updateExpense(savedId, payload)
          : await api.createExpense(payload);
        setSavedId(result.id);
        if (location.state?.queueId) {
          completeQueueItem(location.state.queueId);
        }
        setExpense(result);
        upsert(result);
        if (submit) {
          result = await api.submitExpense(result.id, result);
          upsert(result);
        }
        return result;
      },
      submit ? "Expense submitted for approval" : "Draft saved",
    );
    setSaving(false);
    savingRef.current = false;
    if (saved) {
      if (submit) {
        setSubmitted(saved);
      } else {
        navigate(`/requests/${saved.id}`);
      }
    }
  }
  return (
    <>
      <header className="page-header">
        <div>
          <button className="back-link" onClick={() => navigate("/upload")}>
            <ArrowLeft size={15} />
            Back to uploads
          </button>
          <h1>
            {expense.ocrStatus === "not_scanned"
              ? "Expense details"
              : "Review receipt"}
          </h1>
          <p>Check the extracted details before submitting your expense.</p>
        </div>
        <span className="ocr-label">
          {expense.ocrStatus === "not_scanned"
            ? "MANUAL ENTRY"
            : "OCR EXTRACTION"}{" "}
          · REVIEW REQUIRED
        </span>
      </header>
      <div className="workflow-strip" aria-label="Receipt workflow">
        <span>1. Capture</span>
        <strong>2. Verify & check</strong>
        <span>3. Submit</span>
      </div>
      <div className="review-health-bar">
        <span>
          {validateExpense(expense, categories).length
            ? `${validateExpense(expense, categories).length} required details need attention`
            : "Required details complete"}
        </span>
        <button
          className="text-button"
          onClick={() => {
            return document.getElementById("expense-check")?.scrollIntoView({
              behavior: "smooth",
            });
          }}
        >
          Review Expense Check ↓
        </button>
      </div>
      <div className="review-layout">
        <aside className="review-preview" id="expense-receipt" tabIndex={-1}>
          <details open>
            <summary>
              {"Receipt preview · "}
              {expense.receiptFiles.length}{" "}
              {expense.receiptFiles.length === 1 ? "file" : "sections"}
            </summary>
            {expense.receiptFiles.length > 1 && (
              <select
                aria-label="Receipt section"
                value={fileIndex}
                onChange={(event) => setFileIndex(Number(event.target.value))}
              >
                {expense.receiptFiles.map((file, index) => (
                  <option key={file.id} value={index}>
                    {"Section "}
                    {index + 1}
                    {" · "}
                    {file.name}
                  </option>
                ))}
              </select>
            )}
            {expense.receiptFiles[fileIndex] ? (
              <>
                <ReceiptViewer file={expense.receiptFiles[fileIndex]} />
                {expense.receiptFiles[fileIndex].mimeType.startsWith(
                  "image/",
                ) && (
                  <button
                    className="button image-edit-button"
                    type="button"
                    onClick={() => setImageEditorOpen(true)}
                  >
                    Crop / rotate image
                  </button>
                )}
              </>
            ) : (
              <div className="empty">No receipt attached</div>
            )}
          </details>
          <div>
            <button
              type="button"
              className="button image-edit-button"
              disabled={saving}
              onClick={() => {
                return attachInputRef.current?.click();
              }}
            >
              Attach receipt
            </button>
            <input
              ref={attachInputRef}
              type="file"
              hidden
              accept=".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf"
              disabled={saving}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!!file) {
                  setSaving(true);
                  try {
                    const savedFile = await run(async () => {
                      validateReceiptFile(file);
                      return api.saveEditedFile(
                        file,
                        expense.receiptFiles.length + 1,
                      );
                    });
                    if (savedFile) {
                      setExpense((current) => ({
                        ...current,
                        receiptFiles: [...current.receiptFiles, savedFile],
                      }));
                      setFileIndex(expense.receiptFiles.length);
                    }
                  } finally {
                    setSaving(false);
                  }
                }
              }}
            />
          </div>
          <div className="review-note">
            <Check size={17} />
            <p>Check your receipt and expense details before submitting.</p>
          </div>
          {expense.extractionNotes?.length ? (
            <div className="panel form-panel">
              <h3>Check before submitting</h3>
              {expense.extractionNotes.map((note) => (
                <p key={note} className="muted">
                  {note}
                </p>
              ))}
            </div>
          ) : null}
          {expense.ocrText && (
            <details className="panel form-panel">
              <summary>Recognized receipt text</summary>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  maxHeight: 300,
                  overflow: "auto",
                  fontSize: 12,
                }}
              >
                {expense.ocrText}
              </pre>
            </details>
          )}
        </aside>
        <form
          className="review-form"
          onSubmit={(event) => {
            event.preventDefault();
            save(true);
          }}
        >
          <div className="panel form-panel" id="expense-details" tabIndex={-1}>
            <div className="form-title">
              <h3>Expense details</h3>
              <span className="muted">* Required</span>
            </div>
            {validationErrors.length > 0 && (
              <div className="validation-errors" role="alert">
                {validationErrors.map((message) => (
                  <p key={message} id={`error-${fieldForMessage(message)}`}>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() =>
                        focusExpenseField(fieldForMessage(message))
                      }
                    >
                      {message}
                    </button>
                  </p>
                ))}
              </div>
            )}
            <div className="form-grid">
              {renderField("Employee name", "employeeName", "text", true)}
              {renderField("Position / role", "position", "text", true)}
              {renderField("Department", "department", "text", true)}
              {renderField("Total amount", "amount", "number", true)}
              {renderField("Merchant", "merchant", "text", true)}
              {renderField("Receipt date", "expenseDate", "date", true)}
              <label className="field">
                <span>
                  Currency *
                  {expense.ocrConfidence.currency !== undefined &&
                    expense.ocrConfidence.currency < config.confidence && (
                      <small>● Needs review</small>
                    )}
                </span>
                <select
                  id="expense-currency"
                  value={expense.currency}
                  disabled={saving}
                  onChange={(event) => setField("currency", event.target.value)}
                >
                  {[
                    ...new Set([
                      expense.currency,
                      "PHP",
                      "USD",
                      "EUR",
                      "GBP",
                      "SGD",
                      "JPY",
                      "AUD",
                      "CAD",
                    ]),
                  ]
                    .filter(Boolean)
                    .map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>
                  Category *
                  {expense.ocrConfidence.category !== undefined &&
                    expense.ocrConfidence.category < config.confidence && (
                      <small>● Needs review</small>
                    )}
                </span>
                <select
                  required
                  id="expense-category"
                  value={expense.category}
                  disabled={saving}
                  onChange={(event) => setField("category", event.target.value)}
                >
                  <option value="">Select category</option>
                  {expense.category &&
                    !categories.some(
                      (category) => category.name === expense.category,
                    ) && (
                      <option value={expense.category}>
                        {expense.category}
                        {" (check policy)"}
                      </option>
                    )}
                  {categories.map((category) => (
                    <option key={category.id}>{category.name}</option>
                  ))}
                </select>
              </label>
              {renderField(
                "Business purpose",
                "purpose",
                "text",
                !!categories.find(
                  (category) => category.name === expense.category,
                )?.purposeRequired,
              )}
              {renderField("Location", "location", "text", true)}
              <label className="field">
                <span>Status · set by workflow</span>
                <input value={expense.status} readOnly />
              </label>
              <div className="field">
                <span>Receipt *</span>
                <span>
                  {expense.receiptFiles.length
                    ? expense.receiptFiles.map((file) => file.name).join(", ")
                    : "Attach a receipt before submitting"}
                </span>
              </div>
              {renderField("Payment method", "paymentMethod")}
              {renderField("Receipt number", "receiptNumber")}
              {renderField("Subtotal", "subtotal", "number")}
              {renderField("Tax", "tax", "number")}
            </div>
            <details className="additional-fields">
              <summary>Additional receipt & accounting details</summary>
              <div className="form-grid">
                {renderField("Merchant address", "merchantAddress")}
                {renderField("Time", "expenseTime", "time")}
                {renderField("Service charge", "serviceCharge", "number")}
                {renderField("Tip / gratuity", "tip", "number")}
                {renderField("Discount", "discount", "number")}
                {renderField("Card last four", "cardLastFour")}
                {renderField("Cost center", "costCenter")}
                {renderField("Project", "project")}
                {renderField("Notes", "notes")}
              </div>
            </details>
          </div>
          <div className="panel form-panel">
            <div className="form-title">
              <h3>Line items</h3>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setField("lineItems", [
                    ...expense.lineItems,
                    {
                      id: createId(),
                      description: "",
                      quantity: 1,
                      unitPrice: 0,
                      total: 0,
                    },
                  ])
                }
              >
                <Plus size={15} />
                Add item
              </button>
            </div>
            <div className="line-items" id="expense-lineItems" tabIndex={-1}>
              {expense.lineItems.map((lineItem, index) => (
                <div
                  key={lineItem.id}
                  className={`line-item ${[lineItem.confidence, ...Object.values(lineItem.fieldConfidence || {})].some((item) => item !== undefined && item < config.confidence) ? "low-confidence" : ""}`}
                >
                  <label>
                    Description
                    {[
                      lineItem.confidence,
                      ...Object.values(lineItem.fieldConfidence || {}),
                    ].some(
                      (item) => item !== undefined && item < config.confidence,
                    ) && (
                      <small className="line-confidence">● Needs review</small>
                    )}
                    <input
                      aria-label={`Item ${index + 1} description`}
                      disabled={saving}
                      value={lineItem.description}
                      onChange={(event) =>
                        setField(
                          "lineItems",
                          expense.lineItems.map((currentItem) =>
                            currentItem.id === lineItem.id
                              ? {
                                  ...currentItem,
                                  description: event.target.value,
                                }
                              : currentItem,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Qty
                    <input
                      type="number"
                      min="0.01"
                      step=".01"
                      value={lineItem.quantity}
                      disabled={saving}
                      onChange={(event) =>
                        setField(
                          "lineItems",
                          expense.lineItems.map((currentItem) =>
                            currentItem.id === lineItem.id
                              ? {
                                  ...currentItem,
                                  quantity: Number(event.target.value),
                                  total: Number(
                                    (
                                      Number(event.target.value) *
                                      currentItem.unitPrice
                                    ).toFixed(2),
                                  ),
                                }
                              : currentItem,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Unit price
                    <input
                      type="number"
                      min="0"
                      step=".01"
                      value={lineItem.unitPrice}
                      disabled={saving}
                      onChange={(event) =>
                        setField(
                          "lineItems",
                          expense.lineItems.map((currentItem) =>
                            currentItem.id === lineItem.id
                              ? {
                                  ...currentItem,
                                  unitPrice: Number(event.target.value),
                                  total: Number(
                                    (
                                      Number(event.target.value) *
                                      currentItem.quantity
                                    ).toFixed(2),
                                  ),
                                }
                              : currentItem,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Total price
                    <input
                      aria-label={`Item ${index + 1} total price`}
                      disabled={saving}
                      type="number"
                      min="0"
                      step=".01"
                      value={lineItem.total}
                      onChange={(event) =>
                        setField(
                          "lineItems",
                          expense.lineItems.map((currentItem) =>
                            currentItem.id === lineItem.id
                              ? {
                                  ...currentItem,
                                  total: Number(event.target.value),
                                }
                              : currentItem,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove item ${index + 1}`}
                    onClick={() =>
                      setField(
                        "lineItems",
                        expense.lineItems.filter(
                          (currentItem) => currentItem.id !== lineItem.id,
                        ),
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
            {expense.lineItems.length > 0 &&
              Math.abs(
                expense.lineItems.reduce((sum, item) => sum + item.total, 0) -
                  expense.subtotal,
              ) > 0.02 && (
                <p className="warning-note">
                  Line items do not match the subtotal. Check the receipt.
                </p>
              )}
          </div>
          <ExpenseCheck
            expense={expense}
            all={expenses}
            categories={categories}
            editable
          />
          {duplicate && (
            <section
              className="panel form-panel"
              id="expense-duplicate"
              tabIndex={-1}
            >
              <h3>Compare possible duplicate</h3>
              <div className="duplicate-comparison">
                <div>
                  <small>Current expense</small>
                  <h4>{expense.merchant}</h4>
                  <strong>
                    {formatCurrency(expense.amount, expense.currency)}
                  </strong>
                  <p>{expense.expenseDate}</p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      return document
                        .getElementById("expense-receipt")
                        ?.scrollIntoView({
                          behavior: "smooth",
                        });
                    }}
                  >
                    View current receipt
                  </button>
                </div>
                <div>
                  <small>
                    {"Possible match · "}
                    {duplicate.requestNumber}
                  </small>
                  <h4>{duplicate.merchant}</h4>
                  <strong>
                    {formatCurrency(duplicate.amount, duplicate.currency)}
                  </strong>
                  <p>{duplicate.expenseDate}</p>
                  <a
                    className="text-button"
                    href={`#/requests/${duplicate.id}`}
                    target="_blank"
                    rel="noopener"
                  >
                    View original expense & receipt
                  </a>
                </div>
              </div>
              <p className="muted">
                Compare merchant, date, amount and receipt number before
                continuing. A matching record requires an explanation to submit
                separately.
              </p>
              <button
                className="button"
                type="button"
                onClick={() => setOverrideOpen(!overrideOpen)}
                aria-expanded={overrideOpen}
              >
                Not a duplicate / explain
              </button>
              {overrideOpen && (
                <div className="duplicate-reason">
                  <label className="field">
                    Override reason
                    <textarea
                      value={overrideReason}
                      onChange={(event) =>
                        setOverrideReason(event.target.value)
                      }
                      placeholder="Why is this a separate expense?"
                    />
                  </label>
                  <button
                    type="button"
                    className="button"
                    disabled={overrideReason.trim().length < 3}
                    onClick={() => {
                      setField(
                        "duplicateOverrideReason",
                        overrideReason.trim(),
                      );
                      setOverrideOpen(false);
                    }}
                  >
                    Record override
                  </button>
                </div>
              )}
            </section>
          )}
          {expense.duplicateOverrideReason && (
            <p className="muted">
              {"Duplicate override recorded: "}
              {expense.duplicateOverrideReason}
            </p>
          )}
          {expense.transactionMatch && (
            <div className="panel form-panel">
              <h3>Potential transaction match</h3>
              <p>
                {expense.transactionMatch.merchant}
                {" ·"}{" "}
                {formatCurrency(
                  expense.transactionMatch.amount,
                  expense.currency,
                )}
                {" ·"} {expense.transactionMatch.date}
              </p>
              <small className="muted">
                Confidence:{" "}
                {Number.isFinite(expense.transactionMatch.confidence)
                  ? `${Math.round(expense.transactionMatch.confidence * 100)}%`
                  : "Not provided"}{" "}
                {"· "}
                {expense.transactionMatch.status}
              </small>
              {expense.transactionMatch.status === "Suggested" && (
                <div className="capture-options">
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      setField("transactionMatch", {
                        ...expense.transactionMatch,
                        status: "Matched",
                      })
                    }
                  >
                    Match
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setField("transactionMatch", {
                        ...expense.transactionMatch,
                        status: "Dismissed",
                      })
                    }
                  >
                    Not this transaction
                  </button>
                </div>
              )}
              <small className="muted">
                Your choice is saved with this expense.
              </small>
            </div>
          )}
          <footer className="review-footer">
            <button
              className="button"
              type="button"
              disabled={saving}
              onClick={() => void save(false)}
            >
              <Save size={16} />
              Save Draft
            </button>
            <button className="button primary" disabled={saving}>
              {saving ? <Spinner /> : <Send size={16} />}Submit Expense
            </button>
          </footer>
        </form>
      </div>
      {imageEditorOpen && (
        <ImageEditModal
          file={expense.receiptFiles[fileIndex]}
          onClose={() => setImageEditorOpen(false)}
          onSave={(event) => {
            setField("receiptFiles", [...expense.receiptFiles, event]);
            setFileIndex(expense.receiptFiles.length);
          }}
        />
      )}
    </>
  );
}
