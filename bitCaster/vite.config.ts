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
    alias: {
      "@": "/src",
    },
  },
  server: {
    port: parseInt(process.env.PORT || "5173"),
    host: true,
    proxy: {
      "/v1": {
        target: process.env.services__mintd__mint_api__0 ?? "http://localhost:8085",
        changeOrigin: true,
      },
    },
  },
});
