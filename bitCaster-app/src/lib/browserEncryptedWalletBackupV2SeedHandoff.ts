import {
  decodeEncryptedWalletBackupV2BundleDescriptorWire,
  decodeEncryptedWalletBackupV2BundleSupersessionReceiptWire,
  createEncryptedWalletBackupV2CurrentHead,
  decodeEncryptedWalletBackupV2CurrentHead,
  encodeEncryptedWalletBackupV2BundleSupersessionReceipt,
  encodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire,
  decodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire,
  digestEncryptedWalletBackupV2BundleDescriptor,
  encodeEncryptedWalletBackupV2BundleDescriptor,
  encodeEncryptedWalletBackupV2CurrentHead,
  type EncryptedWalletBackupV2BundleDescriptor,
} from "@bitcaster/client-sdk";
import { browserWalletDatabaseName } from "./browserWalletProfile";
import { encryptedWalletBackupV2VaultLockName } from "./encryptedWalletBackupDriver";
import { withWalletProfileLock } from "./walletProfileLock";
import { readBrowserEncryptedWalletBackupV2ExactLocalProofRows } from "../stores/browser-encrypted-wallet-backup-v2-asset-source";
import { pageActiveCtfRangePreparations } from "../stores/ctf-range-order-db";
import {
  decodeEncryptedWalletBackupV2DesiredAssetRow,
  type EncryptedWalletBackupV2DesiredAssetRow,
} from "../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import {
  decodeBrowserCustodyProofRow,
  type BrowserCustodyProofRow,
} from "../stores/durable-custody-types";
import type { BitcasterDB, EncryptedWalletBackupV2AssetReceiptRow } from "../stores/proof-db";

const DESIRED_ASSET_MAX = 256;
const PROOFS_PER_ASSET_MAX = 512;
const ACTIVE_PROOF_MAX = DESIRED_ASSET_MAX * PROOFS_PER_ASSET_MAX;
const TEXT_KEY_MIN = "";
const TEXT_KEY_MAX = "\uffff";
const NUMBER_KEY_MAX = Number.MAX_SAFE_INTEGER;

/** One local asset that has complete, acknowledged V2 backup authority. */
export interface BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset {
  readonly desired: EncryptedWalletBackupV2DesiredAssetRow;
  readonly proofs: readonly BrowserCustodyProofRow[];
  readonly receipt: EncryptedWalletBackupV2AssetReceiptRow;
  readonly descriptor: EncryptedWalletBackupV2BundleDescriptor;
}

export interface BrowserEncryptedWalletBackupV2CacheEligibilityInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly isCurrentProfile: () => boolean;
}

/**
 * Read bounded local authority for cache removal.
 * This function performs no network I/O and does not remove local state.
 */
export async function listBrowserEncryptedWalletBackupV2CacheRemovalEligibleAssets(
  input: BrowserEncryptedWalletBackupV2CacheEligibilityInput,
): Promise<readonly BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset[]> {
  requireCapturedDatabase(input);
  const desiredRows = await readDesiredRows(input.database, input.scopeId);

  const eligible: BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset[] = [];
  for (const rawDesired of desiredRows) {
    const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
    if (!isAcknowledgedReplacement(desired, input.scopeId)) continue;
    try {
      const proofs = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
        database: input.database,
        scopeId: input.scopeId,
        asset: {
          mintUrl: desired.mintUrl,
          unit: desired.unit,
          assetIdentity: desired.assetIdentity,
        },
      });
      if (proofs.length !== desired.activeProofCount) {
        continue;
      }
      if (
        proofs.some((proof) => proof.selectability !== "selectable" || proof.reservationOperationId)
      )
        continue;
      const coverage = await requireBackupCoverage(input.database, desired);
      eligible.push(
        Object.freeze({
          desired: Object.freeze({ ...desired }),
          proofs: Object.freeze([...proofs]),
          receipt: freezeReceipt(coverage.receipt),
          descriptor: coverage.descriptor,
        }),
      );
    } catch (error) {
      if (isMissingCoverageError(error)) continue;
      throw error;
    }
  }
  requireCapturedDatabase(input);
  return Object.freeze(eligible);
}

/**
 * Delete only the captured old IndexedDB database before activating a new profile.
 * This primitive never calls a backup service or deletes remote backup authority.
 */
