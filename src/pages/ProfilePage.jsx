import { Link } from "react-router-dom";
import { useWorkspace } from "../hooks/useWorkspace";
import { signIn } from "../services/authService";

export function ProfilePage() {
  const { user, authenticated, logout, run, busy, error, refresh } =
    useWorkspace();
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">WORKSPACE / ACCOUNT</div>
          <h1>Profile</h1>
          <p>Your workspace account.</p>
        </div>
      </header>
      <section className="panel profile-panel">
        <h3>{user.name}</h3>
        {user.email && <p>{user.email}</p>}
        <p>
          {authenticated
            ? [user.department, user.role.replaceAll("_", " ").toLowerCase()]
                .filter(Boolean)
                .join(" · ")
            : "Account verification requires your organization’s sign-in service."}
        </p>
        {error && <p role="alert">{error}</p>}
        {authenticated ? (
          <button
            className="button"
            disabled={busy}
            onClick={() => void run(logout)}
          >
            Sign out
          </button>
        ) : (
          <button
            className="button"
            disabled={busy}
            onClick={() => void run(async () => signIn())}
          >
            Sign in
          </button>
        )}
        <button
          className="button"
          disabled={busy}
          onClick={() => void run(refresh)}
        >
          Refresh account
        </button>
        <div className="profile-links">
          <Link to="/settings">Settings & appearance</Link>
          <Link to="/violations">Policy violations</Link>
          <Link to="/requests">My requests</Link>
          {(user.role === "FINANCE_ADMIN" || !authenticated) && (
            <Link to="/categories">Category policies</Link>
          )}
        </div>
      </section>
    </>
  );
}
