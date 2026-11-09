// Browser test: npm run test:e2e:receipt
//
// The receipt preview in the real app, in the installed Edge or Chrome. No backend and no
// database: every API call is answered here from synthetic data, and any other network
// request is blocked, so nothing can reach production or the OCR provider.
//
// Screenshots go to test-results/receipt-preview (not committed).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "test-results/receipt-preview");
const JPG = fs.readFileSync(path.join(ROOT, "server/test/fixtures/synthetic-receipt.jpg"));
const PDF_TEXT = "BT /F1 18 Tf 20 100 Td (SYNTHETIC RECEIPT) Tj ET";
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
    `4 0 obj<</Length ${PDF_TEXT.length}>>stream\n${PDF_TEXT}\nendstream endobj\n` +
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n",
  "latin1",
);
const WEB_PORT = 5198;
const APP = `http://localhost:${WEB_PORT}/#`;
// .env.development's API address. Nothing listens there: page.route answers every call.
const API = "http://localhost:3000/api";
const USER = { id: "emp-1", name: "Sample Employee", role: "EMPLOYEE", provider: "beta", department: "Testing" };

fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, extra = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

const hex = (n) => n.toString(16).padStart(24, "0");
const expenseRecord = (n, name, mimeType, overrides = {}) => ({
  id: hex(100 + n),
  requestNumber: `RF-00000${n}`,
  status: "Draft",
  merchant: `Synthetic Merchant ${n}`,
  amount: 100 + n,
  currency: "PHP",
  expenseDate: "2026-11-01",
  category: "Meals",
  employeeId: USER.id,
  employeeName: USER.name,
  createdAt: "2026-11-01T00:00:00.000Z",
  receiptJobId: hex(200 + n),
  receiptFiles: [{ id: `job-${hex(200 + n)}`, name, mimeType, size: 1000, url: "", pageNumber: 1, uploadedAt: "2026-11-01T00:00:00.000Z" }],
  ...overrides,
});

function createMockApi() {
  const seeded = {
    image: expenseRecord(1, "image.jpg", "image/jpeg"),
    pdf: expenseRecord(2, "statement.pdf", "application/pdf"),
    older: expenseRecord(3, "older-scan.jpg", "image/jpeg"),
    flaky: expenseRecord(4, "flaky.jpg", "image/jpeg"),
    expired: expenseRecord(5, "expired-session.jpg", "image/jpeg"),
    refused: expenseRecord(6, "someone-elses.jpg", "image/jpeg"),
    manual: expenseRecord(7, "no-scan.jpg", "image/jpeg", {
      receiptJobId: undefined,
      receiptFiles: [{ id: "manual-1", name: "no-scan.jpg", mimeType: "image/jpeg", size: 1000, url: "", pageNumber: 1 }],
    }),
  };
  const state = { expenses: new Map(Object.values(seeded).map((e) => [e.id, e])), seeded, receiptRequests: [], uploads: 0, serverFailing: true };
  const receiptReply = (id) => {
    if (id === seeded.pdf.id) return { status: 200, type: "application/pdf", body: PDF };
    if (id === seeded.older.id) return { status: 404, json: { error: "RECEIPT_FILE_NOT_FOUND", message: "The original receipt file is not available for this request." } };
    if (id === seeded.expired.id) return { status: 401, json: { error: "UNAUTHENTICATED", message: "Sign in." } };
    if (id === seeded.refused.id) return { status: 404, json: { error: "EXPENSE_NOT_FOUND", message: "Expense not found." } };
    if (id === seeded.flaky.id && state.serverFailing) {
      return { status: 500, json: { error: "INTERNAL_ERROR", message: "Something went wrong. Please retry." } };
    }
    return { status: 200, type: "image/jpeg", body: JPG };
  };
  const reply = (method, route, body) => {
    if (route === "/auth/session") return { json: { user: USER, features: {} } };
    if (route === "/expenses" && method === "GET") return { json: { expenses: [...state.expenses.values()].reverse() } };
    if (route === "/receipts/upload" && method === "POST") {
      state.uploads += 1;
      return {
        status: 201,
        json: {
          jobId: hex(900),
          status: "ready",
          originalFileName: "image.jpg",
          mimeType: "image/jpeg",
          expense: { merchant: "Scanned Synthetic Cafe", amount: 250, currency: "PHP", expenseDate: "2026-11-02", receiptJobId: hex(900) },
        },
      };
    }
    if (route === "/expenses" && method === "POST") {
      // As the server does (linkReceiptJob): the file entry comes from the scan, with no link.
      const saved = {
        ...body,
        id: hex(901),
        requestNumber: "RF-000901",
        status: "Draft",
        employeeId: USER.id,
        employeeName: USER.name,
        createdAt: new Date().toISOString(),
        receiptFiles: [{ id: `job-${body.receiptJobId}`, name: "image.jpg", mimeType: "image/jpeg", size: JPG.length, url: "", pageNumber: 1 }],
      };
      state.expenses.set(saved.id, saved);
      return { status: 201, json: saved };
    }
    const receipt = route.match(/^\/expenses\/(\w+)\/receipt$/);
    if (receipt) {
      state.receiptRequests.push(receipt[1]);
      return receiptReply(receipt[1]);
    }
    const one = route.match(/^\/expenses\/(\w+)$/);
    if (one && state.expenses.has(one[1])) return { json: state.expenses.get(one[1]) };
    if (route === "/notifications/unread-count") return { json: { count: 0 } };
    if (route === "/categories") return { json: { categories: [{ id: "c1", name: "Meals", active: true }] } };
    if (route === "/violations") return { json: { violations: [] } };
    if (route === "/notifications") return { json: { notifications: [] } };
    if (route === "/policy") return { json: {} };
    if (route === "/policy/check") return { json: { findings: [] } };
    return { status: 404, json: { error: "NOT_FOUND", message: `No mock for ${method} ${route}` } };
  };
  return { state, reply };
}

