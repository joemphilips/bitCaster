import { Amount, CheckStateEnum, type Proof } from "@cashu/cashu-ts";
import {
  issueDurableBearerCustodyHandoffCapability,
  type DurableBearerCustodyHandoffCapability,
} from "./durableBearerHandoffAuthority.ts";
import {
  classifyProofStateVector,
  compactSpentProofEntries,
  completionActorFor,
  decodeDurableBearerSpendDeliveryRecord,
  decodeExactBearerProofVector,
  expectedProofYs,
  requireFingerprint,
  requireIdentifier,
  requireText,
  requireTimestamp,
} from "./durableBearerSpendDeliveryCodec.ts";
import {
  acknowledgeDurableCustodyWalletSendHandoff,
  classifyDurableCustodyWalletSendHandoffBoundary,
  deriveDurableCustodyArtifactFingerprint,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyState,
  type DurableCustodyWalletStorageBoundary,
} from "./durableCustody.ts";
import type {
  DurableBearerSpendClassification,
  DurableBearerSpendCompletionActor,
  DurableBearerSpendDeliveryEvidence,
  DurableBearerSpendDeliveryRecord,
  DurableBearerSpendPendingState,
  DurableBearerSpendProofEntry,
  DurableBearerSpendProofState,
  DurableBearerSpendProofStateChecker,
  DurableBearerSpendReclaimLineage,
  DurableBearerSpendReclaimTransition,
} from "./durableBearerSpendDeliveryTypes.ts";
import { requireExactDurableWalletSendToken } from "./durableWalletSendDelivery.ts";
import { normalizeDurableWalletMintUrl } from "./durableWalletMintUrl.ts";
import { sameCashuProofArtifact } from "./proofSelection.ts";

export type {
  DurableBearerSpendClassification,
  DurableBearerSpendCompletionActor,
  DurableBearerSpendConsumedState,
  DurableBearerSpendDeliveryRecord,
  DurableBearerSpendPendingState,
  DurableBearerSpendProofEntry,
  DurableBearerSpendProofState,
  DurableBearerSpendProofStateChecker,
  DurableBearerSpendReclaimLineage,
  DurableBearerSpendReclaimTransition,
} from "./durableBearerSpendDeliveryTypes.ts";
export { decodeDurableBearerSpendDeliveryRecord } from "./durableBearerSpendDeliveryCodec.ts";

const UNIT_MAX_LENGTH = 64;
const PROOF_STATE_WITNESS_MAX_LENGTH = 16_384;
const RECONCILE_BACKOFF_BASE_MS = 5_000;
const RECONCILE_BACKOFF_MAX_MS = 5 * 60_000;
const RECONCILE_BACKOFF_EXPONENT_MAX = 6;

interface DurableBearerSpendCustodyHandoffPlanAuthority {
  previousCustodyFingerprint: string;
  nextCustodyFingerprint: string;
  bearerRecordFingerprint: string;
}

const custodyHandoffPlanAuthorities = new WeakMap<
  DurableBearerSpendCustodyHandoffPlan,
  DurableBearerSpendCustodyHandoffPlanAuthority
>();

type ValidProofStateClassification =
  | {
      kind: "all-unspent" | "pending" | "mixed" | "all-spent";
      proofStates: readonly DurableBearerSpendProofState[];
    }
  | { kind: "blocked" };

