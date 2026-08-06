import {
  applyEncryptedWalletBackupV2VerifiedReceipt,
  collectAllEncryptedWalletBackupV2DescriptorPages,
  decodeEncryptedWalletBackupV2UploadGroup,
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
  type EncryptedWalletBackupV2KeyHandle,
  type EncryptedWalletBackupV2RemotePort,
} from "@bitcaster/client-sdk";
import Dexie from "dexie";
import { EncryptedWalletBackupV2HttpTransportError } from "@bitcaster/client-sdk/encryptedWalletBackupV2HttpAdapter";
import {
  EncryptedWalletBackupV2DexieAuthorityStore,
  type EncryptedWalletBackupV2PreparedMutationMatch,
} from "../stores/encrypted-wallet-backup-v2-db";
import {
  prepareBrowserEncryptedWalletBackupV2AssetBundle,
  readBrowserEncryptedWalletBackupV2AssetSnapshot,
} from "../stores/browser-encrypted-wallet-backup-v2-asset-source";
import { decodeEncryptedWalletBackupV2DesiredAssetRow } from "../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import type { BitcasterDB } from "../stores/proof-db";

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
  readonly requestUrl: (kind: "head" | "mutation", afterBundleId: string | null) => string;
  readonly nowUnixSeconds: () => number;
  readonly runtime: EncryptedWalletBackupV2BundleRuntime;
  readonly signal: AbortSignal;
  readonly isCurrentProfile: () => boolean;
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
    await store.acceptCompetingHead({
      collectedHeadEvidence: evidence,
      stalePreparedMutation: emptyMatch(),
    });
    return { kind: "head-accepted" };
  }
  const head = await collectedHead(store);
  const selected = await selectPendingAsset(input, store, head);
  if (selected === null) return { kind: "idle" };
  if (selected === "locally-committed") return { kind: "committed" };
  if (selected === "service-quota-pending") return { kind: "service-quota-pending" };
  const next = await prepareSelectedMutation(input, store, head, selected);
  return sendPrepared(input, store, next.bytes, next.mutationId, next.requestDigest, next.binding);
}

async function prepareSelectedMutation(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  head: Awaited<ReturnType<typeof collectedHead>>,
  selected: Exclude<Awaited<ReturnType<typeof selectPendingAsset>>, null | string>,
) {
  const { desired, assetLocator } = selected;
  const preparedBundle = await prepareAssetBundle(input, head, desired);
  const bundle = preparedBundle?.descriptor ?? null;
  const envelope = await prepareEncryptedWalletBackupV2AssetMutation({
    keyHandle: input.keyHandle,
    expectedHeadEvidence: head,
    assetLocator,
    desiredAction: desired.desiredAction,
    addedBundle: bundle,
    runtime: input.runtime,
  });
  const objects = preparedBundle?.objects ?? [];
  const bytes = encodeEncryptedWalletBackupV2UploadGroup({ envelope, objects });
  requireCurrent(input);
  const binding = bindingFor(desired, assetLocator, bundle);
  await store.insertPreparedMutationForDesired({
    prepared: {
      mutationId: envelope.mutation.mutationId,
      requestDigest: envelope.requestDigest,
      canonicalUploadGroup: bytes,
      createdAtUnixMilliseconds: input.nowUnixSeconds() * 1000,
      ...binding,
    },
    desired: binding,
  });
  return {
    bytes,
    mutationId: envelope.mutation.mutationId,
    requestDigest: envelope.requestDigest,
    binding,
  } as const;
}

async function prepareAssetBundle(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  head: Awaited<ReturnType<typeof collectedHead>>,
  desired: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>,
) {
  if (desired.desiredAction === "remove") return null;
  const source = input.assetSource ?? defaultAssetSource;
  const snapshot = await source.read({
    database: input.database,
    scopeId: input.scopeId,
    localAssetKey: desired.localAssetKey,
  });
  return source.prepare({
    snapshot,
    keyHandle: input.keyHandle,
    seed: input.seed,
    runtime: input.runtime,
    bundleIdExists: (id) => head.bundles.some((item) => item.bundleId === id),
  });
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
    return recoverTransportError(input, store, { mutationId, requestDigest }, error);
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
  });
}

async function recoverTransportError(
  input: BrowserEncryptedWalletBackupV2WorkerInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  preparedMutation: EncryptedWalletBackupV2PreparedMutationMatch,
  error: unknown,
): Promise<BrowserEncryptedWalletBackupV2WorkerResult> {
  if (!(error instanceof EncryptedWalletBackupV2HttpTransportError)) throw error;
  if (error.code === "conflict") {
    const evidence = await collectHead(input);
    requireCurrent(input);
    await store.acceptCompetingHead({
      collectedHeadEvidence: evidence,
      stalePreparedMutation: preparedMutation,
    });
    return { kind: "conflict-recovered" };
  }
  if (error.code === "quota-exceeded") {
    requireCurrent(input);
    await store.discardRejectedPreparedMutation(preparedMutation);
    return { kind: "service-quota-pending" };
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
  kind: "head" | "mutation",
  cursor: string | null,
  payload: Uint8Array,
) {
  requireCurrent(input);
  const issuedAtUnixSeconds = input.nowUnixSeconds();
  return prepareEncryptedWalletBackupV2RequestProof({
    keyHandle: input.keyHandle,
    enrollmentEpoch: input.enrollmentEpoch,
    method: kind === "head" ? "GET" : "POST",
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
  for (const removal of desired.filter(({ desiredAction }) => desiredAction === "remove")) {
    const assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
      keyHandle: input.keyHandle,
      mintUrl: removal.mintUrl,
      unit: removal.unit,
      assetIdentity: removal.assetIdentity,
    });
    if (!head.bundles.some((bundle) => bundle.assetLocator === assetLocator)) {
      requireCurrent(input);
      await store.acknowledgeAbsentRemoval({
        localAssetKey: removal.localAssetKey,
        assetLocator,
        custodyRevision: removal.custodyRevision,
        desiredAction: "remove",
        activeProofCount: removal.activeProofCount,
      });
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
