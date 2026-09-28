// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveConditionalKeysetId } from "@cashu/cashu-ts";
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2CurrentHead,
  createEncryptedWalletBackupV2KeyHandle,
  deriveEncryptedWalletBackupV2AssetLocator,
  digestEncryptedWalletBackupV2BundleDescriptor,
  digestEncryptedWalletBackupV2TerminalProofCommitment,
  encodeEncryptedWalletBackupV2UploadGroup,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  prepareEncryptedWalletBackupV2AssetMutation,
  prepareEncryptedWalletBackupV2TransportBundle,
} from "@bitcaster/client-sdk";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { deserializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  decodeEncryptedWalletBackupV2DesiredAssetRow,
} from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import {
  createBrowserRemoteProofBackupAuthorityRow,
  createBrowserProofBackupAuthorityRow,
  requireBrowserLiveProofBackupAuthorityTableRow,
} from "../../stores/browser-proof-backup-authority";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../../stores/durable-custody-db";
import { decodeBrowserCustodyProofRow } from "../../stores/durable-custody-types";
import { BitcasterDB, storedProofFromCustodyRow, storedProofRow } from "../../stores/proof-db";
import { EncryptedWalletBackupV2DexieAuthorityStore } from "../../stores/encrypted-wallet-backup-v2-db";
import {
  cancelDefinitivelyRejectedBrowserCtfRemove,
  discoverBrowserCtfRemovals,
  finalizeBrowserCtfRemove,
  startBrowserCtfRemove,
  type BrowserCtfRemoveTarget,
} from "../browserCtfRemoveCoordinator";
import { commitBrowserCtfTerminalOperation } from "../../test/browserEncryptedWalletBackupV2CommittedTerminalFixture";

const REALM = "backup.example";
const MINT = "https://mint.example";
const PUBLIC_KEY = `02${"22".repeat(32)}`;
const CONDITION_ID = "aa".repeat(32);
const OUTCOME = "YES";
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME,
});
const KEYSET = deriveConditionalKeysetId({
  keys: { "1": PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 0,
  final_expiry: 2,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
});
const SEED = new Uint8Array(64).fill(19);
const databases: BitcasterDB[] = [];
const immediateLockManager = {
  request: (async (_name: string, _options: LockOptions, action: LockGrantedCallback<unknown>) =>
    action(null)) as LockManager["request"],
};
const mocks = vi.hoisted(() => ({
  requireNewWritePermission: vi.fn(),
}));

vi.mock("../browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: mocks.requireNewWritePermission,
}));

