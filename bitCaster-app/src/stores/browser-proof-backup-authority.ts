import {
  decodeDurableCustodyScopeInput,
  decodeDurableCustodyScopeId,
} from "@bitcaster/client-sdk/durableCustody";
import {
  decodeEncryptedWalletBackupV2AssetIdentity,
  encryptedWalletBackupV2LocalAssetKey,
} from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import {
  requireRealm,
  requireUtf8Text as requireBackupUtf8Text,
} from "@bitcaster/client-sdk/encryptedWalletBackupServerValidation";
import {
  decodeDurableWalletProofDerivationLocator,
  durableWalletProofDerivationLocatorsEqual,
  serializeDurableWalletProofDerivationLocator,
  type DurableWalletProofDerivationLocator,
  type SerializableDurableWalletProofDerivationLocator,
} from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import type {
  BrowserCustodyProofRow,
  BrowserCustodyProofSelectability,
} from "./durable-custody-types";

export type BrowserProofDerivationLocatorAuthority = DurableWalletProofDerivationLocator | null;

export interface BrowserLocalTerminalAuthority {
  kind: "local-operation";
  operationId: string;
}

export interface BrowserRemoteTerminalSealAuthority {
  kind: "remote-seal";
}

export type BrowserProofBackupTerminalAuthority =
  | BrowserLocalTerminalAuthority
  | BrowserRemoteTerminalSealAuthority;

interface BrowserProofBackupAuthorityBase {
  schemaVersion: 4;
  scopeId: string;
  proofId: string;
  proofFingerprint: string;
  proofRevision: number;
  proofState: BrowserCustodyProofSelectability;
  terminalOperationId: string | null;
  terminalAuthority: BrowserProofBackupTerminalAuthority | null;
  recordCreatedAtUnixSeconds: number;
  recordUpdatedAtUnixSeconds: number;
  derivationLocator: SerializableDurableWalletProofDerivationLocator | null;
  updatedAtMs: number;
}

export interface BrowserLocalProofBackupAuthorityRow extends BrowserProofBackupAuthorityBase {
  admissionOperationId: string;
  backupState: "local-only";
  backupRecordId: null;
  backupRecordCommitment: null;
}

export interface BrowserRemoteProofBackupAuthorityRow extends BrowserProofBackupAuthorityBase {
  admissionOperationId: null;
  backupState: "remote-backed";
  backupRecordId: string;
  backupRecordCommitment: string;
}

export type BrowserProofBackupAuthorityRow =
  | BrowserLocalProofBackupAuthorityRow
  | BrowserRemoteProofBackupAuthorityRow;

export type BrowserCompletedProofRemovalAcknowledgementKind = "receipt" | "current-head";

export interface BrowserCompletedProofRemovalMarkerRow {
  schemaVersion: 1;
  recordKind: "completed-removal";
  scopeId: string;
  proofId: string;
  proofFingerprint: string;
  proofRevision: number;
  proofCommitment: string;
  localAssetKey: string;
  removalIntentId: string;
  proofSetCommitment: string;
  completionCustodyRevision: string;
  realm: string;
  walletId: string;
  enrollmentEpoch: number;
  acknowledgedHeadVersion: number;
  acknowledgedActiveSetDigest: string;
  acknowledgementKind: BrowserCompletedProofRemovalAcknowledgementKind;
  receiptDigest: string | null;
  acknowledgedAtMs: number;
  completedAtMs: number;
}

export type BrowserProofBackupAuthorityTableRow =
  | BrowserProofBackupAuthorityRow
  | BrowserCompletedProofRemovalMarkerRow;

export class BrowserCompletedProofRemovalError extends Error {
  constructor() {
    super("browser proof backup authority is a completed-removal marker");
    this.name = "BrowserCompletedProofRemovalError";
  }
}