export function createDurableBearerSpendDeliveryRecord(input: {
  deliveryId: string;
  walletId: string;
  parentOperationId: string;
  payloadHandle: string;
  mintUrl: string;
  unit: string;
  encodedToken: string;
  proofs: readonly Proof[];
  origin: "local" | "restored";
  createdAtMs: number;
}): DurableBearerSpendDeliveryRecord {
  const proofs = decodeExactBearerProofVector(input.proofs);
  const mintUrl = normalizeDurableWalletMintUrl(input.mintUrl);
  const unit = requireText(input.unit, "unit", UNIT_MAX_LENGTH);
  const descriptor = requireExactDurableWalletSendToken({
    encodedToken: input.encodedToken,
    mintUrl,
    unit,
    sendProofs: proofs,
  });
  return decodeDurableBearerSpendDeliveryRecord({
    schemaVersion: 1,
    deliveryId: requireIdentifier(input.deliveryId, "delivery id"),
    walletId: requireIdentifier(input.walletId, "wallet id"),
    parentOperationId: requireIdentifier(
      input.parentOperationId,
      "parent operation id",
    ),
    payloadHandle: requireIdentifier(input.payloadHandle, "payload handle"),
    mintUrl,
    unit,
    tokenDigest: descriptor.tokenDigest,
    tokenByteLength: descriptor.byteLength,
    proofEntries: proofs.map((proof) => ({ kind: "active", proof })),
    origin: input.origin,
    reclaim: { kind: "none" },
    createdAtMs: requireTimestamp(input.createdAtMs, "creation time"),
    state: {
      kind: "pending",
      classification: "unverified",
      proofStates: null,
      attemptCount: 0,
      lastObservedAtMs: null,
      nextAttemptAtMs: input.createdAtMs,
    },
  });
}

/**
 * Reconcile through cashu-ts' exact ordered `checkProofsStates` behavior.
 * Transport failures never become completion evidence.
 */
export async function reconcileDurableBearerSpendDelivery(input: {
  record: DurableBearerSpendDeliveryRecord;
  checker: DurableBearerSpendProofStateChecker;
  observedAtMs: number;
}): Promise<DurableBearerSpendDeliveryRecord> {
  const record = decodeDurableBearerSpendDeliveryRecord(input.record);
  const observedAtMs = requireTimestamp(input.observedAtMs, "observation time");
  if (record.state.kind === "consumed") return record;
  requireMonotonicObservation(record, observedAtMs);
  let states: unknown;
  try {
    states = await input.checker.checkProofsStates(
      record.proofEntries.flatMap((entry) =>
        entry.kind === "active"
          ? [{ id: entry.proof.id, secret: entry.proof.secret }]
          : [],
      ),
    );
  } catch {
    return reduceBearerSpendDelivery(record, {
      kind: "indeterminate",
      observedAtMs,
    });
  }
  return reduceBearerSpendDelivery(record, {
    kind: "proof-states",
    observedAtMs,
    states,
  });
}

function reduceBearerSpendDelivery(
  current: DurableBearerSpendDeliveryRecord,
  evidence: DurableBearerSpendDeliveryEvidence,
): DurableBearerSpendDeliveryRecord {
  const record = decodeDurableBearerSpendDeliveryRecord(current);
  if (record.state.kind === "consumed") return record;
  const observedAtMs = requireTimestamp(
    evidence.observedAtMs,
    "observation time",
  );
  requireMonotonicObservation(record, observedAtMs);
  if (evidence.kind === "indeterminate") {
    return withPendingClassification(
      record,
      record.state,
      "indeterminate",
      observedAtMs,
      record.state.proofStates,
    );
  }
  if (evidence.kind !== "proof-states") {
    return assertNever(evidence);
  }
  const classification = classifyExactProofStates(record, evidence.states);
  if (classification.kind === "blocked") {
    return withPendingClassification(
      record,
      record.state,
      "blocked",
      observedAtMs,
      record.state.proofStates,
    );
  }
  const proofEntries = compactSpentProofEntries(
    record.proofEntries,
    classification.proofStates,
  );
  if (classification.kind === "all-spent") {
    return decodeDurableBearerSpendDeliveryRecord({
      ...record,
      proofEntries,
      state: {
        kind: "consumed",
        actor: deriveCompletionActor(record),
        proofStates: classification.proofStates,
        completedAtMs: observedAtMs,
      },
    });
  }
  return withPendingClassification(
    { ...record, proofEntries },
    record.state,
    classification.kind,
    observedAtMs,
    classification.proofStates,
  );
}

