import { createContext, useEffect, useState } from "react";
import { THEME_STORAGE_KEY, applyTheme, getStoredTheme } from "../utils/theme";

export const ThemeContext = createContext(null);
export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(getStoredTheme);
  const [saved, setSaved] = useState(true);
  function setTheme(nextTheme) {
    setThemeState(nextTheme);
    applyTheme(nextTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      setSaved(true);
    } catch {
      setSaved(false);
    }
  }
  useEffect(() => {
    applyTheme(theme);
    const onStorage = (event) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        setThemeState(event.newValue === "light" ? "light" : "dark");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [theme]);
  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme,
        saved,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
