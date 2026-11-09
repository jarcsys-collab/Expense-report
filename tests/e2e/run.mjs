// Browser test: npm run test:e2e
//
// Starts its own API (throwaway in-memory MongoDB, Google stubbed, no real credentials:
// server/scripts/local-e2e-server.js) and frontend on ports of their own, drives the real
// app in the installed Edge or Chrome, then stops them. Nothing leaves this machine.
//
//   E2E_BROWSER=msedge|chrome     choose the installed browser (default: Edge, then Chrome)
//   E2E_BROWSER_PATH=...          or give a browser's path
//
// Screenshots go to test-results/e2e (not committed).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RECEIPT = path.join(ROOT, "server/test/fixtures/synthetic-receipt.jpg");
const OUT = path.join(ROOT, "test-results/e2e");
// Not the usual development ports, so this can never talk to a server you started yourself.
const API_PORT = 3199;
const WEB_PORT = 5199;
const API = `http://localhost:${API_PORT}/api`;
const APP = `http://localhost:${WEB_PORT}/#`;
const MB = 1024 * 1024;

fs.mkdirSync(OUT, { recursive: true });
const results = [];
const errors = [];
const check = (name, ok, extra = "") => {
  results.push({ ok: Boolean(ok), name, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};
const shot = (page, name, options) => page.screenshot({ path: path.join(OUT, `${name}.png`), ...options });

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function launch() {
  const executablePath = process.env.E2E_BROWSER_PATH;
  if (executablePath) return chromium.launch({ executablePath, headless: true });
  const channels = process.env.E2E_BROWSER ? [process.env.E2E_BROWSER] : ["msedge", "chrome"];
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // Not installed: try the next.
    }
  }
  throw new Error("No browser found. Install Edge or Chrome, or set E2E_BROWSER_PATH.");
}

async function startApi(role) {
  const { LOCAL_MONGODB_URI, ...inherited } = process.env;
  const child = spawn(process.execPath, ["scripts/local-e2e-server.js"], {
    cwd: path.join(ROOT, "server"),
    env: { ...inherited, PORT: String(API_PORT), E2E_ROLE: role, E2E_FRONTEND_ORIGIN: `http://localhost:${WEB_PORT}` },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const session = await (await fetch(`${API}/auth/session`)).json();
      if (session.user?.role === role) return child;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill();
  throw new Error("The local API did not start.");
}

async function stopApi(child) {
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
  while (await portInUse(API_PORT)) await new Promise((resolve) => setTimeout(resolve, 200));
}

let browser;
async function open(viewport, extra = {}) {
  const context = await browser.newContext({ viewport, ...extra });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|Failed to load resource/.test(message.text())) errors.push(`console: ${message.text()}`);
  });
  return { context, page };
}
const PHONE = { hasTouch: true, isMobile: true };
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const apiCall = (page, method, route, body) =>
  page.evaluate(
    async ({ url, method, body }) => {
      const response = await fetch(url, { method, credentials: "include", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    },
    { url: `${API}${route}`, method, body },
  );
const countUploads = (page) => {
  const seen = { uploads: 0 };
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/receipts/upload")) seen.uploads += 1;
  });
  return seen;
};
const prepareDialog = (page) => page.getByRole("dialog", { name: /Check (your )?receipt/ });
const usage = async (page) => (await apiCall(page, "GET", "/management/ocr-analytics")).body.usage;

