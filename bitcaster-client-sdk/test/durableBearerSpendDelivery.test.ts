import assert from "node:assert/strict";
import test from "node:test";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { bytesToHex } from "@noble/curves/utils.js";
import {
  CheckStateEnum,
  getEncodedTokenV4,
  hashToCurve,
  hashToCurveBls,
  isBlsKeyset,
  type Proof,
  type ProofState,
} from "@cashu/cashu-ts";
import {
  createDurableBearerSpendDeliveryRecord,
  decodeDurableBearerSpendDeliveryRecord,
  isDurableBearerSpendTokenPresentable,
  reconcileDurableBearerSpendDelivery,
  reduceDurableBearerSpendReclaimLineage,
  selectDurableBearerSpendUnspentProofs,
  type DurableBearerSpendDeliveryRecord,
} from "../src/durableBearerSpendDelivery.ts";
import { sameCashuProofArtifact } from "../src/proofSelection.ts";
import * as BearerDeliveryModule from "../src/durableBearerSpendDelivery.ts";

const MINT = "https://mint.example";
const VALID_SECP_POINT =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const VALID_BLS_POINT = bytesToHex(bls12_381.G1.Point.BASE.toBytes(true));
const BLS_KEYSET_ID = `02${"22".repeat(32)}`;
const PROOFS: readonly Proof[] = [
  {
    id: "0011223344556677",
    amount: 1,
    secret: "11".repeat(32),
    C: VALID_SECP_POINT,
  },
  {
    id: "0011223344556677",
    amount: 2,
    secret: "12".repeat(32),
    C: VALID_SECP_POINT,
  },
  {
    id: "0011223344556677",
    amount: 4,
    secret: "13".repeat(32),
    C: VALID_SECP_POINT,
  },
];

function createRecord(
  origin: "local" | "restored" = "local",
): DurableBearerSpendDeliveryRecord {
  return createRecordForProofs(PROOFS, origin);
}

function createRecordForProofs(
  proofs: readonly Proof[],
  origin: "local" | "restored" = "local",
): DurableBearerSpendDeliveryRecord {
  const encodedToken = getEncodedTokenV4({
    mint: MINT,
    unit: "sat",
    proofs: [...proofs],
  });
  return createDurableBearerSpendDeliveryRecord({
    deliveryId: "delivery-001",
    walletId: "wallet-001",
    parentOperationId: "send-001",
    payloadHandle: "payload-001",
    mintUrl: MINT,
    unit: "sat",
    encodedToken,
    proofs,
    origin,
    createdAtMs: 1_000,
  });
}

function stateFor(proof: Proof, state: ProofState["state"]): ProofState {
  const bytes = new TextEncoder().encode(proof.secret);
  return {
    Y: isBlsKeyset(proof.id)
      ? hashToCurveBls(bytes).toHex(true)
      : hashToCurve(bytes).toHex(true),
    state,
    witness: null,
  };
}

function states(...values: ProofState["state"][]): ProofState[] {
  return values.map((state, index) => stateFor(PROOFS[index]!, state));
}

async function reconcileWithStates(
  record: DurableBearerSpendDeliveryRecord,
  proofStates: unknown,
  observedAtMs = 2_000,
): Promise<DurableBearerSpendDeliveryRecord> {
  return reconcileDurableBearerSpendDelivery({
    record,
    observedAtMs,
    checker: {
      async checkProofsStates() {
        return proofStates;
      },
    },
  });
}