beforeEach(() => {
  mocks.requireNewWritePermission.mockReset();
  mocks.requireNewWritePermission.mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("browser CTF explicit removal coordinator", () => {
  it.each([1, 2])("starts and finalizes a %s-proof removal atomically", async (count) => {
    const fixture = await createFixture(count);
    const targets = [fixture.target(fixture.proofs[0]!.proofId)];
    const targetIds = targets.map(({ proofId }) => proofId);
    const input = fixture.input(targets);

    await expect(startBrowserCtfRemove(input)).resolves.toMatchObject({ kind: "started" });
    const started = await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
      fixture.scopeId,
      fixture.desired.localAssetKey,
    ]);
    expect(started).toMatchObject({
      custodyRevision: "2",
      activeProofCount: count - 1,
      desiredAction: count === 1 ? "remove" : "replace",
      syncState: "pending",
      removalIntent: { state: "pending", proofs: [{ proofId: targetIds[0] }] },
    });
    const target = fixture.proofs.find(({ proofId }) => proofId === targetIds[0]);
    if (target === undefined) throw new Error("test target is missing");
    const startedDecoded = decodeEncryptedWalletBackupV2DesiredAssetRow(started!);
    const targetAuthorityRaw = await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scopeId,
      target.proofId,
    ]);
    const targetAuthority =
      targetAuthorityRaw === undefined
        ? undefined
        : requireBrowserLiveProofBackupAuthorityTableRow(targetAuthorityRaw, [
            fixture.scopeId,
            target.proofId,
          ]);
    expect(startedDecoded.removalIntent?.proofs[0]?.proofCommitment).toBe(
      targetAuthority?.backupRecordCommitment,
    );
    expect(startedDecoded.removalIntent?.proofs[0]?.proofCommitment).not.toBe(
      target.proofFingerprint,
    );
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, target.proofId]),
    ).toMatchObject({
      revision: 1,
      selectability: "pending-removal",
      reservationOperationId: null,
    });
    expect(
      await fixture.database.proofs.get(storedProofFromCustodyRow(target).secret),
    ).toBeUndefined();
    expect(await fixture.database.custodyProofs.count()).toBe(count);

    mocks.requireNewWritePermission.mockReset();
    mocks.requireNewWritePermission.mockRejectedValue(new Error("new writes are refused"));
    await expect(startBrowserCtfRemove(input)).resolves.toMatchObject({ kind: "resumed" });
    expect(mocks.requireNewWritePermission).not.toHaveBeenCalled();
    const originalTarget = targets[0]!;
    await expect(
      startBrowserCtfRemove({
        ...input,
        targets: [{ ...originalTarget, proofFingerprint: "ff".repeat(32) }],
      }),
    ).rejects.toThrow(/conflicts with pending intent/);
    await expect(
      startBrowserCtfRemove({
        ...input,
        targets: [{ ...originalTarget, proofRevision: originalTarget.proofRevision + 1 }],
      }),
    ).rejects.toThrow(/conflicts with pending intent/);
    const conflict = fixture.proofs[count - 1]!.proofId;
    if (count > 1) {
      await expect(
        startBrowserCtfRemove(fixture.input([fixture.target(conflict)])),
      ).rejects.toThrow(/conflicts/);
    }

    const successor = await prepareEncryptedWalletBackupV2TransportBundle({
      keyHandle: fixture.keyHandle,
      asset: fixture.asset,
      declaredAmount: BigInt(count - 1),
      custodyRevision: 2n,
      canonicalPayload: encodeCanonicalBackupCbor(["successor"]),
      runtime: {
        subtle: crypto.subtle,
        getRandomValues: (target) => crypto.getRandomValues(target),
      },
    });
    const successorHead = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      walletId: fixture.keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 2,
      bundles: count === 1 ? [] : [successor.descriptor],
    });
    const successorEvidence = evidence(successorHead, count === 1 ? [] : [successor.descriptor]);
    const desired = (await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
      fixture.scopeId,
      fixture.desired.localAssetKey,
    ]))!;
    const decoded = JSON.parse(JSON.stringify(desired)) as typeof desired;
    const intent = decoded.removalIntent!;
    await fixture.store.acceptCompetingHead({
      collectedHeadEvidence: successorEvidence,
      stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...decoded,
      syncState: "acknowledged",
      removalIntent: {
        ...intent,
        state: "exclusion-acknowledged",
        acknowledgedExclusionEvidence:
          count === 1
            ? {
                kind: "current-head",
                headVersion: successorHead.headVersion,
                activeSetDigest: successorHead.activeSetDigest,
                bundleId: null,
                bundleDescriptorDigest: null,
                acknowledgedAtMs: 3_000,
              }
            : {
                kind: "receipt",
                headVersion: successorHead.headVersion,
                activeSetDigest: successorHead.activeSetDigest,
                receiptDigest: "cc".repeat(32),
                bundleId: successor.descriptor.bundleId,
                bundleDescriptorDigest: digestEncryptedWalletBackupV2BundleDescriptor(
                  successor.descriptor,
                ),
                supersededBundleIds: [],
                acknowledgedAtMs: 3_000,
              },
      },
    });

    if (count === 1) {
      await expect(
        discoverBrowserCtfRemovals({
          database: fixture.database,
          scopeId: fixture.scopeId,
          keyHandle: fixture.keyHandle,
          enrollmentEpoch: 1,
          lockManager: immediateLockManager,
          isCurrentProfile: () => true,
          observedAtMs: 3_001,
        }),
      ).resolves.toBe(1);
    } else {
      await expect(
        finalizeBrowserCtfRemove({
          ...input,
          localAssetKey: fixture.desired.localAssetKey,
          proofIds: targetIds,
          observedAtMs: 3_001,
        }),
      ).resolves.toEqual({ kind: "completed" });
    }
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, target.proofId]),
    ).toBeUndefined();
    const completedAuthority = await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scopeId,
      target.proofId,
    ]);
    expect(completedAuthority).toMatchObject({ recordKind: "completed-removal", proofRevision: 1 });
    expect(completedAuthority).toMatchObject({
      proofCommitment: startedDecoded.removalIntent?.proofs[0]?.proofCommitment,
    });
    if (count === 1) {
      expect(
        await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
          fixture.scopeId,
          fixture.desired.localAssetKey,
        ]),
      ).toBeUndefined();
      await expect(startBrowserCtfRemove(input)).resolves.toMatchObject({ kind: "completed" });
    } else {
      expect(
        await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
          fixture.scopeId,
          fixture.desired.localAssetKey,
        ]),
      ).toMatchObject({ custodyRevision: "2", activeProofCount: 1, removalIntent: null });
      const survivor = fixture.proofs.find(({ proofId }) => proofId !== targetIds[0]);
      if (survivor === undefined) throw new Error("test survivor is missing");
      expect(await fixture.database.proofs.get(storedProofFromCustodyRow(survivor).secret)).toEqual(
        expect.any(Object),
      );
    }
    await expect(startBrowserCtfRemove(input)).resolves.toMatchObject({ kind: "completed" });
    await expect(
      startBrowserCtfRemove({
        ...input,
        targets: [{ ...originalTarget, proofFingerprint: "ff".repeat(32) }],
      }),
    ).rejects.toThrow();
    await expect(
      startBrowserCtfRemove({
        ...input,
        targets: [{ ...originalTarget, proofRevision: originalTarget.proofRevision + 1 }],
      }),
    ).rejects.toThrow();
    await expect(
      finalizeBrowserCtfRemove({
        ...input,
        localAssetKey: fixture.desired.localAssetKey,
        proofIds: targetIds,
      }),
    ).resolves.toEqual({ kind: "completed" });
  });

  it("removes siblings from one terminal operation in separate confirmed actions", async () => {
    const fixture = await createLocalFixture(2, true);
    for (const proof of fixture.proofs) {
      await expect(
        startBrowserCtfRemove(fixture.localInput([fixture.target(proof.proofId)])),
      ).resolves.toMatchObject({ kind: "completed" });
    }
    expect(await fixture.database.custodyProofs.count()).toBe(0);
  });

  it("removes an imported local-only losing proof and replays after reload", async () => {
    const fixture = await createLocalFixture();
    const proof = fixture.proofs[0]!;
    const input = fixture.localInput([fixture.target(proof.proofId)]);

    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(
      await fixture.database.custodyProofBackupAuthorities.get([fixture.scopeId, proof.proofId]),
    ).toMatchObject({
      backupState: "local-only",
      derivationLocator: null,
      proofState: "verified-losing",
      terminalAuthority: { kind: "local-operation", operationId: fixture.terminalOperationId },
    });

    await expect(startBrowserCtfRemove(input)).resolves.toEqual({
      kind: "completed",
      intentId: "completed-local-removal",
    });
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, proof.proofId]),
    ).toBeUndefined();
    expect(
      await fixture.database.proofs.get(storedProofFromCustodyRow(proof).secret),
    ).toBeUndefined();
    const marker = await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scopeId,
      proof.proofId,
    ]);
    expect(marker).toMatchObject({
      recordKind: "completed-local-removal",
      scopeId: fixture.scopeId,
      proofId: proof.proofId,
      proofFingerprint: proof.proofFingerprint,
      proofRevision: 2,
      localAssetKey: fixture.localAssetKey,
      terminalOperationId: fixture.terminalOperationId,
    });
    expect(marker).not.toHaveProperty("proofBody");
    expect(marker).not.toHaveProperty("secret");
    expect(marker).not.toHaveProperty("realm");
    expect(marker).not.toHaveProperty("acknowledgedHeadVersion");
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(await fixture.database.encryptedWalletBackupV2PreparedMutations.count()).toBe(0);

    fixture.database.close();
    const reloaded = new BitcasterDB(browserWalletDatabaseName(fixture.scopeId));
    databases.push(reloaded);
    await reloaded.open();
    await expect(startBrowserCtfRemove({ ...input, database: reloaded })).resolves.toMatchObject({
      kind: "completed",
    });
    expect(await reloaded.custodyProofs.count()).toBe(0);
    await expect(
      startBrowserCtfRemove({
        ...input,
        database: reloaded,
        targets: [{ ...input.targets[0]!, proofRevision: input.targets[0]!.proofRevision + 1 }],
      }),
    ).rejects.toThrow();
  });

  it("rolls back local-only removal before deleting the imported proof", async () => {
    const fixture = await createLocalFixture();
    const proof = fixture.proofs[0]!;

    await expect(
      startBrowserCtfRemove({
        ...fixture.localInput([fixture.target(proof.proofId)]),
        fault: "before-commit",
      }),
    ).rejects.toThrow(/local removal commit fault/);
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, proof.proofId]),
    ).toMatchObject({
      selectability: "verified-losing",
      revision: 2,
    });
    expect(await fixture.database.proofs.get(storedProofFromCustodyRow(proof).secret)).toEqual(
      expect.any(Object),
    );
    expect(
      await fixture.database.custodyProofBackupAuthorities.get([fixture.scopeId, proof.proofId]),
    ).not.toMatchObject({ recordKind: "completed-local-removal" });
  });

  it("rejects local removal when terminal evidence is not the committed 13015 operation", async () => {
    const fixture = await createLocalFixture();
    const proof = fixture.proofs[0]!;
    const rawAuthority = await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scopeId,
      proof.proofId,
    ]);
    const authority =
      rawAuthority === undefined
        ? undefined
        : requireBrowserLiveProofBackupAuthorityTableRow(rawAuthority, [
            fixture.scopeId,
            proof.proofId,
          ]);
    if (authority === undefined || authority.backupState !== "local-only") {
      throw new Error("test local authority is missing");
    }
    await fixture.database.custodyProofBackupAuthorities.put({
      ...authority,
      terminalOperationId: "missing-terminal-operation",
      terminalAuthority: { kind: "local-operation", operationId: "missing-terminal-operation" },
    });

    await expect(
      startBrowserCtfRemove(fixture.localInput([fixture.target(proof.proofId)])),
    ).rejects.toThrow(/terminal seal operation is missing/);
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, proof.proofId]),
    ).toMatchObject({
      selectability: "verified-losing",
      revision: 2,
    });
    expect(
      await fixture.database.custodyProofBackupAuthorities.get([fixture.scopeId, proof.proofId]),
    ).not.toMatchObject({ recordKind: "completed-local-removal" });
  });

  it("does not mix local-only and managed authority paths without a desired row", async () => {
    const fixture = await createLocalFixture(2);
    const managedProof = fixture.proofs[1]!;
    const managedAuthority = await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scopeId,
      managedProof.proofId,
    ]);
    if (managedAuthority === undefined) throw new Error("test managed sibling is missing");
    await fixture.database.custodyProofBackupAuthorities.put(
      createBrowserRemoteProofBackupAuthorityRow({
        proof: managedProof,
        observedAtMs: 3_000,
        derivationLocator: {
          schemaVersion: 1,
          kind: "nut13",
          keysetId: KEYSET,
          counter: 1,
        },
        restoreProofId: managedProof.proofId,
        restoreProofCommitment: "55".repeat(32),
      }),
    );

    await expect(
      startBrowserCtfRemove(
        fixture.input(fixture.proofs.map(({ proofId }) => fixture.target(proofId))),
      ),
    ).rejects.toThrow(/mixed completion paths/);
    expect(await fixture.database.custodyProofs.count()).toBe(2);
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
  });

  it("dispatches a local subset before managed CAS checks and preserves the managed sibling", async () => {
    const fixture = await createLocalFixture(2);
    const managedProof = fixture.proofs[1]!;
    await fixture.database.custodyProofBackupAuthorities.put(
      createBrowserRemoteProofBackupAuthorityRow({
        proof: managedProof,
        observedAtMs: 3_000,
        derivationLocator: {
          schemaVersion: 1,
          kind: "nut13",
          keysetId: KEYSET,
          counter: 1,
        },
        restoreProofId: managedProof.proofId,
        restoreProofCommitment: "55".repeat(32),
      }),
    );
    const desired = {
      ...createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId: fixture.scopeId,
        asset: fixture.asset,
        custodyRevision: 7n,
        activeProofCount: 2,
        terminalCtfContext: {
          conditionId: CONDITION_ID,
          outcomeLabel: OUTCOME,
          outcomeCollectionId: OUTCOME_COLLECTION_ID,
          registeredAt: 1,
          finalExpiry: 2,
        },
      }),
      syncState: "acknowledged" as const,
    };
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);

    await expect(
      startBrowserCtfRemove(fixture.localInput([fixture.target(fixture.proofs[0]!.proofId)])),
    ).resolves.toMatchObject({ kind: "completed", intentId: "completed-local-removal" });
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, managedProof.proofId]),
    ).toBeDefined();
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.localAssetKey,
      ]),
    ).toStrictEqual(desired);
  });

  it("refuses a reserved local-only proof without deleting custody", async () => {
    const fixture = await createLocalFixture();
    const proof = fixture.proofs[0]!;
    await fixture.database.custodyReservations.put({
      scopeId: fixture.scopeId,
      proofId: proof.proofId,
      operationId: "01".repeat(32),
      reservationId: "02".repeat(32),
      inputPosition: 0,
    });

    await expect(
      startBrowserCtfRemove(fixture.input([fixture.target(proof.proofId)])),
    ).rejects.toThrow(/reservation/);
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, proof.proofId]),
    ).toBeDefined();
    expect(
      await fixture.database.custodyProofBackupAuthorities.get([fixture.scopeId, proof.proofId]),
    ).not.toMatchObject({ recordKind: "completed-local-removal" });
  });

  it("refuses a new removal before creating an intent or pending proof", async () => {
    const fixture = await createFixture(1);
    const proof = fixture.proofs[0]!;
    mocks.requireNewWritePermission.mockRejectedValueOnce(
      new Error(
        "Another browser changed this wallet. Reload to start recovery before making a new wallet change.",
      ),
    );

    await expect(
      startBrowserCtfRemove(fixture.input([fixture.target(proof.proofId)])),
    ).rejects.toThrow("Another browser changed this wallet");

    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ custodyRevision: "1", removalIntent: null });
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, proof.proofId]),
    ).toMatchObject({
      revision: 0,
      selectability: "verified-losing",
    });
  });

  it.each([
    [
      "changed fingerprint",
      (target: BrowserCtfRemoveTarget) => ({ ...target, proofFingerprint: "ff".repeat(32) }),
    ],
    [
      "changed revision",
      (target: BrowserCtfRemoveTarget) => ({ ...target, proofRevision: target.proofRevision + 1 }),
    ],
  ])("refuses a %s before creating an intent or deleting custody", async (_name, changeTarget) => {
    const fixture = await createFixture(1);
    const proof = fixture.proofs[0]!;
    const target = fixture.target(proof.proofId);

    await expect(startBrowserCtfRemove(fixture.input([changeTarget(target)]))).rejects.toThrow(
      /caller proof tuples are stale/,
    );

    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ custodyRevision: "1", removalIntent: null });
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, proof.proofId]),
    ).toMatchObject({ revision: target.proofRevision, selectability: "verified-losing" });
    expect(await fixture.database.proofs.get(storedProofFromCustodyRow(proof).secret)).toEqual(
      expect.any(Object),
    );
  });

  it("rejects duplicate and malformed caller proof tuples", async () => {
    const fixture = await createFixture(1);
    const target = fixture.target(fixture.proofs[0]!.proofId);

    await expect(startBrowserCtfRemove(fixture.input([target, target]))).rejects.toThrow(
      /duplicated/,
    );
    await expect(
      startBrowserCtfRemove({
        ...fixture.input([target]),
        targets: [{ ...target, proofFingerprint: "not-a-fingerprint" }],
      }),
    ).rejects.toThrow(/proof tuple is invalid/);
    await expect(
      startBrowserCtfRemove({
        ...fixture.input([target]),
        targets: new Array<BrowserCtfRemoveTarget>(1),
      }),
    ).rejects.toThrow(/proof tuple is invalid/);
    expect(await fixture.database.custodyProofs.count()).toBe(1);
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ removalIntent: null });
  });

  it("does not remove a sibling that the caller did not confirm", async () => {
    const fixture = await createFixture(2);
    const confirmed = fixture.proofs[0]!;
    const unconfirmed = fixture.proofs[1]!;

    await expect(
      startBrowserCtfRemove(fixture.input([fixture.target(confirmed.proofId)])),
    ).resolves.toMatchObject({ kind: "started" });

    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, confirmed.proofId]),
    ).toMatchObject({ revision: confirmed.revision + 1, selectability: "pending-removal" });
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, unconfirmed.proofId]),
    ).toMatchObject({ revision: unconfirmed.revision, selectability: "verified-losing" });
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({
      activeProofCount: 1,
      removalIntent: { proofs: [{ proofId: confirmed.proofId }] },
    });
  });

  it("returns pending while desired backup revision is not acknowledged", async () => {
    const fixture = await createFixture(1);
    const proof = fixture.proofs[0]!;
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...fixture.desired,
      syncState: "pending",
    });

    await expect(
      startBrowserCtfRemove(fixture.input([fixture.target(proof.proofId)])),
    ).resolves.toEqual({ kind: "pending", reason: "backup-not-ready" });

    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "pending", removalIntent: null, custodyRevision: "1" });
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, proof.proofId]),
    ).toMatchObject({ revision: proof.revision, selectability: "verified-losing" });
    expect(await fixture.database.proofs.get(storedProofFromCustodyRow(proof).secret)).toEqual(
      expect.any(Object),
    );
  });

  it("returns pending while an existing prepared backup mutation remains", async () => {
    const fixture = await createFixture(1);
    const proof = fixture.proofs[0]!;
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...fixture.desired,
      syncState: "pending",
    });
    const prepared = await prepareRemovalCandidate(fixture);
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...fixture.desired,
      syncState: "acknowledged",
    });

    await expect(
      startBrowserCtfRemove(fixture.input([fixture.target(proof.proofId)])),
    ).resolves.toEqual({ kind: "pending", reason: "backup-not-ready" });

    expect(await fixture.store.readPreparedMutation()).toMatchObject(prepared);
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "acknowledged", removalIntent: null, custodyRevision: "1" });
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, proof.proofId]),
    ).toMatchObject({ revision: proof.revision, selectability: "verified-losing" });
    expect(await fixture.database.proofs.get(storedProofFromCustodyRow(proof).secret)).toEqual(
      expect.any(Object),
    );
  });

  it("refuses a remote terminal authority bound to the artifact fingerprint", async () => {
    const fixture = await createFixture(1);
    const proof = fixture.proofs[0]!;
    const rawAuthority = await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scopeId,
      proof.proofId,
    ]);
    if (rawAuthority === undefined) throw new Error("test authority is missing");
    const authority = requireBrowserLiveProofBackupAuthorityTableRow(rawAuthority, [
      fixture.scopeId,
      proof.proofId,
    ]);
    if (authority === undefined) throw new Error("test authority is missing");
    if (authority.backupState !== "remote-backed") throw new Error("test authority is local");
    await fixture.database.custodyProofBackupAuthorities.put({
      ...authority,
      backupRecordCommitment: proof.proofFingerprint,
    });

    await expect(
      startBrowserCtfRemove(fixture.input([fixture.target(proof.proofId)])),
    ).rejects.toThrow(/remote terminal authority is foreign/);
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ custodyRevision: "1", removalIntent: null });
  });

  it("fails closed when a local terminal operation is missing", async () => {
    const fixture = await createFixture(1);
    const proof = fixture.proofs[0]!;
    const rawAuthority = await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scopeId,
      proof.proofId,
    ]);
    if (rawAuthority === undefined) throw new Error("test authority is missing");
    const authority = requireBrowserLiveProofBackupAuthorityTableRow(rawAuthority, [
      fixture.scopeId,
      proof.proofId,
    ]);
    if (authority === undefined || authority.backupState !== "remote-backed") {
      throw new Error("test authority is not remote-backed");
    }
    await fixture.database.custodyProofBackupAuthorities.put({
      ...authority,
      admissionOperationId: "admission-local",
      backupState: "local-only",
      backupRecordId: null,
      backupRecordCommitment: null,
      derivationLocator: null,
      terminalOperationId: "missing-terminal-operation",
      terminalAuthority: { kind: "local-operation", operationId: "missing-terminal-operation" },
    });

    await expect(
      startBrowserCtfRemove(fixture.input([fixture.target(proof.proofId)])),
    ).rejects.toThrow(/terminal seal operation is missing/);
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ custodyRevision: "1", removalIntent: null });
  });

  it("routes a local-only authority with a derivation locator through managed checks", async () => {
    const fixture = await createFixture(1);
    const proof = fixture.proofs[0]!;
    const rawAuthority = await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scopeId,
      proof.proofId,
    ]);
    if (rawAuthority === undefined) throw new Error("test authority is missing");
    const authority = requireBrowserLiveProofBackupAuthorityTableRow(rawAuthority, [
      fixture.scopeId,
      proof.proofId,
    ]);
    if (authority === undefined || authority.backupState !== "remote-backed") {
      throw new Error("test authority is not remote-backed");
    }
    await fixture.database.custodyProofBackupAuthorities.put({
      ...authority,
      admissionOperationId: "admission-local",
      terminalOperationId: "missing-terminal-operation",
      terminalAuthority: { kind: "local-operation", operationId: "missing-terminal-operation" },
      backupState: "local-only",
      backupRecordId: null,
      backupRecordCommitment: null,
    });

    await expect(
      startBrowserCtfRemove(fixture.input([fixture.target(proof.proofId)])),
    ).rejects.toThrow(/terminal seal operation is missing/);
  });

  it("rolls back start and finalization faults without deleting custody", async () => {
    const fixture = await createFixture(1);
    const input = fixture.input([fixture.target(fixture.proofs[0]!.proofId)]);
    await expect(startBrowserCtfRemove({ ...input, fault: "before-commit" })).rejects.toThrow(
      /commit fault/,
    );
    expect(await fixture.database.custodyProofs.toArray()).toHaveLength(1);
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ removalIntent: null, custodyRevision: "1" });
  });

  it("rolls back finalization before marker persistence", async () => {
    const fixture = await createFixture(1);
    const input = fixture.input([fixture.target(fixture.proofs[0]!.proofId)]);
    await startBrowserCtfRemove(input);
    const head = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      walletId: fixture.keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 2,
      bundles: [],
    });
    await fixture.store.acceptCompetingHead({
      collectedHeadEvidence: evidence(head, []),
      stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
    });
    const current = (await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
      fixture.scopeId,
      fixture.desired.localAssetKey,
    ]))!;
    const intent = current.removalIntent!;
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...current,
      syncState: "acknowledged",
      removalIntent: {
        ...intent,
        state: "exclusion-acknowledged",
        acknowledgedExclusionEvidence: {
          kind: "current-head",
          headVersion: head.headVersion,
          activeSetDigest: head.activeSetDigest,
          bundleId: null,
          bundleDescriptorDigest: null,
          acknowledgedAtMs: 3_000,
        },
      },
    });
    await expect(
      finalizeBrowserCtfRemove({
        ...input,
        localAssetKey: fixture.desired.localAssetKey,
        fault: "before-commit",
      }),
    ).rejects.toThrow(/finalization fault/);
    expect(await fixture.database.custodyProofs.count()).toBe(1);
    expect(
      await fixture.database.custodyProofBackupAuthorities.get([
        fixture.scopeId,
        fixture.proofs[0]!.proofId,
      ]),
    ).not.toMatchObject({ recordKind: "completed-removal" });
  });

  it("refuses a changed legacy cache without changing canonical custody", async () => {
    const fixture = await createFixture(1);
    const proof = fixture.proofs[0]!;
    const cached = storedProofFromCustodyRow(proof);
    await fixture.database.proofs.put({ ...storedProofRow(cached), C: `02${"33".repeat(32)}` });
    await expect(
      startBrowserCtfRemove(fixture.input([fixture.target(proof.proofId)])),
    ).rejects.toThrow(/cache conflicts/);
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, proof.proofId]),
    ).toMatchObject({ selectability: "verified-losing", revision: 0 });
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ custodyRevision: "1", removalIntent: null });
  });

  it("refuses an exact proof reservation without changing canonical custody", async () => {
    const fixture = await createFixture(1);
    const proof = fixture.proofs[0]!;
    await fixture.database.custodyReservations.put({
      scopeId: fixture.scopeId,
      proofId: proof.proofId,
      operationId: "01".repeat(32),
      reservationId: "02".repeat(32),
      inputPosition: 0,
    });
    await expect(
      startBrowserCtfRemove(fixture.input([fixture.target(proof.proofId)])),
    ).rejects.toThrow(/reservation/);
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, proof.proofId]),
    ).toMatchObject({ selectability: "verified-losing", revision: 0 });
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ custodyRevision: "1", removalIntent: null });
  });

  it.each([1, 2])(
    "cancels an exact rejected %s-proof removal without deleting custody or queuing backup",
    async (count) => {
      const fixture = await createFixture(count);
      const target = fixture.proofs[0]!;
      await startBrowserCtfRemove(fixture.input([fixture.target(target.proofId)]));
      const rejected = await prepareRemovalCandidate(fixture);
      await fixture.store.markCompetingHeadRecoveryRequired({
        collectedHeadEvidence: fixture.headEvidence,
      });

      await expect(
        cancelDefinitivelyRejectedBrowserCtfRemove({
          database: fixture.database,
          scopeId: fixture.scopeId,
          keyHandle: fixture.keyHandle,
          enrollmentEpoch: 1,
          localAssetKey: fixture.desired.localAssetKey,
          assetLocator: fixture.bundle.descriptor.assetLocator,
          rejectedPreparedMutation: rejected,
          observedAtMs: 3_000,
          lockManager: immediateLockManager,
          isCurrentProfile: () => true,
        }),
      ).resolves.toMatchObject({ kind: "cancelled" });

      expect(await fixture.store.readPreparedMutation()).toBeNull();
      expect(await fixture.store.readLocalRecoveryStatus()).toMatchObject({
        localRecoveryStatus: "recovery-required",
        localRecoveryReason: "genuine-conflict",
        localRecoveryVersion: 1,
      });
      expect(
        await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
          fixture.scopeId,
          fixture.desired.localAssetKey,
        ]),
      ).toMatchObject({
        custodyRevision: "1",
        activeProofCount: count,
        desiredAction: "replace",
        syncState: "acknowledged",
        removalIntent: null,
      });
      expect(
        await fixture.database.custodyProofs.get([fixture.scopeId, target.proofId]),
      ).toMatchObject({ revision: 2, selectability: "verified-losing" });
      expect(
        await fixture.database.custodyProofBackupAuthorities.get([fixture.scopeId, target.proofId]),
      ).toMatchObject({
        proofRevision: 2,
        proofState: "verified-losing",
        backupState: "remote-backed",
        terminalAuthority: { kind: "remote-seal" },
      });
      expect(
        await fixture.database.proofs.get(storedProofFromCustodyRow(target).secret),
      ).toBeUndefined();
      expect(await fixture.database.custodyProofs.count()).toBe(count);
    },
  );

  it("keeps the complete pending removal when rejected identity or commit fails", async () => {
    const fixture = await createFixture(1);
    const target = fixture.proofs[0]!;
    await startBrowserCtfRemove(fixture.input([fixture.target(target.proofId)]));
    const rejected = await prepareRemovalCandidate(fixture);
    const cancellation = {
      database: fixture.database,
      scopeId: fixture.scopeId,
      keyHandle: fixture.keyHandle,
      enrollmentEpoch: 1,
      localAssetKey: fixture.desired.localAssetKey,
      assetLocator: fixture.bundle.descriptor.assetLocator,
      rejectedPreparedMutation: rejected,
      observedAtMs: 3_000,
      lockManager: immediateLockManager,
      isCurrentProfile: () => true,
    } as const;

    await expect(
      cancelDefinitivelyRejectedBrowserCtfRemove({
        ...cancellation,
        rejectedPreparedMutation: { ...rejected, requestDigest: "ff".repeat(32) },
      }),
    ).rejects.toThrow(/prepared candidate is stale/);
    await expect(
      cancelDefinitivelyRejectedBrowserCtfRemove({
        ...cancellation,
        fault: "before-commit",
      }),
    ).rejects.toThrow(/cancellation fault/);

    expect(await fixture.store.readPreparedMutation()).toMatchObject(rejected);
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({
      custodyRevision: "2",
      activeProofCount: 0,
      syncState: "pending",
      removalIntent: { state: "pending" },
    });
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, target.proofId]),
    ).toMatchObject({ revision: 1, selectability: "pending-removal" });
    expect(
      await fixture.database.custodyProofBackupAuthorities.get([fixture.scopeId, target.proofId]),
    ).not.toMatchObject({ recordKind: "completed-removal" });
  });
});

