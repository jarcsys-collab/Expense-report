import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { readProductionEnv, stagingBuildProblems } from "./scripts/checkStagingEnv.mjs";

const OUT_DIRS = { pages: "site", staging: "dist-staging" };

// `npm run build` writes to dist/ so the build can be checked without touching
// the deployed site. `npm run build:pages` writes to site/, the folder the
// GitHub Pages workflow publishes. `npm run build:staging` writes to dist-staging/
// (never committed), and refuses values that point at production.
export default defineConfig(({ mode }) => {
  if (mode === "staging") {
    const problems = stagingBuildProblems(loadEnv("staging", process.cwd(), "VITE_"), readProductionEnv());
    if (problems.length) throw new Error(`Staging build refused:\n  - ${problems.join("\n  - ")}`);
  }
  return {
    plugins: [react()],
    // Relative asset URLs so the app works from a GitHub Pages project path.
    base: "./",
    build: {
      outDir: OUT_DIRS[mode] ?? "dist",
      emptyOutDir: true,
      sourcemap: false,
    },
  };
});
