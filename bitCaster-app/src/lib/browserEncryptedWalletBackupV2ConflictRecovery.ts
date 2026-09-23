import {
  collectAllEncryptedWalletBackupV2DescriptorPages,
  decodeEncryptedWalletBackupV2AssetIdentity,
  deriveEncryptedWalletBackupV2AssetLocator,
  ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX,
  ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX,
  prepareEncryptedWalletBackupV2RequestProof,
  type EncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2BundleRuntime,
  type EncryptedWalletBackupV2CollectedHeadEvidence,
  type EncryptedWalletBackupV2KeyHandle,
  type EncryptedWalletBackupV2RemotePort,
  type EncryptedWalletBackupV2VerifiedProofSet,
} from "@bitcaster/client-sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeDurableBolt11MintQuote } from "@bitcaster/client-sdk/durableBolt11MintQuote";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import { serializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { EncryptedWalletBackupV2HttpTransportError } from "@bitcaster/client-sdk/encryptedWalletBackupV2HttpAdapter";
import {
  hashToCurve,
  HttpResponseError,
  NetworkError,
  RateLimitError,
  type ProofState,
  type Wallet as CashuWallet,
} from "@cashu/cashu-ts";
import Dexie from "dexie";
import {
  requireBrowserLiveProofBackupAuthorityTableRow,
  requireBrowserProofBackupAuthorityForProof,
  sameBrowserProofDerivationLocator,
  type BrowserProofBackupAuthorityRow,
} from "../stores/browser-proof-backup-authority";
import { readBrowserEncryptedWalletBackupV2ExactLocalProofRows } from "../stores/browser-encrypted-wallet-backup-v2-asset-source";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  decodeEncryptedWalletBackupV2DesiredAssetRow,
} from "../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { BrowserDurableCustodyAdapter } from "../stores/durable-custody-db";
import {
  decodeBrowserCustodyProofRow,
  type BrowserCustodyProofRow,
} from "../stores/durable-custody-types";
import { EncryptedWalletBackupV2DexieAuthorityStore } from "../stores/encrypted-wallet-backup-v2-db";
import { pageActiveCtfRangePreparations } from "../stores/ctf-range-order-db";
import { storedProofFromCustodyRow, type BitcasterDB } from "../stores/proof-db";
import { admitBrowserEncryptedWalletBackupV2AcceptedRemoteAsset } from "./browserEncryptedWalletBackupV2Admission";
import { discoverAndVerifyBrowserEncryptedWalletBackupV2Descriptor } from "./browserEncryptedWalletBackupV2Restore";
import { withWalletProfileLock } from "./walletProfileLock";

const TEXT_KEY_MIN = "";
const TEXT_KEY_MAX = "\uffff";
const NUT_07_BATCH_MAX = 256;
const ACTIVE_PROOF_PAGE_SIZE = 64;

export type BrowserEncryptedWalletBackupV2ConflictRecoveryIncompleteReason =
  | "remote-unavailable"
  | "remote-head-changed"
  | "local-predecessor-unspent"
  | "local-predecessor-unknown"
  | "submitted-work-unresolved"
  | "local-state-changed";

export type BrowserEncryptedWalletBackupV2ConflictRecoveryResult =
  | {
      readonly kind: "completed";
      readonly headVersion: number;
      readonly recoveryVersion: number;
    }
  | {
      readonly kind: "incomplete";
      readonly reason: BrowserEncryptedWalletBackupV2ConflictRecoveryIncompleteReason;
    };

export interface BrowserEncryptedWalletBackupV2ConflictRecoveryInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly seed: Uint8Array;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly enrollmentEpoch: number;
  readonly remote: EncryptedWalletBackupV2RemotePort;
  readonly requestUrl: (kind: "head" | "object", value: string | null) => string;
  readonly nowUnixSeconds: () => number;
  readonly runtime: EncryptedWalletBackupV2BundleRuntime;
  readonly signal: AbortSignal;
  readonly isCurrentProfile: () => boolean;
  readonly loadWallet: (mintUrl: string) => Promise<CashuWallet>;
  readonly lockManager?: Pick<LockManager, "request">;
}

interface RecoveredAsset {
  readonly kind: "recovered";
  readonly localAssetKey: string;
  readonly proofCount: number;
  readonly desiredDigest: string;
  readonly proofAuthorityDigest: string;
}

interface LocalRecoverySnapshot {
  readonly entries: readonly string[];
  readonly activeProofCount: number;
}

type LocalAssetReconciliation =
  | { readonly kind: "reconciled"; readonly assets: readonly RecoveredAsset[] }
  | Extract<BrowserEncryptedWalletBackupV2ConflictRecoveryResult, { kind: "incomplete" }>;