test("bearer policy record binds the exact token and rejects foreign persisted shape", () => {
  assert.equal("reduceDurableBearerSpendDelivery" in BearerDeliveryModule, false);
  assert.equal(
    "authorizeDurableBearerSpendCustodyHandoff" in BearerDeliveryModule,
    false,
  );
  const record = createRecord();
  assert.equal(record.state.kind, "pending");
  assert.equal(isDurableBearerSpendTokenPresentable(record), true);
  assert.equal(record.proofEntries.length, PROOFS.length);
  assert.match(record.tokenDigest, /^[0-9a-f]{64}$/);

  assert.throws(
    () =>
      decodeDurableBearerSpendDeliveryRecord({
        ...record,
        foreign: true,
      }),
    /bearer delivery record is invalid/,
  );
  assert.throws(
    () =>
      createDurableBearerSpendDeliveryRecord({
        deliveryId: "delivery-duplicate",
        walletId: "wallet-001",
        parentOperationId: "send-duplicate",
        payloadHandle: "payload-duplicate",
        mintUrl: MINT,
        unit: "sat",
        encodedToken: getEncodedTokenV4({
          mint: MINT,
          unit: "sat",
          proofs: [PROOFS[0]!, PROOFS[0]!],
        }),
        proofs: [PROOFS[0]!, PROOFS[0]!],
        origin: "local",
        createdAtMs: 1_000,
      }),
    /proof vector is invalid/,
  );
});

test("all-unspent is retained, presentable, and explicitly cancellable", async () => {
  const next = await reconcileWithStates(
    createRecord(),
    states(
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
    ),
  );
  assert.equal(next.state.kind, "pending");
  if (next.state.kind !== "pending") return;
  assert.equal(next.state.classification, "all-unspent");
  assert.equal(isDurableBearerSpendTokenPresentable(next), true);
  const selected = selectDurableBearerSpendUnspentProofs(next);
  assert.equal(selected.length, PROOFS.length);
  assert.ok(
    selected.every((proof, index) =>
      sameCashuProofArtifact(proof, PROOFS[index]),
    ),
  );
  assert.ok(next.state.nextAttemptAtMs > 2_000);
});

test("any pending or transport-indeterminate result retains authority with backoff", async () => {
  const requested: Pick<Proof, "id" | "secret">[][] = [];
  const pending = await reconcileDurableBearerSpendDelivery({
    record: createRecord(),
    observedAtMs: 2_000,
    checker: {
      async checkProofsStates(proofs) {
        requested.push(proofs);
        return states(
          CheckStateEnum.SPENT,
          CheckStateEnum.PENDING,
          CheckStateEnum.UNSPENT,
        );
      },
    },
  });
  assert.deepEqual(
    requested[0],
    PROOFS.map(({ id, secret }) => ({ id, secret })),
  );
  assert.equal(pending.state.kind, "pending");
  if (pending.state.kind !== "pending") return;
  assert.equal(pending.state.classification, "pending");
  assert.equal(isDurableBearerSpendTokenPresentable(pending), false);

  const indeterminate = await reconcileDurableBearerSpendDelivery({
    record: pending,
    observedAtMs: 3_000,
    checker: {
      async checkProofsStates() {
        throw new Error("must not escape as completion");
      },
    },
  });
  assert.equal(indeterminate.state.kind, "pending");
  if (indeterminate.state.kind !== "pending") return;
  assert.equal(indeterminate.state.classification, "indeterminate");
  assert.equal(isDurableBearerSpendTokenPresentable(indeterminate), false);
  assert.ok(indeterminate.state.nextAttemptAtMs > 3_000);
});

test("malformed, foreign, duplicate, and wrong-order vectors are blocked", async () => {
  const valid = states(
    CheckStateEnum.UNSPENT,
    CheckStateEnum.UNSPENT,
    CheckStateEnum.UNSPENT,
  );
  const cases: unknown[] = [
    valid.slice(0, 2),
    [{ ...valid[0], Y: `02${"ff".repeat(32)}` }, valid[1], valid[2]],
    [valid[0], valid[0], valid[2]],
    [valid[1], valid[0], valid[2]],
    [{ ...valid[0], state: "UNKNOWN" }, valid[1], valid[2]],
    [{ ...valid[0], witness: undefined }, valid[1], valid[2]],
    [{ ...valid[0], extra: true }, valid[1], valid[2]],
  ];
  for (const invalid of cases) {
    const next = await reconcileWithStates(createRecord(), invalid);
    assert.equal(next.state.kind, "pending");
    if (next.state.kind !== "pending") continue;
    assert.equal(next.state.classification, "blocked");
    assert.equal(isDurableBearerSpendTokenPresentable(next), true);
  }
});

