import {
  createEncryptedWalletBackupV2AssetIdentity,
  decodeEncryptedWalletBackupV2AssetIdentity,
  ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX,
  encryptedWalletBackupV2LocalAssetKey,
} from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { EncryptedWalletBackupV2ProofSetAsset } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import type { EncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk/encryptedWalletBackupV2Bundle";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  decodeCanonicalMintOrigin,
  decodeDurableCustodyScopeInput,
  decodeDurableCustodyScopeId,
} from "@bitcaster/client-sdk/durableCustody";
import {
  requireRealm,
  requireUtf8Text as requireBackupUtf8Text,
} from "@bitcaster/client-sdk/encryptedWalletBackupServerValidation";
import {
  requireBrowserProofBackupAuthorityRow,
  requireBrowserProofBackupAuthorityForProof,
  type BrowserProofDerivationLocatorAuthority,
  type BrowserProofBackupAuthorityRow,
} from "./browser-proof-backup-authority";
import { decodeBrowserCustodyConditionalKeysetRow } from "./durable-custody-types";
import { decodeBrowserCustodyProofRow } from "./durable-custody-types";
import type { BrowserCustodyProofRow, BrowserCustodyProofUnit } from "./durable-custody-types";
import type { BitcasterDB } from "./proof-db";

export type EncryptedWalletBackupV2DesiredAction = "replace" | "remove";

export interface EncryptedWalletBackupV2RemovalProofTuple {
  readonly proofId: string;
  readonly proofFingerprint: string;
  readonly proofRevision: number;
  readonly proofCommitment: string;
}

export interface EncryptedWalletBackupV2ReceiptRemovalExclusionEvidence {
  readonly kind: "receipt";
  readonly headVersion: number;
  readonly activeSetDigest: string;
  readonly receiptDigest: string;
  readonly bundleId: string | null;
  readonly bundleDescriptorDigest: string | null;
  readonly supersededBundleIds: readonly string[];
  readonly acknowledgedAtMs: number;
}

export interface EncryptedWalletBackupV2CurrentHeadRemovalExclusionEvidence {
  readonly kind: "current-head";
  readonly headVersion: number;
  readonly activeSetDigest: string;
  readonly bundleId: string | null;
  readonly bundleDescriptorDigest: string | null;
  readonly acknowledgedAtMs: number;
}

export type EncryptedWalletBackupV2RemovalExclusionEvidence =
  | EncryptedWalletBackupV2ReceiptRemovalExclusionEvidence
  | EncryptedWalletBackupV2CurrentHeadRemovalExclusionEvidence;

export type EncryptedWalletBackupV2RemovalIntentState = "pending" | "exclusion-acknowledged";

export interface EncryptedWalletBackupV2RemovalIntent {
  readonly intentId: string;
  readonly createdAtMs: number;
  readonly realm: string;
  readonly walletId: string;
  readonly enrollmentEpoch: number;
  readonly expectedHeadVersion: number;
  readonly expectedActiveSetDigest: string;
  readonly targetCustodyRevision: string;
  readonly proofs: readonly EncryptedWalletBackupV2RemovalProofTuple[];
  readonly proofSetCommitment: string;
  readonly state: EncryptedWalletBackupV2RemovalIntentState;
  readonly acknowledgedExclusionEvidence: EncryptedWalletBackupV2RemovalExclusionEvidence | null;
}

const REMOVAL_SET_COMMITMENT_DOMAIN = "bitcaster/encrypted-wallet-backup-v2-removal-set/v1\0";
const REMOVAL_INTENT_MAX_TEXT_BYTES = 256;
const REMOVAL_INTENT_MAX_SUPERSEDED_BUNDLES = 256;

export function digestEncryptedWalletBackupV2RemovalProofSet(
  proofs: readonly EncryptedWalletBackupV2RemovalProofTuple[],
): string {
  const normalized = decodeRemovalProofTuples(proofs);
  return bytesToHex(
    sha256
      .create()
      .update(new TextEncoder().encode(REMOVAL_SET_COMMITMENT_DOMAIN))
      .update(
        encodeCanonicalBackupCbor(
          normalized.map((proof) => [
            hexBytes(proof.proofId, 32),
            hexBytes(proof.proofFingerprint, 32),
            proof.proofRevision,
            hexBytes(proof.proofCommitment, 32),
          ]),
        ),
      )
      .digest(),
  );
}