export function reduceDurableBearerSpendReclaimLineage(
  current: DurableBearerSpendDeliveryRecord,
  transition: DurableBearerSpendReclaimTransition,
): DurableBearerSpendDeliveryRecord {
  const record = decodeDurableBearerSpendDeliveryRecord(current);
  const next = {
    kind: transition.kind,
    operationId: requireIdentifier(
      transition.operationId,
      "reclaim operation id",
    ),
    parentDeliveryId: record.deliveryId,
    requestFingerprint: requireFingerprint(
      transition.requestFingerprint,
      "reclaim request fingerprint",
    ),
  } as Exclude<DurableBearerSpendReclaimLineage, { kind: "none" }>;
  requireReclaimTransition(record, next);
  const state =
    record.reclaim.kind === "none" &&
    next.kind === "prepared" &&
    record.state.kind === "pending"
      ? { ...record.state, classification: "recheck-required" as const }
      : record.state;
  const updated: DurableBearerSpendDeliveryRecord = {
    ...record,
    reclaim: next,
    state,
  };
  return decodeDurableBearerSpendDeliveryRecord(updated);
}

/** Exact authority available to an explicit reclaim after a fresh allowed check. */
export function selectDurableBearerSpendUnspentProofs(
  value: DurableBearerSpendDeliveryRecord,
): Proof[] {
  const record = decodeDurableBearerSpendDeliveryRecord(value);
  if (
    record.state.kind !== "pending" ||
    (record.reclaim.kind !== "none" && record.reclaim.kind !== "prepared") ||
    (record.state.classification !== "all-unspent" &&
      record.state.classification !== "mixed") ||
    record.state.proofStates === null
  ) {
    throw new Error("durable bearer delivery is not cancellable");
  }
  return record.proofEntries.flatMap((entry, index) =>
    entry.kind === "active" &&
    record.state.kind === "pending" &&
    record.state.proofStates?.[index] === CheckStateEnum.UNSPENT
      ? [entry.proof]
      : [],
  );
}

export function isDurableBearerSpendTokenPresentable(
  value: DurableBearerSpendDeliveryRecord,
): boolean {
  const record = decodeDurableBearerSpendDeliveryRecord(value);
  return (
    record.state.kind === "pending" &&
    record.reclaim.kind === "none" &&
    !record.state.proofStates?.includes(CheckStateEnum.SPENT)
  );
}

/**
 * Proves that every compacted or active entry still occupies the exact
 * position of the original bearer token proof vector.
 */
export function requireDurableBearerSpendOriginalProofLineage(
  value: DurableBearerSpendDeliveryRecord,
  originalProofs: readonly Proof[],
): DurableBearerSpendDeliveryRecord {
  const record = decodeDurableBearerSpendDeliveryRecord(value);
  const originals = decodeExactBearerProofVector(originalProofs);
  if (
    record.proofEntries.length !== originals.length ||
    record.proofEntries.some(
      (entry, index) => !entryMatchesOriginalProof(entry, originals[index]),
    )
  ) {
    throw new Error("durable bearer original proof lineage is invalid");
  }
  return record;
}

function entryMatchesOriginalProof(
  entry: DurableBearerSpendProofEntry,
  original: Proof | undefined,
): boolean {
  if (!original) return false;
  if (entry.kind === "active") {
    return sameCashuProofArtifact(entry.proof, original);
  }
  return (
    entry.Y === expectedProofYs([original])[0] &&
    entry.keysetId === original.id &&
    entry.amount === Amount.from(original.amount).toBigInt().toString()
  );
}

export interface DurableBearerSpendCustodyHandoffPlan {
  readonly bearerRecord: DurableBearerSpendDeliveryRecord;
  readonly custodyState: DurableCustodyState;
}

/**
 * Couples the exact bearer row with the only custody transition it authorizes.
 * The adapter must persist both post-images in one physical transaction.
 */
