import { useEffect, useState } from "react";
import { api } from "../../services/api";

// Company expense policy result for the expense being reviewed. The server
// evaluates it (POST /policy/check) with the employee's verified job title and
// earlier expenses; this component only displays the result. Findings are
// policy exceptions that need manager review, never rejections.

const money = (amount, currency = "PHP") =>
  `${currency} ${Number(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const EXCOM_TYPES = ["EXCOM_APPROVAL_REQUIRED", "EXCOM_APPROVAL_EVIDENCE_MISSING"];

function Rows({ rows }) {
  return (
    <dl>
      {rows
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function employeePolicy(finding, policy) {
  if (!finding.employeeRole) return undefined;
  const group = policy?.roleGroups?.[finding.policyGroup]?.label;
  return group ? `${finding.employeeRole} (${group})` : finding.employeeRole;
}

export function PolicyExceptions({ expense, expenseId, disabled, onEvidenceChange }) {
  const [policy, setPolicy] = useState(null);
  const [check, setCheck] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.getPolicy().then(
      (value) => active && setPolicy(value),
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);
  const inputs = JSON.stringify([
    expense.category,
    expense.amount,
    expense.currency,
    expense.expenseDate,
    expense.excomEvidence ?? null,
    expenseId ?? "",
  ]);
  useEffect(() => {
    if (!expense.category) {
      setCheck(null);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      api.checkPolicy(expense, expenseId).then(
        (result) => {
          if (active) {
            setCheck(result);
            setError("");
          }
        },
        (failure) => active && setError(failure.message),
      );
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // `inputs` captures every value the check depends on.
  }, [inputs]);

  if (error) {
    return (
      <p className="policy-note muted" id="policy-check">
        Company policy could not be checked right now. It is checked again when
        you save or submit.
      </p>
    );
  }
  if (check && !check.policyKey && check.limit?.status === "passed") {
    return (
      <p className="policy-note muted" id="policy-check">
        No company policy limit applies to {expense.category}.
      </p>
    );
  }
  if (!check?.policyKey) return null;
  const label = check.categoryLabel;
  const limit = check.limit?.finding;
  const excom = check.excom?.finding;
  const reviewStatus = "Manager approval required";
  const cards = [];

  if (limit?.type === "POLICY_LIMIT_EXCEEDED") {
    cards.push(
      <article key="limit" className="policy-exception">
        <span className="policy-eyebrow">Policy exception</span>
        <h4>{label}</h4>
        <Rows
          rows={[
            ["Expense", money(limit.submittedAmount)],
            ["Allowed limit", money(limit.policyLimit)],
            ["Exceeded by", money(limit.excessAmount)],
            ["Employee policy", employeePolicy(limit, policy)],
            ["Status", reviewStatus],
          ]}
        />
      </article>,
    );
  } else if (limit?.type === "MONTHLY_POLICY_LIMIT_EXCEEDED") {
    cards.push(
      <article key="limit" className="policy-exception">
        <span className="policy-eyebrow">Policy exception · monthly limit</span>
        <h4>{label}</h4>
        <Rows
          rows={[
            ["This expense", money(limit.submittedAmount)],
            ["Earlier this month", money(limit.previousAmount)],
            [`Total for ${limit.month}`, money(limit.monthlyTotal)],
            ["Monthly limit", money(limit.policyLimit)],
            ["Exceeded by", money(limit.excessAmount)],
            ["Employee policy", employeePolicy(limit, policy)],
            ["Status", reviewStatus],
          ]}
        />
      </article>,
    );
  } else if (
    limit?.type === "POLICY_ROLE_UNMAPPED" ||
    limit?.type === "POLICY_CURRENCY_UNSUPPORTED"
  ) {
    cards.push(
      <article key="limit" className="policy-exception">
        <span className="policy-eyebrow">Policy review</span>
        <h4>{label}</h4>
        <p>{check.limit.message}</p>
        <Rows rows={[["Status", "Manager review required"]]} />
      </article>,
    );
  } else if (check.limit?.status === "passed" && limit) {
    cards.push(
      <p key="limit" className="policy-note">
        Within policy: {check.limit.message}
      </p>,
    );
  }

  if (EXCOM_TYPES.includes(excom?.type)) {
    const provided = excom.evidenceStatus === "provided";
    cards.push(
      <article key="excom" className="policy-exception">
        <span className="policy-eyebrow">ExCom approval required</span>
        <h4>{label}</h4>
        <Rows
          rows={[
            ["Expense", money(excom.submittedAmount)],
            ["ExCom approval needed from", money(excom.threshold)],
            [
              "ExCom approval evidence",
              provided ? "Evidence provided (not verified)" : "Evidence missing",
            ],
            ["Status", reviewStatus],
          ]}
        />
        <ExcomEvidence
          evidence={expense.excomEvidence}
          types={policy?.representationRules?.evidenceTypes ?? {}}
          disabled={disabled}
          onChange={onEvidenceChange}
        />
      </article>,
    );
  }

  return cards.length ? (
    <section className="policy-exceptions" id="policy-check" aria-live="polite">
      {cards}
    </section>
  ) : null;
}

// Evidence of ExCom approval. Only its details are saved: ReceiptFlow has no
// file storage yet, and it does not check what the evidence says.
export function ExcomEvidence({ evidence, types, disabled, onChange }) {
  const current = evidence ?? { type: "", reference: "", fileName: "", mimeType: "", size: 0 };
  const update = (changes) => {
    const next = { ...current, ...changes };
    onChange(next.type ? next : null);
  };
  return (
    <div className="excom-evidence">
      <h5>ExCom approval evidence</h5>
      <label className="field">
        <span>Evidence type</span>
        <select
          id="excom-evidence-type"
          value={current.type}
          disabled={disabled}
          onChange={(event) => update({ type: event.target.value })}
        >
          <option value="">Select evidence type</option>
          {Object.entries(types).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Who approved and when</span>
        <input
          id="excom-evidence-reference"
          value={current.reference}
          maxLength={500}
          disabled={disabled || !current.type}
          placeholder="e.g. Email from the ExCom chair, 3 Oct 2026"
          onChange={(event) => update({ reference: event.target.value })}
        />
      </label>
      <label className="field">
        <span>Screenshot or document</span>
        <input
          id="excom-evidence-file"
          type="file"
          accept="image/*,.pdf"
          disabled={disabled || !current.type}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              update({ fileName: file.name, mimeType: file.type, size: file.size });
            }
          }}
        />
      </label>
      {current.fileName && <p className="muted">Attached: {current.fileName}</p>}
      <p className="muted">
        The file itself is not stored yet: ReceiptFlow keeps its name and these
        details. ReceiptFlow does not verify the approval; your manager reviews it.
      </p>
    </div>
  );
}
