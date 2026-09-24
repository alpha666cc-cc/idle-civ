import { defineConfig } from "vitest/config";

/**
 * Domain-layer tests run in plain Node: `src/game/` is deliberately React- and
 * DOM-free, so the save system and the content registry need no browser. The
 * config is separate from `vite.config.ts` so the React plugin is not loaded for
 * a test run.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tools/**/*.test.ts"],
  },
});