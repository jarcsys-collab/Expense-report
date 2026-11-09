import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Bell, LogIn, Receipt } from "lucide-react";
import { config } from "../../config/appConfig";
import { useWorkspace } from "../../hooks/useWorkspace";
import { NOTIFICATIONS_CHANGED } from "../../pages/NotificationsPage";
import { api } from "../../services/api";
import { initials } from "../../utils/format";

// Where the current screen sits, as [label, link] pairs (no link: current page).
function breadcrumbsFor(pathname) {
  const [section, detail] = pathname.split("/").filter(Boolean);
  switch (section) {
    case "upload":
      return detail
        ? [["New Expense", "/upload"], ["Several receipts"]]
        : [["New Expense"]];
    case "requests":
      return detail ? [["My Requests", "/requests"], ["Request details"]] : [["My Requests"]];
    case "approvals":
      return detail ? [["Approvals", "/approvals"], ["Approval details"]] : [["Approvals"]];
    case "review":
      return [["My Requests", "/requests"], ["Review expense"]];
    case "violations":
      return [["Expense Issues"]];
    case "categories":
      return [["Categories"]];
    case "management":
      return [["Management"]];
    case "notifications":
      return [["Notifications"]];
    case "profile":
      return [["Profile"]];
    case "settings":
      return [["Settings"]];
    default:
      return [["Page not found"]];
  }
}

const UNREAD_REFRESH_MS = 60_000;

// The bell with the unread count. A failed check just keeps the last number.
function NotificationBell() {
  const { pathname } = useLocation();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let active = true;
    const check = () => {
      if (document.visibilityState === "hidden") return;
      api.getUnreadNotificationCount().then(
        (count) => active && setUnread(count),
        () => {},
      );
    };
    check();
    const timer = setInterval(check, UNREAD_REFRESH_MS);
    window.addEventListener(NOTIFICATIONS_CHANGED, check);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED, check);
    };
  }, [pathname]);
  return (
    <Link className="topbar-bell" to="/notifications" aria-label={unread ? `Notifications: ${unread} unread` : "Notifications"} title="Notifications">
      <Bell size={20} aria-hidden="true" />
      {unread > 0 && <b aria-hidden="true">{unread > 99 ? "99+" : unread}</b>}
    </Link>
  );
}

export function TopBar() {
  const { user, authenticated, loading } = useWorkspace();
  const { pathname } = useLocation();
  const crumbs = breadcrumbsFor(pathname);
  return (
    <header className="topbar">
      {/* Phones have no sidebar: the brand sits here instead of breadcrumbs. */}
      <Link className="topbar-brand" to="/upload" aria-label={`${config.appName} home`}>
        <span className="brand-icon" aria-hidden="true">
          <Receipt size={18} />
        </span>
        <strong>{config.appName}</strong>
      </Link>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <ol>
          <li>{config.accountName}</li>
          {crumbs.map(([label, to], index) => (
            <li key={label} aria-current={index === crumbs.length - 1 ? "page" : undefined}>
              {to ? <Link to={to}>{label}</Link> : label}
            </li>
          ))}
        </ol>
      </nav>
      <div className="topbar-actions">
        {authenticated && <NotificationBell />}
        {config.apiBase && !authenticated && !loading ? (
          <Link className="button primary topbar-sign-in" to="/profile">
            <LogIn size={16} aria-hidden="true" />
            Sign in
          </Link>
        ) : (
          <Link className="topbar-user" to="/profile" aria-label={`Profile: ${user.name}`}>
            <span className="topbar-user-text">
              <strong>{user.name}</strong>
              {authenticated && <small>{user.role.replaceAll("_", " ").toLowerCase()}</small>}
            </span>
            <span className="avatar">{initials(user.name)}</span>
          </Link>
        )}
      </div>
    </header>
  );
}
