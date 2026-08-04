// @vitest-environment node
import "fake-indexeddb/auto";
import { deriveConditionalKeysetId } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { prepareDurableCustodyProofImport } from "@bitcaster/client-sdk/durableCustodyProofImport";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitBrowserCustodyProofImport } from "../browser-custody-proof-import";
import { bindBrowserProofBackupAuthorityTerminalOperation } from "../browser-proof-backup-authority";
import { BrowserEncryptedWalletBackupProofSnapshotDexieStore } from "../browser-encrypted-wallet-backup-proof-snapshot-dexie-store";
import { BrowserDurableCustodyAdapter, createBrowserCustodyProofRow } from "../durable-custody-db";
import { BitcasterDB } from "../proof-db";
import { browserWalletDatabaseName } from "../../lib/browserWalletProfile";

const MINT = "https://mint.example";
const KEYSET = `01${"33".repeat(32)}`;
const PUBLIC_KEY = `02${"22".repeat(32)}`;
const CONDITION_ID = "ab".repeat(32);
const OUTCOME_COLLECTION = "YES";
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
});
const CONDITIONAL_KEYSET = deriveConditionalKeysetId({
  keys: { "1": PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 100,
  final_expiry: 100,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
});
const nut13 = (keysetId: string, counter: number) => ({
  schemaVersion: 1 as const,
  kind: "nut13" as const,
  keysetId,
  counter,
});
let database: BitcasterDB | null = null;

afterEach(async () => {
  database?.close();
  if (database) await database.delete();
  database = null;
});

describe("browser encrypted wallet backup proof snapshot store", () => {
  it("reads one ordinary terminal admission synchronously and survives reopen", async () => {
    const fixture = await committedOrdinaryProof();
    database = fixture.database;
    fixture.database.close();
    const reopened = new BitcasterDB(fixture.database.name);
    database = reopened;
    const store = new BrowserEncryptedWalletBackupProofSnapshotDexieStore({
      database: reopened,
      scopeId: fixture.scope.scopeId,
      snapshotId: "snapshot-a",
      snapshotRevision: 2,
    });
    let calls = 0;
    const proofCommitment = await store.withCommittedProofSnapshot(fixture.proof.proofId, (row) => {
      calls += 1;
      expect(row.proofKind).toBe("ordinary");
      expect(row.derivationLocator).toEqual(nut13(KEYSET, 7));
      return row.proofCommitment;
    });
    expect(calls).toBe(1);
    expect(proofCommitment).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      store.withCommittedProofSnapshot(fixture.proof.proofId, async () => "invalid"),
    ).rejects.toThrow("callback must be synchronous");
  });

  it("reads one verified CTF tuple from the immutable conditional keyset row", async () => {
    const fixture = await committedConditionalProof();
    database = fixture.database;
    const store = new BrowserEncryptedWalletBackupProofSnapshotDexieStore({
      database: fixture.database,
      scopeId: fixture.scope.scopeId,
      snapshotId: "snapshot-ctf",
      snapshotRevision: 3,
    });
    await store.withCommittedProofSnapshot(fixture.proof.proofId, (row) => {
      expect(row.proofKind).toBe("ctf");
      expect(row.ctfMetadata).toEqual({
        conditionId: CONDITION_ID,
        outcomeLabel: OUTCOME_COLLECTION,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        registeredAtUnixSeconds: 0,
        finalExpiryUnixSeconds: 100,
      });
      expect(row.conditionalKeysetEvidence).not.toBeNull();
    });
  });

  it("backs one retained losing CTF proof with its exact terminal operation", async () => {
    const fixture = await committedConditionalProof();
    database = fixture.database;
    await bindTerminalOperation([fixture]);
    const page = await snapshotStore(fixture).listEligibleCommittedProofSnapshotPage(null);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.snapshot.terminalOperationId).toBe("redeem:losing");
    expect(page.items[0]!.proofInput.terminalEvidence).not.toBeNull();
  });

  it("rejects a retained losing CTF proof when terminal operation evidence is missing", async () => {
    const fixture = await committedConditionalProof();
    database = fixture.database;
    await bindTerminalOperation([fixture]);
    await fixture.database.proofOperations.delete("redeem:losing");
    await expect(
      snapshotStore(fixture).listEligibleCommittedProofSnapshotPage(null),
    ).rejects.toThrow("CTF terminal operation is missing or foreign");
  });

  it("deduplicates the exact terminal operation join for a proof page", async () => {
    const first = await committedConditionalProof({ counter: 1 });
    database = first.database;
    const second = await committedConditionalProof({
      counter: 2,
      database: first.database,
      scope: first.scope,
      owner: first.owner,
    });
    await bindTerminalOperation([first, second]);
    const terminalBulkGet = vi.spyOn(first.database.proofOperations, "bulkGet");
    const page = await snapshotStore(first).listEligibleCommittedProofSnapshotPage(null);
    expect(page.items).toHaveLength(2);
    expect(terminalBulkGet).toHaveBeenCalledTimes(1);
    expect(terminalBulkGet.mock.calls[0]![0]).toEqual(["redeem:losing"]);
  });

  it("rejects a CTF snapshot when its conditional keyset row is absent", async () => {
    const fixture = await committedConditionalProof();
    database = fixture.database;
    await fixture.database.custodyConditionalKeysets.delete([
      fixture.scope.scopeId,
      MINT,
      "msat",
      CONDITIONAL_KEYSET,
    ]);
    const store = new BrowserEncryptedWalletBackupProofSnapshotDexieStore({
      database: fixture.database,
      scopeId: fixture.scope.scopeId,
      snapshotId: "snapshot-ctf",
      snapshotRevision: 3,
    });
    await expect(
      store.withCommittedProofSnapshot(fixture.proof.proofId, () => "invalid"),
    ).rejects.toThrow("conditional keyset authority is missing or foreign");
  });

  it("rejects a snapshot when its admission operation is active", async () => {
    const fixture = await committedOrdinaryProof();
    database = fixture.database;
    const operationId = fixture.prepared.record.operation.operationId;
    const row = await fixture.database.custodyOperations.get([fixture.scope.scopeId, operationId]);
    if (!row) throw new Error("expected admission operation row");
    await fixture.database.custodyOperations.put({
      ...row,
      record: {
        ...row.record,
        operation: { ...row.record.operation, state: "dispatch-intent" },
      },
    });
    const store = new BrowserEncryptedWalletBackupProofSnapshotDexieStore({
      database: fixture.database,
      scopeId: fixture.scope.scopeId,
      snapshotId: "snapshot-active-admission",
      snapshotRevision: 4,
    });
    await expect(
      store.withCommittedProofSnapshot(fixture.proof.proofId, () => "invalid"),
    ).rejects.toThrow("proof admission operation is not terminal");
  });

  it("rejects a conflicting conditional input fee without changing the persisted tuple", async () => {
    const fixture = await committedConditionalProof();
    database = fixture.database;
    const key = [fixture.scope.scopeId, MINT, "msat", CONDITIONAL_KEYSET] as const;
    const persisted = await fixture.database.custodyConditionalKeysets.get(key);
    if (!persisted) throw new Error("expected conditional keyset row");
    const conflicting = conditionalImport({
      database: fixture.database,
      scope: fixture.scope,
      owner: fixture.owner,
      sourceOperationId: "receive:conflicting-fee",
      secret: "55".repeat(32),
      inputFeePpk: 101,
    });
    await expect(
      commitBrowserCustodyProofImport({
        scope: fixture.scope,
        owner: fixture.owner,
        prepared: conflicting.prepared,
        proofs: [
          {
            proof: conflicting.proof,
            expectedRevision: null,
            derivationLocator: nut13(CONDITIONAL_KEYSET, 7),
            conditionalKeyset: conflicting.conditionalKeyset,
          },
        ],
        database: fixture.database,
      }),
    ).rejects.toThrow();
    expect(await fixture.database.custodyConditionalKeysets.get(key)).toEqual(persisted);
    expect(await fixture.database.custodyProofs.count()).toBe(1);
  });

  it("pages in strict proof-id order and restarts from its exclusive cursor", async () => {
    const first = await committedOrdinaryProof({ counter: 1 });
    database = first.database;
    const second = await committedOrdinaryProof({
      counter: 2,
      database: first.database,
      scope: first.scope,
      owner: first.owner,
    });
    const store = snapshotStore(first);
    const initial = await store.listEligibleCommittedProofSnapshotPage(null);
    expect(initial.items.map(({ snapshot }) => snapshot.proofId)).toEqual(
      [first.proof.proofId, second.proof.proofId].sort(),
    );
    expect(
      initial.items.every(
        ({ proofInput, snapshot }) => proofInput.derivationLocator === snapshot.derivationLocator,
      ),
    ).toBe(true);
    expect(initial.nextCursor).toBeNull();
    const restarted = await store.listEligibleCommittedProofSnapshotPage(first.proof.proofId);
    expect(restarted.items.map(({ snapshot }) => snapshot.proofId)).toEqual([second.proof.proofId]);
  });

  it("stops at 42 candidates and preserves the next proof cursor", async () => {
    const first = await committedOrdinaryProof({ counter: 1 });
    database = first.database;
    const fixtures = [first];
    for (let counter = 2; counter <= 65; counter += 1) {
      fixtures.push(
        await committedOrdinaryProof({
          counter,
          database: first.database,
          scope: first.scope,
          owner: first.owner,
        }),
      );
    }
    const store = snapshotStore(first);
    const page = await store.listEligibleCommittedProofSnapshotPage(null);
    expect(page.items).toHaveLength(42);
    expect(page.nextCursor).toBe(page.items.at(-1)!.snapshot.proofId);
    const resumed = await store.listEligibleCommittedProofSnapshotPage(page.nextCursor);
    expect(resumed.items.map(({ snapshot }) => snapshot.proofId)).toEqual(
      fixtures
        .map(({ proof }) => proof.proofId)
        .filter((id) => id > page.nextCursor!)
        .sort(),
    );
  });

  it("uses one bounded authority query and grouped deduplicated joins", async () => {
    const first = await committedConditionalProof({ counter: 1 });
    database = first.database;
    for (let counter = 2; counter <= 3; counter += 1) {
      await committedConditionalProof({
        counter,
        database: first.database,
        scope: first.scope,
        owner: first.owner,
      });
    }
    const authorityWhere = vi.spyOn(first.database.custodyProofBackupAuthorities, "where");
    const proofBulkGet = vi.spyOn(first.database.custodyProofs, "bulkGet");
    const reservationBulkGet = vi.spyOn(first.database.custodyReservations, "bulkGet");
    const operationBulkGet = vi.spyOn(first.database.custodyOperations, "bulkGet");
    const keysetBulkGet = vi.spyOn(first.database.custodyConditionalKeysets, "bulkGet");
    await snapshotStore(first).listEligibleCommittedProofSnapshotPage(null);
    expect(authorityWhere).toHaveBeenCalledTimes(1);
    expect(proofBulkGet).toHaveBeenCalledTimes(1);
    expect(reservationBulkGet).toHaveBeenCalledTimes(1);
    expect(operationBulkGet).toHaveBeenCalledTimes(1);
    expect(keysetBulkGet).toHaveBeenCalledTimes(1);
    expect(proofBulkGet.mock.calls[0]![0]).toHaveLength(3);
    expect(reservationBulkGet.mock.calls[0]![0]).toHaveLength(3);
    expect(operationBulkGet.mock.calls[0]![0]).toHaveLength(3);
    expect(keysetBulkGet.mock.calls[0]![0]).toHaveLength(1);
  });

  it("keeps proof-body reads bounded to one 64-authority page", async () => {
    const first = await committedOrdinaryProof({ counter: 1 });
    database = first.database;
    for (let counter = 2; counter <= 64; counter += 1) {
      await committedOrdinaryProof({
        counter,
        database: first.database,
        scope: first.scope,
        owner: first.owner,
      });
    }
    const firstPageAuthorities = await first.database.custodyProofBackupAuthorities
      .where("[scopeId+backupState+proofId]")
      .between(
        [first.scope.scopeId, "local-only", Dexie.minKey],
        [first.scope.scopeId, "local-only", Dexie.maxKey],
      )
      .toArray();
    const authorityWhere = vi.spyOn(first.database.custodyProofBackupAuthorities, "where");
    let requestedLimit = 0;
    authorityWhere.mockReturnValue({
      between: () => ({
        limit: (limit: number) => {
          requestedLimit = limit;
          return { toArray: () => Dexie.Promise.resolve(firstPageAuthorities.slice(0, limit)) };
        },
      }),
    } as never);
    const proofBulkGet = vi.spyOn(first.database.custodyProofs, "bulkGet");
    const reservationBulkGet = vi.spyOn(first.database.custodyReservations, "bulkGet");
    const operationBulkGet = vi.spyOn(first.database.custodyOperations, "bulkGet");
    const page = await snapshotStore(first).listEligibleCommittedProofSnapshotPage(null);
    expect(page.items).toHaveLength(42);
    expect(requestedLimit).toBe(42);
    expect(proofBulkGet.mock.calls[0]![0]).toHaveLength(42);
    expect(reservationBulkGet.mock.calls[0]![0]).toHaveLength(42);
    expect(operationBulkGet.mock.calls[0]![0]).toHaveLength(42);
  }, 20_000);

  it("refuses a persisted reservation pin and malformed authority", async () => {
    const fixture = await committedOrdinaryProof();
    database = fixture.database;
    await fixture.database.custodyReservations.put({
      scopeId: fixture.scope.scopeId,
      proofId: fixture.proof.proofId,
      operationId: "reserved-operation",
      reservationId: "reservation-a",
      inputPosition: 0,
    });
    const store = snapshotStore(fixture);
    await expect(
      store.withCommittedProofSnapshot(fixture.proof.proofId, () => "invalid"),
    ).rejects.toThrow("reservation authority is stale");
    await fixture.database.custodyReservations.delete([
      fixture.scope.scopeId,
      fixture.proof.proofId,
    ]);
    const authority = await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scope.scopeId,
      fixture.proof.proofId,
    ]);
    if (!authority) throw new Error("expected proof authority");
    await fixture.database.custodyProofBackupAuthorities.put({ ...authority, proofRevision: -1 });
    await expect(store.listEligibleCommittedProofSnapshotPage(null)).rejects.toThrow(
      "browser proof backup authority",
    );
  });
});