// A picture with a colored quadrant in each corner, so the output's orientation can be checked.
const quadrantImage = (page, width, height) =>
  page.evaluate(
    async ({ width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      for (const [color, x, y] of [["#ff0000", 0, 0], ["#00ff00", width / 2, 0], ["#0000ff", 0, height / 2], ["#ffff00", width / 2, height / 2]]) {
        context.fillStyle = color;
        context.fillRect(x, y, width / 2, height / 2);
      }
      return canvas.toDataURL("image/png").split(",")[1];
    },
    { width, height },
  );
// Noise does not compress: a realistic stand-in for the largest phone photos.
const noiseImage = (page, width, height) =>
  page.evaluate(
    async ({ width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      const image = context.createImageData(width, height);
      const chunk = new Uint32Array(16384);
      for (let start = 0; start < image.data.length; start += chunk.byteLength) {
        crypto.getRandomValues(chunk);
        image.data.set(new Uint8Array(chunk.buffer).subarray(0, Math.min(chunk.byteLength, image.data.length - start)), start);
      }
      for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
      context.putImageData(image, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = "";
      for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return btoa(text);
    },
    { width, height },
  );
// What the server stored for a scan: size, type, dimensions and the color in each corner.
const storedFile = (page, jobId) =>
  page.evaluate(
    async ({ url }) => {
      const response = await fetch(url, { credentials: "include" });
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const color = (x, y) => {
        const [r, g, b] = context.getImageData(x, y, 1, 1).data;
        return [r > 128, g > 128, b > 128].map(Number).join("");
      };
      const inset = 20;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return {
        size: blob.size,
        type: blob.type,
        width: bitmap.width,
        height: bitmap.height,
        sha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""),
        topLeft: color(inset, inset),
        topRight: color(bitmap.width - inset, inset),
        bottomLeft: color(inset, bitmap.height - inset),
        bottomRight: color(bitmap.width - inset, bitmap.height - inset),
      };
    },
    { url: `${API}/receipts/${jobId}/file` },
  );
const RED = "100";
const GREEN = "010";
const BLUE = "001";
const YELLOW = "110";

/** Chooses a file, runs `edit` in the preview, confirms, and returns the stored scan. */
async function scanThroughPreview(page, file, edit = async () => {}) {
  await page.goto(`${APP}/upload`);
  await page.reload();
  await page.getByRole("button", { name: /Choose Photo/ }).waitFor();
  await page.locator('input[type="file"]:not([capture])').first().setInputFiles(file);
  const dialog = prepareDialog(page);
  await dialog.waitFor();
  await page.locator(".prepare-frame canvas").waitFor();
  await edit(dialog);
  const response = page.waitForResponse((res) => res.request().method() === "POST" && res.url().includes("/receipts/upload"), { timeout: 60_000 });
  await dialog.getByRole("button", { name: "Scan receipt" }).click();
  const body = await (await response).json();
  await page.getByText(/SAMPLE COFFEE/).first().waitFor({ timeout: 30_000 });
  return { jobId: body.jobId, duplicateUpload: body.duplicateUpload, stored: await storedFile(page, body.jobId) };
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------
async function scannerTests() {
  const { page, context } = await open({ width: 390, height: 844 }, { ...PHONE, deviceScaleFactor: 2 });
  const seen = countUploads(page);
  await page.goto(`${APP}/upload`);
  await page.getByRole("button", { name: "Take Photo" }).waitFor();
  check("camera uses browser file capture, no camera permission", (await page.locator('input[capture="environment"]').count()) === 1);
  await page.locator('input[capture="environment"]').setInputFiles(RECEIPT);
  const dialog = prepareDialog(page);
  await dialog.waitFor();
  await page.locator(".prepare-frame canvas").waitFor();
  await page.waitForTimeout(400);
  check("OCR does not start when a photo is chosen", seen.uploads === 0, `uploads=${seen.uploads}`);
  const top = dialog.getByRole("slider", { name: "Crop: Top edge" });
  await top.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  check("crop works from the keyboard", (await top.getAttribute("aria-valuenow")) === "4");
  const left = dialog.getByRole("slider", { name: "Crop: Left edge" });
  const box = await left.boundingBox();
  const frame = await page.locator(".prepare-frame").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.12, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const dragged = Number(await left.getAttribute("aria-valuenow"));
  check("crop works by dragging", dragged >= 8 && dragged <= 16, `left=${dragged}%`);
  await dialog.getByLabel(/Enhance text/).check();
  await page.waitForTimeout(200);
  await shot(page, "phone-scanner-preview");
  check("preview fits the phone", (await overflow(page)) <= 0);
  const handle = await dialog.getByRole("slider", { name: "Crop: Bottom edge" }).boundingBox();
  check("crop handles have 44px touch targets", handle.height >= 44, `${handle.height}px`);
  // Cancel sends nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  check("cancelling the preview sends nothing", seen.uploads === 0);
  // Three synchronous taps on the button.
  await page.locator('input[capture="environment"]').setInputFiles(RECEIPT);
  await dialog.waitFor();
  await page.locator(".prepare-frame canvas").waitFor();
  await dialog.getByRole("button", { name: "Scan receipt" }).evaluate((button) => {
    button.click();
    button.click();
    button.click();
  });
  await page.getByText(/SAMPLE COFFEE/).first().waitFor({ timeout: 30_000 });
  check("double tap in the assistant uploads once", seen.uploads === 1, `uploads=${seen.uploads}`);
  await context.close();

  const desktop = await open({ width: 1280, height: 900 });
  const scanPage = desktop.page;
  await scanPage.goto(`${APP}/upload`);
  await scanPage.getByRole("button", { name: /Choose Photo/ }).waitFor();

  // Untouched file: stored byte for byte.
  const original = await scanThroughPreview(scanPage, RECEIPT);
  const expected = createHash("sha256").update(fs.readFileSync(RECEIPT)).digest("hex");
  check("an unedited small photo is uploaded byte for byte", original.stored.sha256 === expected);

  // Rotation: pixels end up where they should.
  const quadrant = { name: "quadrants.png", mimeType: "image/png", buffer: Buffer.from(await quadrantImage(scanPage, 1200, 800), "base64") };
  const rotated = await scanThroughPreview(scanPage, quadrant, async (dialog) => {
    await dialog.getByRole("button", { name: "Rotate" }).click();
  });
  check("rotate swaps width and height in the uploaded image", rotated.stored.width === 800 && rotated.stored.height === 1200, `${rotated.stored.width}x${rotated.stored.height}`);
  check(
    "rotate turns the image clockwise",
    rotated.stored.topLeft === BLUE && rotated.stored.topRight === RED && rotated.stored.bottomRight === GREEN && rotated.stored.bottomLeft === YELLOW,
    JSON.stringify(rotated.stored),
  );
  check("edited images are sent as JPEG", rotated.stored.type === "image/jpeg", rotated.stored.type);

  // Crop: only what is inside the frame is uploaded.
  const quadrant2 = { name: "quadrants2.png", mimeType: "image/png", buffer: Buffer.from(await quadrantImage(scanPage, 1000, 1000), "base64") };
  const cropped = await scanThroughPreview(scanPage, quadrant2, async (dialog) => {
    const slider = dialog.getByRole("slider", { name: "Crop: Top edge" });
    await slider.focus();
    for (let i = 0; i < 25; i += 1) await scanPage.keyboard.press("ArrowDown");
  });
  check("crop removes what is outside the frame", cropped.stored.width === 1000 && cropped.stored.height === 500, `${cropped.stored.width}x${cropped.stored.height}`);
  check("crop keeps the right part of the image", cropped.stored.topLeft === BLUE && cropped.stored.bottomRight === YELLOW, JSON.stringify(cropped.stored));

  // Rotate then crop: the frame stays on the same content.
  const quadrant3 = { name: "quadrants3.png", mimeType: "image/png", buffer: Buffer.from(await quadrantImage(scanPage, 1000, 800), "base64") };
  const both = await scanThroughPreview(scanPage, quadrant3, async (dialog) => {
    const slider = dialog.getByRole("slider", { name: "Crop: Top edge" });
    await slider.focus();
    for (let i = 0; i < 25; i += 1) await scanPage.keyboard.press("ArrowDown");
    await dialog.getByRole("button", { name: "Rotate" }).click();
  });
  check("crop follows a rotation", both.stored.width === 400 && both.stored.height === 1000 && both.stored.topLeft === BLUE && both.stored.bottomLeft === YELLOW, JSON.stringify(both.stored));

  // Compression: over the limit before, within it after, still large enough to read.
  const big = await noiseImage(scanPage, 3600, 2700);
  const oversized = { name: "huge.png", mimeType: "image/png", buffer: Buffer.from(big, "base64") };
  check("the test photo really is over 10 MB", oversized.buffer.length > 10 * MB, `${(oversized.buffer.length / MB).toFixed(1)} MB`);
  const compressed = await scanThroughPreview(scanPage, oversized);
  check("a photo over 10 MB is compressed under the limit", compressed.stored.size <= 10 * MB && compressed.stored.type === "image/jpeg", `${(compressed.stored.size / MB).toFixed(1)} MB`);
  check("compression keeps it readable (2800 px on the long side)", compressed.stored.width === 2800 && compressed.stored.height === 2100, `${compressed.stored.width}x${compressed.stored.height}`);

  // A PDF over the limit is refused before the preview.
  await scanPage.reload();
  await scanPage.getByRole("button", { name: /Choose Photo/ }).waitFor();
  const bigPdf = { name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.alloc(10 * MB + 1)]) };
  await scanPage.locator('input[type="file"]:not([capture])').first().setInputFiles(bigPdf);
  await scanPage.getByText(/larger than 10 MB/).first().waitFor();
  check("a PDF over 10 MB is refused with a clear message", (await prepareDialog(scanPage).count()) === 0);
  await scanPage.getByRole("button", { name: "Choose another receipt" }).click();

  // The server's own limit.
  const server413 = await scanPage.evaluate(async ({ url, size }) => {
    const form = new FormData();
    form.append("receipt", new Blob([new Uint8Array([0xff, 0xd8, 0xff]), new Uint8Array(size)], { type: "image/jpeg" }), "big.jpg");
    return (await fetch(url, { method: "POST", credentials: "include", body: form })).status;
  }, { url: `${API}/receipts/upload`, size: 10 * MB });
  check("the server still refuses over 10 MB", server413 === 413, String(server413));

  // HEIC.
  const heic = { name: "IMG_0001.HEIC", mimeType: "image/heic", buffer: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(64)]) };
  await scanPage.locator('input[type="file"]:not([capture])').first().setInputFiles(heic);
  const heicDialog = prepareDialog(scanPage);
  await heicDialog.waitFor();
  await heicDialog.getByText(/Most Compatible/).waitFor();
  check("HEIC is explained before upload and cannot be sent", await heicDialog.getByRole("button", { name: "Scan receipt" }).isDisabled());
  await heicDialog.getByRole("button", { name: "Cancel" }).click();

  // PDF, keyboard.
  await scanPage.locator('input[type="file"]:not([capture])').first().setInputFiles({ name: "receipt.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 synthetic") });
  await heicDialog.waitFor();
  await heicDialog.getByText("receipt.pdf").waitFor();
  check("a PDF is shown by name, without crop tools", (await heicDialog.getByRole("slider").count()) === 0);
  await scanPage.keyboard.press("Escape");
  await heicDialog.waitFor({ state: "hidden" });
  check("Escape closes the preview", true);

  // Batch page: one preview per file, double tap guarded, nothing before confirming.
  await scanPage.goto(`${APP}/upload/batch`);
  const batchSeen = countUploads(scanPage);
  const distinct = (label) => ({ name: `${label}.jpg`, mimeType: "image/jpeg", buffer: Buffer.concat([fs.readFileSync(RECEIPT), Buffer.from(label)]) });
  await scanPage.locator('input[type="file"]').first().setInputFiles([distinct("batch-a"), distinct("batch-b")]);
  const first = scanPage.getByRole("dialog", { name: "Check receipt 1 of 2" });
  await first.waitFor();
  check("batch: nothing is sent before confirming", batchSeen.uploads === 0);
  await first.getByRole("button", { name: "Scan receipt" }).evaluate((button) => {
    button.click();
    button.click();
  });
  const second = scanPage.getByRole("dialog", { name: "Check receipt 2 of 2" });
  await second.waitFor();
  await second.getByRole("button", { name: "Cancel" }).click();
  await second.waitFor({ state: "hidden" });
  await scanPage.getByText(/1 ready to review/).waitFor({ timeout: 30_000 });
  check("batch: double tap uploads once; a cancelled receipt is not sent", batchSeen.uploads === 1, `uploads=${batchSeen.uploads}`);
  await desktop.context.close();
}

