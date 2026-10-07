import { useEffect, useState } from "react";
import { Plus, SlidersHorizontal } from "lucide-react";
import { EmptyState } from "../components/common/EmptyState";
import { ErrorState } from "../components/common/ErrorState";
import { Modal } from "../components/common/Modal";
import { TableSkeleton } from "../components/common/TableSkeleton";
import { config } from "../config/appConfig";
import { useWorkspace } from "../hooks/useWorkspace";
import { api } from "../services/api";
import { validateCategory } from "../utils/expenseRules";
import { createId, formatCurrency } from "../utils/format";

// Select value for a deliberate "no company policy limit" (saved as null).
const NO_POLICY = "none";

export function CategoriesPage() {
  const {
    categories,
    expenses,
    user,
    run,
    refresh,
    loading,
    error,
    upsertCategory,
  } = useWorkspace();
  const [editing, setEditing] = useState();
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState([]);
  // Company policy categories (labels only; limits are applied by the server).
  const [policyCategories, setPolicyCategories] = useState({});
  useEffect(() => {
    if (user.role !== "FINANCE_ADMIN") return;
    let active = true;
    api.getPolicy().then(
      (policy) => active && setPolicyCategories(policy?.categories ?? {}),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [user.role]);
  const existing = categories.find((category) => category.id === editing?.id);
  // Renaming is allowed: existing expenses keep the name they were filed under.
  const renamingUsed =
    !!existing &&
    existing.name.trim().toLowerCase() !== editing.name.trim().toLowerCase() &&
    expenses.some((expense) => expense.category === existing.name);
  return config.apiBase && user.role !== "FINANCE_ADMIN" ? (
    <EmptyState
      title="Finance admin access required"
      message="Category settings are managed by your finance team."
    />
  ) : (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">WORKSPACE / SETTINGS</div>
          <h1>Categories</h1>
          <p>Keep expenses organized with clear spending policies.</p>
        </div>
        <button
          className="button primary"
          disabled={loading || !!error}
          title={
            loading || error
              ? "Load category policies before adding a category."
              : undefined
          }
          onClick={() => {
            setErrors([]);
            setEditing({
              id: createId(),
              name: "",
              description: "",
              // No limit until Finance enters one.
              limit: null,
              currency: config.defaultCurrency,
              receiptRequired: true,
              purposeRequired: true,
              active: true,
              // Not chosen yet: the admin must pick a policy or "no limit".
              policyKey: undefined,
            });
          }}
        >
          <Plus size={17} />
          Add category
        </button>
      </header>
      {loading ? (
        <TableSkeleton />
      ) : error ? (
        <ErrorState message={error} retry={() => void refresh()} />
      ) : (
        <div className="category-grid">
          {!categories.length && (
            <EmptyState
              title="No categories yet"
              message="Add your organization’s expense categories when the workspace service is connected."
            />
          )}
          {categories.map((category) => (
            <article key={category.id} className="panel category-card">
              <div className="category-icon">
                <SlidersHorizontal size={20} />
              </div>
              <h3>{category.name}</h3>
              {category.description && <p>{category.description}</p>}
              {/* The company policy decides the limits (by job title); the
                  optional category limit is an extra warning on top. */}
              {category.policyKey ? (
                <>
                  <p>Company policy</p>
                  <strong>
                    {policyCategories[category.policyKey]?.label ??
                      category.policyKey}
                  </strong>
                  <small>Limits by job title from the company policy</small>
                </>
              ) : (
                <strong>No company policy limit applies</strong>
              )}
              {category.limit !== null && (
                <small>
                  {"Additional category limit: "}
                  {formatCurrency(category.limit, category.currency)}
                </small>
              )}
              <small>Receipt and purpose required</small>
              {!category.active && (
                <small className="category-inactive">
                  Inactive · employees cannot select it
                </small>
              )}
              <button
                className="button"
                onClick={() => {
                  setErrors([]);
                  setEditing({
                    ...category,
                  });
                }}
              >
                Edit policy
              </button>
            </article>
          ))}
        </div>
      )}
      <details className="policy-explanation panel form-panel">
        <summary>How other expense checks work</summary>
        <p>
          Duplicate review compares matching merchants with the same date,
          amount and currency, or the same receipt number, using available
          expenses and service-reported matches. A separate expense requires an
          override explanation.
        </p>
        <p>
          Date, total and extraction-confidence checks provide review reminders.
          These application checks are not configurable category rules.
          Additional organization checks come from your expense service.
        </p>
      </details>
      {editing && (
        <Modal
          title={editing.name || "New category"}
          onClose={() => {
            if (!saving) {
              setEditing(undefined);
            }
          }}
        >
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (saving) {
                return;
              }
              const validationErrors = validateCategory(editing, categories);
              setErrors(validationErrors);
              if (validationErrors.length) {
                return;
              }
              setSaving(true);
              const saved = await run(
                () =>
                  api.saveCategory({
                    ...editing,
                    name: editing.name.trim(),
                    policyKey: editing.policyKey ?? null,
                  }),
                "Category saved",
              );
              if (saved) {
                upsertCategory(saved);
                setEditing(undefined);
              }
              setSaving(false);
            }}
          >
            {errors.length > 0 && (
              <div role="alert" className="validation-errors">
                {errors.map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </div>
            )}
            <label className="field">
              Category name
              <input
                required
                value={editing.name}
                disabled={saving}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    name: event.target.value,
                  })
                }
              />
            </label>
            {renamingUsed && (
              <p className="muted">
                Existing expenses keep the name “{existing.name}” they were
                filed under.
              </p>
            )}
            <label className="field">
              Description (optional)
              <input
                value={editing.description}
                maxLength={500}
                disabled={saving}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    description: event.target.value,
                  })
                }
              />
            </label>
            {categories.some(
              (category) =>
                category.id !== editing.id &&
                category.name.toLowerCase() ===
                  editing.name.trim().toLowerCase(),
            ) && (
              <p className="danger-text">
                A category with this name already exists.
              </p>
            )}
            <label className="field">
              Additional category limit (optional)
              <input
                type="number"
                step="0.01"
                disabled={saving}
                min="0"
                placeholder="No limit set"
                value={editing.limit ?? ""}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    limit:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  })
                }
              />
            </label>
            <p className="muted">
              Usually empty: the company policy already sets limits by job
              title. Use only for an extra warning on this category.
            </p>
            <label className="field">
              Currency
              <select
                value={editing.currency}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    currency: event.target.value,
                  })
                }
              >
                {["PHP", "USD", "EUR", "GBP", "SGD", "JPY"].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Company policy
              <select
                id="category-policy-key"
                required
                value={
                  editing.policyKey === undefined
                    ? ""
                    : (editing.policyKey ?? NO_POLICY)
                }
                disabled={saving}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    policyKey:
                      event.target.value === ""
                        ? undefined
                        : event.target.value === NO_POLICY
                          ? null
                          : event.target.value,
                  })
                }
              >
                <option value="">Choose a company policy</option>
                <option value={NO_POLICY}>No company policy limit applies</option>
                {Object.entries(policyCategories).map(([key, item]) => (
                  <option key={key} value={key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              Policy limits by job title are applied by ReceiptFlow from the
              company expense policy.
            </p>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    active: event.target.checked,
                  })
                }
              />
              Active (employees can select it)
            </label>
            <div className="rule-preview" aria-live="polite">
              <h3>Rule preview</h3>
              <p>
                {editing.policyKey
                  ? `Company policy limits for ${policyCategories[editing.policyKey]?.label ?? editing.policyKey} apply, by job title.`
                  : editing.policyKey === null
                    ? "No company policy limit applies."
                    : "Choose a company policy."}{" "}
                {editing.limit === null ? null : (
                  <>
                    {"Warn when a "}
                    {editing.name.trim() || "category"}
                    {" expense exceeds"}{" "}
                    {Number.isFinite(editing.limit) && editing.limit >= 0
                      ? formatCurrency(editing.limit, editing.currency)
                      : "a valid limit"}{" "}
                    {"in "}
                    {editing.currency}.
                  </>
                )}
              </p>
              <p>
                {/* ReceiptFlow requires both for every submission. */}
                {"A receipt and a business purpose are required."}{" "}
                {editing.active
                  ? "Employees can select it."
                  : "Inactive: employees cannot select it for new submissions."}
              </p>
              <small>
                Limits apply to the matching currency. The service validates and
                enforces saved policies.
              </small>
            </div>
            <footer>
              <button
                type="button"
                className="button"
                disabled={saving}
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={saving}>
                Save category
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}