test("BLS proof vectors preserve exact ordering and closed classification", async () => {
  const blsProofs: readonly Proof[] = [
    {
      id: BLS_KEYSET_ID,
      amount: 1,
      secret: "21".repeat(32),
      C: VALID_BLS_POINT,
    },
    {
      id: BLS_KEYSET_ID,
      amount: 2,
      secret: "22".repeat(32),
      C: VALID_BLS_POINT,
    },
  ];
  const record = createRecordForProofs(blsProofs);
  const blsStates = (...values: ProofState["state"][]) =>
    values.map((state, index) => stateFor(blsProofs[index]!, state));

  const unspent = await reconcileWithStates(
    record,
    blsStates(CheckStateEnum.UNSPENT, CheckStateEnum.UNSPENT),
  );
  assert.equal(unspent.state.kind, "pending");
  if (unspent.state.kind === "pending") {
    assert.equal(unspent.state.classification, "all-unspent");
  }
  const mixed = await reconcileWithStates(
    record,
    blsStates(CheckStateEnum.SPENT, CheckStateEnum.UNSPENT),
  );
  assert.deepEqual(
    mixed.proofEntries.map((entry) => entry.kind),
    ["spent", "active"],
  );
  const spent = await reconcileWithStates(
    record,
    blsStates(CheckStateEnum.SPENT, CheckStateEnum.SPENT),
  );
  assert.equal(spent.state.kind, "consumed");

  for (const invalid of [
    [
      { ...stateFor(blsProofs[0]!, CheckStateEnum.UNSPENT), Y: "00" },
      stateFor(blsProofs[1]!, CheckStateEnum.UNSPENT),
    ],
    blsStates(CheckStateEnum.UNSPENT, CheckStateEnum.UNSPENT).reverse(),
  ]) {
    const blocked = await reconcileWithStates(record, invalid);
    assert.equal(blocked.state.kind, "pending");
    if (blocked.state.kind === "pending") {
      assert.equal(blocked.state.classification, "blocked");
    }
  }
});

test("persisted and runtime clocks cannot regress", async () => {
  const record = createRecord();
  let checkerCalled = false;
  await assert.rejects(
    reconcileDurableBearerSpendDelivery({
      record,
      observedAtMs: 999,
      checker: {
        async checkProofsStates() {
          checkerCalled = true;
          return states(CheckStateEnum.UNSPENT);
        },
      },
    }),
    /observation time is invalid/,
  );
  assert.equal(checkerCalled, false);

  const observed = await reconcileWithStates(
    record,
    states(
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
    ),
    2_000,
  );
  await assert.rejects(
    reconcileWithStates(observed, states(
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
    ), 1_999),
    /observation time is invalid/,
  );
  assert.throws(
    () =>
      decodeDurableBearerSpendDeliveryRecord({
        ...observed,
        state: { ...observed.state, lastObservedAtMs: 999 },
      }),
    /delivery state is invalid/,
  );
});

test("persisted pending lifecycle accepts only reducer-reachable states", async () => {
  const record = createRecord();
  assert.throws(
    () =>
      decodeDurableBearerSpendDeliveryRecord({
        ...record,
        state: { ...record.state, attemptCount: 1 },
      }),
    /delivery state is invalid/,
  );
  const observed = await reconcileWithStates(
    record,
    states(
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
    ),
  );
  assert.throws(
    () =>
      decodeDurableBearerSpendDeliveryRecord({
        ...observed,
        state: { ...observed.state, attemptCount: 0 },
      }),
    /delivery state is invalid/,
  );
  const consumed = await reconcileWithStates(
    record,
    states(
      CheckStateEnum.SPENT,
      CheckStateEnum.SPENT,
      CheckStateEnum.SPENT,
    ),
  );
  assert.throws(
    () =>
      decodeDurableBearerSpendDeliveryRecord({
        ...consumed,
        state: {
          kind: "pending",
          classification: "blocked",
          proofStates: consumed.state.proofStates,
          attemptCount: 1,
          lastObservedAtMs: 2_000,
          nextAttemptAtMs: 7_000,
        },
      }),
    /delivery (?:state|record) is invalid/,
  );
  assert.throws(
    () =>
      decodeDurableBearerSpendDeliveryRecord({
        ...consumed,
        state: {
          kind: "pending",
          classification: "indeterminate",
          proofStates: null,
          attemptCount: 1,
          lastObservedAtMs: 2_000,
          nextAttemptAtMs: 7_000,
        },
      }),
    /delivery record is invalid/,
  );
  assert.throws(
    () =>
      decodeDurableBearerSpendDeliveryRecord({
        ...record,
        reclaim: {
          kind: "prepared",
          operationId: "reclaim-unobserved",
          parentDeliveryId: record.deliveryId,
          requestFingerprint: "ab".repeat(32),
        },
      }),
    /delivery record is invalid/,
  );
});

