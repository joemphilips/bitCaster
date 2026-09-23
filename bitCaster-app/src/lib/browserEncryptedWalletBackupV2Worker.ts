import {
  applyEncryptedWalletBackupV2VerifiedReceipt,
  authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse,
  collectAllEncryptedWalletBackupV2DescriptorPages,
  decodeEncryptedWalletBackupV2UploadGroup,
  createEncryptedWalletBackupV2CurrentHead,
  decryptEncryptedWalletBackupV2ProofSetBundle,
  deriveEncryptedWalletBackupV2AssetLocator,
  digestEncryptedWalletBackupV2BundleDescriptor,
  decodeEncryptedWalletBackupV2BundleDescriptorWire,
  encodeEncryptedWalletBackupV2BundleSupersessionReceipt,
  encodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire,
  encodeEncryptedWalletBackupV2UploadGroup,
  ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX,
  prepareEncryptedWalletBackupV2AssetMutation,
  prepareEncryptedWalletBackupV2RequestProof,
  verifyEncryptedWalletBackupV2BundleSupersessionReceipt,
  collectEncryptedWalletBackupV2DescriptorPages,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  type EncryptedWalletBackupV2BundleRuntime,
  type EncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2CollectedHeadEvidence,
  type EncryptedWalletBackupV2AssetIdentity,
  type EncryptedWalletBackupV2KeyHandle,
  type EncryptedWalletBackupV2RemotePort,
} from "@bitcaster/client-sdk";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import { serializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import Dexie from "dexie";
import { EncryptedWalletBackupV2HttpTransportError } from "@bitcaster/client-sdk/encryptedWalletBackupV2HttpAdapter";
import {
  EncryptedWalletBackupV2DexieAuthorityStore,
  type EncryptedWalletBackupV2PreparedMutationMatch,
} from "../stores/encrypted-wallet-backup-v2-db";
import {
  prepareBrowserEncryptedWalletBackupV2AssetBundle,
  readBrowserEncryptedWalletBackupV2ExactLocalProofRows,
  readBrowserEncryptedWalletBackupV2AssetSnapshot,
} from "../stores/browser-encrypted-wallet-backup-v2-asset-source";
import { BrowserEncryptedWalletBackupV2TerminalSealStore } from "../stores/browser-encrypted-wallet-backup-v2-terminal-seal-store";
import { decodeEncryptedWalletBackupV2DesiredAssetRow } from "../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import type { BitcasterDB } from "../stores/proof-db";
import {
  cancelDefinitivelyRejectedBrowserCtfRemove,
  finalizeBrowserCtfRemove,
} from "./browserCtfRemoveCoordinator";

export type BrowserEncryptedWalletBackupV2WorkerResult =
  | { readonly kind: "idle" }
  | { readonly kind: "head-accepted" }
  | { readonly kind: "committed" }
  | { readonly kind: "conflict-recovered" }
  | { readonly kind: "retry-pending"; readonly minimumRetryDelayMilliseconds: number }
  | { readonly kind: "service-quota-pending" };

export interface BrowserEncryptedWalletBackupV2WorkerInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly seed: Uint8Array;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly enrollmentEpoch: number;
  readonly pinnedReceiptKeys: readonly { readonly keyId: string; readonly publicKey: string }[];
  readonly remote: EncryptedWalletBackupV2RemotePort;
  readonly requestUrl: (kind: "head" | "mutation" | "object", value: string | null) => string;
  /** Signed HTTPS origin used for SDK-authenticated remote seal reuse. */
  readonly remoteOrigin?: string;
  readonly nowUnixSeconds: () => number;
  readonly runtime: EncryptedWalletBackupV2BundleRuntime;
  readonly signal: AbortSignal;
  readonly isCurrentProfile: () => boolean;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly assetSource?: {
    readonly read: typeof readBrowserEncryptedWalletBackupV2AssetSnapshot;
    readonly prepare: typeof prepareBrowserEncryptedWalletBackupV2AssetBundle;
  };
}

