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
  decodeDurableCustodyRecord,
  decodeDurableCustodyScopeState,
  deriveDurableCustodyArtifactFingerprint,
  encodeBoundedDurableArtifact,
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
import { type DurableWalletSendExactPayload } from "./durableWalletSendExactPayload.ts";
import { requireDurableWalletSendExactPayloadCapability } from "./durableWalletSendExactPayloadAuthority.ts";
import {
  decodeDurableWalletOperation,
  requireDurableWalletReceiveExactResultCapability,
  requireExactDurableWalletReceiveResult,
  type DurableWalletProof,
} from "./durableWalletOperation.ts";

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

export interface DurableBearerSpendReclaimCompletionCapability {
  readonly operationId: string;
  readonly requestFingerprint: string;
  readonly approvedInputFingerprint: string;
  readonly approvedInputAmount: string;
  readonly approvedFee: string;
  readonly approvedReturnAmount: string;
  readonly childResultFingerprint: string;
}

interface DurableBearerSpendReclaimCompletionAuthority {
  recordFingerprint: string;
  operationId: string;
  requestFingerprint: string;
  approvedInputFingerprint: string;
  approvedInputAmount: string;
  approvedFee: string;
  approvedReturnAmount: string;
  childResultFingerprint: string;
}

const reclaimCompletionAuthorities = new WeakMap<
  DurableBearerSpendReclaimCompletionCapability,
  DurableBearerSpendReclaimCompletionAuthority
>();

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

/** Canonical fingerprint for an exact persisted bearer-delivery record. */
export function deriveDurableBearerSpendDeliveryRecordFingerprint(
  value: unknown,
): string {
  return handoffPlanFingerprint(decodeDurableBearerSpendDeliveryRecord(value));
}

