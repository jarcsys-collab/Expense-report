// Organization-wide OCR analytics, from aggregation queries only. Responses hold counts,
// rates, scores and estimated costs: never receipt images, text or merchant details.
import { env } from "../config/env.js";
import { Expense } from "../models/Expense.js";
import { OcrScanEvent } from "../models/OcrScanEvent.js";
import { IMPORTANT_FIELDS } from "./documentAiNormalizer.js";
import { activeOcrProvider } from "./ocrProvider.js";

// Days, weeks and months as the business sees them.
export const REPORT_TIMEZONE = "Asia/Manila";
const MANILA_OFFSET_MS = 8 * 3600 * 1000;

/** Start of a YYYY-MM-DD day in Manila, as a Date. */
export const manilaDayStart = (day) => new Date(new Date(`${day}T00:00:00Z`).getTime() - MANILA_OFFSET_MS);
const manilaDay = (date) => new Date(date.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);

const round = (value, digits = 4) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);
const rate = (part, whole) => (whole > 0 ? round(part / whole) : null);

const COST = { $sum: { $ifNull: ["$estimatedCostUsd", 0] } };
const bucketStage = (unit) => [
  { $group: { _id: { $dateTrunc: { date: "$at", unit, timezone: REPORT_TIMEZONE, ...(unit === "week" ? { startOfWeek: "monday" } : {}) } }, scans: { $sum: 1 }, estimatedCostUsd: COST } },
  { $sort: { _id: 1 } },
  { $limit: 400 },
];

/** Turns the query's filters into event and expense matches. Pure, for tests. */
export function buildMatches({ from, to, employeeId, department, provider, outcome }) {
  const range = { $gte: manilaDayStart(from), $lt: new Date(manilaDayStart(to).getTime() + 24 * 3600 * 1000) };
  const people = { ...(employeeId ? { employeeId } : {}), ...(department ? { department } : {}) };
  return {
    events: { at: range, ...people, ...(provider ? { provider } : {}), ...(outcome ? { outcome } : {}) },
    expenses: {
      createdAt: range,
      ocrQuality: { $type: "object" },
      incompleteDraft: { $ne: true },
      ...people,
      ...(provider ? { "ocrQuality.provider": provider } : {}),
    },
  };
}

export function shapeEventTotals(rows) {
  const by = Object.fromEntries(rows.map((row) => [row._id, row]));
  const count = (outcome) => by[outcome]?.count ?? 0;
  const success = count("success");
  const failed = count("failed");
  const duplicates = count("duplicate_retry") + count("duplicate_reused");
  const skipped = count("skipped_unsupported");
  const total = success + failed + duplicates + skipped;
  return { total, success, failed, duplicates, duplicateRetries: count("duplicate_retry"), duplicateReused: count("duplicate_reused"), skipped, failureRate: rate(failed, success + failed), avoidedRequests: duplicates };
}

export function shapeFieldQuality(statusRows, confidenceRows, missingRows, scanCount) {
  const fields = new Map();
  const entry = (field) => {
    if (!fields.has(field)) fields.set(field, { field, extracted: 0, confirmed: 0, corrected: 0, provided: 0, missing: 0, averageConfidence: null, missingFromScanRate: null });
    return fields.get(field);
  };
  for (const { _id, count } of statusRows) entry(_id.field)[_id.status] = count;
  for (const { _id, average } of confidenceRows) entry(_id).averageConfidence = round(average, 3);
  for (const { _id, count } of missingRows) entry(_id).missingFromScanRate = rate(count, scanCount);
  const list = [...fields.values()].map((item) => {
    const total = item.extracted + item.confirmed + item.corrected + item.provided + item.missing;
    // A field the scan always looks for and never missed is 0%, not "unknown".
    const notMissed = scanCount > 0 && IMPORTANT_FIELDS.includes(item.field) ? 0 : null;
    return {
      ...item,
      missingFromScanRate: item.missingFromScanRate ?? notMissed,
      reviewed: total,
      correctionRate: rate(item.corrected, total),
      missingRate: rate(item.missing, total),
    };
  });
  return list.sort((a, b) => (b.corrected - a.corrected) || a.field.localeCompare(b.field));
}

