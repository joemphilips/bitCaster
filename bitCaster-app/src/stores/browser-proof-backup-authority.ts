import { decodeDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import type {
  BrowserCustodyProofRow,
  BrowserCustodyProofSelectability,
} from "./durable-custody-types";

const MODERN_KEYSET_ID = /^(?:01|02)[0-9a-f]{64}$/;
const DERIVATION_COUNTER_MAX = 2_147_483_647;

export interface BrowserProofDerivationLocator {
  readonly keysetId: string;
  readonly counter: number;
}

export type BrowserProofDerivationLocatorAuthority = BrowserProofDerivationLocator | null;

export interface BrowserProofBackupAuthorityRow {
  schemaVersion: 1;
  scopeId: string;
  proofId: string;
  proofFingerprint: string;
  proofRevision: number;
  proofState: BrowserCustodyProofSelectability;
  backupState: "local-only";
  derivationKeysetId: string | null;
  derivationCounter: number | null;
  backupRecordId: null;
  updatedAtMs: number;
}

export function createBrowserProofBackupAuthorityRow(
  proof: BrowserCustodyProofRow,
  observedAtMs: number,
  derivationLocator: BrowserProofDerivationLocatorAuthority,
): BrowserProofBackupAuthorityRow {
  if (observedAtMs < proof.receivedAtMs) {
    throw new Error("browser proof backup authority time is stale");
  }
  assertLocatorMatchesProof(requireBrowserProofDerivationLocator(derivationLocator), proof);
  return requireBrowserProofBackupAuthorityRow({
    schemaVersion: 1,
    scopeId: proof.scopeId,
    proofId: proof.proofId,
    proofFingerprint: proof.proofFingerprint,
    proofRevision: proof.revision,
    proofState: proof.selectability,
    backupState: "local-only",
    ...derivationLocatorFields(derivationLocator),
    backupRecordId: null,
    updatedAtMs: observedAtMs,
  });
}

export function advanceBrowserProofBackupAuthorityRow(
  current: BrowserProofBackupAuthorityRow,
  proof: BrowserCustodyProofRow,
  observedAtMs: number,
  derivationLocator: BrowserProofDerivationLocatorAuthority,
): BrowserProofBackupAuthorityRow {
  const authority = requireBrowserProofBackupAuthorityRow(current);
  requireProofBinding(authority, proof);
  const currentLocator = derivationLocatorOf(authority);
  const requestedLocator = requireBrowserProofDerivationLocator(derivationLocator);
  assertLocatorMatchesProof(currentLocator, proof);
  assertLocatorMatchesProof(requestedLocator, proof);
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

export function requireBrowserProofBackupAuthorityRow(
  value: unknown,
): BrowserProofBackupAuthorityRow {
  const row = requireAuthorityRecord(value);
  const proofState = requireProofState(row.proofState);
  const derivationLocator = requireBrowserProofDerivationLocator({
    keysetId: row.derivationKeysetId,
    counter: row.derivationCounter,
  });
  return {
    schemaVersion: 1,
    scopeId: decodeDurableCustodyScopeId(row.scopeId),
    proofId: requireFingerprint(row.proofId, "proof id"),
    proofFingerprint: requireFingerprint(row.proofFingerprint, "proof fingerprint"),
    proofRevision: requireRevision(row.proofRevision),
    proofState,
    backupState: "local-only",
    ...derivationLocatorFields(derivationLocator),
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
    row.backupRecordId !== null
  ) {
    throw new Error("browser proof backup authority is invalid");
  }
  return row;
}

export function requireBrowserProofDerivationLocator(
  value: unknown,
): BrowserProofDerivationLocatorAuthority {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("browser proof backup derivation locator is invalid");
  }
  const locator = value as Record<string, unknown>;
  if (Object.keys(locator).length !== 2 || !("keysetId" in locator) || !("counter" in locator)) {
    throw new Error("browser proof backup derivation locator is invalid");
  }
  if (locator.keysetId === null && locator.counter === null) return null;
  if (!isCanonicalDerivationKeysetId(locator.keysetId) || !isDerivationCounter(locator.counter)) {
    throw new Error("browser proof backup derivation locator is invalid");
  }
  return { keysetId: locator.keysetId, counter: locator.counter };
}

export function requireBrowserProofBackupAuthorityForProof(
  value: unknown,
  proof: BrowserCustodyProofRow,
): BrowserProofBackupAuthorityRow {
  const authority = requireBrowserProofBackupAuthorityRow(value);
  requireProofBinding(authority, proof);
  assertLocatorMatchesProof(derivationLocatorOf(authority), proof);
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

function assertLocatorMatchesProof(
  locator: BrowserProofDerivationLocatorAuthority,
  proof: BrowserCustodyProofRow,
): void {
  if (locator !== null && locator.keysetId !== proof.keysetId) {
    throw new Error("browser proof backup derivation locator keyset is foreign");
  }
}

function derivationLocatorOf(
  authority: BrowserProofBackupAuthorityRow,
): BrowserProofDerivationLocatorAuthority {
  return requireBrowserProofDerivationLocator({
    keysetId: authority.derivationKeysetId,
    counter: authority.derivationCounter,
  });
}

function derivationLocatorFields(
  locator: BrowserProofDerivationLocatorAuthority,
): Pick<BrowserProofBackupAuthorityRow, "derivationKeysetId" | "derivationCounter"> {
  const required = requireBrowserProofDerivationLocator(locator);
  return required === null
    ? { derivationKeysetId: null, derivationCounter: null }
    : { derivationKeysetId: required.keysetId, derivationCounter: required.counter };
}

export function sameBrowserProofDerivationLocator(
  left: BrowserProofDerivationLocatorAuthority,
  right: BrowserProofDerivationLocatorAuthority,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.keysetId === right.keysetId &&
      left.counter === right.counter)
  );
}

function isCanonicalDerivationKeysetId(value: unknown): value is string {
  return typeof value === "string" && MODERN_KEYSET_ID.test(value);
}

function isDerivationCounter(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= DERIVATION_COUNTER_MAX
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
