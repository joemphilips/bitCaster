// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { deriveConditionalKeysetId, type Proof } from "@cashu/cashu-ts";
import {
  createDurableProofOperationFacts,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
} from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import type { DurableCustodyProofOperationInput } from "@bitcaster/client-sdk/durableCustodyProofOperation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserWalletDatabaseName } from "../../lib/browserWalletProfile";
import { BrowserEncryptedWalletBackupV2TerminalSealStore } from "../browser-encrypted-wallet-backup-v2-terminal-seal-store";
import { BrowserDurableCustodyAdapter, createBrowserCustodyProofRow } from "../durable-custody-db";
import { createBrowserProofBackupAuthorityRow } from "../browser-proof-backup-authority";
import { BitcasterDB } from "../proof-db";

const MINT = "https://mint.example";
const PUBLIC_KEY = `02${"22".repeat(32)}`;
const CONDITION_ID = "aa".repeat(32);
const OUTCOME_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: "YES",
});
const KEYSET = deriveConditionalKeysetId({
  keys: { "1": PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 0,
  final_expiry: 2,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_ID,
});
const databases: BitcasterDB[] = [];

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe("browser V2 terminal seal store", () => {
  it("requires one stable classification time for all terminal inputs", async () => {
    const fixture = await terminalFixture(17, 2);
    const store = new BrowserEncryptedWalletBackupV2TerminalSealStore({
      database: fixture.database,
      scopeId: fixture.scope.scopeId,
    });
    const callback = vi.fn(({ record, exactRejection, classifiedAtMs }) => {
      expect(Dexie.currentTransaction).toBeDefined();
      expect(record.operation.operationId).toBe(fixture.operationId);
      expect(exactRejection.fingerprint).toBe(fixture.rejection.fingerprint);
      expect(classifiedAtMs).toBe(20);
      return "issued";
    });

    await expect(store.withCommittedTerminalRejection(fixture.operationId, callback)).resolves.toBe(
      "issued",
    );
    expect(callback).toHaveBeenCalledOnce();

    const secondAuthority = await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scope.scopeId,
      fixture.proofIds[1]!,
    ]);
    if (!secondAuthority) throw new Error("test second authority is missing");
    await fixture.database.custodyProofBackupAuthorities.put({
      ...secondAuthority,
      updatedAtMs: 21,
      recordUpdatedAtUnixSeconds: 0,
    });
    const rejected = vi.fn(() => "unexpected");
    await expect(
      store.withCommittedTerminalRejection(fixture.operationId, rejected),
    ).rejects.toThrow("classification time is unstable");
    expect(rejected).not.toHaveBeenCalled();
  });

  it("fails closed when the committed rejection artifact is missing", async () => {
    const fixture = await terminalFixture(19);
    await fixture.database.custodyArtifacts.delete([
      fixture.scope.scopeId,
      fixture.operationId,
      fixture.rejectionReferenceArtifactId,
    ]);
    const store = new BrowserEncryptedWalletBackupV2TerminalSealStore({
      database: fixture.database,
      scopeId: fixture.scope.scopeId,
    });
    await expect(
      store.withCommittedTerminalRejection(fixture.operationId, () => true),
    ).rejects.toThrow(/referenced artifact is missing/);
  });

  it("fails closed when the exact input is not bound to the terminal operation", async () => {
    const fixture = await terminalFixture(20);
    const authority = await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scope.scopeId,
      fixture.proofId,
    ]);
    if (!authority) throw new Error("test authority is missing");
    await fixture.database.custodyProofBackupAuthorities.put({
      ...authority,
      terminalOperationId: "foreign-terminal-operation",
    });
    const store = new BrowserEncryptedWalletBackupV2TerminalSealStore({
      database: fixture.database,
      scopeId: fixture.scope.scopeId,
    });
    await expect(
      store.withCommittedTerminalRejection(fixture.operationId, () => true),
    ).rejects.toThrow(/terminal (?:input proof )?authority is invalid/);
  });

  it("rejects a non-wallet scope and a foreign wallet database", async () => {
    const scope = walletScope(21);
    const database = new BitcasterDB(browserWalletDatabaseName(scope.scopeId));
    databases.push(database);
    expect(
      () =>
        new BrowserEncryptedWalletBackupV2TerminalSealStore({
          database,
          scopeId: deriveDurableCustodyScopeId({
            scopeKind: "condition-inventory",
            conditionId: "aa".repeat(32),
            inventoryAccountId: "account",
            normalizedMint: MINT,
            unit: "msat",
          }),
        }),
    ).toThrow(/requires a wallet scope/);

    const foreignScope = walletScope(22);
    expect(
      () =>
        new BrowserEncryptedWalletBackupV2TerminalSealStore({
          database,
          scopeId: foreignScope.scopeId,
        }),
    ).toThrow(/database is foreign/);
  });
});

