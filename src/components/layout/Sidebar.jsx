import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { PanelLeftClose, PanelLeftOpen, Receipt } from "lucide-react";
import { config } from "../../config/appConfig";
import { useWorkspace } from "../../hooks/useWorkspace";
import { initials } from "../../utils/format";
import { getNavItems } from "./navItems";

export function Sidebar() {
  const { user, authenticated } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const location = useLocation();
  const railRef = useRef(null);
  const toggleRef = useRef(null);
  const navItems = getNavItems(user.role, authenticated);
  function closeRail() {
    setExpanded(false);
    toggleRef.current?.focus();
  }
  useEffect(() => {
    setExpanded(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!expanded) {
      return;
    }
    const mainShell = document.querySelector(".main-shell");
    const previousOverflow = document.body.style.overflow;
    if (mainShell) {
      mainShell.inert = true;
    }
    document.body.style.overflow = "hidden";
    const onKeyDown = (_) => {
      if (_.key === "Escape") {
        _.preventDefault();
        closeRail();
      }
      if (_.key === "Tab") {
        const focusable = Array.from(
          railRef.current?.querySelectorAll("a,button") || [],
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (_.shiftKey && document.activeElement === first) {
          _.preventDefault();
          last?.focus();
        } else {
          if (!_.shiftKey && document.activeElement === last) {
            _.preventDefault();
            first?.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      if (mainShell) {
        mainShell.inert = false;
      }
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded]);
  return (
    <>
      {expanded && (
        <button
          className="rail-backdrop"
          aria-label="Close navigation"
          tabIndex={-1}
          onClick={closeRail}
        />
      )}
      <aside
        ref={railRef}
        className={`mobile-rail ${expanded ? "expanded" : ""}`}
        aria-label="Workspace sidebar"
      >
        <div className="rail-brand">
          <span className="brand-icon">
            <Receipt size={21} />
          </span>
          <strong className="rail-label">{config.appName}</strong>
        </div>
        <button
          ref={toggleRef}
          className="rail-toggle"
          aria-label={expanded ? "Collapse navigation" : "Expand navigation"}
          aria-expanded={expanded}
          aria-controls="mobile-rail-links"
          title={expanded ? "Collapse navigation" : "Expand navigation"}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? (
            <PanelLeftClose size={21} />
          ) : (
            <PanelLeftOpen size={21} />
          )}
          <span className="rail-label">Collapse menu</span>
        </button>
        <nav id="mobile-rail-links" aria-label="Workspace navigation">
          {navItems.map(({ to, label, short, phone, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              aria-label={label}
              title={label}
              data-phone={phone ? "true" : undefined}
              onClick={() => setExpanded(false)}
            >
              <Icon size={21} />
              <span className="rail-label">{label}</span>
              <span className="rail-short" aria-hidden="true">
                {short}
              </span>
            </NavLink>
          ))}
        </nav>
        <NavLink
          className="rail-profile"
          to="/profile"
          aria-label="Profile"
          title="Profile"
          onClick={() => setExpanded(false)}
        >
          <span className="avatar small">{initials(user.name)}</span>
          <span className="rail-label">
            <strong>{user.name}</strong>
            <small>
              {authenticated
                ? user.email || user.role.replaceAll("_", " ")
                : "Workspace account"}
            </small>
          </span>
          <span className="rail-short" aria-hidden="true">
            Profile
          </span>
        </NavLink>
      </aside>
    </>
  );
}
