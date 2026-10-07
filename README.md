# ReceiptFlow

Receipt scanning and expense approvals. React 19 + Vite frontend, deployed to GitHub Pages.

## Develop

```sh
npm install
npm run dev        # http://localhost:5173/#/upload
npm run build      # production build into dist/ (for checking)
npm run preview    # serve dist/
```

Configuration is read from `VITE_*` environment variables; see `.env.example`.
Without `VITE_API_BASE_URL` the app runs in its "service not configured" state.

## Backend (`server/`)

Node.js + Express API backed by MongoDB Atlas (database `receiptflow`).

```sh
cd server
cp .env.example .env     # set MONGODB_URI; never commit .env
npm install
npm run dev              # http://localhost:3000/api/health
```

Run the frontend against it with `VITE_API_BASE_URL=http://localhost:3000/api`.
For local development without signing in, set `DEV_AUTH_ENABLED=true` in `server/.env` so
`/api/auth/session` returns a test user (ignored in production). See **Sign-in** below.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | API + database status |
| GET, POST | `/api/expenses` | list (`?status&category&employeeId&limit`), create |
| GET, PATCH, DELETE | `/api/expenses/:id` | edit/delete only while Draft, Needs Review, Needs Correction or Rejected |
| GET, POST | `/api/categories` | |
| PUT | `/api/categories/:id` | id or the frontend's new-category UUID |
| POST | `/api/expenses/:id/submit` | runs the anomaly check; anomaly → Pending Approval (manager), none → Submitted (Finance) |
| POST | `/api/receipts/upload` | multipart field `receipt`; Veryfi OCR → normalized expense + anomaly report |
| GET | `/api/receipts/:jobId/status` | OCR job polling |
| GET | `/api/violations` | expenses with findings (Expense Issues page) |
| POST | `/api/auth/entra` | Microsoft sign-in: verified ID token (+ Graph token) → ReceiptFlow session |
| POST | `/api/auth/login` | TEMPORARY beta sign-in (fallback) |
| GET / POST | `/api/auth/session`, `/api/auth/logout` | session check used by the frontend |

Errors are JSON: `{ "error": "CODE", "message": "...", "details"?: [...] }`.

`npm run dev` (frontend) uses `.env.development`, which points at `http://localhost:3000/api`
and enables receipt upload. Production/Pages builds do not read it.

**OCR (Veryfi):** backend only (`server/src/services/veryfiService.js`, official SDK). Set the four
`VERYFI_*` values in `server/.env`. Responses are mapped to the expense shape in
`receiptNormalizer.js`; nothing Veryfi did not return is filled in.

**Anomaly checks:** `server/src/services/anomaly/` implements the nine anomalies in
`Anomalies_reference.pdf` (each rule quotes its PDF anomaly and solution). Rules whose data source
is not connected yet (attendance/leave, hotel and budget policy knowledge base, approval evidence)
return `not_evaluated` with a `requiredSource`, and the report lists them in `notEvaluated`.

**Receipt dates:** a printed date such as `10/03/2026` can be read as day/month or month/day.
The backend re-reads the printed date from the OCR text, keeps it as `dateReview.raw` (and
`originalOCR.expenseDateRaw`), suggests the `RECEIPT_DATE_ORDER` reading (default `DMY`,
Philippines), and marks the date `needs_confirmation`. The review screen shows the printed value
and lets the employee pick or confirm the date; submission is refused (`DATE_NOT_CONFIRMED`)
until the confirmed date matches the date field. Dates that can only be read one way are used
directly.

## Sign-in

**Primary: Microsoft Entra ID.** The SPA uses MSAL (`@azure/msal-browser` + `@azure/msal-react`)
with the authorization code flow + PKCE and full-page redirects (desktop, iPhone Safari and
Android Chrome alike). There is no client secret anywhere. Frontend config is centralized in
`src/config/authConfig.js` (`VITE_ENTRA_CLIENT_ID`, `VITE_ENTRA_TENANT_ID`,
`VITE_ENTRA_REDIRECT_URI`, set in `.env.pages` for GitHub Pages); the MSAL cache is
`sessionStorage`.

After sign-in the browser posts the ID token and a Microsoft Graph `User.Read` token once to
`POST /api/auth/entra` (`server/src/services/entraAuth.js`):

- the ID token's signature is verified against the tenant's published keys, and issuer, tenant
  (`tid`), audience (`ENTRA_CLIENT_ID`), expiry and not-before are checked;
- the server itself calls `GET https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,department,jobTitle`
  with the Graph token and accepts the profile only when its `id` matches the token's `oid`.
  If Graph is unavailable, name and email come from the verified ID token and department/job
  title stay empty (never invented);
- the user is upserted in `users` by `entraUserId` (display name, email, department, job title,
  `lastLoginAt`; role `EMPLOYEE` on first sign-in, then kept). Tokens are never stored;
