// What a viewer may see of an expense in API responses.
//
// Duplicate detection compares against every employee's requests, but only
// Finance may see who else submitted a similar expense. Everyone else sees
// their own matching requests plus one anonymous marker
// ({ id: "other-employee", otherEmployee: true }) that says "another employee
// submitted something similar" without its number, owner, merchant, amount,
// date or link. The stored record keeps the full details for Finance.
const isFinance = (user) => user?.role === "FINANCE_ADMIN";
const DUPLICATE_RULE = "possible_duplicate_claim";
export const OTHER_EMPLOYEE_DUPLICATE = Object.freeze({ id: "other-employee", otherEmployee: true });
const LEGACY_DUPLICATE_MESSAGE =
  "A similar previous expense was found. Finance will review it; details of other employees' requests are not shown.";

function visibleDuplicates(list) {
  if (!Array.isArray(list)) return list;
  const own = list.filter((d) => d?.sameEmployee === true).map(({ employeeName, ...rest }) => rest);
  return list.length > own.length ? [...own, { ...OTHER_EMPLOYEE_DUPLICATE }] : own;
}

/**
 * Removes other employees' details from duplicate results for non-Finance viewers.
 * @param {object} expense plain JSON expense (doc.toJSON() or an API object)
 * @param {object} user req.user
 * @returns {object} a copy safe to send to this viewer
 */
export function redactExpenseForViewer(expense, user) {
  if (!expense || typeof expense !== "object" || isFinance(user)) return expense;
  const out = { ...expense };
  if ("possibleDuplicates" in out) out.possibleDuplicates = visibleDuplicates(out.possibleDuplicates);

  let legacy = false;
  if (out.anomalyReport && typeof out.anomalyReport === "object") {
    const report = { ...out.anomalyReport };
    if (Array.isArray(report.possibleDuplicates)) report.possibleDuplicates = visibleDuplicates(report.possibleDuplicates);
    if (Array.isArray(report.anomalies)) {
      report.anomalies = report.anomalies.map((anomaly) => {
        if (anomaly?.ruleId !== DUPLICATE_RULE || anomaly.status !== "flagged") return anomaly;
        // Checks made before this change named every match in the message.
        if (!anomaly.details || !("otherEmployeeMatches" in anomaly.details)) {
          legacy = true;
          return { ...anomaly, message: LEGACY_DUPLICATE_MESSAGE, details: {} };
        }
        return anomaly;
      });
    }
    out.anomalyReport = report;
  }
  if (legacy && Array.isArray(out.policyViolations)) {
    out.policyViolations = out.policyViolations.map((v) =>
      v?.id === `anomaly-${DUPLICATE_RULE}` ? { ...v, message: LEGACY_DUPLICATE_MESSAGE } : v,
    );
  }
  if (legacy && Array.isArray(out.extractionNotes)) {
    out.extractionNotes = out.extractionNotes.filter((note) => !/Similar previous expense/i.test(String(note)));
  }
  return out;
}

/** JSON for a Mongoose expense document, as this viewer may see it. */
export const expenseForViewer = (doc, user) => redactExpenseForViewer(typeof doc?.toJSON === "function" ? doc.toJSON() : doc, user);
