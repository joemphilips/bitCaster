import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";

/**
 * A one-shot secp256k1 keypair generated per order. The pubkey is sent to the
 * matching engine so the eventual counterparty can encrypt atomic-swap
 * messages to it; the privkey stays in the browser.
 *
 * Both halves are hex so the store serialises cleanly to localStorage.
 */
export interface EphemeralKeyPair {
  /** 32-byte scalar, hex (64 chars). */
  privkey: string;
  /** 33-byte compressed point, hex (66 chars, starts 02/03). */
  pubkey: string;
}

/** Produce a fresh keypair. Uses crypto.getRandomValues under the hood. */
export function generateEphemeralKeyPair(): EphemeralKeyPair {
  const privBytes = secp256k1.utils.randomSecretKey();
  const pubBytes = secp256k1.getPublicKey(privBytes, true); // compressed
  return {
    privkey: bytesToHex(privBytes),
    pubkey: bytesToHex(pubBytes),
  };
}