export async function handoffBrowserEncryptedWalletBackupV2Seed(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly isCurrentProfile: () => boolean;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly invalidateOldProfile: () => void;
  readonly activateNewProfile: () => Promise<void>;
  readonly restoreOldProfile: () => Promise<void>;
}): Promise<void> {
  requireCapturedDatabase(input);
  await withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCapturedDatabase(input);
      const vaultLocks = await readVaultLocks(input.database, input.scopeId);
      // The profile lock always precedes sorted vault locks. The backup driver never takes a profile lock.
      await withVaultLocks(vaultLocks, input.lockManager, async () => {
        requireCapturedDatabase(input);
        await requireWholeWalletSeedHandoffEligibility(input);
        requireCapturedDatabase(input);
        input.invalidateOldProfile();
        try {
          input.database.close();
          await input.database.delete();
          await input.activateNewProfile();
        } catch (error) {
          await input.restoreOldProfile();
          throw error;
        }
      });
    },
    input.lockManager,
  );
}

async function readVaultLocks(database: BitcasterDB, scopeId: string): Promise<readonly string[]> {
  const heads = await database.encryptedWalletBackupV2AcceptedHeads
    .where("[scopeId+realm+vaultId+enrollmentEpoch]")
    .between(
      [scopeId, TEXT_KEY_MIN, TEXT_KEY_MIN, 0],
      [scopeId, TEXT_KEY_MAX, TEXT_KEY_MAX, NUMBER_KEY_MAX],
    )
    .limit(DESIRED_ASSET_MAX + 1)
    .toArray();
  if (heads.length > DESIRED_ASSET_MAX) throw new Error("browser V2 vault lock limit exceeded");
  return Object.freeze(
    [
      ...new Set(
        heads.map(({ realm, vaultId }) => encryptedWalletBackupV2VaultLockName({ realm, vaultId })),
      ),
    ].sort((left, right) => left.localeCompare(right)),
  );
}

async function withVaultLocks<T>(
  lockNames: readonly string[],
  lockManager: Pick<LockManager, "request"> | undefined,
  action: () => Promise<T>,
): Promise<T> {
  if (lockNames.length === 0) return action();
  if (!lockManager) throw new Error("This browser cannot safely lock the wallet profile");
  const [lockName, ...remaining] = lockNames;
  return lockManager.request(lockName!, { mode: "exclusive" }, () =>
    withVaultLocks(remaining, lockManager, action),
  );
}

async function requireNoActiveLocalWork(database: BitcasterDB, scopeId: string): Promise<void> {
  const [activeWork, preparedOperation, activeRanges, preparedMutation] = await Promise.all([
    database.custodyActiveWork
      .where("[scopeId+operationId]")
      .between([scopeId, TEXT_KEY_MIN], [scopeId, TEXT_KEY_MAX])
      .limit(1)
      .first(),
    database.proofOperations.where("state").equals("prepared").limit(1).first(),
    pageActiveCtfRangePreparations({ scopeId, limit: 1 }, database),
    database.encryptedWalletBackupV2PreparedMutations
      .where("[scopeId+realm+vaultId+enrollmentEpoch]")
      .between(
        [scopeId, TEXT_KEY_MIN, TEXT_KEY_MIN, 0],
        [scopeId, TEXT_KEY_MAX, TEXT_KEY_MAX, NUMBER_KEY_MAX],
      )
      .limit(1)
      .first(),
  ]);
  if (activeWork !== undefined) throw new Error("browser V2 seed handoff has active custody work");
  if (preparedOperation !== undefined)
    throw new Error("browser V2 seed handoff has a prepared proof operation");
  if (activeRanges.preparations.length > 0) {
    throw new Error("browser V2 seed handoff has active CTF range work");
  }
  if (preparedMutation !== undefined)
    throw new Error("browser V2 seed handoff has a prepared backup mutation");
}

async function requireWholeWalletSeedHandoffEligibility(
  input: BrowserEncryptedWalletBackupV2CacheEligibilityInput,
): Promise<void> {
  await requireNoActiveLocalWork(input.database, input.scopeId);
  const [desiredRows, eligible] = await Promise.all([
    readDesiredRows(input.database, input.scopeId),
    listBrowserEncryptedWalletBackupV2CacheRemovalEligibleAssets(input),
  ]);
  if (eligible.length !== desiredRows.length) {
    throw new Error("browser V2 seed handoff has uncovered desired assets");
  }
  await requireExactActiveProofCoverage(input.database, input.scopeId, eligible);
  requireCapturedDatabase(input);
}

async function readDesiredRows(database: BitcasterDB, scopeId: string) {
  const rows = await database.encryptedWalletBackupV2DesiredAssets
    .where("[scopeId+localAssetKey]")
    .between([scopeId, TEXT_KEY_MIN], [scopeId, TEXT_KEY_MAX])
    .limit(DESIRED_ASSET_MAX + 1)
    .toArray();
  if (rows.length > DESIRED_ASSET_MAX) throw new Error("browser V2 desired asset limit exceeded");
  return rows;
}