const completedProofRemovalMarkerFields = [
  "schemaVersion",
  "recordKind",
  "scopeId",
  "proofId",
  "proofFingerprint",
  "proofRevision",
  "proofCommitment",
  "localAssetKey",
  "removalIntentId",
  "proofSetCommitment",
  "completionCustodyRevision",
  "realm",
  "walletId",
  "enrollmentEpoch",
  "acknowledgedHeadVersion",
  "acknowledgedActiveSetDigest",
  "acknowledgementKind",
  "receiptDigest",
  "acknowledgedAtMs",
  "completedAtMs",
] as const;

export function createBrowserCompletedProofRemovalMarkerRow(input: {
  readonly scopeId: string;
  readonly proofId: string;
  readonly proofFingerprint: string;
  readonly proofRevision: number;
  readonly proofCommitment: string;
  readonly localAssetKey: string;
  readonly removalIntentId: string;
  readonly proofSetCommitment: string;
  readonly completionCustodyRevision: bigint | string;
  readonly realm: string;
  readonly walletId: string;
  readonly enrollmentEpoch: number;
  readonly acknowledgedHeadVersion: number;
  readonly acknowledgedActiveSetDigest: string;
  readonly acknowledgementKind: BrowserCompletedProofRemovalAcknowledgementKind;
  readonly receiptDigest: string | null;
  readonly acknowledgedAtMs: number;
  readonly completedAtMs: number;
}): BrowserCompletedProofRemovalMarkerRow {
  return decodeBrowserCompletedProofRemovalMarkerRow({
    schemaVersion: 1,
    recordKind: "completed-removal",
    ...input,
    proofRevision: input.proofRevision,
    completionCustodyRevision: decimalUint64(
      typeof input.completionCustodyRevision === "bigint"
        ? input.completionCustodyRevision
        : parseDecimalUint64(input.completionCustodyRevision),
    ),
    localAssetKey: canonicalLocalAssetKey(input.localAssetKey),
  });
}

export function decodeBrowserCompletedProofRemovalMarkerRow(
  value: unknown,
): BrowserCompletedProofRemovalMarkerRow {
  if (!isExactRecord(value, completedProofRemovalMarkerFields)) {
    throw new Error("browser completed proof removal marker is invalid");
  }
  const scopeId = decodeDurableCustodyScopeId(value.scopeId);
  const scope = decodeDurableCustodyScopeInput(scopeId);
  const proofId = requireFingerprint(value.proofId, "completed proof id");
  const walletId = requireFingerprint(value.walletId, "completed wallet id");
  if (scope.scopeKind !== "wallet" || scope.walletId !== walletId) {
    throw new Error("browser completed proof removal marker wallet scope is invalid");
  }
  const localAssetKey = canonicalLocalAssetKey(value.localAssetKey);
  if (localAssetKey !== value.localAssetKey) {
    throw new Error("browser completed proof removal marker asset key is not canonical");
  }
  const acknowledgementKind = requireAcknowledgementKind(value.acknowledgementKind);
  const receiptDigest =
    value.receiptDigest === null
      ? null
      : requireFingerprint(value.receiptDigest, "completed receipt digest");
  if ((acknowledgementKind === "receipt") !== (receiptDigest !== null)) {
    throw new Error("browser completed proof removal marker receipt evidence is invalid");
  }
  const acknowledgedAtMs = requireTime(
    value.acknowledgedAtMs,
    "completed removal acknowledgement time",
  );
  const completedAtMs = requireTime(value.completedAtMs, "completed removal completion time");
  if (acknowledgedAtMs > completedAtMs) {
    throw new Error("browser completed proof removal marker time is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    recordKind: "completed-removal",
    scopeId,
    proofId,
    proofFingerprint: requireFingerprint(value.proofFingerprint, "completed proof fingerprint"),
    proofRevision: requireRevision(value.proofRevision),
    proofCommitment: requireFingerprint(value.proofCommitment, "completed proof commitment"),
    localAssetKey,
    removalIntentId: requireBoundedText(value.removalIntentId, "completed removal intent id"),
    proofSetCommitment: requireFingerprint(
      value.proofSetCommitment,
      "completed proof-set commitment",
    ),
    completionCustodyRevision: decimalUint64(parseDecimalUint64(value.completionCustodyRevision)),
    realm: requireRealm(value.realm),
    walletId,
    enrollmentEpoch: requirePositiveSafeInteger(
      value.enrollmentEpoch,
      "completed enrollment epoch",
    ),
    acknowledgedHeadVersion: requireNonnegativeSafeInteger(
      value.acknowledgedHeadVersion,
      "completed acknowledged head version",
    ),
    acknowledgedActiveSetDigest: requireFingerprint(
      value.acknowledgedActiveSetDigest,
      "completed acknowledged active-set digest",
    ),
    acknowledgementKind,
    receiptDigest,
    acknowledgedAtMs,
    completedAtMs,
  });
}

