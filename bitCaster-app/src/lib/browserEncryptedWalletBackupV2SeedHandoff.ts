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
import { encryptedWalletBackupV2WalletLockName } from "./encryptedWalletBackupDriver";
import { withWalletProfileLock } from "./walletProfileLock";
import { readBrowserEncryptedWalletBackupV2ExactLocalProofRows } from "../stores/browser-encrypted-wallet-backup-v2-asset-source";
import { pageActiveCtfRangePreparations } from "../stores/ctf-range-order-db";
import {
  decodeEncryptedWalletBackupV2DesiredAssetRow,
  type EncryptedWalletBackupV2DesiredAssetRow,
} from "../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import {
  decodeBrowserCustodyProofRow,
  decodeBrowserCustodyConditionalKeysetRow,
  type BrowserCustodyConditionalKeysetRow,
  type BrowserCustodyProofRow,
} from "../stores/durable-custody-types";
import type {
  BitcasterDB,
  EncryptedWalletBackupV2AcceptedHeadRow,
  EncryptedWalletBackupV2ActiveDescriptorRow,
  EncryptedWalletBackupV2AssetReceiptRow,
} from "../stores/proof-db";

const DESIRED_ASSET_MAX = 256;
const PROOFS_PER_ASSET_MAX = 512;
const ACTIVE_PROOF_MAX = DESIRED_ASSET_MAX * PROOFS_PER_ASSET_MAX;
const ACTIVE_DESCRIPTOR_MAX = DESIRED_ASSET_MAX * DESIRED_ASSET_MAX;
const CONDITIONAL_KEYSET_MAX = DESIRED_ASSET_MAX * 16;
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

/** One fully evicted local asset with current, verified V2 backup authority. */
type BrowserEncryptedWalletBackupV2EvictedAssetMonitoringIdentity =
  | {
      readonly kind: "ordinary";
      readonly mintUrl: string;
      readonly unit: "sat" | "msat";
    }
  | {
      readonly kind: "conditional";
      readonly mintUrl: string;
      readonly unit: "sat" | "msat";
      readonly conditionId: string;
      readonly outcomeCollection: string;
    };

export type BrowserEncryptedWalletBackupV2EvictedAssetMonitoringFact =
  BrowserEncryptedWalletBackupV2EvictedAssetMonitoringIdentity & {
    readonly declaredAmount: number;
  };

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
      const proofs = await exactLocalProofs(input.database, input.scopeId, desired);
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
 * Lists backed assets whose complete local proof cache was evicted.
 * The returned amount is descriptor metadata. It contains no proof material.
 */
export async function listBrowserEncryptedWalletBackupV2EvictedAssetMonitoringFacts(
  input: BrowserEncryptedWalletBackupV2CacheEligibilityInput,
): Promise<readonly BrowserEncryptedWalletBackupV2EvictedAssetMonitoringFact[]> {
  requireCapturedDatabase(input);
  let scope: EvictedAssetMonitoringScope;
  try {
    scope = await readEvictedAssetMonitoringScope(input.database, input.scopeId);
  } catch (error) {
    requireCapturedDatabase(input);
    if (error instanceof Error && error.message === "browser V2 desired asset limit exceeded") {
      throw error;
    }
    return Object.freeze([]);
  }
  const facts: BrowserEncryptedWalletBackupV2EvictedAssetMonitoringFact[] = [];
  for (const desired of scope.desiredRows) {
    if (!isAcknowledgedReplacement(desired, input.scopeId)) continue;
    const asset = scope.assetsByDesired.get(desired.localAssetKey);
    if (asset === undefined || scope.desiredWithLocalProofs.has(desired.localAssetKey)) continue;
    const coverage = scope.coverageByDesired.get(desired.localAssetKey);
    if (coverage === undefined) continue;
    const declaredAmount = safeDeclaredAmount(coverage.declaredAmount);
    if (declaredAmount !== null) facts.push({ ...asset, declaredAmount });
  }
  requireCapturedDatabase(input);
  return Object.freeze(facts);
}

interface EvictedAssetMonitoringScope {
  readonly desiredRows: readonly EncryptedWalletBackupV2DesiredAssetRow[];
  readonly assetsByDesired: ReadonlyMap<
    string,
    BrowserEncryptedWalletBackupV2EvictedAssetMonitoringIdentity
  >;
  readonly desiredWithLocalProofs: ReadonlySet<string>;
  readonly coverageByDesired: ReadonlyMap<string, { readonly declaredAmount: bigint }>;
}