async function createLocalFixture(count = 1, sharedTerminalOperation = false) {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const scope = {
    scopeKind: "wallet" as const,
    walletId: keyHandle.walletId,
    scopeId,
  };
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  databases.push(database);
  const adapter = new BrowserDurableCustodyAdapter(database);
  const owner = await adapter.claimScope(scope, {
    incarnationId: "browser-local-remove",
    observedAtMs: 1_000,
    leaseExpiresAtMs: 10_000,
  });
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: CONDITION_ID,
      outcomeLabel: OUTCOME,
      outcomeCollectionId: OUTCOME_COLLECTION_ID,
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  const localAssetKey = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset,
    custodyRevision: 0n,
    activeProofCount: 0,
  }).localAssetKey;
  let proofs = Array.from({ length: count }, (_, index) =>
    createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: {
        id: KEYSET,
        amount: 1 as never,
        secret: `local-remove-secret-${index}`,
        C: PUBLIC_KEY,
      },
      asset: { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: OUTCOME },
      receivedAtMs: 900,
    }),
  );
  await database.custodyProofs.bulkPut(proofs);
  await database.custodyProofBackupAuthorities.bulkPut(
    proofs.map((proof, index) =>
      createBrowserProofBackupAuthorityRow(proof, 1_000, null, `admission-local-${index}`),
    ),
  );
  await database.proofs.bulkPut(
    proofs.map((proof) => storedProofRow(storedProofFromCustodyRow(proof))),
  );
  await database.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId,
    normalizedMint: MINT,
    unit: "msat",
    keysetId: proofs[0]!.keysetId,
    denominationPublicKeys: { "1": PUBLIC_KEY },
    inputFeePpk: 0,
    conditionId: CONDITION_ID,
    outcomeCollection: OUTCOME,
    outcomeCollectionId: OUTCOME_COLLECTION_ID,
    registeredAtUnixSeconds: 1,
    finalExpiryUnixSeconds: 2,
    curve: "secp256k1",
  });
  let terminalOperationId = "";
  const groups = sharedTerminalOperation ? [proofs] : proofs.map((proof) => [proof]);
  for (const [index, group] of groups.entries()) {
    const committed = await commitBrowserCtfTerminalOperation({
      adapter,
      scope,
      owner: { ...owner, observedAtMs: 1_500 + index * 100 },
      operationId: `ctf-redeem-local-remove-${index}`,
      mintUrl: MINT,
      proofs: group.map(proofFromLocalRow),
      predecessorProofs: group,
      publicKey: PUBLIC_KEY,
      classifiedAtMs: 2_000 + index * 100,
    });
    if (index === 0) terminalOperationId = committed.operationId;
  }
  const classifiedRows = await database.custodyProofs.bulkGet(
    proofs.map((proof) => [scopeId, proof.proofId]),
  );
  if (classifiedRows.some((proof) => proof === undefined)) {
    throw new Error("test classified removal proof is missing");
  }
  proofs = classifiedRows.map((proof) => decodeBrowserCustodyProofRow(proof));
  const assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle,
    mintUrl: MINT,
    unit: "msat",
    assetIdentity: asset.assetIdentity,
  });
  return {
    database,
    scopeId,
    keyHandle,
    asset,
    localAssetKey,
    proofs,
    terminalOperationId,
    target: (proofId: string) => {
      const proof = proofs.find((candidate) => candidate.proofId === proofId);
      if (proof === undefined) throw new Error("test removal target is missing");
      return removeTarget(proof);
    },
    input: (targets: readonly BrowserCtfRemoveTarget[]) => ({
      database,
      scopeId,
      keyHandle,
      enrollmentEpoch: 1,
      asset,
      assetLocator,
      targets,
      observedAtMs: 3_000,
      lockManager: immediateLockManager,
      isCurrentProfile: () => true,
    }),
    localInput: (targets: readonly BrowserCtfRemoveTarget[]) => ({
      database,
      scopeId,
      asset,
      targets,
      observedAtMs: 3_000,
      lockManager: immediateLockManager,
      isCurrentProfile: () => true,
    }),
  };
}