/** Runs one unmounted V2 synchronization transition. It never starts a timer. */
export async function runBrowserEncryptedWalletBackupV2WorkerCycle(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
): Promise<BrowserEncryptedWalletBackupV2WorkerResult> {
  requireCurrent(input);
  const store = authority(input);
  const prepared = await store.readPreparedMutation();
  if (prepared !== null)
    return sendPrepared(
      input,
      store,
      prepared.canonicalUploadGroup,
      prepared.mutationId,
      prepared.requestDigest,
      preparedBinding(prepared),
    );
  const accepted = await store.readAcceptedHead();
  if (accepted === null) {
    const evidence = await collectHead(input);
    requireCurrent(input);
    if (evidence.bundles.length > 0) {
      await refuseCompetingHead(input, store, evidence);
      return { kind: "conflict-recovered" };
    }
    await store.acceptCompetingHead({
      collectedHeadEvidence: evidence,
      stalePreparedMutation: emptyMatch(),
    });
    return { kind: "head-accepted" };
  }
  const head = await collectedHead(store);
  const current = await collectHead(input);
  requireCurrent(input);
  if (!sameCollectedHead(current, head)) {
    await refuseCompetingHead(input, store, current);
    return { kind: "conflict-recovered" };
  }
  const permission = await store.readNewWritePermission();
  if (!permission.canWrite) return { kind: "conflict-recovered" };
  const selected = await selectPendingAsset(input, store, head);
  if (selected === null) return { kind: "idle" };
  if (selected === "locally-committed") return { kind: "committed" };
  if (selected === "recovery-required") return { kind: "conflict-recovered" };
  if (selected === "service-quota-pending") return { kind: "service-quota-pending" };
  const nextHead = await collectedHead(store);
  const next = await prepareSelectedMutation(input, store, nextHead, selected);
  if ("kind" in next) {
    if (next.kind === "recovery-required") return { kind: "conflict-recovered" };
    if (next.kind === "stale-work")
      return { kind: "retry-pending", minimumRetryDelayMilliseconds: 5_000 };
  }
  return sendPrepared(input, store, next.bytes, next.mutationId, next.requestDigest, next.binding);
}

async function prepareSelectedMutation(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  head: Awaited<ReturnType<typeof collectedHead>>,
  selected: Exclude<Awaited<ReturnType<typeof selectPendingAsset>>, null | string>,
) {
  const { desired, assetLocator } = selected;
  const preparedBundle = await prepareAssetBundle(input, store, head, desired, assetLocator);
  if ("kind" in preparedBundle) {
    if (preparedBundle.kind === "recovery-required") return preparedBundle;
    if (preparedBundle.kind === "stale-work") return preparedBundle;
  }
  const bundle = preparedBundle.bundle?.descriptor ?? null;
  const envelope = await prepareEncryptedWalletBackupV2AssetMutation({
    keyHandle: input.keyHandle,
    expectedHeadEvidence: preparedBundle.headEvidence,
    assetLocator,
    desiredAction: desired.desiredAction,
    addedBundle: bundle,
    runtime: input.runtime,
  });
  const objects = preparedBundle.bundle?.objects ?? [];
  const bytes = encodeEncryptedWalletBackupV2UploadGroup({ envelope, objects });
  requireCurrent(input);
  const binding = bindingFor(desired, assetLocator, bundle);
  const persisted = await store.insertPreparedMutationForDesired({
    prepared: {
      mutationId: envelope.mutation.mutationId,
      requestDigest: envelope.requestDigest,
      canonicalUploadGroup: bytes,
      createdAtUnixMilliseconds: input.nowUnixSeconds() * 1000,
      ...binding,
    },
    desired: binding,
  });
  if (persisted === "stale-desired") return { kind: "stale-work" } as const;
  return {
    bytes,
    mutationId: envelope.mutation.mutationId,
    requestDigest: envelope.requestDigest,
    binding,
  } as const;
}

async function prepareAssetBundle(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  head: Awaited<ReturnType<typeof collectedHead>>,
  desired: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>,
  assetLocator: string,
) {
  if (desired.desiredAction === "remove") return { bundle: null, headEvidence: head } as const;
  const source = input.assetSource ?? defaultAssetSource;
  const snapshot = await source.read({
    database: input.database,
    scopeId: input.scopeId,
    localAssetKey: desired.localAssetKey,
  });
  if (
    snapshot.desired.syncState !== "pending" ||
    snapshot.desired.localAssetKey !== desired.localAssetKey ||
    snapshot.desired.custodyRevision !== desired.custodyRevision ||
    snapshot.desired.desiredAction !== desired.desiredAction ||
    snapshot.desired.activeProofCount !== desired.activeProofCount
  )
    return { kind: "stale-work" } as const;
  const remoteLosers = snapshot.losingProofs.filter(({ origin }) => origin.kind === "remote-seal");
  let remoteTerminalSealReuse;
  if (remoteLosers.length > 0) {
    const currentHead = await collectHead(input);
    requireCurrent(input);
    if (!sameCollectedHead(currentHead, head)) {
      await refuseCompetingHead(input, store, currentHead);
      return { kind: "recovery-required" } as const;
    }
    const predecessor = currentHead.bundles.find(
      ({ assetLocator: candidate }) => candidate === assetLocator,
    );
    if (predecessor === undefined)
      throw new Error("browser V2 remote terminal predecessor bundle is missing");
    if (input.remoteOrigin === undefined)
      throw new Error("browser V2 remote terminal reuse origin is missing");
    try {
      remoteTerminalSealReuse = await authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse({
        keyHandle: input.keyHandle,
        seed: input.seed,
        expectedAsset: snapshot.asset,
        custodyRevision: predecessor.custodyRevision,
        expectedEnrollmentEpoch: input.enrollmentEpoch,
        remote: input.remote,
        remoteRequest: {
          origin: input.remoteOrigin,
          issuedAtUnixSeconds: input.nowUnixSeconds(),
          expiresAtUnixSeconds: input.nowUnixSeconds() + 60,
          signal: input.signal,
          runtime: input.runtime,
        },
        runtime: input.runtime,
      });
    } catch (error) {
      await reconcileIfHeadChanged(input, store, head);
      throw error;
    }
    requireCurrent(input);
    if (!sameCollectedHead(remoteTerminalSealReuse.currentHeadEvidence, head)) {
      await refuseCompetingHead(input, store, remoteTerminalSealReuse.currentHeadEvidence);
      return { kind: "recovery-required" } as const;
    }
  }
  const bundle = await source.prepare({
    snapshot,
    keyHandle: input.keyHandle,
    seed: input.seed,
    runtime: input.runtime,
    terminalSealStore: new BrowserEncryptedWalletBackupV2TerminalSealStore({
      database: input.database,
      scopeId: input.scopeId,
    }),
    bundleIdExists: (id) => head.bundles.some((item) => item.bundleId === id),
    remoteTerminalSealReuse,
  });
  return {
    bundle,
    headEvidence: remoteTerminalSealReuse?.currentHeadEvidence ?? head,
  } as const;
}

