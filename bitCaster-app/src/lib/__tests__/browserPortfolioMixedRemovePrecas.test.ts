// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2CurrentHead,
  encodeEncryptedWalletBackupV2UploadGroup,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  prepareEncryptedWalletBackupV2AssetMutation,
} from "@bitcaster/client-sdk";
import { readBrowserEncryptedWalletBackupV2AssetSnapshot } from "../../stores/browser-encrypted-wallet-backup-v2-asset-source";
import { createBrowserProofBackupAuthorityRow } from "../../stores/browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { BitcasterDB } from "../../stores/proof-db";
import { decodeEncryptedWalletBackupV2DesiredAssetRow } from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import {
  conditionalKeysetIdFor,
  immediateLockManager,
  MINT,
  MINT_PUBLIC_KEY,
  OUTCOME,
  REGULAR_KEYSET,
  SEED,
} from "./fixtures/browserCtfRedeemFixture";
import { createMixedCtfRemoveFixture } from "./fixtures/browserMixedCtfRemoveFixture";
import { removePortfolioPosition } from "../browserPortfolioRemove";
import type { BrowserCtfRemoveTarget } from "../browserCtfRemoveCoordinator";
import type { EncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk";
import {
  cancelDefinitivelyRejectedBrowserCtfRemove,
  finalizeBrowserCtfRemove,
  startBrowserCtfRemove,
} from "../browserCtfRemoveCoordinator";

const mocks = vi.hoisted(() => ({
  database: null as BitcasterDB | null,
  scopeId: "scope",
  claim: vi.fn(),
  driver: null as {
    removeManagedProofs: (input: {
      asset: EncryptedWalletBackupV2AssetIdentity;
      targets: readonly BrowserCtfRemoveTarget[];
      localTargets?: readonly BrowserCtfRemoveTarget[];
    }) => Promise<unknown>;
  } | null,
  lock: vi.fn(),
  requireNewWritePermission: vi.fn(),
}));

vi.mock("../../stores/proof-db", async () => {
  const actual =
    await vi.importActual<typeof import("../../stores/proof-db")>("../../stores/proof-db");
  return {
    ...actual,
    get db() {
      if (mocks.database === null) throw new Error("mixed remove test database is missing");
      return mocks.database;
    },
  };
});
vi.mock("../browserWalletProfile", async () => {
  const actual =
    await vi.importActual<typeof import("../browserWalletProfile")>("../browserWalletProfile");
  return { ...actual, activeBrowserWalletScopeId: () => mocks.scopeId };
});
vi.mock("../walletProfileLock", () => ({ withWalletProfileLock: mocks.lock }));
vi.mock("../bip39", () => ({ toSeed: () => SEED }));
vi.mock("../../stores/wallet", () => ({
  useWalletStore: { getState: () => ({ mnemonic: "test wallet" }) },
}));
vi.mock("../browserPortfolioClaim", () => ({ claimPortfolioPosition: mocks.claim }));
vi.mock("../browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: mocks.requireNewWritePermission,
}));
vi.mock("../encryptedWalletBackupDriver", async () => {
  const actual = await vi.importActual<typeof import("../encryptedWalletBackupDriver")>(
    "../encryptedWalletBackupDriver",
  );
  return {
    ...actual,
    activeBrowserEncryptedWalletBackupV2RuntimeDriver: () => mocks.driver,
  };
});