export function createEncryptedWalletBackupV2RemovalIntent(input: {
  readonly intentId: string;
  readonly createdAtMs: number;
  readonly realm: string;
  readonly walletId: string;
  readonly enrollmentEpoch: number;
  readonly expectedHeadVersion: number;
  readonly expectedActiveSetDigest: string;
  readonly targetCustodyRevision: bigint | string;
  readonly proofs: readonly EncryptedWalletBackupV2RemovalProofTuple[];
  readonly proofSetCommitment?: string;
  readonly state?: EncryptedWalletBackupV2RemovalIntentState;
  readonly acknowledgedExclusionEvidence?: EncryptedWalletBackupV2RemovalExclusionEvidence | null;
}): EncryptedWalletBackupV2RemovalIntent {
  const normalizedProofs = decodeRemovalProofTuples(input.proofs);
  const proofSetCommitment = digestEncryptedWalletBackupV2RemovalProofSet(normalizedProofs);
  if (
    input.proofSetCommitment !== undefined &&
    requireRemovalLowerHex(input.proofSetCommitment, "proof set commitment") !== proofSetCommitment
  ) {
    throw new Error("browser V2 removal intent proof set commitment is invalid");
  }
  const evidence =
    input.acknowledgedExclusionEvidence === undefined ||
    input.acknowledgedExclusionEvidence === null
      ? null
      : decodeRemovalExclusionEvidence(input.acknowledgedExclusionEvidence);
  return decodeEncryptedWalletBackupV2RemovalIntent({
    intentId: input.intentId,
    createdAtMs: input.createdAtMs,
    realm: input.realm,
    walletId: input.walletId,
    enrollmentEpoch: input.enrollmentEpoch,
    expectedHeadVersion: input.expectedHeadVersion,
    expectedActiveSetDigest: input.expectedActiveSetDigest,
    targetCustodyRevision: decimalUint64(
      typeof input.targetCustodyRevision === "bigint"
        ? input.targetCustodyRevision
        : parseDecimalUint64(input.targetCustodyRevision),
    ),
    proofs: normalizedProofs,
    proofSetCommitment,
    state: input.state ?? (evidence === null ? "pending" : "exclusion-acknowledged"),
    acknowledgedExclusionEvidence: evidence,
  });
}

export function decodeEncryptedWalletBackupV2RemovalIntent(
  value: unknown,
): EncryptedWalletBackupV2RemovalIntent {
  if (!isRecord(value) || !exactKeys(value, removalIntentFields)) {
    throw new Error("browser V2 removal intent is invalid");
  }
  const proofs = decodeRemovalProofTuples(value.proofs);
  const proofSetCommitment = requireRemovalLowerHex(
    value.proofSetCommitment,
    "proof set commitment",
  );
  if (digestEncryptedWalletBackupV2RemovalProofSet(proofs) !== proofSetCommitment) {
    throw new Error("browser V2 removal intent proof set commitment is invalid");
  }
  const state = requireRemovalIntentState(value.state);
  const evidence =
    value.acknowledgedExclusionEvidence === null
      ? null
      : decodeRemovalExclusionEvidence(value.acknowledgedExclusionEvidence);
  if ((state === "pending") !== (evidence === null)) {
    throw new Error("browser V2 removal intent exclusion evidence is inconsistent");
  }
  return Object.freeze({
    intentId: requireBoundedText(value.intentId, "intent id"),
    createdAtMs: requireNonnegativeSafeInteger(value.createdAtMs, "creation time"),
    realm: requireRealm(value.realm),
    walletId: requireRemovalLowerHex(value.walletId, "wallet id"),
    enrollmentEpoch: requirePositiveSafeInteger(value.enrollmentEpoch, "enrollment epoch"),
    expectedHeadVersion: requireNonnegativeSafeInteger(
      value.expectedHeadVersion,
      "expected head version",
    ),
    expectedActiveSetDigest: requireRemovalLowerHex(
      value.expectedActiveSetDigest,
      "expected active-set digest",
    ),
    targetCustodyRevision: decimalUint64(parseDecimalUint64(value.targetCustodyRevision)),
    proofs,
    proofSetCommitment,
    state,
    acknowledgedExclusionEvidence: evidence,
  });
}

export function sameEncryptedWalletBackupV2RemovalIntent(
  left: EncryptedWalletBackupV2RemovalIntent | null,
  right: EncryptedWalletBackupV2RemovalIntent | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (
    left.intentId !== right.intentId ||
    left.createdAtMs !== right.createdAtMs ||
    left.realm !== right.realm ||
    left.walletId !== right.walletId ||
    left.enrollmentEpoch !== right.enrollmentEpoch ||
    left.expectedHeadVersion !== right.expectedHeadVersion ||
    left.expectedActiveSetDigest !== right.expectedActiveSetDigest ||
    left.targetCustodyRevision !== right.targetCustodyRevision ||
    left.proofSetCommitment !== right.proofSetCommitment ||
    left.state !== right.state
  )
    return false;
  if (
    left.proofs.length !== right.proofs.length ||
    left.proofs.some((proof, index) => !sameRemovalProofTuple(proof, right.proofs[index]!))
  )
    return false;
  return sameRemovalExclusionEvidence(
    left.acknowledgedExclusionEvidence,
    right.acknowledgedExclusionEvidence,
  );
}

const removalIntentFields = [
  "intentId",
  "createdAtMs",
  "realm",
  "walletId",
  "enrollmentEpoch",
  "expectedHeadVersion",
  "expectedActiveSetDigest",
  "targetCustodyRevision",
  "proofs",
  "proofSetCommitment",
  "state",
  "acknowledgedExclusionEvidence",
] as const;

/** Structural CTF identity retained when a mint keyset is no longer available. */
export type EncryptedWalletBackupV2TerminalCtfContext = Omit<
  Extract<EncryptedWalletBackupV2ProofSetAsset, { readonly kind: "ctf" }>,
  "kind"
>;

