import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "../../hooks/useWorkspace";
import { api } from "../../services/api";
import { auditActionLabel, auditChanges, DELIVERY_STATUS, deliveryErrorText } from "../../utils/notificationRules";
import { EmptyState } from "../common/EmptyState";
import { ErrorState } from "../common/ErrorState";
import { Spinner } from "../common/Spinner";
import { TableSkeleton } from "../common/TableSkeleton";

const PAGE = 50;
const dateTime = (value) => (value ? new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "");

// A list that loads a page at a time, with its loading and error states.
function usePagedList(fetchPage, listKey, deps) {
  const { notify } = useWorkspace();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchPage(0);
      setItems(result[listKey]);
      setTotal(result.total);
    } catch (problem) {
      setError(problem.message);
    } finally {
      setLoading(false);
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
  }, [load]);
  async function loadMore() {
    setMore(true);
    try {
      const result = await fetchPage(items.length);
      setItems((current) => [...current, ...result[listKey]]);
      setTotal(result.total);
    } catch (problem) {
      notify(problem.message, true);
    } finally {
      setMore(false);
    }
  }
  return { items, total, loading, more, error, load, loadMore };
}

function LoadMore({ list }) {
  if (list.items.length >= list.total) return null;
  return (
    <button className="button management-more" disabled={list.more} onClick={list.loadMore}>
      {list.more && <Spinner />}
      Show more ({list.total - list.items.length} left)
    </button>
  );
}

export function DeliveryPanel() {
  const [test, setTest] = useState("false");
  const [status, setStatus] = useState("");
  const list = usePagedList((skip) => api.getNotificationEvents({ test, status, limit: PAGE, skip }), "events", [test, status]);
  return (
    <>
      <div className="management-toolbar">
        <div className="segmented" role="group" aria-label="Kind of notification">
          <button className={test === "false" ? "active" : ""} aria-pressed={test === "false"} onClick={() => setTest("false")}>
            Real notifications
          </button>
          <button className={test === "true" ? "active" : ""} aria-pressed={test === "true"} onClick={() => setTest("true")}>
            Tests
          </button>
        </div>
        <select aria-label="Filter by delivery status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(DELIVERY_STATUS).map(([key, info]) => (
            <option key={key} value={key}>
              {info.label}
            </option>
          ))}
        </select>
      </div>
      {list.loading ? (
        <TableSkeleton />
      ) : list.error ? (
        <ErrorState message={list.error} retry={list.load} />
      ) : !list.items.length ? (
        <EmptyState
          title={test === "true" ? "No tests yet" : "No notifications yet"}
          message={test === "true" ? "Tests you send from a rule are listed here, apart from real notifications." : "Notifications appear here once a rule matches an anomaly."}
        />
      ) : (
        <>
          <div className="management-table-wrap">
            <table className="management-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Status</th>
                  <th>Finding</th>
                  <th>Request</th>
                  <th>Recipient</th>
                  <th>Rule</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((event) => {
                  const info = DELIVERY_STATUS[event.status] ?? DELIVERY_STATUS.queued;
                  const mock = event.provider === "mock";
                  return (
                    <tr key={event.id}>
                      <td data-label="When">
                        <small>{dateTime(event.createdAt)}</small>
                      </td>
                      <td data-label="Status">
                        <span className={`badge ${info.tone}`}>
                          <i />
                          {mock ? "Recorded (mock)" : info.label}
                        </span>
                        {event.lastErrorCode && <small>{deliveryErrorText(event.lastErrorCode)}</small>}
                        {event.attempts > 1 && <small>{event.attempts} attempts</small>}
                      </td>
                      <td data-label="Finding">
                        <small>{event.anomalyName}</small>
                        <small>{event.severity}</small>
                      </td>
                      <td data-label="Request">{event.requestHidden ? <small>Another employee’s request</small> : event.requestNumber}</td>
                      <td data-label="Recipient">{event.recipientName}</td>
                      <td data-label="Rule">
                        <small>{event.ruleName}</small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <LoadMore list={list} />
        </>
      )}
    </>
  );
}

export function AuditPanel() {
  const list = usePagedList((skip) => api.getManagementAudit({ limit: PAGE, skip }), "entries", []);
  if (list.loading) return <TableSkeleton />;
  if (list.error) return <ErrorState message={list.error} retry={list.load} />;
  if (!list.items.length) return <EmptyState title="No changes yet" message="Every change to a notification rule is recorded here." />;
  return (
    <>
      <div className="management-table-wrap">
        <table className="management-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Rule</th>
              <th>Changed</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((entry) => {
              const changes = auditChanges(entry);
              return (
                <tr key={entry.id}>
                  <td data-label="When">
                    <small>{dateTime(entry.at)}</small>
                  </td>
                  <td data-label="Who">{entry.actor?.name}</td>
                  <td data-label="What">{auditActionLabel(entry.action)}</td>
                  <td data-label="Rule">{entry.targetName}</td>
                  <td data-label="Changed">
                    <small>{changes.length ? changes.join(", ") : "—"}</small>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <LoadMore list={list} />
    </>
  );
}
