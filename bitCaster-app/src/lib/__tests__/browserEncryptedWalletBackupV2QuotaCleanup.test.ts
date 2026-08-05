// @vitest-environment node
import "fake-indexeddb/auto";
import { Amount, deriveKeysetId, Keyset, type Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  verifyEncryptedWalletBackupV2RestoredProofSet,
} from "@bitcaster/client-sdk";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset } from "../browserEncryptedWalletBackupV2SeedHandoff";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { BitcasterDB } from "../../stores/proof-db";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { retryBrowserEncryptedWalletBackupV2QuotaWrite } from "../browserEncryptedWalletBackupV2QuotaCleanup";
import { admitBrowserEncryptedWalletBackupV2Asset } from "../browserEncryptedWalletBackupV2Admission";

const scopeId = browserWalletScope(new Uint8Array(64).fill(9)).scopeId;
const SEED = new Uint8Array(64).fill(9);
const KEYSET_ID = deriveKeysetId(
  { 1: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" },
  { unit: "sat", versionByte: 1 },
);
const { eligible } = vi.hoisted(() => ({ eligible: vi.fn() }));

vi.mock("../browserEncryptedWalletBackupV2SeedHandoff", () => ({
  listBrowserEncryptedWalletBackupV2CacheRemovalEligibleAssets: eligible,
}));

describe("browser encrypted wallet backup V2 quota cleanup", () => {
  let database: BitcasterDB | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    eligible.mockReset();
    database?.close();
    if (database) await database.delete();
    database = null;
  });

  it("passes a non-quota write error through without cleanup", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const failure = new Error("write failed");

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        isCurrentProfile: () => true,
        write: async () => {
          throw failure;
        },
        lockManager: immediateLockManager(),
      }),
    ).rejects.toBe(failure);
    expect(eligible).not.toHaveBeenCalled();
  });

  it("rethrows the original quota error when no candidate is eligible", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    eligible.mockResolvedValue([]);
    const quota = quotaError();
    const write = vi.fn(async () => {
      throw quota;
    });

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        isCurrentProfile: () => true,
        write,
        lockManager: immediateLockManager(),
      }),
    ).rejects.toBe(quota);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps protected assets and removes the largest eligible cache exactly", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const protectedCandidate = await candidate(database, "protected", "11", 1);
    const small = await candidate(database, "small", "22", 2);
    const largest = await candidate(database, "largest", "33", 3, 20);
    eligible.mockResolvedValue([protectedCandidate, small, largest]);
    const write = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(quotaError())
      .mockResolvedValueOnce("written");

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        isCurrentProfile: () => true,
        protectedLocalAssetKeys: ["protected"],
        write,
        lockManager: immediateLockManager(),
      }),
    ).resolves.toEqual({ result: "written", evictedLocalAssetKey: "largest" });
    expect(write).toHaveBeenCalledTimes(2);
    expect(await database.custodyProofs.get([scopeId, largest.proofs[0]!.proofId])).toBeUndefined();
    expect(
      await database.custodyProofBackupAuthorities.get([scopeId, largest.proofs[0]!.proofId]),
    ).toBeUndefined();
    expect(
      (await database.proofs.toArray()).some((proof) => proof.secret.startsWith("33".repeat(31))),
    ).toBe(false);
    expect(await database.custodyProofs.get([scopeId, small.proofs[0]!.proofId])).toBeDefined();
    expect(
      await database.custodyProofs.get([scopeId, protectedCandidate.proofs[0]!.proofId]),
    ).toBeDefined();
    expect(
      await database.encryptedWalletBackupV2DesiredAssets.get([scopeId, "largest"]),
    ).toBeDefined();
  });

  it("fails stale profiles before cache deletion", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const victim = await candidate(database, "victim", "44", 4);
    eligible.mockResolvedValue([victim]);
    const quota = quotaError();

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        isCurrentProfile: () => false,
        write: async () => {
          throw quota;
        },
        lockManager: immediateLockManager(),
      }),
    ).rejects.toThrow(/profile is stale/);
    expect(await database.custodyProofs.get([scopeId, victim.proofs[0]!.proofId])).toBeDefined();
  });

  it("does not evict a second cache when the one retry also exceeds quota", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const victim = await candidate(database, "victim", "55", 5);
    eligible.mockResolvedValue([victim]);
    const first = quotaError();
    const second = quotaError();
    const write = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second);

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        isCurrentProfile: () => true,
        write,
        lockManager: immediateLockManager(),
      }),
    ).rejects.toBe(second);
    expect(eligible).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("keeps terminal reimport operation and artifact counts bounded across eviction cycles", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const verified = await verifiedProof();
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: "https://mint.example",
      unit: "sat",
      asset: { kind: "ordinary" },
    });
    const input = {
      seed: SEED,
      verified,
      asset,
      custodyRevision: 1n,
      sourceOperationId: "backup-v2-restore:bundle",
      wallet: restoreWallet(),
      database,
      scopeId,
      isCurrentProfile: () => true,
      lockManager: immediateLockManager(),
    };
    await admitBrowserEncryptedWalletBackupV2Asset(input);
    await database.custodyProofs.clear();
    await database.custodyProofBackupAuthorities.clear();
    await database.proofs.clear();
    await database.custodyOperations.bulkPut(
      Array.from({ length: 513 }, (_, index) => ({
        scopeId,
        operationId: `unrelated-${index}`,
        revision: 0,
        operationState: "reconciled" as const,
        nextAttemptAtMs: null,
        estimatedBytes: 0,
        record: {},
      })) as unknown as Parameters<typeof database.custodyOperations.bulkPut>[0],
    );
    const retainedOperationCount = await database.custodyOperations.count();
    const retainedArtifactCount = await database.custodyArtifacts.count();

    for (const cycle of ["one", "two", "three"]) {
      await admitBrowserEncryptedWalletBackupV2Asset({ ...input, randomId: () => cycle });
      const desired = (await database.encryptedWalletBackupV2DesiredAssets.toArray())[0]!;
      eligible.mockResolvedValue([
        {
          desired,
          proofs: await database.custodyProofs.toArray(),
        } as unknown as BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset,
      ]);
      await retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        isCurrentProfile: () => true,
        lockManager: immediateLockManager(),
        write: vi.fn().mockRejectedValueOnce(quotaError()).mockResolvedValueOnce("written"),
      });
      expect(await database.custodyOperations.count()).toBe(retainedOperationCount);
      expect(await database.custodyArtifacts.count()).toBe(retainedArtifactCount);
    }
  });
});