interface MonitoringCoverageRequest {
  readonly localAssetKey: string;
  readonly desired: EncryptedWalletBackupV2DesiredAssetRow;
  readonly authorityKey: string;
  readonly descriptorKey: string;
  readonly declaredAmount: bigint;
}

async function readEvictedAssetMonitoringScope(
  database: BitcasterDB,
  scopeId: string,
): Promise<EvictedAssetMonitoringScope> {
  const desiredRows = (await readDesiredRows(database, scopeId)).map(
    decodeEncryptedWalletBackupV2DesiredAssetRow,
  );
  const [receipts, heads, conditionalKeysets] = await Promise.all([
    database.encryptedWalletBackupV2AssetReceipts
      .where("[scopeId+realm+walletId+enrollmentEpoch]")
      .between(
        [scopeId, TEXT_KEY_MIN, TEXT_KEY_MIN, 0],
        [scopeId, TEXT_KEY_MAX, TEXT_KEY_MAX, NUMBER_KEY_MAX],
      )
      .limit(DESIRED_ASSET_MAX + 1)
      .toArray(),
    database.encryptedWalletBackupV2AcceptedHeads
      .where("[scopeId+realm+walletId+enrollmentEpoch]")
      .between(
        [scopeId, TEXT_KEY_MIN, TEXT_KEY_MIN, 0],
        [scopeId, TEXT_KEY_MAX, TEXT_KEY_MAX, NUMBER_KEY_MAX],
      )
      .limit(DESIRED_ASSET_MAX + 1)
      .toArray(),
    database.custodyConditionalKeysets
      .where("[scopeId+normalizedMint+unit+keysetId]")
      .between(
        [scopeId, TEXT_KEY_MIN, TEXT_KEY_MIN, TEXT_KEY_MIN],
        [scopeId, TEXT_KEY_MAX, TEXT_KEY_MAX, TEXT_KEY_MAX],
      )
      .limit(CONDITIONAL_KEYSET_MAX + 1)
      .toArray(),
  ]);
  if (receipts.length > DESIRED_ASSET_MAX) throw new Error("browser V2 receipt limit exceeded");
  if (heads.length > DESIRED_ASSET_MAX) throw new Error("browser V2 accepted head limit exceeded");
  if (conditionalKeysets.length > CONDITIONAL_KEYSET_MAX)
    throw new Error("browser V2 conditional keyset limit exceeded");
  const keysetsByIdentity = groupRows(conditionalKeysets, monitoringKeysetIdentityKey);
  const assetsByDesired = new Map<
    string,
    BrowserEncryptedWalletBackupV2EvictedAssetMonitoringIdentity
  >();
  const proofAssetKeys = new Map<string, Set<string>>();
  for (const desired of desiredRows) {
    if (!isAcknowledgedReplacement(desired, scopeId)) continue;
    const resolved = resolveMonitoringAsset(keysetsByIdentity, desired);
    if (resolved === null) continue;
    assetsByDesired.set(desired.localAssetKey, resolved.asset);
    for (const proofKey of resolved.proofKeys) {
      const localAssetKeys = proofAssetKeys.get(proofKey) ?? new Set<string>();
      localAssetKeys.add(desired.localAssetKey);
      proofAssetKeys.set(proofKey, localAssetKeys);
    }
  }
  const desiredWithLocalProofs = await streamMonitoringProofPresence(
    database,
    scopeId,
    proofAssetKeys,
  );
  const receiptsByDesired = groupRows(receipts, (row) =>
    monitoringDesiredKey(row.localAssetKey, row.custodyRevision),
  );
  const coverageRequestsByAuthority = new Map<string, MonitoringCoverageRequest[]>();
  for (const desired of desiredRows) {
    if (!assetsByDesired.has(desired.localAssetKey)) continue;
    const matches =
      receiptsByDesired.get(monitoringDesiredKey(desired.localAssetKey, desired.custodyRevision)) ??
      [];
    if (matches.length !== 1) continue;
    try {
      const receipt = matches[0]!;
      const descriptor = requireReceiptDescriptorBinding(receipt, desired);
      const authorityKey = monitoringAuthorityKey(receipt);
      const requests = coverageRequestsByAuthority.get(authorityKey) ?? [];
      requests.push({
        localAssetKey: desired.localAssetKey,
        desired,
        authorityKey,
        descriptorKey: monitoringDescriptorKey(descriptor),
        declaredAmount: descriptor.declaredAmount,
      });
      coverageRequestsByAuthority.set(authorityKey, requests);
    } catch {
      // Invalid receipts cannot create monitoring coverage.
    }
  }
  const coverageByDesired = await streamMonitoringDescriptorCoverage(
    database,
    scopeId,
    new Map(heads.map((row) => [monitoringAuthorityKey(row), row] as const)),
    coverageRequestsByAuthority,
  );
  return {
    desiredRows,
    assetsByDesired,
    desiredWithLocalProofs,
    coverageByDesired,
  };
}