/** The latest V2 replacement or removal intent for one local asset. */
export interface EncryptedWalletBackupV2DesiredAssetRow extends EncryptedWalletBackupV2AssetIdentity {
  readonly scopeId: string;
  readonly localAssetKey: string;
  readonly custodyRevision: string;
  readonly activeProofCount: number;
  readonly desiredAction: EncryptedWalletBackupV2DesiredAction;
  readonly syncState: "pending" | "acknowledged";
  readonly terminalCtfContext: EncryptedWalletBackupV2TerminalCtfContext | null;
  readonly removalIntent: EncryptedWalletBackupV2RemovalIntent | null;
}

export function createEncryptedWalletBackupV2DesiredAssetRow(input: {
  readonly scopeId: string;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly custodyRevision: bigint;
  readonly activeProofCount: number;
  /**
   * Pass the complete CTF tuple from an SDK-verified proof or local keyset.
   * CTF rows used only to derive a local asset key may leave this null.
   */
  readonly terminalCtfContext?: EncryptedWalletBackupV2TerminalCtfContext | null;
  readonly removalIntent?: EncryptedWalletBackupV2RemovalIntent | null;
}): EncryptedWalletBackupV2DesiredAssetRow {
  const asset = decodeEncryptedWalletBackupV2AssetIdentity(input.asset);
  return decodeEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: input.scopeId,
    localAssetKey: encryptedWalletBackupV2LocalAssetKey(asset),
    ...asset,
    custodyRevision: decimalUint64(input.custodyRevision),
    activeProofCount: requireActiveProofCount(input.activeProofCount),
    desiredAction: input.activeProofCount === 0 ? "remove" : "replace",
    syncState: "pending",
    terminalCtfContext: input.terminalCtfContext ?? null,
    removalIntent: input.removalIntent ?? null,
  });
}

export function decodeEncryptedWalletBackupV2DesiredAssetRow(
  value: unknown,
): EncryptedWalletBackupV2DesiredAssetRow {
  if (!isRecord(value) || !exactKeys(value, rowFields)) {
    throw new Error("browser V2 desired asset row is invalid");
  }
  const scopeId = decodeDurableCustodyScopeId(value.scopeId);
  const custodyScope = decodeDurableCustodyScopeInput(scopeId);
  if (custodyScope.scopeKind !== "wallet") {
    throw new Error("browser V2 desired asset scope is not a wallet scope");
  }
  const asset = decodeEncryptedWalletBackupV2AssetIdentity({
    mintUrl: value.mintUrl,
    unit: value.unit,
    assetIdentity: value.assetIdentity,
  });
  const localAssetKey = encryptedWalletBackupV2LocalAssetKey(asset);
  if (value.localAssetKey !== localAssetKey) {
    throw new Error("browser V2 desired asset key is invalid");
  }
  const activeProofCount = requireActiveProofCount(value.activeProofCount);
  const desiredAction = requireAction(value.desiredAction);
  if ((activeProofCount === 0 ? "remove" : "replace") !== desiredAction) {
    throw new Error("browser V2 desired asset action is inconsistent");
  }
  const terminalCtfContext = decodeTerminalCtfContext(value.terminalCtfContext);
  const removalIntent =
    value.removalIntent === null
      ? null
      : decodeEncryptedWalletBackupV2RemovalIntent(value.removalIntent);
  const custodyRevision = decimalUint64(parseDecimalUint64(value.custodyRevision));
  if (removalIntent !== null && removalIntent.targetCustodyRevision !== custodyRevision) {
    throw new Error("browser V2 desired asset removal intent target revision is stale");
  }
  if (removalIntent !== null && custodyScope.walletId !== removalIntent.walletId) {
    throw new Error("browser V2 desired asset removal intent wallet scope is foreign");
  }
  if (removalIntent !== null && asset.assetIdentity === "cashu:ordinary") {
    throw new Error("browser V2 desired asset removal intent is foreign");
  }
  if (asset.assetIdentity === "cashu:ordinary") {
    if (terminalCtfContext !== null) {
      throw new Error("browser V2 desired asset CTF context is foreign");
    }
  } else if (
    terminalCtfContext !== null &&
    `ctf:${terminalCtfContext.conditionId}:${terminalCtfContext.outcomeCollectionId}` !==
      asset.assetIdentity
  ) {
    throw new Error("browser V2 desired asset CTF context is foreign");
  }
  return {
    scopeId,
    localAssetKey,
    ...asset,
    custodyRevision,
    activeProofCount,
    desiredAction,
    syncState: requireSyncState(value.syncState),
    terminalCtfContext,
    removalIntent,
  };
}

export function incrementEncryptedWalletBackupV2DesiredAssetRevision(value: bigint): bigint {
  const revision = parseDecimalUint64(decimalUint64(value));
  if (revision === UINT64_MAX) {
    throw new Error("browser V2 desired asset revision exceeds uint64");
  }
  return revision + 1n;
}

const rowFields = [
  "scopeId",
  "localAssetKey",
  "mintUrl",
  "unit",
  "assetIdentity",
  "custodyRevision",
  "activeProofCount",
  "desiredAction",
  "syncState",
  "terminalCtfContext",
  "removalIntent",
] as const;
const UINT64_MAX = (1n << 64n) - 1n;

function decimalUint64(value: bigint): string {
  if (value < 0n || value > UINT64_MAX) {
    throw new Error("browser V2 desired asset revision is invalid");
  }
  return value.toString();
}

