// @ts-nocheck
// Compat shim: re-export everything from cashu-ts v3.x and alias the renamed classes
// so that ndk-wallet (which imports CashuWallet/CashuMint from v2.x names) still works.
// Uses direct file path to avoid circular alias (Vite redirects "@cashu/cashu-ts" here).
export * from "../../node_modules/@cashu/cashu-ts/lib/cashu-ts.es.js";
export { Mint as CashuMint, Wallet as CashuWallet } from "../../node_modules/@cashu/cashu-ts/lib/cashu-ts.es.js";