const databases: BitcasterDB[] = [];
const position = { mintUrl: MINT, conditionId: "aa".repeat(32), outcomeCollection: OUTCOME };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.database = null;
  mocks.scopeId = "scope";
  mocks.driver = null;
  mocks.lock.mockImplementation(async (_scopeId: string, action: () => Promise<unknown>) =>
    action(),
  );
  mocks.claim.mockResolvedValue({ kind: "completed", committedPayoutAmount: 0, losingLegs: 0 });
  mocks.requireNewWritePermission.mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("mixed local-only and remote-backed CTF removal", () => {
  it("commits both exact subsets before the successor snapshot reaches CAS", async () => {
    const mixed = await createMixedCtfRemoveFixture();
    databases.push(mixed.database);
    mocks.database = mixed.database;
    mocks.scopeId = mixed.scopeId;
    const cash = await createBrowserCustodyProofRow({
      scopeId: mixed.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: {
        id: REGULAR_KEYSET.id,
        amount: 17 as never,
        secret: "mixed-remove-unrelated-cash",
        C: MINT_PUBLIC_KEY,
      },
      asset: { kind: "regular" },
      receivedAtMs: 2,
    });
    const unrelatedHolding = await createBrowserCustodyProofRow({
      scopeId: mixed.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: {
        id: conditionalKeysetIdFor(4),
        amount: 23 as never,
        secret: "mixed-remove-unrelated-ctf",
        C: MINT_PUBLIC_KEY,
      },
      asset: {
        kind: "conditional",
        conditionId: "dd".repeat(32),
        outcomeCollection: "NO",
      },
      receivedAtMs: 3,
    });
    await mixed.database.custodyProofs.bulkPut([cash, unrelatedHolding]);
    await mixed.database.custodyProofBackupAuthorities.bulkPut([
      createBrowserProofBackupAuthorityRow(cash, 4, null, "test-cash"),
      createBrowserProofBackupAuthorityRow(unrelatedHolding, 4, null, "test-unrelated-ctf"),
    ]);
    const calls: Array<{
      targets: readonly BrowserCtfRemoveTarget[];
      localTargets?: readonly BrowserCtfRemoveTarget[];
    }> = [];
    let casReady = false;

    mocks.driver = {
      removeManagedProofs: async ({ targets, localTargets, ...rest }) => {
        calls.push({ targets, localTargets });
        const started = await startBrowserCtfRemove({
          ...mixed.input(),
          ...rest,
          targets,
          ...(localTargets === undefined ? {} : { localTargets }),
        });
        expect(started.kind).toBe("started");
        const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
          database: mixed.database,
          scopeId: mixed.scopeId,
          localAssetKey: mixed.desired.localAssetKey,
        });
        expect(snapshot.desired).toMatchObject({
          custodyRevision: "2",
          activeProofCount: 0,
          desiredAction: "remove",
          syncState: "pending",
          removalIntent: { state: "pending", proofs: [{ proofId: mixed.managedProof.proofId }] },
        });
        expect(snapshot.proofs).toHaveLength(0);
        casReady = true;
        return started;
      },
    };

    await expect(removePortfolioPosition(position)).resolves.toMatchObject({
      kind: "pending",
      reason: "managed-removal-pending",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.targets).toEqual(mixed.managedTargets);
    expect(calls[0]?.localTargets).toEqual(mixed.localTargets);
    expect(casReady).toBe(true);
    expect(
      await mixed.database.custodyProofs.get([mixed.scopeId, mixed.localProof.proofId]),
    ).toBeUndefined();
    expect(
      await mixed.database.custodyProofBackupAuthorities.get([
        mixed.scopeId,
        mixed.localProof.proofId,
      ]),
    ).toMatchObject({
      recordKind: "completed-local-removal",
      proofFingerprint: mixed.localProof.proofFingerprint,
      proofRevision: mixed.localProof.revision,
    });
    expect(
      await mixed.database.custodyProofs.get([mixed.scopeId, mixed.managedProof.proofId]),
    ).toMatchObject({ selectability: "pending-removal" });
    expect(await mixed.database.custodyProofs.get([mixed.scopeId, cash.proofId])).toMatchObject({
      proofId: cash.proofId,
      amount: 17,
      assetKind: "regular",
    });
    expect(
      await mixed.database.custodyProofs.get([mixed.scopeId, unrelatedHolding.proofId]),
    ).toMatchObject({
      proofId: unrelatedHolding.proofId,
      amount: 23,
      conditionId: "dd".repeat(32),
      outcomeCollection: "NO",
    });

    await expect(startBrowserCtfRemove(mixed.input())).resolves.toMatchObject({
      kind: "resumed",
    });
    await expect(
      startBrowserCtfRemove({
        ...mixed.input(),
        localTargets: [
          {
            ...mixed.localTargets[0]!,
            proofRevision: mixed.localTargets[0]!.proofRevision + 1,
          },
        ],
      }),
    ).rejects.toThrow(/local removal replay is incomplete/);

    mixed.database.close();
    const reloaded = new BitcasterDB(browserWalletDatabaseName(mixed.scopeId));
    databases.push(reloaded);
    await reloaded.open();
    await expect(startBrowserCtfRemove(mixed.input(reloaded, false))).resolves.toMatchObject({
      kind: "resumed",
    });
    expect(
      await reloaded.custodyProofBackupAuthorities.get([mixed.scopeId, mixed.localProof.proofId]),
    ).toMatchObject({ recordKind: "completed-local-removal" });
  });

  it("refuses an unretained non-target arrival before creating the managed intent", async () => {
    const mixed = await createMixedCtfRemoveFixture();
    databases.push(mixed.database);
    mocks.database = mixed.database;
    mocks.scopeId = mixed.scopeId;
    mocks.driver = {
      removeManagedProofs: async ({ targets, localTargets, ...rest }) => {
        const arrival = await createBrowserCustodyProofRow({
          scopeId: mixed.scopeId,
          normalizedMint: MINT,
          unit: "msat",
          proof: {
            id: conditionalKeysetIdFor(3),
            amount: 99 as never,
            secret: "mixed-remove-non-target-arrival",
            C: MINT_PUBLIC_KEY,
          },
          asset: {
            kind: "conditional",
            conditionId: position.conditionId,
            outcomeCollection: OUTCOME,
          },
          receivedAtMs: 50,
        });
        await mixed.database.custodyProofs.put(arrival);
        await mixed.database.custodyProofBackupAuthorities.put(
          createBrowserProofBackupAuthorityRow(arrival, 51, null, "ctf-arrival"),
        );
        return startBrowserCtfRemove({
          ...mixed.input(),
          ...rest,
          targets,
          ...(localTargets === undefined ? {} : { localTargets }),
        });
      },
    };

    await expect(removePortfolioPosition(position)).resolves.toMatchObject({
      kind: "error",
      error: { stage: "managed-backup-removal" },
    });
    expect(await mixed.database.custodyProofs.count()).toBe(3);
    expect(
      await mixed.database.custodyProofs.get([mixed.scopeId, mixed.localProof.proofId]),
    ).toMatchObject({ selectability: "verified-losing" });
    expect(
      await mixed.database.custodyProofs.get([mixed.scopeId, mixed.managedProof.proofId]),
    ).toMatchObject({ selectability: "verified-losing" });
    expect(
      await mixed.database.encryptedWalletBackupV2DesiredAssets.get([
        mixed.scopeId,
        mixed.desired.localAssetKey,
      ]),
    ).toMatchObject({ custodyRevision: "1", activeProofCount: 2, removalIntent: null });
  });

  it("rolls back the mixed local and managed changes at the transaction boundary", async () => {
    const mixed = await createMixedCtfRemoveFixture();
    databases.push(mixed.database);

    await expect(
      startBrowserCtfRemove({ ...mixed.input(), fault: "before-commit" }),
    ).rejects.toThrow(/commit fault/);

    expect(await mixed.database.custodyProofs.count()).toBe(2);
    expect(
      await mixed.database.custodyProofs.get([mixed.scopeId, mixed.localProof.proofId]),
    ).toMatchObject({ selectability: "verified-losing" });
    expect(
      await mixed.database.custodyProofs.get([mixed.scopeId, mixed.managedProof.proofId]),
    ).toMatchObject({ selectability: "verified-losing" });
    expect(
      await mixed.database.encryptedWalletBackupV2DesiredAssets.get([
        mixed.scopeId,
        mixed.desired.localAssetKey,
      ]),
    ).toMatchObject({ custodyRevision: "1", activeProofCount: 2, removalIntent: null });
    expect(
      await mixed.database.custodyProofBackupAuthorities.get([
        mixed.scopeId,
        mixed.localProof.proofId,
      ]),
    ).not.toMatchObject({ recordKind: "completed-local-removal" });
  });

  it("restores only the managed target after a definitive backup rejection", async () => {
    const mixed = await createMixedCtfRemoveFixture();
    databases.push(mixed.database);
    await startBrowserCtfRemove(mixed.input());
    const rejectedPreparedMutation = await prepareRemovalCandidate(mixed);

    await expect(
      cancelDefinitivelyRejectedBrowserCtfRemove({
        database: mixed.database,
        scopeId: mixed.scopeId,
        keyHandle: mixed.keyHandle,
        enrollmentEpoch: 1,
        localAssetKey: mixed.desired.localAssetKey,
        assetLocator: mixed.assetLocator,
        rejectedPreparedMutation,
        observedAtMs: 60,
        lockManager: immediateLockManager,
        isCurrentProfile: () => true,
      }),
    ).resolves.toMatchObject({ kind: "cancelled" });

    expect(
      await mixed.database.custodyProofs.get([mixed.scopeId, mixed.managedProof.proofId]),
    ).toMatchObject({ selectability: "verified-losing" });
    expect(
      await mixed.database.custodyProofs.get([mixed.scopeId, mixed.localProof.proofId]),
    ).toBeUndefined();
    expect(
      await mixed.database.custodyProofBackupAuthorities.get([
        mixed.scopeId,
        mixed.localProof.proofId,
      ]),
    ).toMatchObject({ recordKind: "completed-local-removal" });
    expect(
      await mixed.database.encryptedWalletBackupV2DesiredAssets.get([
        mixed.scopeId,
        mixed.desired.localAssetKey,
      ]),
    ).toMatchObject({ activeProofCount: 1, syncState: "acknowledged", removalIntent: null });
  });

  it("finalizes managed removal without replacing the local completion marker", async () => {
    const mixed = await createMixedCtfRemoveFixture();
    databases.push(mixed.database);
    await startBrowserCtfRemove(mixed.input());
    const prepared = await prepareRemovalCandidate(mixed);
    const successor = createEncryptedWalletBackupV2CurrentHead({
      realm: "backup.example",
      walletId: mixed.keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 2,
      bundles: [],
    });
    const successorEvidence = collectEncryptedWalletBackupV2DescriptorPages(
      enumerateEncryptedWalletBackupV2DescriptorPages({ head: successor, bundles: [] }),
    );
    await mixed.authorityStore.acceptCompetingHead({
      collectedHeadEvidence: successorEvidence,
      stalePreparedMutation: prepared,
    });
    const rawDesired = await mixed.database.encryptedWalletBackupV2DesiredAssets.get([
      mixed.scopeId,
      mixed.desired.localAssetKey,
    ]);
    if (rawDesired === undefined) throw new Error("mixed removal intent is missing");
    const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
    const intent = desired.removalIntent;
    if (intent === null) throw new Error("mixed removal intent is missing");
    await mixed.database.encryptedWalletBackupV2DesiredAssets.put({
      ...desired,
      syncState: "acknowledged",
      removalIntent: {
        ...intent,
        state: "exclusion-acknowledged",
        acknowledgedExclusionEvidence: {
          kind: "current-head",
          headVersion: successor.headVersion,
          activeSetDigest: successor.activeSetDigest,
          bundleId: null,
          bundleDescriptorDigest: null,
          acknowledgedAtMs: 61,
        },
      },
    });

    await expect(
      finalizeBrowserCtfRemove({
        database: mixed.database,
        scopeId: mixed.scopeId,
        keyHandle: mixed.keyHandle,
        enrollmentEpoch: 1,
        localAssetKey: mixed.desired.localAssetKey,
        assetLocator: mixed.assetLocator,
        observedAtMs: 62,
        lockManager: immediateLockManager,
        isCurrentProfile: () => true,
      }),
    ).resolves.toEqual({ kind: "completed" });

    expect(await mixed.database.custodyProofs.count()).toBe(0);
    expect(
      await mixed.database.custodyProofBackupAuthorities.get([
        mixed.scopeId,
        mixed.localProof.proofId,
      ]),
    ).toMatchObject({ recordKind: "completed-local-removal" });
    expect(
      await mixed.database.custodyProofBackupAuthorities.get([
        mixed.scopeId,
        mixed.managedProof.proofId,
      ]),
    ).toMatchObject({ recordKind: "completed-removal" });
    await expect(startBrowserCtfRemove(mixed.input())).resolves.toMatchObject({
      kind: "completed",
    });
  });
});