function parseDecimalUint64(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error("browser V2 desired asset revision is invalid");
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) throw new Error("browser V2 desired asset revision is invalid");
  return parsed;
}

function decodeRemovalProofTuples(
  value: unknown,
): readonly EncryptedWalletBackupV2RemovalProofTuple[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX
  ) {
    throw new Error("browser V2 removal intent proofs are invalid");
  }
  const proofs = Object.freeze(
    value.map((item) => {
      if (!isRecord(item) || !exactKeys(item, removalProofTupleFields)) {
        throw new Error("browser V2 removal intent proof tuple is invalid");
      }
      return Object.freeze({
        proofId: requireRemovalLowerHex(item.proofId, "proof id"),
        proofFingerprint: requireRemovalLowerHex(item.proofFingerprint, "proof fingerprint"),
        proofRevision: requireNonnegativeSafeInteger(item.proofRevision, "proof revision"),
        proofCommitment: requireRemovalLowerHex(item.proofCommitment, "proof commitment"),
      });
    }),
  );
  for (let index = 1; index < proofs.length; index += 1) {
    if (proofs[index - 1]!.proofId >= proofs[index]!.proofId) {
      throw new Error("browser V2 removal intent proofs are unordered or duplicated");
    }
  }
  return proofs;
}

const removalProofTupleFields = [
  "proofId",
  "proofFingerprint",
  "proofRevision",
  "proofCommitment",
] as const;

function decodeRemovalExclusionEvidence(
  value: unknown,
): EncryptedWalletBackupV2RemovalExclusionEvidence {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("browser V2 removal intent exclusion evidence is invalid");
  }
  switch (value.kind) {
    case "receipt": {
      if (!exactKeys(value, removalReceiptExclusionEvidenceFields)) {
        throw new Error("browser V2 removal intent exclusion evidence is invalid");
      }
      const { bundleId, bundleDescriptorDigest } = decodeExclusionBundle(value);
      return Object.freeze({
        kind: "receipt",
        headVersion: requireNonnegativeSafeInteger(value.headVersion, "exclusion head version"),
        activeSetDigest: requireRemovalLowerHex(
          value.activeSetDigest,
          "exclusion active-set digest",
        ),
        receiptDigest: requireRemovalLowerHex(value.receiptDigest, "exclusion receipt digest"),
        bundleId,
        bundleDescriptorDigest,
        supersededBundleIds: decodeSortedBundleIds(value.supersededBundleIds),
        acknowledgedAtMs: requireNonnegativeSafeInteger(
          value.acknowledgedAtMs,
          "exclusion acknowledgement time",
        ),
      });
    }
    case "current-head": {
      if (!exactKeys(value, removalCurrentHeadExclusionEvidenceFields)) {
        throw new Error("browser V2 removal intent exclusion evidence is invalid");
      }
      const { bundleId, bundleDescriptorDigest } = decodeExclusionBundle(value);
      return Object.freeze({
        kind: "current-head",
        headVersion: requireNonnegativeSafeInteger(value.headVersion, "exclusion head version"),
        activeSetDigest: requireRemovalLowerHex(
          value.activeSetDigest,
          "exclusion active-set digest",
        ),
        bundleId,
        bundleDescriptorDigest,
        acknowledgedAtMs: requireNonnegativeSafeInteger(
          value.acknowledgedAtMs,
          "exclusion acknowledgement time",
        ),
      });
    }
    default:
      throw new Error("browser V2 removal intent exclusion evidence is invalid");
  }
}

const removalReceiptExclusionEvidenceFields = [
  "kind",
  "headVersion",
  "activeSetDigest",
  "receiptDigest",
  "bundleId",
  "bundleDescriptorDigest",
  "supersededBundleIds",
  "acknowledgedAtMs",
] as const;

const removalCurrentHeadExclusionEvidenceFields = [
  "kind",
  "headVersion",
  "activeSetDigest",
  "bundleId",
  "bundleDescriptorDigest",
  "acknowledgedAtMs",
] as const;

function decodeExclusionBundle(value: Record<string, unknown>): {
  readonly bundleId: string | null;
  readonly bundleDescriptorDigest: string | null;
} {
  const bundleId =
    value.bundleId === null ? null : requireRemovalLowerHex(value.bundleId, "bundle id", 16);
  const bundleDescriptorDigest =
    value.bundleDescriptorDigest === null
      ? null
      : requireRemovalLowerHex(value.bundleDescriptorDigest, "bundle descriptor digest");
  if ((bundleId === null) !== (bundleDescriptorDigest === null)) {
    throw new Error("browser V2 removal intent exclusion evidence is invalid");
  }
  return { bundleId, bundleDescriptorDigest };
}

function decodeSortedBundleIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > REMOVAL_INTENT_MAX_SUPERSEDED_BUNDLES) {
    throw new Error("browser V2 removal intent bundle ids are invalid");
  }
  const ids = Object.freeze(
    value.map((item) => requireRemovalLowerHex(item, "superseded bundle id", 16)),
  );
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index - 1]! >= ids[index]!) {
      throw new Error("browser V2 removal intent bundle ids are unordered or duplicated");
    }
  }
  return ids;
}