export function planDurableBearerSpendCustodyHandoff(input: {
  bearerRecord: DurableBearerSpendDeliveryRecord;
  custodyState: DurableCustodyState;
  authorization: DurableCustodyOwnerAuthorization;
}): DurableBearerSpendCustodyHandoffPlan {
  const record = decodeDurableBearerSpendDeliveryRecord(input.bearerRecord);
  if (record.state.kind !== "pending") {
    throw new Error("durable bearer delivery cannot be handed off");
  }
  const capability: DurableBearerCustodyHandoffCapability =
    issueDurableBearerCustodyHandoffCapability({
      walletId: record.walletId,
      operationId: record.parentOperationId,
      deliveryId: record.deliveryId,
      payloadHandle: record.payloadHandle,
      payloadFingerprint: record.tokenDigest,
      mintUrl: record.mintUrl,
      unit: record.unit,
    });
  const custodyState = acknowledgeDurableCustodyWalletSendHandoff(
    input.custodyState,
    { ...input.authorization, capability },
  );
  classifyDurableCustodyWalletSendHandoffBoundary({
    previous: input.custodyState.operation,
    next: custodyState.operation,
    capability,
  });
  const plan = Object.freeze({
    bearerRecord: record,
    custodyState,
  });
  custodyHandoffPlanAuthorities.set(plan, {
    previousCustodyFingerprint: handoffPlanFingerprint(input.custodyState),
    nextCustodyFingerprint: handoffPlanFingerprint(custodyState),
    bearerRecordFingerprint: handoffPlanFingerprint(record),
  });
  return plan;
}

/** Validates the exact branded post-images before one adapter transaction. */
export function classifyDurableBearerSpendCustodyHandoffPlan(input: {
  previousCustodyState: DurableCustodyState;
  plan: DurableBearerSpendCustodyHandoffPlan;
}): DurableCustodyWalletStorageBoundary {
  const authority = custodyHandoffPlanAuthorities.get(input.plan);
  if (
    authority?.previousCustodyFingerprint !==
      handoffPlanFingerprint(input.previousCustodyState) ||
    authority.nextCustodyFingerprint !==
      handoffPlanFingerprint(input.plan.custodyState) ||
    authority.bearerRecordFingerprint !==
      handoffPlanFingerprint(
        decodeDurableBearerSpendDeliveryRecord(input.plan.bearerRecord),
      )
  ) {
    throw new Error("durable bearer custody handoff plan is invalid");
  }
  return "reconciliation-only";
}

function handoffPlanFingerprint(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error("durable bearer custody handoff plan is invalid");
  }
  return deriveDurableCustodyArtifactFingerprint(JSON.parse(json));
}

function requireMonotonicObservation(
  record: DurableBearerSpendDeliveryRecord,
  observedAtMs: number,
): void {
  if (
    observedAtMs < record.createdAtMs ||
    (record.state.kind === "pending" &&
      record.state.lastObservedAtMs !== null &&
      observedAtMs < record.state.lastObservedAtMs)
  ) {
    throw new Error("durable bearer observation time is invalid");
  }
}

function withPendingClassification(
  record: DurableBearerSpendDeliveryRecord,
  previous: DurableBearerSpendPendingState,
  classification: Exclude<DurableBearerSpendClassification, "unverified">,
  observedAtMs: number,
  proofStates: readonly DurableBearerSpendProofState[] | null,
): DurableBearerSpendDeliveryRecord {
  const attemptCount = incrementAttemptCount(previous.attemptCount);
  return decodeDurableBearerSpendDeliveryRecord({
    ...record,
    state: {
      kind: "pending",
      classification,
      proofStates,
      attemptCount,
      lastObservedAtMs: observedAtMs,
      nextAttemptAtMs: safeAdd(observedAtMs, reconcileBackoffMs(attemptCount)),
    },
  });
}

