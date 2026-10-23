import {
  decodeEncryptedWalletBackupOwnerUploadGroup,
  encodeEncryptedWalletBackupOwnerUploadGroup,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerUpload";
import { prepareEncryptedWalletBackupOwnerBundleSupersessionMutation } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerMutation";
import type { EncryptedWalletBackupOwnerCandidate } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerDiscovery";
import type { EncryptedWalletBackupOwnerCollectedHeadEvidence } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import type { EncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerReceipt";
import {
  deriveEncryptedWalletBackupV2AssetLocator,
  type EncryptedWalletBackupV2BundleRuntime,
  type EncryptedWalletBackupV2KeyHandle,
  type EncryptedWalletBackupV2PreparedTransportBundle,
} from "@bitcaster/client-sdk";
import Dexie from "dexie";
import { BrowserEncryptedWalletBackupV2TerminalSealStore } from "../stores/browser-encrypted-wallet-backup-v2-terminal-seal-store";
import {
  prepareBrowserEncryptedWalletBackupV2AssetBundle,
  readBrowserEncryptedWalletBackupV2AssetSnapshot,
  type BrowserEncryptedWalletBackupV2AssetSnapshot,
} from "../stores/browser-encrypted-wallet-backup-v2-asset-source";
import { decodeEncryptedWalletBackupV2DesiredAssetRow } from "../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import type { BitcasterDB } from "../stores/proof-db";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "../stores/encrypted-wallet-backup-owner-db";
import type { EncryptedWalletBackupV2PreparedDesiredBinding } from "../stores/encrypted-wallet-backup-v2-db";

export interface BrowserEncryptedWalletBackupOwnerRemotePort {
  readCurrentHead(input: {
    readonly owner: EncryptedWalletBackupOwnerCandidate;
    readonly enrollmentEpoch: number;
    readonly signal: AbortSignal;
  }): Promise<EncryptedWalletBackupOwnerCollectedHeadEvidence>;
  mutateHead(input: {
    readonly owner: EncryptedWalletBackupOwnerCandidate;
    readonly enrollmentEpoch: number;
    readonly mutationEvidence: unknown;
    readonly canonicalUploadGroup: Uint8Array;
    readonly signal: AbortSignal;
  }): Promise<EncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt>;
}

export interface BrowserEncryptedWalletBackupOwnerWorkerInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly seed: Uint8Array;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly owner: EncryptedWalletBackupOwnerCandidate;
  readonly enrollmentEpoch: number;
  readonly remote: BrowserEncryptedWalletBackupOwnerRemotePort;
  readonly runtime: EncryptedWalletBackupV2BundleRuntime;
  readonly signal: AbortSignal;
  readonly isCurrentProfile: () => boolean;
  /** Resume the bounded desired-asset scan after this local key. */
  readonly afterLocalAssetKey?: string;
  /** Test and caller scheduling control. The worker always caps this at 64. */
  readonly desiredAssetScanPageSize?: number;
  readonly assetSource?: {
    readonly read: typeof readBrowserEncryptedWalletBackupV2AssetSnapshot;
    readonly prepare: (
      snapshot: BrowserEncryptedWalletBackupV2AssetSnapshot,
    ) => Promise<EncryptedWalletBackupV2PreparedTransportBundle>;
  };
}

export type BrowserEncryptedWalletBackupOwnerWorkerResult =
  | { readonly kind: "idle" }
  | { readonly kind: "head-accepted" }
  | { readonly kind: "committed" }
  | { readonly kind: "stale-desired" }
  | { readonly kind: "recovery-required" }
  | { readonly kind: "service-quota-pending" }
  | { readonly kind: "scan-more"; readonly afterLocalAssetKey: string };

const desiredAssetScanPageSize = 64;

/** Runs one selected-owner transition. It never consults the active account signer. */
export async function runBrowserEncryptedWalletBackupOwnerWorkerCycle(
  input: BrowserEncryptedWalletBackupOwnerWorkerInput,
): Promise<BrowserEncryptedWalletBackupOwnerWorkerResult> {
  requireCurrent(input);
  const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database: input.database,
    scopeId: input.scopeId,
    ownerScopeId: input.owner.ownerScopeId,
    realm: input.keyHandle.realm,
    walletId: input.keyHandle.walletId,
    requestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
    enrollmentEpoch: input.enrollmentEpoch,
    isCurrent: () => isCurrent(input),
  });
  const prepared = await store.readPreparedMutation();
  requireCurrent(input);
  if (prepared !== null) {
    const expectedHeadEvidence = await store.readCurrentHead();
    requireCurrent(input);
    if (expectedHeadEvidence === null) throw new Error("owner prepared mutation head is missing");
    return sendPrepared(input, store, prepared, expectedHeadEvidence);
  }

  const remoteHead = await input.remote.readCurrentHead({
    owner: input.owner,
    enrollmentEpoch: input.enrollmentEpoch,
    signal: input.signal,
  });
  const acceptedHead = await store.readCurrentHead();
  requireCurrent(input);
  if (acceptedHead === null) {
    if (remoteHead.head.activeBundleCount > 0) {
      await store.markCompetingHeadRecoveryRequired({ evidence: remoteHead });
      requireCurrent(input);
      return { kind: "recovery-required" };
    }
    const outcome = await store.acceptCurrentHead({
      expectedHeadVersion: null,
      evidence: remoteHead,
    });
    return outcome === "accepted" ? { kind: "head-accepted" } : { kind: "recovery-required" };
  }
  if (!sameHead(acceptedHead, remoteHead)) {
    await store.markCompetingHeadRecoveryRequired({ evidence: remoteHead });
    requireCurrent(input);
    return { kind: "recovery-required" };
  }
  const permission = await store.readNewWritePermission();
  requireCurrent(input);
  if (!permission.canWrite) return { kind: "recovery-required" };

  const desiredIndex =
    input.database.encryptedWalletBackupV2DesiredAssets.where("[scopeId+localAssetKey]");
  const desiredRange =
    input.afterLocalAssetKey === undefined
      ? desiredIndex.between([input.scopeId, Dexie.minKey], [input.scopeId, Dexie.maxKey])
      : desiredIndex.between(
          [input.scopeId, input.afterLocalAssetKey],
          [input.scopeId, Dexie.maxKey],
          false,
          false,
        );
  const scanPageSize = input.desiredAssetScanPageSize ?? desiredAssetScanPageSize;
  if (
    !Number.isInteger(scanPageSize) ||
    scanPageSize < 1 ||
    scanPageSize > desiredAssetScanPageSize
  )
    throw new Error("owner desired asset scan page size is invalid");
  const localRows = await desiredRange.limit(scanPageSize + 1).toArray();
  requireCurrent(input);
  const hasMore = localRows.length > scanPageSize;
  for (const raw of localRows.slice(0, scanPageSize)) {
    const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
    const assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
      keyHandle: input.keyHandle,
      mintUrl: desired.mintUrl,
      unit: desired.unit,
      assetIdentity: desired.assetIdentity,
    });
    requireCurrent(input);
    const binding: EncryptedWalletBackupV2PreparedDesiredBinding = {
      localAssetKey: desired.localAssetKey,
      assetLocator,
      custodyRevision: desired.custodyRevision,
      desiredAction: desired.desiredAction,
      activeProofCount: desired.activeProofCount,
    };
    if (await store.isDesiredAssetSynchronized(binding)) continue;
    requireCurrent(input);
    const existing = remoteHead.bundles.filter((bundle) => bundle.assetLocator === assetLocator);
    if (existing.length > 1) return { kind: "recovery-required" };
    let preparedBundle: EncryptedWalletBackupV2PreparedTransportBundle | null = null;
    if (desired.desiredAction === "replace") {
      if (existing.length === 0 && remoteHead.head.activeBundleCount >= 256)
        return { kind: "service-quota-pending" };
      const source = input.assetSource ?? defaultAssetSource(input);
      const snapshot = await source.read({
        database: input.database,
        scopeId: input.scopeId,
        localAssetKey: desired.localAssetKey,
      });
      requireCurrent(input);
      if (
        snapshot.desired.localAssetKey !== desired.localAssetKey ||
        snapshot.desired.custodyRevision !== desired.custodyRevision ||
        snapshot.desired.desiredAction !== desired.desiredAction ||
        snapshot.desired.activeProofCount !== desired.activeProofCount
      )
        return { kind: "stale-desired" };
      preparedBundle = await source.prepare(snapshot);
      requireCurrent(input);
    } else if (existing.length === 0) {
      const recorded = await store.recordAlreadyAbsentDesired(binding);
      requireCurrent(input);
      if (recorded === "stale-desired") return { kind: "stale-desired" };
      continue;
    }
    const envelope = await prepareEncryptedWalletBackupOwnerBundleSupersessionMutation({
      keyHandle: input.keyHandle,
      expectedContext: {
        ownerScopeId: input.owner.ownerScopeId,
        realm: input.keyHandle.realm,
        walletId: input.keyHandle.walletId,
        enrollmentEpoch: input.enrollmentEpoch,
      },
      expectedHeadEvidence: remoteHead,
      addedBundle: preparedBundle?.descriptor ?? null,
      supersededBundleIds: existing.map(({ bundleId }) => bundleId),
      runtime: input.runtime,
    });
    const canonicalUploadGroup = encodeEncryptedWalletBackupOwnerUploadGroup({
      envelope,
      objects: preparedBundle?.objects ?? [],
    });
    requireCurrent(input);
    const inserted = await store.insertPreparedMutationForDesired({
      prepared: {
        mutationId: envelope.mutation.mutationId,
        requestDigest: envelope.requestDigest,
        canonicalUploadGroup,
        createdAtUnixMilliseconds: Date.now(),
        ...binding,
      },
      desired: binding,
    });
    requireCurrent(input);
    if (inserted === "stale-desired") return { kind: "stale-desired" };
    if (inserted === "owner-current") return { kind: "idle" };
    const stored = await store.readPreparedMutation();
    requireCurrent(input);
    if (stored === null) throw new Error("owner prepared mutation was not persisted");
    const expected = await store.readCurrentHead();
    requireCurrent(input);
    if (expected === null) throw new Error("owner prepared mutation head is missing");
    return sendPrepared(input, store, stored, expected);
  }
  if (hasMore) {
    const last = localRows[scanPageSize - 1];
    if (last === undefined) throw new Error("owner desired asset scan cursor is absent");
    const decoded = decodeEncryptedWalletBackupV2DesiredAssetRow(last);
    return { kind: "scan-more", afterLocalAssetKey: decoded.localAssetKey };
  }
  return { kind: "idle" };
}