function proofFromLocalRow(row: ReturnType<typeof createBrowserCustodyProofRow>) {
  const proof = deserializeDurableCustodyProofArtifact(
    JSON.parse(new TextDecoder().decode(row.proofBody)),
  );
  return {
    id: proof.id,
    amount: Number(proof.amount),
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq === undefined ? {} : { dleq: structuredClone(proof.dleq) }),
  } as never;
}

async function createFixture(count: number) {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  databases.push(database);
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: CONDITION_ID,
      outcomeLabel: OUTCOME,
      outcomeCollectionId: OUTCOME_COLLECTION_ID,
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  const proofs = Array.from({ length: count }, (_, index) => {
    const row = createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: {
        id: `01${(index + 1).toString(16).padStart(2, "0")}${"11".repeat(31)}`,
        amount: 1 as never,
        secret: `remove-secret-${index}`,
        C: `02${"22".repeat(32)}`,
      },
      asset: { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: OUTCOME },
      receivedAtMs: 1_000,
    });
    return decodeBrowserCustodyProofRow({ ...row, selectability: "verified-losing" });
  });
  await database.custodyProofs.bulkPut(proofs);
  await database.custodyProofBackupAuthorities.bulkPut(
    proofs.map((proof, index) =>
      createBrowserRemoteProofBackupAuthorityRow({
        proof,
        observedAtMs: 2_000,
        derivationLocator: terminalLocator(proof, index),
        restoreProofId: proof.proofId,
        restoreProofCommitment: terminalProofCommitment(proof, index),
      }),
    ),
  );
  await database.proofs.bulkPut(
    proofs.map((proof) => storedProofRow(storedProofFromCustodyRow(proof))),
  );
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount: count,
    terminalCtfContext: {
      conditionId: CONDITION_ID,
      outcomeLabel: OUTCOME,
      outcomeCollectionId: OUTCOME_COLLECTION_ID,
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  const bundle = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset,
    declaredAmount: BigInt(count),
    custodyRevision: 1n,
    canonicalPayload: encodeCanonicalBackupCbor(["initial"]),
    runtime: { subtle: crypto.subtle, getRandomValues: (target) => crypto.getRandomValues(target) },
  });
  const store = new EncryptedWalletBackupV2DexieAuthorityStore({
    database,
    scopeId,
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
  });
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [bundle.descriptor],
  });
  await store.acceptCompetingHead({
    collectedHeadEvidence: evidence(head, [bundle.descriptor]),
    stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
  });
  await database.encryptedWalletBackupV2DesiredAssets.put({
    ...desired,
    syncState: "acknowledged",
  });
  return {
    database,
    scopeId,
    keyHandle,
    asset,
    desired,
    proofs,
    store,
    bundle,
    headEvidence: evidence(head, [bundle.descriptor]),
    target: (proofId: string) => {
      const proof = proofs.find((candidate) => candidate.proofId === proofId);
      if (proof === undefined) throw new Error("test removal target is missing");
      return removeTarget(proof);
    },
    input: (targets: readonly BrowserCtfRemoveTarget[]) => ({
      database,
      scopeId,
      keyHandle,
      enrollmentEpoch: 1,
      asset,
      assetLocator: bundle.descriptor.assetLocator,
      targets,
      observedAtMs: 2_500,
      lockManager: immediateLockManager,
      isCurrentProfile: () => true,
    }),
  };
}

