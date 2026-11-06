// Anomaly rules derived from Anomalies_reference.pdf (repository root).
//
// The PDF's "Anomalies" list and its matching "Sol" (solution) list are
// reproduced verbatim in `pdf` below, in the PDF's order. The PDF stays the
// business reference; these rules are the runtime implementation.
//
// A rule returns one of:
//   passed         evaluated, nothing found
//   flagged        evaluated, anomaly found
//   needs_review   evaluated, but details are unclear and need a person
//   not_evaluated  the data the rule needs is not connected yet (requiredSource says which)
// Rules never pass when their data is missing.

import { isMaterialTotalCorrection, OCR_CONFIDENCE_THRESHOLD, sameValue } from "../ocrFieldReview.js";
import { describeIsoDate } from "../receiptDate.js";

export const SOURCE_DOCUMENT = "Anomalies_reference.pdf";
export const COMPANY_POLICY = "Company expense policy";

export const DEPENDENCIES = {
  OCR_RECEIPT: "ocr_receipt",
  POLICY: "policy_knowledge_base",
  ATTENDANCE: "attendance",
  PREVIOUS: "previous_submissions",
  APPROVAL: "approval_evidence",
  CLARIFICATION: "manual_clarification",
  COMPANY_POLICY: "company_expense_policy",
};

// "System captures expense and validates details" (PDF): the required details.
export const REQUIRED_DETAILS = [
  ["employeeName", "Employee name"],
  ["position", "Position/role"],
  ["department", "Department"],
  ["expenseDate", "Date"],
  ["category", "Category"],
  ["amount", "Amount"],
  ["purpose", "Purpose"],
  ["location", "Location"],
];
// Details that can come from the receipt itself, checked right after OCR.
const RECEIPT_DETAILS = ["expenseDate", "amount"];

// OCR confidence below this needs the employee's confirmation (ocrFieldReview.js).
export const LOW_CONFIDENCE = OCR_CONFIDENCE_THRESHOLD;
const money = (n, currency) => `${currency || ""} ${Number(n).toFixed(2)}`.trim();
const near = (a, b) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.005);
const filled = (v) => (typeof v === "number" ? Number.isFinite(v) && v > 0 : typeof v === "string" ? v.trim() !== "" : v != null);

const result = (status, message, details) => ({ status, message, ...(details ? { details } : {}) });
const notConnected = (what) => result("not_evaluated", `${what} is not connected yet, so this check could not run.`);
// A company policy evaluation (policy/policyService.js) as a rule outcome.
const fromPolicy = ({ status, message, finding }) => result(status, message, finding);