/** Reconciles one authenticated competing head without merging divergent local value. */
export async function recoverBrowserEncryptedWalletBackupV2Conflict(
  input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput,
): Promise<BrowserEncryptedWalletBackupV2ConflictRecoveryResult> {
  requireCurrent(input);
  const store = authorityStore(input);
  const status = await store.readLocalRecoveryStatus();
  if (status?.localRecoveryStatus !== "recovery-required") {
    throw new Error("browser V2 conflict recovery is not required");
  }
  if ((await store.readPreparedMutation()) !== null) {
    return incomplete("submitted-work-unresolved");
  }

  const firstHead = await tryCollectHead(input);
  if (firstHead === null) return incomplete("remote-unavailable");
  requireRecoveryHead(input, firstHead);
  if (await hasUnresolvedSubmittedWork(input.database, input.scopeId)) {
    return incomplete("submitted-work-unresolved");
  }

  let reconciliation: LocalAssetReconciliation;
  try {
    reconciliation = await reconcileLocalAssets(input, store, firstHead);
  } catch (error) {
    if (isExpectedLocalReconciliationRace(error)) return incomplete("local-state-changed");
    throw error;
  }
  if (reconciliation.kind === "incomplete") return reconciliation;
  const recoveredAssets = reconciliation.assets;

  if (await hasUnresolvedSubmittedWork(input.database, input.scopeId)) {
    return incomplete("submitted-work-unresolved");
  }
  let captured: LocalRecoverySnapshot;
  try {
    captured = await readRecoveredLocalSnapshot(input, recoveredAssets);
  } catch (error) {
    if (isExpectedLocalSnapshotChange(error)) return incomplete("local-state-changed");
    throw error;
  }
  const secondHead = await tryCollectHead(input);
  if (secondHead === null) return incomplete("remote-unavailable");
  requireRecoveryHead(input, secondHead);
  if (!sameCollectedHead(firstHead, secondHead)) return incomplete("remote-head-changed");

  try {
    const next = await withWalletProfileLock(
      input.scopeId,
      () =>
        store.acceptRecoveredHead({
          collectedHeadEvidence: secondHead,
          expectedRecoveryVersion: status.localRecoveryVersion,
          recheckLocalState: async () => {
            requireCurrent(input);
            if (await hasUnresolvedSubmittedWork(input.database, input.scopeId)) return false;
            try {
              const current = await readRecoveredLocalSnapshot(input, recoveredAssets);
              const same =
                current.activeProofCount === captured.activeProofCount &&
                sameStrings(current.entries, captured.entries);
              requireCurrent(input);
              return same;
            } catch (error) {
              if (isExpectedLocalSnapshotChange(error)) return false;
              throw error;
            }
          },
        }),
      input.lockManager,
    );
    return {
      kind: "completed",
      headVersion: secondHead.head.headVersion,
      recoveryVersion: next.localRecoveryVersion,
    };
  } catch (error) {
    if (isExpectedLocalRecheckFailure(error)) return incomplete("local-state-changed");
    throw error;
  }
}

async function reconcileLocalAssets(
  input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  head: EncryptedWalletBackupV2CollectedHeadEvidence,
): Promise<LocalAssetReconciliation> {
  const desiredRows = await readDesiredRows(input.database, input.scopeId);
  const descriptorsByLocator = new Map<string, EncryptedWalletBackupV2BundleDescriptor>();
  for (const descriptor of head.bundles) {
    if (descriptorsByLocator.has(descriptor.assetLocator)) {
      throw new Error("browser V2 conflict recovery descriptor asset is duplicated");
    }
    descriptorsByLocator.set(descriptor.assetLocator, descriptor);
  }

  const desiredByLocator = new Map<
    string,
    ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>
  >();
  for (const desired of desiredRows) {
    requireCurrent(input);
    const asset = decodeEncryptedWalletBackupV2AssetIdentity({
      mintUrl: desired.mintUrl,
      unit: desired.unit,
      assetIdentity: desired.assetIdentity,
    });
    const assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
      keyHandle: input.keyHandle,
      ...asset,
    });
    if (desiredByLocator.has(assetLocator)) {
      throw new Error("browser V2 conflict recovery local asset ownership is duplicated");
    }
    desiredByLocator.set(assetLocator, desired);
  }

  // Resolve known local-only state before downloading or admitting any remote bundle.
  for (const [assetLocator, desired] of desiredByLocator) {
    if (!descriptorsByLocator.has(assetLocator)) {
      if (desired.removalIntent !== null) return incomplete("submitted-work-unresolved");
      const result = await reconcileAbsentAsset(input, store, desired, assetLocator, head);
      if (result !== null) return result;
    }
  }

  const recovered: RecoveredAsset[] = [];
  const seenAssetKeys = new Set<string>();
  for (const descriptor of head.bundles) {
    requireCurrent(input);
    const desired = desiredByLocator.get(descriptor.assetLocator);
    if (desired?.removalIntent !== null && desired !== undefined) {
      return incomplete("submitted-work-unresolved");
    }
    const result = await reconcilePresentDescriptor(input, descriptor, head, desired ?? null);
    if (result.kind === "incomplete") return result;
    if (seenAssetKeys.has(result.localAssetKey)) {
      throw new Error("browser V2 conflict recovery asset ownership is duplicated");
    }
    seenAssetKeys.add(result.localAssetKey);
    recovered.push(result);
  }
  return Object.freeze({ kind: "reconciled", assets: Object.freeze(recovered) });
}