async function refuseCompetingHead(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  evidence: EncryptedWalletBackupV2CollectedHeadEvidence,
): Promise<void> {
  requireCurrent(input);
  await store.markCompetingHeadRecoveryRequired({
    collectedHeadEvidence: evidence,
  });
}

async function reconcileIfHeadChanged(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  accepted: EncryptedWalletBackupV2CollectedHeadEvidence,
): Promise<void> {
  let current: EncryptedWalletBackupV2CollectedHeadEvidence;
  try {
    current = await collectHead(input);
  } catch {
    // Preserve the original remote seal or transport refusal.
    return;
  }
  if (!sameCollectedHead(current, accepted)) await refuseCompetingHead(input, store, current);
}

function sameCollectedHead(
  left: EncryptedWalletBackupV2CollectedHeadEvidence,
  right: EncryptedWalletBackupV2CollectedHeadEvidence,
): boolean {
  if (
    left.head.formatVersion !== right.head.formatVersion ||
    left.head.realm !== right.head.realm ||
    left.head.walletId !== right.head.walletId ||
    left.head.enrollmentEpoch !== right.head.enrollmentEpoch ||
    left.head.headVersion !== right.head.headVersion ||
    left.head.activeBundleCount !== right.head.activeBundleCount ||
    left.head.activeObjectCount !== right.head.activeObjectCount ||
    left.head.activeSetDigest !== right.head.activeSetDigest ||
    left.bundles.length !== right.bundles.length
  )
    return false;
  const rightBundles = new Map(
    right.bundles.map((bundle) => [
      bundle.bundleId,
      digestEncryptedWalletBackupV2BundleDescriptor(bundle),
    ]),
  );
  return left.bundles.every(
    (bundle) =>
      rightBundles.get(bundle.bundleId) === digestEncryptedWalletBackupV2BundleDescriptor(bundle),
  );
}

function bindingFor(
  desired: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>,
  assetLocator: string,
  bundle: EncryptedWalletBackupV2BundleDescriptor | null,
): PreparedBinding {
  return {
    localAssetKey: desired.localAssetKey,
    assetLocator,
    custodyRevision: desired.custodyRevision,
    desiredAction: desired.desiredAction,
    activeProofCount: desired.activeProofCount,
    bundleId: bundle?.bundleId ?? null,
    bundleDescriptorDigest:
      bundle === null ? null : digestEncryptedWalletBackupV2BundleDescriptor(bundle),
  };
}

type PreparedBinding = {
  readonly localAssetKey: string;
  readonly assetLocator: string;
  readonly custodyRevision: string;
  readonly desiredAction: "replace" | "remove";
  readonly activeProofCount: number;
  readonly bundleId: string | null;
  readonly bundleDescriptorDigest: string | null;
};
async function sendPrepared(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  bytes: Uint8Array,
  mutationId: string,
  requestDigest: string,
  binding: PreparedBinding,
): Promise<BrowserEncryptedWalletBackupV2WorkerResult> {
  const group = decodeEncryptedWalletBackupV2UploadGroup({
    bytes,
    expectedRequestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
    expectedContext: {
      realm: input.keyHandle.realm,
      walletId: input.keyHandle.walletId,
      enrollmentEpoch: input.enrollmentEpoch,
    },
  });
  const added = group.mutationEvidence.envelope.mutation.addedBundle;
  const exactBinding = {
    ...binding,
    bundleId: added?.bundleId ?? null,
    bundleDescriptorDigest:
      added === null ? null : digestEncryptedWalletBackupV2BundleDescriptor(added),
  };
  requireCurrent(input);
  try {
    await sendAndCommit(input, store, bytes, { mutationId, requestDigest }, exactBinding, group);
    return { kind: "committed" } as const;
  } catch (error) {
    return recoverTransportError(
      input,
      store,
      { mutationId, requestDigest },
      exactBinding,
      group,
      error,
    );
  }
}

