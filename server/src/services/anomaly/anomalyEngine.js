// Runs the anomaly rules and decides the workflow route, following the
// Anomalies_reference.pdf flow:
//   System runs anomaly check → Any anomaly?
//     Yes → Route to Manager Approval
//     No  → Skip Manager, route directly to Finance
// Checks that could not run are listed in `notEvaluated`; an expense is never
// reported as fully clean while any of them remain.
import { Category } from "../../models/Category.js";
import { evaluateExpensePolicy } from "../../policy/policyService.js";
import { anomalyRules, SOURCE_DOCUMENT } from "./anomalyRules.js";
import { findPossibleDuplicates } from "./duplicateCheck.js";

const SEVERITY_LABEL = { info: "Informational", warning: "Warning", high: "High Risk" };
export const VIOLATION_PREFIX = "anomaly-";

/**
 * @param {object} input
 * @param {object} input.expense   expense fields (frontend shape)
 * @param {"extraction"|"submission"} input.stage
 *        extraction: right after OCR, before the employee confirms the summary
 *        submission: after the employee confirms (save/submit)
 * @param {object|null} [input.ocr]  ocrMeta from the linked receipt job
 * @param {boolean} [input.receiptUploaded]
 * @param {string} [input.excludeId]  the expense's own id (for duplicate checks)
 */
export async function runAnomalyCheck({ expense, stage, ocr = null, receiptUploaded = false, excludeId }) {
  const [categories, duplicates, policy] = await Promise.all([
    Category.find().lean().catch(() => []),
    findPossibleDuplicates(expense, { excludeId }),
    // Company expense policy (policy/expensePolicy.js), used by the policy rules.
    evaluateExpensePolicy({ expense, stage, excludeId }),
  ]);
  const context = {
    expense,
    stage,
    ocr,
    receiptUploaded,
    categories,
    duplicates,
    policy,
    today: new Date().toISOString().slice(0, 10),
  };

  const anomalies = anomalyRules.map((rule) => {
    let outcome;
    try {
      outcome = rule.evaluate(context);
    } catch (error) {
      console.error(`Anomaly rule ${rule.id} failed: ${error.name}`);
      outcome = { status: "not_evaluated", message: "This check failed to run." };
    }
    return {
      ruleId: rule.id,
      name: rule.name,
      status: outcome.status,
      severity: rule.severity,
      message: outcome.message,
      dependency: rule.dependency,
      requiredSource: outcome.status === "not_evaluated" ? rule.requiredSource ?? "unknown" : null,
      source: rule.source ?? SOURCE_DOCUMENT,
      reference: rule.pdf,
      ...(outcome.details ? { details: outcome.details } : {}),
    };
  });

  const found = anomalies.filter((a) => a.status === "flagged" || a.status === "needs_review");
  const notEvaluated = anomalies.filter((a) => a.status === "not_evaluated");
  const needsReview = found.length > 0;
  return {
    source: SOURCE_DOCUMENT,
    stage,
    evaluatedAt: new Date().toISOString(),
    hasAnomaly: found.some((a) => a.status === "flagged"),
    needsReview,
    // Workflow decision from the PDF.
    route: needsReview ? "manager_approval" : "finance",
    complete: notEvaluated.length === 0,
    notEvaluated: notEvaluated.map((a) => ({ ruleId: a.ruleId, requiredSource: a.requiredSource })),
    summary: needsReview
      ? `${found.length} item${found.length > 1 ? "s" : ""} need manager review.`
      : notEvaluated.length
        ? `No anomalies found in the checks that ran; ${notEvaluated.length} check${notEvaluated.length > 1 ? "s" : ""} could not run yet.`
        : "No anomalies found.",
    anomalies,
    possibleDuplicates: duplicates ?? [],
  };
}

// Findings shown in the frontend's Expense Check (policyViolations shape).
export function reportToViolations(report, existing = []) {
  const previous = new Map(existing.map((v) => [v.id, v]));
  return report.anomalies
    .filter((a) => a.status === "flagged" || a.status === "needs_review")
    .map((a) => {
      const id = `${VIOLATION_PREFIX}${a.ruleId}`;
      const before = previous.get(id);
      return {
        id,
        type: a.name,
        severity: SEVERITY_LABEL[a.severity] ?? "Warning",
        message: a.message,
        // Keep a resolution recorded earlier for the same finding.
        status: before?.status === "Resolved" ? "Resolved" : "Open",
        createdAt: before?.createdAt ?? new Date(),
        resolutionReason: before?.resolutionReason ?? "",
      };
    });
}

// Plain-language notes for the review screen ("Check before submitting").
export function reportToNotes(report) {
  const notes = report.anomalies
    .filter((a) => a.status === "flagged" || a.status === "needs_review")
    .map((a) => `${a.name}: ${a.message}`);
  if (report.notEvaluated.length) {
    const names = report.anomalies.filter((a) => a.status === "not_evaluated").map((a) => a.name.toLowerCase());
    notes.push(`Not checked yet (data not connected): ${names.join("; ")}.`);
  }
  return notes;
}
