import { decodeDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import type {
  BrowserCustodyProofRow,
  BrowserCustodyProofSelectability,
} from "./durable-custody-types";

export interface BrowserProofBackupAuthorityRow {
  schemaVersion: 1;
  scopeId: string;
  proofId: string;
  proofFingerprint: string;
  proofRevision: number;
  proofState: BrowserCustodyProofSelectability;
  backupState: "local-only";
  derivationKeysetId: null;
  derivationCounter: null;
  backupRecordId: null;
  updatedAtMs: number;
}

export function createBrowserProofBackupAuthorityRow(
  proof: BrowserCustodyProofRow,
  observedAtMs: number,
): BrowserProofBackupAuthorityRow {
  if (observedAtMs < proof.receivedAtMs) {
    throw new Error("browser proof backup authority time is stale");
  }
  return requireBrowserProofBackupAuthorityRow({
    schemaVersion: 1,
    scopeId: proof.scopeId,
    proofId: proof.proofId,
    proofFingerprint: proof.proofFingerprint,
    proofRevision: proof.revision,
    proofState: proof.selectability,
    backupState: "local-only",
    derivationKeysetId: null,
    derivationCounter: null,
    backupRecordId: null,
    updatedAtMs: observedAtMs,
  });
}

export function advanceBrowserProofBackupAuthorityRow(
  current: BrowserProofBackupAuthorityRow,
  proof: BrowserCustodyProofRow,
  observedAtMs: number,
): BrowserProofBackupAuthorityRow {
  const authority = requireBrowserProofBackupAuthorityRow(current);
  requireProofBinding(authority, proof);
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

export function requireBrowserProofBackupAuthorityRow(
  value: unknown,
): BrowserProofBackupAuthorityRow {
  const row = requireAuthorityRecord(value);
  const proofState = requireProofState(row.proofState);
  return {
    schemaVersion: 1,
    scopeId: decodeDurableCustodyScopeId(row.scopeId),
    proofId: requireFingerprint(row.proofId, "proof id"),
    proofFingerprint: requireFingerprint(row.proofFingerprint, "proof fingerprint"),
    proofRevision: requireRevision(row.proofRevision),
    proofState,
    backupState: "local-only",
    derivationKeysetId: null,
    derivationCounter: null,
    backupRecordId: null,
    updatedAtMs: requireTime(row.updatedAtMs, "proof backup authority time"),
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
    "backupState",
    "derivationKeysetId",
    "derivationCounter",
    "backupRecordId",
    "updatedAtMs",
  ];
  if (
    row.schemaVersion !== 1 ||
    Object.keys(row).length !== fields.length ||
    fields.some((field) => !(field in row)) ||
    row.backupState !== "local-only" ||
    row.derivationKeysetId !== null ||
    row.derivationCounter !== null ||
    row.backupRecordId !== null
  ) {
    throw new Error("browser proof backup authority is invalid");
  }
  return row;
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
