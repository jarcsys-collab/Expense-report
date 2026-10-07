// Evaluates an expense against the company expense policy (expensePolicy.js).
// Runs on the server only, using:
//   - the expense owner's job title from the verified Microsoft profile
//     (expense.employee, set from the server session, never from the browser)
//   - the employee-confirmed category, linked to a policy key by Finance
//   - the confirmed amount
//   - earlier expenses in MongoDB for monthly limits
// Policy findings never reject an expense: they are reported as anomalies and
// route it to manager approval.
import { Category } from "../models/Category.js";
import { Expense } from "../models/Expense.js";
import { expensePolicy } from "./expensePolicy.js";

export const POLICY_FINDINGS = {
  LIMIT_EXCEEDED: "POLICY_LIMIT_EXCEEDED",
  MONTHLY_LIMIT_EXCEEDED: "MONTHLY_POLICY_LIMIT_EXCEEDED",
  ROLE_UNMAPPED: "POLICY_ROLE_UNMAPPED",
  CURRENCY_UNSUPPORTED: "POLICY_CURRENCY_UNSUPPORTED",
  EXCOM_APPROVAL_REQUIRED: "EXCOM_APPROVAL_REQUIRED",
  EXCOM_EVIDENCE_MISSING: "EXCOM_APPROVAL_EVIDENCE_MISSING",
};

// ---------------------------------------------------------------------------
// Job title → policy group
// ---------------------------------------------------------------------------

// Only abbreviations that appear in the policy's own titles.
const ABBREVIATIONS = { asst: "assistant", gen: "general", eng: "engineer", app: "application" };

// Ignores letter case, periods, hyphens/underscores, extra spaces and the
// abbreviations above. "Service Eng." and "service  engineer" are the same title.
export function normalizeJobTitle(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[.\-_]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ABBREVIATIONS[word] ?? word)
    .join(" ");
}

const TITLE_TO_GROUP = new Map();
for (const [group, { titles }] of Object.entries(expensePolicy.roleGroups)) {
  for (const title of titles) {
    const key = normalizeJobTitle(title);
    const existing = TITLE_TO_GROUP.get(key);
    if (existing && existing !== group) {
      throw new Error(`Expense policy: job title "${title}" is listed in groups ${existing} and ${group}.`);
    }
    TITLE_TO_GROUP.set(key, group);
  }
}

