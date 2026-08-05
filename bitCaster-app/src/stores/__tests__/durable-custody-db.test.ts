// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { Proof } from "@cashu/cashu-ts";
import {
  createDurableProofOperationFacts,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import type { DurableCustodyProofOperationInput } from "@bitcaster/client-sdk/durableCustodyProofOperation";
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
  deriveDurableCustodyProofResultFingerprint,
} from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import { BrowserDurableCustodyAdapter, createBrowserCustodyProofRow } from "../durable-custody-db";
import {
  bindBrowserProofBackupAuthorityTerminalOperation,
  createBrowserProofBackupAuthorityRow,
} from "../browser-proof-backup-authority";
import { BitcasterDB } from "../proof-db";

const MINT = "https://mint.example";
const KEYSET = "0011223344556677";
const PUBLIC_KEY = `02${"11".repeat(32)}`;
const openDatabases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("browser durable custody adapter", () => {
  it("accepts the same validated scope regardless of property insertion order", async () => {
    const adapter = new BrowserDurableCustodyAdapter(createDatabase());
    const scope = walletScope();
    await adapter.ensureScope(scope, 1);
    const reordered = {
      walletId: scope.walletId,
      scopeId: scope.scopeId,
      scopeKind: scope.scopeKind,
    } as DurableCustodyScope;

    await expect(adapter.ensureScope(reordered, 2)).resolves.toBeUndefined();
  });

  it("does not advance the desired asset for a transaction without proof changes", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 5);
    const source = operationBinding(
      scope,
      "source-no-proof-change",
      proof("input-no-proof-change"),
      "output",
    );
    const predecessor = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: source.operation.inputs[0] as Proof,
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    await adapter.transact(
      selection(scope, owner, source.record.operation.operationId, null),
      (transaction) =>
        bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
      { predecessorProofs: { [source.record.operation.operationId]: [predecessor] } },
    );

    await adapter.transact(
      selection(scope, observedOwner(owner, 6), source.record.operation.operationId, 0),
      () => undefined,
    );

    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      {
        scopeId: scope.scopeId,
        mintUrl: MINT,
        unit: "msat",
        assetIdentity: "cashu:ordinary",
        custodyRevision: "1",
        activeProofCount: 1,
        desiredAction: "replace",
      },
    ]);
  });

  it("atomically inserts an exact operation and locks its selected proof", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 10);
    const source = operationBinding(scope, "source-a", proof("input-a"), "authorization-a");
    const predecessor = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: source.operation.inputs[0] as Proof,
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });

    await adapter.transact(
      selection(scope, owner, source.record.operation.operationId, null),
      (transaction) =>
        bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
      { predecessorProofs: { [source.record.operation.operationId]: [predecessor] } },
    );

    const restarted = new BrowserDurableCustodyAdapter(database);
    const committed = await restarted.readOperation(scope, source.record.operation.operationId);
    expect(committed?.revision).toBe(0);
    expect(committed?.operation.state).toBe("dispatch-intent");
    const locked = await restarted.readProof(scope.scopeId, predecessor.proofId);
    expect(locked?.selectability).toBe("locked");
    expect(locked?.reservationOperationId).toBe(source.record.operation.operationId);
    expect(await database.custodyReservations.count()).toBe(1);
    expect(
      await database.custodyProofBackupAuthorities.get([scope.scopeId, predecessor.proofId]),
    ).toMatchObject({
      proofFingerprint: predecessor.proofFingerprint,
      proofRevision: 1,
      proofState: "locked",
      backupState: "local-only",
    });
  });

  it("rejects reservation of a proof with terminal CTF authority", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 15);
    const source = operationBinding(scope, "source-terminal", proof("terminal"), "output-terminal");
    const predecessor = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: source.operation.inputs[0] as Proof,
      asset: { kind: "conditional", conditionId: "aa".repeat(32), outcomeCollection: "A" },
      receivedAtMs: 1,
    });
    const authority = bindBrowserProofBackupAuthorityTerminalOperation(
      createBrowserProofBackupAuthorityRow(predecessor, 2, null, "admission-terminal"),
      "redeem-terminal",
      3,
    );
    await database.custodyProofs.put(predecessor);
    await database.custodyProofBackupAuthorities.put(authority);

    await expect(
      adapter.transact(
        selection(scope, owner, source.record.operation.operationId, null),
        (transaction) =>
          bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
        { predecessorProofs: { [source.record.operation.operationId]: [predecessor] } },
      ),
    ).rejects.toThrow("terminal proof cannot be reserved");
    expect(await database.custodyReservations.count()).toBe(0);
  });

  it("rolls back every row when the local transaction fails before commit", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 20);
    const source = operationBinding(scope, "source-fault", proof("input-fault"), "output-fault");
    const predecessor = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: source.operation.inputs[0] as Proof,
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });

    await expect(
      adapter.transact(
        selection(scope, owner, source.record.operation.operationId, null),
        (transaction) =>
          bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
        {
          predecessorProofs: { [source.record.operation.operationId]: [predecessor] },
          injectFault: "before-commit",
        },
      ),
    ).rejects.toThrow(/injected browser custody fault/);

    expect(await adapter.readOperation(scope, source.record.operation.operationId)).toBeNull();
    expect(await adapter.readProof(scope.scopeId, predecessor.proofId)).toBeNull();
    expect(await database.custodyReservations.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
  });

  it("keeps an exact committed intent after an acknowledgement fault", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 25);
    const source = operationBinding(scope, "source-after-commit", proof("input-after"), "output");
    const predecessor = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: source.operation.inputs[0] as Proof,
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });

    await expect(
      adapter.transact(
        selection(scope, owner, source.record.operation.operationId, null),
        (transaction) =>
          bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
        {
          predecessorProofs: { [source.record.operation.operationId]: [predecessor] },
          injectFault: "after-commit",
        },
      ),
    ).rejects.toThrow(/after commit/);

    const restarted = new BrowserDurableCustodyAdapter(database);
    expect(
      await restarted.readOperation(scope, source.record.operation.operationId),
    ).not.toBeNull();
    expect((await restarted.readProof(scope.scopeId, predecessor.proofId))?.selectability).toBe(
      "locked",
    );
    expect(await database.custodyProofBackupAuthorities.count()).toBe(1);
  });

  it("advances the desired asset once for the specialized refund admission", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 26);
    const source = operationBinding(scope, "source-refund", proof("input-refund"), "output");
    const predecessor = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: source.operation.inputs[0] as Proof,
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    await adapter.transact(
      selection(scope, owner, source.record.operation.operationId, null),
      (transaction) =>
        bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
      { predecessorProofs: { [source.record.operation.operationId]: [predecessor] } },
    );
    const abortOwner = observedOwner(owner, 27);
    await adapter.transact(
      selection(scope, abortOwner, source.record.operation.operationId, 0),
      (transaction) =>
        transaction.transitionOperation({
          operationId: source.record.operation.operationId,
          expectedRevision: 0,
          transition: {
            kind: "abort",
            authorization: abortOwner,
            expectedRevision: 0,
          },
        }),
    );
    const refund = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: proof("refund-successor"),
      asset: { kind: "regular" },
      receivedAtMs: 2,
    });

    await adapter.retireAbortedInputsAndAdmitRefunds({
      scopeId: scope.scopeId,
      operationId: source.record.operation.operationId,
      refundProofs: [{ proof: refund, expectedRevision: null, derivationLocator: null }],
      observedAtMs: 28,
    });

    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      {
        scopeId: scope.scopeId,
        assetIdentity: "cashu:ordinary",
        custodyRevision: "2",
        activeProofCount: 1,
        desiredAction: "replace",
      },
    ]);
  });

  it("rejects foreign and oversized proof option collections before mutation", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 27);
    const source = operationBinding(scope, "source-bounds", proof("input-bounds"), "output");
    const predecessor = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: source.operation.inputs[0] as Proof,
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    const selectedId = source.record.operation.operationId;

    await expect(
      adapter.transact(selection(scope, owner, selectedId, null), () => undefined, {
        predecessorProofs: { foreign: [] },
      }),
    ).rejects.toThrow(/operation is not selected/);
    await expect(
      adapter.transact(selection(scope, owner, selectedId, null), () => undefined, {
        predecessorProofs: {
          [selectedId]: Array.from(
            { length: DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX + 1 },
            () => predecessor,
          ),
        },
      }),
    ).rejects.toThrow(/row limit is exceeded/);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.custodyProofs.count()).toBe(0);
  });

  it("atomically applies a mint result and reserves it for the outer operation", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 30);
    const { source, predecessor, authorizationProof, successor, resultFingerprint } =
      await stageSourceResult(adapter, scope, owner, "source-complete", 31);

    const outer = operationBinding(scope, "outer-range", authorizationProof, "settled-output");
    const applyOwner = observedOwner(owner, 32);
    await adapter.transact(
      {
        scope,
        owner: applyOwner,
        operationRows: [
          { operationId: source.record.operation.operationId, expectedRevision: 1 },
          { operationId: outer.record.operation.operationId, expectedRevision: null },
        ],
      },
      (transaction) => {
        transaction.applyVerifiedResult({
          operationId: source.record.operation.operationId,
          expectedRevision: 1,
          authorization: applyOwner,
          outputPlanFingerprint: source.record.operation.outputPlan.outputPlanFingerprint,
          resultHandle: `source-result:${resultFingerprint}`,
          resultFingerprint,
          successorAdmission: {
            scopeId: scope.scopeId,
            operationId: source.record.operation.operationId,
            admissionId: `source-admission:${resultFingerprint}`,
            proofRows: [
              { proofId: successor.proofId, expectedRevision: null, admittedRevision: 0 },
            ],
          },
        });
        bindDurableCustodyProofOperation(transaction, outer.record, outer.artifacts);
      },
      {
        successorProofs: {
          [source.record.operation.operationId]: [
            { proof: successor, expectedRevision: null, derivationLocator: null },
          ],
        },
      },
    );

    expect(
      (await adapter.readOperation(scope, source.record.operation.operationId))?.operation.state,
    ).toBe("reconciled");
    expect(
      (await adapter.readOperation(scope, outer.record.operation.operationId))?.operation.state,
    ).toBe("dispatch-intent");
    expect((await adapter.readProof(scope.scopeId, predecessor.proofId))?.selectability).toBe(
      "spent",
    );
    const reservedSuccessor = await adapter.readProof(scope.scopeId, successor.proofId);
    expect(reservedSuccessor?.selectability).toBe("locked");
    expect(reservedSuccessor?.reservationOperationId).toBe(outer.record.operation.operationId);

    const page = await adapter.listRecoverablePage({ scope, cursor: null, limit: 8 });
    expect(page.records.map((record) => record.operation.operationId)).toEqual([
      outer.record.operation.operationId,
    ]);

    const deliveryPayload = prepareDurableCustodyExactArtifact({ orderId: "order-1" });
    const deliveryOwner = observedOwner(owner, 33);
    await adapter.transact(
      selection(scope, deliveryOwner, source.record.operation.operationId, 2),
      (transaction) =>
        transaction.transitionOperation({
          operationId: source.record.operation.operationId,
          expectedRevision: 2,
          transition: {
            kind: "stage-outbox",
            authorization: deliveryOwner,
            expectedRevision: 2,
            deliveryId: "delivery-1",
            exactPayload: deliveryPayload,
            expiresAtMs: null,
          },
        }),
    );
    const restarted = new BrowserDurableCustodyAdapter(database);
    const snapshot = await restarted.readOperationSnapshot(
      scope,
      source.record.operation.operationId,
    );
    expect(
      snapshot?.artifacts.some(
        ({ reference }) => reference.fingerprint === deliveryPayload.fingerprint,
      ),
    ).toBe(true);
  });

  it("does not replace an existing locked proof during successor replay", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 35);
    const { source, successor, resultFingerprint } = await stageSourceResult(
      adapter,
      scope,
      owner,
      "source-conflict",
      36,
    );
    const conflicting = {
      ...successor,
      revision: 1,
      selectability: "locked" as const,
      reservationOperationId: "foreign-operation",
    };
    await database.custodyProofs.put(conflicting);
    const candidate = { ...successor, revision: 1 };
    const applyOwner = observedOwner(owner, 37);

    await expect(
      adapter.transact(
        selection(scope, applyOwner, source.record.operation.operationId, 1),
        (transaction) =>
          transaction.applyVerifiedResult({
            operationId: source.record.operation.operationId,
            expectedRevision: 1,
            authorization: applyOwner,
            outputPlanFingerprint: source.record.operation.outputPlan.outputPlanFingerprint,
            resultHandle: `source-result:${resultFingerprint}`,
            resultFingerprint,
            successorAdmission: {
              scopeId: scope.scopeId,
              operationId: source.record.operation.operationId,
              admissionId: `source-admission:${resultFingerprint}`,
              proofRows: [{ proofId: candidate.proofId, expectedRevision: 1, admittedRevision: 1 }],
            },
          }),
        {
          successorProofs: {
            [source.record.operation.operationId]: [
              { proof: candidate, expectedRevision: 1, derivationLocator: null },
            ],
          },
        },
      ),
    ).rejects.toThrow(/proof backup authority is (invalid|stale)/);
    await expect(adapter.readProof(scope.scopeId, successor.proofId)).rejects.toThrow(
      /proof backup authority is invalid/,
    );
  });

  it("fails closed when a referenced artifact is missing after restart", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 38);
    const { source } = await stageSourceResult(
      adapter,
      scope,
      owner,
      "source-missing-artifact",
      39,
    );
    await database.custodyArtifacts.delete([
      scope.scopeId,
      source.record.operation.operationId,
      source.record.operation.exactRequest.body.artifactId,
    ]);

    const restarted = new BrowserDurableCustodyAdapter(database);
    await expect(
      restarted.readOperationSnapshot(scope, source.record.operation.operationId),
    ).rejects.toThrow(/referenced artifact is missing/);
  });

  it("rejects a competing reservation for the same proof", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 41);
    const sharedProof = proof("shared-input");
    const first = operationBinding(scope, "first-reservation", sharedProof, "first-output");
    const second = operationBinding(scope, "second-reservation", sharedProof, "second-output");
    const predecessor = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: sharedProof,
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    await adapter.transact(
      selection(scope, owner, first.record.operation.operationId, null),
      (transaction) => bindDurableCustodyProofOperation(transaction, first.record, first.artifacts),
      { predecessorProofs: { [first.record.operation.operationId]: [predecessor] } },
    );

    await expect(
      adapter.transact(
        selection(scope, owner, second.record.operation.operationId, null),
        (transaction) =>
          bindDurableCustodyProofOperation(transaction, second.record, second.artifacts),
        { predecessorProofs: { [second.record.operation.operationId]: [predecessor] } },
      ),
    ).rejects.toThrow(/reservation replay is foreign/);
    expect(await database.custodyOperations.count()).toBe(1);
  });

  it("pages active recovery work without skipping an operation", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 40);
    const durableOperationIds: string[] = [];
    for (const operationId of ["operation-a", "operation-b"] as const) {
      const source = operationBinding(scope, operationId, proof(`${operationId}-input`), "output");
      const durableOperationId = source.record.operation.operationId;
      durableOperationIds.push(durableOperationId);
      const predecessor = createBrowserCustodyProofRow({
        scopeId: scope.scopeId,
        normalizedMint: MINT,
        unit: "msat",
        proof: source.operation.inputs[0] as Proof,
        asset: { kind: "regular" },
        receivedAtMs: 1,
      });
      await adapter.transact(
        selection(scope, owner, durableOperationId, null),
        (transaction) =>
          bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
        { predecessorProofs: { [durableOperationId]: [predecessor] } },
      );
    }
    durableOperationIds.sort();

    const first = await adapter.listRecoverablePage({ scope, cursor: null, limit: 1 });
    expect(first.records.map(({ operation }) => operation.operationId)).toEqual([
      durableOperationIds[0],
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await adapter.listRecoverablePage({
      scope,
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.records.map(({ operation }) => operation.operationId)).toEqual([
      durableOperationIds[1],
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects a custody row whose indexed authority differs from its record", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 50);
    const source = operationBinding(scope, "source-corrupt", proof("input-corrupt"), "output");
    const predecessor = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: source.operation.inputs[0] as Proof,
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    await adapter.transact(
      selection(scope, owner, source.record.operation.operationId, null),
      (transaction) =>
        bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
      { predecessorProofs: { [source.record.operation.operationId]: [predecessor] } },
    );
    const key: [string, string] = [scope.scopeId, source.record.operation.operationId];
    const row = await database.custodyOperations.get(key);
    if (!row) throw new Error("expected custody operation fixture");
    await database.custodyOperations.put({ ...row, estimatedBytes: row.estimatedBytes + 1 });

    await expect(adapter.readOperation(scope, source.record.operation.operationId)).rejects.toThrow(
      /operation row authority is foreign/,
    );
  });
});

async function stageSourceResult(
  adapter: BrowserDurableCustodyAdapter,
  scope: DurableCustodyScope,
  owner: DurableCustodyOwnerAuthorization,
  operationId: string,
  observedAtMs: number,
) {
  const sourceInput = proof(`${operationId}-input`);
  const authorizationProof = proof(`${operationId}-authorization`);
  const source = operationBinding(scope, operationId, sourceInput, authorizationProof.secret);
  const predecessor = createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: sourceInput,
    asset: { kind: "regular" },
    receivedAtMs: 1,
  });
  await adapter.transact(
    selection(scope, owner, source.record.operation.operationId, null),
    (transaction) => bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
    { predecessorProofs: { [source.record.operation.operationId]: [predecessor] } },
  );
  const successor = createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: authorizationProof,
    asset: { kind: "regular" },
    receivedAtMs: observedAtMs,
  });
  expect(source.record.operation.proofStorage.lineage.successorProofIds).toEqual([
    successor.proofId,
  ]);
  const exactResult = prepareDurableCustodyExactArtifact({
    authorization: [authorizationProof],
    keep: [],
  });
  const resultFingerprint = deriveDurableCustodyProofResultFingerprint({
    authorization: [authorizationProof],
    keep: [],
  });
  const stageOwner = observedOwner(owner, observedAtMs);
  await adapter.transact(
    selection(scope, stageOwner, source.record.operation.operationId, 0),
    (transaction) =>
      transaction.stageVerifiedResult({
        operationId: source.record.operation.operationId,
        expectedRevision: 0,
        authorization: stageOwner,
        outputPlanFingerprint: source.record.operation.outputPlan.outputPlanFingerprint,
        resultHandle: `source-result:${resultFingerprint}`,
        resultFingerprint,
        exactResult,
        selectedSuccessorProofIds: [successor.proofId],
      }),
  );
  return { source, predecessor, authorizationProof, successor, resultFingerprint };
}

