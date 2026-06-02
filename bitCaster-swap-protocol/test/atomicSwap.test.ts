import assert from "node:assert/strict";
import { test } from "node:test";
import { Amount, type Proof } from "@cashu/cashu-ts";
import {
  assertConditionalSwapOutputsPinned,
  type SwapContext,
} from "../src/atomicSwap.ts";
import { adapt, generateAdaptorPoint, preSign } from "../src/adaptor.ts";
import { generateEphemeralKeypair } from "../src/ecdh.ts";

// The "leg-2 failure must not publish locked-proofs-seller" invariant is
// tested at the orchestration layer in
// bitCaster/bitcaster-daemon/test/swapExecutor.test.ts ::
// Block2_SellerLock_Leg2Failure_DoesNotPublishLockedProofsSeller. The
// protocol-layer `sellerPreparePrelockedSwap` function returns the cipher;
// whether and when it is sent to the hub is owned by the daemon.

test("Block2_MultiLegSwap_PerLegNonceR_AreDistinct", () => {
  const signer = generateEphemeralKeypair();
  const adaptorA = generateAdaptorPoint();
  const adaptorB = generateAdaptorPoint();
  const finalSigA = adapt(
    preSign(signer.privateKey, new Uint8Array(32).fill(1), adaptorA.point),
    adaptorA.secret,
  );
  const finalSigB = adapt(
    preSign(signer.privateKey, new Uint8Array(32).fill(2), adaptorB.point),
    adaptorB.secret,
  );

  assert.notEqual(
    Buffer.from(finalSigA.slice(0, 32)).toString("hex"),
    Buffer.from(finalSigB.slice(0, 32)).toString("hex"),
  );
});

test("Block2_MultiLegSwap_LocktimeIdenticalAcrossLegs", () => {
  const ctx = swapContext("trade-locktime-identical");
  const proofA = lockedProof(ctx, "keyset-A", 100);
  const proofB = lockedProof(ctx, "keyset-B", 100);

  assert.equal(extractLocktime(proofA), ctx.sellerLocktime);
  assert.equal(extractLocktime(proofB), ctx.sellerLocktime);
});

test("conditional swap previews fail before mint when outputs change keyset", () => {
  assert.throws(
    () =>
      assertConditionalSwapOutputsPinned({
        keysetId: "keyset-A",
        inputs: [
          lockedProof(swapContext("trade-output-keyset"), "keyset-A", 100),
        ],
        outputDataByLabel: {
          lock: [outputData("keyset-B", 100)],
        },
      }),
    /output lock uses keyset keyset-B; expected keyset-A/,
  );
});

function swapContext(tradeId: string): SwapContext {
  const seller = generateEphemeralKeypair();
  const buyer = generateEphemeralKeypair();
  return {
    tradeId,
    role: "seller",
    ephemeralKey: seller,
    counterpartyPubkey: buyer.publicKey,
    sellerLocktime: 1_779_393_600,
    buyerLocktime: 1_779_393_000,
    mintUrl: "https://mint.example",
  };
}

function lockedProof(
  ctx: SwapContext,
  keysetId: string,
  amount: number,
): Proof {
  return {
    id: keysetId,
    amount: Amount.from(amount),
    secret: JSON.stringify([
      "P2PK",
      {
        data: ctx.ephemeralKey.publicKey,
        tags: [
          ["pubkeys", ctx.counterpartyPubkey],
          ["n_sigs", "2"],
          ["sigflag", "SIG_INPUTS"],
          ["locktime", String(ctx.sellerLocktime)],
          ["refund", ctx.ephemeralKey.publicKey],
        ],
      },
    ]),
    C: `02${keysetId}`.padEnd(66, "0").slice(0, 66),
  } as Proof;
}

function extractLocktime(proof: Proof): number {
  const parsed = JSON.parse(proof.secret) as [string, { tags: string[][] }];
  const tag = parsed[1].tags.find(([name]) => name === "locktime");
  return Number(tag?.[1]);
}

function outputData(keysetId: string, amount: number) {
  return {
    blindedMessage: {
      id: keysetId,
      amount: Amount.from(amount),
      B_: `02${keysetId}`.padEnd(66, "0").slice(0, 66),
    },
    blindingFactor: "1",
    secret: `secret-${keysetId}`,
  } as never;
}
