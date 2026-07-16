import type { Proof } from "@cashu/cashu-ts";

export type DurableBearerSpendProofState = "UNSPENT" | "PENDING" | "SPENT";
export type DurableBearerSpendClassification =
  | "unverified"
  | "all-unspent"
  | "pending"
  | "mixed"
  | "recheck-required"
  | "blocked"
  | "indeterminate";

export type DurableBearerSpendCompletionActor =
  | "recipient"
  | "sender-reclaim"
  | "unknown";

export type DurableBearerSpendReclaimLineage =
  | { kind: "none" }
  | {
      kind: "prepared" | "submitted" | "completed";
      operationId: string;
      parentDeliveryId: string;
      requestFingerprint: string;
    };

export type DurableBearerSpendProofEntry =
  | { kind: "active"; proof: Proof }
  | {
      kind: "spent";
      Y: string;
      keysetId: string;
      amount: string;
    };

export interface DurableBearerSpendPendingState {
  kind: "pending";
  classification: DurableBearerSpendClassification;
  proofStates: readonly DurableBearerSpendProofState[] | null;
  attemptCount: number;
  lastObservedAtMs: number | null;
  nextAttemptAtMs: number;
}

export interface DurableBearerSpendConsumedState {
  kind: "consumed";
  actor: DurableBearerSpendCompletionActor;
  proofStates: readonly "SPENT"[];
  completedAtMs: number;
}

export interface DurableBearerSpendDeliveryRecord {
  schemaVersion: 1;
  deliveryId: string;
  walletId: string;
  parentOperationId: string;
  payloadHandle: string;
  mintUrl: string;
  unit: string;
  tokenDigest: string;
  tokenByteLength: number;
  proofEntries: readonly DurableBearerSpendProofEntry[];
  origin: "local" | "restored";
  reclaim: DurableBearerSpendReclaimLineage;
  createdAtMs: number;
  state: DurableBearerSpendPendingState | DurableBearerSpendConsumedState;
}

export type DurableBearerSpendDeliveryEvidence =
  | { kind: "proof-states"; observedAtMs: number; states: unknown }
  | { kind: "indeterminate"; observedAtMs: number };

export type DurableBearerSpendReclaimTransition = {
  kind: "prepared" | "submitted";
  operationId: string;
  requestFingerprint: string;
};

export interface DurableBearerSpendProofStateChecker {
  checkProofsStates(
    proofs: Array<Pick<Proof, "id" | "secret">>,
  ): Promise<unknown>;
}
