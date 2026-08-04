// @vitest-environment node
import "fake-indexeddb/auto";
import { Amount, deriveConditionalKeysetId, type Proof } from "@cashu/cashu-ts";
import {
  createDurableProofOperationFacts,
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import {
  bindDurableCustodyProofImport,
  prepareDurableCustodyProofImport,
  stageDurableCustodyProofImport,
} from "@bitcaster/client-sdk/durableCustodyProofImport";
import type { DurableCustodyProofOperationInput } from "@bitcaster/client-sdk/durableCustodyProofOperation";
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
  deriveDurableCustodyProofResultFingerprint,
} from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  classifyDurableWalletStorage,
  decodeDurableWalletEncryptedBackupReceipt,
  deriveDurableWalletBackupSnapshotId,
} from "@bitcaster/client-sdk/recoverableWalletStorage";
import { issueDurableWalletAuthenticatedBackupReceipt } from "@bitcaster/client-sdk/encryptedWalletBackupAuthority";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserCustodyProofRow } from "../durable-custody-db";
import { BrowserDurableCustodyAdapter } from "../durable-custody-db";
import { BrowserEncryptedWalletBackupProofSnapshotDexieStore } from "../browser-encrypted-wallet-backup-proof-snapshot-dexie-store";
import { BrowserEncryptedWalletBackupRestoreDexieStore } from "../encrypted-wallet-backup-restore-db";
import { bindBrowserProofBackupAuthorityTerminalOperation } from "../browser-proof-backup-authority";
import { BitcasterDB } from "../proof-db";
import { browserWalletDatabaseName } from "../../lib/browserWalletProfile";
import type { EncryptedWalletBackupRestoreProofRow } from "@bitcaster/client-sdk/encryptedWalletBackup";
import { deriveEncryptedWalletBackupProofCommitment } from "@bitcaster/client-sdk/encryptedWalletBackup";

const SCOPE_ID = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: deriveDurableCustodyWalletId(Uint8Array.from({ length: 32 }, (_, index) => index)),
});
const MINT = "https://mint.example";
const KEYSET = `01${"11".repeat(32)}`;
const PUBLIC_KEY = `02${"11".repeat(32)}`;
const CTF_CONDITION_ID = "ab".repeat(32);
const CTF_OUTCOME_COLLECTION = "YES";
const CTF_OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CTF_CONDITION_ID,
  outcomeCollection: CTF_OUTCOME_COLLECTION,
});
const CTF_KEYSET = deriveConditionalKeysetId({
  keys: { "1": PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 0,
  final_expiry: 1_800_000_000,
  conditionId: CTF_CONDITION_ID,
  outcomeCollectionId: CTF_OUTCOME_COLLECTION_ID,
});
const databases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
  vi.restoreAllMocks();
});

