import {
  deriveDurableCustodyWalletId,
  deserializeDurableCustodyProofArtifact,
  encryptedWalletBackupV2AssetMatchesMonitoringAsset,
  type EncryptedWalletBackupV2AssetIdentity,
  type TargetedAssetRecoveryOutcome,
} from "@bitcaster/client-sdk";
import { type BitcasterDB, type StoredProof, addProofs } from "@/stores/proof-db";
import { decodeDurableCustodyProofMaterialRecord } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { readBrowserEncryptedWalletBackupV2ExactLocalProofRows } from "@/stores/browser-encrypted-wallet-backup-v2-asset-source";
import { getWalletForMnemonicUnit } from "@/stores/wallet";
import { activeBrowserEncryptedWalletBackupV2RuntimeDriver } from "./encryptedWalletBackupDriver";
import { createAuthenticatedBrowserEngineClient } from "./markets";
import { withWalletProfileLock } from "./walletProfileLock";

type FundedPlan = { readonly kind: "ready" | "insufficient" | "not-reducible" | "round-limit" };

export type BrowserFundedAssetRecoveryOutcome<TPlan extends FundedPlan> =
  | { readonly kind: "ready"; readonly plan: TPlan }
  | { readonly kind: "not-recoverable"; readonly plan: TPlan }
  | { readonly kind: "recovered" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "persistent-error" };

export interface BrowserFundedAssetRecoveryInput<TPlan extends FundedPlan> {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly seed: Uint8Array;
  readonly mnemonic: string;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly requiredAmount: bigint;
  readonly loadPlan: () => Promise<TPlan>;
  readonly isCurrentProfile: () => boolean;
  readonly lockManager?: Pick<LockManager, "request">;
}

/** Recovers one exact funded action only after its local proof plan is insufficient. */
export async function recoverBrowserFundedAsset<TPlan extends FundedPlan>(
  input: BrowserFundedAssetRecoveryInput<TPlan>,
): Promise<BrowserFundedAssetRecoveryOutcome<TPlan>> {
  try {
    requireCurrent(input);
    const initial = await input.loadPlan();
    requireCurrent(input);
    if (initial.kind === "ready") return { kind: "ready", plan: initial };
    if (initial.kind !== "insufficient") return { kind: "not-recoverable", plan: initial };
    if (await repairSelectableCanonicalRows(input)) {
      const repaired = await input.loadPlan();
      requireCurrent(input);
      if (repaired.kind === "ready") return { kind: "ready", plan: repaired };
      if (repaired.kind !== "insufficient") return { kind: "not-recoverable", plan: repaired };
    }
    return await recoverFromExactMonitoringFact(input);
  } catch {
    return { kind: "persistent-error" };
  }
}

/** Repairs only selectable canonical rows when they can satisfy this exact action. */
export async function repairSelectableCanonicalRows(
  input: Pick<
    BrowserFundedAssetRecoveryInput<FundedPlan>,
    "database" | "scopeId" | "asset" | "requiredAmount" | "isCurrentProfile" | "lockManager"
  >,
): Promise<boolean> {
  requireCurrent(input);
  const rows = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows(input);
  requireCurrent(input);
  const selectable = rows.filter((row) => row.selectability === "selectable");
  const amount = selectable.reduce((total, row) => total + BigInt(row.amount), 0n);
  if (amount < input.requiredAmount) return false;
  await withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCurrent(input);
      await addProofs(selectable.map(toLegacyProof), input.database);
      requireCurrent(input);
    },
    input.lockManager,
  );
  return true;
}

async function recoverFromExactMonitoringFact<TPlan extends FundedPlan>(
  input: BrowserFundedAssetRecoveryInput<TPlan>,
): Promise<BrowserFundedAssetRecoveryOutcome<TPlan>> {
  const driver = activeBrowserEncryptedWalletBackupV2RuntimeDriver(input.scopeId);
  if (driver === null) return { kind: "persistent-error" };
  const walletId = deriveDurableCustodyWalletId(input.seed);
  const page = await createAuthenticatedBrowserEngineClient().getAssetMonitoringAssets({
    walletId,
    pageSize: 200,
  });
  requireCurrent(input);
  const fact = page.assets.find((candidate) =>
    encryptedWalletBackupV2AssetMatchesMonitoringAsset(input.asset, candidate.asset),
  );
  if (fact === undefined || BigInt(fact.availableSubunits) < input.requiredAmount) {
    return { kind: "unavailable" };
  }
  const wallet = await getWalletForMnemonicUnit(
    input.asset.mintUrl,
    input.asset.unit,
    input.mnemonic,
  );
  requireCurrent(input);
  const outcome = await driver.recoverTargetedAsset({
    asset: input.asset,
    monitoringFact: fact,
    wallet,
    lockManager: input.lockManager,
  });
  requireCurrent(input);
  return recoveryOutcome(outcome);
}

function recoveryOutcome<TPlan extends FundedPlan>(
  outcome: TargetedAssetRecoveryOutcome,
): BrowserFundedAssetRecoveryOutcome<TPlan> {
  switch (outcome.kind) {
    case "local":
    case "restored-backup":
    case "restored-mint":
      return { kind: "recovered" };
    case "unavailable":
      return { kind: "persistent-error" };
    case "already-attempted":
      return { kind: "persistent-error" };
    case "persistent-error":
      return { kind: "persistent-error" };
    default:
      throw new Error("browser funded recovery outcome is invalid");
  }
}

function toLegacyProof(
  row: Awaited<ReturnType<typeof readBrowserEncryptedWalletBackupV2ExactLocalProofRows>>[number],
): StoredProof {
  const { proof: material } = decodeDurableCustodyProofMaterialRecord(row);
  const proof = deserializeDurableCustodyProofArtifact({ schemaVersion: 1, ...material });
  return {
    ...proof,
    mintUrl: row.normalizedMint,
    baseAsset: row.baseAsset,
    unit: row.unit,
    ...(row.conditionId === null ? {} : { conditionId: row.conditionId }),
    ...(row.outcomeCollection === null ? {} : { outcomeCollection: row.outcomeCollection }),
  };
}

function requireCurrent(
  input: Pick<BrowserFundedAssetRecoveryInput<FundedPlan>, "isCurrentProfile">,
): void {
  if (!input.isCurrentProfile()) throw new Error("browser funded recovery profile is stale");
}
