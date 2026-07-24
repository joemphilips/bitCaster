import { describe, expect, it } from "vitest";
import {
  generateEphemeralKeypair,
  computeSharedSecret,
  deriveEncryptionKey,
  encrypt,
  decrypt,
  hexToBytes,
} from "../ecdh";
import { secp256k1 } from "@noble/curves/secp256k1.js";

// ---------------------------------------------------------------------------
// Keypair generation
// ---------------------------------------------------------------------------

describe("generateEphemeralKeypair", () => {
  it("returns a 32-byte private key and a valid compressed 33-byte public key", () => {
    const kp = generateEphemeralKeypair();
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey.byteLength).toBe(32);
    expect(kp.publicKey).toMatch(/^(02|03)[0-9a-f]{64}$/);
  });

  it("produces distinct keypairs across calls", () => {
    const a = generateEphemeralKeypair();
    const b = generateEphemeralKeypair();
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it("public key is derivable from private key", () => {
    const kp = generateEphemeralKeypair();
    const recomputed = secp256k1.getPublicKey(kp.privateKey, true);
    const recomputedHex = Array.from(recomputed)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(recomputedHex).toBe(kp.publicKey);
  });
});

// ---------------------------------------------------------------------------
// ECDH shared secret agreement
// ---------------------------------------------------------------------------

describe("computeSharedSecret", () => {
  it("produces the same shared secret from both sides (DH property)", () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();

    const sharedAlice = computeSharedSecret(alice.privateKey, bob.publicKey);
    const sharedBob = computeSharedSecret(bob.privateKey, alice.publicKey);

    expect(sharedAlice).toEqual(sharedBob);
  });

  it("returns a 33-byte compressed EC point", () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();
    const shared = computeSharedSecret(alice.privateKey, bob.publicKey);
    expect(shared.byteLength).toBe(33);
  });

  it("throws on an invalid counterparty pubkey", () => {
    const alice = generateEphemeralKeypair();
    expect(() => computeSharedSecret(alice.privateKey, "deadbeef")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

describe("deriveEncryptionKey", () => {
  it("returns a CryptoKey usable for AES-GCM", async () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();
    const shared = computeSharedSecret(alice.privateKey, bob.publicKey);
    const key = await deriveEncryptionKey(shared);
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.type).toBe("secret");
    expect(key.algorithm.name).toBe("AES-GCM");
  });

  it("derives the same key from both sides (verified by encrypt/decrypt)", async () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();

    const sharedAlice = computeSharedSecret(alice.privateKey, bob.publicKey);
    const sharedBob = computeSharedSecret(bob.privateKey, alice.publicKey);

    const keyAlice = await deriveEncryptionKey(sharedAlice);
    const keyBob = await deriveEncryptionKey(sharedBob);

    // If the keys are identical, Alice can encrypt and Bob can decrypt
    const plaintext = "DH symmetry check";
    const ciphertext = await encrypt(keyAlice, plaintext);
    const recovered = await decrypt(keyBob, ciphertext);
    expect(recovered).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
// Encrypt / decrypt round-trip
// ---------------------------------------------------------------------------

describe("encrypt / decrypt", () => {
  it("round-trips an ASCII string", async () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();
    const shared = computeSharedSecret(alice.privateKey, bob.publicKey);
    const key = await deriveEncryptionKey(shared);

    const plaintext = "Hello, bitCaster!";
    const ciphertext = await encrypt(key, plaintext);
    const recovered = await decrypt(key, ciphertext);
    expect(recovered).toBe(plaintext);
  });

  it("round-trips a JSON payload", async () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();
    const shared = computeSharedSecret(alice.privateKey, bob.publicKey);
    const key = await deriveEncryptionKey(shared);

    const msg = JSON.stringify({ type: "adaptor-point", point: "deadbeef".repeat(8) });
    const ciphertext = await encrypt(key, msg);
    const recovered = await decrypt(key, ciphertext);
    expect(recovered).toBe(msg);
  });

  it("produces non-deterministic ciphertext (different IV each call)", async () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();
    const shared = computeSharedSecret(alice.privateKey, bob.publicKey);
    const key = await deriveEncryptionKey(shared);

    const ct1 = await encrypt(key, "same plaintext");
    const ct2 = await encrypt(key, "same plaintext");
    expect(ct1).not.toBe(ct2);
  });

  it("decrypting with wrong key throws", async () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();
    const carol = generateEphemeralKeypair();

    const correctShared = computeSharedSecret(alice.privateKey, bob.publicKey);
    const wrongShared = computeSharedSecret(alice.privateKey, carol.publicKey);

    const correctKey = await deriveEncryptionKey(correctShared);
    const wrongKey = await deriveEncryptionKey(wrongShared);

    const ct = await encrypt(correctKey, "secret message");
    await expect(decrypt(wrongKey, ct)).rejects.toThrow();
  });

  it("hexToBytes round-trips", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hexToBytes(hex)).toEqual(bytes);
  });
});
