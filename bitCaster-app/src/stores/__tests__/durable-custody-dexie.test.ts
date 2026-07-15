import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeDurableCustodyRecord,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyScopeId,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
  type DurableCustodyTransaction,
} from "@bitcaster/client-sdk/durableCustody";
import { db } from "../proof-db";
import { DexieDurableCustodyStore } from "../durable-custody-dexie";

const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

function walletScope(): DurableCustodyScope {
  const input = { scopeKind: "wallet" as const, walletId: FINGERPRINT_A };
  return { ...input, scopeId: deriveDurableCustodyScopeId(input) };
}

function custodyRecord(
  scope: DurableCustodyScope,
  input: {
    tradeId?: string;
    retainedOperationKey?: string;
    proofId?: string;
  } = {},
): DurableCustodyRecord {
  const tradeId = input.tradeId ?? "trade-001";
  const retainedOperationKey = input.retainedOperationKey ?? "seller-lock-001";
  const proofId = input.proofId ?? FINGERPRINT_A;
  const binding = {
    kind: "trade" as const,
    tradeId,
    role: "seller" as const,
    stage: "lock" as const,
  };
  const operationId = deriveDurableCustodyOperationId(scope.scopeId, {
    retainedOperationKey,
    binding,
  });
  return decodeDurableCustodyRecord({
    schemaVersion: 1,
    revision: 0,
    scope,
    operation: {
      operationId,
      retainedOperationKey,
      binding: {
        ...binding,
        sessionId: `session-${tradeId}`,
        immutableTradeFingerprint: FINGERPRINT_A,
        hasDependentOperation: false,
      },
      semanticKind: "swap-lock",
      state: "dispatch-intent",
      terminalReplayEvidenceRequired: true,
      custodyContext: {
        normalizedMint: "https://mint.example",
        unit: "sat",
        inventoryAccountId: null,
      },
      reservation: {
        reservationId: `reservation-${tradeId}`,
        parentReservationId: null,
        inputs: [{ proofId, keysetId: "keyset-001", curve: "secp256k1" }],
      },
      exactRequest: {
        requestId: `request-${tradeId}`,
        requestFingerprint: FINGERPRINT_A,
        payloadHandle: `request-payload-${tradeId}`,
        inputProofIds: [proofId],
        outputPlanFingerprint: FINGERPRINT_B,
      },
      outputPlan: {
        outputPlanId: `output-plan-${tradeId}`,
        outputPlanFingerprint: FINGERPRINT_B,
        outputMaterialHandle: `output-material-${tradeId}`,
      },
      privateMaterial: {
        materialHandle: `private-material-${tradeId}`,
        useId: `${tradeId}/seller/lock`,
        publicFingerprint: FINGERPRINT_A,
      },
      result: {
        state: "none",
        resultHandle: null,
        resultFingerprint: null,
        outputPlanFingerprint: null,
      },
      verification: {
        outputPlanFingerprint: FINGERPRINT_B,
        hasOutputs: true,
        keysetBindings: [
          {
            keysetId: "keyset-001",
            curve: "secp256k1",
            keysetFingerprint: FINGERPRINT_B,
            requireDleq: true,
          },
        ],
        outputKeysets: [{ keysetId: "keyset-001", curve: "secp256k1" }],
      },
      delivery: {
        deliveryKind: "none",
        deliveryId: null,
        payloadHandle: null,
        payloadFingerprint: null,
        expiresAtMs: null,
        state: "none",
      },
      retry: { attempt: 0, nextAttemptAtMs: null, reason: "none" },
      horizon: {
        notBeforeMs: null,
        notAfterMs: 5_000,
        safetyMarginMs: 500,
        keysetExpiryMs: null,
      },
    },
    terminalTombstone: null,
  });
}