async function reconcilePresentDescriptor(
  input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput,
  descriptor: EncryptedWalletBackupV2BundleDescriptor,
  head: EncryptedWalletBackupV2CollectedHeadEvidence,
  desired: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow> | null,
): Promise<
  | RecoveredAsset
  | Extract<BrowserEncryptedWalletBackupV2ConflictRecoveryResult, { kind: "incomplete" }>
> {
  let walletMintUrl: string | null = null;
  let walletPromise: Promise<CashuWallet> | null = null;
  const loadWallet = async (mintUrl: string): Promise<CashuWallet> => {
    requireCurrent(input);
    if (walletMintUrl !== null && walletMintUrl !== mintUrl) {
      throw new Error("browser V2 conflict recovery descriptor mint changed");
    }
    walletMintUrl = mintUrl;
    walletPromise ??= input.loadWallet(mintUrl);
    const wallet = await walletPromise;
    requireCurrent(input);
    return wallet;
  };
  let discovered: Awaited<
    ReturnType<typeof discoverAndVerifyBrowserEncryptedWalletBackupV2Descriptor>
  >;
  try {
    discovered = await discoverAndVerifyBrowserEncryptedWalletBackupV2Descriptor({
      ...input,
      collectedHeadEvidence: head,
      descriptor,
      loadWallet,
    });
  } catch (error) {
    if (isExpectedRemoteFailure(error)) return incomplete("remote-unavailable");
    throw error;
  }
  const asset = decodeEncryptedWalletBackupV2AssetIdentity(discovered.asset);
  const assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle: input.keyHandle,
    ...asset,
  });
  if (assetLocator !== descriptor.assetLocator) {
    throw new Error("browser V2 conflict recovery discovered asset locator conflicts");
  }
  const desiredIdentity = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: input.scopeId,
    asset,
    custodyRevision: 0n,
    activeProofCount: 0,
  });
  if (desired !== null && desired.localAssetKey !== desiredIdentity.localAssetKey) {
    throw new Error("browser V2 conflict recovery descriptor has multiple local owners");
  }
  if (desired !== null && desired.removalIntent !== null) {
    return incomplete("submitted-work-unresolved");
  }
  if (desired !== null) {
    const predecessorResult = await retireLocalOnlyPredecessors(
      input,
      desired,
      discovered.verified,
      discovered.verified.proofs[0]?.asset.kind === "ctf"
        ? discovered.verified.proofs[0].asset
        : undefined,
    );
    if (predecessorResult !== null) return predecessorResult;
  }
  const wallet = discovered.verified.proofs.some(
    ({ selectionAuthority }) => selectionAuthority === "live-verified",
  )
    ? await loadWallet(asset.mintUrl)
    : undefined;
  await admitBrowserEncryptedWalletBackupV2AcceptedRemoteAsset({
    seed: input.seed,
    verified: discovered.verified,
    asset,
    custodyRevision: discovered.descriptorIdentity.custodyRevision,
    sourceOperationId: `backup-v2-conflict:${head.head.headVersion}:${assetLocator}`,
    collectedHeadEvidence: head,
    realm: input.keyHandle.realm,
    enrollmentEpoch: input.enrollmentEpoch,
    ...(wallet === undefined ? {} : { wallet }),
    database: input.database,
    scopeId: input.scopeId,
    isCurrentProfile: input.isCurrentProfile,
    lockManager: input.lockManager,
  });
  return captureRecoveredAssetEvidence(input, desiredIdentity.localAssetKey, discovered);
}

async function reconcileAbsentAsset(
  input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput,
  store: EncryptedWalletBackupV2DexieAuthorityStore,
  desired: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>,
  assetLocator: string,
  head: EncryptedWalletBackupV2CollectedHeadEvidence,
): Promise<Extract<
  BrowserEncryptedWalletBackupV2ConflictRecoveryResult,
  { kind: "incomplete" }