function sameRemovalProofTuple(
  left: EncryptedWalletBackupV2RemovalProofTuple,
  right: EncryptedWalletBackupV2RemovalProofTuple,
): boolean {
  return (
    left.proofId === right.proofId &&
    left.proofFingerprint === right.proofFingerprint &&
    left.proofRevision === right.proofRevision &&
    left.proofCommitment === right.proofCommitment
  );
}

function sameRemovalExclusionEvidence(
  left: EncryptedWalletBackupV2RemovalExclusionEvidence | null,
  right: EncryptedWalletBackupV2RemovalExclusionEvidence | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (
    left.kind !== right.kind ||
    left.headVersion !== right.headVersion ||
    left.activeSetDigest !== right.activeSetDigest ||
    left.bundleId !== right.bundleId ||
    left.bundleDescriptorDigest !== right.bundleDescriptorDigest ||
    left.acknowledgedAtMs !== right.acknowledgedAtMs
  )
    return false;
  if (left.kind === "current-head" && right.kind === "current-head") return true;
  if (left.kind !== "receipt" || right.kind !== "receipt") return false;
  return (
    left.receiptDigest === right.receiptDigest &&
    left.supersededBundleIds.length === right.supersededBundleIds.length &&
    left.supersededBundleIds.every((id, index) => id === right.supersededBundleIds[index])
  );
}

function requireRemovalIntentState(value: unknown): EncryptedWalletBackupV2RemovalIntentState {
  if (value === "pending" || value === "exclusion-acknowledged") return value;
  throw new Error("browser V2 removal intent state is invalid");
}

function requireBoundedText(value: unknown, label: string): string {
  try {
    return requireBackupUtf8Text(value, REMOVAL_INTENT_MAX_TEXT_BYTES, label);
  } catch {
    throw new Error(`browser V2 removal intent ${label} is invalid`);
  }
}

function requireNonnegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`browser V2 removal intent ${label} is invalid`);
  }
  return value as number;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const number = requireNonnegativeSafeInteger(value, label);
  if (number < 1) throw new Error(`browser V2 removal intent ${label} is invalid`);
  return number;
}

function requireRemovalLowerHex(value: unknown, label: string, bytes = 32): string {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`browser V2 removal intent ${label} is invalid`);
  }
  return value;
}

function hexBytes(value: string, bytes: number): Uint8Array {
  const result = new Uint8Array(bytes);
  for (let index = 0; index < bytes; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function requireAction(value: unknown): EncryptedWalletBackupV2DesiredAction {
  if (value === "replace" || value === "remove") return value;
  throw new Error("browser V2 desired asset action is invalid");
}

function requireSyncState(value: unknown): "pending" | "acknowledged" {
  if (value === "pending" || value === "acknowledged") return value;
  throw new Error("browser V2 desired asset sync state is invalid");
}

function requireActiveProofCount(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX
  ) {
    throw new Error("browser V2 desired asset active proof count is invalid");
  }
  return value as number;
}

function decodeTerminalCtfContext(
  value: unknown,
): EncryptedWalletBackupV2TerminalCtfContext | null {
  if (value === null) return null;
  if (!isRecord(value) || !exactKeys(value, terminalCtfContextFields)) {
    throw new Error("browser V2 desired asset CTF context is invalid");
  }
  const conditionId = requireLowerHex(value.conditionId, "condition id");
  const outcomeCollectionId = requireLowerHex(value.outcomeCollectionId, "outcome collection id");
  const outcomeLabel = requireUtf8Text(value.outcomeLabel, "outcome label");
  const registeredAt = requireUnixTime(value.registeredAt, "registered time");
  const finalExpiry =
    value.finalExpiry === null ? null : requirePositiveUnixTime(value.finalExpiry, "final expiry");
  if (finalExpiry !== null && finalExpiry <= registeredAt) {
    throw new Error("browser V2 desired asset CTF context is invalid");
  }
  return Object.freeze({
    conditionId,
    outcomeLabel,
    outcomeCollectionId,
    registeredAt,
    finalExpiry,
  });
}

const terminalCtfContextFields = [
  "conditionId",
  "outcomeLabel",
  "outcomeCollectionId",
  "registeredAt",
  "finalExpiry",
] as const;

function requireLowerHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`browser V2 desired asset CTF context ${label} is invalid`);
  }
  return value;
}

function requireUtf8Text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > 256
  ) {
    throw new Error(`browser V2 desired asset CTF context ${label} is invalid`);
  }
  return value;
}

function requireUnixTime(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`browser V2 desired asset CTF context ${label} is invalid`);
  }
  return value;
}

function requirePositiveUnixTime(value: unknown, label: string): number {
  const timestamp = requireUnixTime(value, label);
  if (timestamp < 1) throw new Error(`browser V2 desired asset CTF context ${label} is invalid`);
  return timestamp;
}

function sameTerminalCtfContext(
  left: EncryptedWalletBackupV2TerminalCtfContext | null,
  right: EncryptedWalletBackupV2TerminalCtfContext | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.conditionId === right.conditionId &&
      left.outcomeLabel === right.outcomeLabel &&
      left.outcomeCollectionId === right.outcomeCollectionId &&
      left.registeredAt === right.registeredAt &&
      left.finalExpiry === right.finalExpiry)
  );
}

