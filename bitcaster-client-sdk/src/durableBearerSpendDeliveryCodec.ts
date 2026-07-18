import {
  Amount,
  CheckStateEnum,
  hashToCurve,
  hashToCurveBls,
  isBlsKeyset,
  pointFromHex,
  pointFromHexG1,
  type Proof,
} from "@cashu/cashu-ts";
import { decodeStrictCashuProofArtifact } from "./cashuProofArtifact.ts";
import { normalizeDurableWalletMintUrl } from "./durableWalletMintUrl.ts";
import type {
  DurableBearerSpendClassification,
  DurableBearerSpendCompletionActor,
  DurableBearerSpendDeliveryRecord,
  DurableBearerSpendPendingState,
  DurableBearerSpendProofEntry,
  DurableBearerSpendProofState,
  DurableBearerSpendReclaimLineage,
} from "./durableBearerSpendDeliveryTypes.ts";

const IDENTIFIER_MAX_LENGTH = 512;
const UNIT_MAX_LENGTH = 64;
export const DURABLE_BEARER_SPEND_PROOF_COUNT_LIMIT_MAX = 256;

export function decodeDurableBearerSpendDeliveryRecord(
  value: unknown,
): DurableBearerSpendDeliveryRecord {
  const record = requireRecord(value, "bearer delivery record");
  requireExactFields(record, [
    "schemaVersion",
    "deliveryId",
    "walletId",
    "parentOperationId",
    "payloadHandle",
    "mintUrl",
    "unit",
    "tokenDigest",
    "tokenByteLength",
    "proofEntries",
    "origin",
    "reclaim",
    "createdAtMs",
    "state",
  ]);
  if (
    record.schemaVersion !== 1 ||
    (record.origin !== "local" && record.origin !== "restored")
  ) {
    throw new Error("durable bearer delivery record is invalid");
  }
  const deliveryId = requireIdentifier(record.deliveryId, "delivery id");
  const proofEntries = decodeProofEntries(record.proofEntries);
  const createdAtMs = requireTimestamp(record.createdAtMs, "creation time");
  const decoded: DurableBearerSpendDeliveryRecord = {
    schemaVersion: 1,
    deliveryId,
    walletId: requireIdentifier(record.walletId, "wallet id"),
    parentOperationId: requireIdentifier(
      record.parentOperationId,
      "parent operation id",
    ),
    payloadHandle: requireIdentifier(record.payloadHandle, "payload handle"),
    mintUrl: normalizeDurableWalletMintUrl(record.mintUrl),
    unit: requireText(record.unit, "unit", UNIT_MAX_LENGTH),
    tokenDigest: requireFingerprint(record.tokenDigest, "token digest"),
    tokenByteLength: requirePositiveSafeInteger(
      record.tokenByteLength,
      "token byte length",
    ),
    proofEntries,
    origin: record.origin,
    reclaim: decodeReclaimLineage(record.reclaim, deliveryId),
    createdAtMs,
    state: decodeDeliveryState(record.state, proofEntries.length, createdAtMs),
  };
  requireProofEntryStateConsistency(decoded);
  return decoded;
}

function requireProofEntryStateConsistency(
  record: DurableBearerSpendDeliveryRecord,
): void {
  const persistedStates = record.state.proofStates;
  const entryStateConflict =
    persistedStates !== null &&
    persistedStates.some((state, index) =>
      state === CheckStateEnum.SPENT
        ? record.proofEntries[index]?.kind !== "spent"
        : record.proofEntries[index]?.kind !== "active",
    );
  const terminalConflict =
    record.state.kind === "consumed" &&
    (record.proofEntries.some((entry) => entry.kind !== "spent") ||
      record.state.actor !== completionActorFor(record.reclaim, record.origin));
  const pendingCompletedReclaim =
    record.state.kind === "pending" && record.reclaim.kind === "completed";
  const pendingAllSpent =
    record.state.kind === "pending" &&
    record.state.proofStates?.every((state) => state === CheckStateEnum.SPENT);
  const recheckWithoutPreparedLineage =
    record.state.kind === "pending" &&
    record.state.classification === "recheck-required" &&
    record.reclaim.kind !== "prepared";
  const pendingWithoutActiveAuthority =
    record.state.kind === "pending" &&
    record.proofEntries.every((entry) => entry.kind === "spent");
  const reclaimWithoutObservedState =
    record.state.kind === "pending" &&
    record.reclaim.kind !== "none" &&
    record.state.classification === "unverified";
  if (
    entryStateConflict ||
    terminalConflict ||
    pendingCompletedReclaim ||
    pendingAllSpent ||
    recheckWithoutPreparedLineage ||
    pendingWithoutActiveAuthority ||
    reclaimWithoutObservedState
  ) {
    throw new Error("durable bearer delivery record is invalid");
  }
}