async function launch() {
  for (const channel of process.env.E2E_BROWSER ? [process.env.E2E_BROWSER] : ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // Not installed: try the next.
    }
  }
  throw new Error("No browser found. Install Edge or Chrome.");
}

async function newSession(browser, mock, options) {
  const context = await browser.newContext(options);
  const blocked = [];
  const origin = `http://localhost:${WEB_PORT}`;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    if (url.startsWith(`${origin}/`) || /^(blob|data):/.test(url)) return route.continue();
    if (!url.startsWith(`${API}/`)) {
      blocked.push(url);
      return route.abort();
    }
    const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" };
    if (request.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: { ...cors, "access-control-allow-methods": "GET,POST,PATCH,DELETE", "access-control-allow-headers": "content-type,authorization" },
      });
    }
    const parsed = new URL(url);
    let body;
    try {
      body = request.postDataJSON();
    } catch {
      body = undefined;
    }
    const answer = mock.reply(request.method(), parsed.pathname.slice("/api".length), body);
    return route.fulfill(
      answer.json
        ? { status: answer.status ?? 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(answer.json) }
        : { status: answer.status ?? 200, headers: { ...cors, "content-type": answer.type }, body: answer.body },
    );
  });
  // Counts object URLs, so a preview left open or closed can be checked for leaks.
  await context.addInitScript(() => {
    const created = new Set();
    window.__objectUrls = created;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      created.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      created.delete(url);
      revoke(url);
    };
  });
  const page = await context.newPage();
  return { context, page, blocked };
}

const dialog = (page) => page.getByRole("dialog", { name: "Receipt preview" });
const rowLink = (page, name) => page.locator(".receipt-link", { hasText: name }).first();

async function openFromList(page, name) {
  await rowLink(page, name).scrollIntoViewIfNeeded();
  await rowLink(page, name).click();
  await dialog(page).waitFor();
}
async function imageShown(page) {
  const image = dialog(page).locator(".receipt-canvas img");
  await image.waitFor({ timeout: 10_000 });
  return image.evaluate(async (node) => {
    await node.decode().catch(() => {});
    return { width: node.naturalWidth, src: node.src };
  });
}
async function closePreview(page) {
  await dialog(page).getByRole("button", { name: /close/i }).first().click();
  await dialog(page).waitFor({ state: "hidden" });
}
const liveUrls = (page) => page.evaluate(() => window.__objectUrls.size);

