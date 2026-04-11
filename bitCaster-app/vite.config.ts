import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png", "masked-icon.svg"],
      manifest: {
        name: "bitCaster – Bitcoin Prediction Markets",
        short_name: "bitCaster",
        description:
          "Free, anonymous, Bitcoin-native prediction markets powered by Cashu ecash",
        theme_color: "#f7931a",
        background_color: "#0a0a0a",
        display: "standalone",
        scope: "/",
        start_url: "/",
        icons: [
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\/v1\//,
            handler: "NetworkFirst",
            options: {
              cacheName: "mint-api-cache",
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 5,
              },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: [
      { find: "@", replacement: "/src" },
      { find: /^@cashu\/cashu-ts$/, replacement: path.resolve(__dirname, "src/lib/cashu-ts-compat.ts") },
    ],
  },
  // kormir-wasm is imported with a relative path (`./kormir-wasm-pkg/kormir_wasm`),
  // so it naturally bypasses Vite's dep optimizer — no `optimizeDeps.exclude`
  // needed. The ~3MB .wasm sibling is loaded at runtime via the generated ES
  // shim's `fetch()` call and Vite picks it up as an asset automatically.
  server: {
    port: parseInt(process.env.PORT || "5173"),
    strictPort: true,
    host: true,
    allowedHosts: "all",
    proxy: (() => {
      // BITCASTER_SERVER_URL lets parallel worktree runners point /api and /hubs
      // at a per-slot matching engine (e.g. http://localhost:5100). Falls back to
      // the Aspire-provided env var for the single-worktree workflow, then to
      // the default localhost:5000.
      const serverTarget =
        process.env.BITCASTER_SERVER_URL ??
        process.env.services__apiservice__http__0 ??
        "http://localhost:5000";
      const mintTarget =
        process.env.BITCASTER_MINT_URL ??
        process.env.services__mintd__mint_api__0 ??
        "http://localhost:8085";
      return {
        "/v1": {
          target: mintTarget,
          changeOrigin: true,
          ws: true,
        },
        "/api": {
          target: serverTarget,
          changeOrigin: true,
        },
        "/hubs": {
          target: serverTarget,
          changeOrigin: true,
          ws: true,
        },
      };
    })(),
  },
});