export function decodeExactBearerProofVector(value: unknown): Proof[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > DURABLE_BEARER_SPEND_PROOF_COUNT_LIMIT_MAX
  ) {
    throw new Error("durable bearer proof vector is invalid");
  }
  let proofs: Proof[];
  try {
    proofs = value.map(decodeStrictCashuProofArtifact);
  } catch {
    throw new Error("durable bearer proof vector is invalid");
  }
  if (new Set(expectedProofYs(proofs)).size !== proofs.length) {
    throw new Error("durable bearer proof vector is invalid");
  }
  return proofs;
}

export function compactSpentProofEntries(
  entries: readonly DurableBearerSpendProofEntry[],
  states: readonly DurableBearerSpendProofState[],
): DurableBearerSpendProofEntry[] {
  return entries.map((entry, index) => {
    if (entry.kind === "spent" || states[index] !== CheckStateEnum.SPENT) {
      return entry;
    }
    return {
      kind: "spent",
      Y: expectedProofYs([entry.proof])[0]!,
      keysetId: entry.proof.id,
      amount: Amount.from(entry.proof.amount).toBigInt().toString(),
    };
  });
}

export function expectedProofYs(
  proofs: readonly Pick<Proof, "id" | "secret">[],
): string[] {
  const encoder = new TextEncoder();
  return proofs.map(({ id, secret }) => {
    const bytes = encoder.encode(secret);
    return isBlsKeyset(id)
      ? hashToCurveBls(bytes).toHex(true)
      : hashToCurve(bytes).toHex(true);
  });
}

export function classifyProofStateVector(
  states: readonly DurableBearerSpendProofState[],
): "all-unspent" | "pending" | "mixed" | "all-spent" {
  if (states.every((state) => state === CheckStateEnum.UNSPENT)) {
    return "all-unspent";
  }
  if (states.every((state) => state === CheckStateEnum.SPENT)) {
    return "all-spent";
  }
  return states.some((state) => state === CheckStateEnum.PENDING)
    ? "pending"
    : "mixed";
}

export function completionActorFor(
  reclaim: DurableBearerSpendReclaimLineage,
  origin: DurableBearerSpendDeliveryRecord["origin"],
): DurableBearerSpendCompletionActor {
  switch (reclaim.kind) {
    case "completed":
      return "sender-reclaim";
    case "submitted":
      return "unknown";
    case "prepared":
      return origin === "local" ? "recipient" : "unknown";
    case "none":
      return origin === "local" ? "recipient" : "unknown";
  }
}

function decodeDeliveryState(
  value: unknown,
  proofCount: number,
  createdAtMs: number,
): DurableBearerSpendDeliveryRecord["state"] {
  const state = requireRecord(value, "bearer delivery state");
  if (state.kind === "consumed") {
    return decodeConsumedState(state, proofCount, createdAtMs);
  }
  if (state.kind !== "pending") {
    throw new Error("durable bearer delivery state is invalid");
  }
  return decodePendingState(state, proofCount, createdAtMs);
}

function decodeConsumedState(
  state: Record<string, unknown>,
  proofCount: number,
  createdAtMs: number,
): DurableBearerSpendDeliveryRecord["state"] {
  requireExactFields(state, ["kind", "actor", "proofStates", "completedAtMs"]);
  if (
    state.actor !== "recipient" &&
    state.actor !== "sender-reclaim" &&
    state.actor !== "unknown"
  ) {
    throw new Error("durable bearer delivery state is invalid");
  }
  const proofStates = decodePersistedProofStates(state.proofStates, proofCount);
  if (!proofStates.every((candidate) => candidate === CheckStateEnum.SPENT)) {
    throw new Error("durable bearer delivery state is invalid");
  }
  const completedAtMs = requireTimestamp(
    state.completedAtMs,
    "completion time",
  );
  if (completedAtMs < createdAtMs) {
    throw new Error("durable bearer delivery state is invalid");
  }
  return {
    kind: "consumed",
    actor: state.actor,
    proofStates: proofStates as "SPENT"[],
    completedAtMs,
  };
}

