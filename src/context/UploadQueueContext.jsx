import { createContext, useEffect, useRef, useState } from "react";
import { config } from "../config/appConfig";
import { useWorkspace } from "../hooks/useWorkspace";
import { api } from "../services/api";
import { isAbortError } from "../services/httpClient";
import { waitForOcr } from "../services/receiptService";
import { createId, nowIso, sanitizeFileName } from "../utils/format";
import { validateReceiptFile } from "../utils/receiptFile";

export const UploadQueueContext = createContext(null);
export function UploadQueueProvider({ children }) {
  const { notify, user } = useWorkspace();
  const [queue, setQueue] = useState([]);
  const controllers = useRef(new Map());
  const activeIds = useRef(new Set());
  const objectUrls = useRef(new Set());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    setQueue([]);
    return () => {
      mounted.current = false;
      controllers.current.forEach((item) => item.abort());
      controllers.current.clear();
      activeIds.current.clear();
      objectUrls.current.forEach((item) => URL.revokeObjectURL(item));
      objectUrls.current.clear();
    };
  }, [user.id]);
  function updateItem(id, patch) {
    if (mounted.current && activeIds.current.has(id)) {
      setQueue((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                ...patch,
              }
            : item,
        ),
      );
    }
  }
  async function processItem(item) {
    if (controllers.current.has(item.id) || !activeIds.current.has(item.id)) {
      return;
    }
    if (!navigator.onLine) {
      updateItem(item.id, {
        status: "Failed",
        error: "You’re offline. Reconnect and retry; files remain in this tab.",
      });
      return;
    }
    const controller = new AbortController();
    controllers.current.set(item.id, controller);
    const options = {
      signal: controller.signal,
      receiptId: item.id,
      files: item.previews,
      onProgress: (message, progress) =>
        updateItem(item.id, {
          status: "Processing",
          message,
          progress,
        }),
    };
    try {
      updateItem(item.id, {
        status: item.jobId ? "Processing" : "Uploading",
        message: item.jobId
          ? "Checking existing OCR job…"
          : "Uploading receipt…",
        progress: 0,
        error: undefined,
      });
      const initial = item.jobId
        ? await api.getOCRStatus(item.jobId, options)
        : await api.uploadReceipt(item.files, options);
      if (controller.signal.aborted) {
        return;
      }
      updateItem(item.id, {
        jobId: initial.jobId || undefined,
      });
      const result = await waitForOcr(initial, {
        signal: controller.signal,
        interval: config.pollInterval,
        poll: (jobId, signal) =>
          api.getOCRStatus(jobId, {
            ...options,
            signal,
          }),
        onStatus: (status) =>
          updateItem(item.id, {
            status: "Processing",
            message: status.message || "Reading receipt…",
            progress: 0,
          }),
      });
      if (controller.signal.aborted) {
        return;
      }
      const expense = result.expense;
      expense.originalOCR ??
        (expense.originalOCR = {
          merchant: expense.merchant,
          amount: expense.amount,
          expenseDate: expense.expenseDate,
          receiptNumber: expense.receiptNumber,
          subtotal: expense.subtotal,
          tax: expense.tax,
        });
      updateItem(item.id, {
        status: result.status === "ready" ? "Ready" : "Needs Review",
        message: "Receipt ready for review",
        progress: 100,
        expense,
      });
      notify("Receipt ready for review.");
    } catch (error) {
      if (!isAbortError(error)) {
        updateItem(item.id, {
          status: "Failed",
          message: undefined,
          error: error instanceof Error ? error.message : "Upload failed.",
        });
      }
    } finally {
      controllers.current.delete(item.id);
    }
  }
  async function addFiles(files, asSingleReceipt = false) {
    const accepted = [];
    for (const file of files)
      try {
        validateReceiptFile(file);
        accepted.push(file);
      } catch (error) {
        notify(error.message, true);
      }
    if (!accepted.length) {
      return;
    }
    const items = (
      asSingleReceipt ? [accepted] : accepted.map((item) => [item])
    ).map((item) => {
      const id = createId();
      activeIds.current.add(id);
      return {
        id,
        files: item,
        status: "Queued",
        progress: 0,
        previews: item.map((item, index) => {
          const url = URL.createObjectURL(item);
          objectUrls.current.add(url);
          return {
            id: `${id}-${index + 1}`,
            name: sanitizeFileName(item.name),
            mimeType: item.type,
            size: item.size,
            url,
            pageNumber: index + 1,
            uploadedAt: nowIso(),
          };
        }),
      };
    });
    setQueue((current) => [...current, ...items]);
    for (const item of items) {
      if (!mounted.current) {
        return;
      }
      await processItem(item);
    }
  }
  function removeItem(id) {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    activeIds.current.delete(id);
    setQueue((current) => current.filter((item) => item.id !== id));
  }
  return (
    <UploadQueueContext.Provider
      value={{
        queue,
        process: processItem,
        add: addFiles,
        complete: removeItem,
        remove: removeItem,
      }}
    >
      {children}
    </UploadQueueContext.Provider>
  );
}