function operationBinding(
  scope: DurableCustodyScope,
  operationId: string,
  inputProof: Proof,
  outputSecret: string,
): {
  record: DurableCustodyRecord;
  operation: DurableCustodyProofOperationInput;
  artifacts: {
    requestBody: ReturnType<typeof prepareDurableCustodyExactArtifact>;
    output: ReturnType<typeof prepareDurableCustodyExactArtifact>;
    privateMaterial: ReturnType<typeof prepareDurableCustodyExactArtifact>;
  };
} {
  const operation: DurableCustodyProofOperationInput = {
    operationId,
    kind: "wallet-send",
    mintUrl: MINT,
    inputs: [inputProof],
    outputs: {
      authorization: [
        {
          blindedMessage: { amount: 1, id: KEYSET, B_: `02${"33".repeat(32)}` },
          blindingFactor: "7",
          secret: outputSecret,
        },
      ],
      keep: [],
    },
    metadata: { unit: "msat" },
  };
  const artifacts = {
    requestBody: prepareDurableCustodyExactArtifact(operation),
    output: prepareDurableCustodyExactArtifact(operation.outputs),
    privateMaterial: prepareDurableCustodyExactArtifact(operation),
  };
  const facts = createDurableProofOperationFacts({
    unit: "msat",
    binding: { kind: "wallet", activityId: operationId, stage: "send" },
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: true,
    inputKeysetRequirement: "required",
    keysets: [
      {
        keysetId: KEYSET,
        unit: "msat",
        curve: "secp256k1",
        publicKeys: { "1": PUBLIC_KEY },
        keysetExpiryMs: null,
        requireDleq: false,
        usedByInputs: true,
        usedByOutputs: true,
      },
    ],
  });
  return {
    operation,
    artifacts,
    record: createDurableCustodyProofOperation({
      scope,
      operation,
      facts,
      inventoryAccountId: null,
      exactBoundary: {
        method: "POST",
        path: "/v1/swap",
        idempotencyKey: operationId,
        ...artifacts,
      },
    }),
  };
}

