import { useEffect } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { WifiOff } from "lucide-react";
import { config } from "../../config/appConfig";
import { useWorkspace } from "../../hooks/useWorkspace";
import { Sidebar } from "./Sidebar";

export function AppLayout() {
  const { online, authenticated, loading } = useWorkspace();
  const location = useLocation();
  useEffect(() => {
    const viewport = window.visualViewport;
    const updateViewport = () => {
      const keyboardInset = viewport
        ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        : 0;
      const keyboardOpen = !!(
        document.activeElement?.matches("input, textarea, select") &&
        keyboardInset > 120
      );
      document.documentElement.classList.toggle("keyboard-open", keyboardOpen);
      document.documentElement.style.setProperty(
        "--keyboard-inset",
        `${keyboardOpen ? keyboardInset : 0}px`,
      );
      document.documentElement.style.setProperty(
        "--visible-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
    };
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    document.addEventListener("focusin", updateViewport);
    document.addEventListener("focusout", updateViewport);
    return () => {
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      document.removeEventListener("focusin", updateViewport);
      document.removeEventListener("focusout", updateViewport);
      document.documentElement.classList.remove("keyboard-open");
    };
  }, []);
  return (
    <div
      className={`app-shell ${location.pathname.startsWith("/review/") ? "review-screen" : ""}`}
    >
      <div className="main-shell">
        {!online && (
          <div className="offline" role="status">
            <WifiOff size={17} />
            {
              " You’re offline. Keep this page open, then reconnect and retry uploads."
            }
          </div>
        )}
        {!config.apiBase && (
          <div className="offline" role="status">
            Workspace service is not configured. Records will appear after your
            organization connects its service.
          </div>
        )}
        {config.apiBase && !authenticated && !loading && (
          <div className="offline" role="status">
            Sign in to use ReceiptFlow. <Link to="/profile">Sign in</Link>
          </div>
        )}
        <main key={location.pathname.split("/")[1]}>
          <Outlet />
        </main>
      </div>
      <Sidebar />
    </div>
  );
}
