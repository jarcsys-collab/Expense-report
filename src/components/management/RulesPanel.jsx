import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRing, Pencil, Plus, Search, Send, Trash2, TriangleAlert } from "lucide-react";
import { useWorkspace } from "../../hooks/useWorkspace";
import { api } from "../../services/api";
import { formatDate } from "../../utils/format";
import { emptyRule, filterRules, ruleToDraft, ruleWarning } from "../../utils/notificationRules";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { EmptyState } from "../common/EmptyState";
import { ErrorState } from "../common/ErrorState";
import { TableSkeleton } from "../common/TableSkeleton";
import { RuleForm } from "./RuleForm";

const CHANNEL_LABEL = { in_app: "In-app", email: "Email" };

export function RulesPanel() {
  const { notify } = useWorkspace();
  const [catalog, setCatalog] = useState(null);
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [anomalyType, setAnomalyType] = useState("");
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [testing, setTesting] = useState(null);
  const [confirmingTest, setConfirmingTest] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [loadedCatalog, loadedRules] = await Promise.all([api.getManagementCatalog(), api.getNotificationRules()]);
      setCatalog(loadedCatalog);
      setRules(loadedRules);
    } catch (problem) {
      setError(problem.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => filterRules(rules, { search, status, anomalyType }), [rules, search, status, anomalyType]);

  async function runTest(rule, confirm = false) {
    setTesting(rule.id);
    setTestResult(null);
    try {
      const result = await api.testNotificationRule(rule.id, confirm);
      setTestResult({ ruleName: rule.name, ...result });
    } catch (problem) {
      notify(problem.message, true);
    } finally {
      setTesting(null);
    }
  }
  const startTest = (rule) => (catalog.environment.production ? setConfirmingTest(rule) : runTest(rule));

  if (loading) return <TableSkeleton />;
  if (error) return <ErrorState message={error} retry={load} />;

  return (
    <>
      {!catalog.delivery.notificationsEnabled && (
        <div className="management-banner" role="status">
          <TriangleAlert size={18} aria-hidden="true" />
          <p>
            <strong>Notifications are switched off on this server.</strong> You can set up rules now, but nothing is queued or delivered until an administrator sets NOTIFICATIONS_ENABLED.
          </p>
        </div>
      )}
      <div className="management-toolbar">
        <div className="search">
          <Search size={16} aria-hidden="true" />
          <input type="search" aria-label="Search rules" placeholder="Search rules, checks or people" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">All rules</option>
          <option value="on">Enabled</option>
          <option value="off">Disabled</option>
        </select>
        <select aria-label="Filter by anomaly type" value={anomalyType} onChange={(event) => setAnomalyType(event.target.value)}>
          <option value="">All anomaly types</option>
          {catalog.anomalyTypes.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
        <button className="button primary" onClick={() => setEditing(emptyRule())}>
          <Plus size={16} aria-hidden="true" />
          New rule
        </button>
      </div>
      {testResult && (
        <div className={`management-banner ${testResult.sent ? "good" : ""}`} role="status">
          <Send size={18} aria-hidden="true" />
          <p>
            <strong>TEST of “{testResult.ruleName}”.</strong> {testResult.message}
            {testResult.unresolved > 0 && ` ${testResult.unresolved} recipient(s) could not be reached.`}
          </p>
        </div>
      )}
      {!rules.length ? (
        <EmptyState title="No notification rules yet" message="Nobody is told about anomalies until you add a rule. Findings still appear in Expense Issues.">
          <button className="button primary" onClick={() => setEditing(emptyRule())}>
            <BellRing size={16} aria-hidden="true" />
            Add your first rule
          </button>
        </EmptyState>
      ) : !visible.length ? (
        <EmptyState title="No rules match" message="Try another search or adjust the filters." />
      ) : (
        <div className="management-table-wrap">
          <table className="management-table">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Status</th>
                <th>Anomaly types</th>
                <th>Recipients</th>
                <th>Channel</th>
                <th>Last modified</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((rule) => {
                const warning = ruleWarning(rule);
                return (
                  <tr key={rule.id}>
                    <td data-label="Rule">
                      <strong>{rule.name}</strong>
                      {rule.description && <small>{rule.description}</small>}
                      {warning && (
                        <small className="rule-warning">
                          <TriangleAlert size={13} aria-hidden="true" />
                          {warning}
                        </small>
                      )}
                    </td>
                    <td data-label="Status">
                      <span className={`badge ${rule.enabled ? "success" : "pending"}`}>
                        <i />
                        {rule.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                    <td data-label="Anomaly types">
                      {rule.anomalies.slice(0, 2).map((anomaly) => (
                        <small key={anomaly.id}>{anomaly.name}</small>
                      ))}
                      {rule.anomalies.length > 2 && <small>and {rule.anomalies.length - 2} more</small>}
                    </td>
                    <td data-label="Recipients">
                      {rule.recipients.length ? (
                        rule.recipients.slice(0, 2).map((recipient) => <small key={`${recipient.type}-${recipient.userId ?? ""}`}>{recipient.name}</small>)
                      ) : (
                        <small>None</small>
                      )}
                      {rule.recipients.length > 2 && <small>and {rule.recipients.length - 2} more</small>}
                    </td>
                    <td data-label="Channel">{CHANNEL_LABEL[rule.channel] ?? rule.channel}</td>
                    <td data-label="Last modified">
                      <small>{rule.updatedBy?.name}</small>
                      <small>{rule.updatedAt ? formatDate(rule.updatedAt) : ""}</small>
                    </td>
                    <td className="management-actions">
                      <button className="icon-button" aria-label={`Edit ${rule.name}`} title="Edit" onClick={() => setEditing(ruleToDraft(rule))}>
                        <Pencil size={16} aria-hidden="true" />
                      </button>
                      <button className="icon-button" aria-label={`Send a test of ${rule.name}`} title="Send a test" disabled={testing === rule.id} onClick={() => startTest(rule)}>
                        <Send size={16} aria-hidden="true" />
                      </button>
                      <button className="icon-button" aria-label={`Delete ${rule.name}`} title="Delete" onClick={() => setDeleting(rule)}>
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <RuleForm
          draft={editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setRules((current) => (current.some((rule) => rule.id === saved.id) ? current.map((rule) => (rule.id === saved.id ? saved : rule)) : [...current, saved].sort((a, b) => a.name.localeCompare(b.name))));
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete rule"
          danger
          message={`Delete “${deleting.name}”? Nobody will be notified by it any more. Its history stays in the delivery and audit records.`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteNotificationRule(deleting.id);
              setRules((current) => current.filter((rule) => rule.id !== deleting.id));
              notify("Rule deleted.");
            } catch (problem) {
              notify(problem.message, true);
            }
            setDeleting(null);
          }}
        />
      )}
      {confirmingTest && (
        <ConfirmDialog
          title="Send real test"
          message={`This sends a notification labelled TEST to everyone on “${confirmingTest.name}”. It uses made-up details and affects no expense.`}
          onClose={() => setConfirmingTest(null)}
          onConfirm={async () => {
            await runTest(confirmingTest, true);
            setConfirmingTest(null);
          }}
        />
      )}
    </>
  );
}