export function decodeBrowserProofBackupAuthorityTableRow(
  value: unknown,
): BrowserProofBackupAuthorityTableRow {
  if (isRecord(value) && value.recordKind === "completed-removal") {
    return decodeBrowserCompletedProofRemovalMarkerRow(value);
  }
  return requireBrowserProofBackupAuthorityRow(value);
}

export function requireBrowserLiveProofBackupAuthorityTableRow(
  value: unknown,
  primaryKey: readonly [string, string],
): BrowserProofBackupAuthorityRow | undefined {
  if (primaryKey.length !== 2) {
    throw new Error("browser proof backup authority primary key is invalid");
  }
  const expectedScopeId = decodeDurableCustodyScopeId(primaryKey[0]);
  const expectedProofId = requireFingerprint(primaryKey[1], "primary-key proof id");
  if (value === undefined) return undefined;
  const row = decodeBrowserProofBackupAuthorityTableRow(value);
  if (row.scopeId !== expectedScopeId || row.proofId !== expectedProofId) {
    throw new Error("browser proof backup authority primary key is foreign");
  }
  if (isCompletedProofRemovalMarker(row)) {
    throw new BrowserCompletedProofRemovalError();
  }
  return row;
}

/** Bind a selectable proof to its exact encrypted-backup restore authority. */
export function createBrowserRemoteProofBackupAuthorityRow(input: {
  readonly proof: BrowserCustodyProofRow;
  readonly observedAtMs: number;
  readonly derivationLocator: BrowserProofDerivationLocatorAuthority;
  readonly restoreProofId: string;
  readonly restoreProofCommitment: string;
}): BrowserRemoteProofBackupAuthorityRow {
  const proof = input.proof;
  requireLiveProofStateForAuthority(proof.selectability);
  if (input.observedAtMs < proof.receivedAtMs) {
    throw new Error("browser restored proof authority time is stale");
  }
  requireBrowserProofDerivationLocator(input.derivationLocator);
  const authority = requireBrowserProofBackupAuthorityRow({
    schemaVersion: 4 as const,
    scopeId: proof.scopeId,
    proofId: proof.proofId,
    proofFingerprint: proof.proofFingerprint,
    proofRevision: proof.revision,
    proofState: proof.selectability,
    admissionOperationId: null,
    terminalOperationId: null,
    terminalAuthority: proof.selectability === "verified-losing" ? { kind: "remote-seal" } : null,
    ...recordTimes(input.observedAtMs),
    backupState: "remote-backed",
    derivationLocator: serializeBrowserProofDerivationLocator(input.derivationLocator),
    backupRecordId: requireFingerprint(input.restoreProofId, "restore proof id"),
    backupRecordCommitment: requireFingerprint(
      input.restoreProofCommitment,
      "restore proof commitment",
    ),
    updatedAtMs: input.observedAtMs,
  });
  if (authority.backupState !== "remote-backed") {
    throw new Error("browser restored proof authority is invalid");
  }
  return authority;
}

