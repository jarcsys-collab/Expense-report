// Microsoft Entra ID sign-in (primary authentication).
//
// The SPA signs in with MSAL (authorization code flow + PKCE, no client secret)
// and posts two tokens to POST /api/auth/entra once per sign-in:
//   - the ID token: proves who signed in. Its signature is verified against the
//     tenant's published signing keys, and issuer, tenant, audience (this app's
//     client ID), expiry and not-before are checked. It is never just decoded.
//   - the Microsoft Graph access token (User.Read): used once, server-side, to
//     read the profile from Graph. Graph itself validates it, and the profile is
//     only accepted when its id matches the verified ID token's oid. So the
//     browser cannot supply its own name, department or job title.
// Neither token is stored. The server then issues its own ReceiptFlow session.
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errorHandler.js";
import { User } from "../models/User.js";

const GRAPH_PROFILE_FIELDS = "id,displayName,mail,userPrincipalName,department,jobTitle";

let keySet;
const signingKeys = () =>
  (keySet ??= createRemoteJWKSet(new URL(env.entra.jwksUri), { timeoutDuration: 5000, cooldownDuration: 30_000 }));

const rejected = (message = "Your Microsoft sign-in could not be verified. Please sign in again.") =>
  new HttpError(401, "INVALID_MICROSOFT_TOKEN", message);

// Verifies a Microsoft ID token and returns its claims, or throws 401.
export async function verifyEntraIdToken(idToken) {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, signingKeys(), {
      algorithms: ["RS256"],
      issuer: env.entra.issuer,
      audience: env.entra.clientId,
      requiredClaims: ["exp", "iat", "oid", "tid"],
      clockTolerance: 60,
    }));
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) throw rejected("Your Microsoft sign-in has expired. Please sign in again.");
    if (error instanceof joseErrors.JOSEError) throw rejected();
    // Signing keys unreachable (network) rather than a bad token.
    throw new HttpError(503, "MICROSOFT_UNAVAILABLE", "Microsoft sign-in is temporarily unavailable. Please retry.");
  }
  // The issuer already pins the tenant; checked again so a misconfiguration cannot widen it.
  if (payload.tid !== env.entra.tenantId) throw rejected("This Microsoft account is not part of the organization.");
  if (typeof payload.oid !== "string" || !payload.oid) throw rejected();
  return payload;
}

// GET /me with the user's Graph token. null when Graph is unavailable or rejects the token.
async function fetchGraphProfile(accessToken) {
  if (!accessToken) return null;
  try {
    const response = await fetch(`${env.entra.graphBaseUrl}/v1.0/me?$select=${GRAPH_PROFILE_FIELDS}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

const text = (value, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// The verified identity plus profile. Department and job title come only from
// Graph; when Graph is unavailable they stay empty (never invented).
export async function resolveEntraProfile(claims, accessToken) {
  const graph = await fetchGraphProfile(accessToken);
  if (graph && graph.id !== claims.oid) {
    throw rejected("The Microsoft profile does not match the signed-in account.");
  }
  const displayName = text(graph?.displayName) || text(claims.name) || text(claims.preferred_username);
  const email = (text(graph?.mail, 320) || text(graph?.userPrincipalName, 320) || text(claims.preferred_username, 320)).toLowerCase();
  return {
    entraUserId: claims.oid,
    tenantId: claims.tid,
    displayName: displayName || email || "Microsoft user",
    email,
    department: text(graph?.department),
    jobTitle: text(graph?.jobTitle),
    profileSource: graph ? "graph" : "id_token",
  };
}

// Creates or updates the ReceiptFlow user keyed by the Entra object id.
// The role is set only when the record is first created, so a role changed
// later by an administrator is kept.
export async function upsertEntraUser(profile) {
  const set = {
    entraUserId: profile.entraUserId,
    tenantId: profile.tenantId,
    authProvider: "entra",
    displayName: profile.displayName,
    name: profile.displayName,
    department: profile.department,
    jobTitle: profile.jobTitle,
    position: profile.jobTitle,
    lastLoginAt: new Date(),
  };
  const update = profile.email ? { $set: { ...set, email: profile.email } } : { $set: set, $unset: { email: 1 } };
  update.$setOnInsert = { role: "EMPLOYEE" };
  return User.findOneAndUpdate({ entraUserId: profile.entraUserId }, update, {
    upsert: true,
    returnDocument: "after",
    runValidators: true,
  }).lean();
}
