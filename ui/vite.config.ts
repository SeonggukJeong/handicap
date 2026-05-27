import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.HANDICAP_API ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  optimizeDeps: {
    // Monaco ships many small ESM modules. Pre-bundling them speeds up
    // first-time dev startup and prevents the worker-loader from racing.
    include: [
      "monaco-editor/esm/vs/editor/editor.api",
      "monaco-editor/esm/vs/editor/editor.worker",
    ],
  },
  worker: {
    format: "es",
  },
});
