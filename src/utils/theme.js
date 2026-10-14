export const THEME_STORAGE_KEY = "receiptflow-theme";
// Light (teal and white) is the default; a saved "dark" choice is kept.
export function getStoredTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#121616" : "#ffffff");
}
