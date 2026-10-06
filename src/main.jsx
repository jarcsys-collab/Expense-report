import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, getStoredTheme } from "./utils/theme";
import "./styles/index.css";
import "./styles/mobile.css";

// Apply the saved theme before the first render to avoid a flash of the wrong theme.
applyTheme(getStoredTheme());

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