export async function buildOcrAnalytics(filters) {
  const { events, expenses } = buildMatches(filters);
  const [facets] = await OcrScanEvent.aggregate([
    { $match: events },
    {
      $facet: {
        outcomes: [{ $group: { _id: "$outcome", count: { $sum: 1 } } }],
        cost: [
          {
            $group: {
              _id: null,
              estimatedCostUsd: COST,
              billableUnits: { $sum: "$billableUnits" },
              billableScans: { $sum: { $cond: [{ $eq: ["$billable", "yes"] }, 1, 0] } },
              unknownBilling: { $sum: { $cond: [{ $eq: ["$billable", "unknown"] }, 1, 0] } },
              noEstimate: { $sum: { $cond: [{ $and: [{ $eq: ["$billable", "yes"] }, { $eq: ["$estimatedCostUsd", null] }] }, 1, 0] } },
            },
          },
        ],
        duration: [
          { $match: { outcome: { $in: ["success", "failed"] }, durationMs: { $type: "number" } } },
          { $group: { _id: null, averageMs: { $avg: "$durationMs" }, maxMs: { $max: "$durationMs" } } },
        ],
        byDay: bucketStage("day"),
        byWeek: bucketStage("week"),
        byMonth: bucketStage("month"),
        byProvider: [{ $group: { _id: "$provider", scans: { $sum: 1 }, estimatedCostUsd: COST } }, { $sort: { scans: -1 } }],
        byEmployee: [
          { $group: { _id: "$employeeId", name: { $last: "$employeeName" }, department: { $last: "$department" }, scans: { $sum: 1 }, estimatedCostUsd: COST } },
          { $sort: { estimatedCostUsd: -1, scans: -1 } },
          { $limit: 25 },
        ],
        byDepartment: [{ $group: { _id: "$department", scans: { $sum: 1 }, estimatedCostUsd: COST } }, { $sort: { estimatedCostUsd: -1, scans: -1 } }, { $limit: 25 }],
        failures: [{ $match: { outcome: "failed" } }, { $group: { _id: "$errorCode", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 15 }],
        confidence: [{ $unwind: "$confidence" }, { $group: { _id: "$confidence.field", average: { $avg: "$confidence.score" } } }],
        missing: [{ $unwind: "$missingFields" }, { $group: { _id: "$missingFields", count: { $sum: 1 } } }],
      },
    },
  ]);

  const [quality] = await Expense.aggregate([
    { $match: expenses },
    {
      $facet: {
        expenses: [{ $count: "count" }],
        statuses: [{ $unwind: "$ocrQuality.fields" }, { $group: { _id: { field: "$ocrQuality.fields.field", status: "$ocrQuality.fields.status" }, count: { $sum: 1 } } }],
        reviews: [{ $unwind: "$ocrFieldReviews" }, { $group: { _id: "$ocrFieldReviews.status", count: { $sum: 1 } } }],
      },
    },
  ]);

  // Budget: this calendar month in Manila, whatever the filters show.
  const now = new Date();
  const today = manilaDay(now);
  const [spend] = await OcrScanEvent.aggregate([
    { $match: { at: { $gte: manilaDayStart(`${today.slice(0, 7)}-01`) } } },
    {
      $group: {
        _id: null,
        month: COST,
        today: { $sum: { $cond: [{ $gte: ["$at", manilaDayStart(today)] }, { $ifNull: ["$estimatedCostUsd", 0] }, 0] } },
      },
    },
  ]);
  const budget = env.ocrCost.monthlyBudgetUsd;
  const monthSpend = round(spend?.month ?? 0, 4);

  const totals = shapeEventTotals(facets.outcomes);
  const fields = shapeFieldQuality(quality.statuses, facets.confidence, facets.missing, (facets.outcomes.find((o) => o._id === "success")?.count ?? 0));
  const reviewCount = (status) => quality.reviews.find((row) => row._id === status)?.count ?? 0;
  const awaiting = reviewCount("needs_confirmation");
  const answered = reviewCount("confirmed") + reviewCount("corrected") + reviewCount("provided");
  const reviewed = fields.reduce((sum, item) => sum + item.reviewed, 0);
  const corrected = fields.reduce((sum, item) => sum + item.corrected, 0);
  const missing = fields.reduce((sum, item) => sum + item.missing, 0);
  const bucket = (rows) => rows.map((row) => ({ start: row._id, scans: row.scans, estimatedCostUsd: round(row.estimatedCostUsd, 4) }));

  return {
    filters,
    usage: {
      ...totals,
      averageDurationMs: facets.duration[0] ? Math.round(facets.duration[0].averageMs) : null,
      maxDurationMs: facets.duration[0]?.maxMs ?? null,
      byDay: bucket(facets.byDay),
      byWeek: bucket(facets.byWeek),
      byMonth: bucket(facets.byMonth),
      byProvider: facets.byProvider.map((row) => ({ provider: row._id ?? "unknown", scans: row.scans, estimatedCostUsd: round(row.estimatedCostUsd, 4) })),
    },
    quality: {
      expensesMeasured: quality.expenses[0]?.count ?? 0,
      fields,
      correctionRate: rate(corrected, reviewed),
      missingRate: rate(missing, reviewed),
      confirmationRate: rate(answered, answered + awaiting),
      confirmationsAnswered: answered,
      confirmationsAwaiting: awaiting,
      failures: facets.failures.map((row) => ({ code: row._id ?? "UNKNOWN", count: row.count })),
    },
    cost: {
      isEstimate: true,
      note: "Estimates from the configured list price, not Google Cloud billing data.",
      estimatedCostUsd: round(facets.cost[0]?.estimatedCostUsd ?? 0, 4),
      billableUnits: facets.cost[0]?.billableUnits ?? 0,
      billableScans: facets.cost[0]?.billableScans ?? 0,
      unknownBilling: facets.cost[0]?.unknownBilling ?? 0,
      scansWithoutPrice: facets.cost[0]?.noEstimate ?? 0,
      todayUsd: round(spend?.today ?? 0, 4),
      monthToDateUsd: monthSpend,
      budget: budget > 0 ? { monthlyUsd: budget, usedRate: rate(monthSpend, budget), exceeded: monthSpend > budget, warning: monthSpend >= budget * 0.8 } : null,
      byEmployee: facets.byEmployee.map((row) => ({ id: row._id, name: row.name ?? "Unknown", department: row.department ?? "", scans: row.scans, estimatedCostUsd: round(row.estimatedCostUsd, 4) })),
      byDepartment: facets.byDepartment.map((row) => ({ department: row._id || "Not set", scans: row.scans, estimatedCostUsd: round(row.estimatedCostUsd, 4) })),
      pricing: {
        activeProvider: activeOcrProvider(),
        google: { usdPerUnit: env.ocrCost.googleUsdPerUnit, pagesPerUnit: env.ocrCost.googlePagesPerUnit, source: "https://cloud.google.com/products/document-ai/pricing", confirmedOn: "2026-11-09" },
        veryfi: { usdPerDocument: env.ocrCost.veryfiUsdPerDocument || null },
      },
    },
  };
}

/** Options for the filter controls. */
export async function analyticsFilterOptions() {
  const [employees, departments, providers] = await Promise.all([
    OcrScanEvent.aggregate([{ $group: { _id: "$employeeId", name: { $last: "$employeeName" } } }, { $match: { _id: { $type: "string" } } }, { $sort: { name: 1 } }, { $limit: 500 }]),
    OcrScanEvent.distinct("department"),
    OcrScanEvent.distinct("provider"),
  ]);
  return {
    employees: employees.map((row) => ({ id: row._id, name: row.name ?? row._id })),
    departments: departments.filter(Boolean).sort(),
    providers: providers.filter(Boolean).sort(),
  };
}
