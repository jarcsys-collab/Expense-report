import { config } from "../config/appConfig";
import { EXPENSE_STATUSES } from "../config/constants";
import { createId, nowIso, sanitizeFileName } from "../utils/format";
import { asObject, toConfidence, toNumber, toText } from "../utils/values";

export function unwrapResponse(response) {
  let current = response;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (Array.isArray(current)) {
      if (current.length !== 1) {
        throw new Error(
          "Invalid server response: expected one receipt result.",
        );
      }
      current = current[0];
      continue;
    }
    const object = asObject(current);
    if (!Object.keys(object).length) {
      throw new Error("Invalid server response: expected a JSON object.");
    }
    const wrapperKey = ["json", "data", "result"].find(
      (item) => object[item] !== undefined && typeof object[item] == "object",
    );
    if (wrapperKey) {
      current = {
        ...object,
        ...asObject(
          Array.isArray(object[wrapperKey]) && object[wrapperKey].length === 1
            ? object[wrapperKey][0]
            : object[wrapperKey],
        ),
      };
      delete current[wrapperKey];
      continue;
    }
    return object;
  }
  throw new Error("Invalid server response: nested response is too deep.");
}
export const FIELD_ALIASES = {
  merchant: [
    "merchant",
    "merchantName",
    "merchant_name",
    "vendor",
    "vendorName",
  ],
  merchantAddress: ["merchantAddress", "merchant_address", "address"],
  receiptNumber: [
    "receiptNumber",
    "receipt_number",
    "receiptNo",
    "invoiceNumber",
  ],
  expenseDate: ["expenseDate", "receiptDate", "receipt_date", "date"],
  expenseTime: ["expenseTime", "receiptTime", "receipt_time", "time"],
  currency: ["currency", "currencyCode"],
  subtotal: ["subtotal", "subTotal", "sub_total"],
  tax: ["tax", "taxAmount", "vat"],
  serviceCharge: ["serviceCharge", "service_charge"],
  tip: ["tip", "gratuity"],
  discount: ["discount", "discountAmount"],
  amount: ["amount", "total", "totalAmount", "total_amount"],
  paymentMethod: ["paymentMethod", "payment_method"],
  cardLastFour: ["cardLastFour", "card_last_four", "lastFour"],
  category: ["category"],
  purpose: ["purpose", "businessPurpose"],
  location: ["location"],
  employeeId: ["employeeId", "employee_id"],
  employeeName: ["employeeName", "expenseOwner", "employee_name", "owner"],
  department: ["department"],
  costCenter: ["costCenter", "cost_center"],
  project: ["project", "projectCode"],
  notes: ["notes"],
  position: ["position", "role"],
  assignedApproverId: ["assignedApproverId"],
};
export function findField(source, field) {
  for (const alias of FIELD_ALIASES[field] || [field])
    if (source[alias] !== undefined) {
      return {
        key: alias,
        raw: source[alias],
      };
    }
  return {
    key: field,
    raw: undefined,
  };
}
export function toIsoDate(value) {
  const text = toText(value);
  if (!text) {
    return "";
  }
  const date = new Date(text.length === 10 ? text + "T12:00:00Z" : text);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}