async function sendAndCommit(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  bytes: Uint8Array,
  preparedMutation: EncryptedWalletBackupV2PreparedMutationMatch,
  binding: PreparedBinding,
  group: ReturnType<typeof decodeEncryptedWalletBackupV2UploadGroup>,
): Promise<void> {
  const requestProof = await proof(input, "mutation", null, bytes);
  requireCurrent(input);
  const receipt = await input.remote.mutateHeadOnce({
    requestProof,
    canonicalUploadGroup: bytes,
    signal: input.signal,
  });
  const verified = verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
    receipt,
    mutationEvidence: group.mutationEvidence,
    pinnedSigningKeys: input.pinnedReceiptKeys,
  });
  const evidence = applyEncryptedWalletBackupV2VerifiedReceipt({
    expectedHeadEvidence: await collectedHead(store),
    mutationEvidence: group.mutationEvidence,
    receiptEvidence: verified,
  });
  requireCurrent(input);
  await store.commitVerifiedAssetReceipt({
    binding,
    canonicalSignedMutation: encodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire(
      group.mutationEvidence.envelope,
    ),
    canonicalSignedReceipt: encodeEncryptedWalletBackupV2BundleSupersessionReceipt(receipt),
    verifiedReceipt: verified,
    collectedHeadEvidence: evidence,
    preparedMutation,
    acknowledgedAtMs: input.nowUnixSeconds() * 1000,
  });
  const desired = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    binding.localAssetKey,
  ]);
  if (
    desired !== undefined &&
    decodeEncryptedWalletBackupV2DesiredAssetRow(desired).removalIntent !== null
  ) {
    await finalizeBrowserCtfRemove({
      database: input.database,
      scopeId: input.scopeId,
      keyHandle: input.keyHandle,
      enrollmentEpoch: input.enrollmentEpoch,
      localAssetKey: binding.localAssetKey,
      assetLocator: binding.assetLocator,
      lockManager: input.lockManager,
      isCurrentProfile: input.isCurrentProfile,
      observedAtMs: input.nowUnixSeconds() * 1000,
    });
  }
}

async function recoverTransportError(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  preparedMutation: EncryptedWalletBackupV2PreparedMutationMatch,
  binding: PreparedBinding,
  group: ReturnType<typeof decodeEncryptedWalletBackupV2UploadGroup>,
  error: unknown,
): Promise<BrowserEncryptedWalletBackupV2WorkerResult> {
  if (!(error instanceof EncryptedWalletBackupV2HttpTransportError)) throw error;
  const supportsRemovalReconciliation =
    error.code === "transport-failure" ||
    error.code === "deadline-exceeded" ||
    error.code === "replay-rejected" ||
    error.code === "concurrency-exhausted" ||
    error.code === "unavailable" ||
    error.code === "overloaded" ||
    error.code === "rate-limited" ||
    error.code === "conflict" ||
    error.code === "quota-exceeded";
  const pendingRemoval =
    supportsRemovalReconciliation && (await hasExactPendingRemovalIntent(input, binding));
  let removalReconciliation: LostRemovalReconciliation | null = null;
  if (pendingRemoval && !input.signal.aborted) {
    removalReconciliation = await reconcileLostRemoval(
      input,
      store,
      preparedMutation,
      binding,
      group,
    );
    if (removalReconciliation.kind === "committed") return { kind: "committed" };
  }
  if (pendingRemoval && (error.code === "conflict" || error.code === "quota-exceeded")) {
    if (removalReconciliation?.kind !== "disproved") {
      return {
        kind: "retry-pending",
        minimumRetryDelayMilliseconds: minimumRetryDelayMilliseconds(error),
      };
    }
    requireCurrent(input);
    await store.markCompetingHeadRecoveryRequired({
      collectedHeadEvidence: removalReconciliation.collectedHeadEvidence,
    });
    requireCurrent(input);
    await cancelDefinitivelyRejectedBrowserCtfRemove({
      database: input.database,
      scopeId: input.scopeId,
      keyHandle: input.keyHandle,
      enrollmentEpoch: input.enrollmentEpoch,
      localAssetKey: binding.localAssetKey,
      assetLocator: binding.assetLocator,
      rejectedPreparedMutation: preparedMutation,
      observedAtMs: input.nowUnixSeconds() * 1000,
      lockManager: input.lockManager,
      isCurrentProfile: input.isCurrentProfile,
    });
    return error.code === "conflict"
      ? { kind: "conflict-recovered" }
      : { kind: "service-quota-pending" };
  }
  if (error.code === "conflict" || error.code === "quota-exceeded") {
    const reconciliation = await reconcileRejectedReplacement(
      input,
      store,
      preparedMutation,
      binding,
      group,
    );
    if (reconciliation.kind === "committed") return { kind: "committed" };
    if (reconciliation.kind === "indeterminate") {
      return {
        kind: "retry-pending",
        minimumRetryDelayMilliseconds: minimumRetryDelayMilliseconds(error),
      };
    }
    if (error.code === "conflict") {
      requireCurrent(input);
      await store.markCompetingHeadRecoveryRequired({
        collectedHeadEvidence: reconciliation.collectedHeadEvidence,
      });
    }
    requireCurrent(input);
    await store.discardRejectedPreparedMutation(preparedMutation);
    return error.code === "conflict"
      ? { kind: "conflict-recovered" }
      : { kind: "service-quota-pending" };
  }
  if (
    error.code === "concurrency-exhausted" ||
    error.code === "deadline-exceeded" ||
    error.code === "transport-failure" ||
    error.code === "replay-rejected" ||
    error.code === "rate-limited" ||
    error.code === "overloaded" ||
    error.code === "unavailable"
  )
    return {
      kind: "retry-pending",
      minimumRetryDelayMilliseconds: minimumRetryDelayMilliseconds(error),
    };
  throw error;
}