/** Canonical bytes for a decoded persisted bearer-delivery record. */
export function encodeDurableBearerSpendDeliveryRecord(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  const decoded = decodeDurableBearerSpendDeliveryRecord(value);
  return encodeBoundedDurableArtifact(
    JSON.parse(JSON.stringify(decoded)) as unknown,
    maximumBytes,
  );
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
    approvedInputFingerprint: requireFingerprint(
      transition.approvedInputFingerprint,
      "reclaim approved input fingerprint",
    ),
    approvedInputAmount: requirePositiveAmount(
      transition.approvedInputAmount,
      "reclaim approved input amount",
    ),
    approvedFee: requireNonnegativeAmount(
      transition.approvedFee,
      "reclaim approved fee",
    ),
    approvedReturnAmount: requirePositiveAmount(
      transition.approvedReturnAmount,
      "reclaim approved return amount",
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

export interface DurableBearerSpendReclaimIntent {
  operationId: string;
  requestFingerprint: string;
  approvedInputFingerprint: string;
  approvedInputAmount: string;
  approvedFee: string;
  approvedReturnAmount: string;
}

export function planDurableBearerSpendReclaimIntent(
  value: DurableBearerSpendDeliveryRecord,
  approval?: {
    requestFingerprint: string;
    approvedFee: string;
    approvedReturnAmount: string;
  },
): DurableBearerSpendReclaimIntent {
  const record = decodeDurableBearerSpendDeliveryRecord(value);
  if (
    record.state.kind !== "pending" ||
    (record.reclaim.kind !== "none" && record.reclaim.kind !== "prepared")
  ) {
    throw new Error("durable bearer delivery is not cancellable");
  }
  const parentFingerprint = deriveDurableCustodyArtifactFingerprint({
    domain: "durable-bearer-reclaim-intent/v1",
    deliveryId: record.deliveryId,
    walletId: record.walletId,
    parentOperationId: record.parentOperationId,
    mintUrl: record.mintUrl,
    unit: record.unit,
    tokenDigest: record.tokenDigest,
    tokenByteLength: record.tokenByteLength,
    originalProofs: record.proofEntries.map((entry) =>
      entry.kind === "active"
        ? {
            kind: "active",
            Y: expectedProofYs([entry.proof])[0],
            keysetId: entry.proof.id,
            amount: Amount.from(entry.proof.amount).toBigInt().toString(),
          }
        : entry,
    ),
  });
  const requestFingerprint =
    approval === undefined
      ? parentFingerprint
      : requireFingerprint(
          approval.requestFingerprint,
          "reclaim approval fingerprint",
        );
  const selectedProofs = selectDurableBearerSpendUnspentProofs(record);
  const approvedInputFingerprint = reclaimInputFingerprint(selectedProofs);
  const approvedInputAmount = proofAmount(selectedProofs);
  const approvedFee =
    approval === undefined
      ? "0"
      : requireNonnegativeAmount(approval.approvedFee, "reclaim approved fee");
  const approvedReturnAmount =
    approval === undefined
      ? approvedInputAmount
      : requirePositiveAmount(
          approval.approvedReturnAmount,
          "reclaim approved return amount",
        );
  if (
    BigInt(approvedFee) + BigInt(approvedReturnAmount) !==
    BigInt(approvedInputAmount)
  ) {
    throw new Error("durable bearer reclaim approved amounts are invalid");
  }
  return {
    operationId: `bearer-reclaim:${deriveDurableCustodyArtifactFingerprint({
      domain: "durable-bearer-reclaim-operation/v1",
      parentFingerprint,
      requestFingerprint,
      approvedInputFingerprint,
      approvedInputAmount,
      approvedFee,
      approvedReturnAmount,
    })}`,
    requestFingerprint,
    approvedInputFingerprint,
    approvedInputAmount,
    approvedFee,
    approvedReturnAmount,
  };
}

export function replaceDurableBearerSpendReclaimIntent(
  value: DurableBearerSpendDeliveryRecord,
  intent: DurableBearerSpendReclaimIntent,
): DurableBearerSpendDeliveryRecord {
  const record = decodeDurableBearerSpendDeliveryRecord(value);
  if (record.state.kind !== "pending" || record.reclaim.kind !== "prepared") {
    throw new Error("durable bearer reclaim intent is not replaceable");
  }
  const operationId = requireIdentifier(
    intent.operationId,
    "reclaim operation id",
  );
  const requestFingerprint = requireFingerprint(
    intent.requestFingerprint,
    "reclaim request fingerprint",
  );
  const approvedInputFingerprint = requireFingerprint(
    intent.approvedInputFingerprint,
    "reclaim approved input fingerprint",
  );
  const approvedInputAmount = requirePositiveAmount(
    intent.approvedInputAmount,
    "reclaim approved input amount",
  );
  const approvedFee = requireNonnegativeAmount(
    intent.approvedFee,
    "reclaim approved fee",
  );
  const approvedReturnAmount = requirePositiveAmount(
    intent.approvedReturnAmount,
    "reclaim approved return amount",
  );
  requireApprovedAmountEquation({
    approvedInputAmount,
    approvedFee,
    approvedReturnAmount,
  });
  return decodeDurableBearerSpendDeliveryRecord({
    ...record,
    reclaim: {
      kind: "prepared",
      operationId,
      parentDeliveryId: record.deliveryId,
      requestFingerprint,
      approvedInputFingerprint,
      approvedInputAmount,
      approvedFee,
      approvedReturnAmount,
    },
    state: {
      ...record.state,
      classification: "recheck-required",
    },
  });
}

export function completeDurableBearerSpendReclaim(input: {
  record: DurableBearerSpendDeliveryRecord;
  capability: DurableBearerSpendReclaimCompletionCapability;
  completedAtMs: number;
}): DurableBearerSpendDeliveryRecord {
  const record = decodeDurableBearerSpendDeliveryRecord(input.record);
  const authority = requireReclaimCompletionCapability(
    input.capability,
    record,
  );
  const {
    operationId,
    requestFingerprint,
    approvedInputFingerprint,
    approvedInputAmount,
    approvedFee,
    approvedReturnAmount,
  } = authority;
  const completedAtMs = requireTimestamp(
    input.completedAtMs,
    "reclaim completion time",
  );
  if (
    record.reclaim.kind === "completed" &&
    record.reclaim.operationId === operationId &&
    record.reclaim.requestFingerprint === requestFingerprint &&
    record.reclaim.approvedInputFingerprint === approvedInputFingerprint &&
    record.reclaim.approvedInputAmount === approvedInputAmount &&
    record.reclaim.approvedFee === approvedFee &&
    record.reclaim.approvedReturnAmount === approvedReturnAmount &&
    record.state.kind === "consumed" &&
    record.state.actor === "sender-reclaim"
  ) {
    return record;
  }
  if (
    record.reclaim.kind !== "submitted" ||
    record.reclaim.operationId !== operationId ||
    record.reclaim.requestFingerprint !== requestFingerprint ||
    record.reclaim.approvedInputFingerprint !== approvedInputFingerprint ||
    record.reclaim.approvedInputAmount !== approvedInputAmount ||
    record.reclaim.approvedFee !== approvedFee ||
    record.reclaim.approvedReturnAmount !== approvedReturnAmount ||
    completedAtMs < record.createdAtMs ||
    (record.state.kind === "consumed" && record.state.actor !== "unknown")
  ) {
    throw new Error("durable bearer reclaim completion is invalid");
  }
  const proofStates: "SPENT"[] = record.proofEntries.map(
    () => CheckStateEnum.SPENT,
  );
  return decodeDurableBearerSpendDeliveryRecord({
    ...record,
    proofEntries: compactSpentProofEntries(record.proofEntries, proofStates),
    reclaim: {
      kind: "completed",
      operationId,
      parentDeliveryId: record.deliveryId,
      requestFingerprint,
      approvedInputFingerprint,
      approvedInputAmount,
      approvedFee,
      approvedReturnAmount,
    },
    state: {
      kind: "consumed",
      actor: "sender-reclaim",
      proofStates,
      completedAtMs,
    },
  });
}

export function issueDurableBearerSpendReclaimCompletionCapability(input: {
  record: DurableBearerSpendDeliveryRecord;
  intent: DurableBearerSpendReclaimIntent;
  walletOperation: unknown;
  resultGroups: unknown;
}): DurableBearerSpendReclaimCompletionCapability {
  const record = decodeDurableBearerSpendDeliveryRecord(input.record);
  const intent = requireReclaimIntent(input.intent);
  if (
    (record.reclaim.kind !== "submitted" &&
      record.reclaim.kind !== "completed") ||
    record.reclaim.operationId !== intent.operationId ||
    record.reclaim.requestFingerprint !== intent.requestFingerprint ||
    record.reclaim.approvedInputFingerprint !==
      intent.approvedInputFingerprint ||
    record.reclaim.approvedInputAmount !== intent.approvedInputAmount ||
    record.reclaim.approvedFee !== intent.approvedFee ||
    record.reclaim.approvedReturnAmount !== intent.approvedReturnAmount
  ) {
    throw new Error("durable bearer reclaim completion authority is invalid");
  }
  const operation = requireDurableBearerSpendReclaimChildPlan({
    record,
    intent,
    walletOperation: input.walletOperation,
  });
  const exactResult = requireExactDurableWalletReceiveResult({
    walletOperation: operation,
    resultGroups: input.resultGroups,
  });
  requireDurableWalletReceiveExactResultCapability(exactResult);
  if (exactResult.amount !== intent.approvedReturnAmount) {
    throw new Error("durable bearer reclaim child result amount is invalid");
  }
  const capability = Object.freeze({
    operationId: intent.operationId,
    requestFingerprint: intent.requestFingerprint,
    approvedInputFingerprint: intent.approvedInputFingerprint,
    approvedInputAmount: intent.approvedInputAmount,
    approvedFee: intent.approvedFee,
    approvedReturnAmount: intent.approvedReturnAmount,
    childResultFingerprint: exactResult.resultFingerprint,
  });
  reclaimCompletionAuthorities.set(capability, {
    recordFingerprint: reclaimAuthorityFingerprint(record),
    ...capability,
  });
  return capability;
}

export function requireDurableBearerSpendReclaimChildPlan(input: {
  record: DurableBearerSpendDeliveryRecord;
  intent: DurableBearerSpendReclaimIntent;
  walletOperation: unknown;
}) {
  const record = decodeDurableBearerSpendDeliveryRecord(input.record);
  const intent = requireReclaimIntent(input.intent);
  const operation = decodeDurableWalletOperation(input.walletOperation);
  if (
    operation.kind !== "wallet-receive" ||
    operation.operationId !== intent.operationId ||
    operation.mintUrl !== record.mintUrl ||
    operation.unit !== record.unit ||
    operation.preview.amount !== intent.approvedReturnAmount ||
    operation.preview.fees !== intent.approvedFee ||
    proofAmountFromDurable(operation.preview.inputs) !==
      intent.approvedInputAmount ||
    reclaimInputFingerprintFromDurable(operation.preview.inputs) !==
      intent.approvedInputFingerprint ||
    !isOrderedParentProofSubset(record, operation.preview.inputs) ||
    outputAmount(operation.preview.keepOutputs) !== intent.approvedReturnAmount
  ) {
    throw new Error("durable bearer reclaim child plan is invalid");
  }
  return operation;
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
  exactPayload: DurableWalletSendExactPayload;
  authorization: DurableCustodyOwnerAuthorization;
}): DurableBearerSpendCustodyHandoffPlan {
  const record = decodeDurableBearerSpendDeliveryRecord(input.bearerRecord);
  if (record.state.kind !== "pending") {
    throw new Error("durable bearer delivery cannot be handed off");
  }
  const exactPayload = requireDurableWalletSendExactPayloadCapability(
    input.exactPayload,
  );
  if (
    exactPayload.policyKind !== "user-export" ||
    exactPayload.walletOperationId !==
      input.custodyState.operation.operation.retainedOperationKey ||
    exactPayload.deliveryIntentFingerprint !==
      input.custodyState.operation.operation.privateMaterial
        .publicFingerprint ||
    exactPayload.resultFingerprint !==
      input.custodyState.operation.operation.result.resultFingerprint ||
    exactPayload.payloadHandle !== record.payloadHandle ||
    exactPayload.tokenDigest !== record.tokenDigest ||
    exactPayload.encodedTokenBytes !== record.tokenByteLength ||
    exactPayload.mintUrl !== record.mintUrl ||
    exactPayload.unit !== record.unit
  ) {
    throw new Error("durable bearer custody policy is invalid");
  }
  const capability: DurableBearerCustodyHandoffCapability =
    issueDurableBearerCustodyHandoffCapability({
      policyKind: "user-export",
      deliveryIntentFingerprint: exactPayload.deliveryIntentFingerprint,
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

/** Rebuilds and checks one exact handoff capability after structured cloning. */
export function rehydrateDurableBearerSpendCustodyHandoffPlan(input: {
  readonly bearerRecord: unknown;
  readonly previousCustodyState: DurableCustodyState;
  readonly exactPayload: DurableWalletSendExactPayload;
  readonly persistedPlan: unknown;
}): DurableBearerSpendCustodyHandoffPlan {
  const persisted = decodePersistedHandoffPlan(input.persistedPlan);
  const previous = decodeCustodyState(input.previousCustodyState);
  const owner = previous.scopeState.owner;
  if (owner === null) {
    throw new Error("durable bearer custody handoff owner is missing");
  }
  const rebuilt = planDurableBearerSpendCustodyHandoff({
    bearerRecord: decodeDurableBearerSpendDeliveryRecord(input.bearerRecord),
    custodyState: previous,
    exactPayload: input.exactPayload,
    authorization: {
      incarnationId: owner.incarnationId,
      fencingEpoch: previous.scopeState.fencingEpoch,
      observedAtMs:
        persisted.custodyState.scopeState.effectiveClock.highWaterMarkMs,
    },
  });
  if (handoffPlanFingerprint(rebuilt) !== handoffPlanFingerprint(persisted)) {
    throw new Error("durable bearer custody handoff plan conflicts");
  }
  return rebuilt;
}

function decodePersistedHandoffPlan(
  value: unknown,
): DurableBearerSpendCustodyHandoffPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("durable bearer custody handoff plan is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !("bearerRecord" in record) ||
    !("custodyState" in record)
  ) {
    throw new Error("durable bearer custody handoff plan is invalid");
  }
  return {
    bearerRecord: decodeDurableBearerSpendDeliveryRecord(record.bearerRecord),
    custodyState: decodeCustodyState(record.custodyState),
  };
}

function decodeCustodyState(value: unknown): DurableCustodyState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("durable bearer custody state is invalid");
  }
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).length !== 2 ||
    !("operation" in state) ||
    !("scopeState" in state)
  ) {
    throw new Error("durable bearer custody state is invalid");
  }
  const operation = decodeDurableCustodyRecord(state.operation);
  return {
    operation,
    scopeState: decodeDurableCustodyScopeState(
      state.scopeState,
      operation.scope,
    ),
  };
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
  requireApprovedAmountEquation(next);
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
  const selectedProofs = selectDurableBearerSpendUnspentProofs(record);
  if (
    reclaimInputFingerprint(selectedProofs) !== next.approvedInputFingerprint ||
    proofAmount(selectedProofs) !== next.approvedInputAmount
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
    left.requestFingerprint === right.requestFingerprint &&
    left.approvedInputFingerprint === right.approvedInputFingerprint &&
    left.approvedInputAmount === right.approvedInputAmount &&
    left.approvedFee === right.approvedFee &&
    left.approvedReturnAmount === right.approvedReturnAmount
  );
}

