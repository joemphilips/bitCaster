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
  type EncryptedWalletBackupV2CollectedHeadEvidence,
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
import {
  addProofs,
  storedProofFromCustodyRow,
  storedProofFromRow,
  type StoredProof,
} from "../stores/proof-db";
import {
  BrowserEncryptedWalletBackupV2LocalAssetReadError,
  readBrowserEncryptedWalletBackupV2LocalAssetRead,
  readBrowserEncryptedWalletBackupV2ExactLocalProofRows,
} from "../stores/browser-encrypted-wallet-backup-v2-asset-source";
import {
  decodeDurableCustodyProofMaterialRecord,
  serializeDurableCustodyProofArtifact,
} from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import {
  admitBrowserEncryptedWalletBackupV2Asset,
  admitBrowserEncryptedWalletBackupV2MixedAsset,
  admitBrowserEncryptedWalletBackupV2SealedAsset,
  type BrowserEncryptedWalletBackupV2AdmissionStage,
} from "./browserEncryptedWalletBackupV2Admission";
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
      readonly collectedHeadEvidence: EncryptedWalletBackupV2CollectedHeadEvidence;
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
  readonly reportTargetedRecoveryStage?: (
    stage: BrowserEncryptedWalletBackupV2RestoreStage,
  ) => void;
  readonly reportTargetedRecoveryFailureClass?: (
    failureClass: BrowserEncryptedWalletBackupV2FailureClass,
  ) => void;
}

export type BrowserEncryptedWalletBackupV2RestoreStage =
  | "backup-object"
  | "backup-decrypt"
  | "backup-verify"
  | "backup-admit"
  | "backup-admit-lock"
  | "backup-admit-authority"
  | "backup-admit-state"
  | "backup-admit-custody"
  | "backup-admit-counter"
  | "backup-admit-desired"
  | "backup-admit-desired-write"
  | "backup-admit-current-profile"
  | "backup-admit-transaction-commit"
  | "backup-admit-cache"
  | "backup-admit-postcheck";

export type BrowserEncryptedWalletBackupV2FailureClass =
  | "abort"
  | "constraint"
  | "data"
  | "database-closed"
  | "invalid-state"
  | "premature-commit"
  | "quota"
  | "transaction-inactive"
  | "unknown";

export class BrowserEncryptedWalletBackupV2LocalCustodyError extends Error {
  constructor(
    readonly code:
      | "removal"
      | "missing-authority"
      | "invalid-action"
      | "partial"
      | "stale-profile"
      | "proof-read"
      | "snapshot-read",
    message: string,
  ) {
    super(message);
    this.name = "BrowserEncryptedWalletBackupV2LocalCustodyError";
  }
}

export interface BrowserEncryptedWalletBackupV2RestoreAndAdmitInput extends BrowserEncryptedWalletBackupV2TargetedRestoreInput {
  /** Loads the mint wallet only when live proof verification or admission needs it. */
  readonly loadWallet: () => Promise<CashuWallet>;
  readonly lockManager?: Pick<LockManager, "request">;
}

export type BrowserEncryptedWalletBackupV2RestoreAndAdmitResult =
  | { readonly kind: "local-custody" }
  | { readonly kind: "restored"; readonly bundleId: string; readonly headVersion: number };