export const anomalyRules = [
  {
    id: "hotel_exceeded_allowable_limit",
    name: "Hotel exceeded allowable limit",
    pdf: {
      anomaly: "Hotel exceeded allowable limit due to room availability issue",
      solution: "Knowledge base checks policy limit",
    },
    dependency: DEPENDENCIES.COMPANY_POLICY,
    requiredSource: "confirmed_category",
    severity: "warning",
    // Hotel & Lodging limits by policy group, from the company expense policy.
    evaluate: ({ policy }) => {
      if (policy.policyKey === "HOTEL_LODGING") return fromPolicy(policy.limit);
      if (policy.limit.status === "not_evaluated" && !policy.policyKey) return fromPolicy(policy.limit);
      return result("passed", "Not a Hotel & Lodging expense.");
    },
  },
  {
    id: "missing_receipt",
    name: "No receipt or attachment",
    pdf: {
      anomaly: "No Receipts/attachments but in the excel file",
      solution: "Ai chatbot requests upload",
    },
    dependency: DEPENDENCIES.OCR_RECEIPT,
    requiredSource: null,
    severity: "warning",
    evaluate: ({ expense, receiptUploaded }) =>
      receiptUploaded || (expense.receiptFiles?.length ?? 0) > 0
        ? result("passed", "A receipt or proof of payment is attached.")
        : result("flagged", "No receipt or proof of payment is attached. Ask the employee to upload it."),
  },
  {
    id: "meals_charged_while_on_leave",
    name: "Meals charged while on leave",
    pdf: { anomaly: "Charged meals but on leave", solution: "ai crosschecking vs attendance database" },
    dependency: DEPENDENCIES.ATTENDANCE,
    requiredSource: "attendance",
    severity: "warning",
    evaluate: () => notConnected("Attendance/leave data"),
  },
  {
    id: "exceeded_budget_or_policy_limit",
    name: "Exceeded approved budget or policy limit",
    pdf: {
      anomaly: "Expense amount exceeded approved budget or policy limit",
      solution: "knowledge base checks policy limit",
    },
    dependency: DEPENDENCIES.POLICY,
    requiredSource: "policy_knowledge_base",
    severity: "warning",
    // Uses only the category limits Finance configures in ReceiptFlow. Approved
    // budgets live in the knowledge base, which is not connected yet.
    evaluate: ({ expense, categories }) => {
      const category = categories.find((c) => c.name.toLowerCase() === String(expense.category || "").trim().toLowerCase());
      if (!filled(expense.amount)) return result("not_evaluated", "No amount to compare against a limit yet.");
      if (!category) {
        return result("not_evaluated", "No ReceiptFlow category policy matches this expense, and approved budgets (knowledge base) are not connected.");
      }
      if (category.limit === null || category.limit === undefined) {
        return result("not_evaluated", `No spending limit is set for ${category.name} yet, and approved budgets (knowledge base) are not connected.`);
      }
      if (category.currency !== expense.currency) {
        return result("not_evaluated", `The ${category.name} limit is in ${category.currency}; this ${expense.currency || "expense"} amount cannot be compared without a currency conversion.`);
      }
      if (expense.amount > category.limit) {
        return result("flagged", `Amount ${money(expense.amount, expense.currency)} exceeds the ${category.name} category limit of ${money(category.limit, category.currency)}.`, {
          category: category.name,
          limit: category.limit,
          overBy: Math.round((expense.amount - category.limit) * 100) / 100,
        });
      }
      return result("passed", `Within the ${category.name} category limit. Approved budgets (knowledge base) are not connected and were not checked.`, {
        partial: true,
        notChecked: "approved_budget",
      });
    },
  },
  {
    id: "receipt_unclear_or_invalid",
    name: "Receipt unclear or invalid",
    pdf: {
      anomaly: "Submitted OR/receipt is not original or is unclear/invalid",
      solution: "ai chatbot - request to reupload",
    },
    dependency: DEPENDENCIES.OCR_RECEIPT,
    requiredSource: "ocr",
    severity: "warning",
    // Uses OCR results only. Whether a receipt is the original cannot be
    // determined automatically, so this never claims a receipt is fake.
    evaluate: ({ ocr, expense }) => {
      if (!ocr) return result("not_evaluated", "No OCR scan is linked to this expense (manual entry), so receipt clarity was not checked.");
      // A low-confidence field the employee explicitly confirmed or corrected (a
      // server-maintained review whose value is still the expense's value) is no
      // longer an unresolved OCR uncertainty. Unread fields and provider warnings
      // still need review; a corrected total is checked by ocr_total_corrected.
      const resolved = new Map(
        (expense?.ocrFieldReviews ?? [])
          .filter((r) => (r.status === "confirmed" || r.status === "corrected") && r.confirmedAt && sameValue(r.field, r.confirmedValue, expense?.[r.field]))
          .map((r) => [r.field, r]),
      );
      const reasons = [];
      const confirmed = [];
      for (const [field, label] of [["merchant", "merchant"], ["amount", "total"], ["expenseDate", "date"]]) {
        if (!ocr.fieldsExtracted?.includes(field)) reasons.push(`the ${label} could not be read`);
        else if (typeof ocr.confidence?.[field] === "number" && ocr.confidence[field] < LOW_CONFIDENCE) {
          const pct = Math.round(ocr.confidence[field] * 100);
          const review = resolved.get(field);
          if (review) confirmed.push(`${label} (read with ${pct}% confidence, ${review.status} by ${review.confirmedBy?.name || "the employee"})`);
          else reasons.push(`the ${label} was read with low confidence (${pct}%)`);
        }
      }
      if (ocr.isDocument === false) reasons.push("Veryfi did not recognize the file as a receipt or invoice");
      if (ocr.fraudColor === "red") reasons.push("Veryfi reported a high fraud-risk signal for this document");
      const note = "Originality is not verified automatically.";
      const confirmedNote = confirmed.length ? ` Confirmed by the employee: ${confirmed.join("; ")}.` : "";
      const details = confirmed.length ? { reasons, confirmedFields: [...resolved.keys()] } : { reasons };
      return reasons.length
        ? result("needs_review", `The receipt may be unclear: ${reasons.join("; ")}. Ask the employee to re-upload a clearer copy if needed.${confirmedNote} ${note}`, details)
        : result("passed", `Key receipt fields were read clearly${confirmed.length ? " or confirmed by the employee" : ""}.${confirmedNote} ${note}`, confirmed.length ? details : undefined);
    },
  },
  {
    // The employee changed the total the receipt scan read. Original and
    // submitted totals are kept; a change beyond the configured tolerance
    // (default: any change) needs review. Confirmation never overrides this.
    id: "ocr_total_corrected",
    name: "Total changed from the scanned receipt",
    pdf: {
      anomaly: "Submitted OR/receipt is not original or is unclear/invalid",
      solution: "ai chatbot - request to reupload",
    },
    dependency: DEPENDENCIES.OCR_RECEIPT,
    requiredSource: "ocr",
    severity: "warning",
    evaluate: ({ expense, ocrResult }) => {
      if (!ocrResult) return result("not_evaluated", "No OCR scan is linked to this expense (manual entry), so there is no scanned total to compare.");
      const scanned = typeof ocrResult.amount === "number" && Number.isFinite(ocrResult.amount) ? ocrResult.amount : null;
      if (scanned === null) return result("not_evaluated", "The receipt scan did not read a total, so a changed total cannot be detected.");
      const submitted = Number(expense?.amount);
      if (!Number.isFinite(submitted)) return result("not_evaluated", "The expense has no total yet.");
      const difference = Math.round((submitted - scanned) * 100) / 100;
      const details = { scannedTotal: scanned, submittedTotal: submitted, difference };
      if (difference === 0) return result("passed", "The total matches the scanned receipt.");
      const change = `The total was changed from ${money(scanned, expense.currency)} (scanned) to ${money(submitted, expense.currency)} (difference ${money(difference, expense.currency)}).`;
      return isMaterialTotalCorrection(scanned, submitted)
        ? result("needs_review", `${change} A reviewer should compare it with the receipt.`, details)
        : result("passed", `${change} This is within the tolerance set by Finance.`, details);
    },
  },
  {
    // The employee changed the currency the receipt scan read. Both values are
    // kept; any change needs review. A scan without a currency is not an
    // anomaly: the employee provides it (ocrFieldReview.js).
    id: "ocr_currency_changed",
    name: "Currency changed from the scanned receipt",
    pdf: {
      anomaly: "Submitted OR/receipt is not original or is unclear/invalid",
      solution: "ai chatbot - request to reupload",
    },
    dependency: DEPENDENCIES.OCR_RECEIPT,
    requiredSource: "ocr",
    severity: "warning",
    evaluate: ({ expense, ocrResult }) => {
      if (!ocrResult) return result("not_evaluated", "No OCR scan is linked to this expense (manual entry), so there is no scanned currency to compare.");
      const scanned = typeof ocrResult.currency === "string" && /^[A-Z]{3}$/.test(ocrResult.currency) ? ocrResult.currency : null;
      if (!scanned) return result("not_evaluated", "The receipt scan did not read a currency; the employee provided it.");
      const submitted = String(expense?.currency ?? "").toUpperCase();
      if (submitted === scanned) return result("passed", "The currency matches the scanned receipt.");
      return result(
        "needs_review",
        `The currency was changed from ${scanned} (scanned) to ${submitted || "none"}. A reviewer should compare it with the receipt.`,
        { scannedCurrency: scanned, submittedCurrency: submitted || null },
      );
    },
  },
  {
    // Document screening signals supplied by the OCR provider itself (Veryfi:
    // fraud-risk color, duplicate-document flag, receipt/not-a-receipt check).
    // A provider that cannot supply them (Google Document AI) makes this check
    // "not evaluated" with the missing signals listed; it is never reported as passed.
    id: "ocr_provider_screening",
    name: "OCR provider document screening",
    pdf: {
      anomaly: "Submitted OR/receipt is not original or is unclear/invalid",
      solution: "ai chatbot - request to reupload",
    },
    dependency: DEPENDENCIES.OCR_RECEIPT,
    requiredSource: "ocr_provider_signals",
    severity: "warning",
    evaluate: ({ ocr }) => {
      if (!ocr) return result("not_evaluated", "No OCR scan is linked to this expense (manual entry), so provider document screening did not run.");
      const unavailable = Array.isArray(ocr.unavailableSignals) ? ocr.unavailableSignals : [];
      if (unavailable.length) {
        const labels = {
          provider_fraud_signal: "fraud-risk screening",
          provider_duplicate_signal: "the provider's duplicate-document check",
          provider_document_check: "the receipt/not-a-receipt check",
        };
        const names = unavailable.map((id) => labels[id] ?? id).join(", ");
        return result(
          "not_evaluated",
          `Not available with the current OCR provider (${ocr.provider ?? "unknown"}): ${names}. These were not checked; ReceiptFlow's own duplicate and policy checks still ran.`,
          { unavailableSignals: unavailable, provider: ocr.provider },
        );
      }
      // Veryfi: its signals are applied in the receipt-clarity and duplicate checks.
      return result("passed", "The OCR provider's document screening signals were available and are applied in the receipt and duplicate checks.");
    },
  },
  {
    id: "possible_duplicate_claim",
    name: "Possible duplicate claim",
    pdf: { anomaly: "Possible duplicate claim detected", solution: "ai crosschecks previous submissions" },
    dependency: DEPENDENCIES.PREVIOUS,
    requiredSource: "previous_submissions",
    severity: "warning",
    // Flags for review only; a similar expense is never rejected automatically.
    evaluate: ({ expense, duplicates, ocr }) => {
      if (duplicates === null) return result("not_evaluated", "Previous submissions could not be checked (database unavailable).");
      const veryfiDuplicate = ocr?.isDuplicate === true;
      if (!duplicates.length && !veryfiDuplicate) return result("passed", "No similar previous expense was found.");
      // Only the employee's own earlier requests are named; another employee's
      // request is never identified here (Finance sees it in possibleDuplicates).
      const own = duplicates.filter((d) => d.sameEmployee === true);
      const others = duplicates.length - own.length;
      const parts = [];
      if (own.length) {
        parts.push(`Similar previous expense${own.length > 1 ? "s" : ""} of yours found: ${own.map((d) => d.requestNumber || d.id).join(", ")}.`);
      }
      if (others) parts.push("A similar expense was submitted by another employee. Finance will review it.");
      if (veryfiDuplicate) parts.push("Veryfi reports that this document was submitted before.");
      if (expense.duplicateOverrideReason) parts.push(`Employee explanation: "${expense.duplicateOverrideReason}".`);
      return result("flagged", parts.join(" "), { matches: own.map((d) => d.id), otherEmployeeMatches: others, veryfiDuplicate });
    },
  },
  {
    id: "expense_on_approved_leave_date",
    name: "Expense date on approved leave",
    pdf: { anomaly: "Expense date falls on approved leave date", solution: "ai crosschecks with attendance" },
    dependency: DEPENDENCIES.ATTENDANCE,
    requiredSource: "attendance",
    severity: "warning",
    evaluate: () => notConnected("Attendance/leave data"),
  },
  {
    id: "higher_level_approval_required",
    name: "Higher-level approval required",
    pdf: {
      anomaly: "Expense requires higher-level approval due to exception or policy breach",
      solution: "Ai chatbot requests for approval proof",
    },
    dependency: DEPENDENCIES.APPROVAL,
    requiredSource: "approval_evidence",
    severity: "warning",
    evaluate: () => notConnected("Approval-authority policy and approval evidence"),
  },
  {
    id: "company_policy_limit",
    name: "Company policy limit",
    source: COMPANY_POLICY,
    pdf: {
      anomaly: "Expense amount exceeded approved budget or policy limit",
      solution: "knowledge base checks policy limit",
    },
    dependency: DEPENDENCIES.COMPANY_POLICY,
    requiredSource: "confirmed_category",
    severity: "warning",
    // Meal limits per expense and the monthly Product Presentations / Training &
    // Evaluation / Gifts limit, by the employee's policy group. Hotel & Lodging
    // is reported by the hotel rule above.
    evaluate: ({ policy }) =>
      policy.policyKey === "HOTEL_LODGING"
        ? result("passed", "Checked under Hotel exceeded allowable limit.")
        : fromPolicy(policy.limit),
  },
  {
    id: "excom_approval_required",
    name: "ExCom approval",
    source: COMPANY_POLICY,
    pdf: {
      anomaly: "Expense requires higher-level approval due to exception or policy breach",
      solution: "Ai chatbot requests for approval proof",
    },
    dependency: DEPENDENCIES.APPROVAL,
    requiredSource: "confirmed_category",
    severity: "warning",
    // Representations of PHP 5,000.00 and above need proof of ExCom approval.
    evaluate: ({ policy }) => fromPolicy(policy.excom),
  },
  {
    id: "unclear_or_inconsistent_details",
    name: "Unclear or inconsistent details",
    pdf: {
      anomaly: "Unclear or inconsistent expense details requiring clarification",
      solution: "Ai chatbot asks for clarification on unclear fields",
    },
    dependency: DEPENDENCIES.CLARIFICATION,
    requiredSource: null,
    severity: "warning",
    evaluate: ({ expense, stage, today }) => {
      const required = stage === "extraction" ? REQUIRED_DETAILS.filter(([f]) => RECEIPT_DETAILS.includes(f)) : REQUIRED_DETAILS;
      const missing = required.filter(([field]) => !filled(expense[field])).map(([, label]) => label);
      const issues = [];
      const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      const total = n(expense.amount);
      const subtotal = n(expense.subtotal);
      if (total > 0 && subtotal > 0) {
        const computed = subtotal + n(expense.tax) + n(expense.serviceCharge) + n(expense.tip) - n(expense.discount);
        // Accept tax-exclusive (subtotal + tax + ... = total) and tax-inclusive (subtotal = total) receipts.
        if (!near(computed, total) && !near(subtotal, total)) {
          issues.push(`Subtotal and charges (${computed.toFixed(2)}) do not match the total (${total.toFixed(2)}).`);
        }
      }
      const items = (expense.lineItems ?? []).filter((i) => n(i.total) > 0);
      if (items.length && total > 0) {
        const sum = items.reduce((s, i) => s + n(i.total), 0);
        if (!near(sum, total) && !(subtotal > 0 && near(sum, subtotal))) {
          issues.push(`Line items add up to ${sum.toFixed(2)}, which matches neither the subtotal nor the total.`);
        }
      }
      if (filled(expense.expenseDate) && expense.expenseDate > today) issues.push(`The date ${expense.expenseDate} is in the future.`);
      // A printed date like 10/03/2026 can be read as day/month or month/day
      // (services/receiptDate.js). Until the employee confirms it, the date is
      // unclear: needs_review, never a confirmed anomaly.
      const review = expense.dateReview;
      const dateAwaitingConfirmation = review?.ambiguous && review.status !== "confirmed";
      if (dateAwaitingConfirmation) {
        issues.push(
          `The receipt shows "${review.raw}", which can be ${describeIsoDate(review.candidates.dayMonthYear)} (day/month) or ${describeIsoDate(review.candidates.monthDayYear)} (month/day). The employee must confirm the date.`,
        );
      }
      if (!missing.length && !issues.length) return result("passed", "Required details are present and consistent.");
      const text = [missing.length ? `Missing: ${missing.join(", ")}.` : "", ...issues].filter(Boolean).join(" ");
      return result("needs_review", `${text} Ask the employee to clarify.`, {
        missing,
        inconsistencies: issues,
        ...(dateAwaitingConfirmation
          ? { dateReview: { raw: review.raw, candidates: review.candidates, suggested: review.suggested, awaiting: "employee_confirmation" } }
          : {}),
      });
    },
  },
];
