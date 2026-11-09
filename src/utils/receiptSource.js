// Where a receipt preview comes from, and what to say when it cannot be shown.

// A saved expense's scan entry has no browser link of its own (`job-<scan id>`,
// empty url): the stored original is fetched through the API with the session.
// A blob: link on that entry is only a leftover from this tab's upload and may
// already be revoked, so the server copy is used for it too. An unsaved scan has
// no server id yet and keeps showing its local preview.
export const isStoredScanFile = (file, expense) =>
  /^[a-f0-9]{24}$/i.test(String(expense?.id ?? "")) &&
  Boolean(expense?.receiptJobId) &&
  file?.id === `job-${expense.receiptJobId}` &&
  !/^https?:/i.test(file?.url || "");

/** The text (and whether retrying can help) for a failed GET /expenses/:id/receipt. */
export function describeReceiptLoadFailure(error) {
  if (error?.code === "RECEIPT_FILE_NOT_FOUND") {
    return {
      message:
        "The original receipt isn’t available for this request. Receipts scanned before ReceiptFlow began keeping files have only the file details and the scanned data.",
      canRetry: false,
    };
  }
  if (error?.status === 401) {
    return { message: "You’re signed out. Sign in, then try again.", canRetry: true };
  }
  if (error?.status === 403 || error?.status === 404) {
    return { message: "You don’t have access to this receipt, or it’s no longer available.", canRetry: false };
  }
  return { message: "The receipt couldn’t be loaded. Check your connection and try again.", canRetry: true };
}
