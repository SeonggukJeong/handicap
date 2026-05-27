import { defineConfig } from "vitest/config";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Vite plugin that resolves `?worker` imports in the test environment.
 *
 * The `?worker` suffix is handled by Vite's built-in worker plugin during a
 * real build, but vitest's test runner does not load that plugin. Without this
 * shim, vite:import-analysis fails on any `import Foo from "...?worker"` line
 * with "Does the file exist?" even when the module itself is mocked.
 *
 * Strategy: intercept at the `resolveId` hook (before import-analysis bails)
 * and strip the `?worker` suffix so the normal module-resolution path (plus
 * the vi.mock factory in the test) can take over.
 */
function workerQueryPlugin(): Plugin {
  return {
    name: "test:strip-worker-query",
    enforce: "pre",
    resolveId(id) {
      if (id.endsWith("?worker")) {
        // Return the raw path without the query string as the resolved ID.
        // vi.mock intercepts this module ID at import time, so the factory
        // stub in the test file provides the actual runtime value.
        return id.slice(0, -"?worker".length);
      }
    },
  };
}

export default defineConfig({
  plugins: [workerQueryPlugin()],
  resolve: {
    // Monaco only publishes a `module` field (no `exports` map, no `main`).
    // Vite's dev server handles this automatically, but Vitest's node
    // resolution falls back to the package root which has no CJS entry.
    // Point bare `monaco-editor` (exact match, NOT prefix) at its ESM API
    // entry so vi.mock can intercept it before the test import.
    // Use regex find to avoid prefix-matching monaco-editor/* sub-paths.
    alias: [
      {
        find: /^monaco-editor$/,
        replacement: path.resolve(
          __dirname,
          "node_modules/monaco-editor/esm/vs/editor/editor.api.js",
        ),
      },
    ],
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/__tests__/**/*.{test,spec}.{ts,tsx}"],
  },
});
