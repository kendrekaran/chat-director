import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "web",
  resolve: {
    alias: {
      "@shared": resolve(import.meta.dirname, "src/shared/index.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/media": "http://127.0.0.1:8787",
      "/overlay": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist/web"),
    emptyOutDir: true,
  },
});
