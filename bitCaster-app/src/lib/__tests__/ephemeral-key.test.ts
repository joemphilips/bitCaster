import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { generateEphemeralKeyPair } from "../ephemeral-key";

describe("generateEphemeralKeyPair", () => {
  it("returns a 64-char hex privkey and a 66-char compressed pubkey", () => {
    const { privkey, pubkey } = generateEphemeralKeyPair();
    expect(privkey).toMatch(/^[0-9a-f]{64}$/);
    expect(pubkey).toMatch(/^(02|03)[0-9a-f]{64}$/);
  });

  it("produces a pubkey that the secp256k1 library accepts as a valid point", () => {
    // Round-trips through the curve: if the pubkey is malformed, getSharedSecret
    // would throw. This is a cheap on-curve check without invoking a verifier.
    const { privkey, pubkey } = generateEphemeralKeyPair();
    const recomputed = secp256k1.getPublicKey(hexToBytes(privkey), true);
    expect(bytesToHex(recomputed)).toBe(pubkey);
  });

  it("produces distinct keys across calls", () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    expect(a.privkey).not.toBe(b.privkey);
    expect(a.pubkey).not.toBe(b.pubkey);
  });
});

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
