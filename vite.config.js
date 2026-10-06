import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run build` writes to dist/ so the build can be checked without touching
// the deployed site. `npm run build:pages` writes to site/, the folder the
// GitHub Pages workflow publishes.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Relative asset URLs so the app works from a GitHub Pages project path.
  base: "./",
  build: {
    outDir: mode === "pages" ? "site" : "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
}));