function classifyExactProofStates(
  record: DurableBearerSpendDeliveryRecord,
  value: unknown,
): ValidProofStateClassification {
  const activeEntries = record.proofEntries.filter(
    (
      entry,
    ): entry is Extract<DurableBearerSpendProofEntry, { kind: "active" }> =>
      entry.kind === "active",
  );
  if (!Array.isArray(value) || value.length !== activeEntries.length) {
    return { kind: "blocked" };
  }
  const expectedYs = expectedProofYs(activeEntries.map(({ proof }) => proof));
  const observed: DurableBearerSpendProofState[] = [];
  for (let index = 0; index < activeEntries.length; index += 1) {
    const state = decodeExactProofState(value[index], expectedYs[index]);
    if (state === null) return { kind: "blocked" };
    observed.push(state);
  }
  let activeIndex = 0;
  const proofStates = record.proofEntries.map((entry) =>
    entry.kind === "spent" ? CheckStateEnum.SPENT : observed[activeIndex++]!,
  );
  const kind = classifyProofStateVector(proofStates);
  return {
    kind,
    proofStates,
  };
}

function decodeExactProofState(
  value: unknown,
  expectedY: string | undefined,
): DurableBearerSpendProofState | null {
  if (
    expectedY === undefined ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "Y" ||
    keys[1] !== "state" ||
    keys[2] !== "witness" ||
    state.Y !== expectedY ||
    (state.state !== CheckStateEnum.UNSPENT &&
      state.state !== CheckStateEnum.PENDING &&
      state.state !== CheckStateEnum.SPENT) ||
    (state.witness !== null &&
      (typeof state.witness !== "string" ||
        state.witness.length > PROOF_STATE_WITNESS_MAX_LENGTH))
  ) {
    return null;
  }
  return state.state;
}

function deriveCompletionActor(
  record: DurableBearerSpendDeliveryRecord,
): DurableBearerSpendCompletionActor {
  return completionActorFor(record.reclaim, record.origin);
}

function requireReclaimTransition(
  record: DurableBearerSpendDeliveryRecord,
  next: Exclude<DurableBearerSpendReclaimLineage, { kind: "none" }>,
): void {
  const before = record.reclaim;
  if (before.kind === next.kind && sameReclaimIdentity(before, next)) return;
  const legal =
    (before.kind === "none" &&
      next.kind === "prepared" &&
      record.state.kind === "pending" &&
      (record.state.classification === "all-unspent" ||
        record.state.classification === "mixed")) ||
    (before.kind === "prepared" &&
      next.kind === "submitted" &&
      record.state.kind === "pending" &&
      (record.state.classification === "all-unspent" ||
        record.state.classification === "mixed"));
  if (
    !legal ||
    (before.kind !== "none" && !sameReclaimIdentity(before, next))
  ) {
    throw new Error("durable bearer reclaim transition is invalid");
  }
}

function sameReclaimIdentity(
  left: Exclude<DurableBearerSpendReclaimLineage, { kind: "none" }>,
  right: Exclude<DurableBearerSpendReclaimLineage, { kind: "none" }>,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.parentDeliveryId === right.parentDeliveryId &&
    left.requestFingerprint === right.requestFingerprint
  );
}

function incrementAttemptCount(value: number): number {
  return value === Number.MAX_SAFE_INTEGER ? value : value + 1;
}

function reconcileBackoffMs(attemptCount: number): number {
  const exponent = Math.min(
    Math.max(attemptCount - 1, 0),
    RECONCILE_BACKOFF_EXPONENT_MAX,
  );
  return Math.min(
    RECONCILE_BACKOFF_MAX_MS,
    RECONCILE_BACKOFF_BASE_MS * 2 ** exponent,
  );
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error("durable bearer next attempt time is invalid");
  }
  return result;
}

function assertNever(value: never): never {
  throw new Error(`unhandled durable bearer variant: ${String(value)}`);
}