function putIntent(
  transaction: DurableCustodyTransaction,
  record: DurableCustodyRecord,
): void {
  transaction.putOperation(record);
  if (record.operation.binding.kind !== "trade") {
    throw new Error("test operation must be trade-bound");
  }
  transaction.putSessionLink(
    record.operation.operationId,
    record.operation.binding,
  );
  transaction.reserveExactInputs({
    operationId: record.operation.operationId,
    reservationId: record.operation.reservation.reservationId,
    proofIds: record.operation.reservation.inputs.map(({ proofId }) => proofId),
  });
  transaction.rebuildActiveWorkIndex();
}

describe("Dexie durable custody store", () => {
  let store: DexieDurableCustodyStore;
  let scope: DurableCustodyScope;
  let owner: DurableCustodyOwnerAuthorization;

  beforeEach(async () => {
    db.close();
    await db.delete();
    await db.open();
    store = new DexieDurableCustodyStore(db);
    scope = walletScope();
    await store.registerScope(scope);
    const claimed = await store.claimScope({
      scope,
      incarnationId: "tab-001",
      observedAtMs: 1,
      leaseExpiresAtMs: 10_000,
    });
    owner = {
      incarnationId: "tab-001",
      fencingEpoch: claimed.fencingEpoch,
      observedAtMs: 2,
    };
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it("atomically commits canonical operation, link, reservation, and active index", async () => {
    const operation = custodyRecord(scope);
    await store.transact(
      { scope, owner, operationIds: [operation.operation.operationId] },
      (transaction) => putIntent(transaction, operation),
    );

    const page = await store.listRecoverablePage({
      scope,
      cursor: null,
      limit: 1,
    });
    expect(page.records).toEqual([operation]);
    expect(page.nextCursor).toBeNull();
    expect(await db.custodyProofReservations.get(FINGERPRINT_A)).toMatchObject({
      scopeId: scope.scopeId,
      operationId: operation.operation.operationId,
    });
  });

  it("rejects a transaction that substitutes the custody fencing epoch", async () => {
    await expect(
      store.transact({ scope, owner, operationIds: [] }, (transaction) => {
        const current = transaction.getScopeState();
        transaction.putScopeState({
          ...current,
          fencingEpoch: current.fencingEpoch + 1,
        });
      }),
    ).rejects.toThrow(/fencing epoch changes require claimScope/i);
  });

  it("rejects undeclared rows, foreign awaits, and stale prepared snapshots", async () => {
    const operation = custodyRecord(scope);
    await expect(
      store.transact({ scope, owner, operationIds: [] }, (transaction) =>
        transaction.getOperation(operation.operation.operationId),
      ),
    ).rejects.toThrow("operation was not selected");
    await expect(
      store.transact({ scope, owner, operationIds: [] }, async () => undefined),
    ).rejects.toThrow("transaction callback must not await");

    const plan = await store.prepareTransaction(
      { scope, owner, operationIds: [operation.operation.operationId] },
      (transaction) => putIntent(transaction, operation),
    );
    await store.transact(
      { scope, owner: { ...owner, observedAtMs: 3 }, operationIds: [] },
      () => undefined,
    );
    await expect(store.commitPreparedTransaction(plan)).rejects.toThrow(
      "snapshot changed before commit",
    );
    expect(
      await db.custodyOperations.get(operation.operation.operationId),
    ).toBeUndefined();

    const operationPlan = await store.prepareTransaction(
      { scope, owner, operationIds: [operation.operation.operationId] },
      (transaction) => putIntent(transaction, operation),
    );
    await db.custodyOperations.add({
      operationId: operation.operation.operationId,
      scopeId: scope.scopeId,
      active: 1,
      bindingKind: operation.operation.binding.kind,
      record: operation,
    });
    await expect(
      store.commitPreparedTransaction(operationPlan),
    ).rejects.toThrow("snapshot changed before commit");
  });

  it("enforces global proof ownership and rolls every row back on a write fault", async () => {
    const first = custodyRecord(scope);
    await store.transact(
      { scope, owner, operationIds: [first.operation.operationId] },
      (transaction) => putIntent(transaction, first),
    );
    const conflict = custodyRecord(scope, {
      tradeId: "trade-002",
      retainedOperationKey: "seller-lock-002",
      proofId: FINGERPRINT_A,
    });
    await expect(
      store.transact(
        {
          scope,
          owner: { ...owner, observedAtMs: 3 },
          operationIds: [conflict.operation.operationId],
        },
        (transaction) => putIntent(transaction, conflict),
      ),
    ).rejects.toThrow("proof reservation is already owned");
    expect(
      await db.custodyOperations.get(conflict.operation.operationId),
    ).toBeUndefined();

    const second = custodyRecord(scope, {
      tradeId: "trade-003",
      retainedOperationKey: "seller-lock-003",
      proofId: "c".repeat(64),
    });
    const fault = vi
      .spyOn(db.custodySessionLinks, "bulkPut")
      .mockRejectedValueOnce(new Error("injected link write failure"));
    await expect(
      store.transact(
        {
          scope,
          owner: { ...owner, observedAtMs: 4 },
          operationIds: [second.operation.operationId],
        },
        (transaction) => putIntent(transaction, second),
      ),
    ).rejects.toThrow("injected link write failure");
    fault.mockRestore();
    expect(
      await db.custodyOperations.get(second.operation.operationId),
    ).toBeUndefined();
    expect(
      await db.custodyProofReservations.get("c".repeat(64)),
    ).toBeUndefined();
  });

  it("releases active proof ownership after safe abort and reconciliation", async () => {
    const aborted = custodyRecord(scope, {
      tradeId: "trade-aborted",
      retainedOperationKey: "seller-lock-aborted",
    });
    await store.transact(
      { scope, owner, operationIds: [aborted.operation.operationId] },
      (transaction) => putIntent(transaction, aborted),
    );
    await store.transact(
      {
        scope,
        owner: { ...owner, observedAtMs: 3 },
        operationIds: [aborted.operation.operationId],
      },
      (transaction) => {
        transaction.transitionOperation({
          operationId: aborted.operation.operationId,
          transition: {
            kind: "abort-no-transport",
            classification: "all-inputs-unspent",
            exactRequestDisposition: "deterministically-rejected",
          },
        });
        transaction.rebuildActiveWorkIndex();
      },
    );
    expect(
      await db.custodyProofReservations.get(FINGERPRINT_A),
    ).toBeUndefined();

    const reconciled = custodyRecord(scope, {
      tradeId: "trade-reconciled",
      retainedOperationKey: "seller-lock-reconciled",
    });
    await store.transact(
      {
        scope,
        owner: { ...owner, observedAtMs: 4 },
        operationIds: [reconciled.operation.operationId],
      },
      (transaction) => putIntent(transaction, reconciled),
    );
    await store.transact(
      {
        scope,
        owner: { ...owner, observedAtMs: 5 },
        operationIds: [reconciled.operation.operationId],
      },
      (transaction) => {
        const result = {
          operationId: reconciled.operation.operationId,
          outputPlanFingerprint:
            reconciled.operation.outputPlan.outputPlanFingerprint,
          resultHandle: "result-trade-reconciled",
          resultFingerprint: FINGERPRINT_A,
        };
        transaction.stageVerifiedResult(result);
        transaction.applyVerifiedResult(result);
        transaction.rebuildActiveWorkIndex();
      },
    );
    expect(
      await db.custodyProofReservations.get(FINGERPRINT_A),
    ).toBeUndefined();

    const next = custodyRecord(scope, {
      tradeId: "trade-next",
      retainedOperationKey: "seller-lock-next",
    });
    await store.transact(
      {
        scope,
        owner: { ...owner, observedAtMs: 6 },
        operationIds: [next.operation.operationId],
      },
      (transaction) => putIntent(transaction, next),
    );
    expect(await db.custodyProofReservations.get(FINGERPRINT_A)).toMatchObject({
      operationId: next.operation.operationId,
    });
  });
});