export function createBrowserProofBackupAuthorityRow(
  proof: BrowserCustodyProofRow,
  observedAtMs: number,
  derivationLocator: BrowserProofDerivationLocatorAuthority,
  admissionOperationId: string,
): BrowserProofBackupAuthorityRow {
  requireLiveProofStateForAuthority(proof.selectability);
  if (observedAtMs < proof.receivedAtMs) {
    throw new Error("browser proof backup authority time is stale");
  }
  requireBrowserProofDerivationLocator(derivationLocator);
  return requireBrowserProofBackupAuthorityRow({
    schemaVersion: 4 as const,
    scopeId: proof.scopeId,
    proofId: proof.proofId,
    proofFingerprint: proof.proofFingerprint,
    proofRevision: proof.revision,
    proofState: proof.selectability,
    admissionOperationId: requireOperationId(admissionOperationId, "proof admission operation"),
    terminalOperationId: null,
    terminalAuthority: null,
    ...recordTimes(observedAtMs),
    backupState: "local-only",
    derivationLocator: serializeBrowserProofDerivationLocator(derivationLocator),
    backupRecordId: null,
    backupRecordCommitment: null,
    updatedAtMs: observedAtMs,
  });
}

export function advanceBrowserProofBackupAuthorityRow(
  current: BrowserProofBackupAuthorityRow,
  proof: BrowserCustodyProofRow,
  observedAtMs: number,
  derivationLocator: BrowserProofDerivationLocatorAuthority,
  admissionOperationId: string,
): BrowserProofBackupAuthorityRow {
  const authority = requireBrowserProofBackupAuthorityRow(current);
  requireLiveProofStateForAuthority(authority.proofState);
  requireLiveProofStateForAuthority(proof.selectability);
  if (authority.backupState !== "local-only") {
    throw new Error("browser proof backup authority is remote-backed");
  }
  requireProofBinding(authority, proof);
  if (
    authority.admissionOperationId !==
    requireOperationId(admissionOperationId, "proof admission operation")
  ) {
    throw new Error("browser proof backup admission operation conflicts");
  }
  const currentLocator = derivationLocatorOf(authority);
  const requestedLocator = requireBrowserProofDerivationLocator(derivationLocator);
  if (!sameBrowserProofDerivationLocator(currentLocator, requestedLocator)) {
    throw new Error("browser proof backup derivation locator conflicts");
  }
  const time = requireTime(observedAtMs, "proof backup authority time");
  if (time < proof.receivedAtMs) {
    throw new Error("browser proof backup authority time is stale");
  }
  if (proof.revision === authority.proofRevision) {
    if (proof.selectability !== authority.proofState) {
      throw new Error("browser proof backup authority state conflicts");
    }
    return authority;
  }
  requireNextProofAuthorityRevision(authority, proof, time);
  return requireBrowserProofBackupAuthorityRow({
    ...authority,
    proofRevision: proof.revision,
    proofState: proof.selectability,
    updatedAtMs: time,
  });
}

/** Advance local proof state without changing the encrypted-backup origin. */
export function advanceBrowserRemoteProofBackupAuthorityRow(
  current: BrowserRemoteProofBackupAuthorityRow,
  proof: BrowserCustodyProofRow,
  observedAtMs: number,
  derivationLocator: BrowserProofDerivationLocatorAuthority,
): BrowserRemoteProofBackupAuthorityRow {
  const authority = requireBrowserProofBackupAuthorityRow(current);
  requireLiveProofStateForAuthority(authority.proofState);
  requireLiveProofStateForAuthority(proof.selectability);
  if (authority.backupState !== "remote-backed") {
    throw new Error("browser proof backup authority is local-only");
  }
  requireProofBinding(authority, proof);
  if (!sameBrowserProofDerivationLocator(derivationLocatorOf(authority), derivationLocator)) {
    throw new Error("browser proof backup derivation locator conflicts");
  }
  const time = requireTime(observedAtMs, "proof backup authority time");
  if (time < proof.receivedAtMs) throw new Error("browser proof backup authority time is stale");
  if (proof.revision === authority.proofRevision) {
    if (proof.selectability !== authority.proofState) {
      throw new Error("browser proof backup authority state conflicts");
    }
    return authority;
  }
  requireNextProofAuthorityRevision(authority, proof, time);
  return requireBrowserProofBackupAuthorityRow({
    ...authority,
    proofRevision: proof.revision,
    proofState: proof.selectability,
    updatedAtMs: time,
  }) as BrowserRemoteProofBackupAuthorityRow;
}

