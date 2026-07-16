import assert from "node:assert/strict";
import test from "node:test";
import { getEncodedTokenV4, type Proof } from "@cashu/cashu-ts";
import {
  planDurableWalletSendDeliveryAdmission,
  describeDurableWalletSendToken,
  requireDurableWalletSendResultWithinAdmission,
  requireExactDurableWalletSendToken,
} from "../src/durableWalletSendDelivery.ts";

const MINT = "https://mint.example";
const PROOF: Proof = {
  id: "0011223344556677",
  amount: 2,
  secret: "11".repeat(32),
  C: `02${"22".repeat(32)}`,
};

test("wallet-send token descriptor is deterministic and byte-bounded", () => {
  const token = getEncodedTokenV4({ mint: MINT, unit: "sat", proofs: [PROOF] });
  const first = describeDurableWalletSendToken(token);
  const second = describeDurableWalletSendToken(token);
  assert.deepEqual(first, second);
  assert.equal(first.byteLength, new TextEncoder().encode(token).byteLength);
  assert.match(first.tokenDigest, /^[0-9a-f]{64}$/);
  assert.throws(() => describeDurableWalletSendToken(""), /token is invalid/);
});

test("wallet-send token binds the exact mint, unit, order, and proof artifact", () => {
  const token = getEncodedTokenV4({ mint: MINT, unit: "sat", proofs: [PROOF] });
  assert.doesNotThrow(() =>
    requireExactDurableWalletSendToken({
      encodedToken: token,
      mintUrl: MINT,
      unit: "sat",
      sendProofs: [PROOF],
    }),
  );
  assert.throws(
    () =>
      requireExactDurableWalletSendToken({
        encodedToken: token,
        mintUrl: MINT,
        unit: "sat",
        sendProofs: [{ ...PROOF, secret: "33".repeat(32) }],
      }),
    /conflicts with its result/,
  );
});

test("wallet-send delivery admission rejects an oversized exact output plan before transport", () => {
  assert.throws(
    () =>
      planDurableWalletSendDeliveryAdmission({
        outputPlan: {
          mintUrl: MINT,
          unit: "sat",
          sendOutputs: Array.from({ length: 65 }, (_, index) => ({
            blindedMessage: { id: PROOF.id },
            secret: (index + 101).toString(16).padStart(64, "0"),
          })),
        },
        limits: {
          encodedTokenBytes: 64 * 1_024,
          proofCount: 64,
          durableStorageBytes: 96 * 1_024,
          nativeOperationRowBytes: 256 * 1_024,
        },
      }),
    /proof count limit/,
  );
});

test("wallet-send delivery admission binds a conservative pre-transport envelope", () => {
  const admission = planDurableWalletSendDeliveryAdmission({
    outputPlan: {
      mintUrl: MINT,
      unit: "sat",
      sendOutputs: [
        {
          blindedMessage: {
            id: PROOF.id,
          },
          secret: PROOF.secret,
        },
      ],
      keepOutputs: [
        { blindedMessage: { id: PROOF.id }, secret: "44".repeat(32) },
      ],
      passthroughProofs: [{ id: PROOF.id, secret: "55".repeat(32) }],
    },
    limits: {
      encodedTokenBytes: 64 * 1_024,
      proofCount: 64,
      durableStorageBytes: 1 * 1_024 * 1_024,
      nativeOperationRowBytes: 256 * 1_024,
    },
  });
  assert.equal(admission.sendProofCount, 1);
  assert.equal(admission.resultProofCount, 3);
  assert.ok(
    admission.durableStorageBytesRequired >
      admission.encodedTokenBytesUpperBound,
  );
  const token = getEncodedTokenV4({ mint: MINT, unit: "sat", proofs: [PROOF] });
  assert.doesNotThrow(() =>
    requireDurableWalletSendResultWithinAdmission({
      admission,
      encodedToken: token,
      sendProofCount: 1,
      resultProofCount: 3,
    }),
  );
  assert.throws(
    () =>
      requireDurableWalletSendResultWithinAdmission({
        admission,
        encodedToken: token,
        sendProofCount: 1,
        resultProofCount: 2,
      }),
    /exceeds its admitted envelope/,
  );
});

test("wallet-send delivery admission rejects oversized exact proof artifacts", () => {
  assert.throws(
    () =>
      planDurableWalletSendDeliveryAdmission({
        outputPlan: {
          mintUrl: MINT,
          unit: "sat",
          sendOutputs: [
            { blindedMessage: { id: PROOF.id }, secret: PROOF.secret },
          ],
          passthroughProofs: [
            {
              ...PROOF,
              witness: "w".repeat(16_385),
            },
          ],
        },
        limits: {
          encodedTokenBytes: 64 * 1_024,
          proofCount: 64,
          durableStorageBytes: 1 * 1_024 * 1_024,
          nativeOperationRowBytes: 256 * 1_024,
        },
      }),
    /proof witness is invalid/,
  );
});