function mergeTerminalCtfContext(
  current: EncryptedWalletBackupV2TerminalCtfContext | null,
  update: EncryptedWalletBackupV2TerminalCtfContext | null,
): EncryptedWalletBackupV2TerminalCtfContext | null {
  if (current !== null && update !== null && !sameTerminalCtfContext(current, update)) {
    throw new Error("browser V2 desired asset CTF context conflicts");
  }
  return current ?? update;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === fields.length && keys.every((key, index) => key === [...fields].sort()[index])
  );
}

export interface BrowserV2DesiredAssetProofChange {
  readonly beforeProof: BrowserCustodyProofRow | null;
  readonly beforeLocator: BrowserProofDerivationLocatorAuthority;
  readonly afterProof: BrowserCustodyProofRow;
  readonly afterLocator: BrowserProofDerivationLocatorAuthority;
  readonly payloadChanged: boolean;
}

export async function advanceBrowserV2DesiredAssetsForProofChanges(
  database: BitcasterDB,
  scopeId: string,
  changes: readonly BrowserV2DesiredAssetProofChange[],
  conditionalKeysetForProof?: (
    proof: BrowserCustodyProofRow,
  ) => ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow> | undefined,
): Promise<void> {
  const updates = new Map<string, DesiredAssetUpdate>();
  for (const change of changes) {
    if (!change.payloadChanged) continue;
    const before = change.beforeProof;
    if (before && isBackupEligible(before, change.beforeLocator)) {
      const asset = knownAssetForProof(before, conditionalKeysetForProof);
      addDesiredAssetUpdate(
        updates,
        asset ?? (await loadConditionalAssetForProof(database, before)),
        -1,
      );
    }
    if (isBackupEligible(change.afterProof, change.afterLocator)) {
      const asset = knownAssetForProof(change.afterProof, conditionalKeysetForProof);
      addDesiredAssetUpdate(
        updates,
        asset ?? (await loadConditionalAssetForProof(database, change.afterProof)),
        1,
      );
    }
  }
  await persistDesiredAssetUpdates(database, scopeId, updates);
}

export async function advanceBrowserV2DesiredAssetsForCounter(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly normalizedMint: string;
  readonly unit: BrowserCustodyProofUnit;
  readonly keysetId: string;
}): Promise<void> {
  const scopeId = decodeDurableCustodyScopeId(input.scopeId);
  const normalizedMint = decodeCanonicalMintOrigin(input.normalizedMint);
  const active = await firstActiveProof(input.database, {
    ...input,
    scopeId,
    normalizedMint,
  });
  if (active === null) return;
  const updates = new Map<string, DesiredAssetUpdate>();
  addDesiredAssetUpdate(
    updates,
    knownAssetForProof(active) ?? (await loadConditionalAssetForProof(input.database, active)),
    0,
  );
  await persistDesiredAssetUpdates(input.database, scopeId, updates);
}

/** Read the exact desired asset while the proof still has its predecessor authority. */
export async function requireBrowserV2DesiredAssetForProof(input: {
  readonly database: BitcasterDB;
  readonly proof: BrowserCustodyProofRow;
  readonly authority: BrowserProofBackupAuthorityRow;
}): Promise<EncryptedWalletBackupV2DesiredAssetRow> {
  const proof = decodeBrowserCustodyProofRow(input.proof);
  const authority = requireBrowserProofBackupAuthorityForProof(input.authority, proof);
  if (!isBackupEligible(proof, authority.derivationLocator)) {
    throw new Error("browser V2 desired asset proof is not active backup material");
  }
  const material =
    knownAssetForProof(proof) ??
    (await loadConditionalAssetForProof(input.database, proof, authority));
  const localAssetKey = encryptedWalletBackupV2LocalAssetKey(material.asset);
  const raw = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    proof.scopeId,
    localAssetKey,
  ]);
  if (raw === undefined) throw new Error("browser V2 desired asset authority is missing");
  const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
  if (
    desired.scopeId !== proof.scopeId ||
    desired.localAssetKey !== localAssetKey ||
    desired.mintUrl !== material.asset.mintUrl ||
    desired.unit !== material.asset.unit ||
    desired.assetIdentity !== material.asset.assetIdentity ||
    !sameTerminalCtfContext(desired.terminalCtfContext, material.terminalCtfContext)
  ) {
    throw new Error("browser V2 desired asset authority is foreign");
  }
  return desired;
}

async function firstActiveProof(
  database: BitcasterDB,
  expected: {
    readonly scopeId: string;
    readonly normalizedMint: string;
    readonly unit: BrowserCustodyProofUnit;
    readonly keysetId: string;
  },
): Promise<BrowserCustodyProofRow | null> {
  for (const state of ["selectable", "locked", "verified-losing"] as const) {
    const rows = await database.custodyProofs
      .where("[scopeId+normalizedMint+unit+keysetId+selectability]")
      .equals([expected.scopeId, expected.normalizedMint, expected.unit, expected.keysetId, state])
      .limit(513)
      .toArray();
    const proofs = rows.map((row) => decodeActiveProofReference(row, expected));
    const authorities = await database.custodyProofBackupAuthorities.bulkGet(
      proofs.map((proof) => [proof.scopeId, proof.proofId]),
    );
    for (const [index, proof] of proofs.entries()) {
      const authority = requireBrowserProofBackupAuthorityForProof(authorities[index], proof);
      if (isBackupEligible(proof, authority.derivationLocator)) return proof;
    }
  }
  return null;
}