test("mixed spent and unspent hides the full token and retains only exact unspent authority", async () => {
  const next = await reconcileWithStates(
    createRecord(),
    states(
      CheckStateEnum.SPENT,
      CheckStateEnum.UNSPENT,
      CheckStateEnum.SPENT,
    ),
  );
  assert.equal(next.state.kind, "pending");
  if (next.state.kind !== "pending") return;
  assert.equal(next.state.classification, "mixed");
  assert.equal(isDurableBearerSpendTokenPresentable(next), false);
  assert.deepEqual(
    next.proofEntries.map((entry) => entry.kind),
    ["spent", "active", "spent"],
  );
  for (const entry of [next.proofEntries[0], next.proofEntries[2]]) {
    assert.equal(entry?.kind, "spent");
    assert.equal("proof" in (entry ?? {}), false);
    assert.equal("secret" in (entry ?? {}), false);
    assert.equal("C" in (entry ?? {}), false);
  }
  const selected = selectDurableBearerSpendUnspentProofs(next);
  assert.equal(selected.length, 1);
  assert.ok(sameCashuProofArtifact(selected[0]!, PROOFS[1]));

  const regressed = await reconcileWithStates(
    next,
    [stateFor(PROOFS[1]!, CheckStateEnum.UNSPENT)],
    3_000,
  );
  assert.equal(regressed.state.kind, "pending");
  if (regressed.state.kind !== "pending") return;
  assert.equal(regressed.state.classification, "mixed");
  assert.equal(isDurableBearerSpendTokenPresentable(regressed), false);
});

test("all-spent actor comes only from persisted linked reclaim lineage", async () => {
  const allSpent = states(
    CheckStateEnum.SPENT,
    CheckStateEnum.SPENT,
    CheckStateEnum.SPENT,
  );
  const recipient = await reconcileWithStates(createRecord(), allSpent);
  assert.equal(recipient.state.kind, "consumed");
  if (recipient.state.kind === "consumed") {
    assert.equal(recipient.state.actor, "recipient");
  }
  assert.ok(recipient.proofEntries.every((entry) => entry.kind === "spent"));
  assert.ok(
    recipient.proofEntries.every(
      (entry) => !("proof" in entry) && !("secret" in entry) && !("C" in entry),
    ),
  );

  const restored = await reconcileWithStates(createRecord("restored"), allSpent);
  assert.equal(restored.state.kind, "consumed");
  if (restored.state.kind === "consumed") {
    assert.equal(restored.state.actor, "unknown");
  }

  const sender = decodeDurableBearerSpendDeliveryRecord({
    ...recipient,
    reclaim: {
      kind: "completed",
      operationId: "reclaim-001",
      parentDeliveryId: "delivery-001",
      requestFingerprint: "ab".repeat(32),
    },
    state: {
      ...recipient.state,
      actor: "sender-reclaim",
    },
  });
  assert.equal(sender.state.kind, "consumed");
  if (sender.state.kind === "consumed") {
    assert.equal(sender.state.actor, "sender-reclaim");
  }
  assert.throws(
    () =>
      decodeDurableBearerSpendDeliveryRecord({
        ...sender,
        state: { ...sender.state, completedAtMs: 999 },
      }),
    /delivery state is invalid/,
  );

  const cancellable = await reconcileWithStates(
    createRecord(),
    states(
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
    ),
  );
  const prepared = reduceDurableBearerSpendReclaimLineage(cancellable, {
    kind: "prepared",
    operationId: "reclaim-001",
    requestFingerprint: "ab".repeat(32),
  });
  const rechecked = await reconcileWithStates(
    prepared,
    states(
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
    ),
    2_500,
  );
  const submittedReclaim = reduceDurableBearerSpendReclaimLineage(rechecked, {
    kind: "submitted",
    operationId: "reclaim-001",
    requestFingerprint: "ab".repeat(32),
  });
  const raced = await reconcileWithStates(submittedReclaim, allSpent, 3_000);
  assert.equal(raced.state.kind, "consumed");
  if (raced.state.kind === "consumed") {
    assert.equal(raced.state.actor, "unknown");
  }
});

