// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckStateEnum, hashToCurve, MintOperationError } from "@cashu/cashu-ts";
import type { RedeemWallet } from "@bitcaster/client-sdk/ctfRedeem";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  encryptedWalletBackupV2LocalAssetKey,
} from "@bitcaster/client-sdk";
import {
  createBrowserCompletedLocalProofRemovalMarkerRow,
  createBrowserRemoteProofBackupAuthorityRow,
  createBrowserProofBackupAuthorityRow,
} from "../../stores/browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import type { BitcasterDB } from "../../stores/proof-db";
import {
  conditionalKeysetIdFor,
  CONDITION,
  MINT,
  MINT_PUBLIC_KEY,
  OUTCOME,
  REGULAR_KEYSET,
  SEED,
  fixture,
  immediateLockManager,
  signOutputs,
} from "./fixtures/browserCtfRedeemFixture";

const mocks = vi.hoisted(() => ({
  database: null as BitcasterDB | null,
  scopeId: "scope",
  activeScopeId: "scope",
  claim: vi.fn(),
  remove: vi.fn(),
  driver: null as { removeManagedProofs: (input: unknown) => Promise<unknown> } | null,
  lock: vi.fn(),
  requireNewWritePermission: vi.fn(),
}));

vi.mock("../../stores/proof-db", async () => {
  const actual =
    await vi.importActual<typeof import("../../stores/proof-db")>("../../stores/proof-db");
  return {
    ...actual,
    get db() {
      if (mocks.database === null) throw new Error("portfolio remove test database is missing");
      return mocks.database;
    },
  };
});
vi.mock("../browserWalletProfile", () => ({
  activeBrowserWalletScopeId: () => mocks.activeScopeId,
}));
vi.mock("../walletProfileLock", () => ({
  withWalletProfileLock: mocks.lock,
}));
vi.mock("../bip39", () => ({ toSeed: () => SEED }));
vi.mock("../../stores/wallet", () => ({
  useWalletStore: { getState: () => ({ mnemonic: "test wallet" }) },
}));
vi.mock("../browserPortfolioClaim", () => ({
  claimPortfolioPosition: mocks.claim,
}));
vi.mock("../browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: mocks.requireNewWritePermission,
}));
vi.mock("../browserCtfRemoveCoordinator", async () => {
  const actual = await vi.importActual<typeof import("../browserCtfRemoveCoordinator")>(
    "../browserCtfRemoveCoordinator",
  );
  return { ...actual, startBrowserCtfRemove: mocks.remove };
});
vi.mock("../encryptedWalletBackupDriver", async () => {
  const actual = await vi.importActual<typeof import("../encryptedWalletBackupDriver")>(
    "../encryptedWalletBackupDriver",
  );
  return {
    ...actual,
    activeBrowserEncryptedWalletBackupV2RuntimeDriver: () => mocks.driver,
  };
});

import { removePortfolioPosition } from "../browserPortfolioRemove";
import { claimBrowserCanonicalCtfPosition } from "../browserCtfPositionClaim";

const position = {
  mintUrl: MINT,
  conditionId: CONDITION,
  outcomeCollection: OUTCOME,
};

const databases: BitcasterDB[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.database = null;
  mocks.activeScopeId = mocks.scopeId;
  mocks.driver = null;
  mocks.requireNewWritePermission.mockResolvedValue(undefined);
  mocks.lock.mockImplementation(async (_scopeId: string, action: () => Promise<unknown>) =>
    action(),
  );
  mocks.claim.mockResolvedValue({
    kind: "completed",
    committedPayoutAmount: 0,
    committedLegs: 0,
    losingLegs: 1,
    pendingLegs: 0,
    error: null,
  });
  mocks.remove.mockResolvedValue({ kind: "completed", intentId: "completed-local-removal" });
});

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function useFixture(amounts: readonly number[] = [13015]) {
  const entry = await fixture({ amounts });
  databases.push(entry.database);
  mocks.database = entry.database;
  mocks.scopeId = entry.scope.scopeId;
  mocks.activeScopeId = entry.scope.scopeId;
  return entry;
}

async function makeManaged(entry: Awaited<ReturnType<typeof fixture>>, index = 0) {
  const proof = entry.proofs[index]!;
  await entry.database.custodyProofBackupAuthorities.put(
    createBrowserRemoteProofBackupAuthorityRow({
      proof,
      observedAtMs: 2,
      derivationLocator: null,
      restoreProofId: proof.proofId,
      restoreProofCommitment: "22".repeat(32),
    }),
  );
}

function losingWallet(): RedeemWallet {
  return {
    loadMint: async () => undefined,
    checkProofsStates: async (inputs) =>
      inputs.map((input) => ({
        Y: hashToCurve(new TextEncoder().encode(input.secret)).toHex(true),
        state: CheckStateEnum.UNSPENT,
        witness: null,
      })),
    redeemOutcomeProofs: async () => {
      throw new MintOperationError(13015, "Oracle has not attested to this outcome collection");
    },
  };
}