async function terminalFixture(seedByte: number, inputCount = 1) {
  const scope = walletScope(seedByte);
  const database = new BitcasterDB(browserWalletDatabaseName(scope.scopeId));
  databases.push(database);
  const adapter = new BrowserDurableCustodyAdapter(database);
  const owner = await adapter.claimScope(scope, {
    incarnationId: `browser-${seedByte}`,
    observedAtMs: 10,
    leaseExpiresAtMs: 10_000,
  });
  const requestedOperationId = `ctf-redeem-terminal-${seedByte}`;
  const inputs = Array.from({ length: inputCount }, (_, index) =>
    proof(`terminal-proof-${seedByte}-${index}`),
  );
  const operation = operationBinding(scope, requestedOperationId, inputs);
  const operationId = operation.record.operation.operationId;
  const predecessors = inputs.map((input) =>
    createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: input,
      asset: { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: "YES" },
      receivedAtMs: 1,
    }),
  );
  await database.custodyProofs.bulkPut(predecessors);
  await database.custodyProofBackupAuthorities.bulkPut(
    predecessors.map((predecessor, index) =>
      createBrowserProofBackupAuthorityRow(predecessor, 10, null, `admission-${seedByte}-${index}`),
    ),
  );
  await database.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    keysetId: KEYSET,
    denominationPublicKeys: { "1": PUBLIC_KEY },
    inputFeePpk: 0,
    conditionId: CONDITION_ID,
    outcomeCollection: "YES",
    outcomeCollectionId: OUTCOME_ID,
    registeredAtUnixSeconds: 1,
    finalExpiryUnixSeconds: 2,
    curve: "secp256k1",
  });
  await adapter.transact(
    { scope, owner, operationRows: [{ operationId, expectedRevision: null }] },
    (transaction) =>
      bindDurableCustodyProofOperation(transaction, operation.record, operation.artifacts),
    { predecessorProofs: { [operationId]: predecessors } },
  );
  const rejection = prepareDurableCustodyExactArtifact({
    schemaVersion: 1,
    kind: "authenticated-terminal-mint-rejection",
    operationId,
    semanticKind: "ctf-redeem",
    normalizedMint: MINT,
    requestFingerprint: operation.record.operation.exactRequest.requestFingerprint,
    code: 13015,
    transportProvenance: "authenticated-mint-transport",
    transportOperationId: operation.record.operation.retainedOperationKey,
    rejectionBody: { code: 13015 },
    predecessorDisposition: "retain",
    selectedSuccessorProofIds: [],
  });
  await adapter.transact(
    {
      scope,
      owner: observedOwner(owner, 20),
      operationRows: [{ operationId, expectedRevision: 0 }],
    },
    (transaction) =>
      transaction.reconcileAuthenticatedTerminalMintRejection!({
        operationId,
        expectedRevision: 0,
        authorization: observedOwner(owner, 20),
        rejectionHandle: `terminal:${rejection.fingerprint}`,
        rejectionFingerprint: rejection.fingerprint,
        exactRejection: rejection,
        code: 13015,
        predecessorDisposition: "retain",
      }),
  );
  const committed = await adapter.readOperation(scope, operationId);
  if (committed === null || committed.operation.terminalMintRejection === null) {
    throw new Error("test terminal operation was not committed");
  }
  return {
    database,
    scope,
    operationId,
    proofId: predecessors[0]!.proofId,
    proofIds: predecessors.map(({ proofId }) => proofId),
    rejection,
    rejectionReferenceArtifactId:
      committed.operation.terminalMintRejection.exactRejection.artifactId,
  };
}

function operationBinding(
  scope: DurableCustodyScope,
  operationId: string,
  inputs: readonly Proof[],
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
    kind: "ctf-redeem",
    mintUrl: MINT,
    inputs,
    outputs: {
      regular: [
        {
          blindedMessage: { amount: 1, id: inputs[0]!.id, B_: PUBLIC_KEY },
          blindingFactor: "7",
          secret: `output-${operationId}`,
        },
      ],
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
    binding: { kind: "wallet", activityId: operationId, stage: "ctf-redeem" },
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: true,
    inputKeysetRequirement: "required",
    keysets: [
      {
        keysetId: inputs[0]!.id!,
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
        path: "/v1/redeem_outcome",
        idempotencyKey: operationId,
        requestBody: artifacts.requestBody,
        output: artifacts.output,
        privateMaterial: artifacts.privateMaterial,
      },
    }),
  };
}

function proof(secret: string): Proof {
  return { id: KEYSET, amount: 1 as never, secret, C: PUBLIC_KEY };
}

function walletScope(seedByte: number): Extract<DurableCustodyScope, { scopeKind: "wallet" }> {
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(32).fill(seedByte));
  return {
    scopeKind: "wallet",
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
  };
}

function observedOwner(
  owner: DurableCustodyOwnerAuthorization,
  observedAtMs: number,
): DurableCustodyOwnerAuthorization {
  return { ...owner, observedAtMs };
}
