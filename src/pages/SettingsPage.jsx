import { Link } from "react-router-dom";
import { ArrowRight, Check, Moon, Sun } from "lucide-react";
import { useTheme } from "../hooks/useTheme";

export function SettingsPage() {
  const { theme, setTheme, saved } = useTheme();
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">WORKSPACE / PREFERENCES</div>
          <h1>Settings</h1>
          <p>Make ReceiptFlow feel right for you.</p>
        </div>
      </header>
      <section className="panel appearance-panel">
        <h2>Appearance</h2>
        <p className="muted">
          Choose a theme for your workspace. Changes apply immediately.
        </p>
        <div className="theme-options" role="group" aria-label="Color theme">
          {["light", "dark"].map((item) => (
            <button
              key={item}
              type="button"
              className={`theme-option ${theme === item ? "selected" : ""}`}
              aria-pressed={theme === item}
              onClick={() => setTheme(item)}
            >
              <span
                className={`theme-sample theme-sample-${item}`}
                aria-hidden="true"
              >
                <span className="sample-sidebar" />
                <span className="sample-content">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <span className="theme-option-label">
                {item === "light" ? <Sun size={20} /> : <Moon size={20} />}
                <strong>{item === "light" ? "Light mode" : "Dark mode"}</strong>
                {theme === item && <Check size={19} />}
              </span>
            </button>
          ))}
        </div>
        <p className="theme-status muted" role="status">
          {saved
            ? `${theme === "light" ? "Light" : "Dark"} mode · Preference saved on this browser.`
            : "Theme applied. This browser could not save your preference."}
        </p>
      </section>
      <section className="panel appearance-panel settings-account">
        <div>
          <h2>Account</h2>
          <p className="muted">Manage your workspace account and sign-in.</p>
        </div>
        <Link className="button" to="/profile">
          {"Open profile "}
          <ArrowRight size={16} />
        </Link>
      </section>
    </>
  );
}
