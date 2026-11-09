// The staging entry point: what it refuses, and what it does when it starts. Runs the real
// server in production mode against an authenticated throwaway MongoDB. Nothing leaves
// this machine: OCR is the stub, and Entra sign-in is not used (a session is inserted).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { credentialScopeProblem, stagingProblems } from "../scripts/stagingGuards.js";

const { MongoClient } = mongoose.mongo;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, "..");
const ORIGIN = "https://receiptflow-staging.example.test";
const safe = {
  NODE_ENV: "production",
  MONGODB_URI: "mongodb://example.test",
  MONGODB_DB_NAME: "receiptflow-staging",
  FRONTEND_ORIGIN: ORIGIN,
  ENTRA_TENANT_ID: "00000000-0000-4000-8000-000000000001",
  ENTRA_CLIENT_ID: "00000000-0000-4000-8000-000000000002",
  APPROVAL_WORKFLOW_ENABLED: "false",
  RECEIPT_CLEANUP_ENABLED: "false",
  NOTIFICATIONS_ENABLED: "false",
};

describe("Staging safety checks", () => {
  test("a safe configuration passes; the flags may also be unset", () => {
    assert.deepEqual(stagingProblems(safe), []);
    const { APPROVAL_WORKFLOW_ENABLED, RECEIPT_CLEANUP_ENABLED, NOTIFICATIONS_ENABLED, ...unset } = safe;
    assert.deepEqual(stagingProblems(unset), []);
  });

  const refused = [
    ["development mode", { NODE_ENV: "development" }, /NODE_ENV/],
    ["no database", { MONGODB_URI: "" }, /MONGODB_URI/],
    ["the production database name", { MONGODB_DB_NAME: "receiptflow" }, /staging database/],
    ["a database not named staging", { MONGODB_DB_NAME: "other" }, /staging database/],
    ["notifications on", { NOTIFICATIONS_ENABLED: "true" }, /NOTIFICATIONS_ENABLED/],
    ["approval routing on", { APPROVAL_WORKFLOW_ENABLED: "true" }, /APPROVAL_WORKFLOW_ENABLED/],
    ["receipt cleanup on", { RECEIPT_CLEANUP_ENABLED: "true" }, /RECEIPT_CLEANUP_ENABLED/],
    ["the shared beta login on", { BETA_AUTH_ENABLED: "true" }, /BETA_AUTH_ENABLED/],
    ["development sign-in on", { DEV_AUTH_ENABLED: "true" }, /DEV_AUTH_ENABLED/],
    ["the production frontend", { FRONTEND_ORIGIN: "https://jarcsys-collab.github.io" }, /production frontend/],
    ["no frontend", { FRONTEND_ORIGIN: "" }, /FRONTEND_ORIGIN/],
    ["an insecure frontend", { FRONTEND_ORIGIN: "http://localhost:5173" }, /https/],
    ["production's Entra app", { ENTRA_CLIENT_ID: "92e8f33d-6e27-4763-b638-7d7959c2ddc9" }, /app registration/],
    ["no Entra app", { ENTRA_CLIENT_ID: "" }, /ENTRA/],
    ["an unknown OCR mode", { STAGING_OCR_MODE: "maybe" }, /STAGING_OCR_MODE/],
  ];
  for (const [label, change, pattern] of refused) {
    test(`refused: ${label}`, () => {
      const problems = stagingProblems({ ...safe, ...change });
      assert.ok(problems.some((problem) => pattern.test(problem)), problems.join(" | "));
    });
  }

  test("messages never contain the configured values", () => {
    const text = stagingProblems({ ...safe, MONGODB_DB_NAME: "secret-db", FRONTEND_ORIGIN: "http://secret-host" }).join(" ");
    assert.doesNotMatch(text, /secret-db|secret-host/);
  });
});