export function advanceBrowserProofBackupAuthorityRowToPendingRemoval(
  current: BrowserProofBackupAuthorityRow,
  proof: BrowserCustodyProofRow,
  observedAtMs: number,
): BrowserProofBackupAuthorityRow {
  const authority = requireBrowserProofBackupAuthorityRow(current);
  requireProofBinding(authority, proof);
  if (authority.proofState !== "selectable" && authority.proofState !== "verified-losing") {
    throw new Error("browser proof backup pending-removal predecessor is not live");
  }
  if (
    proof.selectability !== "pending-removal" ||
    proof.assetKind !== "conditional" ||
    proof.reservationOperationId !== null
  ) {
    throw new Error("browser proof backup pending-removal proof is invalid");
  }
  if (authority.proofState !== "verified-losing" && authority.terminalAuthority !== null) {
    throw new Error("browser proof backup pending-removal terminal authority is invalid");
  }
  const time = requireTime(observedAtMs, "proof backup authority time");
  if (time < proof.receivedAtMs) {
    throw new Error("browser proof backup authority time is stale");
  }
  requireNextProofAuthorityRevision(authority, proof, time);
  return requireBrowserProofBackupAuthorityRow({
    ...authority,
    proofRevision: proof.revision,
    proofState: proof.selectability,
    recordUpdatedAtUnixSeconds: Math.floor(time / 1_000),
    updatedAtMs: time,
  });
}

/** Bind one committed terminal operation without changing proof authority. */
export function bindBrowserProofBackupAuthorityTerminalOperation(
  current: BrowserProofBackupAuthorityRow,
  terminalOperationId: string,
  classifiedAtMs: number,
): BrowserProofBackupAuthorityRow {
  const authority = requireBrowserProofBackupAuthorityRow(current);
  requireLiveProofStateForAuthority(authority.proofState);
  const terminal = requireOperationId(terminalOperationId, "proof terminal operation");
  if (
    authority.terminalAuthority?.kind === "local-operation" &&
    authority.terminalAuthority.operationId === terminal
  )
    return authority;
  if (authority.terminalOperationId !== null) {
    throw new Error("browser proof backup terminal operation conflicts");
  }
  if (authority.terminalAuthority !== null) {
    throw new Error("browser proof backup terminal authority conflicts");
  }
  const time = requireTime(classifiedAtMs, "proof terminal classification time");
  if (time < authority.updatedAtMs) {
    throw new Error("browser proof backup terminal classification time is stale");
  }
  const recordUpdatedAtUnixSeconds = Math.floor(time / 1_000);
  if (recordUpdatedAtUnixSeconds < authority.recordUpdatedAtUnixSeconds) {
    throw new Error("browser proof backup terminal classification time is stale");
  }
  return requireBrowserProofBackupAuthorityRow({
    ...authority,
    terminalOperationId: terminal,
    terminalAuthority: { kind: "local-operation", operationId: terminal },
    recordUpdatedAtUnixSeconds,
    updatedAtMs: time,
  });
}

/** Commit the proof revision and terminal binding as one strict authority row. */
export function classifyBrowserProofBackupAuthorityVerifiedLosing(
  current: BrowserProofBackupAuthorityRow,
  proof: BrowserCustodyProofRow,
  terminalOperationId: string,
  classifiedAtMs: number,
): BrowserProofBackupAuthorityRow {
  const authority = requireBrowserProofBackupAuthorityRow(current);
  requireProofBinding(authority, proof);
  if (
    authority.proofState !== "locked" ||
    authority.terminalAuthority !== null ||
    proof.selectability !== "verified-losing"
  ) {
    throw new Error("browser proof backup losing classification is invalid");
  }
  const time = requireTime(classifiedAtMs, "proof terminal classification time");
  requireNextProofAuthorityRevision(authority, proof, time);
  const terminal = requireOperationId(terminalOperationId, "proof terminal operation");
  return requireBrowserProofBackupAuthorityRow({
    ...authority,
    proofRevision: proof.revision,
    proofState: proof.selectability,
    terminalOperationId: terminal,
    terminalAuthority: {
      kind: "local-operation",
      operationId: terminal,
    },
    recordUpdatedAtUnixSeconds: Math.floor(time / 1_000),
    updatedAtMs: time,
  });
}

