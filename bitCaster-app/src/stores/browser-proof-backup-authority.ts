import { decodeDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
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

interface BrowserProofBackupAuthorityBase {
  schemaVersion: 3;
  scopeId: string;
  proofId: string;
  proofFingerprint: string;
  proofRevision: number;
  proofState: BrowserCustodyProofSelectability;
  terminalOperationId: string | null;
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

/** Bind a selectable proof to its exact encrypted-backup restore authority. */
export function createBrowserRemoteProofBackupAuthorityRow(input: {
  readonly proof: BrowserCustodyProofRow;
  readonly observedAtMs: number;
  readonly derivationLocator: BrowserProofDerivationLocatorAuthority;
  readonly restoreProofId: string;
  readonly restoreProofCommitment: string;
}): BrowserRemoteProofBackupAuthorityRow {
  const proof = input.proof;
  if (input.observedAtMs < proof.receivedAtMs) {
    throw new Error("browser restored proof authority time is stale");
  }
  requireBrowserProofDerivationLocator(input.derivationLocator);
  const authority = requireBrowserProofBackupAuthorityRow({
    schemaVersion: 3 as const,
    scopeId: proof.scopeId,
    proofId: proof.proofId,
    proofFingerprint: proof.proofFingerprint,
    proofRevision: proof.revision,
    proofState: proof.selectability,
    admissionOperationId: null,
    terminalOperationId: null,
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
  if (observedAtMs < proof.receivedAtMs) {
    throw new Error("browser proof backup authority time is stale");
  }
  requireBrowserProofDerivationLocator(derivationLocator);
  return requireBrowserProofBackupAuthorityRow({
    schemaVersion: 3 as const,
    scopeId: proof.scopeId,
    proofId: proof.proofId,
    proofFingerprint: proof.proofFingerprint,
    proofRevision: proof.revision,
    proofState: proof.selectability,
    admissionOperationId: requireOperationId(admissionOperationId, "proof admission operation"),
    terminalOperationId: null,
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
  if (proof.revision !== authority.proofRevision + 1 || time < authority.updatedAtMs) {
    throw new Error("browser proof backup authority revision is stale");
  }
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
  if (proof.revision !== authority.proofRevision + 1 || time < authority.updatedAtMs) {
    throw new Error("browser proof backup authority revision is stale");
  }
  return requireBrowserProofBackupAuthorityRow({
    ...authority,
    proofRevision: proof.revision,
    proofState: proof.selectability,
    updatedAtMs: time,
  }) as BrowserRemoteProofBackupAuthorityRow;
}

/** Bind one committed terminal operation without changing proof authority. */
export function bindBrowserProofBackupAuthorityTerminalOperation(
  current: BrowserProofBackupAuthorityRow,
  terminalOperationId: string,
  classifiedAtMs: number,
): BrowserProofBackupAuthorityRow {
  const authority = requireBrowserProofBackupAuthorityRow(current);
  const terminal = requireOperationId(terminalOperationId, "proof terminal operation");
  if (authority.terminalOperationId === terminal) return authority;
  if (authority.terminalOperationId !== null) {
    throw new Error("browser proof backup terminal operation conflicts");
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
    recordUpdatedAtUnixSeconds,
    updatedAtMs: time,
  });
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
    schemaVersion: 3 as const,
    scopeId: decodeDurableCustodyScopeId(row.scopeId),
    proofId: requireFingerprint(row.proofId, "proof id"),
    proofFingerprint: requireFingerprint(row.proofFingerprint, "proof fingerprint"),
    proofRevision: requireRevision(row.proofRevision),
    proofState,
    terminalOperationId,
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
    "recordCreatedAtUnixSeconds",
    "recordUpdatedAtUnixSeconds",
    "backupState",
    "derivationLocator",
    "backupRecordId",
    "backupRecordCommitment",
    "updatedAtMs",
  ];
  if (
    row.schemaVersion !== 3 ||
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
  if (value !== "selectable" && value !== "locked" && value !== "spent") {
    throw new Error("browser proof backup authority state is invalid");
  }
  return value;
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