describe("The staging server", () => {
  let memory;
  let root;
  let port;
  let scopedUri;
  let rootUri;
  const children = [];
  const blank = Object.fromEntries(
    ["VERYFI_CLIENT_ID", "VERYFI_CLIENT_SECRET", "VERYFI_USERNAME", "VERYFI_API_KEY", "GOOGLE_DOCUMENT_AI_PROJECT_ID", "GOOGLE_DOCUMENT_AI_LOCATION", "GOOGLE_DOCUMENT_AI_PROCESSOR_ID", "GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON", "GOOGLE_APPLICATION_CREDENTIALS", "BETA_AUTH_USERNAME", "BETA_AUTH_PASSWORD", "OCR_PROVIDER", "BETA_AUTH_ENABLED", "DEV_AUTH_ENABLED"].map((name) => [name, ""]),
  );
  const run = (env) => {
    const inherited = Object.fromEntries(["PATH", "Path", "SystemRoot", "TEMP", "TMP"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
    // Every setting is explicit, so server/.env can never supply one.
    const child = spawn(process.execPath, ["scripts/staging-server.js"], { cwd: SERVER_DIR, env: { ...inherited, ...blank, ...safe, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.log = "";
    child.stdout.on("data", (data) => (child.log += data));
    child.stderr.on("data", (data) => (child.log += data));
    child.finished = new Promise((resolve) => child.once("exit", resolve));
    children.push(child);
    return child;
  };

  before(async () => {
    memory = await MongoMemoryServer.create({
      auth: {
        enable: true,
        customRootName: "synthetic-root",
        customRootPwd: "synthetic-root-password",
        extraUsers: [{ createUser: "synthetic-staging", pwd: "synthetic-staging-password", database: "receiptflow-staging", roles: [{ role: "readWrite", db: "receiptflow-staging" }] }],
      },
    });
    const { hostname, port: mongoPort } = new URL(memory.getUri());
    scopedUri = `mongodb://synthetic-staging:synthetic-staging-password@${hostname}:${mongoPort}/?authSource=receiptflow-staging`;
    rootUri = `mongodb://synthetic-root:synthetic-root-password@${hostname}:${mongoPort}/?authSource=admin`;
    root = new MongoClient(rootUri);
    await root.connect();
    // Stands in for production data on the same server.
    await root.db("receiptflow").collection("users").insertOne({ name: "Synthetic production record" });
  });

  after(async () => {
    for (const child of children) child.kill();
    await root?.close();
    await memory?.stop();
  });

  test("the scoped user cannot read the production database's name; a broader user is refused", async () => {
    assert.equal(await credentialScopeProblem(scopedUri), null);
    assert.match(await credentialScopeProblem(rootUri), /able to read/);
    const scoped = new MongoClient(scopedUri);
    await scoped.connect();
    await assert.rejects(() => scoped.db("receiptflow").collection("users").findOne({}), (error) => error.code === 13);
    await scoped.close();
  });

  test("an unsafe configuration stops before it connects to anything", async () => {
    const child = run({ MONGODB_URI: scopedUri, NOTIFICATIONS_ENABLED: "true" });
    assert.equal(await child.finished, 1);
    assert.match(child.log, /Refusing to start/);
    assert.match(child.log, /NOTIFICATIONS_ENABLED/);
    assert.doesNotMatch(child.log, /synthetic-staging-password/);
  });

  test("an over-privileged database user is refused", async () => {
    const child = run({ MONGODB_URI: rootUri });
    assert.equal(await child.finished, 1);
    assert.match(child.log, /able to read/);
    assert.equal(await root.db("receiptflow-staging").collection("notificationRules").countDocuments(), 0);
    assert.doesNotMatch(child.log, /synthetic-root-password/);
  });

  test("a safe start: isolated database, no production origin, no default rules, stub OCR", { timeout: 90_000 }, async () => {
    port = 3188;
    const child = run({ MONGODB_URI: scopedUri, PORT: String(port) });
    const base = `http://127.0.0.1:${port}/api`;
    let health;
    for (let i = 0; i < 120; i += 1) {
      try {
        health = await (await fetch(`${base}/health`)).json();
        if (health.database === "connected" && /approved categories/i.test(child.log)) break;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(health?.database, "connected", child.log);
    assert.equal(health.ocr, "configured");
    assert.match(child.log, /STAGING service\. OCR: STUB/);
    assert.doesNotMatch(child.log, /synthetic-staging-password|PRIVATE KEY/);
    assert.doesNotMatch(child.log, /outbox worker|receipt-cleanup\] scheduled/, "notifications and cleanup did not start");

    const staging = root.db("receiptflow-staging");
    const names = (await staging.listCollections().toArray()).map((collection) => collection.name);
    for (const name of ["notificationRules", "notificationEvents", "ocrScanEvents", "managementAudit", "expenses", "receiptJobs", "users"]) assert.ok(names.includes(name), name);
    assert.equal(await staging.collection("notificationRules").countDocuments(), 0);
    assert.ok((await staging.collection("receiptJobs").indexes()).some((index) => index.name === "inFlightKey_1" && index.unique));
    assert.equal((await root.db("receiptflow").listCollections().toArray()).length, 1, "nothing was created in the production database's name");

    const allowed = async (origin) => (await fetch(`${base}/health`, { headers: { origin } })).headers.get("access-control-allow-origin");
    assert.equal(await allowed(ORIGIN), ORIGIN);
    assert.equal(await allowed("https://jarcsys-collab.github.io"), null, "the production frontend cannot call staging");

    assert.equal((await fetch(`${base}/auth/session`)).status, 401, "no sign-in shortcut");
    assert.equal((await fetch(`${base}/management/notification-rules`)).status, 401);

    // A signed-in Microsoft employee (a session is inserted; Entra is not contacted).
    const token = randomBytes(32).toString("base64url");
    await staging.collection("users").insertOne({ name: "Synthetic Employee", entraUserId: "synthetic-oid", role: "EMPLOYEE" });
    await staging.collection("sessions").insertOne({
      tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
      user: { id: "synthetic-oid", name: "Synthetic Employee", role: "EMPLOYEE", provider: "entra", email: "", department: "", jobTitle: "" },
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const headers = { authorization: `Bearer ${token}` };
    const session = await (await fetch(`${base}/auth/session`, { headers })).json();
    assert.deepEqual(
      [session.features.management, session.features.ocrAnalytics, session.features.approvalWorkflow],
      [true, false, false],
    );
    assert.equal((await fetch(`${base}/management/notification-rules`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/management/ocr-analytics`, { headers })).status, 403);

    const form = new FormData();
    form.append("receipt", new Blob([fs.readFileSync(path.join(HERE, "fixtures/synthetic-receipt.jpg"))], { type: "image/jpeg" }), "synthetic-receipt.jpg");
    const scan = await fetch(`${base}/receipts/upload`, { method: "POST", headers, body: form });
    const body = await scan.json();
    assert.equal(scan.status, 201, JSON.stringify(body));
    assert.equal(body.expense.merchant, "SAMPLE COFFEE HOUSE");
    assert.match(child.log, /stub OCR: no request sent to Google/);
    const event = await staging.collection("ocrScanEvents").findOne({});
    assert.equal(event.outcome, "success");
    assert.equal(await staging.collection("notificationEvents").countDocuments(), 0);
    child.kill();
  });
});