function requireNextProofAuthorityRevision(
  authority: BrowserProofBackupAuthorityRow,
  proof: BrowserCustodyProofRow,
  observedAtMs: number,
): void {
  const expectedRevision = authority.proofRevision + 1;
  if (proof.revision !== expectedRevision) {
    throw new Error(
      `browser proof backup authority revision is stale: expected ${expectedRevision}, received ${proof.revision}`,
    );
  }
  if (observedAtMs < authority.updatedAtMs) {
    throw new Error("browser proof backup authority time is stale");
  }
}

export function requireBrowserProofBackupAuthorityRow(
  value: unknown,
): BrowserProofBackupAuthorityRow {
  const row = requireAuthorityRecord(value);
  const proofState = requireProofState(row.proofState);
  const derivationLocator = requireBrowserProofDerivationLocator(row.derivationLocator);
  const recordCreatedAtUnixSeconds = requireTime(
    row.recordCreatedAtUnixSeconds,
    "proof backup record creation time",
  );
  const recordUpdatedAtUnixSeconds = requireTime(
    row.recordUpdatedAtUnixSeconds,
    "proof backup record update time",
  );
  const terminalOperationId =
    row.terminalOperationId === null
      ? null
      : requireOperationId(row.terminalOperationId, "proof terminal operation");
  if (recordUpdatedAtUnixSeconds < recordCreatedAtUnixSeconds) {
    throw new Error("browser proof backup authority is invalid");
  }
  const admissionOperationId =
    row.admissionOperationId === null
      ? null
      : requireOperationId(row.admissionOperationId, "proof admission operation");
  const backupState = requireBackupState(row.backupState);
  const backupRecordId =
    row.backupRecordId === null ? null : requireFingerprint(row.backupRecordId, "backup record id");
  const backupRecordCommitment =
    row.backupRecordCommitment === null
      ? null
      : requireFingerprint(row.backupRecordCommitment, "backup record commitment");
  const terminalAuthority = requireTerminalAuthority(
    row.terminalAuthority,
    proofState,
    terminalOperationId,
    backupState,
  );
  if (
    (backupState === "local-only" &&
      (admissionOperationId === null ||
        backupRecordId !== null ||
        backupRecordCommitment !== null)) ||
    (backupState === "remote-backed" &&
      (admissionOperationId !== null ||
        backupRecordId !== row.proofId ||
        backupRecordCommitment === null))
  ) {
    throw new Error("browser proof backup authority is invalid");
  }
  const base = {
    schemaVersion: 4 as const,
    scopeId: decodeDurableCustodyScopeId(row.scopeId),
    proofId: requireFingerprint(row.proofId, "proof id"),
    proofFingerprint: requireFingerprint(row.proofFingerprint, "proof fingerprint"),
    proofRevision: requireRevision(row.proofRevision),
    proofState,
    terminalOperationId,
    terminalAuthority,
    recordCreatedAtUnixSeconds,
    recordUpdatedAtUnixSeconds,
    derivationLocator: serializeBrowserProofDerivationLocator(derivationLocator),
    updatedAtMs: requireTime(row.updatedAtMs, "proof backup authority time"),
  };
  return backupState === "local-only"
    ? {
        ...base,
        admissionOperationId: admissionOperationId!,
        backupState,
        backupRecordId: null,
        backupRecordCommitment: null,
      }
    : {
        ...base,
        admissionOperationId: null,
        backupState,
        backupRecordId: backupRecordId!,
        backupRecordCommitment: backupRecordCommitment!,
      };
}

function requireAuthorityRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("browser proof backup authority is invalid");
  }
  const row = value as Record<string, unknown>;
  const fields = [
    "schemaVersion",
    "scopeId",
    "proofId",
    "proofFingerprint",
    "proofRevision",
    "proofState",
    "admissionOperationId",
    "terminalOperationId",
    "terminalAuthority",
    "recordCreatedAtUnixSeconds",
    "recordUpdatedAtUnixSeconds",
    "backupState",
    "derivationLocator",
    "backupRecordId",
    "backupRecordCommitment",
    "updatedAtMs",
  ];
  if (
    row.schemaVersion !== 4 ||
    Object.keys(row).length !== fields.length ||
    fields.some((field) => !(field in row)) ||
    (row.backupState !== "local-only" && row.backupState !== "remote-backed")
  ) {
    throw new Error("browser proof backup authority is invalid");
  }
  return row;
}

function requireBackupState(value: unknown): "local-only" | "remote-backed" {
  if (value !== "local-only" && value !== "remote-backed") {
    throw new Error("browser proof backup authority state is invalid");
  }
  return value;
}

function requireTerminalAuthority(
  value: unknown,
  proofState: BrowserCustodyProofSelectability,
  terminalOperationId: string | null,
  backupState: "local-only" | "remote-backed",
): BrowserProofBackupTerminalAuthority | null {
  if (value === null) {
    if (proofState === "verified-losing") {
      throw new Error("browser proof backup losing classification is unbound");
    }
    if (terminalOperationId !== null) {
      throw new Error("browser proof backup terminal authority is invalid");
    }
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("browser proof backup terminal authority is invalid");
  }
  const authority = value as Record<string, unknown>;
  if (typeof authority.kind !== "string") {
    throw new Error("browser proof backup terminal authority is invalid");
  }
  switch (authority.kind) {
    case "local-operation": {
      if (
        Object.keys(authority).length !== 2 ||
        !("operationId" in authority) ||
        terminalOperationId === null
      ) {
        throw new Error("browser proof backup terminal authority is invalid");
      }
      const operationId = requireOperationId(
        authority.operationId,
        "proof terminal authority operation",
      );
      if (operationId !== terminalOperationId) {
        throw new Error("browser proof backup terminal authority is invalid");
      }
      return { kind: "local-operation", operationId };
    }
    case "remote-seal":
      if (
        Object.keys(authority).length !== 1 ||
        terminalOperationId !== null ||
        (proofState !== "verified-losing" && proofState !== "pending-removal") ||
        backupState !== "remote-backed"
      ) {
        throw new Error("browser proof backup terminal authority is invalid");
      }
      return { kind: "remote-seal" };
    default:
      throw new Error("browser proof backup terminal authority is invalid");
  }
}

function recordTimes(
  observedAtMs: number,
): Pick<
  BrowserProofBackupAuthorityRow,
  "recordCreatedAtUnixSeconds" | "recordUpdatedAtUnixSeconds"
> {
  const seconds = Math.floor(requireTime(observedAtMs, "proof backup authority time") / 1_000);
  return { recordCreatedAtUnixSeconds: seconds, recordUpdatedAtUnixSeconds: seconds };
}

function requireOperationId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw new Error(`browser ${label} is invalid`);
  }
  return value;
}

export function requireBrowserProofDerivationLocator(
  value: unknown,
): BrowserProofDerivationLocatorAuthority {
  if (value === null) return null;
  try {
    return decodeDurableWalletProofDerivationLocator(value);
  } catch {
    throw new Error("browser proof backup derivation locator is invalid");
  }
}

export function requireBrowserProofBackupAuthorityForProof(
  value: unknown,
  proof: BrowserCustodyProofRow,
): BrowserProofBackupAuthorityRow {
  const authority = requireBrowserProofBackupAuthorityRow(value);
  requireProofBinding(authority, proof);
  if (authority.proofRevision !== proof.revision || authority.proofState !== proof.selectability) {
    throw new Error("browser proof backup authority is stale");
  }
  return authority;
}