type LostRemovalReconciliation =
  | { readonly kind: "committed" }
  | {
      readonly kind: "disproved";
      readonly collectedHeadEvidence: EncryptedWalletBackupV2CollectedHeadEvidence;
    }
  | { readonly kind: "indeterminate" };

async function reconcileRejectedReplacement(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  preparedMutation: EncryptedWalletBackupV2PreparedMutationMatch,
  binding: PreparedBinding,
  group: ReturnType<typeof decodeEncryptedWalletBackupV2UploadGroup>,
): Promise<LostRemovalReconciliation> {
  try {
    const predecessor = await collectedHead(store);
    const mutation = group.mutationEvidence.envelope.mutation;
    if (
      mutation.expectedHeadVersion !== predecessor.head.headVersion ||
      mutation.expectedActiveSetDigest !== predecessor.head.activeSetDigest
    )
      return { kind: "indeterminate" };
    const bundles = predecessor.bundles.filter(
      ({ bundleId }) => !mutation.supersededBundleIds.includes(bundleId),
    );
    if (mutation.addedBundle !== null) bundles.push(mutation.addedBundle);
    bundles.sort((left, right) => left.bundleId.localeCompare(right.bundleId));
    const expected = collectEncryptedWalletBackupV2DescriptorPages(
      enumerateEncryptedWalletBackupV2DescriptorPages({
        head: createEncryptedWalletBackupV2CurrentHead({
          realm: input.keyHandle.realm,
          walletId: input.keyHandle.walletId,
          enrollmentEpoch: input.enrollmentEpoch,
          headVersion: predecessor.head.headVersion + 1,
          bundles,
        }),
        bundles,
      }),
    );
    const current = await collectHead(input);
    if (sameCollectedHead(current, expected)) {
      const prepared = await store.readPreparedMutation();
      if (
        prepared === null ||
        prepared.mutationId !== preparedMutation.mutationId ||
        prepared.requestDigest !== preparedMutation.requestDigest
      )
        return { kind: "indeterminate" };
      await sendAndCommit(
        input,
        store,
        prepared.canonicalUploadGroup,
        preparedMutation,
        binding,
        group,
      );
      return { kind: "committed" };
    }
    // A later successor can hide an earlier successful request with a lost response.
    if (
      current.head.headVersion > expected.head.headVersion ||
      current.head.headVersion < predecessor.head.headVersion
    )
      return { kind: "indeterminate" };
    return { kind: "disproved", collectedHeadEvidence: current };
  } catch (error) {
    if (!input.isCurrentProfile() || input.signal.aborted) throw error;
    return { kind: "indeterminate" };
  }
}

async function hasExactPendingRemovalIntent(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  binding: PreparedBinding,
): Promise<boolean> {
  const rawDesired = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    binding.localAssetKey,
  ]);
  if (rawDesired === undefined) return false;
  const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
  const assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle: input.keyHandle,
    mintUrl: desired.mintUrl,
    unit: desired.unit,
    assetIdentity: desired.assetIdentity,
  });
  return (
    desired.localAssetKey === binding.localAssetKey &&
    assetLocator === binding.assetLocator &&
    desired.custodyRevision === binding.custodyRevision &&
    desired.desiredAction === binding.desiredAction &&
    desired.activeProofCount === binding.activeProofCount &&
    desired.syncState === "pending" &&
    desired.removalIntent?.state === "pending"
  );
}