// The policy group for a job title, or null when it cannot be mapped safely.
// Exact match after normalization only: no partial or "closest" matches.
export function resolvePolicyGroup(jobTitle) {
  const group = TITLE_TO_GROUP.get(normalizeJobTitle(jobTitle));
  return group ? { group, label: expensePolicy.roleGroups[group].label } : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cents = (amount) => Math.round(Number(amount) * 100);
const fromCents = (value) => value / 100;
export const formatPolicyMoney = (amount, currency = expensePolicy.currency) =>
  `${currency} ${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const result = (status, message, finding) => ({ status, message, ...(finding ? { finding } : {}) });

// Whose policy applies: the expense owner's verified Microsoft job title.
function policyRole(expense) {
  const owner = expense.employee;
  if (owner?.provider !== "entra") {
    return { verified: false, jobTitle: String(expense.position ?? "") };
  }
  return { verified: true, jobTitle: String(owner.jobTitle ?? ""), group: resolvePolicyGroup(owner.jobTitle) };
}

function roleUnmapped(role, policyLabel, category) {
  const reason = !role.verified
    ? "the employee's job title does not come from a verified Microsoft profile"
    : role.jobTitle
      ? `the job title "${role.jobTitle}" does not match a policy group`
      : "no job title is set in the employee's Microsoft profile";
  return result("needs_review", `The ${policyLabel} policy limit could not be applied because ${reason}. Manager review required.`, {
    type: POLICY_FINDINGS.ROLE_UNMAPPED,
    category,
    employeeRole: role.jobTitle || null,
    policyGroup: null,
    severity: "warning",
    requiresReview: true,
    requiresManagerApproval: true,
  });
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   policyKey: string|null, categoryLabel: string|null,
 *   limit: {status, message, finding?}, excom: {status, message, finding?}
 * }>}
 * `limit` covers per-expense and monthly limits; `excom` the representation rule.
 */
export async function evaluateExpensePolicy({ expense, stage, excludeId }) {
  const notYet = (message) => ({ policyKey: null, categoryLabel: null, limit: result("not_evaluated", message), excom: result("not_evaluated", message) });
  if (stage !== "submission") {
    return notYet("Company policy checks run once the employee confirms the category and amount.");
  }
  const categoryName = String(expense.category ?? "").trim();
  if (!categoryName) return notYet("Choose a category to check it against the company policy.");

  const category = await Category.findOne({ name: categoryName }).collation({ locale: "en", strength: 2 }).lean();
  const policyKey = category?.policyKey ?? null;
  if (!policyKey) {
    const none = result("passed", `No company policy limit applies to ${categoryName}.`);
    return { policyKey: null, categoryLabel: null, limit: none, excom: none };
  }
  const { label, period } = expensePolicy.categories[policyKey];
  const base = { policyKey, categoryLabel: label };

  if (!(Number.isFinite(expense.amount) && expense.amount > 0)) {
    return { ...base, limit: result("not_evaluated", "No amount to check yet."), excom: result("not_evaluated", "No amount to check yet.") };
  }
  if ((expense.currency || expensePolicy.currency) !== expensePolicy.currency) {
    const unsupported = result(
      "needs_review",
      `The company policy is in ${expensePolicy.currency}; this ${expense.currency} expense cannot be compared without a currency conversion. Manager review required.`,
      { type: POLICY_FINDINGS.CURRENCY_UNSUPPORTED, category: policyKey, severity: "warning", requiresReview: true, requiresManagerApproval: true },
    );
    return { ...base, limit: unsupported, excom: unsupported };
  }

  if (policyKey === expensePolicy.representationRules.category) {
    return { ...base, limit: result("passed", `No per-expense limit applies to ${label}.`), excom: evaluateRepresentation(expense, label) };
  }
  const excom = result("passed", `The ExCom approval rule applies only to representation expenses.`);

  const role = policyRole(expense);
  if (!role.verified || !role.group) return { ...base, limit: roleUnmapped(role, label, policyKey), excom };
  const { group } = role.group;
  const common = { category: policyKey, employeeRole: role.jobTitle, policyGroup: group, severity: "warning" };

  if (period === "monthly") {
    return { ...base, limit: await evaluateMonthly(expense, { label, policyKey, group, role, common, excludeId }), excom };
  }

  const limit = expensePolicy.categoryLimits[group]?.[policyKey];
  if (limit === undefined) return { ...base, limit: result("passed", `No ${label} limit is defined for ${role.group.label}.`), excom };
  const over = cents(expense.amount) - cents(limit);
  const finding = { ...common, submittedAmount: expense.amount, policyLimit: limit };
  if (over > 0) {
    return {
      ...base,
      excom,
      limit: result(
        "flagged",
        `${label} expense of ${formatPolicyMoney(expense.amount)} exceeds the ${formatPolicyMoney(limit)} policy limit for ${role.jobTitle} by ${formatPolicyMoney(fromCents(over))}.`,
        { ...finding, type: POLICY_FINDINGS.LIMIT_EXCEEDED, excessAmount: fromCents(over), requiresReview: true, requiresManagerApproval: true },
      ),
    };
  }
  return {
    ...base,
    excom,
    limit: result("passed", `Within the ${formatPolicyMoney(limit)} ${label} policy limit for ${role.jobTitle}.`, {
      ...finding,
      type: null,
      excessAmount: 0,
      requiresReview: false,
      requiresManagerApproval: false,
    }),
  };
}

// Monthly limit: earlier qualifying expenses of the same employee, same policy
// category and same calendar month (by receipt date), plus this expense.
async function evaluateMonthly(expense, { label, policyKey, group, role, common, excludeId }) {
  const limit = expensePolicy.monthlyLimits[policyKey]?.[group];
  if (limit === undefined) return result("passed", `No monthly ${label} limit is defined for this policy group.`);
  const month = /^(\d{4}-\d{2})-\d{2}$/.exec(expense.expenseDate ?? "")?.[1];
  if (!month) return result("not_evaluated", `A receipt date is needed to total this month's ${label} expenses.`);
  if (!expense.employeeId) return result("not_evaluated", "The expense has no owner to total monthly expenses for.");

  // Expenses saved with a policy key count by that key (as filed). Older
  // records without one count by the names of categories now mapped to it.
  const names = (await Category.find({ policyKey }, { name: 1 }).lean()).map((c) => c.name);
  const earlier = await Expense.find(
    {
      employeeId: expense.employeeId,
      status: { $in: expensePolicy.monthlyCountedStatuses },
      $or: [{ policyKey }, { policyKey: { $exists: false }, category: { $in: names } }],
      expenseDate: { $regex: `^${month}-` },
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    },
    { amount: 1, currency: 1 },
  ).lean();
  const otherCurrency = earlier.filter((e) => (e.currency || expensePolicy.currency) !== expensePolicy.currency).length;
  const previousCents = earlier
    .filter((e) => (e.currency || expensePolicy.currency) === expensePolicy.currency)
    .reduce((sum, e) => sum + cents(e.amount || 0), 0);
  const totalCents = previousCents + cents(expense.amount);
  const finding = {
    ...common,
    period: "monthly",
    month,
    submittedAmount: expense.amount,
    previousAmount: fromCents(previousCents),
    monthlyTotal: fromCents(totalCents),
    policyLimit: limit,
    countedExpenses: earlier.length - otherCurrency,
  };
  const over = totalCents - cents(limit);
  if (over > 0) {
    return result(
      "flagged",
      `${label} expenses for ${month} total ${formatPolicyMoney(fromCents(totalCents))} (${formatPolicyMoney(fromCents(previousCents))} earlier this month + ${formatPolicyMoney(expense.amount)} now), exceeding the ${formatPolicyMoney(limit)} monthly policy limit for ${role.jobTitle} by ${formatPolicyMoney(fromCents(over))}.`,
      { ...finding, type: POLICY_FINDINGS.MONTHLY_LIMIT_EXCEEDED, excessAmount: fromCents(over), requiresReview: true, requiresManagerApproval: true },
    );
  }
  if (otherCurrency) {
    return result(
      "needs_review",
      `${otherCurrency} earlier ${label} expense(s) this month are not in ${expensePolicy.currency} and could not be added to the monthly total. Manager review required.`,
      { ...finding, type: POLICY_FINDINGS.CURRENCY_UNSUPPORTED, requiresReview: true, requiresManagerApproval: true },
    );
  }
  return result(
    "passed",
    `${label} expenses for ${month} total ${formatPolicyMoney(fromCents(totalCents))}, within the ${formatPolicyMoney(limit)} monthly policy limit for ${role.jobTitle}.`,
    { ...finding, type: null, excessAmount: 0, requiresReview: false, requiresManagerApproval: false },
  );
}

