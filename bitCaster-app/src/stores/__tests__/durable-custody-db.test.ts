// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { Amount, OutputData, deriveConditionalKeysetId, type Proof } from "@cashu/cashu-ts";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  createDurableProofOperationFacts,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
  type DurableCustodyTransaction,
} from "@bitcaster/client-sdk/durableCustody";
import type { DurableCustodyProofOperationInput } from "@bitcaster/client-sdk/durableCustodyProofOperation";
import { deriveMarketFundingProductBinding } from "@bitcaster/client-sdk/marketFundingDelivery";
import {
  createDurableOutgoingCashuTransfer,
  type DurableOutgoingCashuTransfer,
} from "@bitcaster/client-sdk/durableOutgoingCashuTransfer";
import { serializeDurableWalletSendOperation } from "@bitcaster/client-sdk/durableWalletOperation";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  encryptedWalletBackupV2LocalAssetKey,
} from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
  deriveDurableCustodyProofResultFingerprint,
} from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
  persistBrowserOutgoingCashuTransferRewrite,
} from "../durable-custody-db";
import {
  advanceBrowserProofBackupAuthorityRow,
  bindBrowserProofBackupAuthorityTerminalOperation,
  classifyBrowserProofBackupAuthorityVerifiedLosing,
  createBrowserCompletedProofRemovalMarkerRow,
  createBrowserRemoteProofBackupAuthorityRow,
  createBrowserProofBackupAuthorityRow,
  type BrowserProofBackupAuthorityRow,
} from "../browser-proof-backup-authority";
import type { BrowserCustodyProofRow } from "../durable-custody-types";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  createEncryptedWalletBackupV2RemovalIntent,
} from "../browser-encrypted-wallet-backup-v2-desired-asset";
import {
  BitcasterDB,
  browserOutgoingPredecessorKey,
  findBrowserOutgoingCashuTransferByPredecessor,
  storedProofRow,
  type BrowserOutgoingCashuTransferRow,
} from "../proof-db";