function removeTarget(
  proof: ReturnType<typeof decodeBrowserCustodyProofRow>,
): BrowserCtfRemoveTarget {
  return {
    proofId: proof.proofId,
    proofFingerprint: proof.proofFingerprint,
    proofRevision: proof.revision,
  };
}

async function prepareRemovalCandidate(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const desiredRaw = await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
    fixture.scopeId,
    fixture.desired.localAssetKey,
  ]);
  if (desiredRaw === undefined) throw new Error("test desired removal is missing");
  const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(desiredRaw);
  const successor =
    desired.activeProofCount === 0
      ? null
      : await prepareEncryptedWalletBackupV2TransportBundle({
          keyHandle: fixture.keyHandle,
          asset: fixture.asset,
          declaredAmount: BigInt(desired.activeProofCount),
          custodyRevision: BigInt(desired.custodyRevision),
          canonicalPayload: encodeCanonicalBackupCbor(["survivors"]),
          runtime: {
            subtle: crypto.subtle,
            getRandomValues: (target) => crypto.getRandomValues(target),
          },
        });
  const envelope = await prepareEncryptedWalletBackupV2AssetMutation({
    keyHandle: fixture.keyHandle,
    expectedHeadEvidence: fixture.headEvidence,
    assetLocator: fixture.bundle.descriptor.assetLocator,
    desiredAction: desired.desiredAction,
    addedBundle: successor?.descriptor ?? null,
    runtime: { getRandomValues: (target) => crypto.getRandomValues(target) },
  });
  const canonicalUploadGroup = encodeEncryptedWalletBackupV2UploadGroup({
    envelope,
    objects: successor?.objects ?? [],
  });
  const binding = {
    localAssetKey: desired.localAssetKey,
    assetLocator: fixture.bundle.descriptor.assetLocator,
    custodyRevision: desired.custodyRevision,
    desiredAction: desired.desiredAction,
    activeProofCount: desired.activeProofCount,
  };
  await fixture.store.insertPreparedMutationForDesired({
    prepared: {
      mutationId: envelope.mutation.mutationId,
      requestDigest: envelope.requestDigest,
      canonicalUploadGroup,
      createdAtUnixMilliseconds: 2_600,
      ...binding,
    },
    desired: binding,
  });
  return { mutationId: envelope.mutation.mutationId, requestDigest: envelope.requestDigest };
}

function evidence(
  head: ReturnType<typeof createEncryptedWalletBackupV2CurrentHead>,
  bundles: Parameters<typeof enumerateEncryptedWalletBackupV2DescriptorPages>[0]["bundles"],
) {
  return collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles }),
  );
}

function terminalLocator(proof: ReturnType<typeof decodeBrowserCustodyProofRow>, counter: number) {
  return {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: proof.keysetId,
    counter,
  };
}

function terminalProofCommitment(
  proof: ReturnType<typeof decodeBrowserCustodyProofRow>,
  counter: number,
): string {
  return digestEncryptedWalletBackupV2TerminalProofCommitment({
    proofId: proof.proofId,
    mintUrl: proof.normalizedMint,
    unit: proof.unit,
    asset: {
      kind: "ctf",
      conditionId: CONDITION_ID,
      outcomeLabel: OUTCOME,
      outcomeCollectionId: OUTCOME_COLLECTION_ID,
      registeredAt: 1,
      finalExpiry: 2,
    },
    proof: deserializeDurableCustodyProofArtifact(
      JSON.parse(new TextDecoder().decode(proof.proofBody)),
    ),
    locator: terminalLocator(proof, counter),
  });
}
