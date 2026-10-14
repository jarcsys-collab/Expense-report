import { Link, useLocation } from "react-router-dom";
import { LogIn, Receipt } from "lucide-react";
import { config } from "../../config/appConfig";
import { useWorkspace } from "../../hooks/useWorkspace";
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
    case "profile":
      return [["Profile"]];
    case "settings":
      return [["Settings"]];
    default:
      return [["Page not found"]];
  }
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