interface DesiredAssetUpdate {
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly terminalCtfContext: EncryptedWalletBackupV2TerminalCtfContext | null;
  delta: number;
}

interface DesiredAssetMaterial {
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly terminalCtfContext: EncryptedWalletBackupV2TerminalCtfContext | null;
}

function addDesiredAssetUpdate(
  updates: Map<string, DesiredAssetUpdate>,
  material: DesiredAssetMaterial,
  delta: number,
): void {
  const key = encryptedWalletBackupV2LocalAssetKey(material.asset);
  const current = updates.get(key);
  if (current) {
    if (!sameTerminalCtfContext(current.terminalCtfContext, material.terminalCtfContext)) {
      throw new Error("browser V2 desired asset CTF context conflicts");
    }
    current.delta += delta;
    return;
  }
  updates.set(key, { ...material, delta });
}

async function persistDesiredAssetUpdates(
  database: BitcasterDB,
  scopeId: string,
  updates: ReadonlyMap<string, DesiredAssetUpdate>,
): Promise<void> {
  for (const [localAssetKey, update] of updates) {
    const raw = await database.encryptedWalletBackupV2DesiredAssets.get([scopeId, localAssetKey]);
    const current =
      raw === undefined ? undefined : decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
    if (current === undefined && update.delta <= 0) {
      throw new Error("browser V2 desired asset authority is missing");
    }
    if (current && (current.scopeId !== scopeId || current.localAssetKey !== localAssetKey)) {
      throw new Error("browser V2 desired asset authority is foreign");
    }
    if (current !== undefined && current.removalIntent !== null) {
      throw new Error("browser V2 desired asset removal intent requires an explicit head rebase");
    }
    if (
      current &&
      (current.assetIdentity !== update.asset.assetIdentity ||
        current.mintUrl !== update.asset.mintUrl ||
        current.unit !== update.asset.unit)
    ) {
      throw new Error("browser V2 desired asset authority is foreign");
    }
    if (update.asset.assetIdentity.startsWith("ctf:") && update.terminalCtfContext === null) {
      throw new Error("browser V2 desired asset conditional context is missing");
    }
    const terminalCtfContext = current
      ? mergeTerminalCtfContext(current.terminalCtfContext, update.terminalCtfContext)
      : update.terminalCtfContext;
    const activeProofCount = (current?.activeProofCount ?? 0) + update.delta;
    await database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId,
        asset: update.asset,
        terminalCtfContext,
        custodyRevision:
          current === undefined
            ? 1n
            : incrementEncryptedWalletBackupV2DesiredAssetRevision(BigInt(current.custodyRevision)),
        activeProofCount,
        removalIntent: null,
      }),
    );
  }
}

function isActive(proof: BrowserCustodyProofRow): boolean {
  switch (proof.selectability) {
    case "selectable":
    case "locked":
    case "verified-losing":
      return true;
    case "pending-removal":
      return false;
    case "spent":
      return false;
    default:
      throw new Error("browser V2 desired asset proof state is invalid");
  }
}

function isBackupEligible(
  proof: BrowserCustodyProofRow,
  derivationLocator: BrowserProofDerivationLocatorAuthority,
): boolean {
  return isActive(proof) && derivationLocator !== null;
}

function knownAssetForProof(
  proof: BrowserCustodyProofRow,
  conditionalKeysetForProof?: (
    proof: BrowserCustodyProofRow,
  ) => ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow> | undefined,
): DesiredAssetMaterial | undefined {
  if (proof.assetKind === "regular") {
    return {
      asset: createEncryptedWalletBackupV2AssetIdentity({
        mintUrl: proof.normalizedMint,
        unit: proof.unit,
        asset: { kind: "ordinary" },
      }),
      terminalCtfContext: null,
    };
  }
  if (conditionalKeysetForProof === undefined) return undefined;
  const keyset = conditionalKeysetForProof(proof);
  if (keyset === undefined && proof.selectability !== "verified-losing") {
    throw new Error("browser V2 desired asset conditional authority is missing");
  }
  if (keyset === undefined) return undefined;
  return conditionalAssetForProof(proof, keyset);
}

async function loadConditionalAssetForProof(
  database: BitcasterDB,
  proof: BrowserCustodyProofRow,
  suppliedAuthority?: BrowserProofBackupAuthorityRow,
): Promise<DesiredAssetMaterial> {
  if (proof.assetKind !== "conditional") {
    throw new Error("browser V2 desired asset conditional proof is required");
  }
  const raw = await database.custodyConditionalKeysets.get([
    proof.scopeId,
    proof.normalizedMint,
    proof.unit,
    proof.keysetId,
  ]);
  if (raw === undefined && proof.selectability === "verified-losing") {
    return loadRemoteTerminalAssetForProof(database, proof, suppliedAuthority);
  }
  if (raw === undefined) {
    throw new Error("browser V2 desired asset conditional authority is missing");
  }
  return conditionalAssetForProof(proof, decodeBrowserCustodyConditionalKeysetRow(raw));
}

