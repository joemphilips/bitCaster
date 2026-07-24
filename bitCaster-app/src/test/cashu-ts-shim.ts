/**
 * Vitest compatibility shim for @cashu/cashu-ts v3.
 *
 * cashu-ts v3 renamed CashuMint → Mint and CashuWallet → Wallet, but
 * @nostr-dev-kit/ndk-wallet still imports the old names. This shim
 * re-exports the real module with legacy aliases so ESM named-import
 * validation passes in the test environment.
 *
 * Wired up via resolve.alias in vitest.config.ts.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck — the real module path is not '@cashu/cashu-ts' here
export { Mint as CashuMint, Wallet as CashuWallet } from "@cashu/cashu-ts-real";
export * from "@cashu/cashu-ts-real";