// ---------------------------------------------------------------------------
// The whole flow through the assistant, then the notification
// ---------------------------------------------------------------------------
async function assistantFlow(page) {
  await page.goto(`${APP}/upload`);
  await page.reload();
  await page.getByRole("button", { name: /Choose Photo/ }).waitFor();
  await page.locator('input[type="file"]:not([capture])').first().setInputFiles(RECEIPT);
  await prepareDialog(page).getByRole("button", { name: "Scan receipt" }).click();
  await page.getByText(/SAMPLE COFFEE/).first().waitFor({ timeout: 30_000 });
  const composer = page.getByRole("region", { name: "Your reply" });
  const steps = [];
  for (let step = 0; step < 30; step += 1) {
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, { timeout: 30_000 });
    await page.waitForTimeout(150);
    if (await composer.getByRole("button", { name: "View Request" }).count()) return steps;
    const select = composer.locator(".composer-answer select");
    const input = composer.locator(".composer-answer input");
    if (await select.count()) {
      await select.selectOption({ index: 1 });
      steps.push("category");
      await composer.getByRole("button", { name: "Confirm category" }).click();
      continue;
    }
    if (await input.count()) {
      await input.fill("E2E answer");
      steps.push("answer");
      await composer.getByRole("button", { name: "Continue" }).click();
      continue;
    }
    let clicked = false;
    for (const name of ["Looks right, continue", /^Yes, th/, /\(day\/month\)/, "Continue", "Save to My Requests"]) {
      const button = composer.getByRole("button", { name });
      if (await button.count()) {
        steps.push(String(name));
        await button.first().click();
        clicked = true;
        break;
      }
    }
    if (!clicked) throw new Error(`The assistant is waiting for something unexpected: ${await composer.innerText()}`);
  }
  throw new Error(`The assistant did not finish: ${steps.join(" > ")}`);
}

