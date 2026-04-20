import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    server: {
      deps: {
        // Force ndk-wallet and cashu-ts through Vite's transform pipeline so
        // the resolve.alias shim can add legacy CashuMint/CashuWallet aliases.
        inline: ["@nostr-dev-kit/ndk-wallet", "@cashu/cashu-ts"],
      },
    },
  },
  resolve: {
    alias: {
      "@": "/src",
      // @cashu/cashu-ts v3 renamed CashuMint → Mint, CashuWallet → Wallet.
      // ndk-wallet still imports the old names. Route through a shim that
      // re-exports with legacy aliases.  The shim itself imports
      // '@cashu/cashu-ts-real' which resolves to the actual package.
      "@cashu/cashu-ts-real": "@cashu/cashu-ts",
      "@cashu/cashu-ts": "/src/test/cashu-ts-shim.ts",
    },
  },
});
