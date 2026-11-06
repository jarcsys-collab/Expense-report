// Frontend OCR confirmation logic (utils, API payload, assistant steps), loaded
// through Vite so import.meta.env works. Run: npm test (repository root).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite;
let ocr;
let normalizers;
let flow;

before(async () => {
  vite = await createServer({ logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
  ocr = await vite.ssrLoadModule("/src/utils/ocrConfirmation.js");
  normalizers = await vite.ssrLoadModule("/src/services/normalizers.js");
  flow = await vite.ssrLoadModule("/src/components/assistant/assistantFlow.js");
});
after(async () => vite?.close());

const SERVER_ID = "6aed640cbeb1f481c06d018b";
const scanned = () => ({
  id: "4b1c0f6e-1111-4222-8333-944455556666", // unsaved (browser id)
  receiptJobId: "6aed640cbeb1f481c06d0100",
  merchant: "SAMPLE COFFEE HOUSE",
  expenseDate: "2026-03-25",
  amount: 335.5,
  currency: "PHP",
  ocrConfidence: { merchant: 0.858, expenseDate: 0.433, amount: 0.953 },
  originalOCR: { merchant: "SAMPLE COFFEE HOUSE", expenseDate: "2026-03-25", amount: 335.5, currency: "PHP" },
});

test("unsaved scan: low-confidence key fields are predicted from the scan", () => {
  const states = ocr.ocrFieldStates(scanned());
  assert.deepEqual(states.map((s) => [s.field, s.status]), [["expenseDate", "needs_confirmation"]]);
  assert.equal(ocr.confidenceText(0.433), "43% confidence");
});

test("saved expense: only the server's review list counts", () => {
  const saved = { ...scanned(), id: SERVER_ID };
  assert.deepEqual(ocr.ocrFieldStates(saved), [], "saved without reviews: nothing to confirm");
  saved.ocrFieldReviews = [
    { field: "amount", ocrValue: 335.5, ocrConfidence: 0.6, status: "confirmed", confirmedValue: 335.5, confirmedBy: { id: "e", name: "Emp" } },
  ];
  const [state] = ocr.ocrFieldStates(saved);
  assert.equal(state.status, "confirmed");
  assert.equal(state.confirmedBy.name, "Emp");
  assert.equal(ocr.ocrFieldStates({ ...saved, amount: 336 })[0].status, "needs_confirmation", "a changed value needs confirmation again");
});

test("confirm, correct and invalidate locally; payload only carries matching confirmations", () => {
  let expense = ocr.confirmOcrFields(scanned(), ["expenseDate"]);
  assert.equal(ocr.ocrFieldState(expense, "expenseDate").status, "confirmed");
  assert.deepEqual(normalizers.toExpensePayload(expense).ocrConfirmations, { expenseDate: "2026-03-25" });
  expense = { ...expense, expenseDate: "2026-03-24" };
  assert.equal(ocr.ocrFieldState(expense, "expenseDate").status, "needs_confirmation");
  assert.equal(normalizers.toExpensePayload(expense).ocrConfirmations, undefined, "stale confirmation not sent");
  expense = ocr.confirmOcrFields(expense, ["expenseDate"]);
  assert.equal(ocr.ocrFieldState(expense, "expenseDate").status, "corrected");
  const payload = normalizers.toExpensePayload({ ...expense, ocrFieldReviews: [{ field: "expenseDate", status: "confirmed" }] });
  assert.equal(payload.ocrFieldReviews, undefined, "server records are never sent back");
});

test("amount confirmations are sent as numbers", () => {
  const expense = ocr.confirmOcrFields({ ...scanned(), amount: "335.50", ocrConfidence: { amount: 0.5 } }, ["amount"]);
  assert.deepEqual(normalizers.toExpensePayload(expense).ocrConfirmations, { amount: 335.5 });
});

test("server reviews are read from API responses", () => {
  const expense = normalizers.normalizeExpense({
    id: SERVER_ID,
    merchant: "M",
    expenseDate: "2026-03-25",
    amount: 10,
    ocrFieldReviews: [
      { field: "expenseDate", ocrValue: "2026-03-25", ocrConfidence: 0.433, status: "needs_confirmation", confirmedBy: null },
      { field: "evil", status: "confirmed" },
    ],
  });
  assert.deepEqual(expense.ocrFieldReviews.map((r) => [r.field, r.status]), [["expenseDate", "needs_confirmation"]]);
});

test("assistant: asks to confirm uncertain fields before continuing, then records the confirmation", () => {
  const start = { ...flow.initialState(), step: flow.STEPS.REVIEW_EXTRACTED_DATA, expense: scanned(), categoryConfirmed: true };
  const asked = flow.reducer(start, { type: "DETAILS_CONFIRMED" });
  assert.equal(asked.step, flow.STEPS.CONFIRM_OCR_FIELDS);
  const message = asked.messages.at(-1);
  assert.equal(message.type ?? message.kind, "ocrConfirm");
  const confirmed = flow.reducer(asked, { type: "OCR_FIELDS_CONFIRMED", fields: ["expenseDate"], label: "This matches my receipt." });
  assert.notEqual(confirmed.step, flow.STEPS.CONFIRM_OCR_FIELDS);
  assert.deepEqual(confirmed.expense.ocrConfirmations, { expenseDate: "2026-03-25" });
});

test("assistant: editing an uncertain field is an explicit correction; untouched ones still need confirming", () => {
  const expense = { ...scanned(), ocrConfidence: { merchant: 0.5, expenseDate: 0.433, amount: 0.95 } };
  const start = { ...flow.initialState(), step: flow.STEPS.CONFIRM_OCR_FIELDS, expense, categoryConfirmed: true };
  const edited = flow.reducer(start, { type: "DETAILS_EDITED", expense: { ...expense, merchant: "Sample Coffee House Makati" } });
  assert.equal(ocr.ocrFieldState(edited.expense, "merchant").status, "corrected");
  assert.equal(ocr.ocrFieldState(edited.expense, "expenseDate").status, "needs_confirmation");
  assert.equal(edited.step, flow.STEPS.CONFIRM_OCR_FIELDS);
});

test("assistant: the server's OCR_FIELDS_NOT_CONFIRMED sends the employee back to confirm", () => {
  const expense = ocr.confirmOcrFields(scanned(), ["expenseDate"]);
  const state = { ...flow.initialState(), step: flow.STEPS.SUBMITTING, expense, categoryConfirmed: true };
  const next = flow.reducer(state, { type: "OCR_FIELDS_REJECTED", fields: ["expenseDate"] });
  assert.equal(next.step, flow.STEPS.CONFIRM_OCR_FIELDS);
});

test("My Requests: the saved status is editable, labelled and tracked without inventing approval steps", async () => {
  const constants = await vite.ssrLoadModule("/src/config/constants.js");
  assert.ok(constants.EXPENSE_STATUSES.includes("Pending Workflow Setup"));
  assert.ok(constants.EDITABLE_STATUSES.includes("Pending Workflow Setup"));
  assert.ok(!constants.EDITABLE_STATUSES.includes("Submitted"));
  assert.ok(!constants.EDITABLE_STATUSES.includes("Pending Approval"));
  assert.match(flow.STATUS_LABELS["Pending Workflow Setup"], /not set up yet/);
  assert.deepEqual(flow.statusTimeline({ status: "Pending Workflow Setup", anomalyReport: { route: "manager_approval" } }), [
    { key: "Pending Workflow Setup", label: "Saved in My Requests · approval routing not set up yet", state: "current" },
  ]);
  const saved = normalizers.normalizeExpense({ id: SERVER_ID, status: "Pending Workflow Setup", merchant: "M", amount: 1 });
  assert.equal(saved.status, "Pending Workflow Setup", "status kept from the server");
});

test("approval routing flag comes only from the server session", async () => {
  const auth = await vite.ssrLoadModule("/src/services/authService.js");
  assert.equal(typeof auth.loadSession, "function");
  const source = await (await import("node:fs/promises")).readFile(new URL("../src/services/authService.js", import.meta.url), "utf8");
  assert.match(source, /approvalWorkflowEnabled: payload\?\.features\?\.approvalWorkflow === true/);
});

test("currency missing from the scan must be provided; it is sent uppercase and shown as provided", () => {
  const expense = { ...scanned(), currency: "PHP", originalOCR: { merchant: "M", expenseDate: "2026-03-25", amount: 335.5 } };
  const currency = ocr.ocrFieldState(expense, "currency");
  assert.equal(currency.reason, "not_read");
  assert.equal(currency.status, "needs_confirmation");
  const provided = ocr.confirmOcrFields(expense, ["currency"]);
  assert.equal(ocr.ocrFieldState(provided, "currency").status, "provided");
  assert.deepEqual(normalizers.toExpensePayload(provided).ocrConfirmations, { currency: "PHP" });
  assert.equal(ocr.ocrFieldState(scanned(), "currency"), undefined, "a scanned currency needs nothing");
});

test("10 MB upload limit with a clear message (matches the server)", async () => {
  const { config } = await vite.ssrLoadModule("/src/config/appConfig.js");
  const files = await vite.ssrLoadModule("/src/utils/receiptFile.js");
  assert.equal(config.maxFileSize, 10 * 1024 * 1024);
  const big = { name: "big.jpg", type: "image/jpeg", size: 10 * 1024 * 1024 + 1 };
  assert.throws(() => files.validateReceiptFile(big), /larger than 10 MB/);
  assert.doesNotThrow(() => files.validateReceiptFile({ name: "ok.jpg", type: "image/jpeg", size: 1024 }));
});

test("another employee's duplicate stays anonymous in the frontend", () => {
  const expense = normalizers.normalizeExpense({
    id: SERVER_ID,
    merchant: "M",
    amount: 1,
    possibleDuplicates: [{ id: "other-employee", otherEmployee: true, requestNumber: "RF-LEAK", merchant: "x" }],
  });
  assert.deepEqual(expense.possibleDuplicates, [{ id: "other-employee", otherEmployee: true }]);
});