export function normalizeFile(file, index = 0) {
  const source = asObject(file);
  const rawUrl = toText(source.url ?? source.signedUrl ?? source.downloadUrl);
  let url = "";
  if (rawUrl) {
    try {
      const parsed = new URL(
        rawUrl,
        config.apiBase
          ? new URL(
              config.apiBase + "/",
              globalThis.location?.href || "https://receiptflow.invalid/",
            ).href
          : globalThis.location?.href || "https://receiptflow.invalid/",
      );
      if (
        !["http:", "https:", "blob:", "data:"].includes(parsed.protocol) ||
        (parsed.protocol === "data:" &&
          !/^data:(image\/|application\/pdf)/i.test(rawUrl))
      ) {
        throw new Error();
      }
      url = parsed.href;
    } catch {
      throw new Error("Invalid receipt URL in server response.");
    }
  }
  return {
    id: toText(source.id ?? source.fileId, createId()),
    name: sanitizeFileName(
      toText(source.name ?? source.filename, `receipt-${index + 1}`),
    ),
    mimeType: toText(
      source.mimeType ?? source.mime_type ?? source.type,
      "application/octet-stream",
    ),
    size: toNumber(source.size),
    url,
    thumbnailUrl: undefined,
    pageNumber: toNumber(source.pageNumber, index + 1),
    uploadedAt: toText(source.uploadedAt, nowIso()),
  };
}
export function normalizeComment(comment) {
  const source = asObject(comment);
  return {
    id: toText(source.id, createId()),
    userId: toText(source.userId),
    userName: toText(source.userName, "Team member"),
    role: toText(source.role),
    message: toText(source.message ?? source.comment),
    createdAt: toText(source.createdAt, nowIso()),
    replies: Array.isArray(source.replies)
      ? source.replies.map(normalizeComment)
      : [],
  };
}
export function normalizeViolation(violation) {
  const source = asObject(violation);
  const severity = toText(source.severity).toLowerCase();
  return {
    id: toText(source.id ?? source.ruleId, createId()),
    type: toText(source.type ?? source.name, "Policy review"),
    severity:
      severity === "high risk" || severity === "high"
        ? "High Risk"
        : severity === "informational" || severity === "info"
          ? "Informational"
          : "Warning",
    message: toText(
      source.message ?? source.reason,
      "Review this policy flag.",
    ),
    status:
      toText(source.status).toLowerCase() === "resolved" ? "Resolved" : "Open",
    createdAt: toText(source.createdAt, nowIso()),
    resolutionReason: toText(source.resolutionReason) || undefined,
  };
}
export function normalizeLineItem(item) {
  const source = asObject(item);
  const fields = {
    description: source.description ?? source.name,
    quantity: source.quantity ?? source.qty,
    unitPrice: source.unitPrice ?? source.unit_price ?? source.price,
    total: source.total ?? source.totalPrice ?? source.total_price,
  };
  const fieldConfidence = {};
  for (const [field, value] of Object.entries(fields)) {
    const confidence = toConfidence(
      asObject(value).confidence ?? asObject(source.fieldConfidence)[field],
    );
    if (confidence !== undefined) {
      fieldConfidence[field] = confidence;
    }
  }
  const quantity = toNumber(fields.quantity, 1);
  const unitPrice = toNumber(fields.unitPrice);
  return {
    id: toText(source.id, createId()),
    description: toText(fields.description),
    quantity,
    unitPrice,
    total: toNumber(fields.total, Math.round(quantity * unitPrice * 100) / 100),
    confidence: toConfidence(source.confidence),
    fieldConfidence,
  };
}
export function flattenExpensePayload(payload) {
  let result = {
    ...payload,
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const nestedKey = ["expense", "receipt", "ocr", "fields"].find(
      (item) => Object.keys(asObject(result[item])).length > 0,
    );
    if (!nestedKey) {
      break;
    }
    const nested = asObject(result[nestedKey]);
    delete result[nestedKey];
    result = {
      ...result,
      ...nested,
    };
  }
  return result;
}
export function normalizeExpense(response, options = {}) {
  const payload = unwrapResponse(response);
  const source = flattenExpensePayload(payload);
  const fallback = options.fallback || {};
  const confidence = {
    ...fallback.ocrConfidence,
  };
  const fields = {};
  for (const field of Object.keys(FIELD_ALIASES)) {
    const found = findField(source, field);
    const raw = found.raw;
    const fieldConfidence = toConfidence(
      asObject(raw).confidence ??
        asObject(source.ocrConfidence ?? source.confidence)[found.key] ??
        asObject(source.ocrConfidence ?? source.confidence)[field],
    );
    if (fieldConfidence !== undefined) {
      confidence[field] = fieldConfidence;
    }
    const fallbackValue = fallback[field];
    if (
      [
        "subtotal",
        "tax",
        "serviceCharge",
        "tip",
        "discount",
        "amount",
      ].includes(field)
    ) {
      fields[field] = toNumber(
        raw,
        typeof fallbackValue == "number" ? fallbackValue : 0,
      );
    } else {
      fields[field] = toText(
        raw,
        typeof fallbackValue == "string" ? fallbackValue : "",
      );
    }
  }
  if (!fields.merchant && asObject(source.merchant).name) {
    fields.merchant = toText(asObject(source.merchant).name);
  }
  if (!fields.merchantAddress && asObject(source.merchant).address) {
    fields.merchantAddress = toText(asObject(source.merchant).address);
  }
  fields.expenseDate = toIsoDate(fields.expenseDate);
  let currency = String(fields.currency).toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    currency = config.defaultCurrency;
    confidence.currency = 0;
  }
  fields.currency = currency || config.defaultCurrency;
  for (const field of ["merchant", "amount", "expenseDate"]) {
    if (findField(source, field).raw === undefined && !fallback[field]) {
      confidence[field] = 0;
    }
  }
  const id = toText(source.id ?? source.expenseId);
  if (options.saved && !id) {
    throw new Error(
      "Invalid server response: saved expense is missing its id.",
    );
  }
  const rawFiles = source.receiptFiles ?? source.files;
  let receiptFiles = Array.isArray(rawFiles)
    ? rawFiles.map((rawFile, index) => {
        const normalized = normalizeFile(rawFile);
        const previous =
          options.files?.[index] || fallback.receiptFiles?.[index];
        return {
          ...normalized,
          url: normalized.url || previous?.url || "",
        };
      })
    : options.files || fallback.receiptFiles || [];
  if (!receiptFiles.length && options.files?.length) {
    receiptFiles = options.files;
  }
  const rawStatus = toText(source.status ?? source.approvalStatus);
  if (
    options.saved &&
    !EXPENSE_STATUSES.some(
      (status) =>
        status.toLowerCase().replaceAll(" ", "_") ===
        rawStatus.toLowerCase().replaceAll(" ", "_"),
    )
  ) {
    throw new Error(
      "Invalid server response: saved expense must include a valid status.",
    );
  }
  const status =
    EXPENSE_STATUSES.find(
      (status) =>
        status.toLowerCase().replaceAll(" ", "_") ===
        rawStatus.toLowerCase().replaceAll(" ", "_"),
    ) ||
    fallback.status ||
    "Needs Review";
  const rawLineItems = source.lineItems ?? source.line_items ?? source.items;
  const rawViolations = source.policyViolations ?? source.warnings;
  const expense = {
    ...fallback,
    ...fields,
    id: id || createId(),
    receiptId: toText(
      source.receiptId,
      options.receiptId || fallback.receiptId,
    ),
    requestNumber: toText(
      source.requestNumber,
      id ? `RF-${id}` : "Unsubmitted receipt",
    ),
    employeeId: String(fields.employeeId || options.user?.id || ""),
    employeeName: String(fields.employeeName || options.user?.name || ""),
    department: String(fields.department || options.user?.department || ""),
    position: String(fields.position || options.user?.position || ""),
    // Owner identity set by the server from the signed-in account. A verified
    // Microsoft identity cannot be edited in the form.
    ...ownerIdentity(source, fallback, fields, options.user),
    receiptFiles,
    lineItems: Array.isArray(rawLineItems)
      ? rawLineItems.map(normalizeLineItem)
      : fallback.lineItems || [],
    ocrStatus: toText(source.ocrStatus, "ready"),
    ocrConfidence: confidence,
    approvalStatus: status,
    status,
    comments: Array.isArray(source.comments)
      ? source.comments.map(normalizeComment)
      : fallback.comments || [],
    policyViolations: Array.isArray(rawViolations)
      ? rawViolations.map(normalizeViolation)
      : fallback.policyViolations || [],
    activityLog: Array.isArray(source.activityLog)
      ? source.activityLog.map((entry2) => {
          const entry = asObject(entry2);
          return {
            id: toText(entry.id, createId()),
            actor: toText(entry.actor, "Team member"),
            action: toText(entry.action),
            createdAt: toText(entry.createdAt, nowIso()),
          };
        })
      : fallback.activityLog || [],
    createdAt: toText(source.createdAt, fallback.createdAt || nowIso()),
    updatedAt: toText(source.updatedAt, fallback.updatedAt || nowIso()),
  };
  for (const field of [
    "submittedAt",
    "approvedAt",
    "approvedBy",
    "rejectedAt",
    "rejectedBy",
    "rejectionReason",
    "duplicateOverrideReason",
  ]) {
    if (source[field] !== undefined) {
      expense[field] = toText(source[field]);
    }
  }
  const rawDuplicates = source.possibleDuplicates ?? source.duplicates;
  if (Array.isArray(rawDuplicates)) {
    expense.possibleDuplicates = rawDuplicates.map((rawDuplicate) => {
      const duplicate = asObject(rawDuplicate);
      return {
        id: toText(duplicate.id ?? duplicate.expenseId),
        merchant: toText(duplicate.merchant ?? duplicate.merchantName),
        amount: toNumber(duplicate.amount ?? duplicate.total),
        currency: toText(duplicate.currency, expense.currency),
        expenseDate: toIsoDate(duplicate.expenseDate ?? duplicate.date),
        receiptNumber: toText(duplicate.receiptNumber),
        requestNumber: toText(duplicate.requestNumber),
      };
    });
  }
  const rawTransactionMatch = asObject(source.transactionMatch);
  if (Object.keys(rawTransactionMatch).length) {
    expense.transactionMatch = {
      id: toText(rawTransactionMatch.id),
      merchant: toText(rawTransactionMatch.merchant),
      amount: toNumber(rawTransactionMatch.amount),
      date: toIsoDate(rawTransactionMatch.date),
      confidence: toConfidence(rawTransactionMatch.confidence) || 0,
      status: ["Matched", "Dismissed"].includes(
        toText(rawTransactionMatch.status),
      )
        ? toText(rawTransactionMatch.status)
        : "Suggested",
    };
  }
  const originalOcr = asObject(source.originalOCR);
  expense.originalOCR = Object.keys(originalOcr).length
    ? Object.fromEntries(
        Object.entries(originalOcr).filter(
          ([, value]) => typeof value == "string" || typeof value == "number",
        ),
      )
    : fallback.originalOCR;
  // Receipt scan link, anomaly check and review notes from the backend.
  const receiptJobId = toText(source.receiptJobId, fallback.receiptJobId || "");
  if (receiptJobId) expense.receiptJobId = receiptJobId;
  const anomalyReport = asObject(source.anomalyReport);
  if (Object.keys(anomalyReport).length) expense.anomalyReport = anomalyReport;
  // Printed receipt date, its possible readings and the employee's confirmation.
  const dateReview = asObject(source.dateReview);
  if (Object.keys(dateReview).length) expense.dateReview = dateReview;
  if (Array.isArray(source.extractionNotes)) {
    expense.extractionNotes = source.extractionNotes
      .map((note) => toText(note))
      .filter(Boolean);
  }
  const ocrText = toText(source.ocrText);
  if (ocrText) expense.ocrText = ocrText;
  return expense;
}
export function normalizeOcrResult(response, options = {}) {
  const payload = unwrapResponse(response);
  const status = toText(payload.status).toLowerCase().replaceAll(" ", "_");
  const jobId = toText(payload.jobId ?? payload.job_id);
  if (["failed", "error"].includes(status) || payload.success === false) {
    return {
      jobId,
      status: "failed",
      error: toText(payload.error ?? payload.message, "OCR processing failed."),
    };
  }
  if (["processing", "queued", "pending", "uploading"].includes(status)) {
    if (!jobId) {
      throw new Error(
        "Invalid OCR response: a processing job must include jobId.",
      );
    }
    return {
      jobId,
      status: "processing",
      receiptId: toText(payload.receiptId, options.receiptId),
      message: toText(payload.message ?? payload.stage) || undefined,
    };
  }
  const source = flattenExpensePayload(payload);
  if (
    !["merchant", "amount", "receiptNumber", "expenseDate"].some(
      (item) => findField(source, item).raw !== undefined,
    ) &&
    !Array.isArray(source.lineItems ?? source.line_items ?? source.items)
  ) {
    throw new Error(
      "Invalid OCR response: no extracted receipt fields were returned.",
    );
  }
  const expense = normalizeExpense(payload, options);
  expense.status = "Needs Review";
  expense.approvalStatus = "Needs Review";
  expense.ocrStatus = status === "needs_review" ? "needs_review" : "ready";
  expense.originalOCR ??
    (expense.originalOCR = Object.fromEntries(
      Object.keys(FIELD_ALIASES)
        .map((key) => [key, expense[key]])
        .filter(
          ([, value]) => typeof value == "number" || typeof value == "string",
        ),
    ));
  return {
    jobId,
    status:
      status === "needs_review" ||
      Object.values(expense.ocrConfidence).some(
        (value) => value < config.confidence,
      )
        ? "needs_review"
        : "ready",
    expense,
    receiptId: expense.receiptId,
  };
}
export function normalizeExpenseList(response) {
  const list = Array.isArray(response)
    ? response
    : (asObject(response).expenses ??
      asObject(response).data ??
      asObject(response).items);
  if (!Array.isArray(list)) {
    throw new Error("Invalid server response: expected an expense list.");
  }
  return list.map((item) =>
    normalizeExpense(item, {
      saved: true,
    }),
  );
}
export function normalizeCategory(category) {
  const source = asObject(category);
  if (!toText(source.id) || !toText(source.name)) {
    throw new Error("Invalid category response: id and name are required.");
  }
  return {
    id: toText(source.id),
    name: toText(source.name),
    limit: toNumber(source.limit),
    currency: toText(source.currency, config.defaultCurrency),
    receiptRequired: source.receiptRequired !== false,
    purposeRequired: source.purposeRequired !== false,
  };
}
export function normalizeCategoryList(response) {
  const list = Array.isArray(response)
    ? response
    : (asObject(response).categories ?? asObject(response).data);
  if (!Array.isArray(list)) {
    throw new Error("Invalid server response: expected a category list.");
  }
  return list.map(normalizeCategory);
}
function ownerIdentity(source, fallback, fields, user) {
  const owner = asObject(source.employee);
  const isNewForUser = !fields.employeeId && !owner.provider;
  return {
    employeeEmail: toText(
      owner.email,
      fallback.employeeEmail || (isNewForUser ? user?.email || "" : ""),
    ),
    identityVerified:
      owner.provider === "entra" ||
      (!owner.provider && Boolean(fallback.identityVerified)) ||
      (isNewForUser && user?.provider === "entra"),
  };
}
export function toExpensePayload(expense) {
  return {
    ...expense,
    receiptFiles: expense.receiptFiles?.map((file) => ({
      ...file,
      url: /^(blob:|data:)/.test(file.url) ? undefined : file.url,
      thumbnailUrl: undefined,
    })),
    clientRequestId: expense.id,
  };
}
