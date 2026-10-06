import { useState } from "react";
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
  const existing = categories.find((category) => category.id === editing?.id);
  const nameLocked =
    !!existing &&
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
              limit: 0,
              currency: config.defaultCurrency,
              receiptRequired: true,
              purposeRequired: true,
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
              <p>Warn when this category exceeds</p>
              <strong>
                {formatCurrency(category.limit, category.currency)}
              </strong>
              <small>
                {category.receiptRequired
                  ? "Receipt required"
                  : "Receipt optional"}
                {" ·"}{" "}
                {category.purposeRequired
                  ? "Purpose required"
                  : "Purpose optional"}
              </small>
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
                disabled={saving || nameLocked}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    name: event.target.value,
                  })
                }
              />
            </label>
            {nameLocked && (
              <p className="muted">
                This name is used by existing expenses. You can update its
                policy or add a new category.
              </p>
            )}
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
              Maximum amount
              <input
                type="number"
                step="0.01"
                disabled={saving}
                min="0"
                required
                value={editing.limit}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    limit: Number(event.target.value),
                  })
                }
              />
            </label>
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
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={editing.receiptRequired}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    receiptRequired: event.target.checked,
                  })
                }
              />
              Receipt required
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={editing.purposeRequired}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    purposeRequired: event.target.checked,
                  })
                }
              />
              Business purpose required
            </label>
            <div className="rule-preview" aria-live="polite">
              <h3>Rule preview</h3>
              <p>
                {"Warn when a "}
                {editing.name.trim() || "category"}
                {" expense exceeds"}{" "}
                {Number.isFinite(editing.limit) && editing.limit >= 0
                  ? formatCurrency(editing.limit, editing.currency)
                  : "a valid limit"}{" "}
                {"in "}
                {editing.currency}.
              </p>
              <p>
                {editing.receiptRequired
                  ? "A receipt is required."
                  : "Receipt attachment is optional."}{" "}
                {editing.purposeRequired
                  ? "A business purpose is required."
                  : "Business purpose is optional."}
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
