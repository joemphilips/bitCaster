import type {
  EncryptedWalletBackupCtfMetadata,
  EncryptedWalletBackupCtfTerminalEvidence,
} from "@bitcaster/client-sdk/encryptedWalletBackup";
import {
  decodeDurableWalletStorageClassification,
  type DurableWalletStorageClassification,
} from "@bitcaster/client-sdk/recoverableWalletStorage";
import {
  parseCashuProofUnit,
  type CashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import { normalizeUrl } from "../lib/url";
import { requireGuiWalletId } from "./proof-db";

export type GuiProofSpendDisposition =
  | "active-selectable"
  | "active-reserved"
  | "retained-nonselectable";

export type GuiProofNonselectableReason =
  | "recorded-ctf-expiry-passed"
  | "verified-losing-outcome";

export type GuiProofDerivationLocator =
  | Readonly<{ kind: "nut13"; keysetId: string; counter: number }>
  | Readonly<{ kind: "non-deterministic" }>;

export interface GuiProofBackupAuthorityRow {
  walletId: string;
  proofId: string;
  mintUrl: string;
  unit: CashuProofUnit;
  amount: number;
  proofKind: "ordinary" | "ctf" | "p2pk" | "htlc" | "unknown";
  conditionId: string | null;
  outcomeCollection: string | null;
  finalExpiryUnixSeconds: number | null;
  spendDisposition: GuiProofSpendDisposition;
  nonselectableReason: GuiProofNonselectableReason | null;
  derivationLocator: GuiProofDerivationLocator;
  proofCommitment: string;
  ctfMetadata: EncryptedWalletBackupCtfMetadata | null;
  terminalEvidence: EncryptedWalletBackupCtfTerminalEvidence | null;
  storageClassification: DurableWalletStorageClassification;
  revision: number;
  updatedAtMs: number;
}

export function requireGuiProofBackupAuthorityRow(
  candidate: GuiProofBackupAuthorityRow,
  walletId = candidate.walletId,
): GuiProofBackupAuthorityRow {
  requireGuiWalletId(walletId);
  requireExactFields(candidate, PROOF_AUTHORITY_FIELDS, "proof authority");
  if (candidate.walletId !== walletId) {
    throw new Error("GUI proof authority belongs to another wallet");
  }
  requireLowerHex(candidate.proofId, "proof id");
  requireLowerHex(candidate.proofCommitment, "proof commitment");
  requirePositiveInteger(candidate.amount, "proof amount");
  if (parseCashuProofUnit(candidate.unit) !== candidate.unit) {
    throw new Error("GUI proof authority unit is invalid");
  }
  requireNonNegativeInteger(candidate.revision, "proof authority revision");
  requireNonNegativeInteger(candidate.updatedAtMs, "proof authority time");
  const classification = decodeDurableWalletStorageClassification(
    candidate.storageClassification,
  );
  if (
    classification.recordId !== candidate.proofId ||
    classification.recordKind !== "deterministic-proof" ||
    classification.proofCommitment !== candidate.proofCommitment
  ) {
    throw new Error("GUI proof storage classification conflicts");
  }
  requireProofKind(candidate.proofKind);
  requireSpendDisposition(candidate);
  requireDerivationLocator(candidate);
  requireLocatorClassification(candidate, classification);
  requireCtfTuple(candidate);
  requireClassificationDisposition(candidate, classification);
  return structuredClone({
    ...candidate,
    mintUrl: normalizeUrl(candidate.mintUrl),
    storageClassification: classification,
  });
}

function requireSpendDisposition(candidate: GuiProofBackupAuthorityRow): void {
  switch (candidate.spendDisposition) {
    case "active-selectable":
    case "active-reserved":
      if (candidate.nonselectableReason !== null) {
        throw new Error("GUI active proof has a nonselectable reason");
      }
      return;
    case "retained-nonselectable":
      if (
        candidate.proofKind !== "ctf" ||
        (candidate.nonselectableReason !== "recorded-ctf-expiry-passed" &&
          candidate.nonselectableReason !== "verified-losing-outcome")
      ) {
        throw new Error("GUI retained proof disposition is invalid");
      }
      return;
    default:
      throw new Error("GUI proof spend disposition is invalid");
  }
}

function requireClassificationDisposition(
  candidate: GuiProofBackupAuthorityRow,
  classification: DurableWalletStorageClassification,
): void {
  if (
    candidate.spendDisposition === "retained-nonselectable" &&
    classification.storageClass !== "user-retained-nonselectable-ctf"
  ) {
    throw new Error("GUI retained proof storage classification conflicts");
  }
  if (
    candidate.spendDisposition !== "retained-nonselectable" &&
    classification.storageClass === "user-retained-nonselectable-ctf"
  ) {
    throw new Error("GUI active proof storage classification conflicts");
  }
}

function requireDerivationLocator(candidate: GuiProofBackupAuthorityRow): void {
  const locator = candidate.derivationLocator;
  if (locator.kind === "non-deterministic") {
    requireExactFields(locator, ["kind"], "proof derivation locator");
    return;
  }
  if (locator.kind !== "nut13") {
    throw new Error("GUI proof derivation locator is invalid");
  }
  requireExactFields(
    locator,
    ["kind", "keysetId", "counter"],
    "proof derivation locator",
  );
  requireBoundedText(locator.keysetId, 256, "derivation keyset id");
  requireNonNegativeInteger(locator.counter, "derivation counter");
}

function requireLocatorClassification(
  candidate: GuiProofBackupAuthorityRow,
  classification: DurableWalletStorageClassification,
): void {
  const missing = classification.pinReasons.includes(
    "missing-derivation-locator",
  );
  if ((candidate.derivationLocator.kind === "non-deterministic") !== missing) {
    throw new Error("GUI proof derivation classification conflicts");
  }
}

function requireCtfTuple(candidate: GuiProofBackupAuthorityRow): void {
  if (candidate.proofKind !== "ctf") {
    if (
      candidate.conditionId !== null ||
      candidate.outcomeCollection !== null ||
      candidate.finalExpiryUnixSeconds !== null ||
      candidate.ctfMetadata !== null ||
      candidate.terminalEvidence !== null
    ) {
      throw new Error("GUI ordinary proof has conditional authority");
    }
    return;
  }
  const metadata = candidate.ctfMetadata;
  if (metadata === null) throw new Error("GUI CTF proof authority is missing");
  requireExactFields(metadata, CTF_FIELDS, "CTF authority");
  requireLowerHex(metadata.conditionId, "condition id");
  requireBoundedText(metadata.outcomeLabel, 512, "outcome label");
  requireLowerHex(metadata.outcomeCollectionId, "outcome collection id");
  requireNonNegativeInteger(
    metadata.registeredAtUnixSeconds,
    "CTF registration time",
  );
  requireNonNegativeInteger(
    metadata.finalExpiryUnixSeconds,
    "CTF final expiry",
  );
  if (metadata.finalExpiryUnixSeconds <= metadata.registeredAtUnixSeconds) {
    throw new Error("GUI CTF proof expiry is invalid");
  }
  if (
    candidate.conditionId !== metadata.conditionId ||
    candidate.outcomeCollection !== metadata.outcomeLabel ||
    candidate.finalExpiryUnixSeconds !== metadata.finalExpiryUnixSeconds
  ) {
    throw new Error("GUI CTF proof authority mirrors conflict");
  }
  requireTerminalEvidence(candidate);
}

function requireTerminalEvidence(candidate: GuiProofBackupAuthorityRow): void {
  const evidence = candidate.terminalEvidence;
  if (evidence === null) {
    if (candidate.nonselectableReason === "verified-losing-outcome") {
      throw new Error("GUI losing CTF proof evidence is missing");
    }
    return;
  }
  requireExactFields(evidence, TERMINAL_FIELDS, "CTF terminal evidence");
  if (
    evidence.reason !== "verified-losing-outcome" ||
    evidence.failureCode !== 13015 ||
    candidate.spendDisposition !== "retained-nonselectable" ||
    candidate.nonselectableReason !== "verified-losing-outcome"
  ) {
    throw new Error("GUI CTF terminal evidence is invalid");
  }
  requireLowerHex(evidence.operationIdDigest, "terminal operation digest");
  requireLowerHex(evidence.requestDigest, "terminal request digest");
  requireNonNegativeInteger(
    evidence.classifiedAt,
    "terminal classification time",
  );
}

function requireProofKind(
  value: GuiProofBackupAuthorityRow["proofKind"],
): void {
  if (!PROOF_KINDS.has(value)) {
    throw new Error("GUI proof kind is invalid");
  }
}

function requireExactFields(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  if (
    actual.length !== fields.length ||
    actual.some((field, index) => field !== fields[index])
  ) {
    throw new Error(`GUI ${label} fields are invalid`);
  }
}

function requireLowerHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`GUI ${label} is invalid`);
  }
  return value;
}

function requireBoundedText(
  value: unknown,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`GUI ${label} is invalid`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`GUI ${label} is invalid`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const integer = requireNonNegativeInteger(value, label);
  if (integer === 0) throw new Error(`GUI ${label} is invalid`);
  return integer;
}

const PROOF_KINDS = new Set(["ordinary", "ctf", "p2pk", "htlc", "unknown"]);
const CTF_FIELDS = [
  "conditionId",
  "outcomeLabel",
  "outcomeCollectionId",
  "registeredAtUnixSeconds",
  "finalExpiryUnixSeconds",
] as const;
const TERMINAL_FIELDS = [
  "reason",
  "operationIdDigest",
  "requestDigest",
  "failureCode",
  "classifiedAt",
] as const;
const PROOF_AUTHORITY_FIELDS = [
  "walletId",
  "proofId",
  "mintUrl",
  "unit",
  "amount",
  "proofKind",
  "conditionId",
  "outcomeCollection",
  "finalExpiryUnixSeconds",
  "spendDisposition",
  "nonselectableReason",
  "derivationLocator",
  "proofCommitment",
  "ctfMetadata",
  "terminalEvidence",
  "storageClassification",
  "revision",
  "updatedAtMs",
] as const;