> | null> {
  requireCurrent(input);
  if (desired.removalIntent !== null && desired.activeProofCount > 0) {
    return incomplete("submitted-work-unresolved");
  }
  let current = desired;
  if (current.activeProofCount > 0) {
    const result = await retireLocalOnlyPredecessors(input, current, { proofs: [] });
    if (result !== null) return result;
    const raw = await input.database.encryptedWalletBackupV2DesiredAssets.get([
      input.scopeId,
      current.localAssetKey,
    ]);
    requireCurrent(input);
    if (raw === undefined) {
      throw new Error("browser V2 conflict recovery retired asset is absent");
    }
    current = decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
  }
  if (current.activeProofCount !== 0 || current.desiredAction !== "remove") {
    throw new Error("browser V2 conflict recovery absent asset is not empty");
  }
  await withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCurrent(input);
      await store.acknowledgeCurrentHeadRemoval({
        binding: {
          localAssetKey: current.localAssetKey,
          assetLocator,
          custodyRevision: current.custodyRevision,
          desiredAction: "remove",
          activeProofCount: 0,
        },
        collectedHeadEvidence: head,
        acknowledgedAtMs: input.nowUnixSeconds() * 1_000,
      });
      requireCurrent(input);
    },
    input.lockManager,
  );
  return null;
}

async function retireLocalOnlyPredecessors(
  input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput,
  expectedDesired: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>,
  remote: Pick<EncryptedWalletBackupV2VerifiedProofSet, "proofs">,
  ctfRoute?: Extract<
    EncryptedWalletBackupV2VerifiedProofSet["proofs"][number]["asset"],
    { readonly kind: "ctf" }
  >,
): Promise<Extract<
  BrowserEncryptedWalletBackupV2ConflictRecoveryResult,
  { kind: "incomplete" }
> | null> {
  requireCurrent(input);
  const asset = decodeEncryptedWalletBackupV2AssetIdentity({
    mintUrl: expectedDesired.mintUrl,
    unit: expectedDesired.unit,
    assetIdentity: expectedDesired.assetIdentity,
  });
  const local = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
    database: input.database,
    scopeId: input.scopeId,
    asset,
    ...(ctfRoute === undefined ? {} : { ctfRoute }),
  });
  const remoteIds = new Set(remote.proofs.map(({ proofId }) => proofId));
  const candidates = local.filter(({ proofId }) => !remoteIds.has(proofId));
  if (candidates.length === 0) return null;
  const states = await classifyMintStates(input, asset.mintUrl, candidates);
  requireCurrent(input);
  if (states === null) return incomplete("local-predecessor-unknown");
  if (states.some((state) => state === "UNSPENT")) {
    return incomplete("local-predecessor-unspent");
  }
  if (states.some((state) => state !== "SPENT")) {
    return incomplete("local-predecessor-unknown");
  }
  const authorities = await input.database.custodyProofBackupAuthorities.bulkGet(
    candidates.map(({ proofId }) => [input.scopeId, proofId] as [string, string]),
  );
  const retirementCandidates = candidates.map((proof, index) => ({
    proof,
    authority: requireBrowserProofBackupAuthorityForProof(
      requireBrowserLiveProofBackupAuthorityTableRow(authorities[index], [
        input.scopeId,
        proof.proofId,
      ]),
      proof,
    ),
  }));
  await withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCurrent(input);
      await new BrowserDurableCustodyAdapter(input.database).retireExactMintSpentProofs({
        scopeId: input.scopeId,
        candidates: retirementCandidates,
        expectedDesiredAsset: expectedDesired,
        observedAtMs: input.nowUnixSeconds() * 1_000,
      });
      requireCurrent(input);
    },
    input.lockManager,
  );
  return null;
}

async function classifyMintStates(
  input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput,
  mintUrl: string,
  proofs: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[],
): Promise<readonly string[] | null> {
  requireCurrent(input);
  let wallet: CashuWallet;
  try {
    wallet = await input.loadWallet(mintUrl);
  } catch (error) {
    if (isExpectedRemoteFailure(error)) return null;
    throw error;
  }
  requireCurrent(input);
  const result: string[] = [];
  for (let start = 0; start < proofs.length; start += NUT_07_BATCH_MAX) {
    const batch = proofs.slice(start, start + NUT_07_BATCH_MAX);
    let states: readonly ProofState[];
    try {
      states = await wallet.checkProofsStates(
        batch.map((proof) => {
          const stored = storedProofFromCustodyRow(proof);
          return { id: stored.id, secret: stored.secret };
        }),
      );
    } catch (error) {
      if (isExpectedRemoteFailure(error)) return null;
      throw error;
    }
    requireCurrent(input);
    const bound = bindExactMintStates(batch, states);
    if (bound === null) return null;
    result.push(...bound);
  }
  return Object.freeze(result);
}