/** Read local custody first, then one authenticated current V2 proof bundle. */
export async function restoreBrowserEncryptedWalletBackupV2TargetedAsset(
  input: BrowserEncryptedWalletBackupV2TargetedRestoreInput,
): Promise<BrowserEncryptedWalletBackupV2TargetedRestoreResult> {
  requireProductMsatUnit(input.asset.unit);
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
  let assetLocator: string;
  let head: Awaited<ReturnType<typeof collectAllEncryptedWalletBackupV2DescriptorPages>>;
  let descriptor: (typeof head.bundles)[number];
  let objects: Awaited<ReturnType<EncryptedWalletBackupV2RemotePort["readObject"]>>[];
  try {
    assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
      keyHandle: input.keyHandle,
      ...input.asset,
    });
    head = await collectAllEncryptedWalletBackupV2DescriptorPages({
      issueRequestProof: (cursor) => requestProof(input, "head", cursor, new Uint8Array()),
      readDescriptorPage: ({ requestProof, afterBundleId }) => {
        requireCurrent(input);
        return input.remote.readDescriptorPage({
          requestProof,
          afterBundleId,
          signal: input.signal,
        });
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
    descriptor = head.bundles.find((candidate) => candidate.assetLocator === assetLocator)!;
    if (descriptor === undefined) throw new Error("encrypted backup V2 current asset is absent");
    objects = [];
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
  } catch (error) {
    reportStage(input, "backup-object");
    throw error;
  }
  let unverified: Awaited<ReturnType<typeof decryptEncryptedWalletBackupV2ProofSetBundle>>;
  try {
    unverified = await decryptEncryptedWalletBackupV2ProofSetBundle({
      keyHandle: input.keyHandle,
      seed: input.seed,
      expectedAsset: input.asset,
      custodyRevision: descriptor.custodyRevision,
      descriptor,
      objects,
      runtime: input.runtime,
    });
    requireCurrent(input);
  } catch (error) {
    reportStage(input, "backup-decrypt");
    throw error;
  }
  return {
    kind: "backup",
    assetLocator,
    bundleId: descriptor.bundleId,
    custodyRevision: descriptor.custodyRevision,
    headVersion: head.head.headVersion,
    collectedHeadEvidence: head,
    unverified,
  };
}

/** Verify and atomically admit one requested V2 asset, or repair its local cache. */
export async function restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset(
  input: BrowserEncryptedWalletBackupV2RestoreAndAdmitInput,
): Promise<BrowserEncryptedWalletBackupV2RestoreAndAdmitResult> {
  requireProductMsatUnit(input.asset.unit);
  const loadWallet = lazyWallet(input);
  const restored = await restoreBrowserEncryptedWalletBackupV2TargetedAsset(input);
  requireCurrent(input);
  if (restored.kind === "local-custody") {
    try {
      await withWalletProfileLock(
        input.scopeId,
        () => repairLegacyProofCache(input),
        input.lockManager,
      );
    } catch (error) {
      reportStage(input, "backup-admit");
      throw error;
    }
    return restored;
  }
  let verified: Awaited<ReturnType<typeof verifyEncryptedWalletBackupV2RestoredProofSet>>;
  let admissionStage: BrowserEncryptedWalletBackupV2RestoreStage = "backup-admit-lock";
  try {
    if (restored.unverified.proofs.some(({ terminalSeal }) => terminalSeal === undefined)) {
      const wallet = await loadWallet();
      if (normalizeUrl(wallet.mint.mintUrl) !== normalizeUrl(input.asset.mintUrl)) {
        throw new Error("browser V2 restore mint is foreign");
      }
    }
    verified = await verifyEncryptedWalletBackupV2RestoredProofSet({
      seed: input.seed,
      expectedAsset: input.asset,
      unverified: restored.unverified,
      port: restoreVerificationPort(input, loadWallet),
    });
    requireCurrent(input);
  } catch (error) {
    reportStage(input, "backup-verify");
    throw error;
  }
  try {
    const allSealed =
      verified.proofs.length > 0 &&
      verified.proofs.every(
        ({ selectionAuthority }) => selectionAuthority === "terminal-sealed-non-selectable",
      );
    if (allSealed) {
      await retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database: input.database,
        scopeId: input.scopeId,
        isCurrentProfile: input.isCurrentProfile,
        protectedLocalAssetKeys: [encryptedWalletBackupV2LocalAssetKey(input.asset)],
        lockManager: input.lockManager,
        write: () =>
          admitBrowserEncryptedWalletBackupV2SealedAsset({
            seed: input.seed,
            verified,
            asset: input.asset,
            custodyRevision: restored.custodyRevision,
            sourceOperationId: `backup-v2-restore:${restored.bundleId}`,
            database: input.database,
            scopeId: input.scopeId,
            isCurrentProfile: input.isCurrentProfile,
            lockManager: input.lockManager,
            setTargetedRecoveryAdmissionStage: (stage) => {
              admissionStage = stage;
            },
          }),
      });
      return { kind: "restored", bundleId: restored.bundleId, headVersion: restored.headVersion };
    }
    const wallet = await loadWallet();
    const hasSealed = verified.proofs.some(
      ({ selectionAuthority }) => selectionAuthority === "terminal-sealed-non-selectable",
    );
    await retryBrowserEncryptedWalletBackupV2QuotaWrite({
      database: input.database,
      scopeId: input.scopeId,
      isCurrentProfile: input.isCurrentProfile,
      protectedLocalAssetKeys: [encryptedWalletBackupV2LocalAssetKey(input.asset)],
      lockManager: input.lockManager,
      write: () => {
        const admission = {
          seed: input.seed,
          verified,
          asset: input.asset,
          custodyRevision: restored.custodyRevision,
          sourceOperationId: `backup-v2-restore:${restored.bundleId}`,
          wallet,
          database: input.database,
          scopeId: input.scopeId,
          isCurrentProfile: input.isCurrentProfile,
          lockManager: input.lockManager,
          setTargetedRecoveryAdmissionStage: (
            stage: BrowserEncryptedWalletBackupV2AdmissionStage,
          ) => {
            admissionStage = stage;
          },
        };
        return hasSealed
          ? admitBrowserEncryptedWalletBackupV2MixedAsset(admission)
          : admitBrowserEncryptedWalletBackupV2Asset(admission);
      },
    });
  } catch (error) {
    reportStage(input, admissionStage);
    input.reportTargetedRecoveryFailureClass?.(classifyFailure(error));
    throw error;
  }
  return { kind: "restored", bundleId: restored.bundleId, headVersion: restored.headVersion };
}

