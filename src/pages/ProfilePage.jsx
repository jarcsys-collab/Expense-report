import { useState } from "react";
import { Link } from "react-router-dom";
import { config } from "../config/appConfig";
import { entraConfig } from "../config/authConfig";
import { useWorkspace } from "../hooks/useWorkspace";
import { betaLogin, signIn } from "../services/authService";
import { signInWithMicrosoft } from "../services/entraAuth";

const NOT_PROVIDED = "Not provided in Microsoft profile";

export function ProfilePage() {
  const { user, authenticated, logout, run, busy, error, refresh } =
    useWorkspace();
  const microsoftSignIn = Boolean(config.apiBase) && entraConfig.enabled;
  // TEMPORARY controlled-beta sign-in, kept as a fallback while Microsoft
  // sign-in is verified. The password stays in memory only and is cleared
  // after every attempt.
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
  const betaForm = (
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
  );
  const verified = authenticated && user.provider === "entra";
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
        {verified ? (
          <dl className="profile-identity">
            <dt>Department</dt>
            <dd className={user.department ? "" : "not-provided"}>
              {user.department || NOT_PROVIDED}
            </dd>
            <dt>Job title</dt>
            <dd className={user.position ? "" : "not-provided"}>
              {user.position || NOT_PROVIDED}
            </dd>
            <dt>Role</dt>
            <dd>{user.role.replaceAll("_", " ").toLowerCase()}</dd>
            <dt>Signed in with</dt>
            <dd>Microsoft</dd>
          </dl>
        ) : (
          <p>
            {authenticated
              ? [
                  user.department,
                  user.role.replaceAll("_", " ").toLowerCase(),
                  user.provider === "beta" && "temporary beta account",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Account verification requires your organization’s sign-in service."}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {authenticated ? (
          <button
            className="button"
            disabled={busy}
            onClick={() => void run(logout)}
          >
            Sign out
          </button>
        ) : microsoftSignIn ? (
          <>
            <button
              className="button primary microsoft-sign-in"
              disabled={busy}
              onClick={() => void run(() => signInWithMicrosoft("/upload"))}
            >
              Sign in with Microsoft
            </button>
            {betaSignIn && (
              <details className="beta-sign-in">
                <summary>Use temporary beta sign-in</summary>
                {betaForm}
              </details>
            )}
          </>
        ) : betaSignIn ? (
          betaForm
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