function decodePendingState(
  state: Record<string, unknown>,
  proofCount: number,
  createdAtMs: number,
): DurableBearerSpendPendingState {
  requireExactFields(state, [
    "kind",
    "classification",
    "proofStates",
    "attemptCount",
    "lastObservedAtMs",
    "nextAttemptAtMs",
  ]);
  const decoded: DurableBearerSpendPendingState = {
    kind: "pending",
    classification: requireClassification(state.classification),
    proofStates:
      state.proofStates === null
        ? null
        : decodePersistedProofStates(state.proofStates, proofCount),
    attemptCount: requireNonnegativeSafeInteger(
      state.attemptCount,
      "attempt count",
    ),
    lastObservedAtMs:
      state.lastObservedAtMs === null
        ? null
        : requireTimestamp(state.lastObservedAtMs, "last observation time"),
    nextAttemptAtMs: requireTimestamp(
      state.nextAttemptAtMs,
      "next attempt time",
    ),
  };
  requireLegalPendingState(decoded, createdAtMs);
  return decoded;
}

function requireLegalPendingState(
  state: DurableBearerSpendPendingState,
  createdAtMs: number,
): void {
  const expectedKind = state.proofStates
    ? classifyProofStateVector(state.proofStates)
    : null;
  const classificationLegal =
    (state.classification === "unverified" && expectedKind === null) ||
    (state.classification === "all-unspent" &&
      expectedKind === "all-unspent") ||
    (state.classification === "mixed" && expectedKind === "mixed") ||
    (state.classification === "pending" && expectedKind === "pending") ||
    (state.classification === "recheck-required" &&
      (expectedKind === "all-unspent" || expectedKind === "mixed")) ||
    ((state.classification === "blocked" ||
      state.classification === "indeterminate") &&
      expectedKind !== "all-spent");
  const isUnverified = state.classification === "unverified";
  const canonicalAttemptState = isUnverified
    ? state.attemptCount === 0 &&
      state.proofStates === null &&
      state.lastObservedAtMs === null &&
      state.nextAttemptAtMs === createdAtMs
    : state.attemptCount >= 1 && state.lastObservedAtMs !== null;
  if (
    !classificationLegal ||
    !canonicalAttemptState ||
    state.nextAttemptAtMs < createdAtMs ||
    (state.lastObservedAtMs !== null && state.lastObservedAtMs < createdAtMs) ||
    (state.classification === "unverified") !==
      (state.lastObservedAtMs === null) ||
    (state.lastObservedAtMs !== null &&
      state.nextAttemptAtMs <= state.lastObservedAtMs)
  ) {
    throw new Error("durable bearer delivery state is invalid");
  }
}

function decodeReclaimLineage(
  value: unknown,
  deliveryId: string,
): DurableBearerSpendReclaimLineage {
  const lineage = requireRecord(value, "bearer reclaim lineage");
  if (lineage.kind === "none") {
    requireExactFields(lineage, ["kind"]);
    return { kind: "none" };
  }
  if (
    lineage.kind !== "prepared" &&
    lineage.kind !== "submitted" &&
    lineage.kind !== "completed"
  ) {
    throw new Error("durable bearer reclaim lineage is invalid");
  }
  requireExactFields(lineage, [
    "kind",
    "operationId",
    "parentDeliveryId",
    "requestFingerprint",
    "approvedInputFingerprint",
    "approvedInputAmount",
    "approvedFee",
    "approvedReturnAmount",
  ]);
  if (lineage.parentDeliveryId !== deliveryId) {
    throw new Error("durable bearer reclaim lineage is invalid");
  }
  const decoded: Exclude<
    DurableBearerSpendReclaimLineage,
    { kind: "none" }
  > = {
    kind: lineage.kind,
    operationId: requireIdentifier(lineage.operationId, "reclaim operation id"),
    parentDeliveryId: deliveryId,
    requestFingerprint: requireFingerprint(
      lineage.requestFingerprint,
      "reclaim request fingerprint",
    ),
    approvedInputFingerprint: requireFingerprint(
      lineage.approvedInputFingerprint,
      "reclaim approved input fingerprint",
    ),
    approvedInputAmount: requirePositiveAmount(
      lineage.approvedInputAmount,
      "reclaim approved input amount",
    ),
    approvedFee: requireNonnegativeAmount(
      lineage.approvedFee,
      "reclaim approved fee",
    ),
    approvedReturnAmount: requirePositiveAmount(
      lineage.approvedReturnAmount,
      "reclaim approved return amount",
    ),
  };
  if (
    BigInt(decoded.approvedFee) + BigInt(decoded.approvedReturnAmount) !==
    BigInt(decoded.approvedInputAmount)
  ) {
    throw new Error("durable bearer reclaim approved amounts are invalid");
  }
  return decoded;
}