async function prepareRemovalCandidate(
  mixed: Awaited<ReturnType<typeof createMixedCtfRemoveFixture>>,
) {
  const rawDesired = await mixed.database.encryptedWalletBackupV2DesiredAssets.get([
    mixed.scopeId,
    mixed.desired.localAssetKey,
  ]);
  if (rawDesired === undefined) throw new Error("mixed removal desired row is missing");
  const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
  const envelope = await prepareEncryptedWalletBackupV2AssetMutation({
    keyHandle: mixed.keyHandle,
    expectedHeadEvidence: mixed.headEvidence,
    assetLocator: mixed.assetLocator,
    desiredAction: desired.desiredAction,
    addedBundle: null,
    runtime: { getRandomValues: (target) => crypto.getRandomValues(target) },
  });
  const canonicalUploadGroup = encodeEncryptedWalletBackupV2UploadGroup({
    envelope,
    objects: [],
  });
  const binding = {
    localAssetKey: desired.localAssetKey,
    assetLocator: mixed.assetLocator,
    custodyRevision: desired.custodyRevision,
    desiredAction: desired.desiredAction,
    activeProofCount: desired.activeProofCount,
  };
  await mixed.authorityStore.insertPreparedMutationForDesired({
    prepared: {
      mutationId: envelope.mutation.mutationId,
      requestDigest: envelope.requestDigest,
      canonicalUploadGroup,
      createdAtUnixMilliseconds: 55,
      ...binding,
    },
    desired: binding,
  });
  return { mutationId: envelope.mutation.mutationId, requestDigest: envelope.requestDigest };
}