function requireProofBinding(
  authority: BrowserProofBackupAuthorityRow,
  proof: BrowserCustodyProofRow,
): void {
  if (
    authority.scopeId !== proof.scopeId ||
    authority.proofId !== proof.proofId ||
    authority.proofFingerprint !== proof.proofFingerprint
  ) {
    throw new Error("browser proof backup authority is foreign");
  }
}

function derivationLocatorOf(
  authority: BrowserProofBackupAuthorityRow,
): BrowserProofDerivationLocatorAuthority {
  return requireBrowserProofDerivationLocator(authority.derivationLocator);
}

function serializeBrowserProofDerivationLocator(
  locator: BrowserProofDerivationLocatorAuthority,
): SerializableDurableWalletProofDerivationLocator | null {
  const required = requireBrowserProofDerivationLocator(locator);
  return required === null ? null : serializeDurableWalletProofDerivationLocator(required);
}

export function sameBrowserProofDerivationLocator(
  left: BrowserProofDerivationLocatorAuthority,
  right: BrowserProofDerivationLocatorAuthority,
): boolean {
  return (
    left === right ||
    (left !== null && right !== null && durableWalletProofDerivationLocatorsEqual(left, right))
  );
}

function requireProofState(value: unknown): BrowserCustodyProofSelectability {
  if (
    value !== "selectable" &&
    value !== "locked" &&
    value !== "verified-losing" &&
    value !== "pending-removal" &&
    value !== "spent"
  ) {
    throw new Error("browser proof backup authority state is invalid");
  }
  return value;
}

function requireLiveProofStateForAuthority(value: BrowserCustodyProofSelectability): void {
  if (value === "pending-removal") {
    throw new Error("browser proof backup pending-removal requires explicit transition");
  }
}

function requireFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`browser proof backup ${label} is invalid`);
  }
  return value;
}

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("browser proof backup authority revision is invalid");
  }
  return value as number;
}

function requireTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`browser ${label} is invalid`);
  }
  return value as number;
}

function canonicalLocalAssetKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("browser completed proof removal marker asset key is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("browser completed proof removal marker asset key is invalid");
  }
  try {
    if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error("asset key tuple");
    const asset = decodeEncryptedWalletBackupV2AssetIdentity({
      mintUrl: parsed[0],
      unit: parsed[1],
      assetIdentity: parsed[2],
    });
    if (asset.assetIdentity === "cashu:ordinary") throw new Error("ordinary asset key");
    return encryptedWalletBackupV2LocalAssetKey(asset);
  } catch {
    throw new Error("browser completed proof removal marker asset key is invalid");
  }
}

function decimalUint64(value: bigint): string {
  if (value < 0n || value > UINT64_MAX) {
    throw new Error("browser completed proof removal marker revision is invalid");
  }
  return value.toString();
}

function parseDecimalUint64(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error("browser completed proof removal marker revision is invalid");
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) {
    throw new Error("browser completed proof removal marker revision is invalid");
  }
  return parsed;
}

function requireBoundedText(value: unknown, label: string): string {
  return requireBackupUtf8Text(value, 256, `browser ${label}`);
}

function requireNonnegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`browser ${label} is invalid`);
  }
  return value as number;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const number = requireNonnegativeSafeInteger(value, label);
  if (number < 1) throw new Error(`browser ${label} is invalid`);
  return number;
}

function requireAcknowledgementKind(
  value: unknown,
): BrowserCompletedProofRemovalAcknowledgementKind {
  if (value === "receipt" || value === "current-head") return value;
  throw new Error("browser completed proof removal marker acknowledgement kind is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === fields.length && keys.every((key, index) => key === [...fields].sort()[index])
  );
}

function isCompletedProofRemovalMarker(
  value: BrowserProofBackupAuthorityTableRow,
): value is BrowserCompletedProofRemovalMarkerRow {
  return "recordKind" in value && value.recordKind === "completed-removal";
}

const UINT64_MAX = (1n << 64n) - 1n;