const MINT = "https://mint.example";
const KEYSET = `01${"11".repeat(32)}`;
const PUBLIC_KEY = `02${"11".repeat(32)}`;
const TERMINAL_CONDITION = "aa".repeat(32);
const TERMINAL_OUTCOME_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: TERMINAL_CONDITION,
  outcomeCollection: "YES",
});
const TERMINAL_KEYSET = deriveConditionalKeysetId({
  keys: { "1": PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 0,
  final_expiry: 2,
  conditionId: TERMINAL_CONDITION,
  outcomeCollectionId: TERMINAL_OUTCOME_ID,
});
const REMOTE_REPLAY_LOCATOR = {
  schemaVersion: 1 as const,
  kind: "nut13" as const,
  keysetId: TERMINAL_KEYSET,
  counter: 7,
};
const openDatabases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("browser durable custody adapter", () => {
  it.each(["remote-terminal", "local-terminal", "selectable"] as const)(
    "retires exact mint-spent %s proof authority and retains its body",
    async (kind) => {
      const fixture = await mintSpentRetirementFixture(kind);
      const beforeBody = fixture.candidates[0]!.proof.proofBody.slice();

      const result = await fixture.adapter.retireExactMintSpentProofs({
        scopeId: fixture.scope.scopeId,
        candidates: fixture.candidates,
        expectedDesiredAsset: fixture.desired,
        observedAtMs: 20,
      });

      const retired = await fixture.adapter.readProof(
        fixture.scope.scopeId,
        fixture.candidates[0]!.proof.proofId,
      );
      expect(retired).toMatchObject({
        revision: fixture.candidates[0]!.proof.revision + 1,
        selectability: "spent",
        reservationOperationId: null,
      });
      expect(
        retired !== null &&
          retired.proofBody.byteLength === beforeBody.byteLength &&
          retired.proofBody.every((byte, index) => byte === beforeBody[index]),
      ).toBe(true);
      const authority = await fixture.database.custodyProofBackupAuthorities.get([
        fixture.scope.scopeId,
        fixture.candidates[0]!.proof.proofId,
      ]);
      expect(authority).toMatchObject({
        proofState: "spent",
        proofRevision: fixture.candidates[0]!.proof.revision + 1,
        terminalAuthority: fixture.candidates[0]!.authority.terminalAuthority,
      });
      expect(result).toMatchObject({
        custodyRevision: "2",
        activeProofCount: 0,
        desiredAction: "remove",
        syncState: "pending",
      });
      await expect(
        fixture.database.encryptedWalletBackupV2DesiredAssets.get([
          fixture.scope.scopeId,
          result.localAssetKey,
        ]),
      ).resolves.toEqual(result);
    },
  );

  it("retires one exact batch with one desired-asset revision advance", async () => {
    const fixture = await mintSpentRetirementFixture("selectable", 2, 3);

    const result = await fixture.adapter.retireExactMintSpentProofs({
      scopeId: fixture.scope.scopeId,
      candidates: fixture.candidates,
      expectedDesiredAsset: fixture.desired,
      observedAtMs: 20,
    });

    expect(result).toMatchObject({ custodyRevision: "2", activeProofCount: 1 });
    const retired = await fixture.database.custodyProofs.bulkGet(
      fixture.candidates.map(({ proof }) => [fixture.scope.scopeId, proof.proofId]),
    );
    expect(retired.map((proofRow) => proofRow?.selectability)).toEqual(["spent", "spent"]);
  });

  it("joins one caller-owned transaction for exact mint-spent retirement", async () => {
    const fixture = await mintSpentRetirementFixture("selectable");

    const result = await fixture.database.transaction(
      "rw",
      [
        fixture.database.custodyOperations,
        fixture.database.custodyProofs,
        fixture.database.custodyReservations,
        fixture.database.custodyActiveWork,
        fixture.database.custodyProofBackupAuthorities,
        fixture.database.custodyConditionalKeysets,
        fixture.database.encryptedWalletBackupV2DesiredAssets,
      ],
      async () => {
        const transaction = Dexie.currentTransaction;
        if (transaction === undefined) throw new Error("test transaction is missing");
        return fixture.adapter.retireExactMintSpentProofsInCurrentTransaction(transaction, {
          scopeId: fixture.scope.scopeId,
          candidates: fixture.candidates,
          expectedDesiredAsset: fixture.desired,
          observedAtMs: 20,
        });
      },
    );

    expect(result).toMatchObject({ custodyRevision: "2", activeProofCount: 0 });
  });

  it.each(["locked", "pending-removal"] as const)(
    "refuses a %s predecessor before exact mint-spent retirement",
    async (selectability) => {
      const fixture = await mintSpentRetirementFixture(
        selectability === "locked" ? "selectable" : "local-terminal",
      );
      const candidate = fixture.candidates[0]!;
      await expect(
        fixture.adapter.retireExactMintSpentProofs({
          scopeId: fixture.scope.scopeId,
          candidates: [
            {
              ...candidate,
              proof: {
                ...candidate.proof,
                selectability,
                reservationOperationId: selectability === "locked" ? "reservation" : null,
              },
            },
          ],
          expectedDesiredAsset: fixture.desired,
          observedAtMs: 20,
        }),
      ).rejects.toThrow(/predecessor is invalid/);
    },
  );

  it("rolls back proof, authority, and desired state on reservation and injected faults", async () => {
    const reserved = await mintSpentRetirementFixture("selectable");
    const candidate = reserved.candidates[0]!;
    await reserved.database.custodyReservations.put({
      scopeId: reserved.scope.scopeId,
      proofId: candidate.proof.proofId,
      operationId: "foreign-reservation",
      reservationId: "foreign-reservation:0",
      inputPosition: 0,
    });
    await expect(
      reserved.adapter.retireExactMintSpentProofs({
        scopeId: reserved.scope.scopeId,
        candidates: reserved.candidates,
        expectedDesiredAsset: reserved.desired,
        observedAtMs: 20,
      }),
    ).rejects.toThrow(/proof is reserved/);
    expect(
      (await reserved.adapter.readProof(reserved.scope.scopeId, candidate.proof.proofId))
        ?.selectability,
    ).toBe("selectable");

    const fault = await mintSpentRetirementFixture("remote-terminal");
    await expect(
      fault.adapter.retireExactMintSpentProofs({
        scopeId: fault.scope.scopeId,
        candidates: fault.candidates,
        expectedDesiredAsset: fault.desired,
        observedAtMs: 20,
        injectFault: "before-commit",
      }),
    ).rejects.toThrow(/injected browser mint-spent retirement fault/);
    expect(
      (await fault.adapter.readProof(fault.scope.scopeId, fault.candidates[0]!.proof.proofId))
        ?.selectability,
    ).toBe("verified-losing");
    await expect(
      fault.database.encryptedWalletBackupV2DesiredAssets.get([
        fault.scope.scopeId,
        fault.desired.localAssetKey,
      ]),
    ).resolves.toEqual(fault.desired);
  });

  it("rejects active and unresolved creator work before mint-spent retirement", async () => {
    const fixture = await mintSpentRetirementFixture("selectable");
    const candidate = fixture.candidates[0]!;
    const source = operationBinding(
      fixture.scope,
      candidate.authority.admissionOperationId!,
      proof("mint-spent-active-input"),
      candidate.proof.proofId,
    );
    if (candidate.authority.backupState !== "local-only") {
      throw new Error("test mint-spent authority is not local");
    }
    const activeAuthority = {
      ...candidate.authority,
      admissionOperationId: source.record.operation.operationId,
    };
    fixture.candidates[0] = { proof: candidate.proof, authority: activeAuthority };
    await fixture.database.custodyProofBackupAuthorities.put(activeAuthority);
    const owner = await claim(fixture.adapter, fixture.scope, 10);
    const predecessor = createBrowserCustodyProofRow({
      scopeId: fixture.scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: source.operation.inputs[0] as Proof,
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    await fixture.adapter.transact(
      selection(fixture.scope, owner, source.record.operation.operationId, null),
      (transaction) =>
        bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
      { predecessorProofs: { [source.record.operation.operationId]: [predecessor] } },
    );
    expect(source.record.operation.operationId).toBe(activeAuthority.admissionOperationId);
    expect(
      await fixture.database.custodyActiveWork.get([
        fixture.scope.scopeId,
        source.record.operation.operationId,
      ]),
    ).toBeDefined();
    const retirement = {
      scopeId: fixture.scope.scopeId,
      candidates: fixture.candidates,
      expectedDesiredAsset: fixture.desired,
      observedAtMs: 20,
    } as const;
    await expect(fixture.adapter.retireExactMintSpentProofs(retirement)).rejects.toThrow(
      /active custody work/,
    );

    await fixture.database.custodyActiveWork.delete([
      fixture.scope.scopeId,
      source.record.operation.operationId,
    ]);
    await expect(fixture.adapter.retireExactMintSpentProofs(retirement)).rejects.toThrow(
      /unresolved custody operation/,
    );
  });

  it("rejects removal intent and exact proof or desired CAS changes", async () => {
    const intentFixture = await mintSpentRetirementFixture("remote-terminal");
    const candidate = intentFixture.candidates[0]!;
    const intent = createEncryptedWalletBackupV2RemovalIntent({
      intentId: "mint-spent-conflicting-removal",
      createdAtMs: 5,
      realm: "development",
      walletId: intentFixture.scope.walletId,
      enrollmentEpoch: 1,
      expectedHeadVersion: 0,
      expectedActiveSetDigest: "11".repeat(32),
      targetCustodyRevision: intentFixture.desired.custodyRevision,
      proofs: [
        {
          proofId: candidate.proof.proofId,
          proofFingerprint: candidate.proof.proofFingerprint,
          proofRevision: candidate.proof.revision,
          proofCommitment: "22".repeat(32),
        },
      ],
    });
    const desiredWithIntent = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: intentFixture.scope.scopeId,
      asset: {
        mintUrl: intentFixture.desired.mintUrl,
        unit: intentFixture.desired.unit,
        assetIdentity: intentFixture.desired.assetIdentity,
      },
      custodyRevision: BigInt(intentFixture.desired.custodyRevision),
      activeProofCount: intentFixture.desired.activeProofCount,
      terminalCtfContext: intentFixture.desired.terminalCtfContext,
      removalIntent: intent,
    });
    await intentFixture.database.encryptedWalletBackupV2DesiredAssets.put(desiredWithIntent);
    await expect(
      intentFixture.adapter.retireExactMintSpentProofs({
        scopeId: intentFixture.scope.scopeId,
        candidates: intentFixture.candidates,
        expectedDesiredAsset: desiredWithIntent,
        observedAtMs: 20,
      }),
    ).rejects.toThrow(/desired asset is invalid/);

    const stale = await mintSpentRetirementFixture("selectable");
    const staleCandidate = stale.candidates[0]!;
    if (staleCandidate.authority.backupState !== "local-only") {
      throw new Error("test mint-spent authority is not local");
    }
    const advancedProof = { ...staleCandidate.proof, revision: 1 };
    const advancedAuthority = advanceBrowserProofBackupAuthorityRow(
      staleCandidate.authority,
      advancedProof,
      3,
      staleCandidate.authority.derivationLocator,
      staleCandidate.authority.admissionOperationId,
    );
    await Promise.all([
      stale.database.custodyProofs.put(advancedProof),
      stale.database.custodyProofBackupAuthorities.put(advancedAuthority),
    ]);
    await expect(
      stale.adapter.retireExactMintSpentProofs({
        scopeId: stale.scope.scopeId,
        candidates: stale.candidates,
        expectedDesiredAsset: stale.desired,
        observedAtMs: 20,
      }),
    ).rejects.toThrow(/proof CAS is stale/);
    await expect(
      stale.database.encryptedWalletBackupV2DesiredAssets.get([
        stale.scope.scopeId,
        stale.desired.localAssetKey,
      ]),
    ).resolves.toEqual(stale.desired);

    const staleDesired = await mintSpentRetirementFixture("selectable");
    await staleDesired.database.encryptedWalletBackupV2DesiredAssets.put({
      ...staleDesired.desired,
      custodyRevision: "2",
    });
    await expect(
      staleDesired.adapter.retireExactMintSpentProofs({
        scopeId: staleDesired.scope.scopeId,
        candidates: staleDesired.candidates,
        expectedDesiredAsset: staleDesired.desired,
        observedAtMs: 20,
      }),
    ).rejects.toThrow(/desired asset CAS is stale/);
  });

  it("CASes the exact derivation locator and terminal origin", async () => {
    const locator = await mintSpentRetirementFixture("selectable");
    const locatorCandidate = locator.candidates[0]!;
    await expect(
      locator.adapter.retireExactMintSpentProofs({
        scopeId: locator.scope.scopeId,
        candidates: [
          {
            ...locatorCandidate,
            authority: {
              ...locatorCandidate.authority,
              derivationLocator: {
                ...REMOTE_REPLAY_LOCATOR,
                keysetId: locatorCandidate.proof.keysetId,
                counter: 99,
              },
            },
          },
        ],
        expectedDesiredAsset: locator.desired,
        observedAtMs: 20,
      }),
    ).rejects.toThrow(/authority CAS is stale/);

    const terminal = await mintSpentRetirementFixture("local-terminal");
    const terminalCandidate = terminal.candidates[0]!;
    await expect(
      terminal.adapter.retireExactMintSpentProofs({
        scopeId: terminal.scope.scopeId,
        candidates: [
          {
            ...terminalCandidate,
            authority: {
              ...terminalCandidate.authority,
              terminalOperationId: "foreign-terminal-operation",
              terminalAuthority: {
                kind: "local-operation",
                operationId: "foreign-terminal-operation",
              },
            },
          },
        ],
        expectedDesiredAsset: terminal.desired,
        observedAtMs: 20,
      }),
    ).rejects.toThrow(/authority CAS is stale/);
  });

  it("treats a bodyless completed-removal marker as removed and rejects a body beside it", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const proofRow = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: proof("completed-removal-read"),
      asset: { kind: "conditional", conditionId: TERMINAL_CONDITION, outcomeCollection: "YES" },
      receivedAtMs: 1,
    });
    const marker = completedRemovalMarker(scope, proofRow);
    await database.custodyProofBackupAuthorities.put(marker);

    await expect(adapter.readProof(scope.scopeId, proofRow.proofId)).resolves.toBeNull();
    await database.custodyProofs.put(proofRow);
    await expect(adapter.readProof(scope.scopeId, proofRow.proofId)).rejects.toThrow(
      "completed-removal authority",
    );
    await expect(
      database.custodyProofBackupAuthorities.get([scope.scopeId, proofRow.proofId]),
    ).resolves.toEqual(marker);
  });

  it("refuses admission beside a completed-removal marker without writing or replacing it", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 10);
    const source = operationBinding(
      scope,
      "completed-removal-admission",
      proof("admission-input"),
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
    const successor = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: proof("admission-successor"),
      asset: { kind: "conditional", conditionId: TERMINAL_CONDITION, outcomeCollection: "YES" },
      receivedAtMs: 2,
    });
    const marker = completedRemovalMarker(scope, successor);
    await database.custodyProofBackupAuthorities.put(marker);

    await expect(
      adapter.transact(
        selection(scope, owner, source.record.operation.operationId, null),
        (transaction) =>
          bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
        {
          predecessorProofs: { [source.record.operation.operationId]: [predecessor] },
          successorProofs: {
            [source.record.operation.operationId]: [
              { proof: successor, expectedRevision: null, derivationLocator: null },
            ],
          },
        },
      ),
    ).rejects.toThrow("completed-removal");
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.custodyProofs.count()).toBe(0);
    await expect(
      database.custodyProofBackupAuthorities.get([scope.scopeId, successor.proofId]),
    ).resolves.toEqual(marker);
  });

  it("preserves a completed-removal marker when a body would otherwise be advanced", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 10);
    const source = operationBinding(
      scope,
      "completed-removal-advance",
      proof("advance-input"),
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
      selection(scope, observedOwner(owner, 11), source.record.operation.operationId, 0),
      (transaction) =>
        transaction.transitionOperation({
          operationId: source.record.operation.operationId,
          expectedRevision: 0,
          transition: {
            kind: "abort",
            authorization: observedOwner(owner, 11),
            expectedRevision: 0,
          },
        }),
    );
    const locked = await database.custodyProofs.get([scope.scopeId, predecessor.proofId]);
    expect(locked).toBeDefined();
    const marker = completedRemovalMarker(scope, locked!);
    await database.custodyProofBackupAuthorities.put(marker);
    const refund = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: proof("advance-refund"),
      asset: { kind: "regular" },
      receivedAtMs: 12,
    });

    await expect(
      adapter.retireAbortedInputsAndAdmitRefunds({
        scopeId: scope.scopeId,
        operationId: source.record.operation.operationId,
        refundProofs: [{ proof: refund, expectedRevision: null, derivationLocator: null }],
        observedAtMs: 12,
      }),
    ).rejects.toThrow("completed-removal");
    expect(await database.custodyProofs.get([scope.scopeId, predecessor.proofId])).toEqual(locked);
    expect(
      await database.custodyProofBackupAuthorities.get([scope.scopeId, predecessor.proofId]),
    ).toEqual(marker);
    expect(await database.custodyProofs.get([scope.scopeId, refund.proofId])).toBeUndefined();
  });

  it("commits authenticated losing CTF evidence with retained proof, cache, and backup revision", async () => {
    const { database, adapter, scope, owner, source, predecessor } =
      await terminalFixture("losing");
    const terminalOwner = observedOwner(owner, 20);
    const exactRejection = terminalRejection(source);
    const operationId = source.record.operation.operationId;

    await adapter.transact(selection(scope, terminalOwner, operationId, 0), (transaction) =>
      transaction.reconcileAuthenticatedTerminalMintRejection!({
        operationId,
        expectedRevision: 0,
        authorization: terminalOwner,
        rejectionHandle: `terminal:${exactRejection.fingerprint}`,
        rejectionFingerprint: exactRejection.fingerprint,
        exactRejection,
        code: 13015,
        predecessorDisposition: "retain",
      }),
    );

    const retained = await adapter.readProof(scope.scopeId, predecessor.proofId);
    expect(retained).toMatchObject({
      selectability: "verified-losing",
      reservationOperationId: null,
      revision: 2,
    });
    expect(retained?.proofFingerprint).toBe(predecessor.proofFingerprint);
    expect(retained?.proofBody.byteLength).toBe(predecessor.proofBody.byteLength);
    expect(await database.custodyReservations.count()).toBe(0);
    expect((await adapter.readOperation(scope, operationId))?.operation.state).toBe("aborted");
    const snapshot = await adapter.readOperationSnapshot(scope, operationId);
    expect(
      snapshot?.artifacts.some(
        ({ reference }) => reference.fingerprint === exactRejection.fingerprint,
      ),
    ).toBe(true);
    expect(
      await database.custodyProofBackupAuthorities.get([scope.scopeId, predecessor.proofId]),
    ).toMatchObject({
      proofState: "verified-losing",
      terminalOperationId: operationId,
      updatedAtMs: 20,
    });
    expect(await database.proofs.get(source.operation.inputs[0]!.secret)).toMatchObject({
      terminalOperationId: operationId,
    });
    expect(
      (await database.proofs.get(source.operation.inputs[0]!.secret))?.reservedBy,
    ).toBeUndefined();
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      { custodyRevision: "2", activeProofCount: 1, desiredAction: "replace" },
    ]);
    const databaseName = database.name;
    database.close();
    const reopenedDatabase = new BitcasterDB(databaseName);
    openDatabases.splice(openDatabases.indexOf(database), 1, reopenedDatabase);
    const reopened = new BrowserDurableCustodyAdapter(reopenedDatabase);
    expect((await reopened.readProof(scope.scopeId, predecessor.proofId))?.selectability).toBe(
      "verified-losing",
    );
  });

  it("replays a remote-sealed losing CTF proof without a local keyset", async () => {
    const fixture = await keysetFreeSuccessorReplayFixture("verified-losing", "remote-terminal");
    await stageSuccessorReplay(fixture);

    await applySuccessorReplay(fixture);

    expect(
      await fixture.database.custodyConditionalKeysets.get([
        fixture.scope.scopeId,
        MINT,
        "msat",
        TERMINAL_KEYSET,
      ]),
    ).toBeUndefined();
    expect(
      await fixture.adapter.readProof(fixture.scope.scopeId, fixture.successor.proofId),
    ).toEqual(
      expect.objectContaining({
        selectability: "verified-losing",
        revision: 0,
      }),
    );
    expect(
      await fixture.database.custodyProofBackupAuthorities.get([
        fixture.scope.scopeId,
        fixture.successor.proofId,
      ]),
    ).toEqual(
      expect.objectContaining({
        backupState: "remote-backed",
        proofState: "verified-losing",
        terminalAuthority: { kind: "remote-seal" },
        derivationLocator: REMOTE_REPLAY_LOCATOR,
      }),
    );
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.toArray()).toEqual([
      expect.objectContaining({
        custodyRevision: "1",
        terminalCtfContext: {
          conditionId: TERMINAL_CONDITION,
          outcomeLabel: "YES",
          outcomeCollectionId: TERMINAL_OUTCOME_ID,
          registeredAt: 1,
          finalExpiry: 2,
        },
      }),
    ]);
    expect(
      (
        await fixture.adapter.readOperation(
          fixture.scope,
          fixture.source.record.operation.operationId,
        )
      )?.operation.state,
    ).toBe("reconciled");
  });

  it("rejects a keyset-free losing replay without exact remote authority", async () => {
    const missing = await keysetFreeSuccessorReplayFixture("verified-losing", "missing");
    await expect(stageSuccessorReplay(missing)).rejects.toThrow(
      /proof backup authority is (missing|invalid)/,
    );

    const wrong = await keysetFreeSuccessorReplayFixture("verified-losing", "wrong");
    await expect(stageSuccessorReplay(wrong)).rejects.toThrow(
      /proof backup authority is (invalid|foreign)/,
    );
  });

  it.each(["missing", "foreign"] as const)(
    "rolls back a keyset-free replay with %s terminal context",
    async (contextKind) => {
      const fixture = await keysetFreeSuccessorReplayFixture(
        "verified-losing",
        "remote-terminal",
        contextKind,
      );
      await stageSuccessorReplay(fixture);

      await expect(applySuccessorReplay(fixture)).rejects.toThrow(
        contextKind === "missing" ? /terminal context is missing/ : /terminal context is foreign/,
      );
      expect(
        (
          await fixture.adapter.readOperation(
            fixture.scope,
            fixture.source.record.operation.operationId,
          )
        )?.operation.state,
      ).toBe("dispatch-intent");
      expect(
        (await fixture.adapter.readProof(fixture.scope.scopeId, fixture.successor.proofId))
          ?.revision,
      ).toBe(0);
    },
  );

  it.each(["selectable", "locked"] as const)(
    "requires a real keyset for a %s conditional replay",
    async (selectability) => {
      const fixture = await keysetFreeSuccessorReplayFixture(selectability, "remote-terminal");
      await expect(stageSuccessorReplay(fixture)).rejects.toThrow(
        /conditional proof keyset authority is missing/,
      );
    },
  );

  it("rejects terminal reconciliation in a current transaction without legacy cache authority", async () => {
    const { database, adapter, scope, owner, source, predecessor } =
      await terminalFixture("current-transaction");
    const terminalOwner = observedOwner(owner, 20);
    const operationId = source.record.operation.operationId;
    const exactRejection = terminalRejection(source);
    await expect(
      database.transaction(
        "rw",
        database.tables.filter((table) => table.name !== database.proofs.name),
        async () => {
          const currentTransaction = Dexie.currentTransaction;
          if (!currentTransaction) throw new Error("missing test transaction");
          await adapter.transactInCurrentTransaction(
            currentTransaction,
            selection(scope, terminalOwner, operationId, 0),
            (transaction) =>
              transaction.reconcileAuthenticatedTerminalMintRejection!({
                operationId,
                expectedRevision: 0,
                authorization: terminalOwner,
                rejectionHandle: `terminal:${exactRejection.fingerprint}`,
                rejectionFingerprint: exactRejection.fingerprint,
                exactRejection,
                code: 13015,
                predecessorDisposition: "retain",
              }),
          );
        },
      ),
    ).rejects.toThrow("browser terminal cache transaction does not cover required tables");
    expect((await adapter.readProof(scope.scopeId, predecessor.proofId))?.selectability).toBe(
      "locked",
    );
    expect((await adapter.readOperation(scope, operationId))?.operation.state).toBe(
      "dispatch-intent",
    );
    expect(await database.custodyReservations.count()).toBe(1);
  });

  it("rejects non-13015 terminal claims and rolls back an injected terminal write fault", async () => {
    const { database, adapter, scope, owner, source, predecessor } = await terminalFixture("fault");
    const terminalOwner = observedOwner(owner, 20);
    const operationId = source.record.operation.operationId;
    const exactRejection = terminalRejection(source);
    const reconcile = (code: 13015) => (transaction: DurableCustodyTransaction) =>
      transaction.reconcileAuthenticatedTerminalMintRejection!({
        operationId,
        expectedRevision: 0,
        authorization: terminalOwner,
        rejectionHandle: `terminal:${exactRejection.fingerprint}`,
        rejectionFingerprint: exactRejection.fingerprint,
        exactRejection,
        code,
        predecessorDisposition: "retain",
      });
    await expect(
      adapter.transact(selection(scope, terminalOwner, operationId, 0), () => {
        throw new Error("mint timeout");
      }),
    ).rejects.toThrow("mint timeout");
    await expect(
      adapter.transact(selection(scope, terminalOwner, operationId, 0), reconcile(13014 as 13015)),
    ).rejects.toThrow();
    await expect(
      adapter.transact(
        selection(scope, { ...terminalOwner, incarnationId: "foreign-owner" }, operationId, 0),
        reconcile(13015),
      ),
    ).rejects.toThrow();
    await expect(
      adapter.transact(selection(scope, terminalOwner, operationId, 1), reconcile(13015)),
    ).rejects.toThrow();
    await expect(
      adapter.transact(selection(scope, terminalOwner, operationId, 0), reconcile(13015), {
        injectFault: "before-commit",
      }),
    ).rejects.toThrow("injected browser custody fault before commit");
    expect((await adapter.readProof(scope.scopeId, predecessor.proofId))?.selectability).toBe(
      "locked",
    );
    expect((await adapter.readOperation(scope, operationId))?.operation.state).toBe(
      "dispatch-intent",
    );
    expect(await database.custodyReservations.count()).toBe(1);
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      { custodyRevision: "1", activeProofCount: 1 },
    ]);
  });

  it("refuses a foreign locked predecessor without condemning the local proof", async () => {
    const { database, adapter, scope, owner, source, predecessor } =
      await terminalFixture("foreign");
    const operationId = source.record.operation.operationId;
    const locked = await database.custodyProofs.get([scope.scopeId, predecessor.proofId]);
    await database.custodyProofs.put({ ...locked!, normalizedMint: "https://foreign.example" });
    const terminalOwner = observedOwner(owner, 20);
    const exactRejection = terminalRejection(source);
    await expect(
      adapter.transact(selection(scope, terminalOwner, operationId, 0), (transaction) =>
        transaction.reconcileAuthenticatedTerminalMintRejection!({
          operationId,
          expectedRevision: 0,
          authorization: terminalOwner,
          rejectionHandle: `terminal:${exactRejection.fingerprint}`,
          rejectionFingerprint: exactRejection.fingerprint,
          exactRejection,
          code: 13015,
          predecessorDisposition: "retain",
        }),
      ),
    ).rejects.toThrow();
    expect((await adapter.readOperation(scope, operationId))?.operation.state).toBe(
      "dispatch-intent",
    );
    expect(await database.custodyReservations.count()).toBe(1);
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      { custodyRevision: "1", activeProofCount: 1 },
    ]);
  });
  it("rejects a full-length V3 proof before browser custody can persist it", async () => {
    const database = createDatabase();
    const scope = walletScope();
    expect(() =>
      createBrowserCustodyProofRow({
        scopeId: scope.scopeId,
        normalizedMint: MINT,
        unit: "msat",
        proof: { ...proof("v3"), id: `02${"11".repeat(32)}` } as Proof,
        asset: { kind: "regular" },
        receivedAtMs: 1,
      }),
    ).toThrow(/canonical NUT-02 V2/);
    expect(await database.custodyProofs.count()).toBe(0);
  });

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

  it("does not create a backup target for a local-only predecessor", async () => {
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

    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
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

  it("requires an existing exact predecessor for canonical reservations", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 12);
    const source = operationBinding(scope, "canonical-ctf-claim", proof("ctf-input"), "regular");
    const predecessor = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: source.operation.inputs[0] as Proof,
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    const bind = () =>
      adapter.transact(
        selection(scope, owner, source.record.operation.operationId, null),
        (transaction) =>
          bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
        {
          predecessorProofs: { [source.record.operation.operationId]: [predecessor] },
          requirePersistedPredecessors: true,
        },
      );

    await expect(bind()).rejects.toThrow(/predecessor proof is not persisted/);
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyOperations.count()).toBe(0);

    await database.custodyProofs.put(predecessor);
    await database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(predecessor, 12, null, "ctf-admission"),
    );
    await expect(bind()).resolves.toBeUndefined();
    expect((await adapter.readProof(scope.scopeId, predecessor.proofId))?.selectability).toBe(
      "locked",
    );
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

  it.each([
    { predecessorTransferId: null, expectedIndexKey: "", sequenced: true },
    {
      predecessorTransferId: "prior-transfer",
      expectedIndexKey: "prior-transfer",
      sequenced: true,
    },
    { predecessorTransferId: null, expectedIndexKey: undefined, sequenced: false },
  ])("uses one unique predecessor index key for %#", async (input) => {
    const database = createDatabase();
    const first = fundingTransfer(
      "indexed-first",
      input.predecessorTransferId,
      undefined,
      input.sequenced,
    );
    await database.outgoingCashuTransfers.put(fundingRow(first));

    expect(browserOutgoingPredecessorKey(first)).toBe(input.expectedIndexKey);
    const resolved = await findBrowserOutgoingCashuTransferByPredecessor({
      scopeId: first.walletScopeId,
      recipientBinding: fundingBinding(first),
      predecessorTransferId: input.predecessorTransferId,
      database,
    });
    if (input.expectedIndexKey === undefined) {
      expect(resolved).toBeNull();
    } else {
      expect(resolved).toMatchObject({ transferId: first.transferId });
    }

    const duplicate = fundingTransfer(
      "indexed-duplicate",
      input.predecessorTransferId,
      undefined,
      input.sequenced,
    );
    if (input.expectedIndexKey === undefined) {
      await expect(database.outgoingCashuTransfers.put(fundingRow(duplicate))).resolves.toEqual([
        duplicate.walletScopeId,
        duplicate.transferId,
      ]);
    } else {
      await expect(database.outgoingCashuTransfers.put(fundingRow(duplicate))).rejects.toThrow();
    }
  });

  it("rolls back custody, outgoing transfer, and funding head on a head CAS conflict", async () => {
    const database = createDatabase();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const scope = walletScope();
    const owner = await claim(adapter, scope, 70);
    const first = fundingTransfer("funding-first", null, scope.scopeId);
    await persistFundingTransfer(adapter, scope, owner, first, {
      expectedPrevious: null,
      nextRevision: 1,
    });

    const second = fundingTransfer("funding-second", first.transferId, scope.scopeId);
    await expect(
      persistFundingTransfer(adapter, scope, observedOwner(owner, 71), second, {
        expectedPrevious: { transferId: first.transferId, revision: 99 },
        nextRevision: 100,
      }),
    ).rejects.toThrow("head CAS conflict");

    expect(await database.outgoingCashuTransfers.count()).toBe(1);
    expect(
      await database.marketFundingHeads.get([scope.scopeId, fundingBinding(first)]),
    ).toMatchObject({ transferId: first.transferId, revision: 1 });
    expect(await adapter.readOperation(scope, "funding-custody:funding-second")).toBeNull();
  });

  it("rejects higher-revision sequence tampering and keeps the original predecessor occupied", async () => {
    const database = createDatabase();
    const original = fundingTransfer("tamper-target", null);
    await database.outgoingCashuTransfers.put(fundingRow(original));
    const tampered = { ...fundingTransfer("tamper-target", "other-transfer"), revision: 1 };

    await expect(rewriteOutgoing(database, fundingRow(tampered))).rejects.toThrow(
      "immutable request identity",
    );
    await expect(
      findBrowserOutgoingCashuTransferByPredecessor({
        scopeId: original.walletScopeId,
        recipientBinding: fundingBinding(original),
        predecessorTransferId: null,
        database,
      }),
    ).resolves.toMatchObject({ transferId: original.transferId });
    expect(
      await findBrowserOutgoingCashuTransferByPredecessor({
        scopeId: original.walletScopeId,
        recipientBinding: fundingBinding(original),
        predecessorTransferId: "other-transfer",
        database,
      }),
    ).toBeNull();
  });

  it("preserves an unchanged recipient sequence across a higher-revision rewrite", async () => {
    const database = createDatabase();
    const original = fundingTransfer("rewrite-target", null);
    await database.outgoingCashuTransfers.put(fundingRow(original));
    const replacement = { ...original, revision: original.revision + 1 };

    await rewriteOutgoing(database, fundingRow(replacement));
    expect(
      (await database.outgoingCashuTransfers.get([original.walletScopeId, original.transferId]))
        ?.transfer.revision,
    ).toBe(1);
    expect(
      await findBrowserOutgoingCashuTransferByPredecessor({
        scopeId: original.walletScopeId,
        recipientBinding: fundingBinding(original),
        predecessorTransferId: null,
        database,
      }),
    ).toMatchObject({ transferId: original.transferId });
  });

  it("does not back up a specialized refund without a deterministic locator", async () => {
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

    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
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

async function mintSpentRetirementFixture(
  kind: "remote-terminal" | "local-terminal" | "selectable",
  proofCount = 1,
  activeProofCount = proofCount,
) {
  const database = createDatabase();
  const adapter = new BrowserDurableCustodyAdapter(database);
  const scope = walletScope();
  const candidates: Array<{
    proof: BrowserCustodyProofRow;
    authority: BrowserProofBackupAuthorityRow;
  }> = [];
  for (let index = 0; index < proofCount; index += 1) {
    const base = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: {
        ...proof(`mint-spent-${kind}-${index}`),
        id: kind === "selectable" ? KEYSET : TERMINAL_KEYSET,
      },
      asset:
        kind === "selectable"
          ? { kind: "regular" }
          : {
              kind: "conditional",
              conditionId: TERMINAL_CONDITION,
              outcomeCollection: "YES",
            },
      receivedAtMs: 1,
    });
    if (kind === "remote-terminal") {
      const losing = { ...base, selectability: "verified-losing" as const };
      candidates.push({
        proof: losing,
        authority: createBrowserRemoteProofBackupAuthorityRow({
          proof: losing,
          observedAtMs: 2,
          derivationLocator: { ...REMOTE_REPLAY_LOCATOR, counter: 20 + index },
          restoreProofId: losing.proofId,
          restoreProofCommitment: "33".repeat(32),
        }),
      });
      continue;
    }
    const locator = {
      schemaVersion: 1 as const,
      kind: "nut13" as const,
      keysetId: base.keysetId,
      counter: 20 + index,
    };
    if (kind === "local-terminal") {
      const operationId = `mint-spent-terminal-${index}`;
      const locked = {
        ...base,
        selectability: "locked" as const,
        reservationOperationId: operationId,
      };
      const losing = {
        ...base,
        revision: 1,
        selectability: "verified-losing" as const,
        reservationOperationId: null,
      };
      candidates.push({
        proof: losing,
        authority: classifyBrowserProofBackupAuthorityVerifiedLosing(
          createBrowserProofBackupAuthorityRow(locked, 2, locator, `mint-spent-admission-${index}`),
          losing,
          operationId,
          3,
        ),
      });
      continue;
    }
    candidates.push({
      proof: base,
      authority: createBrowserProofBackupAuthorityRow(
        base,
        2,
        locator,
        `mint-spent-admission-${index}`,
      ),
    });
  }
  await Promise.all([
    database.custodyProofs.bulkPut(candidates.map(({ proof: proofRow }) => proofRow)),
    database.custodyProofBackupAuthorities.bulkPut(candidates.map(({ authority }) => authority)),
  ]);
  if (kind === "local-terminal") {
    await database.custodyConditionalKeysets.put({
      schemaVersion: 1,
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: TERMINAL_KEYSET,
      denominationPublicKeys: { "1": PUBLIC_KEY },
      inputFeePpk: 0,
      conditionId: TERMINAL_CONDITION,
      outcomeCollection: "YES",
      outcomeCollectionId: TERMINAL_OUTCOME_ID,
      registeredAtUnixSeconds: 1,
      finalExpiryUnixSeconds: 2,
      curve: "secp256k1",
    });
  }
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset:
      kind === "selectable"
        ? { kind: "ordinary" }
        : {
            kind: "ctf",
            conditionId: TERMINAL_CONDITION,
            outcomeLabel: "YES",
            outcomeCollectionId: TERMINAL_OUTCOME_ID,
            registeredAt: 1,
            finalExpiry: 2,
          },
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: scope.scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount,
    terminalCtfContext:
      kind === "selectable"
        ? null
        : {
            conditionId: TERMINAL_CONDITION,
            outcomeLabel: "YES",
            outcomeCollectionId: TERMINAL_OUTCOME_ID,
            registeredAt: 1,
            finalExpiry: 2,
          },
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(desired);
  return { database, adapter, scope, candidates, desired };
}