async function sendPrepared(
  input: BrowserEncryptedWalletBackupOwnerWorkerInput,
  store: EncryptedWalletBackupOwnerDexieAuthorityStore,
  prepared: Awaited<ReturnType<typeof store.readPreparedMutation>> & {},
  expectedHeadEvidence: EncryptedWalletBackupOwnerCollectedHeadEvidence,
): Promise<BrowserEncryptedWalletBackupOwnerWorkerResult> {
  const current = requirePrepared(prepared);
  const group = decodeEncryptedWalletBackupOwnerUploadGroup({
    bytes: current.canonicalUploadGroup,
    expectedContext: {
      ownerScopeId: input.owner.ownerScopeId,
      realm: input.keyHandle.realm,
      walletId: input.keyHandle.walletId,
      enrollmentEpoch: input.enrollmentEpoch,
    },
    expectedRequestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
  });
  const receiptEvidence = await input.remote.mutateHead({
    owner: input.owner,
    enrollmentEpoch: input.enrollmentEpoch,
    mutationEvidence: group.mutationEvidence,
    canonicalUploadGroup: current.canonicalUploadGroup,
    signal: input.signal,
  });
  requireCurrent(input);
  const result = await store.commitVerifiedMutationResult({
    preparedMutation: { mutationId: current.mutationId, requestDigest: current.requestDigest },
    canonicalUploadGroup: current.canonicalUploadGroup,
    expectedHeadEvidence,
    receiptEvidence,
    desired: {
      localAssetKey: current.localAssetKey,
      assetLocator: current.assetLocator,
      custodyRevision: current.custodyRevision,
      desiredAction: current.desiredAction,
      activeProofCount: current.activeProofCount,
    },
  });
  requireCurrent(input);
  return result === "committed" ? { kind: "committed" } : { kind: "stale-desired" };
}

