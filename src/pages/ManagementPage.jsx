import { Link, NavLink, Navigate, useParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { EmptyState } from "../components/common/EmptyState";
import { AnalyticsPanel } from "../components/management/AnalyticsPanel";
import { AuditPanel, DeliveryPanel } from "../components/management/HistoryPanels";
import { RulesPanel } from "../components/management/RulesPanel";
import { useWorkspace } from "../hooks/useWorkspace";
import { visibleManagementSections } from "../utils/notificationRules";

const PANELS = { notifications: RulesPanel, delivery: DeliveryPanel, ocr: AnalyticsPanel, audit: AuditPanel };

// Everything here is loaded from routes the server restricts (middleware/managementAccess.js).
// Hiding a page is only a courtesy: it is not what protects the data.
export function ManagementPage() {
  const { user, authenticated, loading } = useWorkspace();
  const { section = "notifications" } = useParams();
  if (!loading && (!authenticated || !user.managementAccess)) {
    return <EmptyState title="Sign-in required" message="Management is available to employees signed in with their Microsoft account." />;
  }
  const sections = visibleManagementSections(user);
  const current = sections.find((item) => item.id === section);
  if (!current && !loading) return <Navigate to="/management" replace />;
  const Panel = current ? PANELS[current.id] : null;
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Management</h1>
          {current && <p>{current.intro}</p>}
        </div>
      </header>
      <div className="workspace-surface">
        <nav className="management-tabs" aria-label="Management sections">
          {sections.map((item) => (
            <NavLink key={item.id} to={item.id === "notifications" ? "/management" : `/management/${item.id}`} end>
              {item.label}
            </NavLink>
          ))}
          {user.role === "FINANCE_ADMIN" && (
            <Link to="/categories" className="management-tab-link">
              Categories
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          )}
        </nav>
        {loading || !Panel ? null : <Panel />}
      </div>
    </>
  );
}