async function keysetFreeSuccessorReplayFixture(
  selectability: "verified-losing" | "selectable" | "locked",
  authorityKind: "remote-terminal" | "missing" | "wrong",
  contextKind: "valid" | "missing" | "foreign" = "valid",
) {
  const database = createDatabase();
  const adapter = new BrowserDurableCustodyAdapter(database);
  const scope = walletScope();
  const owner = await claim(adapter, scope, 10);
  const inputProof = { ...proof(`replay-input-${selectability}`), id: TERMINAL_KEYSET };
  const source = operationBinding(
    scope,
    `replay-${selectability}-${authorityKind}`,
    inputProof,
    `replay-output-${selectability}-${authorityKind}`,
  );
  const predecessor = createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: inputProof,
    asset: { kind: "regular" },
    receivedAtMs: 1,
  });
  await adapter.transact(
    selection(scope, owner, source.record.operation.operationId, null),
    (transaction) => bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
    { predecessorProofs: { [source.record.operation.operationId]: [predecessor] } },
  );

  const outputProof = {
    ...proof(`replay-output-${selectability}-${authorityKind}`),
    id: TERMINAL_KEYSET,
  };
  const successor = createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: outputProof,
    asset: { kind: "conditional", conditionId: TERMINAL_CONDITION, outcomeCollection: "YES" },
    receivedAtMs: 2,
  });
  expect(source.record.operation.proofStorage.lineage.successorProofIds).toEqual([
    successor.proofId,
  ]);
  const persistedSuccessor = {
    ...successor,
    selectability,
    reservationOperationId: selectability === "locked" ? "foreign-replay" : null,
  };
  await database.custodyProofs.put(persistedSuccessor);

  if (authorityKind === "remote-terminal") {
    await database.custodyProofBackupAuthorities.put(
      createBrowserRemoteProofBackupAuthorityRow({
        proof: persistedSuccessor,
        observedAtMs: 10,
        derivationLocator: REMOTE_REPLAY_LOCATOR,
        restoreProofId: persistedSuccessor.proofId,
        restoreProofCommitment: "cc".repeat(32),
      }),
    );
  } else if (authorityKind === "wrong") {
    const foreignProof = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: { ...proof("foreign-replay-authority"), id: TERMINAL_KEYSET },
      asset: { kind: "conditional", conditionId: TERMINAL_CONDITION, outcomeCollection: "YES" },
      receivedAtMs: 2,
    });
    const foreignAuthority = createBrowserRemoteProofBackupAuthorityRow({
      proof: foreignProof,
      observedAtMs: 10,
      derivationLocator: REMOTE_REPLAY_LOCATOR,
      restoreProofId: foreignProof.proofId,
      restoreProofCommitment: "ee".repeat(32),
    });
    await database.custodyProofBackupAuthorities.put({
      ...foreignAuthority,
      proofId: persistedSuccessor.proofId,
    });
  }

  if (selectability === "verified-losing" && authorityKind === "remote-terminal") {
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: MINT,
      unit: "msat",
      asset: {
        kind: "ctf",
        conditionId: TERMINAL_CONDITION,
        outcomeLabel: "YES",
        outcomeCollectionId: TERMINAL_OUTCOME_ID,
        registeredAt: 1,
        finalExpiry: 2,
      },
    });
    await database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId: scope.scopeId,
        asset,
        custodyRevision: 1n,
        activeProofCount: 1,
        terminalCtfContext:
          contextKind === "missing"
            ? null
            : {
                conditionId: TERMINAL_CONDITION,
                outcomeLabel: contextKind === "foreign" ? "NO" : "YES",
                outcomeCollectionId: TERMINAL_OUTCOME_ID,
                registeredAt: 1,
                finalExpiry: 2,
              },
      }),
    );
  }

  const exactResult = prepareDurableCustodyExactArtifact({
    authorization: [outputProof],
    keep: [],
  });
  const resultFingerprint = deriveDurableCustodyProofResultFingerprint({
    authorization: [outputProof],
    keep: [],
  });
  return {
    database,
    adapter,
    scope,
    owner,
    source,
    successor: persistedSuccessor,
    exactResult,
    resultFingerprint,
  };
}

