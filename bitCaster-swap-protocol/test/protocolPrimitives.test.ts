import assert from "node:assert/strict";
import { test } from "node:test";
import { Amount } from "@cashu/cashu-ts";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  MIN_LOCKTIME_DELTA_SECS,
  assertProofsAtomicSwapLocked,
  sellerPreparePersistedPrelockedSwap,
  sellerPreparePrelockedSwap,
  validateLocktimeOrdering,
} from "../src/atomicSwap.ts";
import {
  adapt,
  extract,
  generateAdaptorPoint,
  preSign,
  preVerify,
} from "../src/adaptor.ts";
import {
  computeSharedSecret,
  decrypt,
  deriveEncryptionKey,
  encrypt,
  encryptWithIv,
  generateEphemeralKeypair,
} from "../src/ecdh.ts";
import { createP2PKSecret, createP2PKWitness } from "../src/p2pk.ts";
import { normalizeUrl, safeHostname } from "../src/url.ts";

test("validateLocktimeOrdering enforces the atomic-swap refund invariant", () => {
  assert.equal(
    validateLocktimeOrdering(100 + MIN_LOCKTIME_DELTA_SECS + 1, 100),
    null,
  );
  assert.match(
    validateLocktimeOrdering(100 + MIN_LOCKTIME_DELTA_SECS, 100) ?? "",
    /locktime ordering violates protocol invariant/,
  );
  assert.match(
    validateLocktimeOrdering(Number.NaN, 100) ?? "",
    /invalid locktime values/,
  );
});

test("ECDH helpers derive the same key for both sides and decrypt round trips", async () => {
  const alice = generateEphemeralKeypair();
  const bob = generateEphemeralKeypair();
  const aliceShared = computeSharedSecret(alice.privateKey, bob.publicKey);
  const bobShared = computeSharedSecret(bob.privateKey, alice.publicKey);

  assert.deepEqual(aliceShared, bobShared);

  const aliceKey = await deriveEncryptionKey(aliceShared);
  const bobKey = await deriveEncryptionKey(bobShared);
  const ciphertext = await encrypt(aliceKey, "seller locked proofs");

  assert.equal(await decrypt(bobKey, ciphertext), "seller locked proofs");
});

test("persisted AES-GCM IV reproduces one exact durable ciphertext", async () => {
  const alice = generateEphemeralKeypair();
  const bob = generateEphemeralKeypair();
  const key = await deriveEncryptionKey(
    computeSharedSecret(alice.privateKey, bob.publicKey),
  );
  const iv = new Uint8Array(12).fill(7);

  const initial = await encryptWithIv(key, "buyer locked proofs", iv);
  const recovered = await encryptWithIv(key, "buyer locked proofs", iv);

  assert.equal(recovered, initial);
  assert.equal(await decrypt(key, recovered), "buyer locked proofs");
  await assert.rejects(
    () => encryptWithIv(key, "buyer locked proofs", new Uint8Array(11)),
    /encryption IV must be 12 bytes/,
  );
});

test("adaptor signatures preverify, adapt, and extract the adaptor secret", () => {
  const signer = generateEphemeralKeypair();
  const message = new Uint8Array(32).fill(7);
  const adaptor = generateAdaptorPoint();
  const preSig = preSign(signer.privateKey, message, adaptor.point);
  const signerPubkey = hexToBytes(signer.publicKey);

  assert.equal(preVerify(signerPubkey, message, preSig, adaptor.point), true);

  const finalSig = adapt(preSig, adaptor.secret);
  assert.equal(schnorr.verify(finalSig, message, signerPubkey.slice(1)), true);
  assert.deepEqual(extract(finalSig, preSig), adaptor.secret);
});

test("Block2_MultiLegSwap_PerLegNonceR_AreDistinct", () => {
  const signer = generateEphemeralKeypair();
  const adaptorA = generateAdaptorPoint();
  const adaptorB = generateAdaptorPoint();
  const messageA = new Uint8Array(32).fill(1);
  const messageB = new Uint8Array(32).fill(2);

  const finalSigA = adapt(
    preSign(signer.privateKey, messageA, adaptorA.point),
    adaptorA.secret,
  );
  const finalSigB = adapt(
    preSign(signer.privateKey, messageB, adaptorB.point),
    adaptorB.secret,
  );

  const nonceRA = Buffer.from(finalSigA.slice(0, 32)).toString("hex");
  const nonceRB = Buffer.from(finalSigB.slice(0, 32)).toString("hex");
  assert.notEqual(nonceRA, nonceRB);
});

test("P2PK helpers produce NUT-11 secret and witness shapes", () => {
  const signer = generateEphemeralKeypair();
  const refund = generateEphemeralKeypair();
  const secret = JSON.parse(
    createP2PKSecret({
      recipientPubkey: signer.publicKey,
      locktime: 1_779_393_600,
      refundPubkey: refund.publicKey,
    }),
  ) as [string, { data: string; tags: string[][] }];

  assert.equal(secret[0], "P2PK");
  assert.equal(secret[1].data, signer.publicKey);
  assert.deepEqual(secret[1].tags, [
    ["sigflag", "SIG_INPUTS"],
    ["locktime", "1779393600"],
    ["refund", refund.publicKey],
  ]);

  const message = new Uint8Array(32).fill(3);
  const witness = JSON.parse(createP2PKWitness(signer.privateKey, message)) as {
    signatures: string[];
  };
  assert.equal(witness.signatures.length, 1);
  assert.equal(witness.signatures[0].length, 128);
  assert.throws(
    () => createP2PKWitness(signer.privateKey, new Uint8Array(31)),
    /message must be 32 bytes/,
  );
});