async function reconcileLostRemoval(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  preparedMutation: EncryptedWalletBackupV2PreparedMutationMatch,
  binding: PreparedBinding,
  group: ReturnType<typeof decodeEncryptedWalletBackupV2UploadGroup>,
): Promise<LostRemovalReconciliation> {
  const mutation = group.mutationEvidence.envelope.mutation;
  if (mutation.supersededBundleIds.length !== 1) return { kind: "indeterminate" };
  let resultCommitted = false;
  try {
    const predecessor = await collectedHead(store);
    if (
      mutation.expectedHeadVersion !== predecessor.head.headVersion ||
      mutation.expectedActiveSetDigest !== predecessor.head.activeSetDigest
    ) {
      return { kind: "indeterminate" };
    }
    const targetBundles = predecessor.bundles.filter(
      ({ assetLocator }) => assetLocator === binding.assetLocator,
    );
    if (
      targetBundles.length !== 1 ||
      targetBundles[0]!.bundleId !== mutation.supersededBundleIds[0]
    ) {
      return { kind: "indeterminate" };
    }
    const rawDesired = await input.database.encryptedWalletBackupV2DesiredAssets.get([
      input.scopeId,
      binding.localAssetKey,
    ]);
    if (rawDesired === undefined) return { kind: "indeterminate" };
    const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
    const intent = desired.removalIntent;
    if (
      intent === null ||
      desired.custodyRevision !== binding.custodyRevision ||
      desired.desiredAction !== binding.desiredAction ||
      desired.activeProofCount !== binding.activeProofCount
    )
      return { kind: "indeterminate" };
    const expectedBundles = predecessor.bundles.filter(
      ({ bundleId }) => !mutation.supersededBundleIds.includes(bundleId),
    );
    if (binding.desiredAction === "remove") {
      if (binding.activeProofCount !== 0 || mutation.addedBundle !== null) {
        return { kind: "indeterminate" };
      }
    } else {
      const successor = mutation.addedBundle;
      if (
        successor === null ||
        successor.assetLocator !== binding.assetLocator ||
        successor.custodyRevision.toString() !== binding.custodyRevision
      )
        return { kind: "indeterminate" };
      expectedBundles.push(successor);
    }
    expectedBundles.sort((left, right) => left.bundleId.localeCompare(right.bundleId));
    const expectedHead = collectEncryptedWalletBackupV2DescriptorPages(
      enumerateEncryptedWalletBackupV2DescriptorPages({
        head: createEncryptedWalletBackupV2CurrentHead({
          realm: input.keyHandle.realm,
          walletId: input.keyHandle.walletId,
          enrollmentEpoch: input.enrollmentEpoch,
          headVersion: predecessor.head.headVersion + 1,
          bundles: expectedBundles,
        }),
        bundles: expectedBundles,
      }),
    );
    const current = await collectHead(input);
    if (!sameCollectedHead(current, expectedHead)) {
      return { kind: "disproved", collectedHeadEvidence: current };
    }
    const targetProofIds = new Set(intent.proofs.map(({ proofId }) => proofId));
    const expectedAsset: EncryptedWalletBackupV2AssetIdentity = {
      mintUrl: desired.mintUrl,
      unit: desired.unit,
      assetIdentity: desired.assetIdentity,
    };
    const localRows = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
      database: input.database,
      scopeId: input.scopeId,
      asset: expectedAsset,
    });
    const decrypted = await readAndDecryptBundle(
      input,
      targetBundles[0]!,
      BigInt(targetBundles[0]!.custodyRevision),
      expectedAsset,
    );
    if (!sameProofMaterialSet(localRows, decrypted.proofs)) return { kind: "indeterminate" };
    if (
      intent.proofs.length === 0 ||
      intent.proofs.some(
        (tuple) =>
          !decrypted.proofs.some(
            (entry) =>
              entry.proofId === tuple.proofId &&
              entry.terminalSeal?.proofCommitment === tuple.proofCommitment,
          ),
      )
    )
      return { kind: "indeterminate" };
    if (mutation.addedBundle !== null) {
      const successorProofs = await readAndDecryptBundle(
        input,
        mutation.addedBundle,
        BigInt(mutation.addedBundle.custodyRevision),
        expectedAsset,
      );
      const survivors = localRows.filter((row) => !targetProofIds.has(row.proofId));
      if (!sameProofMaterialSet(survivors, successorProofs.proofs)) {
        return { kind: "indeterminate" };
      }
      if (
        successorProofs.proofs.some(
          (entry) =>
            targetProofIds.has(entry.proofId) ||
            (entry.terminalSeal !== undefined &&
              intent.proofs.some(
                (tuple) => entry.terminalSeal!.proofCommitment === tuple.proofCommitment,
              )),
        )
      )
        return { kind: "indeterminate" };
    }
    requireCurrent(input);
    await store.commitExactPreparedRemovalHead({
      binding: {
        ...binding,
        bundleId: mutation.addedBundle?.bundleId ?? null,
        bundleDescriptorDigest:
          mutation.addedBundle === null
            ? null
            : digestEncryptedWalletBackupV2BundleDescriptor(mutation.addedBundle),
      },
      collectedHeadEvidence: current,
      preparedMutation,
      acknowledgedAtMs: input.nowUnixSeconds() * 1000,
    });
    resultCommitted = true;
    await finalizeBrowserCtfRemove({
      database: input.database,
      scopeId: input.scopeId,
      keyHandle: input.keyHandle,
      enrollmentEpoch: input.enrollmentEpoch,
      localAssetKey: binding.localAssetKey,
      assetLocator: binding.assetLocator,
      lockManager: input.lockManager,
      isCurrentProfile: input.isCurrentProfile,
      observedAtMs: input.nowUnixSeconds() * 1000,
    });
    return { kind: "committed" };
  } catch (error) {
    if (resultCommitted || !input.isCurrentProfile() || input.signal.aborted) throw error;
    return { kind: "indeterminate" };
  }
}