function bindExactMintStates(
  proofs: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[],
  states: readonly ProofState[],
): readonly string[] | null {
  if (states.length !== proofs.length) return null;
  const expectedByY = new Map<string, number>();
  for (const [index, proof] of proofs.entries()) {
    const stored = storedProofFromCustodyRow(proof);
    const Y = hashToCurve(new TextEncoder().encode(stored.secret)).toHex(true);
    if (expectedByY.has(Y)) throw new Error("browser V2 conflict recovery proof Y is duplicated");
    expectedByY.set(Y, index);
  }
  const bound: string[] = new Array(proofs.length);
  const seen = new Set<string>();
  for (const state of states) {
    const index = expectedByY.get(state.Y);
    if (index === undefined || seen.has(state.Y)) return null;
    seen.add(state.Y);
    bound[index] = state.state;
  }
  return bound.some((state) => state === undefined) ? null : Object.freeze(bound);
}

async function readRecoveredLocalSnapshot(
  input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput,
  recoveredAssets: readonly RecoveredAsset[],
): Promise<LocalRecoverySnapshot> {
  requireCurrent(input);
  const desired = await readDesiredRows(input.database, input.scopeId);
  const expected = new Map(recoveredAssets.map((asset) => [asset.localAssetKey, asset]));
  const entries: string[] = [];
  for (const row of desired) {
    const recovered = expected.get(row.localAssetKey);
    if (recovered === undefined) {
      throw new Error("browser V2 conflict recovery local asset is absent remotely");
    }
    const current = await readAssetLocalEvidence(input, row);
    if (
      current.proofCount !== recovered.proofCount ||
      current.desiredDigest !== recovered.desiredDigest ||
      current.proofAuthorityDigest !== recovered.proofAuthorityDigest
    ) {
      throw new Error("browser V2 conflict recovery local asset evidence changed");
    }
    entries.push(
      JSON.stringify([
        recovered.localAssetKey,
        recovered.proofCount,
        recovered.desiredDigest,
        recovered.proofAuthorityDigest,
      ]),
    );
    expected.delete(row.localAssetKey);
  }
  if (expected.size !== 0) {
    throw new Error("browser V2 conflict recovery admitted asset is missing locally");
  }
  const activeProofCount = recoveredAssets.reduce((count, asset) => count + asset.proofCount, 0);
  await requireNoOrphanActiveProofs(input, activeProofCount);
  requireCurrent(input);
  return Object.freeze({ entries: Object.freeze(entries.sort()), activeProofCount });
}

async function captureRecoveredAssetEvidence(
  input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput,
  localAssetKey: string,
  discovered: Awaited<ReturnType<typeof discoverAndVerifyBrowserEncryptedWalletBackupV2Descriptor>>,
): Promise<RecoveredAsset> {
  requireCurrent(input);
  const raw = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    localAssetKey,
  ]);
  if (raw === undefined) {
    throw new Error("browser V2 conflict recovery admitted asset is missing locally");
  }
  const row = decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
  const local = await readAssetLocalEvidence(input, row, discovered.verified);
  if (local.proofCount !== discovered.verified.proofs.length) {
    throw new Error("browser V2 conflict recovery proof set is incomplete");
  }
  return Object.freeze({
    kind: "recovered",
    localAssetKey,
    ...local,
  });
}

async function readAssetLocalEvidence(
  input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput,
  row: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>,
  verified?: EncryptedWalletBackupV2VerifiedProofSet,
): Promise<Pick<RecoveredAsset, "proofCount" | "desiredDigest" | "proofAuthorityDigest">> {
  if (
    row.scopeId !== input.scopeId ||
    row.desiredAction !== "replace" ||
    row.syncState !== "acknowledged" ||
    row.removalIntent !== null
  ) {
    throw new Error("browser V2 conflict recovery desired asset is incomplete");
  }
  const asset = decodeEncryptedWalletBackupV2AssetIdentity({
    mintUrl: row.mintUrl,
    unit: row.unit,
    assetIdentity: row.assetIdentity,
  });
  const remoteById =
    verified === undefined ? null : new Map(verified.proofs.map((proof) => [proof.proofId, proof]));
  const ctfRoute = verified?.proofs[0]?.asset.kind === "ctf" ? verified.proofs[0].asset : undefined;
  const proofs = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
    database: input.database,
    scopeId: input.scopeId,
    asset,
    ...(ctfRoute === undefined ? {} : { ctfRoute }),
  });
  if (
    proofs.length !== row.activeProofCount ||
    proofs.length > ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX
  ) {
    throw new Error("browser V2 conflict recovery proof set is incomplete");
  }
  const authorities = await input.database.custodyProofBackupAuthorities.bulkGet(
    proofs.map(({ proofId }) => [input.scopeId, proofId] as [string, string]),
  );
  const proofTokens: string[] = [];
  for (const [index, proof] of proofs.entries()) {
    const authority = requireBrowserProofBackupAuthorityForProof(
      requireBrowserLiveProofBackupAuthorityTableRow(authorities[index], [
        input.scopeId,
        proof.proofId,
      ]),
      proof,
    );
    const materialFingerprint = requireExactProofMaterialFingerprint(proof);
    if (remoteById !== null) {
      const remote = remoteById.get(proof.proofId);
      if (remote === undefined) {
        throw new Error("browser V2 conflict recovery proof is absent remotely");
      }
      requireRemoteProofBinding(proof, authority, remote);
    }
    proofTokens.push(
      stableJson([proof.proofId, proofSnapshotToken(proof), materialFingerprint, authority]),
    );
  }
  if (remoteById !== null && remoteById.size !== proofs.length) {
    throw new Error("browser V2 conflict recovery proof set is incomplete");
  }
  proofTokens.sort();
  return Object.freeze({
    proofCount: proofs.length,
    desiredDigest: digestExactState("desired-asset-v1", stableJson(row)),
    proofAuthorityDigest: digestExactState("proof-authority-set-v1", stableJson(proofTokens)),
  });
}