function proofAmount(proofs: readonly Proof[]): string {
  return proofs
    .reduce((sum, proof) => sum + Amount.from(proof.amount).toBigInt(), 0n)
    .toString();
}

function proofAmountFromDurable(proofs: readonly DurableWalletProof[]): string {
  return proofs
    .reduce((sum, proof) => sum + BigInt(proof.amount), 0n)
    .toString();
}

function outputAmount(
  outputs: readonly { blindedMessage: { amount: string } }[],
): string {
  return outputs
    .reduce((sum, output) => sum + BigInt(output.blindedMessage.amount), 0n)
    .toString();
}

function reclaimInputFingerprint(proofs: readonly Proof[]): string {
  return deriveDurableCustodyArtifactFingerprint({
    domain: "durable-bearer-reclaim-inputs/v1",
    inputs: proofs.map((proof) => ({
      Y: expectedProofYs([proof])[0],
      keysetId: proof.id,
      amount: Amount.from(proof.amount).toBigInt().toString(),
    })),
  });
}

function reclaimInputFingerprintFromDurable(
  proofs: readonly DurableWalletProof[],
): string {
  return deriveDurableCustodyArtifactFingerprint({
    domain: "durable-bearer-reclaim-inputs/v1",
    inputs: proofs.map((proof) => ({
      Y: expectedProofYs([{ id: proof.id, secret: proof.secret }])[0],
      keysetId: proof.id,
      amount: proof.amount,
    })),
  });
}