async function committedOrdinaryProof(options: SharedFixtureOptions = {}) {
  return committedProof({ kind: "ordinary", ...options });
}

async function committedConditionalProof(options: SharedFixtureOptions = {}) {
  return committedProof({ kind: "ctf", ...options });
}

interface SharedFixtureOptions {
  readonly counter?: number;
  readonly database?: BitcasterDB;
  readonly scope?: DurableCustodyScope;
  readonly owner?: Awaited<ReturnType<BrowserDurableCustodyAdapter["claimScope"]>>;
}

async function committedProof(input: { readonly kind: "ordinary" | "ctf" } & SharedFixtureOptions) {
  const counter = input.counter ?? 7;
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(32).fill(7));
  const scope =
    input.scope ??
    ({
      scopeKind: "wallet",
      walletId,
      scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
    } as const);
  const database = input.database ?? new BitcasterDB(browserWalletDatabaseName(scope.scopeId));
  const conditional = input.kind === "ctf";
  const keysetId = conditional ? CONDITIONAL_KEYSET : KEYSET;
  const unit = conditional ? "msat" : "sat";
  const value = {
    id: keysetId,
    amount: 1 as never,
    secret: counter.toString(16).padStart(2, "0").repeat(32),
    C: PUBLIC_KEY,
    dleq: { e: "22".repeat(32), s: "33".repeat(32), r: "44".repeat(32) },
  };
  const proof = createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit,
    proof: value,
    asset: conditional
      ? {
          kind: "conditional" as const,
          conditionId: CONDITION_ID,
          outcomeCollection: OUTCOME_COLLECTION,
        }
      : { kind: "regular" as const },
    receivedAtMs: 1_000,
  });
  const prepared = prepareDurableCustodyProofImport({
    scope,
    sourceOperationId: `receive:${counter}`,
    normalizedMint: MINT,
    unit,
    inventoryAccountId: null,
    keysets: [
      {
        keysetId,
        unit,
        curve: "secp256k1",
        publicKeys: { "1": PUBLIC_KEY },
        keysetExpiryMs: null,
        requireDleq: false,
      },
    ],
    proofs: [value],
    inventoryAuthorityFingerprint: deriveDurableCustodyArtifactFingerprint({
      schemaVersion: 1,
      proofs: [
        {
          proofId: proof.proofId,
          proofFingerprint: proof.proofFingerprint,
          assetKind: conditional ? "conditional" : "regular",
          conditionId: conditional ? CONDITION_ID : null,
          outcomeCollection: conditional ? OUTCOME_COLLECTION : null,
          baseAsset: "sat",
        },
      ],
    }),
  });
  const adapter = new BrowserDurableCustodyAdapter(database);
  const owner =
    input.owner ??
    (await adapter.claimScope(scope, {
      incarnationId: "snapshot-test",
      observedAtMs: 1_000,
      leaseExpiresAtMs: 10_000,
    }));
  const conditionalKeyset = conditional
    ? {
        schemaVersion: 1 as const,
        normalizedMint: MINT,
        unit: "msat" as const,
        keysetId,
        denominationPublicKeys: { "1": PUBLIC_KEY },
        inputFeePpk: 100,
        conditionId: CONDITION_ID,
        outcomeCollection: OUTCOME_COLLECTION,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        registeredAtUnixSeconds: 0,
        finalExpiryUnixSeconds: 100,
        curve: "secp256k1" as const,
      }
    : undefined;
  const commitInput = {
    scope,
    owner,
    prepared,
    proofs: [
      {
        proof,
        expectedRevision: null,
        derivationLocator: nut13(keysetId, counter),
        ...(conditionalKeyset === undefined ? {} : { conditionalKeyset }),
      },
    ],
    database,
  };
  await commitBrowserCustodyProofImport(commitInput);
  return { database, scope, proof, value, prepared, owner, conditionalKeyset };
}

