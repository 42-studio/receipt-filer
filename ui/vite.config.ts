import { cpSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

// Dev: the Worker (npm run dev:ui at the repo root) serves /api and /oauth on 8788.
const worker = "http://localhost:8788";

// Keep the browser's Host: the Worker refuses a change whose Origin is not the host it was asked for.
const toWorker: ProxyOptions = { target: worker, changeOrigin: false };

// pdf.js loads these at run time by URL; copy them where Vite serves and builds public files (git ignores the copy).
// config(), not buildStart(): the dev server lists public files before buildStart runs.
const pdfjsAssets = { name: "pdfjs-assets", config() {
  for (const dir of ["wasm", "cmaps", "standard_fonts", "iccs"]) {
    cpSync(path.resolve(import.meta.dirname, "node_modules/pdfjs-dist", dir), path.resolve(import.meta.dirname, "public/pdfjs", dir), { recursive: true });
  }
} };

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets],
  resolve: { alias: { "@api": path.resolve(import.meta.dirname, "../src/ui/api-types.ts"), "@stats": path.resolve(import.meta.dirname, "../src/ui/stats.ts"), "@": path.resolve(import.meta.dirname, "./src") } },
  // "^/__": the dev worker's data-scenario routes (dev/worker.ts), used by the dev panel
  server: { port: 5173, proxy: { "/api": toWorker, "/oauth": toWorker, "^/__(scenarios?|new|reset)": toWorker } },
});
