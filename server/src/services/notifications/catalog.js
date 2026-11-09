// What can be configured in Management, derived from what the backend really supports.
import { env } from "../../config/env.js";
import { anomalyRules } from "../anomaly/anomalyRules.js";

export const SEVERITY_LABEL = { info: "Informational", warning: "Warning", high: "High Risk" };

// Rules that can never raise a finding today: they only report "not evaluated"
// because their data is not connected (attendance, approval evidence) or the OCR
// provider does not supply the signal. A rule can name them, but they will not fire.
export const NEVER_FIRES = {
  meals_charged_while_on_leave: "Needs attendance and leave data, which is not connected.",
  expense_on_approved_leave_date: "Needs attendance and leave data, which is not connected.",
  higher_level_approval_required: "Needs approval-authority data, which is not connected.",
  ocr_provider_screening: "Only reports which provider signals are unavailable; it does not raise findings.",
};

export const ANOMALY_TYPE_IDS = anomalyRules.map((rule) => rule.id);
export const anomalyById = new Map(anomalyRules.map((rule) => [rule.id, rule]));

export const anomalyTypes = () =>
  anomalyRules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    severity: SEVERITY_LABEL[rule.severity] ?? "Warning",
    source: rule.source ?? "Anomalies reference",
    available: !NEVER_FIRES[rule.id],
    ...(NEVER_FIRES[rule.id] ? { unavailableReason: NEVER_FIRES[rule.id] } : {}),
  }));

export const channelOptions = () => [
  { id: "in_app", label: "In-app notification", available: true },
  env.notifications.emailProvider === "mock"
    ? { id: "email", label: "Email (mock: recorded, nothing is sent)", available: true, mock: true }
    : { id: "email", label: "Email", available: false, unavailableReason: "Email delivery is not connected yet." },
];

export const recipientTypeOptions = () => [
  { id: "user", label: "Specific person", available: true },
  { id: "finance_admins", label: "All Finance administrators", available: true },
  {
    id: "employee_manager",
    label: "Employee's manager",
    available: false,
    unavailableReason: "Requires configuration: ReceiptFlow does not hold manager information yet.",
  },
];

export const channelAvailable = (channel) => channelOptions().some((option) => option.id === channel && option.available);