async function bindTerminalOperation(
  fixtures: readonly Awaited<ReturnType<typeof committedConditionalProof>>[],
): Promise<void> {
  const fixture = fixtures[0];
  if (!fixture) throw new Error("expected terminal proof fixture");
  const operationId = "redeem:losing";
  await fixture.database.proofOperations.put({
    operationId,
    kind: "ctf-redeem",
    state: "Failed",
    mintUrl: MINT,
    inputs: fixtures.map(({ value }) => value),
    outputs: {},
    metadata: { unit: "msat" },
    failureCode: 13015,
    createdAt: 1_500,
    updatedAt: 2_000,
  });
  const keys = fixtures.map(
    ({ proof }) => [fixture.scope.scopeId, proof.proofId] as [string, string],
  );
  const authorities = await fixture.database.custodyProofBackupAuthorities.bulkGet(keys);
  await fixture.database.custodyProofBackupAuthorities.bulkPut(
    authorities.map((authority) => {
      if (!authority) throw new Error("expected proof backup authority");
      return bindBrowserProofBackupAuthorityTerminalOperation(authority, operationId, 2_000);
    }),
  );
}

function snapshotStore(fixture: Awaited<ReturnType<typeof committedOrdinaryProof>>) {
  return new BrowserEncryptedWalletBackupProofSnapshotDexieStore({
    database: fixture.database,
    scopeId: fixture.scope.scopeId,
    snapshotId: "snapshot-page",
    snapshotRevision: 1,
  });
}

