import { useState } from "react";
import { Link } from "react-router-dom";
import { config } from "../config/appConfig";
import { useWorkspace } from "../hooks/useWorkspace";
import { betaLogin, signIn } from "../services/authService";

export function ProfilePage() {
  const { user, authenticated, logout, run, busy, error, refresh } =
    useWorkspace();
  // TEMPORARY controlled-beta sign-in (until Microsoft Entra ID). The password
  // stays in memory only and is cleared after every attempt.
  const betaSignIn = Boolean(config.apiBase) && !config.signInUrl;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const submitBetaLogin = async (event) => {
    event.preventDefault();
    const entered = password;
    setPassword("");
    const signedIn = await run(async () => {
      await betaLogin(username.trim(), entered);
      return true;
    }, "Signed in");
    if (signedIn) await refresh();
  };
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
        ) : betaSignIn ? (
          <form onSubmit={submitBetaLogin} aria-label="Beta sign-in">
            <label className="field">
              Username
              <input
                name="username"
                autoComplete="username"
                required
                value={username}
                disabled={busy}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label className="field">
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button className="button primary" disabled={busy}>
              Sign In
            </button>
          </form>
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
