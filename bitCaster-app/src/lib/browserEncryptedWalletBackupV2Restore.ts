import {
  collectAllEncryptedWalletBackupV2DescriptorPages,
  deserializeDurableCustodyProofArtifact,
  decryptEncryptedWalletBackupV2ProofSetBundle,
  deriveEncryptedWalletBackupV2AssetLocator,
  encryptedWalletBackupV2LocalAssetKey,
  prepareEncryptedWalletBackupV2RequestProof,
  verifyEncryptedWalletBackupV2RestoredProofSet,
  type EncryptedWalletBackupV2AssetIdentity,
  type EncryptedWalletBackupV2BundleRuntime,
  type EncryptedWalletBackupV2KeyHandle,
  type EncryptedWalletBackupV2RemotePort,
  type EncryptedWalletBackupV2RestoreVerificationPort,
  type EncryptedWalletBackupV2UnverifiedProofSet,
} from "@bitcaster/client-sdk";
import {
  hashToCurve,
  isBlsKeyset,
  verifyProofsForReceive,
  type ProofState,
  type Wallet as CashuWallet,
} from "@cashu/cashu-ts";
import type { BitcasterDB } from "../stores/proof-db";
import { addProofs, type StoredProof } from "../stores/proof-db";
import {
  readBrowserEncryptedWalletBackupV2AssetSnapshot,
  readBrowserEncryptedWalletBackupV2ExactLocalProofRows,
} from "../stores/browser-encrypted-wallet-backup-v2-asset-source";
import { decodeDurableCustodyProofMaterialRecord } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { admitBrowserEncryptedWalletBackupV2Asset } from "./browserEncryptedWalletBackupV2Admission";
import { retryBrowserEncryptedWalletBackupV2QuotaWrite } from "./browserEncryptedWalletBackupV2QuotaCleanup";
import { withWalletProfileLock } from "./walletProfileLock";
import { normalizeUrl } from "./url";

export type BrowserEncryptedWalletBackupV2TargetedRestoreResult =
  | { readonly kind: "local-custody" }
  | {
      readonly kind: "backup";
      readonly assetLocator: string;
      readonly bundleId: string;
      readonly custodyRevision: bigint;
      readonly headVersion: number;
      readonly unverified: EncryptedWalletBackupV2UnverifiedProofSet;
    };

export interface BrowserEncryptedWalletBackupV2TargetedRestoreInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly seed: Uint8Array;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly enrollmentEpoch: number;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly remote: EncryptedWalletBackupV2RemotePort;
  readonly requestUrl: (kind: "head" | "object", value: string | null) => string;
  readonly nowUnixSeconds: () => number;
  readonly runtime: EncryptedWalletBackupV2BundleRuntime;
  readonly signal: AbortSignal;
  readonly isCurrentProfile: () => boolean;
  readonly minimumAvailableAmount?: bigint;
}

export interface BrowserEncryptedWalletBackupV2RestoreAndAdmitInput extends BrowserEncryptedWalletBackupV2TargetedRestoreInput {
  readonly wallet: CashuWallet;
  readonly lockManager?: Pick<LockManager, "request">;
}

export type BrowserEncryptedWalletBackupV2RestoreAndAdmitResult =
  | { readonly kind: "local-custody" }
  | { readonly kind: "restored"; readonly bundleId: string; readonly headVersion: number };

/** Read local custody first, then one authenticated current V2 proof bundle. */
export async function restoreBrowserEncryptedWalletBackupV2TargetedAsset(
  input: BrowserEncryptedWalletBackupV2TargetedRestoreInput,
): Promise<BrowserEncryptedWalletBackupV2TargetedRestoreResult> {
  requireCurrent(input);
  if (input.minimumAvailableAmount !== undefined && input.minimumAvailableAmount < 0n) {
    throw new Error("browser V2 targeted restore minimum amount is invalid");
  }
  const localAmount = await readBrowserEncryptedWalletBackupV2LocalAvailableAmount(input);
  if (
    localAmount !== null &&
    (input.minimumAvailableAmount === undefined || localAmount >= input.minimumAvailableAmount)
  )
    return { kind: "local-custody" };
  const assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle: input.keyHandle,
    ...input.asset,
  });
  const head = await collectAllEncryptedWalletBackupV2DescriptorPages({
    issueRequestProof: (cursor) => requestProof(input, "head", cursor, new Uint8Array()),
    readDescriptorPage: ({ requestProof, afterBundleId }) => {
      requireCurrent(input);
      return input.remote.readDescriptorPage({ requestProof, afterBundleId, signal: input.signal });
    },
  });
  requireCurrent(input);
  if (
    head.head.realm !== input.keyHandle.realm ||
    head.head.walletId !== input.keyHandle.walletId ||
    head.head.enrollmentEpoch !== input.enrollmentEpoch
  ) {
    throw new Error("encrypted backup V2 current head is foreign");
  }
  const descriptor = head.bundles.find((candidate) => candidate.assetLocator === assetLocator);
  if (descriptor === undefined) throw new Error("encrypted backup V2 current asset is absent");
  const objects = [];
  for (const { objectId } of descriptor.objects) {
    const auth = await requestProof(input, "object", objectId, new Uint8Array());
    requireCurrent(input);
    objects.push(
      await input.remote.readObject({
        requestProof: auth,
        objectId,
        expectedDescriptor: descriptor,
        signal: input.signal,
      }),
    );
  }
  requireCurrent(input);
  const unverified = await decryptEncryptedWalletBackupV2ProofSetBundle({
    keyHandle: input.keyHandle,
    seed: input.seed,
    expectedAsset: input.asset,
    custodyRevision: descriptor.custodyRevision,
    descriptor,
    objects,
    runtime: input.runtime,
  });
  requireCurrent(input);
  return {
    kind: "backup",
    assetLocator,
    bundleId: descriptor.bundleId,
    custodyRevision: descriptor.custodyRevision,
    headVersion: head.head.headVersion,
    unverified,
  };
}

