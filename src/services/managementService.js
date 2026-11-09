// /management (administrators; the server enforces it) and /notifications (own inbox).
import { resolveEndpoint } from "../config/api";
import { apiRequest } from "./httpClient";

const send = (name, params, body) => {
  const endpoint = resolveEndpoint(name, params);
  return apiRequest(endpoint.path, endpoint.method, body);
};
const withQuery = (name, params, query = {}) => {
  const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== "" && value !== null);
  const text = new URLSearchParams(entries).toString();
  return apiRequest(`${resolveEndpoint(name, params).path}${text ? `?${text}` : ""}`);
};

export const getManagementCatalog = () => send("managementCatalog");
export const searchDirectory = (q) => withQuery("managementDirectory", {}, { q });
export const getNotificationRules = async () => (await send("notificationRules")).rules;
export const createNotificationRule = (rule) => send("createNotificationRule", {}, rule);
export const updateNotificationRule = (id, rule) => send("updateNotificationRule", { id }, rule);
export const deleteNotificationRule = (id) => send("deleteNotificationRule", { id });
export const testNotificationRule = (id, confirm = false) => send("testNotificationRule", { id }, { confirm });
export const getNotificationEvents = (query) => withQuery("notificationEvents", {}, query);
export const getManagementAudit = (query) => withQuery("managementAudit", {}, query);
export const getOcrAnalytics = (query) => withQuery("ocrAnalytics", {}, query);

export const getMyNotifications = () => send("myNotifications");
export const getUnreadNotificationCount = async () => (await send("unreadNotifications")).unread;
export const markNotificationRead = (id) => send("readNotification", { id }, {});
export const markAllNotificationsRead = () => send("readAllNotifications", {}, {});
