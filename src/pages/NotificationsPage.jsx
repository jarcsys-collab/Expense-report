import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BellOff } from "lucide-react";
import { EmptyState } from "../components/common/EmptyState";
import { ErrorState } from "../components/common/ErrorState";
import { TableSkeleton } from "../components/common/TableSkeleton";
import { useWorkspace } from "../hooks/useWorkspace";
import { api } from "../services/api";

export const NOTIFICATIONS_CHANGED = "receiptflow-notifications-changed";
const changed = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));

export function NotificationsPage() {
  const { authenticated, loading: signingIn, notify } = useWorkspace();
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.getMyNotifications();
      setItems(result.notifications);
      setUnread(result.unread);
    } catch (problem) {
      setError(problem.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (authenticated) load();
    else if (!signingIn) setLoading(false);
  }, [authenticated, signingIn, load]);

  async function markRead(item) {
    if (item.readAt) return;
    try {
      await api.markNotificationRead(item.id);
      setItems((current) => current.map((other) => (other.id === item.id ? { ...other, readAt: new Date().toISOString() } : other)));
      setUnread((current) => Math.max(0, current - 1));
      changed();
    } catch (problem) {
      notify(problem.message, true);
    }
  }
  async function markAll() {
    try {
      await api.markAllNotificationsRead();
      setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
      setUnread(0);
      changed();
    } catch (problem) {
      notify(problem.message, true);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Notifications</h1>
          <p>{unread ? `${unread} unread` : "You’re all caught up."}</p>
        </div>
        {unread > 0 && (
          <button className="button" onClick={markAll}>
            Mark all as read
          </button>
        )}
      </header>
      <div className="workspace-surface">
        {loading ? (
          <TableSkeleton />
        ) : error ? (
          <ErrorState message={error} retry={load} />
        ) : !items.length ? (
          <EmptyState title="No notifications" message="Notifications about expense checks you’re responsible for appear here." />
        ) : (
          <ul className="notification-list">
            {items.map((item) => (
              <li key={item.id} className={item.readAt ? "" : "unread"}>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.body}</p>
                  <small>{new Date(item.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</small>
                </div>
                <div className="notification-actions">
                  {item.expenseId ? (
                    <Link className="button" to={`/requests/${item.expenseId}`} onClick={() => markRead(item)}>
                      Open request
                    </Link>
                  ) : !item.test ? (
                    <small className="muted">
                      <BellOff size={13} aria-hidden="true" /> You can’t open this request
                    </small>
                  ) : null}
                  {!item.readAt && (
                    <button className="text-button" onClick={() => markRead(item)}>
                      Mark as read
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