async function requireNoOrphanActiveProofs(
  input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput,
  expectedProofCount: number,
): Promise<void> {
  let activeProofCount = 0;
  const { database, scopeId } = input;
  for (const state of ["selectable", "locked", "verified-losing", "pending-removal"] as const) {
    let afterProofId: string | null = null;
    for (;;) {
      requireCurrent(input);
      const lower: [string, string] | [string, string, string] =
        afterProofId === null ? [scopeId, state] : [scopeId, state, afterProofId];
      const page: BrowserCustodyProofRow[] = await database.custodyProofs
        .where("[scopeId+selectability+proofId]")
        .between(lower, [scopeId, state, []], afterProofId === null, true)
        .limit(ACTIVE_PROOF_PAGE_SIZE)
        .toArray();
      if (page.length === 0) break;
      const proofs: ReturnType<typeof decodeBrowserCustodyProofRow>[] = page.map(
        decodeBrowserCustodyProofRow,
      );
      const authorities = await database.custodyProofBackupAuthorities.bulkGet(
        proofs.map(({ proofId }) => [scopeId, proofId] as [string, string]),
      );
      for (const [index, proof] of proofs.entries()) {
        if (proof.scopeId !== scopeId || proof.selectability !== state) {
          throw new Error("browser V2 conflict recovery active proof is foreign");
        }
        requireBrowserProofBackupAuthorityForProof(
          requireBrowserLiveProofBackupAuthorityTableRow(authorities[index], [
            scopeId,
            proof.proofId,
          ]),
          proof,
        );
        requireExactProofMaterialFingerprint(proof);
        activeProofCount += 1;
        if (activeProofCount > expectedProofCount) {
          throw new Error("browser V2 conflict recovery orphan active proof appeared");
        }
      }
      afterProofId = proofs[proofs.length - 1]!.proofId;
      if (page.length < ACTIVE_PROOF_PAGE_SIZE) break;
    }
  }
  if (activeProofCount !== expectedProofCount) {
    throw new Error("browser V2 conflict recovery active proof set changed");
  }
}

