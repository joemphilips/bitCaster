import { defineConfig } from "vitest/config";
import path from "path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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
      // @cashu/cashu-ts v3 renamed CashuMint → Mint, CashuWallet → Wallet.
      // ndk-wallet still imports the old names. Route through a shim that
      // re-exports with legacy aliases.  The shim itself imports
      // '@cashu/cashu-ts-real' which resolves to the actual package.
      { find: "@cashu/cashu-ts-real", replacement: "@cashu/cashu-ts" },
      { find: "@cashu/cashu-ts", replacement: "/src/test/cashu-ts-shim.ts" },
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
});