function conditionalImport(input: {
  readonly database: BitcasterDB;
  readonly scope: DurableCustodyScope;
  readonly owner: Awaited<ReturnType<BrowserDurableCustodyAdapter["claimScope"]>>;
  readonly sourceOperationId: string;
  readonly secret: string;
  readonly inputFeePpk: number;
}) {
  const value = {
    id: CONDITIONAL_KEYSET,
    amount: 1 as never,
    secret: input.secret,
    C: PUBLIC_KEY,
    dleq: { e: "22".repeat(32), s: "33".repeat(32), r: "44".repeat(32) },
  };
  const proof = createBrowserCustodyProofRow({
    scopeId: input.scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: value,
    asset: {
      kind: "conditional",
      conditionId: CONDITION_ID,
      outcomeCollection: OUTCOME_COLLECTION,
    },
    receivedAtMs: 1_000,
  });
  const prepared = prepareDurableCustodyProofImport({
    scope: input.scope,
    sourceOperationId: input.sourceOperationId,
    normalizedMint: MINT,
    unit: "msat",
    inventoryAccountId: null,
    keysets: [
      {
        keysetId: CONDITIONAL_KEYSET,
        unit: "msat",
        curve: "secp256k1",
        publicKeys: { "1": PUBLIC_KEY },
        keysetExpiryMs: null,
        requireDleq: false,
      },
    ],
    proofs: [value],
    inventoryAuthorityFingerprint: deriveDurableCustodyArtifactFingerprint({
      schemaVersion: 1,
      proofs: [
        {
          proofId: proof.proofId,
          proofFingerprint: proof.proofFingerprint,
          assetKind: "conditional",
          conditionId: CONDITION_ID,
          outcomeCollection: OUTCOME_COLLECTION,
          baseAsset: "sat",
        },
      ],
    }),
  });
  return {
    proof,
    prepared,
    conditionalKeyset: {
      schemaVersion: 1 as const,
      normalizedMint: MINT,
      unit: "msat" as const,
      keysetId: CONDITIONAL_KEYSET,
      denominationPublicKeys: { "1": PUBLIC_KEY },
      inputFeePpk: input.inputFeePpk,
      conditionId: CONDITION_ID,
      outcomeCollection: OUTCOME_COLLECTION,
      outcomeCollectionId: OUTCOME_COLLECTION_ID,
      registeredAtUnixSeconds: 0,
      finalExpiryUnixSeconds: 100,
      curve: "secp256k1" as const,
    },
  };
}