/** Verify and atomically admit one requested V2 asset, or repair its local cache. */
export async function restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset(
  input: BrowserEncryptedWalletBackupV2RestoreAndAdmitInput,
): Promise<BrowserEncryptedWalletBackupV2RestoreAndAdmitResult> {
  if (normalizeUrl(input.wallet.mint.mintUrl) !== normalizeUrl(input.asset.mintUrl)) {
    throw new Error("browser V2 restore mint is foreign");
  }
  const restored = await restoreBrowserEncryptedWalletBackupV2TargetedAsset(input);
  requireCurrent(input);
  if (restored.kind === "local-custody") {
    await withWalletProfileLock(
      input.scopeId,
      () => repairLegacyProofCache(input),
      input.lockManager,
    );
    return restored;
  }
  const verified = await verifyEncryptedWalletBackupV2RestoredProofSet({
    seed: input.seed,
    expectedAsset: input.asset,
    unverified: restored.unverified,
    port: restoreVerificationPort(input),
  });
  requireCurrent(input);
  await retryBrowserEncryptedWalletBackupV2QuotaWrite({
    database: input.database,
    scopeId: input.scopeId,
    isCurrentProfile: input.isCurrentProfile,
    protectedLocalAssetKeys: [encryptedWalletBackupV2LocalAssetKey(input.asset)],
    lockManager: input.lockManager,
    write: () =>
      admitBrowserEncryptedWalletBackupV2Asset({
        seed: input.seed,
        verified,
        asset: input.asset,
        custodyRevision: restored.custodyRevision,
        sourceOperationId: `backup-v2-restore:${restored.bundleId}`,
        wallet: input.wallet,
        database: input.database,
        scopeId: input.scopeId,
        isCurrentProfile: input.isCurrentProfile,
        lockManager: input.lockManager,
      }),
  });
  return { kind: "restored", bundleId: restored.bundleId, headVersion: restored.headVersion };
}

function restoreVerificationPort(
  input: BrowserEncryptedWalletBackupV2RestoreAndAdmitInput,
): EncryptedWalletBackupV2RestoreVerificationPort {
  return {
    async resolveKeyset({ mintUrl, unit, keysetId }) {
      requireCurrent(input);
      if (isBlsKeyset(keysetId)) throw new Error("browser V2 restore BLS keyset is unsupported");
      const keyset = input.wallet.getKeyset(keysetId);
      return {
        mintUrl,
        unit,
        keysetId,
        keyset,
        requireDleq: true,
        verify: () => keyset.id === keysetId && keyset.unit === unit && keyset.verify(),
      };
    },
    verifyProofs({ proofs, keysets }) {
      requireCurrent(input);
      verifyProofsForReceive([...proofs], (keysetId) => requiredRestoreKeyset(keysets, keysetId), {
        requireDleq: true,
      });
      requireCurrent(input);
    },
    async checkProofStates({ proofs }) {
      requireCurrent(input);
      const expectedByY = expectedProofIdsByY(proofs);
      const states = await input.wallet.checkProofsStates(
        proofs.map(({ id, secret }) => ({ id, secret })),
      );
      requireCurrent(input);
      return bindProofStates(expectedByY, states);
    },
  };
}

function requiredRestoreKeyset(
  keysets: ReadonlyMap<
    string,
    Awaited<ReturnType<EncryptedWalletBackupV2RestoreVerificationPort["resolveKeyset"]>>
  >,
  keysetId: string,
): ReturnType<CashuWallet["getKeyset"]> {
  const resolved = keysets.get(keysetId);
  if (resolved === undefined) throw new Error("browser V2 restore keyset is missing");
  return resolved.keyset as ReturnType<CashuWallet["getKeyset"]>;
}