async function readAndDecryptBundle(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  descriptor: EncryptedWalletBackupV2BundleDescriptor,
  custodyRevision: bigint,
  asset: {
    readonly mintUrl: string;
    readonly unit: string;
    readonly assetIdentity: string;
  },
) {
  const objects = [];
  for (const { objectId } of descriptor.objects) {
    const requestProof = await proof(input, "object", objectId, new Uint8Array());
    requireCurrent(input);
    objects.push(
      await input.remote.readObject({
        requestProof,
        objectId,
        expectedDescriptor: descriptor,
        signal: input.signal,
      }),
    );
  }
  return decryptEncryptedWalletBackupV2ProofSetBundle({
    keyHandle: input.keyHandle,
    seed: input.seed,
    expectedAsset: asset,
    custodyRevision,
    runtime: input.runtime,
    descriptor,
    objects,
  });
}

function sameProofMaterialSet(
  localRows: readonly ReturnType<
    typeof import("../stores/durable-custody-types").decodeBrowserCustodyProofRow
  >[],
  remoteProofs: readonly { readonly proofId: string; readonly proof: unknown }[],
): boolean {
  if (localRows.length !== remoteProofs.length) return false;
  const expected = new Map(localRows.map((row) => [row.proofId, row.proofFingerprint]));
  const seen = new Set<string>();
  for (const entry of remoteProofs) {
    if (seen.has(entry.proofId)) return false;
    seen.add(entry.proofId);
    let fingerprint: string;
    try {
      fingerprint = deriveDurableCustodyArtifactFingerprint(
        serializeDurableCustodyProofArtifact(entry.proof as never),
      );
    } catch {
      return false;
    }
    if (expected.get(entry.proofId) !== fingerprint) return false;
  }
  return seen.size === expected.size;
}

function minimumRetryDelayMilliseconds(error: EncryptedWalletBackupV2HttpTransportError): number {
  return Math.max(5_000, (error.retryAfterSeconds ?? 0) * 1_000);
}

async function collectHead(input: BrowserEncryptedWalletBackupV2WorkerInput) {
  return collectAllEncryptedWalletBackupV2DescriptorPages({
    issueRequestProof: (cursor) => proof(input, "head", cursor, new Uint8Array()),
    readDescriptorPage: ({ requestProof, afterBundleId }) => {
      requireCurrent(input);
      return input.remote.readDescriptorPage({ requestProof, afterBundleId, signal: input.signal });
    },
  });
}

async function proof(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  kind: "head" | "mutation" | "object",
  cursor: string | null,
  payload: Uint8Array,
) {
  requireCurrent(input);
  const issuedAtUnixSeconds = input.nowUnixSeconds();
  return prepareEncryptedWalletBackupV2RequestProof({
    keyHandle: input.keyHandle,
    enrollmentEpoch: input.enrollmentEpoch,
    method: kind === "mutation" ? "POST" : "GET",
    url: input.requestUrl(kind, cursor),
    issuedAtUnixSeconds,
    expiresAtUnixSeconds: issuedAtUnixSeconds + 60,
    payload,
    signal: input.signal,
    runtime: input.runtime,
  });
}