// ExCom evidence is "provided" when the employee states its type and either
// describes it or attaches a file. ReceiptFlow does not verify its content.
export function excomEvidenceProvided(evidence) {
  return Boolean(
    evidence &&
      Object.hasOwn(expensePolicy.representationRules.evidenceTypes, evidence.type) &&
      (String(evidence.reference ?? "").trim() || String(evidence.fileName ?? "").trim()),
  );
}

function evaluateRepresentation(expense, label) {
  const { excomApprovalThreshold } = expensePolicy.representationRules;
  if (cents(expense.amount) < cents(excomApprovalThreshold)) {
    return result("passed", `${label} below ${formatPolicyMoney(excomApprovalThreshold)}: no ExCom approval needed.`);
  }
  const finding = {
    category: expensePolicy.representationRules.category,
    submittedAmount: expense.amount,
    threshold: excomApprovalThreshold,
    severity: "warning",
    requiresReview: true,
    requiresManagerApproval: true,
  };
  if (excomEvidenceProvided(expense.excomEvidence)) {
    return result(
      "needs_review",
      `${label} of ${formatPolicyMoney(expense.amount)} requires ExCom approval. Evidence provided (${expensePolicy.representationRules.evidenceTypes[expense.excomEvidence.type]}); not verified by ReceiptFlow. Manager review required.`,
      { ...finding, type: POLICY_FINDINGS.EXCOM_APPROVAL_REQUIRED, evidenceStatus: "provided", evidenceType: expense.excomEvidence.type },
    );
  }
  return result(
    "flagged",
    `${label} of ${formatPolicyMoney(expense.amount)} requires ExCom approval (${formatPolicyMoney(excomApprovalThreshold)} and above). ExCom approval evidence is missing: attach an email, letter, Viber or Teams message.`,
    { ...finding, type: POLICY_FINDINGS.EXCOM_EVIDENCE_MISSING, evidenceStatus: "missing", blocksFinalApproval: true },
  );
}
