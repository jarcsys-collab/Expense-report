// Removes the stored original of ABANDONED receipt uploads: scans older than
// the retention window that no expense uses (no draft, saved or submitted
// request) and that are not being processed. Files of any expense are never
// touched. The scan record (extracted data, audit) is kept; only its file goes,
// and the record notes when (fileDeletedAt).
//
// Safe to run repeatedly and on several servers at once:
//   - each scan is claimed atomically before anything is deleted, and only if
//     it still has its file and no linked expense
//   - expense references are checked again after the claim
//   - a file that is already gone counts as deleted (idempotent)
// Dry-run by default: it reports what it would delete.
import mongoose from "mongoose";
import { Expense } from "../models/Expense.js";
import { ReceiptJob } from "../models/ReceiptJob.js";

export const DEFAULT_ABANDONED_DAYS = 7;
const ACTIVE_STATUSES = ["queued", "processing", "pending"];
const CLAIM_TTL_MS = 60 * 60 * 1000; // a crashed run's claim expires after an hour
const BUCKET = "receiptFiles";

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
const isFileNotFound = (error) => /FileNotFound|file not found/i.test(`${error?.name} ${error?.message}`);

async function deleteStoredFile(fileId) {
  try {
    await bucket().delete(fileId);
    return "deleted";
  } catch (error) {
    if (isFileNotFound(error)) return "already_gone";
    throw error;
  }
}

/**
 * @param {{ olderThanDays?: number, dryRun?: boolean, now?: Date, limit?: number, log?: (line: string) => void }} [options]
 * @returns {Promise<object>} summary counts (and job ids, for the log)
 */
export async function cleanupAbandonedReceiptFiles({
  olderThanDays = DEFAULT_ABANDONED_DAYS,
  dryRun = true,
  now = new Date(),
  limit = 500,
  log = (line) => console.info(line),
} = {}) {
  const days = Math.max(1, Number(olderThanDays) || DEFAULT_ABANDONED_DAYS);
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const summary = {
    dryRun,
    cutoff: cutoff.toISOString(),
    candidates: 0,
    deleted: 0,
    wouldDelete: 0,
    skippedReferenced: 0,
    skippedClaimed: 0,
    sharedFileKept: 0,
    orphanFilesDeleted: 0,
    orphanFilesWouldDelete: 0,
    errors: 0,
    jobIds: [],
  };

  // 1. Scans with a stored file, old enough, not active, not linked to an expense.
  const candidates = await ReceiptJob.find({
    fileId: { $ne: null },
    createdAt: { $lt: cutoff },
    status: { $nin: ACTIVE_STATUSES },
    expenseId: null,
  })
    .select("_id fileId")
    .limit(limit)
    .lean();
  summary.candidates = candidates.length;

  for (const job of candidates) {
    try {
      if (await Expense.exists({ receiptJobId: job._id })) {
        summary.skippedReferenced += 1;
        continue;
      }
      // Another scan of the same account reuses this stored file: this abandoned scan
      // only lets go of it. The file stays until the last scan using it is cleaned up.
      if (await ReceiptJob.exists({ fileId: job.fileId, _id: { $ne: job._id } })) {
        summary.sharedFileKept += 1;
        if (!dryRun) await ReceiptJob.updateOne({ _id: job._id, fileId: job.fileId }, { $unset: { fileId: 1 } });
        continue;
      }
      if (dryRun) {
        summary.wouldDelete += 1;
        summary.jobIds.push(String(job._id));
        continue;
      }
      const claimed = await ReceiptJob.findOneAndUpdate(
        {
          _id: job._id,
          fileId: job.fileId,
          expenseId: null,
          status: { $nin: ACTIVE_STATUSES },
          $or: [{ cleanupClaimedAt: null }, { cleanupClaimedAt: { $lt: new Date(now.getTime() - CLAIM_TTL_MS) } }],
        },
        { $set: { cleanupClaimedAt: now } },
        { new: true },
      );
      if (!claimed) {
        summary.skippedClaimed += 1;
        continue;
      }
      // Linked while we were claiming? Release and keep the file.
      if (await Expense.exists({ receiptJobId: job._id })) {
        await ReceiptJob.updateOne({ _id: job._id }, { $unset: { cleanupClaimedAt: 1 } });
        summary.skippedReferenced += 1;
        continue;
      }
      await deleteStoredFile(job.fileId);
      await ReceiptJob.updateOne(
        { _id: job._id, fileId: job.fileId },
        { $unset: { fileId: 1, cleanupClaimedAt: 1 }, $set: { fileDeletedAt: now } },
      );
      summary.deleted += 1;
      summary.jobIds.push(String(job._id));
    } catch (error) {
      summary.errors += 1;
      log(`[receipt-cleanup] job ${job._id} failed: ${error.name}`);
    }
  }

  // 2. Stored files no scan points to (e.g. a scan record removed by hand).
  const oldFiles = await mongoose.connection.db
    .collection(`${BUCKET}.files`)
    .find({ uploadDate: { $lt: cutoff } }, { projection: { _id: 1 } })
    .limit(limit)
    .toArray();
  for (const file of oldFiles) {
    try {
      if (await ReceiptJob.exists({ fileId: file._id })) continue;
      if (dryRun) {
        summary.orphanFilesWouldDelete += 1;
        continue;
      }
      if ((await deleteStoredFile(file._id)) === "deleted") summary.orphanFilesDeleted += 1;
    } catch (error) {
      summary.errors += 1;
      log(`[receipt-cleanup] orphan file ${file._id} failed: ${error.name}`);
    }
  }

  log(
    `[receipt-cleanup] ${dryRun ? "DRY RUN " : ""}older than ${days} day(s) (before ${summary.cutoff}): ` +
      `${dryRun ? `would delete ${summary.wouldDelete}` : `deleted ${summary.deleted}`} file(s) of ${summary.candidates} abandoned scan(s); ` +
      `kept ${summary.skippedReferenced} linked to an expense; ${summary.skippedClaimed} handled by another run; ` +
      `orphan files ${dryRun ? `would delete ${summary.orphanFilesWouldDelete}` : `deleted ${summary.orphanFilesDeleted}`}; errors ${summary.errors}` +
      (summary.jobIds.length ? `; scans: ${summary.jobIds.slice(0, 50).join(", ")}` : ""),
  );
  return summary;
}