function isOrderedParentProofSubset(
  record: DurableBearerSpendDeliveryRecord,
  inputs: readonly DurableWalletProof[],
): boolean {
  let parentIndex = 0;
  for (const input of inputs) {
    let matched = false;
    while (parentIndex < record.proofEntries.length) {
      const entry = record.proofEntries[parentIndex];
      parentIndex += 1;
      if (entry && durableInputMatchesParentEntry(input, entry)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

function durableInputMatchesParentEntry(
  input: DurableWalletProof,
  entry: DurableBearerSpendProofEntry,
): boolean {
  return (
    expectedProofYs([{ id: input.id, secret: input.secret }])[0] ===
      (entry.kind === "active" ? expectedProofYs([entry.proof])[0] : entry.Y) &&
    input.id === (entry.kind === "active" ? entry.proof.id : entry.keysetId) &&
    input.amount ===
      (entry.kind === "active"
        ? Amount.from(entry.proof.amount).toBigInt().toString()
        : entry.amount)
  );
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

function requireApprovedAmountEquation(input: {
  approvedInputAmount: string;
  approvedFee: string;
  approvedReturnAmount: string;
}): void {
  if (
    BigInt(input.approvedFee) + BigInt(input.approvedReturnAmount) !==
    BigInt(input.approvedInputAmount)
  ) {
    throw new Error("durable bearer reclaim approved amounts are invalid");
  }
}

function requireReclaimIntent(
  value: DurableBearerSpendReclaimIntent,
): DurableBearerSpendReclaimIntent {
  const intent = {
    operationId: requireIdentifier(value.operationId, "reclaim operation id"),
    requestFingerprint: requireFingerprint(
      value.requestFingerprint,
      "reclaim request fingerprint",
    ),
    approvedInputFingerprint: requireFingerprint(
      value.approvedInputFingerprint,
      "reclaim approved input fingerprint",
    ),
    approvedInputAmount: requirePositiveAmount(
      value.approvedInputAmount,
      "reclaim approved input amount",
    ),
    approvedFee: requireNonnegativeAmount(
      value.approvedFee,
      "reclaim approved fee",
    ),
    approvedReturnAmount: requirePositiveAmount(
      value.approvedReturnAmount,
      "reclaim approved return amount",
    ),
  };
  requireApprovedAmountEquation(intent);
  return intent;
}

function requireReclaimCompletionCapability(
  capability: DurableBearerSpendReclaimCompletionCapability,
  record: DurableBearerSpendDeliveryRecord,
): DurableBearerSpendReclaimCompletionAuthority {
  const authority = reclaimCompletionAuthorities.get(capability);
  if (
    !authority ||
    authority.recordFingerprint !== reclaimAuthorityFingerprint(record) ||
    authority.operationId !== capability.operationId ||
    authority.requestFingerprint !== capability.requestFingerprint ||
    authority.approvedInputFingerprint !==
      capability.approvedInputFingerprint ||
    authority.approvedInputAmount !== capability.approvedInputAmount ||
    authority.approvedFee !== capability.approvedFee ||
    authority.approvedReturnAmount !== capability.approvedReturnAmount ||
    authority.childResultFingerprint !== capability.childResultFingerprint
  ) {
    throw new Error("durable bearer reclaim completion capability is invalid");
  }
  return authority;
}

function reclaimAuthorityFingerprint(
  record: DurableBearerSpendDeliveryRecord,
): string {
  return deriveDurableCustodyArtifactFingerprint({
    domain: "durable-bearer-reclaim-parent/v1",
    deliveryId: record.deliveryId,
    walletId: record.walletId,
    parentOperationId: record.parentOperationId,
    payloadHandle: record.payloadHandle,
    mintUrl: record.mintUrl,
    unit: record.unit,
    tokenDigest: record.tokenDigest,
    tokenByteLength: record.tokenByteLength,
    origin: record.origin,
    createdAtMs: record.createdAtMs,
  });
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