type SuccessorReplayFixture = Awaited<ReturnType<typeof keysetFreeSuccessorReplayFixture>>;

async function stageSuccessorReplay(fixture: SuccessorReplayFixture): Promise<void> {
  const stageOwner = observedOwner(fixture.owner, 20);
  await fixture.adapter.transact(
    selection(fixture.scope, stageOwner, fixture.source.record.operation.operationId, 0),
    (transaction) =>
      transaction.stageVerifiedResult({
        operationId: fixture.source.record.operation.operationId,
        expectedRevision: 0,
        authorization: stageOwner,
        outputPlanFingerprint: fixture.source.record.operation.outputPlan.outputPlanFingerprint,
        resultHandle: `replay-result:${fixture.resultFingerprint}`,
        resultFingerprint: fixture.resultFingerprint,
        exactResult: fixture.exactResult,
        selectedSuccessorProofIds: [fixture.successor.proofId],
      }),
    {
      successorProofs: {
        [fixture.source.record.operation.operationId]: [
          {
            proof: fixture.successor,
            expectedRevision: 0,
            derivationLocator: REMOTE_REPLAY_LOCATOR,
          },
        ],
      },
    },
  );
}

async function applySuccessorReplay(fixture: SuccessorReplayFixture): Promise<void> {
  const applyOwner = observedOwner(fixture.owner, 21);
  await fixture.adapter.transact(
    selection(fixture.scope, applyOwner, fixture.source.record.operation.operationId, 1),
    (transaction) =>
      transaction.applyVerifiedResult({
        operationId: fixture.source.record.operation.operationId,
        expectedRevision: 1,
        authorization: applyOwner,
        outputPlanFingerprint: fixture.source.record.operation.outputPlan.outputPlanFingerprint,
        resultHandle: `replay-result:${fixture.resultFingerprint}`,
        resultFingerprint: fixture.resultFingerprint,
        successorAdmission: {
          scopeId: fixture.scope.scopeId,
          operationId: fixture.source.record.operation.operationId,
          admissionId: `replay-admission:${fixture.resultFingerprint}`,
          proofRows: [
            { proofId: fixture.successor.proofId, expectedRevision: 0, admittedRevision: 0 },
          ],
        },
      }),
    {
      successorProofs: {
        [fixture.source.record.operation.operationId]: [
          {
            proof: fixture.successor,
            expectedRevision: 0,
            derivationLocator: REMOTE_REPLAY_LOCATOR,
          },
        ],
      },
    },
  );
}

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

