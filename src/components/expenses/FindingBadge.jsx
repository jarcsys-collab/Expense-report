import { Info, TriangleAlert } from "lucide-react";

export function FindingBadge({ expense }) {
  const openFindings = expense.policyViolations.filter(
    (violation) => violation.status === "Open",
  );
  return openFindings.length ? (
    <span
      className={`finding-badge ${openFindings.some((finding) => finding.severity === "High Risk") ? "risk" : "warning"}`}
    >
      <TriangleAlert size={13} />
      {openFindings.length} {openFindings.length === 1 ? "finding" : "findings"}
    </span>
  ) : (
    <span className="finding-badge neutral">
      <Info size={13} />
      No reported issues
    </span>
  );
}