- a ReceiptFlow session is created (`ENTRA_SESSION_HOURS`, default 8): an HttpOnly cookie, plus
  the same token returned to the page, which keeps it **in memory only** and sends it as
  `Authorization: Bearer` so the session also works where cross-site cookies are blocked
  (Safari). After a reload the session is restored from the cookie or silently from MSAL.

Expenses get their owner from the session, never from the browser: `employeeId`,
`employeeName`, `department`, `position` and `employee { provider, entraUserId, displayName,
email, department, jobTitle }`. In the scanner form these fields are read-only for Microsoft
accounts; an empty department or job title shows "Not provided in Microsoft profile".

Sign-out deletes the ReceiptFlow session and clears MSAL's tokens from the browser.

**Temporary fallback: beta sign-in** (`BETA_AUTH_*`, one shared account, `provider: "beta"`,
id `beta-user`, never stored as a user). It is a collapsed "Use temporary beta sign-in" option
on the Profile page. Signing in with either method replaces any existing session, so the two
identities never mix. To remove it after Entra is verified: delete the beta block in
`server/src/routes/auth.js`, `BETA_*` in `server/src/config/env.js` and the beta helpers in
`server/src/services/authSession.js`, and `betaLogin` / the beta form in
`src/services/authService.js` and `src/pages/ProfilePage.jsx`.

Local Microsoft sign-in needs `http://localhost:5173/` added as a Single-page application redirect
URI on the app registration and the IDs filled in `.env.development` (empty by default).

## Current limitations

- **Receipt files are not stored.** ReceiptFlow saves the extracted data, the OCR job and file
  metadata (name, type, size) only. The original receipt image/PDF is sent to Veryfi and is not
  kept by ReceiptFlow, so reopening a saved expense cannot show the original receipt.
- **Long receipts:** uploads with several sections are rejected with
  `MULTIPLE_FILES_NOT_SUPPORTED` (one photo or one PDF per scan).

## Production deployment blockers

These must be built before ReceiptFlow is used in production. None of them is faked: the
frontend calls the endpoints, and the API answers `404 NOT_FOUND`.

1. **Roles and ownership rules.** Microsoft sign-in is in place, but every new user is an
   `EMPLOYEE` until an administrator changes `role` in the `users` collection, and listing is not
   yet limited to the employee's own expenses. The beta sign-in fallback should be removed once
   Microsoft sign-in is verified.
2. **Approve:** `POST /api/expenses/:id/approve`
3. **Reject:** `POST /api/expenses/:id/reject` (and request changes, `POST /api/expenses/:id/request-changes`)
4. **Comments:** `POST /api/expenses/:id/comments`
5. **File deletion:** `DELETE /api/expenses/:id/files/:fileId` (and `POST /api/receipts/files` for added/edited images),
   which also depends on receipt file storage above.
6. **Resolve finding** (Expense Issues page): `POST /api/expenses/:id/violations/:violationId/resolve`.

## Deploy backend (Railway)

- Service **Root Directory**: `/server`. Railpack reads `server/railpack.json` (Node provider,
  `npm start` → `node src/server.js`), so the repo-root Vite app is never served instead.
- Optional: set the service **Config File Path** to `/server/railway.json` (health check
  `/api/health`, redeploy only on `/server/**` changes). Railway does not apply Root Directory to it.
- The server listens on Railway's `PORT`; the public domain's target port must be that same port.
- Set variables in Railway (not files): `NODE_ENV=production`, `MONGODB_URI`, `MONGODB_DB_NAME`,
  `VERYFI_*`, `RECEIPT_DATE_ORDER`, `TRUST_PROXY=1`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`
  (same values as the frontend's `VITE_ENTRA_*`) and, while the fallback exists, `BETA_AUTH_*`.
  Allow Railway's egress in Atlas Network Access.

## Deploy (GitHub Pages)

The Pages workflow (`.github/workflows/pages.yml`, run manually) publishes the
committed `site/` folder as-is. To publish a new build:

```sh
npm run build:pages   # replaces site/ with a fresh build
git add site && git commit -m "Publish frontend"
```

Then run the "Publish ReceiptFlow frontend" workflow.

## Layout

```
src/
  config/      appConfig.js (env-driven settings), api.js (base URL + every endpoint)
  services/    httpClient, authService, expenseService, categoryService,
               violationService, receiptService, normalizers, api (UI facade)
  context/     Workspace, upload queue and theme providers
  hooks/       useWorkspace, useUploadQueue, useTheme
  pages/       one component per route
  components/  layout/, common/, expenses/, receipts/
  utils/       formatting, value coercion, expense rules, image and file helpers
  styles/      index.css (the original deployed stylesheet)
```

Routes use a hash router (`/#/upload`, `/#/requests/:id`, ...) so deep links work on GitHub Pages.