test("seller prelocked swap rejects raw outcome proofs before presigning", async () => {
  const seller = generateEphemeralKeypair();
  const buyer = generateEphemeralKeypair();
  const ctx = {
    role: "seller" as const,
    tradeId: "trade-precondition",
    orderId: "order-precondition",
    marketId: "condition-YES",
    mintUrl: "https://mint.example",
    counterpartyPubkey: buyer.publicKey,
    ephemeralKey: seller,
    sellerLocktime: 1_779_393_600,
    buyerLocktime: 1_779_393_000,
  };
  const rawProof = {
    id: "conditional-keyset",
    amount: Amount.from(100),
    secret: "raw-outcome-secret",
    C: "02".padEnd(66, "0"),
  };

  assert.throws(
    () => assertProofsAtomicSwapLocked(ctx, [rawProof]),
    /requires P2PK-locked proofs/,
  );
  await assert.rejects(
    () => sellerPreparePrelockedSwap(ctx, [rawProof]),
    /requires P2PK-locked proofs/,
  );
});

test("seller prelocked swap accepts the exact atomic-swap P2PK lock shape", () => {
  const seller = generateEphemeralKeypair();
  const buyer = generateEphemeralKeypair();
  const ctx = {
    role: "seller" as const,
    tradeId: "trade-precondition-ok",
    orderId: "order-precondition-ok",
    marketId: "condition-YES",
    mintUrl: "https://mint.example",
    counterpartyPubkey: buyer.publicKey,
    ephemeralKey: seller,
    sellerLocktime: 1_779_393_600,
    buyerLocktime: 1_779_393_000,
  };
  const lockedProof = {
    id: "conditional-keyset",
    amount: Amount.from(100),
    secret: JSON.stringify([
      "P2PK",
      {
        data: seller.publicKey,
        tags: [
          ["pubkeys", buyer.publicKey],
          ["n_sigs", "2"],
          ["sigflag", "SIG_INPUTS"],
          ["locktime", String(ctx.sellerLocktime)],
          ["refund", seller.publicKey],
        ],
      },
    ]),
    C: "02".padEnd(66, "1"),
  };

  assert.doesNotThrow(() => assertProofsAtomicSwapLocked(ctx, [lockedProof]));
});

test("seller prelocked swap normalizes structured-cloned Cashu Amount values", async () => {
  const seller = generateEphemeralKeypair();
  const buyer = generateEphemeralKeypair();
  const ctx = {
    role: "seller" as const,
    tradeId: "trade-structured-amount",
    orderId: "order-structured-amount",
    marketId: "condition-YES",
    mintUrl: "https://mint.example",
    counterpartyPubkey: buyer.publicKey,
    ephemeralKey: seller,
    sellerLocktime: 1_779_393_600,
    buyerLocktime: 1_779_393_000,
  };
  const lockedProof = {
    id: "conditional-keyset",
    amount: { value: 100n },
    secret: JSON.stringify([
      "P2PK",
      {
        data: seller.publicKey,
        tags: [
          ["pubkeys", buyer.publicKey],
          ["n_sigs", "2"],
          ["sigflag", "SIG_INPUTS"],
          ["locktime", String(ctx.sellerLocktime)],
          ["refund", seller.publicKey],
        ],
      },
    ]),
    C: "02".padEnd(66, "2"),
  } as never;

  const prepared = await sellerPreparePrelockedSwap(ctx, [lockedProof]);

  assert.equal(prepared.lockedProofs[0].amount, 100);
});

test("seller recovery reuses one persisted adaptor point and rejects a mismatched binding", async () => {
  const seller = generateEphemeralKeypair();
  const buyer = generateEphemeralKeypair();
  const ctx = {
    role: "seller" as const,
    tradeId: "trade-persisted-adaptor",
    orderId: "order-persisted-adaptor",
    marketId: "condition-YES",
    mintUrl: "https://mint.example",
    counterpartyPubkey: buyer.publicKey,
    ephemeralKey: seller,
    sellerLocktime: 1_779_393_600,
    buyerLocktime: 1_779_393_000,
  };
  const lockedProof = {
    id: "conditional-keyset",
    amount: Amount.from(100),
    secret: JSON.stringify([
      "P2PK",
      {
        data: seller.publicKey,
        tags: [
          ["pubkeys", buyer.publicKey],
          ["n_sigs", "2"],
          ["sigflag", "SIG_INPUTS"],
          ["locktime", String(ctx.sellerLocktime)],
          ["refund", seller.publicKey],
        ],
      },
    ]),
    C: "02".padEnd(66, "3"),
  };
  const persisted = generateAdaptorPoint();

  const recovered = await sellerPreparePersistedPrelockedSwap(
    ctx,
    [lockedProof],
    persisted,
  );

  assert.deepEqual(recovered.adaptorPoint, persisted);
  await assert.rejects(
    () =>
      sellerPreparePersistedPrelockedSwap(ctx, [lockedProof], {
        secret: persisted.secret,
        point: generateAdaptorPoint().point,
      }),
    /persisted adaptor point binding is invalid/,
  );
});

test("URL helpers normalize mint identifiers consistently", () => {
  assert.equal(normalizeUrl("https://mint.example///"), "https://mint.example");
  assert.equal(safeHostname("https://mint.example/path"), "mint.example");
  assert.equal(safeHostname("not a url"), "not a url");
});

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
