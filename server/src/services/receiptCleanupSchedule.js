// Runs the abandoned-receipt cleanup on a timer when RECEIPT_CLEANUP_ENABLED=true
// (dry-run unless RECEIPT_CLEANUP_DRY_RUN=false). First run 10 minutes after
// start, then every RECEIPT_CLEANUP_INTERVAL_HOURS. Several server instances
// may run it: each scan is claimed atomically (receiptCleanup.js).
import { env } from "../config/env.js";
import { cleanupAbandonedReceiptFiles } from "./receiptCleanup.js";

let started = false;

export function startReceiptCleanupSchedule() {
  const { enabled, dryRun, abandonedDays, intervalHours } = env.receiptCleanup;
  if (!enabled || started) return;
  started = true;
  console.info(
    `[receipt-cleanup] scheduled every ${intervalHours} h for uploads abandoned over ${abandonedDays} day(s)${dryRun ? " (DRY RUN: nothing is deleted)" : ""}.`,
  );
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await cleanupAbandonedReceiptFiles({ olderThanDays: abandonedDays, dryRun });
    } catch (error) {
      console.error(`[receipt-cleanup] run failed: ${error.name}`);
    } finally {
      running = false;
    }
  };
  setTimeout(run, 10 * 60 * 1000).unref();
  setInterval(run, intervalHours * 60 * 60 * 1000).unref();
}