async function loadRemoteTerminalAssetForProof(
  database: BitcasterDB,
  proof: BrowserCustodyProofRow,
  suppliedAuthority?: BrowserProofBackupAuthorityRow,
): Promise<DesiredAssetMaterial> {
  if (
    proof.assetKind !== "conditional" ||
    proof.conditionId === null ||
    proof.outcomeCollection === null
  ) {
    throw new Error("browser V2 desired asset conditional proof is required");
  }
  let authority: BrowserProofBackupAuthorityRow;
  if (suppliedAuthority === undefined) {
    const authorityRaw = await database.custodyProofBackupAuthorities.get([
      proof.scopeId,
      proof.proofId,
    ]);
    if (authorityRaw === undefined) {
      throw new Error("browser V2 desired asset remote terminal authority is missing");
    }
    authority = requireBrowserProofBackupAuthorityForProof(authorityRaw, proof);
  } else {
    authority = requireBrowserProofBackupAuthorityRow(suppliedAuthority);
    if (
      authority.scopeId !== proof.scopeId ||
      authority.proofId !== proof.proofId ||
      authority.proofFingerprint !== proof.proofFingerprint ||
      authority.proofState !== proof.selectability
    ) {
      throw new Error("browser V2 desired asset remote terminal authority is foreign");
    }
  }
  if (
    authority.backupState !== "remote-backed" ||
    authority.terminalAuthority?.kind !== "remote-seal"
  ) {
    throw new Error("browser V2 desired asset remote terminal authority is foreign");
  }
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId: proof.conditionId,
    outcomeCollection: proof.outcomeCollection,
  });
  const asset = decodeEncryptedWalletBackupV2AssetIdentity({
    mintUrl: proof.normalizedMint,
    unit: proof.unit,
    assetIdentity: `ctf:${proof.conditionId}:${outcomeCollectionId}`,
  });
  const desiredRaw = await database.encryptedWalletBackupV2DesiredAssets.get([
    proof.scopeId,
    encryptedWalletBackupV2LocalAssetKey(asset),
  ]);
  if (desiredRaw === undefined) {
    throw new Error("browser V2 desired asset terminal context is missing");
  }
  const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(desiredRaw);
  const context = desired.terminalCtfContext;
  if (
    desired.scopeId !== proof.scopeId ||
    desired.mintUrl !== proof.normalizedMint ||
    desired.unit !== proof.unit ||
    desired.assetIdentity !== asset.assetIdentity
  ) {
    throw new Error("browser V2 desired asset terminal context is foreign");
  }
  if (context === null) {
    throw new Error("browser V2 desired asset terminal context is missing");
  }
  if (
    context.conditionId !== proof.conditionId ||
    context.outcomeLabel !== proof.outcomeCollection ||
    context.outcomeCollectionId !== outcomeCollectionId
  ) {
    throw new Error("browser V2 desired asset terminal context is foreign");
  }
  return { asset, terminalCtfContext: context };
}

/** Validate a persisted remote-sealed proof before a keyset-free custody write. */
export async function requireBrowserV2KeysetFreeTerminalContextForProof(input: {
  readonly database: BitcasterDB;
  readonly proof: BrowserCustodyProofRow;
  readonly authority: unknown;
}): Promise<void> {
  if (input.proof.selectability !== "verified-losing") {
    throw new Error("browser V2 desired asset terminal proof state is invalid");
  }
  await loadRemoteTerminalAssetForProof(
    input.database,
    input.proof,
    requireBrowserProofBackupAuthorityRow(input.authority),
  );
}

function conditionalAssetForProof(
  proof: BrowserCustodyProofRow,
  keyset: ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow>,
): DesiredAssetMaterial {
  if (
    keyset.scopeId !== proof.scopeId ||
    keyset.normalizedMint !== proof.normalizedMint ||
    keyset.unit !== proof.unit ||
    keyset.keysetId !== proof.keysetId ||
    keyset.conditionId !== proof.conditionId ||
    keyset.outcomeCollection !== proof.outcomeCollection
  ) {
    throw new Error("browser V2 desired asset conditional authority is foreign");
  }
  return {
    asset: createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: proof.normalizedMint,
      unit: proof.unit,
      asset: {
        kind: "ctf",
        conditionId: keyset.conditionId,
        outcomeLabel: keyset.outcomeCollection,
        outcomeCollectionId: keyset.outcomeCollectionId,
        registeredAt: keyset.registeredAtUnixSeconds,
        finalExpiry: keyset.finalExpiryUnixSeconds,
      },
    }),
    terminalCtfContext: {
      conditionId: keyset.conditionId,
      outcomeLabel: keyset.outcomeCollection,
      outcomeCollectionId: keyset.outcomeCollectionId,
      registeredAt: keyset.registeredAtUnixSeconds,
      finalExpiry: keyset.finalExpiryUnixSeconds,
    },
  };
}

function decodeActiveProofReference(
  value: unknown,
  expected: {
    readonly scopeId: string;
    readonly normalizedMint: string;
    readonly unit: BrowserCustodyProofUnit;
    readonly keysetId: string;
  },
): BrowserCustodyProofRow {
  const proof = decodeBrowserCustodyProofRow(value);
  if (
    proof.scopeId !== expected.scopeId ||
    proof.normalizedMint !== expected.normalizedMint ||
    proof.unit !== expected.unit ||
    proof.keysetId !== expected.keysetId ||
    !isActive(proof)
  ) {
    throw new Error("browser V2 desired asset counter proof is foreign");
  }
  return proof;
}