async function verifiedProof() {
  const locator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: KEYSET_ID,
    counter: 0,
  };
  const proof = {
    id: KEYSET_ID,
    amount: Amount.from(1),
    secret: deriveDurableWalletProofSecret({
      seed: SEED,
      locator,
      proofKeysetId: KEYSET_ID,
      proofAmount: 1,
    }),
    C: `02${"33".repeat(32)}`,
  };
  return verifyEncryptedWalletBackupV2RestoredProofSet({
    seed: SEED,
    expectedAsset: createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: "https://mint.example",
      unit: "sat",
      asset: { kind: "ordinary" },
    }),
    unverified: {
      proofs: [
        {
          mintUrl: "https://mint.example",
          unit: "sat",
          asset: { kind: "ordinary" },
          proof,
          locator,
          proofId: "11".repeat(32),
        },
      ],
      counterHighWaterMarks: [
        { mintUrl: "https://mint.example", unit: "sat", keysetId: KEYSET_ID, nextCounter: 1 },
      ],
    },
    port: {
      async resolveKeyset({ mintUrl, unit, keysetId }) {
        return { mintUrl, unit, keysetId, keyset: {}, requireDleq: true, verify: () => true };
      },
      verifyProofs: () => undefined,
      checkProofStates: async ({ proofs }) =>
        proofs.map(({ proofId }) => ({ proofId, state: "UNSPENT" })),
    },
  });
}

function restoreWallet(): CashuWallet {
  const keyset = new Keyset(KEYSET_ID, "sat", true, 0);
  keyset.keys = { 1: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" };
  return { getKeyset: () => keyset } as unknown as CashuWallet;
}

async function candidate(
  database: BitcasterDB,
  localAssetKey: string,
  secretPart: string,
  receivedAtMs: number,
  proofCount = 1,
): Promise<BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset> {
  const proofs = await Promise.all(
    Array.from({ length: proofCount }, async (_, index) => {
      const secret = `${secretPart.repeat(31)}${index.toString(16).padStart(2, "0")}`;
      const proof = createBrowserCustodyProofRow({
        scopeId,
        normalizedMint: "https://mint.example",
        unit: "sat",
        proof: {
          id: "01" + "22".repeat(32),
          amount: Amount.from(1),
          secret,
          C: "02" + "33".repeat(32),
        },
        asset: { kind: "regular" },
        receivedAtMs,
      });
      await database.custodyProofs.put(proof);
      await database.custodyProofBackupAuthorities.put({
        schemaVersion: 3,
        scopeId,
        proofId: proof.proofId,
        proofFingerprint: proof.proofFingerprint,
        proofRevision: 0,
        proofState: "selectable",
        terminalOperationId: null,
        recordCreatedAtUnixSeconds: 1,
        recordUpdatedAtUnixSeconds: 1,
        derivationLocator: null,
        updatedAtMs: 1,
        admissionOperationId: null,
        backupState: "remote-backed",
        backupRecordId: proof.proofId,
        backupRecordCommitment: "aa".repeat(32),
      });
      await database.proofs.put({
        id: proof.keysetId,
        amount: 1,
        secret,
        C: "02" + "33".repeat(32),
        mintUrl: "https://mint.example",
      });
      return proof;
    }),
  );
  await database.encryptedWalletBackupV2DesiredAssets.put({
    scopeId,
    localAssetKey,
    mintUrl: "https://mint.example",
    unit: "sat",
    assetIdentity: "ordinary",
    custodyRevision: "1",
    activeProofCount: proofs.length,
    desiredAction: "replace",
    syncState: "acknowledged",
  });
  return {
    desired: { localAssetKey },
    proofs,
  } as unknown as BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset;
}

function quotaError(): Error {
  return Object.assign(new Error("quota"), { name: "QuotaExceededError" });
}

function immediateLockManager(): Pick<LockManager, "request"> {
  return {
    request: async <T>(
      _name: string,
      options: LockOptions | LockGrantedCallback<T>,
      callback?: LockGrantedCallback<T>,
    ) => (typeof options === "function" ? options(null) : callback!(null)),
  };
}
