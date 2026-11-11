import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "./",
  root: path.resolve(__dirname, "src/renderer"),
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // The renderer runs inside Electron 34 (Chromium 132); target that runtime
    // directly instead of transpiling against an unrelated browser matrix.
    target: "chrome132",
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/renderer"),
    },
  },
});