async function run() {
  const mock = createMockApi();
  const { seeded } = mock.state;
  const browser = await launch();
  const vite = await createServer({ logLevel: "silent", server: { port: WEB_PORT, strictPort: true } });
  await vite.listen();
  try {
    // ---------- desktop: upload -> immediate preview -> OCR -> save -> list ----------
    const desktop = await newSession(browser, mock, { viewport: { width: 1360, height: 900 } });
    const { page } = desktop;
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${APP}/upload/batch`);
    await page.locator('input[type="file"]').first().setInputFiles({ name: "image.jpg", mimeType: "image/jpeg", buffer: JPG });
    await page.getByRole("dialog", { name: /Check (your )?receipt/ }).getByRole("button", { name: "Scan receipt" }).click();
    await page.getByRole("button", { name: "Review receipt" }).first().click({ timeout: 20_000 });
    const reviewImage = page.locator(".review-preview .receipt-canvas img");
    await reviewImage.waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector(".review-preview .receipt-canvas img")?.naturalWidth > 0);
    check("1. after upload and OCR the preview shows at once, from the local file", (await reviewImage.getAttribute("src")).startsWith("blob:") && mock.state.receiptRequests.length === 0);
    await page.getByRole("button", { name: "Save Draft" }).click();
    await page.waitForURL(new RegExp(`requests/${hex(901)}`), { timeout: 10_000 });
    await page.goto(`${APP}/requests`);
    await rowLink(page, "image.jpg").waitFor();

    const savedId = hex(901);
    const fetchedBefore = mock.state.receiptRequests.length;
    await openFromList(page, "image.jpg");
    const shown = await imageShown(page);
    await page.screenshot({ path: path.join(OUT, "desktop-image.png") });
    check("2. the saved receipt opens from My Requests (the reported screen)", shown.width > 0 && shown.src.startsWith("blob:"), `naturalWidth=${shown.width}`);
    // Not the upload's own preview, which is gone after a refresh or once revoked.
    check("2. opening it fetches that expense's file through the authenticated API", mock.state.receiptRequests.slice(fetchedBefore).includes(savedId));
    check("2. the reported message is gone", !(await dialog(page).getByText(/not stored/).count()));
    const whileOpen = await liveUrls(page);
    await closePreview(page);
    check("object URL is revoked when the preview closes", (await liveUrls(page)) === whileOpen - 1, `${whileOpen} -> ${await liveUrls(page)}`);

    // ---------- reload ----------
    await page.reload();
    await rowLink(page, "image.jpg").waitFor();
    await openFromList(page, "image.jpg");
    check("3. it still opens after refreshing the page", (await imageShown(page)).width > 0);
    await closePreview(page);

    // ---------- PDF ----------
    await openFromList(page, "statement.pdf");
    const pdf = dialog(page).locator(".receipt-canvas object");
    await pdf.waitFor();
    check("4. a stored PDF opens in the viewer", (await pdf.getAttribute("data")).startsWith("blob:") && (await pdf.getAttribute("type")) === "application/pdf");
    await page.screenshot({ path: path.join(OUT, "desktop-pdf.png") });
    await closePreview(page);

    // ---------- missing files and failed requests ----------
    await openFromList(page, "older-scan.jpg");
    await dialog(page).getByText(/isn’t available for this request/).waitFor();
    check("5. an older scan with no stored file explains that, with no retry and no fake image", !(await dialog(page).getByRole("button", { name: "Try again" }).count()) && !(await dialog(page).locator(".receipt-canvas img").count()));
    await page.screenshot({ path: path.join(OUT, "desktop-older.png") });
    await closePreview(page);

    await openFromList(page, "flaky.jpg");
    await dialog(page).getByText(/couldn’t be loaded/).waitFor();
    check("6. a server error is not reported as a missing file", !(await dialog(page).getByText(/not stored|isn’t available/).count()));
    mock.state.serverFailing = false;
    await dialog(page).getByRole("button", { name: "Try again" }).click();
    check("6. Try again loads the receipt", (await imageShown(page)).width > 0);
    await closePreview(page);

    await openFromList(page, "expired-session.jpg");
    await dialog(page).getByText(/signed out/i).waitFor();
    check("7. a 401 asks the employee to sign in", true);
    await closePreview(page);

    await openFromList(page, "someone-elses.jpg");
    await dialog(page).getByText(/don’t have access/).waitFor();
    check("8. a refused receipt shows no image and no retry", !(await dialog(page).locator(".receipt-canvas img").count()) && !(await dialog(page).getByRole("button", { name: "Try again" }).count()));
    await closePreview(page);

    const before = mock.state.receiptRequests.length;
    await openFromList(page, "no-scan.jpg");
    await dialog(page).getByText(/Original receipt not stored/).waitFor();
    check("9. a file entry with no scan says so, without calling the API", mock.state.receiptRequests.length === before);
    await closePreview(page);

    // ---------- request drawer ----------
    await page.goto(`${APP}/requests/${seeded.image.id}`);
    await page.getByRole("tab", { name: "Files" }).click();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    check("10. the request's Files tab previews the stored receipt", (await imageShown(page)).width > 0);
    await closePreview(page);
    check("no uncaught page errors on desktop", errors.length === 0, errors.join(" | "));
    check("no request left this machine (desktop)", desktop.blocked.length === 0, desktop.blocked.slice(0, 3).join(" "));
    await desktop.context.close();

    // ---------- a new sign-in: nothing from the earlier session survives ----------
    const again = await newSession(browser, mock, { viewport: { width: 1360, height: 900 } });
    await again.page.goto(`${APP}/requests`);
    await rowLink(again.page, "image.jpg").waitFor();
    await openFromList(again.page, "image.jpg");
    check("11. it still opens in a new session (signed out and back in)", (await imageShown(again.page)).width > 0);
    await again.context.close();

    // ---------- phone ----------
    const phone = await newSession(browser, mock, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    // The list's receipt column is hidden on phones: the request's Files tab is the way in.
    await phone.page.goto(`${APP}/requests/${seeded.image.id}`);
    await phone.page.getByRole("tab", { name: "Files" }).tap();
    await phone.page.getByRole("button", { name: "Preview", exact: true }).tap();
    const mobileImage = await imageShown(phone.page);
    const layout = await dialog(phone.page).evaluate((node) => {
      const box = node.getBoundingClientRect();
      const canvas = node.querySelector(".receipt-canvas").getBoundingClientRect();
      return { left: box.left, right: box.right, canvasHeight: canvas.height, width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    await phone.page.screenshot({ path: path.join(OUT, "phone-image.png") });
    check("12. phone: the stored image shows", mobileImage.width > 0, `naturalWidth=${mobileImage.width}`);
    check("12. phone: the preview fits the screen with no sideways page scroll", layout.left >= 0 && layout.right <= layout.width && layout.overflow <= 0 && layout.canvasHeight > 200, JSON.stringify(layout));
    await closePreview(phone.page);
    await phone.page.goto(`${APP}/requests/${seeded.pdf.id}`);
    await phone.page.getByRole("tab", { name: "Files" }).tap();
    await phone.page.getByRole("button", { name: "Preview", exact: true }).tap();
    const mobilePdf = dialog(phone.page).locator(".receipt-canvas object");
    await mobilePdf.waitFor();
    check("13. phone: a stored PDF has the viewer, with Open and Download as the way out", (await mobilePdf.getAttribute("data")).startsWith("blob:") && (await dialog(phone.page).getByRole("button", { name: "Open original" }).isVisible()) && (await dialog(phone.page).getByRole("button", { name: "Download receipt" }).isVisible()));
    await phone.page.screenshot({ path: path.join(OUT, "phone-pdf.png") });
    check("no request left this machine (phone)", phone.blocked.length === 0, phone.blocked.slice(0, 3).join(" "));
    await phone.context.close();

    // ---------- a phone browser that cannot show a PDF inside a page ----------
    const noViewer = await newSession(browser, mock, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await noViewer.context.addInitScript(() => Object.defineProperty(navigator, "pdfViewerEnabled", { get: () => false }));
    await noViewer.page.goto(`${APP}/requests/${seeded.pdf.id}`);
    await noViewer.page.getByRole("tab", { name: "Files" }).tap();
    await noViewer.page.getByRole("button", { name: "Preview", exact: true }).tap();
    await dialog(noViewer.page).getByRole("button", { name: "Open PDF" }).waitFor();
    check("13. no inline PDF viewer: a clear Open PDF action, not a blank box", !(await dialog(noViewer.page).locator(".receipt-canvas object").count()));
    await noViewer.page.screenshot({ path: path.join(OUT, "phone-pdf-no-viewer.png") });
    await noViewer.context.close();
    check("14. no upload beyond the one scan, and no duplicate from previewing", mock.state.uploads === 1, `uploads=${mock.state.uploads}`);
  } finally {
    await browser.close();
    await vite.close();
  }
}

try {
  await run();
} catch (error) {
  results.push(false);
  console.error(`FAIL  the run stopped: ${error.message}`);
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