describe("encrypted wallet backup restore Dexie store", () => {
  it("inserts exact absent proof authority and accepts an idempotent replay after restart", async () => {
    const database = databaseFor();
    const row = restoreRow();
    const store = restoreStore(database);
    await expect(commit(store, [row])).resolves.toBe("committed");
    expect(await database.encryptedWalletBackupRestoreProofs.count()).toBe(1);
    expect(await database.proofs.count()).toBe(1);
    expect(await database.custodyProofs.count()).toBe(1);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(1);
    await expect(
      new BrowserDurableCustodyAdapter(database).readProof(SCOPE_ID, row.proofId),
    ).resolves.toMatchObject({ proofId: row.proofId, selectability: "selectable" });

    database.close();
    databases.splice(databases.indexOf(database), 1);
    const restarted = new BitcasterDB(database.name);
    databases.push(restarted);
    await expect(commit(restoreStore(restarted), [row])).resolves.toBe("committed");
    expect(await restarted.encryptedWalletBackupRestoreProofs.count()).toBe(1);
    expect(await restarted.proofs.count()).toBe(1);
  });

  it("hydrates only a missing restored proof body", async () => {
    const database = databaseFor();
    const row = restoreRow();
    await database.encryptedWalletBackupRestoreProofs.put({
      scopeId: SCOPE_ID,
      proofId: row.proofId,
      storageClassification: row.storageClassification,
      proof: null,
    });
    let observedProof: unknown = undefined;
    await commit(restoreStore(database), [row], "hydrate-existing", (current) => {
      observedProof = current[0]!.proof;
      return "hydrated";
    });
    expect(observedProof).toBeNull();
    expect(await database.proofs.count()).toBe(1);
    expect(
      (await database.encryptedWalletBackupRestoreProofs.get([SCOPE_ID, row.proofId]))?.proof,
    ).not.toBeNull();
  });

  it("does not treat a fresh staged import successor as a restored current proof", async () => {
    const database = databaseFor();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await adapter.claimScope(scope, {
      incarnationId: "staged-import",
      observedAtMs: 10,
      leaseExpiresAtMs: 10_000,
    });
    const prospectiveValue = cashuProof("cc".repeat(32));
    const prospective = createBrowserCustodyProofRow({
      scopeId: SCOPE_ID,
      normalizedMint: MINT,
      unit: "sat",
      proof: prospectiveValue,
      asset: { kind: "regular" },
      receivedAtMs: 10,
    });
    const prepared = prepareDurableCustodyProofImport({
      scope,
      sourceOperationId: "staged-import-source",
      normalizedMint: MINT,
      unit: "sat",
      inventoryAccountId: null,
      keysets: [
        {
          keysetId: KEYSET,
          unit: "sat",
          curve: "secp256k1",
          publicKeys: { "1": PUBLIC_KEY },
          keysetExpiryMs: null,
          requireDleq: false,
        },
      ],
      proofs: [prospectiveValue],
      inventoryAuthorityFingerprint: deriveDurableCustodyArtifactFingerprint({
        schemaVersion: 1,
        proofs: [
          {
            proofId: prospective.proofId,
            proofFingerprint: prospective.proofFingerprint,
            assetKind: "regular",
            conditionId: null,
            outcomeCollection: null,
            baseAsset: "sat",
          },
        ],
      }),
    });
    await adapter.transact(
      selection(scope, owner, prepared.record.operation.operationId, null),
      (transaction) => bindDurableCustodyProofImport({ transaction, prepared }),
    );
    await adapter.transact(
      selection(scope, owner, prepared.record.operation.operationId, 0),
      (transaction) =>
        stageDurableCustodyProofImport({ transaction, prepared, authorization: owner }),
    );
    expect(
      (await adapter.readOperation(scope, prepared.record.operation.operationId))?.operation.result
        .state,
    ).toBe("verified-staged");
    expect(await adapter.readProof(SCOPE_ID, prospective.proofId)).toBeNull();

    const restored = restoreRow();
    await expect(commit(restoreStore(database), [restored])).resolves.toBe("committed");
    expect(await adapter.readProof(SCOPE_ID, restored.proofId)).not.toBeNull();
    expect(await adapter.readProof(SCOPE_ID, prospective.proofId)).toBeNull();
  });

  it("keeps retained CTF proof bodies without canonical spendable rows", async () => {
    const database = databaseFor();
    const retained = restoreRow({ retained: true });
    const selectable = restoreRow({ secret: "22".repeat(32), ctf: true });
    await commit(restoreStore(database), [retained, selectable]);
    expect(await database.encryptedWalletBackupRestoreProofs.count()).toBe(2);
    expect(await database.proofs.count()).toBe(1);
    expect(await database.custodyProofs.count()).toBe(1);
    expect(await database.proofs.get(retained.proof.proof.secret)).toBeUndefined();
  });

  it.each(["classic proof", "custody proof", "reservation", "backup authority"])(
    "rejects a %s authority conflict without mutation",
    async (kind) => {
      const database = databaseFor();
      const row = restoreRow();
      await insertConflict(database, row, kind);
      await expect(commit(restoreStore(database), [row], "complete-origin")).rejects.toThrow(
        /conflict/,
      );
      expect(await database.encryptedWalletBackupRestoreProofs.count()).toBe(0);
    },
  );

  it("rejects duplicate proof ids, invalid body ids, and a batch above 64", async () => {
    const database = databaseFor();
    const row = restoreRow();
    expect(
      () => new BrowserEncryptedWalletBackupRestoreDexieStore({ database, scopeId: "foreign" }),
    ).toThrow(/scope id is invalid/);
    expect(
      () =>
        new BrowserEncryptedWalletBackupRestoreDexieStore({
          database: new BitcasterDB("foreign"),
          scopeId: SCOPE_ID,
        }),
    ).toThrow(/does not match/);
    await expect(commit(restoreStore(database), [row, row])).rejects.toThrow(/duplicated/);
    await expect(
      commit(restoreStore(database), [
        { ...row, proof: { ...row.proof, proofId: "00".repeat(32) } },
      ]),
    ).rejects.toThrow(/body conflicts/);
    await expect(
      commit(restoreStore(database), [
        {
          ...row,
          proof: { ...row.proof, proof: { ...row.proof.proof, p2pk_e: "forbidden" } } as never,
        },
      ]),
    ).rejects.toThrow(/unsupported spending authority/);
    await expect(
      commit(restoreStore(database), [
        {
          ...row,
          proof: { ...row.proof, proof: { ...row.proof.proof, witness: "forbidden" } } as never,
        },
      ]),
    ).rejects.toThrow(/unsupported spending authority/);
    await expect(
      commit(restoreStore(database), [
        {
          ...row,
          storageClassification: { ...row.storageClassification, recordId: "00".repeat(32) },
        },
      ]),
    ).rejects.toThrow(/classification conflicts/);
    await expect(
      commit(
        restoreStore(database),
        Array.from({ length: 65 }, () => row),
      ),
    ).rejects.toThrow(/exceeds the limit/);
  });

  it("calls the callback once, rejects async callbacks, and rolls back callback or abort failures", async () => {
    const database = databaseFor();
    const store = restoreStore(database);
    const row = restoreRow();
    const callback = vi.fn(() => "done");
    await expect(commit(store, [row], "complete-origin", callback)).resolves.toBe("done");
    expect(callback).toHaveBeenCalledTimes(1);
    await expect(
      commit(
        store,
        [restoreRow({ secret: "22".repeat(32) })],
        "complete-origin",
        async () => "bad",
      ),
    ).rejects.toThrow(/synchronous/);
    const callbackFailure = restoreRow({ secret: "33".repeat(32) });
    await expect(
      commit(store, [callbackFailure], "complete-origin", () => {
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    const controller = new AbortController();
    const aborted = restoreRow({ secret: "44".repeat(32) });
    await expect(
      commit(
        store,
        [aborted],
        "complete-origin",
        () => {
          controller.abort();
          return "no";
        },
        controller.signal,
      ),
    ).rejects.toThrow(/aborted/);
    expect(await database.encryptedWalletBackupRestoreProofs.count()).toBe(1);
  });

  it("preserves each current identity and accepts exactly 64 proof rows", async () => {
    const database = databaseFor();
    const rows = Array.from({ length: 64 }, (_, index) =>
      restoreRow({ secret: (index + 1).toString(16).padStart(64, "0") }),
    );
    await commit(restoreStore(database), rows, "complete-origin", (current) => {
      expect(current.map(({ proofId }) => proofId)).toEqual(rows.map(({ proofId }) => proofId));
      expect(
        current.every(
          ({ storageClassification, proof }) => storageClassification === null && proof === null,
        ),
      ).toBe(true);
      return "page";
    });
    expect(await database.encryptedWalletBackupRestoreProofs.count()).toBe(64);
  });

  it("rolls back every write when a canonical proof write fails", async () => {
    const database = databaseFor();
    const store = restoreStore(database);
    const row = restoreRow();
    vi.spyOn(database.custodyProofs, "bulkPut").mockRejectedValueOnce(new Error("write failed"));
    await expect(commit(store, [row])).rejects.toThrow("write failed");
    expect(await database.encryptedWalletBackupRestoreProofs.count()).toBe(0);
    expect(await database.proofs.count()).toBe(0);
    expect(await database.custodyProofs.count()).toBe(0);
  });

  it.each(["complete-origin", "hydrate-existing"] as const)(
    "applies an expired CTF transition in %s mode",
    async (restoreMode) => {
      const database = databaseFor();
      const active = restoreRow({ ctf: true });
      const retained = restoreRow({ secret: active.proof.proof.secret, retained: true });
      await commit(restoreStore(database), [active]);
      await commit(restoreStore(database), [retained], restoreMode);
      expect(await database.proofs.get(active.proof.proof.secret)).toBeUndefined();
      expect(await database.custodyProofs.get([SCOPE_ID, active.proofId])).toBeUndefined();
      expect(
        await database.custodyProofBackupAuthorities.get([SCOPE_ID, active.proofId]),
      ).toBeUndefined();
      expect(
        (await database.encryptedWalletBackupRestoreProofs.get([SCOPE_ID, active.proofId]))?.proof
          ?.disposition,
      ).toBe("user-retained-nonselectable");
    },
  );

  it.each(["complete-origin", "hydrate-existing"] as const)(
    "applies a verified-losing CTF transition in %s mode",
    async (restoreMode) => {
      const database = databaseFor();
      const active = restoreRow({ ctf: true });
      const retained = restoreRow({ secret: active.proof.proof.secret, verifiedLosing: true });
      await commit(restoreStore(database), [active]);
      await commit(restoreStore(database), [retained], restoreMode);
      expect(
        await database.custodyProofBackupAuthorities.get([SCOPE_ID, active.proofId]),
      ).toBeUndefined();
      expect(
        (await database.encryptedWalletBackupRestoreProofs.get([SCOPE_ID, active.proofId]))?.proof
          ?.nonselectableReason,
      ).toBe("verified-losing-outcome");
    },
  );

  it("does not scan 10,000 unrelated history and pin rows", async () => {
    const database = databaseFor();
    await database.proofOperations.bulkPut(
      Array.from({ length: 10_000 }, (_, index) => ({ operationId: `history-${index}` })) as never,
    );
    const operations = vi.spyOn(database.proofOperations, "toArray");
    const pins = vi.spyOn(database.encryptedWalletBackupSnapshotPins, "toArray");
    const sources = vi.spyOn(database.encryptedWalletBackupPreparedSources, "toArray");
    await commit(restoreStore(database), [restoreRow()]);
    expect(operations).not.toHaveBeenCalled();
    expect(pins).not.toHaveBeenCalled();
    expect(sources).not.toHaveBeenCalled();
  });

  it("retains a remote-backed proof as the exact next snapshot entry", async () => {
    const database = databaseFor();
    const row = restoreRow();
    await commit(restoreStore(database), [row]);
    const snapshots = new BrowserEncryptedWalletBackupProofSnapshotDexieStore({
      database,
      scopeId: SCOPE_ID,
      snapshotId: "next-snapshot",
      snapshotRevision: 1,
    });
    await snapshots.withCommittedProofSnapshot(row.proofId, (snapshot) => {
      expect(snapshot.proofId).toBe(row.proofId);
      expect(snapshot.proofCommitment).toBe(row.proof.proofCommitment);
      expect(snapshot.derivationLocator).toEqual(row.proof.derivationLocator);
    });
  });

  it("uses a restored proof for a funded operation and keeps its remote backup origin", async () => {
    const database = databaseFor();
    const row = restoreRow();
    await commit(restoreStore(database), [row]);
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await adapter.claimScope(scope, {
      incarnationId: "restore-funded-operation",
      observedAtMs: 1_700_000_000_100,
      leaseExpiresAtMs: 1_700_000_010_100,
    });
    const predecessor = toCashuProof(row.proof.proof);
    const successorProof = cashuProof("bb".repeat(32));
    const source = operationBinding(scope, "restored-source", predecessor, successorProof.secret);
    const restoredPredecessor = await adapter.readProof(SCOPE_ID, row.proofId);
    if (restoredPredecessor === null) throw new Error("restored predecessor is missing");

    await adapter.transact(
      selection(scope, owner, source.record.operation.operationId, null),
      (transaction) =>
        bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
      {
        predecessorProofs: {
          [source.record.operation.operationId]: [restoredPredecessor],
        },
      },
    );
    expect((await adapter.readProof(SCOPE_ID, row.proofId))?.selectability).toBe("locked");
    expect(await database.custodyProofBackupAuthorities.get([SCOPE_ID, row.proofId])).toMatchObject(
      {
        backupState: "remote-backed",
        backupRecordId: row.proofId,
        backupRecordCommitment: row.proof.proofCommitment,
        admissionOperationId: null,
        proofState: "locked",
        proofRevision: 1,
      },
    );
    const lockedSnapshots = new BrowserEncryptedWalletBackupProofSnapshotDexieStore({
      database,
      scopeId: SCOPE_ID,
      snapshotId: "locked-remote-parent",
      snapshotRevision: 1,
    });
    const lockedPage = await lockedSnapshots.listEligibleCommittedProofSnapshotPage(null);
    expect(lockedPage.items).toHaveLength(1);
    expect(lockedPage.items[0]!.snapshot).toMatchObject({
      proofId: row.proofId,
      proofCommitment: row.proof.proofCommitment,
      reserved: false,
    });

    const successor = createBrowserCustodyProofRow({
      scopeId: SCOPE_ID,
      normalizedMint: MINT,
      unit: "sat",
      proof: successorProof,
      asset: { kind: "regular" },
      receivedAtMs: 1_700_000_000_200,
    });
    const exactResult = prepareDurableCustodyExactArtifact({
      authorization: [successorProof],
      keep: [],
    });
    const resultFingerprint = deriveDurableCustodyProofResultFingerprint({
      authorization: [successorProof],
      keep: [],
    });
    const stageOwner = observedOwner(owner, 1_700_000_000_200);
    await adapter.transact(
      selection(scope, stageOwner, source.record.operation.operationId, 0),
      (transaction) =>
        transaction.stageVerifiedResult({
          operationId: source.record.operation.operationId,
          expectedRevision: 0,
          authorization: stageOwner,
          outputPlanFingerprint: source.record.operation.outputPlan.outputPlanFingerprint,
          resultHandle: `restored-result:${resultFingerprint}`,
          resultFingerprint,
          exactResult,
          selectedSuccessorProofIds: [successor.proofId],
        }),
    );
    const applyOwner = observedOwner(owner, 1_700_000_000_300);
    await adapter.transact(
      selection(scope, applyOwner, source.record.operation.operationId, 1),
      (transaction) =>
        transaction.applyVerifiedResult({
          operationId: source.record.operation.operationId,
          expectedRevision: 1,
          authorization: applyOwner,
          outputPlanFingerprint: source.record.operation.outputPlan.outputPlanFingerprint,
          resultHandle: `restored-result:${resultFingerprint}`,
          resultFingerprint,
          successorAdmission: {
            scopeId: SCOPE_ID,
            operationId: source.record.operation.operationId,
            admissionId: `restored-admission:${resultFingerprint}`,
            proofRows: [
              { proofId: successor.proofId, expectedRevision: null, admittedRevision: 0 },
            ],
          },
        }),
      {
        successorProofs: {
          [source.record.operation.operationId]: [
            { proof: successor, expectedRevision: null, derivationLocator: null },
          ],
        },
      },
    );

    const restarted = new BrowserDurableCustodyAdapter(database);
    expect((await restarted.readProof(SCOPE_ID, row.proofId))?.selectability).toBe("spent");
    expect((await restarted.readProof(SCOPE_ID, successor.proofId))?.selectability).toBe(
      "selectable",
    );
    expect(await database.custodyProofBackupAuthorities.get([SCOPE_ID, row.proofId])).toMatchObject(
      {
        backupState: "remote-backed",
        backupRecordId: row.proofId,
        backupRecordCommitment: row.proof.proofCommitment,
        admissionOperationId: null,
        proofState: "spent",
        proofRevision: 2,
      },
    );
    expect(
      await database.custodyProofBackupAuthorities.get([SCOPE_ID, successor.proofId]),
    ).toMatchObject({
      backupState: "local-only",
      admissionOperationId: source.record.operation.operationId,
      backupRecordId: null,
      backupRecordCommitment: null,
    });
    const completedPage = await lockedSnapshots.listEligibleCommittedProofSnapshotPage(null);
    expect(completedPage.items).toEqual([]);
  });

  it("materializes verified losing evidence for a remote-backed CTF proof", async () => {
    const database = databaseFor();
    const row = restoreRow({ ctf: true });
    await commit(restoreStore(database), [row]);
    await database.custodyConditionalKeysets.put({
      scopeId: SCOPE_ID,
      schemaVersion: 1,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: CTF_KEYSET,
      denominationPublicKeys: { "1": PUBLIC_KEY },
      inputFeePpk: 0,
      conditionId: CTF_CONDITION_ID,
      outcomeCollection: CTF_OUTCOME_COLLECTION,
      outcomeCollectionId: CTF_OUTCOME_COLLECTION_ID,
      registeredAtUnixSeconds: 1,
      finalExpiryUnixSeconds: 1_800_000_000,
      curve: "secp256k1",
    });
    const terminalOperationId = "restore-ctf-redeem";
    await database.proofOperations.put({
      operationId: terminalOperationId,
      kind: "ctf-redeem",
      state: "Failed",
      mintUrl: MINT,
      inputs: [toCashuProof(row.proof.proof)],
      outputs: {},
      metadata: { unit: "msat" },
      failureCode: 13015,
      createdAt: 1_700_000_000_100,
      updatedAt: 1_700_000_000_200,
    });
    const authority = await database.custodyProofBackupAuthorities.get([SCOPE_ID, row.proofId]);
    if (!authority) throw new Error("restored CTF authority is missing");
    await database.custodyProofBackupAuthorities.put(
      bindBrowserProofBackupAuthorityTerminalOperation(
        authority,
        terminalOperationId,
        1_700_000_000_200,
      ),
    );
    const snapshots = new BrowserEncryptedWalletBackupProofSnapshotDexieStore({
      database,
      scopeId: SCOPE_ID,
      snapshotId: "terminal-snapshot",
      snapshotRevision: 2,
    });
    const page = await snapshots.listEligibleCommittedProofSnapshotPage(null);
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.snapshot.terminalOperationId).toBe(terminalOperationId);
    expect(item.snapshot.proofCommitment).not.toBe(row.proof.proofCommitment);
    expect(item.proofInput.terminalEvidence).not.toBeNull();
  });

  it("pages remote CTF terminal proofs through 10,000 indexed authority rows", async () => {
    const database = databaseFor();
    const rows = Array.from({ length: 84 }, (_, index) => remoteCtfRestoreRow(index));
    await commit(restoreStore(database), rows.slice(0, 64));
    await commit(restoreStore(database), rows.slice(64));
    await database.custodyConditionalKeysets.put({
      scopeId: SCOPE_ID,
      schemaVersion: 1,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: CTF_KEYSET,
      denominationPublicKeys: { "1": PUBLIC_KEY },
      inputFeePpk: 0,
      conditionId: CTF_CONDITION_ID,
      outcomeCollection: CTF_OUTCOME_COLLECTION,
      outcomeCollectionId: CTF_OUTCOME_COLLECTION_ID,
      registeredAtUnixSeconds: 1,
      finalExpiryUnixSeconds: 1_800_000_000,
      curve: "secp256k1",
    });
    const terminalOperationId = "remote-page-terminal";
    await database.proofOperations.put({
      operationId: terminalOperationId,
      kind: "ctf-redeem",
      state: "Failed",
      mintUrl: MINT,
      inputs: rows.map((row) => toCashuProof(row.proof.proof)),
      outputs: {},
      metadata: { unit: "msat" },
      failureCode: 13015,
      createdAt: 1_700_000_000_100,
      updatedAt: 1_700_000_000_200,
    });
    const keys = rows.map(({ proofId }) => [SCOPE_ID, proofId] as [string, string]);
    const authorities = await database.custodyProofBackupAuthorities.bulkGet(keys);
    await database.custodyProofBackupAuthorities.bulkPut(
      authorities.map((authority) => {
        if (!authority) throw new Error("remote page authority is missing");
        return bindBrowserProofBackupAuthorityTerminalOperation(
          authority,
          terminalOperationId,
          1_700_000_000_200,
        );
      }),
    );
    await database.custodyProofBackupAuthorities.bulkPut(
      Array.from({ length: 10_000 - rows.length }, (_, index) => ({
        scopeId: SCOPE_ID,
        proofId: `ff${index.toString(16).padStart(62, "0")}`,
      })) as never,
    );

    const snapshots = new BrowserEncryptedWalletBackupProofSnapshotDexieStore({
      database,
      scopeId: SCOPE_ID,
      snapshotId: "remote-page",
      snapshotRevision: 1,
    });
    const first = await snapshots.listEligibleCommittedProofSnapshotPage(null);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(10_000);
    expect(first.items).toHaveLength(42);
    expect(first.nextCursor).toBe(first.items.at(-1)!.snapshot.proofId);
    expect(
      first.items.every((item) => item.snapshot.terminalOperationId === terminalOperationId),
    ).toBe(true);
    const second = await snapshots.listEligibleCommittedProofSnapshotPage(first.nextCursor);
    expect(second.items).toHaveLength(42);
    expect(second.items[0]!.snapshot.proofId > first.nextCursor!).toBe(true);
    expect(
      second.items.every((item) => item.snapshot.terminalOperationId === terminalOperationId),
    ).toBe(true);
  });

  it.each(["classic", "classic-p2pk", "classic-witness", "custody", "authority", "restore"])(
    "rejects a %s row with a changed authoritative field",
    async (kind) => {
      const database = databaseFor();
      const row = restoreRow();
      await commit(restoreStore(database), [row]);
      if (kind === "classic" || kind === "classic-p2pk" || kind === "classic-witness") {
        const current = await database.proofs.get(row.proof.proof.secret);
        if (!current) throw new Error("missing classic proof");
        await database.proofs.put({
          ...current,
          ...(kind === "classic"
            ? {
                reservedBy: "reservation",
                terminalOperationId: "terminal",
                marketId: "market",
                baseAsset: "changed",
                receivedAt: current.receivedAt! + 1,
                dleq: { e: "01".repeat(32), s: "01".repeat(32), r: "01".repeat(32) },
              }
            : kind === "classic-p2pk"
              ? { p2pk_e: "foreign" }
              : { witness: "foreign" }),
        });
      } else if (kind === "custody") {
        const current = await database.custodyProofs.get([SCOPE_ID, row.proofId]);
        if (!current) throw new Error("missing custody proof");
        await database.custodyProofs.put({ ...current, revision: current.revision + 1 });
      } else if (kind === "authority") {
        const current = await database.custodyProofBackupAuthorities.get([SCOPE_ID, row.proofId]);
        if (!current) throw new Error("missing proof authority");
        await database.custodyProofBackupAuthorities.put({
          ...current,
          updatedAtMs: current.updatedAtMs + 1,
        });
      } else {
        const current = await database.encryptedWalletBackupRestoreProofs.get([
          SCOPE_ID,
          row.proofId,
        ]);
        if (!current || current.proof === null) throw new Error("missing restore proof");
        await database.encryptedWalletBackupRestoreProofs.put({
          ...current,
          proof: {
            ...current.proof,
            proof: {
              ...current.proof.proof,
              dleq: { e: "01".repeat(32), s: "01".repeat(32), r: "01".repeat(32) },
            },
          },
        });
      }
      await expect(commit(restoreStore(database), [row])).rejects.toThrow(/conflict/);
    },
  );
});

function databaseFor(): BitcasterDB {
  const database = new BitcasterDB(browserWalletDatabaseName(SCOPE_ID));
  databases.push(database);
  return database;
}

function restoreStore(database: BitcasterDB): BrowserEncryptedWalletBackupRestoreDexieStore {
  return new BrowserEncryptedWalletBackupRestoreDexieStore({ database, scopeId: SCOPE_ID });
}

function commit<T>(
  store: BrowserEncryptedWalletBackupRestoreDexieStore,
  expected: readonly EncryptedWalletBackupRestoreProofRow[],
  restoreMode: "complete-origin" | "hydrate-existing" = "complete-origin",
  callback: (current: Parameters<Parameters<typeof store.commitRestoredProofs>[1]>[0]) => T = () =>
    "committed" as T,
  signal: AbortSignal = new AbortController().signal,
) {
  return store.commitRestoredProofs({ expected, restoreMode, signal }, callback);
}

function restoreRow(
  input: { secret?: string; ctf?: boolean; retained?: boolean; verifiedLosing?: boolean } = {},
): EncryptedWalletBackupRestoreProofRow {
  const secret = input.secret ?? "aa".repeat(32);
  const ctf = input.ctf === true || input.retained === true || input.verifiedLosing === true;
  const unit = ctf ? "msat" : "sat";
  const keysetId = ctf ? CTF_KEYSET : KEYSET;
  const provisional = createBrowserCustodyProofRow({
    scopeId: SCOPE_ID,
    normalizedMint: MINT,
    unit,
    proof: {
      id: keysetId,
      amount: Amount.from(1),
      secret,
      C: ctf ? PUBLIC_KEY : `02${"22".repeat(32)}`,
      dleq: { e: "00".repeat(32), s: "00".repeat(32), r: "00".repeat(32) },
    },
    asset: ctf
      ? {
          kind: "conditional",
          conditionId: CTF_CONDITION_ID,
          outcomeCollection: CTF_OUTCOME_COLLECTION,
        }
      : { kind: "regular" },
    receivedAtMs: 1_700_000_000_000,
  });
  const proof: EncryptedWalletBackupRestoreProofRow["proof"] = {
    schemaVersion: 1 as const,
    realm: "restore-test",
    vaultId: "33".repeat(32),
    generation: 1,
    manifestDigest: "44".repeat(32),
    parentGeneration: null,
    parentManifestDigest: null,
    chunkObjectId: "55".repeat(16),
    chunkDigest: "66".repeat(32),
    proofId: provisional.proofId,
    proofCommitment: "",
    mint: MINT,
    unit,
    derivationLocator: {
      schemaVersion: 1 as const,
      kind: "nut13" as const,
      keysetId,
      counter: 0,
    },
    proofKind: ctf ? ("ctf" as const) : ("ordinary" as const),
    ctfMetadata: ctf
      ? {
          conditionId: CTF_CONDITION_ID,
          outcomeLabel: CTF_OUTCOME_COLLECTION,
          outcomeCollectionId: CTF_OUTCOME_COLLECTION_ID,
          registeredAtUnixSeconds: 1,
          finalExpiryUnixSeconds: 1_800_000_000,
        }
      : null,
    terminalEvidence: null,
    createdAtUnixSeconds: 1_700_000_000,
    updatedAtUnixSeconds: 1_700_000_000,
    disposition:
      input.retained || input.verifiedLosing
        ? "user-retained-nonselectable"
        : ("selectable" as const),
    nonselectableReason: input.verifiedLosing
      ? ("verified-losing-outcome" as const)
      : input.retained
        ? ("recorded-ctf-expiry-passed" as const)
        : null,
    proof: {
      id: keysetId,
      amount: "1",
      secret,
      C: ctf ? PUBLIC_KEY : `02${"22".repeat(32)}`,
      dleq: { e: "00".repeat(32), s: "00".repeat(32), r: "00".repeat(32) },
    },
  };
  const proofCommitment = deriveEncryptedWalletBackupProofCommitment({
    scopeId: SCOPE_ID,
    mint: proof.mint,
    unit: proof.unit,
    derivationLocator: proof.derivationLocator,
    proof: proof.proof,
    proofKind: proof.proofKind,
    ctfMetadata: proof.ctfMetadata,
    terminalEvidence: null,
    createdAtUnixSeconds: proof.createdAtUnixSeconds,
    updatedAtUnixSeconds: proof.updatedAtUnixSeconds,
  }).commitment;
  return {
    proofId: provisional.proofId,
    storageClassification: classifyDurableWalletStorage({
      schemaVersion: 1,
      recordId: provisional.proofId,
      kind: "deterministic-proof",
      provenance: "wallet-seed",
      proofKind: ctf ? "ctf" : "ordinary",
      ctfMetadata: ctf ? { finalExpiryUnixSeconds: 1_800_000_000, terminalEvidence: null } : null,
      effectiveNowUnixSeconds:
        input.retained || input.verifiedLosing ? 1_800_000_000 : 1_700_000_000,
      operationBinding: "terminally-unlinked",
      reserved: false,
      ambiguousMintOperation: false,
      proofPins: {
        openOrderCollateral: "absent",
        outbox: "absent",
        retryCursor: "absent",
        replayTombstone: "absent",
        dependentWork: "absent",
      },
      derivationLocator: "committed",
      proofCommitment: { state: "verified", digest: proofCommitment },
      backupReceiptEvidence:
        input.retained || input.verifiedLosing ? null : authenticatedReceipt(proofCommitment),
    }),
    proof: { ...proof, proofCommitment },
  };
}

function remoteCtfRestoreRow(index: number): EncryptedWalletBackupRestoreProofRow {
  for (let attempt = 0; ; attempt += 1) {
    const row = restoreRow({
      ctf: true,
      secret: (index * 1_000 + attempt + 1).toString(16).padStart(64, "0"),
    });
    if (!row.proofId.startsWith("ff")) return row;
  }
}

function authenticatedReceipt(proofCommitment: string) {
  const head = {
    formatVersion: 1 as const,
    realm: "restore-test",
    backupPublicKey: "99".repeat(32),
    generation: 1,
    manifestDigest: "44".repeat(32),
  };
  return issueDurableWalletAuthenticatedBackupReceipt(
    Object.freeze(
      decodeDurableWalletEncryptedBackupReceipt({
        ...head,
        snapshotId: deriveDurableWalletBackupSnapshotId(head),
        chunkDigest: "66".repeat(32),
        proofCommitment,
      }),
    ),
  );
}

function walletScope(): Extract<DurableCustodyScope, { scopeKind: "wallet" }> {
  const walletId = deriveDurableCustodyWalletId(
    Uint8Array.from({ length: 32 }, (_, index) => index),
  );
  return { scopeKind: "wallet", walletId, scopeId: SCOPE_ID };
}

function selection(
  scope: DurableCustodyScope,
  owner: DurableCustodyOwnerAuthorization,
  operationId: string,
  expectedRevision: number | null,
) {
  return { scope, owner, operationRows: [{ operationId, expectedRevision }] };
}

function observedOwner(
  owner: DurableCustodyOwnerAuthorization,
  observedAtMs: number,
): DurableCustodyOwnerAuthorization {
  return { ...owner, observedAtMs };
}

function toCashuProof(value: EncryptedWalletBackupRestoreProofRow["proof"]["proof"]): Proof {
  return { ...value, amount: Number(value.amount) as never };
}

function cashuProof(secret: string): Proof {
  return {
    id: KEYSET,
    amount: 1 as never,
    secret,
    C: `02${"22".repeat(32)}`,
  };
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
    metadata: { unit: "sat" },
  };
  const artifacts = {
    requestBody: prepareDurableCustodyExactArtifact(operation),
    output: prepareDurableCustodyExactArtifact(operation.outputs),
    privateMaterial: prepareDurableCustodyExactArtifact(operation),
  };
  const facts = createDurableProofOperationFacts({
    unit: "sat",
    binding: { kind: "wallet", activityId: operationId, stage: "send" },
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: true,
    inputKeysetRequirement: "required",
    keysets: [
      {
        keysetId: KEYSET,
        unit: "sat",
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

async function insertConflict(
  database: BitcasterDB,
  row: EncryptedWalletBackupRestoreProofRow,
  kind: string,
): Promise<void> {
  const custody = createBrowserCustodyProofRow({
    scopeId: SCOPE_ID,
    normalizedMint: MINT,
    unit: row.proof.unit as "sat" | "msat",
    proof: { ...row.proof.proof, amount: Amount.from(row.proof.proof.amount) },
    asset:
      row.proof.ctfMetadata === null
        ? { kind: "regular" }
        : {
            kind: "conditional",
            conditionId: row.proof.ctfMetadata.conditionId,
            outcomeCollection: row.proof.ctfMetadata.outcomeLabel,
          },
    receivedAtMs: row.proof.createdAtUnixSeconds * 1_000,
  });
  if (kind === "classic proof")
    await database.proofs.put({
      ...row.proof.proof,
      amount: 1,
      mintUrl: MINT,
      baseAsset: "sat",
      unit: row.proof.unit as "sat" | "msat",
      receivedAt: row.proof.createdAtUnixSeconds * 1_000,
    });
  else if (kind === "custody proof") await database.custodyProofs.put(custody);
  else if (kind === "reservation")
    await database.custodyReservations.put({
      scopeId: SCOPE_ID,
      proofId: row.proofId,
      operationId: "operation",
      reservationId: "reservation",
      inputPosition: 0,
    });
  else if (kind === "backup authority")
    await database.custodyProofBackupAuthorities.put({
      scopeId: SCOPE_ID,
      proofId: row.proofId,
    } as never);
}
