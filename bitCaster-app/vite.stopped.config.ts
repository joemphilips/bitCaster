import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The build of the stopped page (src/stopped). A stopped host serves only this build
// (server.js). stopped/public/sw.js replaces the service worker of the cached app.
// The build loads nothing from another origin.
export default defineConfig({
  root: path.resolve(__dirname, "stopped"),
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "dist-stopped"),
    emptyOutDir: true,
  },
  resolve: {
    alias: [{ find: "@", replacement: path.resolve(__dirname, "src") }],
  },
});