function requireProductMsatUnit(unit: unknown): asserts unit is "msat" {
  if (unit !== "msat") throw new Error("browser V2 product restore requires msat");
}

function reportStage(
  input: BrowserEncryptedWalletBackupV2TargetedRestoreInput,
  stage: BrowserEncryptedWalletBackupV2RestoreStage,
): void {
  input.reportTargetedRecoveryStage?.(stage);
}

function classifyFailure(error: unknown): BrowserEncryptedWalletBackupV2FailureClass {
  if (!(error instanceof Error)) return "unknown";
  switch (error.name) {
    case "AbortError":
      return "abort";
    case "ConstraintError":
      return "constraint";
    case "DataError":
      return "data";
    case "DatabaseClosedError":
      return "database-closed";
    case "InvalidStateError":
      return "invalid-state";
    case "PrematureCommitError":
      return "premature-commit";
    case "QuotaExceededError":
      return "quota";
    case "TransactionInactiveError":
      return "transaction-inactive";
    default:
      return "unknown";
  }
}

function restoreVerificationPort(
  input: BrowserEncryptedWalletBackupV2RestoreAndAdmitInput,
  loadWallet: () => Promise<CashuWallet>,
): EncryptedWalletBackupV2RestoreVerificationPort {
  return {
    async resolveKeyset({ mintUrl, unit, keysetId }) {
      requireCurrent(input);
      if (isBlsKeyset(keysetId)) throw new Error("browser V2 restore BLS keyset is unsupported");
      const wallet = await loadWallet();
      const keyset = wallet.getKeyset(keysetId);
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
      const wallet = await loadWallet();
      const states = await wallet.checkProofsStates(
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
  const cacheRows = rows.filter(
    ({ selectability }) => selectability === "selectable" || selectability === "locked",
  );
  await removeStaleNonSelectableLegacyProofCacheRows(input.database, rows);
  if (cacheRows.length === 0) return;
  const proofs: StoredProof[] = cacheRows.map((row) => {
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

async function removeStaleNonSelectableLegacyProofCacheRows(
  database: BitcasterDB,
  rows: ReadonlyArray<
    Awaited<ReturnType<typeof readBrowserEncryptedWalletBackupV2ExactLocalProofRows>>[number]
  >,
): Promise<void> {
  const nonSelectableProofs = rows
    .filter(
      ({ selectability }) =>
        selectability === "verified-losing" || selectability === "pending-removal",
    )
    .map((row) => storedProofFromCustodyRow(row));
  if (nonSelectableProofs.length === 0) return;
  const cached = await database.proofs.bulkGet(nonSelectableProofs.map(({ secret }) => secret));
  const removableSecrets = cached.flatMap((row, index) => {
    if (row === undefined) return [];
    const proof = storedProofFromRow(row);
    const expected = nonSelectableProofs[index]!;
    const metadataMatches =
      proof.mintUrl === expected.mintUrl &&
      proof.unit === expected.unit &&
      proof.conditionId === expected.conditionId &&
      proof.outcomeCollection === expected.outcomeCollection &&
      (proof.baseAsset === undefined || proof.baseAsset === expected.baseAsset) &&
      (proof.marketId === undefined ||
        proof.marketId === `${expected.conditionId}-${expected.outcomeCollection}`);
    const bodyMatches =
      deriveDurableCustodyArtifactFingerprint(serializeDurableCustodyProofArtifact(proof)) ===
      deriveDurableCustodyArtifactFingerprint(serializeDurableCustodyProofArtifact(expected));
    if (!metadataMatches || !bodyMatches) {
      // Preserve only rows that the legacy spend selectors definitely hide.
      if (isDefinitelyNonSpendableLegacyProof(proof)) return [];
      throw new Error("browser V2 losing legacy proof cache conflicts");
    }
    if (isDefinitelyNonSpendableLegacyProof(proof)) return [];
    return [row.secret];
  });
  if (removableSecrets.length > 0) await database.proofs.bulkDelete(removableSecrets);
}

function isDefinitelyNonSpendableLegacyProof(proof: StoredProof): boolean {
  return (
    (typeof proof.reservedBy === "string" && proof.reservedBy.length > 0) ||
    proof.terminalOperationId !== undefined
  );
}

/** Returns one complete local asset's exact currently available amount. */
export async function readBrowserEncryptedWalletBackupV2LocalAvailableAmount(
  input: BrowserEncryptedWalletBackupV2TargetedRestoreInput,
): Promise<bigint | null> {
  let local: Awaited<ReturnType<typeof readBrowserEncryptedWalletBackupV2LocalAssetRead>>;
  requireCurrentForLocalCustody(input);
  try {
    local = await readBrowserEncryptedWalletBackupV2LocalAssetRead({
      database: input.database,
      scopeId: input.scopeId,
      asset: input.asset,
    });
  } catch (error) {
    if (error instanceof BrowserEncryptedWalletBackupV2LocalAssetReadError)
      throw localCustodyError(error.code, error.message);
    throw localCustodyError("proof-read", "browser V2 local custody proof read failed");
  }
  requireCurrentForLocalCustody(input);
  if (local.desired === null) {
    if (local.activeProofs.length === 0) return null;
    if (local.backupEligibleProofCount === 0) return 0n;
    throw localCustodyError(
      "missing-authority",
      "browser V2 local custody asset authority is missing",
    );
  }
  const row = local.desired;
  if (row.desiredAction === "remove") {
    if (local.backupEligibleProofCount !== 0) {
      throw localCustodyError("partial", "browser V2 local custody asset is partial");
    }
    return 0n;
  }
  if (local.activeProofs.length === 0 && row.syncState === "acknowledged") {
    return null;
  }
  if (local.backupEligibleProofCount !== row.activeProofCount)
    throw localCustodyError("partial", "browser V2 local custody asset is partial");
  if (local.snapshot === null)
    throw localCustodyError("snapshot-read", "browser V2 local custody snapshot read failed");
  return local.activeProofs.reduce(
    (total, proof) => (proof.selectability === "selectable" ? total + BigInt(proof.amount) : total),
    0n,
  );
}

function localCustodyError(
  code: ConstructorParameters<typeof BrowserEncryptedWalletBackupV2LocalCustodyError>[0],
  message: string,
): BrowserEncryptedWalletBackupV2LocalCustodyError {
  return new BrowserEncryptedWalletBackupV2LocalCustodyError(code, message);
}

function requireCurrentForLocalCustody(
  input: BrowserEncryptedWalletBackupV2TargetedRestoreInput,
): void {
  try {
    requireCurrent(input);
  } catch {
    throw localCustodyError("stale-profile", "browser V2 targeted restore profile is stale");
  }
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

function lazyWallet(input: BrowserEncryptedWalletBackupV2RestoreAndAdmitInput) {
  let pending: Promise<CashuWallet> | undefined;
  return async (): Promise<CashuWallet> => {
    if (pending === undefined) {
      requireCurrent(input);
      pending = input.loadWallet();
    }
    const wallet = await pending;
    requireCurrent(input);
    return wallet;
  };
}
