import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronLeft, ChevronRight, Receipt } from "lucide-react";
import { config } from "../../config/appConfig";
import { useWorkspace } from "../../hooks/useWorkspace";
import { initials } from "../../utils/format";
import { getNavItems } from "./navItems";

// Desktop (>= 1024px): full teal sidebar, collapsible to icons (remembered on
// this browser). Tablet (640-1023px): icon rail that opens over the page.
// Phone (< 640px): the same element becomes the bottom navigation (mobile.css).
const DESKTOP_QUERY = "(min-width: 1024px)";
const COLLAPSED_KEY = "receiptflow-sidebar-collapsed";

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function Sidebar() {
  const { user, authenticated } = useWorkspace();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [expanded, setExpanded] = useState(false);
  const location = useLocation();
  const railRef = useRef(null);
  const toggleRef = useRef(null);
  const navItems = getNavItems(user.role, authenticated, user.managementAccess);
  // The tablet overlay only exists below the desktop breakpoint.
  const overlayOpen = expanded && !desktop;
  const open = desktop ? !collapsed : overlayOpen;
  function closeRail() {
    setExpanded(false);
    toggleRef.current?.focus();
  }
  function toggle() {
    if (desktop) {
      const next = !collapsed;
      setCollapsed(next);
      try {
        localStorage.setItem(COLLAPSED_KEY, String(next));
      } catch {
        // Not saved on this browser; the sidebar still toggles.
      }
    } else {
      setExpanded((current) => !current);
    }
  }
  useEffect(() => {
    setExpanded(false);
  }, [location.pathname, desktop]);
  useEffect(() => {
    if (!overlayOpen) {
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
  }, [overlayOpen]);
  const toggleLabel = open ? "Collapse navigation" : "Expand navigation";
  return (
    <>
      {overlayOpen && (
        <button
          className="rail-backdrop"
          aria-label="Close navigation"
          tabIndex={-1}
          onClick={closeRail}
        />
      )}
      <aside
        ref={railRef}
        className={`mobile-rail${overlayOpen ? " expanded" : ""}${desktop && collapsed ? " collapsed" : ""}`}
        aria-label="Workspace sidebar"
      >
        <div className="rail-head">
          <div className="rail-brand">
            <span className="brand-icon">
              <Receipt size={22} />
            </span>
            <span className="rail-label">
              <strong>{config.appName}</strong>
              <small>{config.accountName} · Expenses</small>
            </span>
          </div>
          <button
            ref={toggleRef}
            className="rail-toggle"
            aria-label={toggleLabel}
            aria-expanded={open}
            aria-controls="mobile-rail-links"
            title={toggleLabel}
            onClick={toggle}
          >
            {open ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
          </button>
        </div>
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
              <Icon size={20} />
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
