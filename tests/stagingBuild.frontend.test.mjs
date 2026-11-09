// The staging build cannot point at production.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readProductionEnv, stagingBuildProblems } from "../scripts/checkStagingEnv.mjs";

const production = {
  VITE_API_BASE_URL: "https://production.example.test/api",
  VITE_ENTRA_CLIENT_ID: "production-client",
  VITE_ENTRA_REDIRECT_URI: "https://production.example.test/app/",
};
const staging = {
  VITE_APP_NAME: "ReceiptFlow STAGING",
  VITE_API_BASE_URL: "https://staging-api.example.test/api",
  VITE_ENTRA_CLIENT_ID: "staging-client",
  VITE_ENTRA_TENANT_ID: "tenant",
  VITE_ENTRA_REDIRECT_URI: "https://staging.example.test/",
};
const problemsWith = (change) => stagingBuildProblems({ ...staging, ...change }, production).join(" | ");

test("a staging configuration builds", () => {
  assert.deepEqual(stagingBuildProblems(staging, production), []);
});

test("production's API, app registration and address are refused", () => {
  assert.match(problemsWith({ VITE_API_BASE_URL: production.VITE_API_BASE_URL }), /production API/);
  assert.match(problemsWith({ VITE_ENTRA_CLIENT_ID: production.VITE_ENTRA_CLIENT_ID }), /production's app registration/);
  assert.match(problemsWith({ VITE_ENTRA_REDIRECT_URI: "https://production.example.test/" }), /^$/, "a different address is fine");
  assert.match(stagingBuildProblems({ ...staging, VITE_ENTRA_REDIRECT_URI: "https://same.example.test/" }, { ...production, VITE_ENTRA_REDIRECT_URI: "https://same.example.test/" }).join(), /production address/);
});

test("production's values come from the committed file, whatever the shell says", () => {
  const before = process.env.VITE_API_BASE_URL;
  process.env.VITE_API_BASE_URL = "https://staging-api.example.test/api";
  try {
    const real = readProductionEnv();
    assert.match(real.VITE_API_BASE_URL, /^https:\/\/expense-report-production/);
    assert.ok(real.VITE_ENTRA_CLIENT_ID);
    assert.match(stagingBuildProblems({ ...staging, VITE_API_BASE_URL: real.VITE_API_BASE_URL }, real).join(), /production API/);
    assert.deepEqual(stagingBuildProblems(staging, real), []);
  } finally {
    if (before === undefined) delete process.env.VITE_API_BASE_URL;
    else process.env.VITE_API_BASE_URL = before;
  }
});

test("placeholders, missing values and an unlabelled app are refused", () => {
  assert.match(problemsWith({ VITE_API_BASE_URL: "" }), /VITE_API_BASE_URL/);
  assert.match(problemsWith({ VITE_API_BASE_URL: "http://insecure.example.test/api" }), /VITE_API_BASE_URL/);
  assert.match(problemsWith({ VITE_ENTRA_CLIENT_ID: "" }), /VITE_ENTRA_CLIENT_ID/);
  assert.match(problemsWith({ VITE_ENTRA_REDIRECT_URI: "" }), /VITE_ENTRA_REDIRECT_URI/);
  assert.match(problemsWith({ VITE_APP_NAME: "ReceiptFlow" }), /must say staging/);
});