async function streamMonitoringProofPresence(
  database: BitcasterDB,
  scopeId: string,
  relevantAssetKeys: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<ReadonlySet<string>> {
  const desiredWithLocalProofs = new Set<string>();
  let count = 0;
  await database.custodyProofs
    .where("[scopeId+selectability+proofId]")
    .between([scopeId, "locked", TEXT_KEY_MIN], [scopeId, "selectable", TEXT_KEY_MAX])
    .limit(ACTIVE_PROOF_MAX + 1)
    .each((rawProof) => {
      count += 1;
      const localAssetKeys = relevantAssetKeys.get(monitoringProofKey(rawProof));
      if (localAssetKeys === undefined) return;
      const proof = decodeBrowserCustodyProofRow(rawProof);
      if (monitoringProofKey(proof) !== monitoringProofKey(rawProof)) {
        throw new Error("browser V2 monitoring proof is invalid");
      }
      localAssetKeys.forEach((localAssetKey) => desiredWithLocalProofs.add(localAssetKey));
    });
  if (count > ACTIVE_PROOF_MAX) throw new Error("browser V2 active proof limit exceeded");
  return desiredWithLocalProofs;
}

async function streamMonitoringDescriptorCoverage(
  database: BitcasterDB,
  scopeId: string,
  headsByAuthority: ReadonlyMap<string, EncryptedWalletBackupV2AcceptedHeadRow>,
  requestsByAuthority: ReadonlyMap<string, readonly MonitoringCoverageRequest[]>,
): Promise<ReadonlyMap<string, { readonly declaredAmount: bigint }>> {
  const coverageByDesired = new Map<string, { readonly declaredAmount: bigint }>();
  let descriptorCount = 0;
  let currentAuthorityKey: string | null = null;
  let group: EncryptedWalletBackupV2ActiveDescriptorRow[] = [];
  const validateGroup = () => {
    if (currentAuthorityKey === null) return;
    const requests = requestsByAuthority.get(currentAuthorityKey);
    if (!requests || requests.length === 0) return;
    try {
      const head = headsByAuthority.get(currentAuthorityKey);
      if (head === undefined) return;
      const decodedHead = decodeCurrentHeadForReceipt(head, requests[0]!.desired, {
        realm: head.realm,
        walletId: head.walletId,
        enrollmentEpoch: head.enrollmentEpoch,
      });
      const descriptorDigests = requireCurrentDescriptorAuthorityFromRows(
        requests[0]!.desired,
        decodedHead,
        group,
      );
      for (const request of requests) {
        if (descriptorDigests.has(request.descriptorKey)) {
          coverageByDesired.set(request.localAssetKey, { declaredAmount: request.declaredAmount });
        }
      }
    } catch {
      // Stale or foreign descriptor authority cannot create monitoring coverage.
    }
  };
  await database.encryptedWalletBackupV2ActiveDescriptors
    .where("[scopeId+realm+walletId+enrollmentEpoch]")
    .between(
      [scopeId, TEXT_KEY_MIN, TEXT_KEY_MIN, 0],
      [scopeId, TEXT_KEY_MAX, TEXT_KEY_MAX, NUMBER_KEY_MAX],
    )
    .limit(ACTIVE_DESCRIPTOR_MAX + 1)
    .each((row) => {
      descriptorCount += 1;
      const authorityKey = monitoringAuthorityKey(row);
      if (currentAuthorityKey !== null && authorityKey !== currentAuthorityKey) {
        validateGroup();
        group = [];
      }
      currentAuthorityKey = authorityKey;
      group.push(row);
      if (group.length > DESIRED_ASSET_MAX) {
        throw new Error("browser V2 active descriptor limit exceeded");
      }
    });
  validateGroup();
  if (descriptorCount > ACTIVE_DESCRIPTOR_MAX)
    throw new Error("browser V2 active descriptor limit exceeded");
  return coverageByDesired;
}

function resolveMonitoringAsset(
  keysetsByIdentity: ReadonlyMap<string, readonly BrowserCustodyConditionalKeysetRow[]>,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
): {
  readonly asset: BrowserEncryptedWalletBackupV2EvictedAssetMonitoringIdentity;
  readonly proofKeys: readonly string[];
} | null {
  if (desired.unit !== "sat" && desired.unit !== "msat") return null;
  if (desired.assetIdentity === "cashu:ordinary") {
    const asset = { kind: "ordinary", mintUrl: desired.mintUrl, unit: desired.unit } as const;
    return { asset, proofKeys: [monitoringOrdinaryProofKey(desired.scopeId, asset)] };
  }
  const identity = desired.assetIdentity.split(":");
  const [prefix, conditionId, outcomeCollectionId] = identity;
  if (
    identity.length !== 3 ||
    prefix !== "ctf" ||
    conditionId === undefined ||
    outcomeCollectionId === undefined
  ) {
    return null;
  }
  const rows =
    keysetsByIdentity.get(
      monitoringKeysetIdentityKey({
        scopeId: desired.scopeId,
        normalizedMint: desired.mintUrl,
        unit: desired.unit,
        conditionId,
        outcomeCollectionId,
      }),
    ) ?? [];
  if (rows.length < 1 || rows.length > 16) return null;
  const keysets = rows.map(decodeBrowserCustodyConditionalKeysetRow);
  const first = keysets[0]!;
  if (
    keysets.some(
      (keyset) =>
        keyset.scopeId !== desired.scopeId ||
        keyset.normalizedMint !== desired.mintUrl ||
        keyset.unit !== desired.unit ||
        keyset.conditionId !== conditionId ||
        keyset.outcomeCollectionId !== outcomeCollectionId ||
        keyset.outcomeCollection !== first.outcomeCollection,
    )
  ) {
    return null;
  }
  const asset = {
    kind: "conditional" as const,
    mintUrl: desired.mintUrl,
    unit: desired.unit as "sat" | "msat",
    conditionId,
    outcomeCollection: first.outcomeCollection,
  };
  return {
    asset,
    proofKeys: keysets.map((keyset) => monitoringConditionalProofKey(desired.scopeId, keyset)),
  };
}

function monitoringOrdinaryProofKey(
  scopeId: string,
  asset: Extract<
    BrowserEncryptedWalletBackupV2EvictedAssetMonitoringIdentity,
    { kind: "ordinary" }
  >,
): string {
  return `${scopeId}\u0000${asset.mintUrl}\u0000${asset.unit}\u0000regular`;
}

function monitoringConditionalProofKey(
  scopeId: string,
  keyset: BrowserCustodyConditionalKeysetRow,
): string {
  return `${scopeId}\u0000${keyset.normalizedMint}\u0000${keyset.unit}\u0000conditional\u0000${keyset.keysetId}`;
}

function monitoringProofKey(value: BrowserCustodyProofRow): string {
  return value.assetKind === "regular"
    ? `${value.scopeId}\u0000${value.normalizedMint}\u0000${value.unit}\u0000regular`
    : `${value.scopeId}\u0000${value.normalizedMint}\u0000${value.unit}\u0000conditional\u0000${value.keysetId}`;
}

function groupRows<T>(
  rows: readonly T[],
  key: (row: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const rowsForKey = groups.get(key(row));
    if (rowsForKey) rowsForKey.push(row);
    else groups.set(key(row), [row]);
  }
  return groups;
}

function monitoringDesiredKey(localAssetKey: string, custodyRevision: string): string {
  return `${localAssetKey}\u0000${custodyRevision}`;
}

function monitoringAuthorityKey(value: {
  readonly scopeId: string;
  readonly realm: string;
  readonly walletId: string;
  readonly enrollmentEpoch: number;
}): string {
  return `${value.scopeId}\u0000${value.realm}\u0000${value.walletId}\u0000${value.enrollmentEpoch}`;
}

function monitoringKeysetIdentityKey(value: {
  readonly scopeId: string;
  readonly normalizedMint: string;
  readonly unit: string;
  readonly conditionId: string;
  readonly outcomeCollectionId: string;
}): string {
  return `${value.scopeId}\u0000${value.normalizedMint}\u0000${value.unit}\u0000${value.conditionId}\u0000${value.outcomeCollectionId}`;
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
      const walletLocks = await readWalletLocks(input.database, input.scopeId);
      // The profile lock always precedes sorted wallet locks. The backup driver never takes a profile lock.
      await withWalletLocks(walletLocks, input.lockManager, async () => {
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

async function readWalletLocks(database: BitcasterDB, scopeId: string): Promise<readonly string[]> {
  const heads = await database.encryptedWalletBackupV2AcceptedHeads
    .where("[scopeId+realm+walletId+enrollmentEpoch]")
    .between(
      [scopeId, TEXT_KEY_MIN, TEXT_KEY_MIN, 0],
      [scopeId, TEXT_KEY_MAX, TEXT_KEY_MAX, NUMBER_KEY_MAX],
    )
    .limit(DESIRED_ASSET_MAX + 1)
    .toArray();
  if (heads.length > DESIRED_ASSET_MAX) throw new Error("browser V2 wallet lock limit exceeded");
  return Object.freeze(
    [
      ...new Set(
        heads.map(({ realm, walletId }) =>
          encryptedWalletBackupV2WalletLockName({ realm, walletId }),
        ),
      ),
    ].sort((left, right) => left.localeCompare(right)),
  );
}

async function withWalletLocks<T>(
  lockNames: readonly string[],
  lockManager: Pick<LockManager, "request"> | undefined,
  action: () => Promise<T>,
): Promise<T> {
  if (lockNames.length === 0) return action();
  if (!lockManager) throw new Error("This browser cannot safely lock the wallet profile");
  const [lockName, ...remaining] = lockNames;
  return lockManager.request(lockName!, { mode: "exclusive" }, () =>
    withWalletLocks(remaining, lockManager, action),
  );
}

async function requireNoActiveLocalWork(database: BitcasterDB, scopeId: string): Promise<void> {
  const [activeWork, preparedOperation, activeRanges, preparedMutation, outgoingAuthority] =
    await Promise.all([
      database.custodyActiveWork
        .where("[scopeId+operationId]")
        .between([scopeId, TEXT_KEY_MIN], [scopeId, TEXT_KEY_MAX])
        .limit(1)
        .first(),
      database.proofOperations.where("state").equals("prepared").limit(1).first(),
      pageActiveCtfRangePreparations({ scopeId, limit: 1 }, database),
      database.encryptedWalletBackupV2PreparedMutations
        .where("[scopeId+realm+walletId+enrollmentEpoch]")
        .between(
          [scopeId, TEXT_KEY_MIN, TEXT_KEY_MIN, 0],
          [scopeId, TEXT_KEY_MAX, TEXT_KEY_MAX, NUMBER_KEY_MAX],
        )
        .limit(1)
        .first(),
      database.outgoingCashuTransfers
        .where("[scopeId+localAuthorityState+transferId]")
        .between([scopeId, "nonterminal", TEXT_KEY_MIN], [scopeId, "nonterminal", TEXT_KEY_MAX])
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
  if (outgoingAuthority !== undefined) {
    throw new Error("browser V2 seed handoff has nonterminal outgoing Cashu authority");
  }
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

async function exactLocalProofs(
  database: BitcasterDB,
  scopeId: string,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
) {
  return readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
    database,
    scopeId,
    asset: {
      mintUrl: desired.mintUrl,
      unit: desired.unit,
      assetIdentity: desired.assetIdentity,
    },
  });
}

function safeDeclaredAmount(value: bigint): number | null {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

async function requireBackupCoverage(
  database: BitcasterDB,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
): Promise<{
  readonly receipt: EncryptedWalletBackupV2AssetReceiptRow;
  readonly descriptor: EncryptedWalletBackupV2BundleDescriptor;
}> {
  const receipts = await database.encryptedWalletBackupV2AssetReceipts
    .where("[scopeId+realm+walletId+enrollmentEpoch]")
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
  const descriptor = requireReceiptDescriptorBinding(receipt, desired);
  const head = await database.encryptedWalletBackupV2AcceptedHeads.get([
    desired.scopeId,
    receipt.realm,
    receipt.walletId,
    receipt.enrollmentEpoch,
  ]);
  if (head === undefined) throw new Error("browser V2 accepted head is absent");
  const decodedHead = decodeCurrentHeadForReceipt(head, desired, receipt);
  await requireCurrentDescriptorAuthority(database, desired, decodedHead, descriptor);
  return { receipt, descriptor };
}

function requireReceiptDescriptorBinding(
  receipt: EncryptedWalletBackupV2AssetReceiptRow,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
): EncryptedWalletBackupV2BundleDescriptor {
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
    mutation.walletId !== receipt.walletId ||
    mutation.enrollmentEpoch !== receipt.enrollmentEpoch ||
    mutation.addedBundle === null ||
    mutation.addedBundle.bundleId !== receipt.bundleId ||
    mutation.addedBundle.assetLocator !== receipt.assetLocator ||
    mutation.addedBundle.custodyRevision.toString() !== receipt.custodyRevision ||
    signedReceipt.realm !== receipt.realm ||
    signedReceipt.walletId !== receipt.walletId ||
    signedReceipt.enrollmentEpoch !== receipt.enrollmentEpoch ||
    signedReceipt.mutationId !== mutation.mutationId ||
    signedReceipt.requestDigest !== signedMutation.requestDigest ||
    signedReceipt.bundleId !== receipt.bundleId ||
    signedReceipt.bundleDescriptorDigest !== receipt.bundleDescriptorDigest ||
    signedReceipt.resultHead.realm !== receipt.realm ||
    signedReceipt.resultHead.walletId !== receipt.walletId ||
    signedReceipt.resultHead.enrollmentEpoch !== receipt.enrollmentEpoch
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
  return descriptor;
}

function decodeCurrentHeadForReceipt(
  head: EncryptedWalletBackupV2AcceptedHeadRow,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  receipt: Pick<EncryptedWalletBackupV2AssetReceiptRow, "realm" | "walletId" | "enrollmentEpoch">,
): ReturnType<typeof decodeEncryptedWalletBackupV2CurrentHead> {
  if (
    head.scopeId !== desired.scopeId ||
    head.realm !== receipt.realm ||
    head.walletId !== receipt.walletId ||
    head.enrollmentEpoch !== receipt.enrollmentEpoch
  ) {
    throw new Error("browser V2 accepted head is foreign");
  }
  const decodedHead = decodeEncryptedWalletBackupV2CurrentHead({
    formatVersion: 2,
    realm: head.realm,
    walletId: head.walletId,
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
  return decodedHead;
}

async function requireCurrentDescriptorAuthority(
  database: BitcasterDB,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  head: ReturnType<typeof decodeEncryptedWalletBackupV2CurrentHead>,
  receiptDescriptor: EncryptedWalletBackupV2BundleDescriptor,
): Promise<void> {
  const rows = await database.encryptedWalletBackupV2ActiveDescriptors
    .where("[scopeId+realm+walletId+enrollmentEpoch]")
    .equals([desired.scopeId, head.realm, head.walletId, head.enrollmentEpoch])
    .limit(DESIRED_ASSET_MAX + 1)
    .toArray();
  const descriptorDigests = requireCurrentDescriptorAuthorityFromRows(desired, head, rows);
  if (!descriptorDigests.has(monitoringDescriptorKey(receiptDescriptor))) {
    throw new Error("browser V2 accepted head is stale");
  }
}

function requireCurrentDescriptorAuthorityFromRows(
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  head: ReturnType<typeof decodeEncryptedWalletBackupV2CurrentHead>,
  rows: readonly EncryptedWalletBackupV2ActiveDescriptorRow[],
): ReadonlySet<string> {
  if (rows.length !== head.activeBundleCount || rows.length > DESIRED_ASSET_MAX) {
    throw new Error("browser V2 accepted head is stale");
  }
  const descriptors = rows.map((row) => {
    const descriptor = decodeEncryptedWalletBackupV2BundleDescriptorWire(row.canonicalDescriptor, {
      realm: head.realm,
      walletId: head.walletId,
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
    !sameBytes(
      encodeEncryptedWalletBackupV2CurrentHead(
        createEncryptedWalletBackupV2CurrentHead({
          realm: head.realm,
          walletId: head.walletId,
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
  return new Set(descriptors.map(monitoringDescriptorKey));
}

function monitoringDescriptorKey(descriptor: EncryptedWalletBackupV2BundleDescriptor): string {
  return `${descriptor.bundleId}\u0000${digestEncryptedWalletBackupV2BundleDescriptor(descriptor)}`;
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
