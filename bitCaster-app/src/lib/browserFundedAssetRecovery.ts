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

const ASSET_MONITORING_PAGE_SIZE = 200;
const ASSET_MONITORING_RECOVERY_TIMEOUT_MS = 30_000;
// This is a safety bound for one recovery read, not an asset-count limit. A
// bounded read that reaches it is incomplete and never proves asset absence.
const ASSET_MONITORING_RECOVERY_PAGES_MAX = 64;

type BrowserFundedAssetRecoveryDiagnostic =
  | "local-plan"
  | "canonical-repair"
  | "driver-absent"
  | "driver-outcome"
  | "profile-or-lock";

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
  let failureStage: BrowserFundedAssetRecoveryDiagnostic = "local-plan";
  try {
    requireMsatAsset(input.asset);
    failureStage = "profile-or-lock";
    requireCurrent(input);
    failureStage = "local-plan";
    const initial = await input.loadPlan();
    failureStage = "profile-or-lock";
    requireCurrent(input);
    if (initial.kind === "ready") return { kind: "ready", plan: initial };
    if (initial.kind !== "insufficient") return { kind: "not-recoverable", plan: initial };
    failureStage = "canonical-repair";
    if (await repairSelectableCanonicalRows(input)) {
      failureStage = "local-plan";
      const repaired = await input.loadPlan();
      failureStage = "profile-or-lock";
      requireCurrent(input);
      if (repaired.kind === "ready") return { kind: "ready", plan: repaired };
      if (repaired.kind !== "insufficient") return { kind: "not-recoverable", plan: repaired };
    }
    failureStage = "driver-outcome";
    return await recoverBackupFirst(input);
  } catch {
    reportFundedRecoveryDiagnostic(failureStage);
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
  requireMsatAsset(input.asset);
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

async function recoverBackupFirst<TPlan extends FundedPlan>(
  input: BrowserFundedAssetRecoveryInput<TPlan>,
): Promise<BrowserFundedAssetRecoveryOutcome<TPlan>> {
  const driver = activeBrowserEncryptedWalletBackupV2RuntimeDriver(input.scopeId);
  if (driver === null) {
    reportFundedRecoveryDiagnostic("driver-absent");
    return { kind: "persistent-error" };
  }
  let monitoringAbsent = false;
  const outcome = await driver.recoverTargetedAsset({
    asset: input.asset,
    requiredAmount: input.requiredAmount,
    loadWallet: () => loadWallet(input),
    readExactMonitoringRecovery: async () => {
      const monitoring = await readExactMonitoringRecovery(input);
      monitoringAbsent = monitoring === null;
      return monitoring;
    },
    lockManager: input.lockManager,
  });
  requireCurrent(input);
  const recovered = recoveryOutcome<TPlan>(outcome, monitoringAbsent);
  if (recovered.kind === "persistent-error") {
    reportFundedRecoveryDiagnostic("driver-outcome");
  }
  return recovered;
}

/** Reads bounded monitoring pages only after authenticated backup lacks the asset. */
async function readExactMonitoringRecovery<TPlan extends FundedPlan>(
  input: BrowserFundedAssetRecoveryInput<TPlan>,
) {
  requireCurrent(input);
  const walletId = deriveDurableCustodyWalletId(input.seed);
  const client = createAuthenticatedBrowserEngineClient();
  const lifetime = createAssetMonitoringRecoveryLifetime();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  try {
    for (let pageNumber = 0; pageNumber < ASSET_MONITORING_RECOVERY_PAGES_MAX; pageNumber += 1) {
      requireCurrent(input);
      lifetime.signal.throwIfAborted();
      const page = await client.getAssetMonitoringAssets(
        {
          walletId,
          pageSize: ASSET_MONITORING_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        lifetime.signal,
      );
      lifetime.signal.throwIfAborted();
      requireCurrent(input);

      // A stale, building, or incomplete page cannot establish either presence
      // or absence. Preserve the existing recovery-unavailable outcome and do
      // not scan a partial page for a recovery fact.
      if (page.stale || page.building || page.incomplete) {
        throw new Error("asset monitoring page is incomplete");
      }

      const fact = page.assets.find((candidate) =>
        encryptedWalletBackupV2AssetMatchesMonitoringAsset(input.asset, candidate.asset),
      );
      if (fact !== undefined && BigInt(fact.availableSubunits) >= input.requiredAmount) {
        return { fact };
      }

      const nextCursor = page.nextCursor ?? null;
      if (nextCursor === null) return null;
      if (seenCursors.has(nextCursor)) {
        throw new Error("asset monitoring cursor did not advance");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new Error("asset monitoring recovery page bound exceeded");
  } finally {
    lifetime.dispose();
  }
}

function createAssetMonitoringRecoveryLifetime(): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ASSET_MONITORING_RECOVERY_TIMEOUT_MS);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timeout),
  };
}

async function loadWallet<TPlan extends FundedPlan>(input: BrowserFundedAssetRecoveryInput<TPlan>) {
  requireCurrent(input);
  const wallet = await getWalletForMnemonicUnit(
    input.asset.mintUrl,
    input.asset.unit,
    input.mnemonic,
  );
  requireCurrent(input);
  return wallet;
}

function requireMsatAsset(asset: EncryptedWalletBackupV2AssetIdentity): void {
  if (asset.unit !== "msat") throw new Error("funded asset recovery requires msat");
}

function recoveryOutcome<TPlan extends FundedPlan>(
  outcome: TargetedAssetRecoveryOutcome,
  monitoringAbsent: boolean,
): BrowserFundedAssetRecoveryOutcome<TPlan> {
  switch (outcome.kind) {
    case "local":
    case "restored-backup":
    case "restored-mint":
      return { kind: "recovered" };
    case "unavailable":
      return monitoringAbsent ? { kind: "unavailable" } : { kind: "persistent-error" };
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

function reportFundedRecoveryDiagnostic(code: BrowserFundedAssetRecoveryDiagnostic): void {
  console.warn(`funded-recovery-code=${code}`);
}