function expectedProofIdsByY(
  proofs: readonly { readonly proofId: string; readonly id: string; readonly secret: string }[],
): ReadonlyMap<string, string> {
  const expected = new Map<string, string>();
  for (const proof of proofs) {
    if (isBlsKeyset(proof.id)) throw new Error("browser V2 restore BLS keyset is unsupported");
    const secret = new TextEncoder().encode(proof.secret);
    const Y = hashToCurve(secret).toHex(true);
    if (expected.has(Y)) throw new Error("browser V2 restore proof-state authority is duplicated");
    expected.set(Y, proof.proofId);
  }
  return expected;
}

function bindProofStates(
  expectedByY: ReadonlyMap<string, string>,
  states: readonly ProofState[],
): readonly { readonly proofId: string; readonly state: string }[] {
  if (states.length !== expectedByY.size)
    throw new Error("browser V2 restore proof-state authority is incomplete");
  const seen = new Set<string>();
  return states.map((state) => {
    const proofId = expectedByY.get(state.Y);
    if (proofId === undefined || seen.has(state.Y))
      throw new Error("browser V2 restore proof-state authority is foreign");
    seen.add(state.Y);
    return { proofId, state: state.state };
  });
}

async function repairLegacyProofCache(
  input: BrowserEncryptedWalletBackupV2RestoreAndAdmitInput,
): Promise<void> {
  requireCurrent(input);
  const rows = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
    database: input.database,
    scopeId: input.scopeId,
    asset: input.asset,
  });
  if (rows.length === 0) throw new Error("browser V2 local custody asset is absent");
  const proofs: StoredProof[] = rows.map((row) => {
    const { proof: material } = decodeDurableCustodyProofMaterialRecord(row);
    const proof = deserializeDurableCustodyProofArtifact({
      schemaVersion: 1,
      ...material,
    });
    return {
      ...proof,
      mintUrl: row.normalizedMint,
      baseAsset: row.baseAsset,
      unit: row.unit,
      ...(row.conditionId === null ? {} : { conditionId: row.conditionId }),
      ...(row.outcomeCollection === null ? {} : { outcomeCollection: row.outcomeCollection }),
      ...(row.reservationOperationId === null ? {} : { reservedBy: row.reservationOperationId }),
    };
  });
  requireCurrent(input);
  await addProofs(proofs, input.database);
  requireCurrent(input);
}

/** Returns one complete local asset's exact currently available amount. */
export async function readBrowserEncryptedWalletBackupV2LocalAvailableAmount(
  input: BrowserEncryptedWalletBackupV2TargetedRestoreInput,
): Promise<bigint | null> {
  const row = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    encryptedWalletBackupV2LocalAssetKey(input.asset),
  ]);
  requireCurrent(input);
  if (row === undefined) {
    if ((await exactLocalProofCount(input)) !== 0)
      throw new Error("browser V2 local custody asset authority is missing");
    return null;
  }
  const localProofs = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
    database: input.database,
    scopeId: input.scopeId,
    asset: input.asset,
  });
  requireCurrent(input);
  const localProofCount = localProofs.length;
  if (row.desiredAction === "remove")
    throw new Error("browser V2 local custody asset is marked for removal");
  if (localProofCount === 0 && row.syncState === "acknowledged") {
    if (row.desiredAction !== "replace") throw new Error("browser V2 desired asset is invalid");
    return null;
  }
  if (localProofCount !== row.activeProofCount)
    throw new Error("browser V2 local custody asset is partial");
  const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
    database: input.database,
    scopeId: input.scopeId,
    localAssetKey: row.localAssetKey,
  });
  requireCurrent(input);
  if (snapshot.proofs.length === 0) return null;
  return localProofs.reduce(
    (total, proof) => (proof.selectability === "selectable" ? total + BigInt(proof.amount) : total),
    0n,
  );
}

async function exactLocalProofCount(
  input: BrowserEncryptedWalletBackupV2TargetedRestoreInput,
): Promise<number> {
  const rows = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
    database: input.database,
    scopeId: input.scopeId,
    asset: input.asset,
  });
  requireCurrent(input);
  return rows.length;
}

async function requestProof(
  input: BrowserEncryptedWalletBackupV2TargetedRestoreInput,
  kind: "head" | "object",
  value: string | null,
  payload: Uint8Array,
) {
  requireCurrent(input);
  const issuedAtUnixSeconds = input.nowUnixSeconds();
  return prepareEncryptedWalletBackupV2RequestProof({
    keyHandle: input.keyHandle,
    enrollmentEpoch: input.enrollmentEpoch,
    method: "GET",
    url: input.requestUrl(kind, value),
    issuedAtUnixSeconds,
    expiresAtUnixSeconds: issuedAtUnixSeconds + 60,
    payload,
    signal: input.signal,
    runtime: input.runtime,
  });
}

function requireCurrent(input: BrowserEncryptedWalletBackupV2TargetedRestoreInput): void {
  if (!input.isCurrentProfile() || input.signal.aborted)
    throw new Error("browser V2 targeted restore profile is stale");
}