async function requireBackupCoverage(
  database: BitcasterDB,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
): Promise<{
  readonly receipt: EncryptedWalletBackupV2AssetReceiptRow;
  readonly descriptor: EncryptedWalletBackupV2BundleDescriptor;
}> {
  const receipts = await database.encryptedWalletBackupV2AssetReceipts
    .where("[scopeId+realm+vaultId+enrollmentEpoch]")
    .between(
      [desired.scopeId, TEXT_KEY_MIN, TEXT_KEY_MIN, 0],
      [desired.scopeId, TEXT_KEY_MAX, TEXT_KEY_MAX, NUMBER_KEY_MAX],
    )
    .limit(DESIRED_ASSET_MAX + 1)
    .toArray();
  if (receipts.length > DESIRED_ASSET_MAX) throw new Error("browser V2 receipt limit exceeded");
  const matches = receipts.filter(
    (row) =>
      row.localAssetKey === desired.localAssetKey &&
      row.custodyRevision === desired.custodyRevision,
  );
  if (matches.length !== 1) throw new Error("browser V2 desired receipt is absent or ambiguous");
  const receipt = matches[0]!;
  const signedMutation = decodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire(
    receipt.canonicalSignedMutation,
  );
  const mutation = signedMutation.mutation;
  const signedReceipt = decodeEncryptedWalletBackupV2BundleSupersessionReceiptWire(
    receipt.canonicalSignedReceipt,
  );
  if (
    !sameBytes(
      encodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire(signedMutation),
      receipt.canonicalSignedMutation,
    ) ||
    !sameBytes(
      encodeEncryptedWalletBackupV2BundleSupersessionReceipt(signedReceipt),
      receipt.canonicalSignedReceipt,
    )
  ) {
    throw new Error("browser V2 desired receipt is invalid");
  }
  if (
    mutation.realm !== receipt.realm ||
    mutation.vaultId !== receipt.vaultId ||
    mutation.enrollmentEpoch !== receipt.enrollmentEpoch ||
    mutation.addedBundle === null ||
    mutation.addedBundle.bundleId !== receipt.bundleId ||
    mutation.addedBundle.assetLocator !== receipt.assetLocator ||
    mutation.addedBundle.custodyRevision.toString() !== receipt.custodyRevision ||
    signedReceipt.realm !== receipt.realm ||
    signedReceipt.vaultId !== receipt.vaultId ||
    signedReceipt.enrollmentEpoch !== receipt.enrollmentEpoch ||
    signedReceipt.mutationId !== mutation.mutationId ||
    signedReceipt.requestDigest !== signedMutation.requestDigest ||
    signedReceipt.bundleId !== receipt.bundleId ||
    signedReceipt.bundleDescriptorDigest !== receipt.bundleDescriptorDigest
  ) {
    throw new Error("browser V2 desired receipt is foreign");
  }
  if (mutation.addedBundle === null) throw new Error("browser V2 desired receipt is foreign");
  const descriptor = mutation.addedBundle;
  if (
    descriptor.bundleId !== receipt.bundleId ||
    descriptor.assetLocator !== receipt.assetLocator ||
    descriptor.custodyRevision.toString() !== desired.custodyRevision ||
    digestEncryptedWalletBackupV2BundleDescriptor(descriptor) !== receipt.bundleDescriptorDigest
  ) {
    throw new Error("browser V2 active descriptor binding is invalid");
  }
  const head = await database.encryptedWalletBackupV2AcceptedHeads.get([
    desired.scopeId,
    receipt.realm,
    receipt.vaultId,
    receipt.enrollmentEpoch,
  ]);
  if (head === undefined) throw new Error("browser V2 accepted head is absent");
  if (
    head.scopeId !== desired.scopeId ||
    head.realm !== receipt.realm ||
    head.vaultId !== receipt.vaultId ||
    head.enrollmentEpoch !== receipt.enrollmentEpoch
  ) {
    throw new Error("browser V2 accepted head is foreign");
  }
  const decodedHead = decodeEncryptedWalletBackupV2CurrentHead({
    formatVersion: 2,
    realm: head.realm,
    vaultId: head.vaultId,
    enrollmentEpoch: head.enrollmentEpoch,
    headVersion: head.headVersion,
    activeBundleCount: head.activeBundleCount,
    activeObjectCount: head.activeObjectCount,
    activeSetDigest: head.activeSetDigest,
  });
  if (
    !sameBytes(encodeEncryptedWalletBackupV2CurrentHead(decodedHead), head.canonicalCurrentHead)
  ) {
    throw new Error("browser V2 accepted head is stale");
  }
  if (
    signedReceipt.resultHead.realm !== receipt.realm ||
    signedReceipt.resultHead.vaultId !== receipt.vaultId ||
    signedReceipt.resultHead.enrollmentEpoch !== receipt.enrollmentEpoch
  ) {
    throw new Error("browser V2 receipt result head is foreign");
  }
  await requireCurrentDescriptorAuthority(database, desired, decodedHead, descriptor);
  return { receipt, descriptor };
}

