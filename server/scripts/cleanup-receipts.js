// Abandoned-receipt cleanup against a LOCAL throwaway MongoDB only (localOnly.js).
// Dry-run unless --apply.
//
//   cd server
//   MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/cleanup-receipts.js [--db receiptflow-local] [--days 7] [--apply]
import mongoose from "mongoose";
import { assertLocalMongo } from "./localOnly.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const uri = process.env.MONGODB_URI;
const dbName = arg("db", "receiptflow-local");
assertLocalMongo(uri, dbName);
await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 5000 });
const { cleanupAbandonedReceiptFiles } = await import("../src/services/receiptCleanup.js");
const summary = await cleanupAbandonedReceiptFiles({ olderThanDays: Number(arg("days", 7)), dryRun: !process.argv.includes("--apply") });
await mongoose.disconnect();
process.exitCode = summary.errors ? 1 : 0;