async function terminalFixture(suffix: string) {
  const database = createDatabase();
  const adapter = new BrowserDurableCustodyAdapter(database);
  const scope = walletScope();
  const owner = await claim(adapter, scope, 10);
  const source = operationBinding(
    scope,
    `redeem-${suffix}`,
    { ...proof(`terminal-${suffix}`), id: TERMINAL_KEYSET },
    `output-${suffix}`,
    "ctf-redeem",
  );
  const predecessor = createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: source.operation.inputs[0] as Proof,
    asset: { kind: "conditional", conditionId: TERMINAL_CONDITION, outcomeCollection: "YES" },
    receivedAtMs: 1,
  });
  await database.custodyProofs.put(predecessor);
  await database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(
      predecessor,
      10,
      {
        schemaVersion: 1,
        kind: "nut13",
        keysetId: TERMINAL_KEYSET,
        counter: 1,
      },
      `admission-${suffix}`,
    ),
  );
  await database.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    keysetId: TERMINAL_KEYSET,
    denominationPublicKeys: { "1": PUBLIC_KEY },
    inputFeePpk: 0,
    conditionId: TERMINAL_CONDITION,
    outcomeCollection: "YES",
    outcomeCollectionId: TERMINAL_OUTCOME_ID,
    registeredAtUnixSeconds: 1,
    finalExpiryUnixSeconds: 2,
    curve: "secp256k1",
  });
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: TERMINAL_CONDITION,
      outcomeLabel: "YES",
      outcomeCollectionId: TERMINAL_OUTCOME_ID,
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(
    createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: scope.scopeId,
      asset,
      custodyRevision: 1n,
      activeProofCount: 1,
    }),
  );
  await database.proofs.put(
    storedProofRow({
      ...(source.operation.inputs[0] as Proof),
      mintUrl: MINT,
      unit: "msat",
      baseAsset: "sat",
      conditionId: TERMINAL_CONDITION,
      outcomeCollection: "YES",
      reservedBy: source.record.operation.operationId,
    }),
  );
  await adapter.transact(
    selection(scope, owner, source.record.operation.operationId, null),
    (transaction) => bindDurableCustodyProofOperation(transaction, source.record, source.artifacts),
    { predecessorProofs: { [source.record.operation.operationId]: [predecessor] } },
  );
  return { database, adapter, scope, owner, source, predecessor };
}