function requirePositiveAmount(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireNonnegativeAmount(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function decodeProofEntries(value: unknown): DurableBearerSpendProofEntry[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > DURABLE_BEARER_SPEND_PROOF_COUNT_LIMIT_MAX
  ) {
    throw new Error("durable bearer proof vector is invalid");
  }
  const entries = value.map(decodeProofEntry);
  const Ys = entries.map((entry) =>
    entry.kind === "spent" ? entry.Y : expectedProofYs([entry.proof])[0]!,
  );
  if (new Set(Ys).size !== Ys.length) {
    throw new Error("durable bearer proof vector is invalid");
  }
  return entries;
}

function decodeProofEntry(value: unknown): DurableBearerSpendProofEntry {
  const entry = requireRecord(value, "bearer proof entry");
  if (entry.kind === "active") {
    requireExactFields(entry, ["kind", "proof"]);
    try {
      return {
        kind: "active",
        proof: decodeStrictCashuProofArtifact(entry.proof),
      };
    } catch {
      throw new Error("durable bearer proof vector is invalid");
    }
  }
  if (entry.kind !== "spent") {
    throw new Error("durable bearer proof vector is invalid");
  }
  requireExactFields(entry, ["kind", "Y", "keysetId", "amount"]);
  const keysetId = requireIdentifier(entry.keysetId, "spent proof keyset id");
  return {
    kind: "spent",
    Y: requireProofY(entry.Y, keysetId),
    keysetId,
    amount: requireCanonicalAmount(entry.amount),
  };
}

function requireProofY(value: unknown, keysetId: string): string {
  if (typeof value !== "string" || value !== value.toLowerCase()) {
    throw new Error("durable bearer spent proof marker is invalid");
  }
  try {
    if (isBlsKeyset(keysetId)) pointFromHexG1(value);
    else pointFromHex(value);
  } catch {
    throw new Error("durable bearer spent proof marker is invalid");
  }
  return value;
}

function requireCanonicalAmount(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("durable bearer spent proof amount is invalid");
  }
  return Amount.from(value).toBigInt().toString();
}

function decodePersistedProofStates(
  value: unknown,
  proofCount: number,
): DurableBearerSpendProofState[] {
  if (!Array.isArray(value) || value.length !== proofCount) {
    throw new Error("durable bearer proof states are invalid");
  }
  return value.map((state) => {
    if (
      state !== CheckStateEnum.UNSPENT &&
      state !== CheckStateEnum.PENDING &&
      state !== CheckStateEnum.SPENT
    ) {
      throw new Error("durable bearer proof states are invalid");
    }
    return state;
  });
}

export function requireRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`durable ${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

export function requireExactFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): void {
  const keys = Object.keys(record);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  ) {
    throw new Error("durable bearer delivery record is invalid");
  }
}

export function requireIdentifier(value: unknown, name: string): string {
  return requireText(value, name, IDENTIFIER_MAX_LENGTH);
}

export function requireText(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`durable bearer ${name} is invalid`);
  }
  return value;
}

export function requireFingerprint(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`durable bearer ${name} is invalid`);
  }
  return value;
}

export function requireTimestamp(value: unknown, name: string): number {
  return requireNonnegativeSafeInteger(value, name);
}

function requirePositiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`durable bearer ${name} is invalid`);
  }
  return value as number;
}

function requireNonnegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`durable bearer ${name} is invalid`);
  }
  return value as number;
}

function requireClassification(
  value: unknown,
): DurableBearerSpendClassification {
  if (
    value !== "unverified" &&
    value !== "all-unspent" &&
    value !== "pending" &&
    value !== "mixed" &&
    value !== "recheck-required" &&
    value !== "blocked" &&
    value !== "indeterminate"
  ) {
    throw new Error("durable bearer classification is invalid");
  }
  return value;
}