function defaultAssetSource(input: BrowserEncryptedWalletBackupOwnerWorkerInput) {
  const terminalSealStore = new BrowserEncryptedWalletBackupV2TerminalSealStore({
    database: input.database,
    scopeId: input.scopeId,
  });
  return {
    read: readBrowserEncryptedWalletBackupV2AssetSnapshot,
    prepare: (snapshot: BrowserEncryptedWalletBackupV2AssetSnapshot) =>
      prepareBrowserEncryptedWalletBackupV2AssetBundle({
        snapshot,
        keyHandle: input.keyHandle,
        seed: input.seed,
        runtime: input.runtime,
        terminalSealStore,
      }),
  };
}

function requirePrepared<T>(value: T | null): NonNullable<T> {
  if (value == null) throw new Error("owner prepared mutation is absent");
  return value as NonNullable<T>;
}

function sameHead(
  left: EncryptedWalletBackupOwnerCollectedHeadEvidence,
  right: EncryptedWalletBackupOwnerCollectedHeadEvidence,
): boolean {
  return (
    left.head.ownerScopeId === right.head.ownerScopeId &&
    left.head.realm === right.head.realm &&
    left.head.walletId === right.head.walletId &&
    left.head.enrollmentEpoch === right.head.enrollmentEpoch &&
    left.head.headVersion === right.head.headVersion &&
    left.head.activeSetDigest === right.head.activeSetDigest
  );
}

function isCurrent(input: BrowserEncryptedWalletBackupOwnerWorkerInput): boolean {
  return !input.signal.aborted && input.isCurrentProfile();
}

function requireCurrent(input: BrowserEncryptedWalletBackupOwnerWorkerInput): void {
  if (!isCurrent(input)) throw new Error("browser owner backup worker profile is stale");
}