function runLosingClaim(entry: Awaited<ReturnType<typeof fixture>>, targets: readonly unknown[]) {
  return claimBrowserCanonicalCtfPosition({
    position: { conditionId: CONDITION, outcomeCollection: OUTCOME },
    targets: targets as never,
    stopOnCommittedPayout: true,
    walletProfileLockHeld: true,
    context: {
      seed: SEED,
      mintUrl: MINT,
      prepareNewLegAuthority: async () => ({
        regularKeyset: REGULAR_KEYSET,
        oracleWitness: '{"oracle_sig":"test"}',
      }),
      counterSource: entry.counters,
      database: entry.database,
      adapter: entry.adapter,
      owner: entry.owner,
      wallet: losingWallet(),
      restoreOutputs: async (_mintUrl, outputs) => ({
        regular: signOutputs(outputs.regular as never),
      }),
      observedAtMs: 5,
      lockManager: immediateLockManager,
    },
  });
}

describe("Portfolio remove entry point", () => {
  it("captures canonical selectable proof identities before removing a 13015 proof", async () => {
    const entry = await useFixture([1]);
    const onCommittedLeg = vi.fn();
    const otherMint = await createBrowserCustodyProofRow({
      scopeId: entry.scope.scopeId,
      normalizedMint: "https://other.example",
      unit: "msat",
      proof: {
        id: conditionalKeysetIdFor(9),
        amount: 3 as never,
        secret: "other-mint-proof",
        C: MINT_PUBLIC_KEY,
      },
      asset: { kind: "conditional", conditionId: CONDITION, outcomeCollection: OUTCOME },
      receivedAtMs: 2,
    });
    await entry.database.custodyProofs.put(otherMint);
    await entry.database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(otherMint, 2, null, "other-mint-receive"),
    );
    mocks.claim.mockImplementation(async ({ targets }: { targets: readonly unknown[] }) =>
      runLosingClaim(entry, targets),
    );

    await expect(removePortfolioPosition({ ...position, onCommittedLeg })).resolves.toMatchObject({
      kind: "completed",
    });

    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          expect.objectContaining({
            proofId: entry.proof.proofId,
            revision: entry.proof.revision,
            proofFingerprint: entry.proof.proofFingerprint,
          }),
        ],
        stopOnCommittedPayout: true,
        onCommittedLeg,
      }),
    );
    expect(mocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          {
            proofId: entry.proof.proofId,
            proofFingerprint: entry.proof.proofFingerprint,
            proofRevision: entry.proof.revision + 2,
          },
        ],
      }),
    );
  });

  it("accepts the real selectable-to-13015 terminal revision before local removal", async () => {
    const entry = await useFixture([1]);
    mocks.claim.mockImplementation(async ({ targets }: { targets: readonly unknown[] }) =>
      runLosingClaim(entry, targets),
    );

    const result = await removePortfolioPosition(position);
    expect(result).toEqual({ kind: "completed", committedPayoutAmount: 0 });
    const retained = await entry.adapter.readProof(entry.scope.scopeId, entry.proof.proofId);
    expect(retained?.selectability).toBe("verified-losing");
    expect(retained?.revision).toBe(entry.proof.revision + 2);
    expect(mocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          {
            proofId: entry.proof.proofId,
            proofFingerprint: entry.proof.proofFingerprint,
            proofRevision: entry.proof.revision + 2,
          },
        ],
      }),
    );
  });

  it("retains exact proofs when canonical claim recovery is pending", async () => {
    await useFixture();
    mocks.claim.mockResolvedValue({
      kind: "pending",
      committedPayoutAmount: 0,
      committedLegs: 0,
      losingLegs: 0,
      pendingLegs: 1,
      reason: "mint-response-pending",
      error: null,
    });

    await expect(removePortfolioPosition(position)).resolves.toEqual({
      kind: "pending",
      reason: "claim-pending",
      committedPayoutAmount: 0,
    });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("stops removal after a stale display discovers a committed winning payout", async () => {
    await useFixture();
    mocks.claim.mockResolvedValue({
      kind: "stopped",
      committedPayoutAmount: 13015,
      committedLegs: 1,
      losingLegs: 0,
      pendingLegs: 0,
      reason: "winning-payout",
      error: null,
    });

    await expect(removePortfolioPosition(position)).resolves.toEqual({
      kind: "stopped",
      reason: "winning-payout",
      committedPayoutAmount: 13015,
    });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("keeps local-only proofs when managed removal is pending", async () => {
    const entry = await useFixture([1, 2]);
    await makeManaged(entry, 0);
    mocks.driver = {
      removeManagedProofs: vi.fn().mockResolvedValue({ kind: "started", intentId: "intent" }),
    };
    mocks.claim.mockImplementation(async ({ targets }: { targets: readonly unknown[] }) =>
      runLosingClaim(entry, targets),
    );

    await expect(removePortfolioPosition(position)).resolves.toEqual({
      kind: "pending",
      reason: "managed-removal-pending",
      committedPayoutAmount: 0,
    });
    expect(mocks.driver.removeManagedProofs).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          {
            proofId: entry.proofs[0]!.proofId,
            proofFingerprint: entry.proofs[0]!.proofFingerprint,
            proofRevision: entry.proofs[0]!.revision + 2,
          },
        ],
      }),
    );
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("continues the exact local subset after managed completion without including a new arrival", async () => {
    const entry = await useFixture([1, 2]);
    await makeManaged(entry, 0);
    const managedLocalAssetKey = encryptedWalletBackupV2LocalAssetKey(
      createEncryptedWalletBackupV2AssetIdentity({
        mintUrl: MINT,
        unit: "msat",
        asset: {
          kind: "ctf",
          conditionId: CONDITION,
          outcomeLabel: OUTCOME,
          outcomeCollectionId: "bb".repeat(32),
          registeredAt: 1,
          finalExpiry: null,
        },
      }),
    );
    mocks.driver = {
      removeManagedProofs: vi.fn().mockImplementation(async () => {
        await entry.database.custodyProofs.delete([entry.scope.scopeId, entry.proofs[0]!.proofId]);
        await entry.database.custodyProofBackupAuthorities.put(
          createBrowserCompletedLocalProofRemovalMarkerRow({
            scopeId: entry.scope.scopeId,
            proofId: entry.proofs[0]!.proofId,
            proofFingerprint: entry.proofs[0]!.proofFingerprint,
            proofRevision: entry.proofs[0]!.revision + 2,
            localAssetKey: managedLocalAssetKey,
            terminalOperationId: "managed-remove",
            completedAtMs: 6,
          }),
        );
        return { kind: "completed", intentId: "done" };
      }),
    };
    mocks.claim.mockImplementation(async ({ targets }: { targets: readonly unknown[] }) => {
      const result = await runLosingClaim(entry, targets);
      const arriving = await createBrowserCustodyProofRow({
        scopeId: entry.scope.scopeId,
        normalizedMint: MINT,
        unit: "msat",
        proof: {
          id: conditionalKeysetIdFor(3),
          amount: 99 as never,
          secret: "arriving-proof",
          C: MINT_PUBLIC_KEY,
        },
        asset: { kind: "conditional", conditionId: CONDITION, outcomeCollection: OUTCOME },
        receivedAtMs: 4,
      });
      await entry.database.custodyProofs.put(arriving);
      await entry.database.custodyProofBackupAuthorities.put(
        createBrowserProofBackupAuthorityRow(arriving, 5, null, "ctf-arrival"),
      );
      return result;
    });

    await expect(removePortfolioPosition(position)).resolves.toEqual({
      kind: "completed",
      committedPayoutAmount: 0,
    });
    expect(mocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          {
            proofId: entry.proofs[1]!.proofId,
            proofFingerprint: entry.proofs[1]!.proofFingerprint,
            proofRevision: entry.proofs[1]!.revision + 2,
          },
        ],
      }),
    );
    expect(mocks.remove.mock.calls[0]![0].targets).not.toContainEqual(
      expect.objectContaining({ proofId: "arriving-proof" }),
    );
  });

  it("chunks a large exact local removal into bounded coordinator operations", async () => {
    await useFixture(Array.from({ length: 513 }, () => 1));

    await expect(removePortfolioPosition(position)).resolves.toEqual({
      kind: "completed",
      committedPayoutAmount: 0,
    });
    expect(mocks.remove).toHaveBeenCalledTimes(2);
    expect(mocks.remove.mock.calls[0]![0].targets).toHaveLength(512);
    expect(mocks.remove.mock.calls[1]![0].targets).toHaveLength(1);
  }, 15_000);

  it("refuses a proof revision or body race after claim terminalization", async () => {
    const entry = await useFixture();
    mocks.claim.mockImplementation(async () => {
      const current = await entry.database.custodyProofs.get([
        entry.scope.scopeId,
        entry.proof.proofId,
      ]);
      if (!current) throw new Error("test proof disappeared");
      await entry.database.custodyProofs.put({
        ...current,
        revision: current.revision + 1,
        proofFingerprint: "ff".repeat(32),
      });
      return {
        kind: "completed",
        committedPayoutAmount: 0,
        committedLegs: 0,
        losingLegs: 1,
        pendingLegs: 0,
        error: null,
      };
    });

    await expect(removePortfolioPosition(position)).resolves.toMatchObject({ kind: "error" });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
