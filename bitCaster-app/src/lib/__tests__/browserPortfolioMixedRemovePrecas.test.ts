// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBrowserEncryptedWalletBackupV2AssetSnapshot } from "../../stores/browser-encrypted-wallet-backup-v2-asset-source";
import { createBrowserProofBackupAuthorityRow } from "../../stores/browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { BitcasterDB } from "../../stores/proof-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import {
  CONDITION,
  conditionalKeysetIdFor,
  immediateLockManager,
  MINT,
  MINT_PUBLIC_KEY,
  REGULAR_KEYSET,
} from "./fixtures/browserCtfRedeemFixture";
import { createMixedCtfRemoveFixture } from "./fixtures/ownerMixedCtfRemoveFixture";
import { removePortfolioPosition } from "../browserPortfolioRemove";
import type { BrowserCtfRemoveTarget } from "../browserCtfRemoveCoordinator";
import type { EncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk";
import { finalizeBrowserCtfRemove, startBrowserCtfRemove } from "../browserCtfRemoveCoordinator";

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

import { removalSeed as SEED } from "./fixtures/ownerCtfRemovalProofs";
const OUTCOME = "YES";
const databases: BitcasterDB[] = [];
const position = { mintUrl: MINT, conditionId: CONDITION, outcomeCollection: OUTCOME };

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
    ).toMatchObject({ custodyRevision: "1", activeProofCount: 1, removalIntent: null });
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
    ).toMatchObject({ custodyRevision: "1", activeProofCount: 1, removalIntent: null });
    expect(
      await mixed.database.custodyProofBackupAuthorities.get([
        mixed.scopeId,
        mixed.localProof.proofId,
      ]),
    ).not.toMatchObject({ recordKind: "completed-local-removal" });
  });

  it("retains managed pending work after rejected Owner dispatch without restoring the local target", async () => {
    const mixed = await createMixedCtfRemoveFixture();
    databases.push(mixed.database);
    await startBrowserCtfRemove(mixed.input());
    mixed.remote.remote.mutateHead.mockRejectedValueOnce(new Error("controlled Owner refusal"));
    await expect(mixed.cycle()).rejects.toThrow("controlled Owner refusal");
    const prepared = await mixed.remote.store.readPreparedMutation();
    expect(prepared).not.toBeNull();
    expect(
      await mixed.database.custodyProofs.get([mixed.scopeId, mixed.managedProof.proofId]),
    ).toMatchObject({ selectability: "pending-removal" });
    expect(
      await mixed.database.custodyProofs.get([mixed.scopeId, mixed.localProof.proofId]),
    ).toBeUndefined();
    expect(await mixed.remote.store.readPreparedMutation()).toEqual(prepared);
    expect(
      (
        await mixed.database.encryptedWalletBackupV2DesiredAssets.get([
          mixed.scopeId,
          mixed.desired.localAssetKey,
        ])
      )?.removalIntent?.state,
    ).toBe("pending");
  });

  it("finalizes managed removal without replacing the local completion marker", async () => {
    const mixed = await createMixedCtfRemoveFixture();
    databases.push(mixed.database);
    await startBrowserCtfRemove(mixed.input());
    expect((await mixed.cycle()).kind).toBe("committed");
    const localMarker = await mixed.database.custodyProofBackupAuthorities.get([
      mixed.scopeId,
      mixed.localProof.proofId,
    ]);
    await expect(
      finalizeBrowserCtfRemove({
        database: mixed.database,
        scopeId: mixed.scopeId,
        keyHandle: mixed.keyHandle,
        enrollmentEpoch: 1,
        ownerScopeId: mixed.owner.ownerScopeId,
        localAssetKey: mixed.desired.localAssetKey,
        assetLocator: mixed.assetLocator,
        observedAtMs: Date.now(),
        lockManager: immediateLockManager,
        isCurrentProfile: () => true,
      }),
    ).resolves.toEqual({ kind: "completed" });

    expect(
      await mixed.database.custodyProofBackupAuthorities.get([
        mixed.scopeId,
        mixed.localProof.proofId,
      ]),
    ).toEqual(localMarker);
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