async function collectedHead(store: EncryptedWalletBackupV2DexieAuthorityStore) {
  const head = await store.readAcceptedHead();
  if (head === null) throw new Error("browser V2 accepted head is absent");
  const bundles = await store.listActiveDescriptors();
  return collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({
      head: {
        formatVersion: 2,
        realm: head.realm,
        walletId: head.walletId,
        enrollmentEpoch: head.enrollmentEpoch,
        headVersion: head.headVersion,
        activeBundleCount: head.activeBundleCount,
        activeObjectCount: head.activeObjectCount,
        activeSetDigest: head.activeSetDigest,
      },
      bundles: bundles.map((row) =>
        decodeEncryptedWalletBackupV2BundleDescriptorWire(row.canonicalDescriptor),
      ),
    }),
  );
}
function authority(input: BrowserEncryptedWalletBackupV2WorkerInput) {
  return new EncryptedWalletBackupV2DexieAuthorityStore({
    database: input.database,
    scopeId: input.scopeId,
    realm: input.keyHandle.realm,
    walletId: input.keyHandle.walletId,
    enrollmentEpoch: input.enrollmentEpoch,
    requestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
  });
}
function requireCurrent(input: BrowserEncryptedWalletBackupV2WorkerInput) {
  if (!input.isCurrentProfile() || input.signal.aborted)
    throw new Error("browser V2 worker profile is stale");
}
async function desiredRows(database: BitcasterDB, scopeId: string) {
  const rows = await database.encryptedWalletBackupV2DesiredAssets
    .where("[scopeId+syncState+localAssetKey]")
    .between([scopeId, "pending", Dexie.minKey], [scopeId, "pending", Dexie.maxKey])
    .limit(257)
    .toArray();
  if (rows.length > 256) throw new Error("browser V2 desired asset rows exceed the limit");
  return rows.map(decodeEncryptedWalletBackupV2DesiredAssetRow);
}
function emptyMatch() {
  return { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) };
}

async function selectPendingAsset(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  head: Awaited<ReturnType<typeof collectedHead>>,
) {
  const desired = await desiredRows(input.database, input.scopeId);
  for (const removal of desired.filter(
    ({ desiredAction, removalIntent }) => desiredAction === "remove" || removalIntent !== null,
  )) {
    const assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
      keyHandle: input.keyHandle,
      mintUrl: removal.mintUrl,
      unit: removal.unit,
      assetIdentity: removal.assetIdentity,
    });
    const freshHead = await collectHead(input);
    requireCurrent(input);
    if (!sameCollectedHead(freshHead, head)) {
      await refuseCompetingHead(input, store, freshHead);
      return "recovery-required" as const;
    }
    if (!freshHead.bundles.some((bundle) => bundle.assetLocator === assetLocator)) {
      requireCurrent(input);
      const outcome = await store.acknowledgeCurrentHeadRemoval({
        binding: {
          localAssetKey: removal.localAssetKey,
          assetLocator,
          custodyRevision: removal.custodyRevision,
          desiredAction: removal.desiredAction,
          activeProofCount: removal.activeProofCount,
        },
        collectedHeadEvidence: freshHead,
        acknowledgedAtMs: input.nowUnixSeconds() * 1000,
      });
      if (outcome === "acknowledged") {
        await finalizeBrowserCtfRemove({
          database: input.database,
          scopeId: input.scopeId,
          keyHandle: input.keyHandle,
          enrollmentEpoch: input.enrollmentEpoch,
          localAssetKey: removal.localAssetKey,
          assetLocator,
          lockManager: input.lockManager,
          isCurrentProfile: input.isCurrentProfile,
          observedAtMs: input.nowUnixSeconds() * 1000,
        });
      }
      return "locally-committed" as const;
    }
    return { desired: removal, assetLocator } as const;
  }
  const replacements = desired.filter(({ desiredAction }) => desiredAction === "replace");
  if (replacements.length === 0) return null;
  if (head.bundles.length < ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX) {
    return locatedAsset(input, replacements[0]!);
  }
  for (const replacement of replacements) {
    const located = await locatedAsset(input, replacement);
    if (head.bundles.some((bundle) => bundle.assetLocator === located.assetLocator)) return located;
  }
  return "service-quota-pending" as const;
}

async function locatedAsset(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  desired: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>,
) {
  const assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle: input.keyHandle,
    mintUrl: desired.mintUrl,
    unit: desired.unit,
    assetIdentity: desired.assetIdentity,
  });
  return { desired, assetLocator } as const;
}

const defaultAssetSource = Object.freeze({
  read: readBrowserEncryptedWalletBackupV2AssetSnapshot,
  prepare: prepareBrowserEncryptedWalletBackupV2AssetBundle,
});
function preparedBinding(row: {
  readonly localAssetKey?: string;
  readonly assetLocator?: string;
  readonly custodyRevision?: string;
  readonly desiredAction?: "replace" | "remove";
  readonly activeProofCount?: number;
}): PreparedBinding {
  if (
    row.localAssetKey === undefined ||
    row.assetLocator === undefined ||
    row.custodyRevision === undefined ||
    row.desiredAction === undefined ||
    row.activeProofCount === undefined
  )
    throw new Error("browser V2 prepared mutation binding is missing");
  return {
    localAssetKey: row.localAssetKey,
    assetLocator: row.assetLocator,
    custodyRevision: row.custodyRevision,
    desiredAction: row.desiredAction,
    activeProofCount: row.activeProofCount,
    bundleId: null,
    bundleDescriptorDigest: null,
  };
}
