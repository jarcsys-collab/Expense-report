import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MsalProvider } from "@azure/msal-react";
import { App } from "./App";
import { initializeEntra, msalInstance } from "./services/entraAuth";
import { applyTheme, getStoredTheme } from "./utils/theme";
import "./styles/index.css";
import "./styles/mobile.css";

// Apply the saved theme before the first render to avoid a flash of the wrong theme.
applyTheme(getStoredTheme());

// Finish a Microsoft sign-in redirect (if any) before the router reads the URL.
initializeEntra().finally(() => {
  createRoot(document.getElementById("root")).render(
    <StrictMode>
      {msalInstance ? (
        <MsalProvider instance={msalInstance}>
          <App />
        </MsalProvider>
      ) : (
        <App />
      )}
    </StrictMode>,
  );
});