function terminalRejection(source: ReturnType<typeof operationBinding>) {
  return prepareDurableCustodyExactArtifact({
    schemaVersion: 1,
    kind: "authenticated-terminal-mint-rejection",
    operationId: source.record.operation.operationId,
    semanticKind: "ctf-redeem",
    normalizedMint: MINT,
    requestFingerprint: source.record.operation.exactRequest.requestFingerprint,
    code: 13015,
    transportProvenance: "authenticated-mint-transport",
    transportOperationId: source.operation.operationId,
    rejectionBody: { code: 13015 },
    predecessorDisposition: "retain",
    selectedSuccessorProofIds: [],
  });
}

function operationBinding(
  scope: DurableCustodyScope,
  operationId: string,
  inputProof: Proof,
  outputSecret: string,
  kind: "wallet-send" | "ctf-redeem" = "wallet-send",
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
    kind,
    mintUrl: MINT,
    inputs: [inputProof],
    outputs: {
      authorization: [
        {
          blindedMessage: { amount: 1, id: inputProof.id, B_: `02${"33".repeat(32)}` },
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
    binding: {
      kind: "wallet",
      activityId: operationId,
      stage: kind === "ctf-redeem" ? "ctf-redeem" : "send",
    },
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: true,
    inputKeysetRequirement: "required",
    keysets: [
      {
        keysetId: inputProof.id,
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
        path: kind === "ctf-redeem" ? "/v1/redeem_outcome" : "/v1/swap",
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

function fundingTransfer(
  transferId: string,
  predecessorTransferId: string | null,
  scopeId = "wallet-scope-funding",
  sequenced = true,
): DurableOutgoingCashuTransfer {
  const output = OutputData.createSingleDeterministicData(
    1,
    new Uint8Array(64).fill(7),
    transferId.charCodeAt(0),
    KEYSET,
  );
  const operation = serializeDurableWalletSendOperation({
    operationId: `wallet-send:${transferId}`,
    mintUrl: MINT,
    unit: "msat",
    preview: {
      amount: Amount.from(1),
      fees: Amount.zero(),
      keysetId: KEYSET,
      inputs: [
        { id: KEYSET, amount: Amount.from(1), secret: `wallet-input:${transferId}`, C: PUBLIC_KEY },
      ],
      sendOutputs: [output],
      keepOutputs: [],
      unselectedProofs: [],
    },
  });
  return createDurableOutgoingCashuTransfer({
    transferId,
    walletScopeId: scopeId,
    requestedAmount: "1",
    walletSendOperation: operation,
    recipientSequence: sequenced ? { predecessorTransferId } : null,
    deliveryIntent: {
      policy: "durable-recipient-ack",
      expectedSubject: "account-1",
      opaqueProductBinding: deriveMarketFundingProductBinding({
        conditionId: "aa".repeat(32),
        divisibility: 1_000,
        accountSubject: "account-1",
      }),
      tokenBytesLimit: 1024,
      tokenProofLimit: 1,
    },
  });
}

function fundingRow(transfer: DurableOutgoingCashuTransfer): BrowserOutgoingCashuTransferRow {
  const predecessorKey = browserOutgoingPredecessorKey(transfer);
  return {
    scopeId: transfer.walletScopeId,
    mintUrl: transfer.mintUrl,
    mintRecoveryState: transfer.deliveryState === "prepared" ? "pending" : "complete",
    localAuthorityState: "nonterminal",
    bearerMintUrl: null,
    dueAtMs: transfer.recovery.dueAtMs,
    transferId: transfer.transferId,
    recipientBinding:
      transfer.deliveryIntent.policy === "durable-recipient-ack"
        ? transfer.deliveryIntent.opaqueProductBinding
        : null,
    ...(predecessorKey === undefined ? {} : { predecessorKey }),
    admissionState: "consumed",
    transfer,
  };
}

function fundingBinding(transfer: DurableOutgoingCashuTransfer): string {
  if (transfer.deliveryIntent.policy !== "durable-recipient-ack") {
    throw new Error("test transfer is not a durable recipient transfer");
  }
  return transfer.deliveryIntent.opaqueProductBinding;
}

async function persistFundingTransfer(
  adapter: BrowserDurableCustodyAdapter,
  scope: DurableCustodyScope,
  owner: DurableCustodyOwnerAuthorization,
  transfer: DurableOutgoingCashuTransfer,
  head: {
    expectedPrevious: { transferId: string; revision: number } | null;
    nextRevision: number;
  },
): Promise<void> {
  const operationId = `funding-custody:${transfer.transferId}`;
  const binding = operationBinding(
    scope,
    operationId,
    proof(`funding-input:${transfer.transferId}`),
    "funding-output",
  );
  const boundOperationId = binding.record.operation.operationId;
  const predecessor = createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: binding.operation.inputs[0] as Proof,
    asset: { kind: "regular" },
    receivedAtMs: owner.observedAtMs,
  });
  await adapter.transactAtomic(
    selection(scope, owner, boundOperationId, null),
    (transaction) =>
      bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
    {
      predecessorProofs: { [boundOperationId]: [predecessor] },
      outgoingTransfer: fundingRow(transfer),
      outgoingAdmission: null,
      marketFundingHead: {
        accountSubject: "account-1",
        conditionId: "aa".repeat(32),
        divisibility: 1_000,
        ...head,
      },
    },
  );
}

async function rewriteOutgoing(
  database: BitcasterDB,
  row: BrowserOutgoingCashuTransferRow,
): Promise<void> {
  await database.transaction("rw", database.outgoingCashuTransfers, async () => {
    const transaction = Dexie.currentTransaction;
    if (transaction === undefined) throw new Error("missing test transaction");
    await persistBrowserOutgoingCashuTransferRewrite(database, transaction, row);
  });
}

function completedRemovalMarker(
  scope: Extract<DurableCustodyScope, { scopeKind: "wallet" }>,
  proofRow: ReturnType<typeof createBrowserCustodyProofRow>,
) {
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: TERMINAL_CONDITION,
      outcomeLabel: "YES",
      outcomeCollectionId: TERMINAL_OUTCOME_ID,
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  return createBrowserCompletedProofRemovalMarkerRow({
    scopeId: scope.scopeId,
    proofId: proofRow.proofId,
    proofFingerprint: proofRow.proofFingerprint,
    proofRevision: proofRow.revision,
    proofCommitment: "66".repeat(32),
    localAssetKey: encryptedWalletBackupV2LocalAssetKey(asset),
    removalIntentId: "completed-removal-test",
    proofSetCommitment: "77".repeat(32),
    completionCustodyRevision: "3",
    realm: "development",
    walletId: scope.walletId,
    enrollmentEpoch: 1,
    acknowledgedHeadVersion: 0,
    acknowledgedActiveSetDigest: "88".repeat(32),
    acknowledgementKind: "current-head",
    receiptDigest: null,
    acknowledgedAtMs: 2,
    completedAtMs: 3,
  });
}

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`bitcaster-custody-test-${crypto.randomUUID()}`);
  openDatabases.push(database);
  return database;
}