async function requireCurrentDescriptorAuthority(
  database: BitcasterDB,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  head: ReturnType<typeof decodeEncryptedWalletBackupV2CurrentHead>,
  receiptDescriptor: EncryptedWalletBackupV2BundleDescriptor,
): Promise<void> {
  const rows = await database.encryptedWalletBackupV2ActiveDescriptors
    .where("[scopeId+realm+vaultId+enrollmentEpoch]")
    .equals([desired.scopeId, head.realm, head.vaultId, head.enrollmentEpoch])
    .limit(DESIRED_ASSET_MAX + 1)
    .toArray();
  if (rows.length !== head.activeBundleCount || rows.length > DESIRED_ASSET_MAX) {
    throw new Error("browser V2 accepted head is stale");
  }
  const descriptors = rows.map((row) => {
    const descriptor = decodeEncryptedWalletBackupV2BundleDescriptorWire(row.canonicalDescriptor, {
      realm: head.realm,
      vaultId: head.vaultId,
    });
    if (
      row.scopeId !== desired.scopeId ||
      row.assetLocator !== descriptor.assetLocator ||
      row.custodyRevision !== descriptor.custodyRevision.toString() ||
      !sameBytes(encodeEncryptedWalletBackupV2BundleDescriptor(descriptor), row.canonicalDescriptor)
    ) {
      throw new Error("browser V2 active descriptor binding is invalid");
    }
    return descriptor;
  });
  if (
    new Set(descriptors.map(({ bundleId }) => bundleId)).size !== descriptors.length ||
    !descriptors.some(
      (descriptor) =>
        descriptor.bundleId === receiptDescriptor.bundleId &&
        digestEncryptedWalletBackupV2BundleDescriptor(descriptor) ===
          digestEncryptedWalletBackupV2BundleDescriptor(receiptDescriptor),
    ) ||
    !sameBytes(
      encodeEncryptedWalletBackupV2CurrentHead(
        createEncryptedWalletBackupV2CurrentHead({
          realm: head.realm,
          vaultId: head.vaultId,
          enrollmentEpoch: head.enrollmentEpoch,
          headVersion: head.headVersion,
          bundles: descriptors,
        }),
      ),
      encodeEncryptedWalletBackupV2CurrentHead(head),
    )
  ) {
    throw new Error("browser V2 accepted head is stale");
  }
}

async function requireExactActiveProofCoverage(
  database: BitcasterDB,
  scopeId: string,
  eligible: readonly BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset[],
): Promise<void> {
  const expected = new Set(eligible.flatMap(({ proofs }) => proofs.map(({ proofId }) => proofId)));
  const [selectable, locked] = await Promise.all([
    database.custodyProofs
      .where("[scopeId+selectability]")
      .equals([scopeId, "selectable"])
      .limit(ACTIVE_PROOF_MAX + 1)
      .toArray(),
    database.custodyProofs
      .where("[scopeId+selectability]")
      .equals([scopeId, "locked"])
      .limit(ACTIVE_PROOF_MAX + 1)
      .toArray(),
  ]);
  const rawRows = [...selectable, ...locked];
  if (rawRows.length > ACTIVE_PROOF_MAX) throw new Error("browser V2 active proof limit exceeded");
  const actual = rawRows.map(decodeBrowserCustodyProofRow).filter((row) => row.scopeId === scopeId);
  if (actual.length !== expected.size || actual.some((row) => !expected.delete(row.proofId))) {
    throw new Error("browser V2 seed handoff has untracked active custody rows");
  }
}

function isAcknowledgedReplacement(
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  scopeId: string,
): boolean {
  return (
    (desired.scopeId !== scopeId ||
      desired.syncState !== "acknowledged" ||
      desired.desiredAction !== "replace" ||
      desired.activeProofCount < 1) === false
  );
}

function isMissingCoverageError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /desired receipt is absent or ambiguous|active descriptor is absent|accepted head is absent|custody is incomplete/.test(
      error.message,
    )
  );
}

function freezeReceipt(
  value: EncryptedWalletBackupV2AssetReceiptRow,
): EncryptedWalletBackupV2AssetReceiptRow {
  return Object.freeze({
    ...value,
    canonicalSignedMutation: value.canonicalSignedMutation.slice(),
    canonicalSignedReceipt: value.canonicalSignedReceipt.slice(),
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function requireCapturedDatabase(input: BrowserEncryptedWalletBackupV2CacheEligibilityInput): void {
  if (
    !input.isCurrentProfile() ||
    input.database.name !== browserWalletDatabaseName(input.scopeId)
  ) {
    throw new Error("browser V2 seed handoff profile is stale");
  }
}