function proof(secret: string): Proof {
  return {
    id: KEYSET,
    amount: 1 as never,
    secret,
    C: `02${"22".repeat(32)}`,
  };
}

function walletScope(): Extract<DurableCustodyScope, { scopeKind: "wallet" }> {
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(32).fill(9));
  return {
    scopeKind: "wallet",
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
  };
}

async function claim(
  adapter: BrowserDurableCustodyAdapter,
  scope: DurableCustodyScope,
  observedAtMs: number,
): Promise<DurableCustodyOwnerAuthorization> {
  return adapter.claimScope(scope, {
    incarnationId: `browser-${observedAtMs}`,
    observedAtMs,
    leaseExpiresAtMs: observedAtMs + 10_000,
  });
}

function observedOwner(
  owner: DurableCustodyOwnerAuthorization,
  observedAtMs: number,
): DurableCustodyOwnerAuthorization {
  return { ...owner, observedAtMs };
}

function selection(
  scope: DurableCustodyScope,
  owner: DurableCustodyOwnerAuthorization,
  operationId: string,
  expectedRevision: number | null,
) {
  return { scope, owner, operationRows: [{ operationId, expectedRevision }] };
}

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`bitcaster-custody-test-${crypto.randomUUID()}`);
  openDatabases.push(database);
  return database;
}
