import { useCallback, useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { api } from "../../services/api";
import { formatDate } from "../../utils/format";
import { formatDuration, formatRate, formatUsd, lastDays } from "../../utils/notificationRules";
import { EmptyState } from "../common/EmptyState";
import { ErrorState } from "../common/ErrorState";
import { TableSkeleton } from "../common/TableSkeleton";
import { FIELD_LABELS } from "../receipts/OcrFieldSummary";

const OUTCOMES = {
  success: "Successful",
  failed: "Failed",
  duplicate_retry: "Duplicate: retry",
  duplicate_reused: "Duplicate: reading reused",
  skipped_unsupported: "Skipped: unsupported file",
};
const PROVIDERS = { google_document_ai: "Google Document AI", veryfi: "Veryfi" };
const providerName = (id) => PROVIDERS[id] ?? id;

function Stat({ label, value, note }) {
  return (
    <div className="stat-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

const bucketLabel = (start, unit) => {
  const date = new Date(start);
  const manila = new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (unit === "month") return manila.slice(0, 7);
  return unit === "week" ? `Week of ${formatDate(manila)}` : formatDate(manila);
};

// One measure in one hue: scans and cost are never drawn on the same axis.
export function BucketChart({ title, buckets, unit, measure }) {
  const value = (bucket) => (measure === "cost" ? bucket.estimatedCostUsd : bucket.scans);
  const format = (number) => (measure === "cost" ? formatUsd(number) : number.toLocaleString("en-US"));
  const max = Math.max(...buckets.map(value), 0);
  return (
    <figure className="bucket-chart">
      <figcaption>{title}</figcaption>
      {max === 0 ? (
        <p className="muted">Nothing to show for this period.</p>
      ) : (
        <>
          <div className="bucket-scale" aria-hidden="true">
            Highest: {format(max)}
          </div>
          <div className="bucket-bars" role="img" aria-label={`${title}. Highest value ${format(max)}. The table below has every value.`}>
            {buckets.map((bucket) => (
              <div key={bucket.start} className="bucket-bar" tabIndex={0} aria-label={`${bucketLabel(bucket.start, unit)}: ${format(value(bucket))}`}>
                <i style={{ height: `${Math.max(2, (value(bucket) / max) * 100)}%` }} />
                <span className="bucket-tooltip">
                  {bucketLabel(bucket.start, unit)}
                  <strong>{format(value(bucket))}</strong>
                </span>
              </div>
            ))}
          </div>
          <div className="bucket-axis" aria-hidden="true">
            <span>{bucketLabel(buckets[0].start, unit)}</span>
            {buckets.length > 1 && <span>{bucketLabel(buckets[buckets.length - 1].start, unit)}</span>}
          </div>
          <details className="bucket-table">
            <summary>Show as a table</summary>
            <table className="management-table compact">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Scans</th>
                  <th>Estimated cost</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((bucket) => (
                  <tr key={bucket.start}>
                    <td data-label="Period">{bucketLabel(bucket.start, unit)}</td>
                    <td data-label="Scans">{bucket.scans}</td>
                    <td data-label="Estimated cost">{formatUsd(bucket.estimatedCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </figure>
  );
}

function CostRows({ title, first, rows, nameOf }) {
  return (
    <section className="panel analytics-section">
      <h3>{title}</h3>
      {rows.length ? (
        <table className="management-table compact">
          <thead>
            <tr>
              <th>{first}</th>
              <th>Scans</th>
              <th>Estimated cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={nameOf(row)}>
                <td data-label={first}>{nameOf(row)}</td>
                <td data-label="Scans">{row.scans}</td>
                <td data-label="Estimated cost">{formatUsd(row.estimatedCostUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Nothing for this period.</p>
      )}
    </section>
  );
}

export function AnalyticsPanel() {
  const [filters, setFilters] = useState(() => ({ ...lastDays(30), employeeId: "", department: "", provider: "", outcome: "" }));
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unit, setUnit] = useState("day");
  const [measure, setMeasure] = useState("scans");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setReport(await api.getOcrAnalytics(filters));
    } catch (problem) {
      setError(problem.message);
    } finally {
      setLoading(false);
    }
  }, [filters]);
  useEffect(() => {
    load();
  }, [load]);
  const set = (field) => (event) => setFilters((current) => ({ ...current, [field]: event.target.value }));

  const options = report?.options;
  const buckets = report ? { day: report.usage.byDay, week: report.usage.byWeek, month: report.usage.byMonth }[unit] : [];
  const budget = report?.cost.budget;

  return (
    <>
      <div className="analytics-filters">
        <label className="field">
          From
          <input type="date" value={filters.from} max={filters.to} onChange={set("from")} />
        </label>
        <label className="field">
          To
          <input type="date" value={filters.to} min={filters.from} onChange={set("to")} />
        </label>
        <label className="field">
          Employee
          <select value={filters.employeeId} onChange={set("employeeId")}>
            <option value="">All employees</option>
            {options?.employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Department
          <select value={filters.department} onChange={set("department")}>
            <option value="">All departments</option>
            {options?.departments.map((department) => (
              <option key={department}>{department}</option>
            ))}
          </select>
        </label>
        <label className="field">
          OCR provider
          <select value={filters.provider} onChange={set("provider")}>
            <option value="">All providers</option>
            {options?.providers.map((provider) => (
              <option key={provider} value={provider}>
                {providerName(provider)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Processing status
          <select value={filters.outcome} onChange={set("outcome")}>
            <option value="">All statuses</option>
            {Object.entries(OUTCOMES).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading && !report ? (
        <TableSkeleton />
      ) : error ? (
        <ErrorState message={error} retry={load} />
      ) : !report.usage.total && !report.quality.expensesMeasured ? (
        <EmptyState title="No scans for this period" message="Scans are measured from the day this dashboard is deployed. Earlier scans are not included." />
      ) : (
        <div className="analytics-body" aria-busy={loading}>
          {budget?.exceeded && (
            <div className="management-banner danger" role="alert">
              <TriangleAlert size={18} aria-hidden="true" />
              <p>
                <strong>Over the monthly budget.</strong> Estimated {formatUsd(report.cost.monthToDateUsd)} of {formatUsd(budget.monthlyUsd)} this month.
              </p>
            </div>
          )}
          {budget && !budget.exceeded && budget.warning && (
            <div className="management-banner" role="status">
              <TriangleAlert size={18} aria-hidden="true" />
              <p>
                <strong>Close to the monthly budget.</strong> Estimated {formatUsd(report.cost.monthToDateUsd)} of {formatUsd(budget.monthlyUsd)} this month.
              </p>
            </div>
          )}
          <h2 className="analytics-heading">Usage</h2>
          <div className="stat-grid">
            <Stat label="Total scans" value={report.usage.total} />
            <Stat label="Successful" value={report.usage.success} />
            <Stat label="Failed" value={report.usage.failed} note={report.usage.failureRate !== null ? `${formatRate(report.usage.failureRate)} of provider calls` : undefined} />
            <Stat label="Duplicates caught" value={report.usage.duplicates} note="No OCR request made" />
            <Stat label="Skipped" value={report.usage.skipped} note="Unsupported files" />
            <Stat label="Average time" value={formatDuration(report.usage.averageDurationMs)} />
          </div>
          <section className="panel analytics-section">
            <div className="analytics-chart-controls">
              <div className="segmented" role="group" aria-label="Period">
                {[["day", "Day"], ["week", "Week"], ["month", "Month"]].map(([key, label]) => (
                  <button key={key} className={unit === key ? "active" : ""} aria-pressed={unit === key} onClick={() => setUnit(key)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="segmented" role="group" aria-label="Measure">
                {[["scans", "Scans"], ["cost", "Estimated cost"]].map(([key, label]) => (
                  <button key={key} className={measure === key ? "active" : ""} aria-pressed={measure === key} onClick={() => setMeasure(key)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <BucketChart title={measure === "cost" ? `Estimated cost by ${unit}` : `Scans by ${unit}`} buckets={buckets} unit={unit} measure={measure} />
            {report.usage.byProvider.length > 0 && (
              <p className="muted">
                {report.usage.byProvider.map((row) => `${providerName(row.provider)}: ${row.scans} scan${row.scans === 1 ? "" : "s"}`).join(" · ")}
              </p>
            )}
          </section>

          <h2 className="analytics-heading">Estimated cost</h2>
          <p className="muted">{report.cost.note} List price used: {formatUsd(report.cost.pricing.google.usdPerUnit)} per {report.cost.pricing.google.pagesPerUnit} pages (checked on {formatDate(report.cost.pricing.google.confirmedOn)}). Failed requests are not billed by Google.</p>
          <div className="stat-grid">
            <Stat label="This period" value={formatUsd(report.cost.estimatedCostUsd)} note={`${report.cost.billableScans} billable scan${report.cost.billableScans === 1 ? "" : "s"}`} />
            <Stat label="Today" value={formatUsd(report.cost.todayUsd)} />
            <Stat label="This month" value={formatUsd(report.cost.monthToDateUsd)} note={budget ? `${formatRate(budget.usedRate)} of ${formatUsd(budget.monthlyUsd)} budget` : "No budget set"} />
            {report.cost.unknownBilling > 0 && <Stat label="Billing unknown" value={report.cost.unknownBilling} note="Timed out on our side; not in the estimate" />}
            {report.cost.scansWithoutPrice > 0 && <Stat label="No price set" value={report.cost.scansWithoutPrice} note="Scans by a provider with no configured price" />}
          </div>
          <div className="analytics-columns">
            <CostRows title="By employee" first="Employee" rows={report.cost.byEmployee} nameOf={(row) => row.name} />
            <CostRows title="By department" first="Department" rows={report.cost.byDepartment} nameOf={(row) => row.department} />
          </div>

          <h2 className="analytics-heading">OCR quality</h2>
          <div className="stat-grid">
            <Stat label="Correction rate" value={formatRate(report.quality.correctionRate)} note="Scanned fields the employee changed" />
            <Stat label="Missing fields" value={formatRate(report.quality.missingRate)} note="Empty after review" />
            <Stat label="Confirmation rate" value={formatRate(report.quality.confirmationRate)} note={`${report.quality.confirmationsAnswered} answered, ${report.quality.confirmationsAwaiting} waiting`} />
            <Stat label="Requests measured" value={report.quality.expensesMeasured} note="Saved from a scan" />
          </div>
          <section className="panel analytics-section">
            <h3>By field, most corrected first</h3>
            {report.quality.fields.length ? (
              <table className="management-table compact scrolls">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Average confidence</th>
                    <th>Corrected</th>
                    <th>Confirmed</th>
                    <th>Missing after review</th>
                    <th>Not read by the scan</th>
                  </tr>
                </thead>
                <tbody>
                  {report.quality.fields.map((field) => (
                    <tr key={field.field}>
                      <td data-label="Field">{FIELD_LABELS[field.field] ?? field.field}</td>
                      <td data-label="Average confidence">{field.averageConfidence === null ? "—" : `${Math.round(field.averageConfidence * 100)}%`}</td>
                      <td data-label="Corrected">{field.corrected}</td>
                      <td data-label="Confirmed">{field.confirmed}</td>
                      <td data-label="Missing after review">{field.missing}</td>
                      <td data-label="Not read by the scan">{field.missingFromScanRate === null ? "—" : formatRate(field.missingFromScanRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">Nothing for this period.</p>
            )}
          </section>
          {report.quality.failures.length > 0 && (
            <section className="panel analytics-section">
              <h3>Processing failures</h3>
              <ul className="analytics-failures">
                {report.quality.failures.map((failure) => (
                  <li key={failure.code}>
                    <code>{failure.code}</code>
                    <span>{failure.count}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}
