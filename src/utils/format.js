export const formatCurrency = (amount, currency = "PHP") =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amount);
export const formatDate = (value) =>
  new Date(
    value.length === 10 ? value + "T12:00:00" : value,
  ).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
export const initials = (name) =>
  name
    .split(" ")
    .map((item) => item[0])
    .slice(0, 2)
    .join("");
export const createId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
export const sanitizeFileName = (name) =>
  name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 160);