test("reclaim lineage freezes recipient completion and hides cancellation", async () => {
  const cancellable = await reconcileWithStates(
    createRecord(),
    states(
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
    ),
  );
  const transition = {
    operationId: "reclaim-001",
    requestFingerprint: "ab".repeat(32),
  };
  const prepared = reduceDurableBearerSpendReclaimLineage(cancellable, {
    kind: "prepared",
    ...transition,
  });
  assert.equal(prepared.reclaim.kind, "prepared");
  assert.equal(isDurableBearerSpendTokenPresentable(prepared), false);
  assert.throws(
    () => selectDurableBearerSpendUnspentProofs(prepared),
    /not cancellable/,
  );
  assert.throws(
    () =>
      decodeDurableBearerSpendDeliveryRecord({
        ...cancellable,
        reclaim: {
          kind: "completed",
          operationId: transition.operationId,
          parentDeliveryId: cancellable.deliveryId,
          requestFingerprint: transition.requestFingerprint,
        },
      }),
    /delivery record is invalid/,
  );
  const rechecked = await reconcileWithStates(
    prepared,
    states(
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
      CheckStateEnum.UNSPENT,
    ),
    3_000,
  );
  assert.equal(selectDurableBearerSpendUnspentProofs(rechecked).length, 3);
  const submitted = reduceDurableBearerSpendReclaimLineage(rechecked, {
    kind: "submitted",
    ...transition,
  });
  assert.equal(isDurableBearerSpendTokenPresentable(submitted), false);
  assert.throws(
    () => selectDurableBearerSpendUnspentProofs(submitted),
    /not cancellable/,
  );
  assert.throws(
    () =>
      reduceDurableBearerSpendReclaimLineage(submitted, {
        kind: "submitted",
        ...transition,
        operationId: "reclaim-foreign",
      }),
    /reclaim transition is invalid/,
  );
  const raced = await reconcileWithStates(
    submitted,
    states(
      CheckStateEnum.SPENT,
      CheckStateEnum.SPENT,
      CheckStateEnum.SPENT,
    ),
    4_000,
  );
  assert.equal(raced.state.kind, "consumed");
  if (raced.state.kind === "consumed")
    assert.equal(raced.state.actor, "unknown");
  assert.deepEqual(
    reduceDurableBearerSpendReclaimLineage(raced, {
      kind: "submitted",
      ...transition,
    }),
    raced,
  );

  const recipientAfterIntent = await reconcileWithStates(
    prepared,
    states(
      CheckStateEnum.SPENT,
      CheckStateEnum.SPENT,
      CheckStateEnum.SPENT,
    ),
    3_000,
  );
  assert.equal(recipientAfterIntent.state.kind, "consumed");
  if (recipientAfterIntent.state.kind === "consumed") {
    assert.equal(recipientAfterIntent.state.actor, "recipient");
  }
  assert.throws(
    () =>
      reduceDurableBearerSpendReclaimLineage(recipientAfterIntent, {
        kind: "submitted",
        ...transition,
      }),
    /reclaim transition is invalid/,
  );
});