function requireExactProofMaterialFingerprint(
  proof: ReturnType<typeof decodeBrowserCustodyProofRow>,
): string {
  const fingerprint = deriveDurableCustodyArtifactFingerprint(
    serializeDurableCustodyProofArtifact(storedProofFromCustodyRow(proof)),
  );
  if (fingerprint !== proof.proofFingerprint) {
    throw new Error("browser V2 conflict recovery proof material conflicts");
  }
  return fingerprint;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function digestExactState(domain: string, value: string): string {
  const digest = sha256
    .create()
    .update(new TextEncoder().encode(`bitcaster/browser-backup-v2-conflict-recovery/${domain}\0`))
    .update(new TextEncoder().encode(value))
    .digest();
  return bytesToHex(digest);
}

function requireRemoteProofBinding(
  local: ReturnType<typeof decodeBrowserCustodyProofRow>,
  authority: BrowserProofBackupAuthorityRow,
  remote: EncryptedWalletBackupV2VerifiedProofSet["proofs"][number],
): void {
  if (
    local.proofFingerprint !==
      deriveDurableCustodyArtifactFingerprint(serializeDurableCustodyProofArtifact(remote.proof)) ||
    !sameBrowserProofDerivationLocator(authority.derivationLocator, remote.locator)
  ) {
    throw new Error("browser V2 conflict recovery proof material conflicts");
  }
  const live = remote.selectionAuthority === "live-verified";
  if (
    live !== (local.selectability === "selectable" && authority.terminalAuthority === null) ||
    (!live &&
      (local.selectability !== "verified-losing" || authority.terminalAuthority === null)) ||
    (!live &&
      authority.terminalAuthority?.kind === "remote-seal" &&
      authority.backupRecordCommitment !== remote.terminalSeal?.proofCommitment)
  ) {
    throw new Error("browser V2 conflict recovery proof authority conflicts");
  }
}

async function hasUnresolvedSubmittedWork(
  database: BitcasterDB,
  scopeId: string,
): Promise<boolean> {
  const [activeWork, reservation, activeRange, outgoingAuthority, outgoingMintRecovery, prepared] =
    await Promise.all([
      database.custodyActiveWork
        .where("[scopeId+operationId]")
        .between([scopeId, TEXT_KEY_MIN], [scopeId, TEXT_KEY_MAX])
        .first(),
      database.custodyReservations
        .where("[scopeId+operationId]")
        .between([scopeId, TEXT_KEY_MIN], [scopeId, TEXT_KEY_MAX])
        .first(),
      pageActiveCtfRangePreparations({ scopeId, limit: 1 }, database),
      database.outgoingCashuTransfers
        .where("[scopeId+localAuthorityState+transferId]")
        .between([scopeId, "nonterminal", TEXT_KEY_MIN], [scopeId, "nonterminal", TEXT_KEY_MAX])
        .first(),
      database.outgoingCashuTransfers
        .where("[scopeId+mintRecoveryState+dueAtMs+mintUrl+transferId]")
        .between([scopeId, "pending"], [scopeId, "pending", []], true, true)
        .first(),
      database.proofOperations.where("state").equals("prepared").first(),
    ]);
  if (
    activeWork !== undefined ||
    reservation !== undefined ||
    activeRange.preparations.length > 0 ||
    outgoingAuthority !== undefined ||
    outgoingMintRecovery !== undefined ||
    prepared !== undefined
  ) {
    return true;
  }
  const quotes = await database.mintQuotes
    .where("[scopeId+paymentMethod+recoveryState+lastRecoveryAttemptAtMs+quoteRecordId]")
    .between(
      [scopeId, "bolt11", "pending", Dexie.minKey, Dexie.minKey],
      [scopeId, "bolt11", "pending", Number.MAX_SAFE_INTEGER, TEXT_KEY_MAX],
    )
    .limit(ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX + 1)
    .toArray();
  if (quotes.length > ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX) return true;
  return quotes.some((row) => {
    const quote = decodeDurableBolt11MintQuote(row.quote);
    return quote.observedState !== "UNPAID" || quote.walletMintOperationAuthority !== null;
  });
}

async function readDesiredRows(database: BitcasterDB, scopeId: string) {
  const rows = await database.encryptedWalletBackupV2DesiredAssets
    .where("[scopeId+localAssetKey]")
    .between([scopeId, TEXT_KEY_MIN], [scopeId, TEXT_KEY_MAX])
    .limit(ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX + 1)
    .toArray();
  if (rows.length > ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX) {
    throw new Error("browser V2 conflict recovery desired asset limit exceeded");
  }
  return rows.map(decodeEncryptedWalletBackupV2DesiredAssetRow);
}

async function tryCollectHead(
  input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput,
): Promise<EncryptedWalletBackupV2CollectedHeadEvidence | null> {
  try {
    return await collectAllEncryptedWalletBackupV2DescriptorPages({
      issueRequestProof: (cursor) => requestProof(input, cursor),
      readDescriptorPage: ({ requestProof, afterBundleId }) => {
        requireCurrent(input);
        return input.remote.readDescriptorPage({
          requestProof,
          afterBundleId,
          signal: input.signal,
        });
      },
    });
  } catch (error) {
    if (isExpectedRemoteFailure(error)) return null;
    throw error;
  }
}

async function requestProof(
  input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput,
  cursor: string | null,
) {
  requireCurrent(input);
  const issuedAtUnixSeconds = input.nowUnixSeconds();
  return prepareEncryptedWalletBackupV2RequestProof({
    keyHandle: input.keyHandle,
    enrollmentEpoch: input.enrollmentEpoch,
    method: "GET",
    url: input.requestUrl("head", cursor),
    issuedAtUnixSeconds,
    expiresAtUnixSeconds: issuedAtUnixSeconds + 60,
    payload: new Uint8Array(),
    signal: input.signal,
    runtime: input.runtime,
  });
}

function sameCollectedHead(
  left: EncryptedWalletBackupV2CollectedHeadEvidence,
  right: EncryptedWalletBackupV2CollectedHeadEvidence,
): boolean {
  if (
    left.head.realm !== right.head.realm ||
    left.head.walletId !== right.head.walletId ||
    left.head.enrollmentEpoch !== right.head.enrollmentEpoch ||
    left.head.headVersion !== right.head.headVersion ||
    left.head.activeBundleCount !== right.head.activeBundleCount ||
    left.head.activeObjectCount !== right.head.activeObjectCount ||
    left.head.activeSetDigest !== right.head.activeSetDigest
  ) {
    return false;
  }
  return true;
}

function proofSnapshotToken(proof: ReturnType<typeof decodeBrowserCustodyProofRow>): string {
  return JSON.stringify([
    proof.scopeId,
    proof.normalizedMint,
    proof.unit,
    proof.assetKind,
    proof.conditionId,
    proof.outcomeCollection,
    proof.baseAsset,
    proof.proofId,
    proof.keysetId,
    proof.amount,
    proof.proofFingerprint,
    proof.curve,
    proof.dleqPresence,
    proof.revision,
    proof.selectability,
    proof.reservationOperationId,
    proof.receivedAtMs,
  ]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireRecoveryHead(
  input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput,
  head: EncryptedWalletBackupV2CollectedHeadEvidence,
): void {
  if (
    head.head.realm !== input.keyHandle.realm ||
    head.head.walletId !== input.keyHandle.walletId ||
    head.head.enrollmentEpoch !== input.enrollmentEpoch
  ) {
    throw new Error("browser V2 conflict recovery head is foreign");
  }
}

function authorityStore(input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput) {
  return new EncryptedWalletBackupV2DexieAuthorityStore({
    database: input.database,
    scopeId: input.scopeId,
    realm: input.keyHandle.realm,
    walletId: input.keyHandle.walletId,
    enrollmentEpoch: input.enrollmentEpoch,
    requestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
  });
}

function requireCurrent(input: BrowserEncryptedWalletBackupV2ConflictRecoveryInput): void {
  if (!input.isCurrentProfile() || input.signal.aborted) {
    throw new Error("browser V2 conflict recovery profile is stale");
  }
}

function incomplete(
  reason: BrowserEncryptedWalletBackupV2ConflictRecoveryIncompleteReason,
): Extract<BrowserEncryptedWalletBackupV2ConflictRecoveryResult, { kind: "incomplete" }> {
  return Object.freeze({ kind: "incomplete", reason });
}

function isExpectedRemoteFailure(error: unknown): boolean {
  return (
    error instanceof EncryptedWalletBackupV2HttpTransportError ||
    error instanceof NetworkError ||
    error instanceof RateLimitError ||
    (error instanceof HttpResponseError && error.status >= 500) ||
    isNetworkTypeError(error) ||
    (error instanceof DOMException &&
      (error.name === "NetworkError" || error.name === "TimeoutError"))
  );
}

function isNetworkTypeError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /connection|connect|dns|fetch|network|socket|timed? ?out|timeout/i.test(error.message)
  );
}

function isExpectedLocalRecheckFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "encrypted wallet backup v2 recovery is incomplete" ||
      error.message === "encrypted wallet backup v2 recovery status is stale")
  );
}

function isExpectedLocalReconciliationRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    [
      "browser mint-spent retirement proof is missing",
      "browser mint-spent retirement proof CAS is stale",
      "browser mint-spent retirement authority CAS is stale",
      "browser mint-spent retirement proof is reserved",
      "browser mint-spent retirement desired asset CAS is stale",
      "browser mint-spent retirement proof count is stale",
      "browser mint-spent retirement has active custody work",
      "browser mint-spent retirement has an unresolved custody operation",
      "browser V2 desired asset authority is missing",
      "browser V2 accepted-remote local proof is locked or pending",
      "browser V2 accepted-remote local proof is reserved",
      "browser V2 accepted-remote custody work is unfinished",
      "browser V2 accepted-remote local active proof is absent remotely",
      "browser V2 accepted-remote removal intent is unresolved",
      "browser V2 accepted-remote local proof changed during inspection",
      "browser V2 accepted-remote local state changed before commit",
      "browser V2 conflict recovery retired asset is absent",
      "browser V2 conflict recovery absent asset is not empty",
      "encrypted wallet backup v2 desired asset is stale",
    ].includes(error.message)
  );
}

function isExpectedLocalSnapshotChange(error: unknown): boolean {
  return (
    error instanceof Error &&
    [
      "browser V2 conflict recovery local asset is absent remotely",
      "browser V2 conflict recovery desired asset is incomplete",
      "browser V2 conflict recovery proof set is incomplete",
      "browser V2 conflict recovery local asset evidence changed",
      "browser V2 conflict recovery proof is absent remotely",
      "browser V2 conflict recovery proof material conflicts",
      "browser V2 conflict recovery admitted asset is missing locally",
      "browser V2 conflict recovery orphan active proof appeared",
      "browser V2 conflict recovery active proof set changed",
    ].includes(error.message)
  );
}
