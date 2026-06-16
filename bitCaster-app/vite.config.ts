import path from "path";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const require = createRequire(import.meta.url);

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
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
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
      {
        find: /^@bitcaster\/client-sdk\/(.+)$/,
        replacement: path.resolve(__dirname, "../bitcaster-client-sdk/src/$1"),
      },
      {
        find: /^@bitcaster\/client-sdk$/,
        replacement: path.resolve(
          __dirname,
          "../bitcaster-client-sdk/src/index.ts",
        ),
      },
      {
        find: /^@bitcaster\/swap-protocol\/(.+)$/,
        replacement: path.resolve(
          __dirname,
          "../bitCaster-swap-protocol/src/$1",
        ),
      },
      {
        find: /^@cashu\/cashu-ts$/,
        replacement: path.resolve(__dirname, "../cashu-ts/lib/cashu-ts.es.js"),
      },
      {
        find: /^@noble\/curves\/secp256k1\.js$/,
        replacement: require.resolve("@noble/curves/secp256k1.js"),
      },
      {
        find: /^@noble\/hashes\/sha2\.js$/,
        replacement: require.resolve("@noble/hashes/sha2.js"),
      },
    ],
  },
  // kormir-wasm is imported with a relative path (`./kormir-wasm-pkg/kormir_wasm`),
  // so it naturally bypasses Vite's dep optimizer — no `optimizeDeps.exclude`
  // needed. The ~3MB .wasm sibling is loaded at runtime via the generated ES
  // shim's `fetch()` call and Vite picks it up as an asset automatically.
  server: {
    port: parseInt(process.env.PORT || "5273"),
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
          xfwd: true,
        },
        "/hubs": {
          target: serverTarget,
          changeOrigin: true,
          xfwd: true,
          ws: true,
        },
      };
    })(),
  },
});