async function notificationFlow() {
  const { page, context } = await open({ width: 1280, height: 900 });
  await page.goto(`${APP}/upload`);

  // No rules are created for you, on a database prepared by the normal start-up.
  await page.getByRole("link", { name: "Management", exact: true }).first().click();
  await page.getByText("No notification rules yet").waitFor();
  check("no default notification rules", (await apiCall(page, "GET", "/management/notification-rules")).body.rules.length === 0);
  await shot(page, "desktop-management-empty", { fullPage: false });

  await page.getByRole("button", { name: "New rule" }).click();
  const form = page.getByRole("dialog", { name: "New notification rule" });
  await form.waitFor();
  await form.getByLabel("Enabled").check();
  await form.getByRole("button", { name: "Save rule" }).click();
  await form.getByText("Enter a rule name.").waitFor();
  await form.getByText("Choose at least one anomaly type.").waitFor();
  await form.getByText("Add at least one recipient before enabling this rule.").waitFor();
  check("the form shows validation messages", true);
  check("the manager recipient is disabled", await form.getByRole("button", { name: /manager/i }).isDisabled());
  await form.getByText(/Requires configuration/).waitFor();
  check("the manager option says it requires configuration", true);
  check("email is shown as not connected", (await form.getByRole("option", { name: /Email/ }).first().innerText()).length > 0);
  await form.getByLabel("Rule name").fill("Corrected totals");
  await form.getByLabel("Rule name").blur();
  check("a fixed problem clears its message", (await form.getByText("Enter a rule name.").count()) === 0);
  await form.getByLabel("Description (optional)").fill("Tell people when a scanned total changes");
  await form.getByLabel("Total changed from the scanned receipt").check();
  await form.getByLabel("Add a specific person").fill("fay");
  await form.getByRole("button", { name: "Add Fay Finance" }).click();
  await form.getByRole("button", { name: "Add all Finance administrators" }).click();
  await form.getByRole("button", { name: "Remove Fay Finance" }).click();
  await form.getByLabel("Add a specific person").fill("bob");
  await form.getByRole("button", { name: "Add Bob Employee" }).click();
  await form.getByLabel("Add a specific person").fill("developer");
  await form.getByRole("button", { name: "Add Local Developer" }).click();
  check("recipients can be added and removed", (await form.getByRole("button", { name: /^Remove / }).count()) === 3);
  await form.getByRole("button", { name: "Save rule" }).click();
  await form.waitFor({ state: "hidden" });
  const ruleCell = page.getByRole("cell", { name: /^Corrected totals Tell/ });
  await ruleCell.waitFor();
  await page.getByText(/saved\./).first().waitFor();
  check("the rule is saved with a confirmation", true);
  await shot(page, "desktop-rules-table");

  await page.getByRole("searchbox", { name: "Search rules" }).fill("nothing like this");
  await page.getByText("No rules match").waitFor();
  await page.getByRole("searchbox", { name: "Search rules" }).fill("bob");
  await ruleCell.waitFor();
  check("search filters the table", true);
  await page.getByRole("searchbox", { name: "Search rules" }).fill("");

  await page.getByRole("button", { name: "Send a test of Corrected totals" }).click();
  await page.getByText(/Nothing was sent/).waitFor();
  check("a test uses the mock and says nothing was sent", true);
  await page.getByRole("link", { name: "Delivery history" }).click();
  await page.getByText("No notifications yet").waitFor();
  check("tests are not mixed with real notifications", true);
  await page.getByRole("button", { name: "Tests" }).click();
  await page.getByText(/Recorded \(mock\)/).first().waitFor();
  check("tests are recorded separately", true);

  // Through the assistant, as an employee would.
  const steps = await assistantFlow(page);
  check("the assistant takes a scan all the way to My Requests", true, steps.join(" > "));
  const { body: list } = await apiCall(page, "GET", "/expenses");
  const first = list.expenses[0];
  check("the request is saved; no approval routing", first?.status === "Pending Workflow Setup", first?.status);
  check("the unchanged scan raised no notification", (await apiCall(page, "GET", "/management/notification-events")).body.total === 0);

  // Same file, with the total changed: an anomaly the rule matches.
  const form2 = await page.evaluate(async ({ url, bytes }) => {
    const data = new FormData();
    data.append("receipt", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "r.jpg");
    return (await fetch(url, { method: "POST", credentials: "include", body: data })).json();
  }, { url: `${API}/receipts/upload`, bytes: [...fs.readFileSync(RECEIPT)] });
  const { status, jobId, id, ...extracted } = form2.expense;
  const created = await apiCall(page, "POST", "/expenses", {
    ...extracted,
    receiptJobId: form2.jobId,
    amount: 400,
    category: first.category,
    purpose: "E2E",
    location: "Makati",
    position: first.position,
    department: first.department,
    ocrConfirmations: { expenseDate: extracted.expenseDate, merchant: extracted.merchant },
    duplicateOverrideReason: "A separate test purchase",
  });
  check("an expense is saved from the scan", created.status === 201, `status=${created.status}`);
  check("no notification on save, for an on-submission rule", (await apiCall(page, "GET", "/management/notification-events")).body.total === 0);
  const saved = await apiCall(page, "POST", `/expenses/${created.body.id}/submit`, {});
  check("saved to My Requests; no approval routing", saved.body.status === "Pending Workflow Setup", saved.body.status);

  await page.waitForTimeout(800);
  let history = (await apiCall(page, "GET", "/management/notification-events")).body;
  const recipients = history.events.map((event) => event.recipientName).sort();
  check("the anomaly matched the rule, one notification per person", history.total === 3 && history.events.every((event) => event.anomalyType === "ocr_total_corrected"), recipients.join(", "));
  check("delivered in-app", history.events.every((event) => event.status === "delivered" && event.provider === "in_app"), history.events.map((event) => event.status).join(","));
  await apiCall(page, "PATCH", `/expenses/${created.body.id}`, { purpose: "E2E, edited" });
  await apiCall(page, "POST", `/expenses/${created.body.id}/submit`, {});
  await page.waitForTimeout(400);
  history = (await apiCall(page, "GET", "/management/notification-events")).body;
  check("saving again does not notify again", history.total === 3, `total=${history.total}`);

  await page.goto(`${APP}/notifications`);
  await page.getByText(/Expense check: Total changed/).first().waitFor();
  check("the recipient sees it in the inbox", true);
  check("the bell shows the unread count", (await page.getByRole("link", { name: /Notifications: \d+ unread/ }).count()) === 1);
  await shot(page, "desktop-inbox");
  await page.getByRole("link", { name: "Open request" }).first().click();
  await page.waitForURL(/requests\//);
  check("the link opens the request", true);

  await page.goto(`${APP}/review/${created.body.id}`);
  await page.getByText("Scanned receipt details").click();
  await page.getByText("Corrected", { exact: true }).first().waitFor();
  await page.getByText("VATable sales").waitFor();
  check("the review screen shows field statuses and VAT figures", true);

  // Edit and delete through the UI.
  await page.goto(`${APP}/management`);
  await page.getByRole("button", { name: "Edit Corrected totals" }).click();
  const editor = page.getByRole("dialog", { name: /^Edit rule/ });
  await editor.waitFor();
  await editor.getByRole("button", { name: "Remove Bob Employee" }).click();
  await editor.getByLabel("Enabled").uncheck();
  await editor.getByRole("button", { name: "Save rule" }).click();
  await editor.waitFor({ state: "hidden" });
  await page.locator(".management-table .badge", { hasText: "Disabled" }).first().waitFor();
  check("a rule can be edited and disabled", (await apiCall(page, "GET", "/management/notification-rules")).body.rules[0].recipients.length === 2);

  await page.getByRole("link", { name: "Delivery history" }).click();
  await page.locator(".management-table .badge", { hasText: "Delivered" }).first().waitFor();
  check("delivery history lists the notifications", true);
  await page.getByRole("link", { name: "Audit history" }).click();
  await page.getByText("Created rule").waitFor();
  await page.getByText("Changed rule").waitFor();
  await page.getByText("Sent a test").waitFor();
  await page.getByText(/enabled, recipients|recipients, enabled/).first().waitFor();
  check("the audit history says who changed what", (await page.getByRole("cell", { name: "Local Developer" }).count()) >= 3);
  await shot(page, "desktop-audit");

  await page.getByRole("link", { name: "Notification rules" }).click();
  await page.getByRole("button", { name: "Delete Corrected totals" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete rule" });
  await confirm.getByRole("button", { name: "Delete rule" }).click();
  await page.getByText("No notification rules yet").waitFor();
  check("a rule can be deleted", true);
  await page.getByRole("link", { name: "Audit history" }).click();
  await page.getByText("Deleted rule").waitFor();
  check("deletion is in the audit history", true);

  // The dashboard, against what really happened in this run.
  await page.goto(`${APP}/management/ocr`);
  await page.getByText("Total scans").waitFor();
  const report = (await apiCall(page, "GET", "/management/ocr-analytics")).body;
  const counted = report.usage.success + report.usage.failed + report.usage.duplicates + report.usage.skipped;
  check("scan counts add up", report.usage.total === counted, `total=${report.usage.total}`);
  check("estimated cost is USD 0.10 per successful one-page scan", Math.abs(report.cost.estimatedCostUsd - report.usage.success * 0.1) < 1e-6, `${report.cost.estimatedCostUsd} for ${report.usage.success}`);
  check("duplicates were caught", report.usage.duplicates >= 1, `duplicates=${report.usage.duplicates}`);
  check("the corrected total is measured", report.quality.fields.find((field) => field.field === "amount")?.corrected === 1);
  await page.getByText(/not Google Cloud billing data/).waitFor();
  check("costs are labelled as estimates", (await page.getByRole("heading", { name: "Estimated cost" }).count()) === 1);
  await shot(page, "desktop-analytics");
  await page.getByRole("button", { name: "Estimated cost" }).click();
  await page.getByText(/Estimated cost by day/).waitFor();
  check("the chart switches measure, one axis at a time", true);
  await page.getByText("Show as a table").click();
  await page.locator(".bucket-table").getByRole("cell", { name: /US.[0-9]/ }).first().waitFor();
  check("the chart has a table view", true);
  const bar = page.locator(".bucket-bar").first();
  await bar.focus();
  check("chart values can be reached by keyboard", await bar.locator(".bucket-tooltip").isVisible());
  await context.close();
}

// ---------------------------------------------------------------------------
// Existing pages and layout
// ---------------------------------------------------------------------------
async function layoutTests(prefix, routes, hasAnalytics) {
  // A rule to lay out (earlier steps may have deleted theirs).
  const setup = await open({ width: 1280, height: 900 });
  await setup.page.goto(`${APP}/upload`);
  const created = await apiCall(setup.page, "POST", "/management/notification-rules", { name: "Layout check", description: "Disabled, for the layout checks", enabled: false, anomalyTypes: ["ocr_total_corrected"] });
  check(`${prefix}: a rule for the layout checks`, created.status === 201, `status=${created.status}`);
  await setup.context.close();
  for (const [label, viewport, extra] of [
    ["android-360", { width: 360, height: 740 }, PHONE],
    ["iphone-390", { width: 390, height: 844 }, PHONE],
    ["tablet-768", { width: 768, height: 1024 }, { hasTouch: true }],
    ["laptop-1024", { width: 1024, height: 768 }, {}],
    ["desktop-1200", { width: 1200, height: 800 }, {}],
    ["desktop-1440", { width: 1440, height: 900 }, {}],
  ]) {
    const { page, context } = await open(viewport, extra);
    const wide = [];
    for (const route of routes) {
      await page.goto(`${APP}${route}`);
      await page.waitForTimeout(350);
      const extraWidth = await overflow(page);
      if (extraWidth > 0) wide.push(`${route} +${extraWidth}px`);
    }
    check(`${prefix} no sideways scrolling at ${label} on ${routes.length} pages`, wide.length === 0, wide.join(", "));
    if (hasAnalytics) {
      await page.goto(`${APP}/management/ocr`);
      await page.getByText("Total scans").waitFor();
      await page.waitForTimeout(200);
      await shot(page, `${label}-analytics`);
      if (viewport.width < 500) {
        const tall = await page.evaluate(() => document.documentElement.scrollHeight);
        check(`${label}: the dashboard is not thousands of stacked rows`, tall < 3600, `${tall}px`);
      } else if (viewport.width >= 1024) {
        await page.evaluate(() => window.scrollTo(0, 900));
        await page.waitForTimeout(200);
        const rail = await page.locator(".mobile-rail").boundingBox();
        check(`${label}: the sidebar keeps its width while scrolled`, rail.width < 300, `${rail.width}px`);
      }
    }
    await page.goto(`${APP}/management`);
    await page.getByRole("button", { name: "New rule" }).first().waitFor();
    await page.waitForTimeout(200);
    await shot(page, `${prefix}-${label}-rules`);

    // The rule's action buttons can be reached: not clipped, not behind the bottom bar.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(200);
    const action = await page.getByRole("button", { name: /^Delete / }).first().boundingBox();
    const wrap = await page.locator(".management-table-wrap").boundingBox();
    const phoneBar = extra.isMobile ? await page.locator(".mobile-rail").boundingBox() : null;
    check(
      `${prefix} ${label}: rule actions are not clipped or covered`,
      action.x + action.width <= wrap.x + wrap.width + 1 && (!phoneBar || action.y + action.height <= phoneBar.y),
      `action ends at x ${Math.round(action.x + action.width)}, y ${Math.round(action.y + action.height)}`,
    );

    if (extra.isMobile) {
      await page.getByRole("button", { name: "New rule" }).first().click();
      const dialog = page.getByRole("dialog", { name: "New notification rule" });
      await dialog.waitFor();
      await page.waitForTimeout(200);
      check(`${prefix} ${label}: the rule form fits`, (await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)) <= 0);
    }
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// As an ordinary employee
// ---------------------------------------------------------------------------
async function employeeTests() {
  const { page, context } = await open({ width: 1280, height: 900 });
  await page.goto(`${APP}/upload`);
  await page.getByRole("link", { name: "Management", exact: true }).first().click();
  await page.getByText("No notification rules yet").waitFor();
  check("an employee can open Management", true);
  check("an employee is not offered OCR analytics", (await page.getByRole("link", { name: "OCR analytics" }).count()) === 0);
  check("an employee is not offered Categories", (await page.getByRole("navigation", { name: "Management sections" }).getByRole("link", { name: "Categories" }).count()) === 0);
  check("the analytics API refuses an employee", (await apiCall(page, "GET", "/management/ocr-analytics")).status === 403);
  await page.goto(`${APP}/management/ocr`);
  await page.waitForURL(/#\/management$/);
  await page.getByRole("button", { name: "New rule" }).waitFor();
  check("the analytics address leads back to the rules", true);

  await page.getByRole("button", { name: "New rule" }).click();
  const form = page.getByRole("dialog", { name: "New notification rule" });
  await form.getByLabel("Rule name").fill("Duplicate claims");
  await form.getByLabel("Possible duplicate claim").check();
  await form.getByLabel("Add a specific person").fill("bob");
  await form.getByRole("button", { name: "Add Bob Employee" }).click();
  await form.getByLabel("Enabled").check();
  await form.getByRole("button", { name: "Save rule" }).click();
  await form.waitFor({ state: "hidden" });
  await page.locator(".management-table .badge", { hasText: "Enabled" }).first().waitFor();
  check("an employee can create and enable a rule", true);
  await page.getByRole("button", { name: "Edit Duplicate claims" }).click();
  const editor = page.getByRole("dialog", { name: /^Edit rule/ });
  await editor.getByLabel("Enabled").uncheck();
  await editor.getByRole("button", { name: "Save rule" }).click();
  await editor.waitFor({ state: "hidden" });
  check("an employee can edit and disable a rule", (await apiCall(page, "GET", "/management/notification-rules")).body.rules[0].enabled === false);
  await page.getByRole("button", { name: "Delete Duplicate claims" }).click();
  await page.getByRole("dialog", { name: "Delete rule" }).getByRole("button", { name: "Delete rule" }).click();
  await page.getByText("No notification rules yet").waitFor();
  check("an employee can delete a rule", true);
  await page.getByRole("link", { name: "Audit history" }).click();
  await page.getByText("Deleted rule").waitFor();
  await shot(page, "employee-audit");
  const audit = (await apiCall(page, "GET", "/management/audit")).body.entries;
  check("the audit trail names the employee", audit.length === 3 && audit.every((entry) => entry.actor.id === "dev-user" && entry.actor.role === "EMPLOYEE"), `${audit.length} entries`);
  await context.close();
  await layoutTests("employee", ["/management", "/management/delivery", "/management/audit", "/notifications", "/upload", "/requests"], false);
}

async function main() {
  for (const port of [API_PORT, WEB_PORT]) {
    if (await portInUse(port)) throw new Error(`Port ${port} is already in use. Stop whatever is using it and run again.`);
  }
  // Read by Vite before it loads .env.development.
  process.env.VITE_API_BASE_URL = API;
  process.env.VITE_RECEIPT_UPLOAD_ENABLED = "true";
  const vite = await createServer({ root: ROOT, logLevel: "error", server: { port: WEB_PORT, strictPort: true } });
  await vite.listen();
  browser = await launch();
  let api;
  try {
    console.log("\n--- Signed in as a Finance administrator ---");
    api = await startApi("FINANCE_ADMIN");
    await scannerTests();
    await notificationFlow();
    await layoutTests(
      "finance",
      ["/management", "/management/delivery", "/management/ocr", "/management/audit", "/notifications", "/upload", "/upload/batch", "/requests", "/violations", "/categories", "/approvals", "/settings", "/profile"],
      true,
    );
    await stopApi(api);

    console.log("\n--- Signed in as an ordinary employee ---");
    api = await startApi("EMPLOYEE");
    await employeeTests();
    check("no page or console errors", errors.length === 0, errors.slice(0, 5).join(" | "));
  } finally {
    await browser.close().catch(() => {});
    await vite.close().catch(() => {});
    if (api && api.exitCode === null) await stopApi(api);
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed. Screenshots: test-results/e2e`);
  for (const result of failed) console.log(`FAILED: ${result.name} ${result.extra}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
