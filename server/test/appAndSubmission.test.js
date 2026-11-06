// App boot / health, upload guards, and the duplicate-submission guard.
// No real database: the Mongo call is mocked at the collection level.
import "./setup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { Expense } from "../src/models/Expense.js";

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("health reports the OCR provider and status without any credential details", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ocrProvider, "google_document_ai");
    assert.equal(body.ocr, "configured");
    const text = JSON.stringify(body);
    assert.ok(!/private_key|client_email|BEGIN/.test(text));
  });
});

test("submission guard: a second concurrent submit cannot save (DocumentNotFoundError → 409 in the route)", async (t) => {
  const expense = Expense.hydrate({ _id: new mongoose.Types.ObjectId(), status: "Draft", activityLog: [], receiptFiles: [] });
  const statusAtStart = expense.status;
  expense.status = "Submitted";
  expense.$where = { status: statusAtStart };
  let filterSeen;
  // The other request already moved the expense out of "Draft": nothing matches.
  t.mock.method(Expense.collection, "updateOne", async (filter) => {
    filterSeen = filter;
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  });
  // VersionError when arrays changed (the route appends to activityLog), else DocumentNotFoundError;
  // the submit route turns either into 409 ALREADY_SUBMITTED.
  await assert.rejects(expense.save({ validateBeforeSave: false }), (error) =>
    ["DocumentNotFoundError", "VersionError"].includes(error.name),
  );
  assert.equal(filterSeen.status, "Draft", "the save is conditional on the status read at the start");
});
