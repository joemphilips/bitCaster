import type {
  DurableCustodyArtifactRow,
  DurableCustodyRecord,
  DurableCustodyScopeState,
} from "@bitcaster/client-sdk/durableCustody";
import type { DurableCustodyProofMaterialRecord } from "@bitcaster/client-sdk/durableCustodyProofMaterial";

export type BrowserCustodyProofUnit = "sat" | "msat";
export type BrowserCustodyProofSelectability = "selectable" | "locked" | "spent";

export interface BrowserCustodyScopeRow {
  scopeId: string;
  state: DurableCustodyScopeState;
}

export interface BrowserCustodyOperationRow {
  scopeId: string;
  operationId: string;
  revision: number;
  operationState: DurableCustodyRecord["operation"]["state"];
  nextAttemptAtMs: number | null;
  estimatedBytes: number;
  record: DurableCustodyRecord;
}

export interface BrowserCustodyArtifactRow extends DurableCustodyArtifactRow {
  scopeId: string;
  operationId: string;
  artifactId: string;
}

export interface BrowserCustodyProofRow extends DurableCustodyProofMaterialRecord {
  scopeId: string;
  normalizedMint: string;
  unit: BrowserCustodyProofUnit;
  assetKind: "regular" | "conditional";
  conditionId: string | null;
  outcomeCollection: string | null;
  baseAsset: "sat";
  revision: number;
  selectability: BrowserCustodyProofSelectability;
  reservationOperationId: string | null;
  receivedAtMs: number;
}

export interface BrowserCustodyReservationRow {
  scopeId: string;
  proofId: string;
  operationId: string;
  reservationId: string;
  inputPosition: number;
}

export interface BrowserCustodyActiveWorkRow {
  scopeId: string;
  operationId: string;
  nextAttemptAtMs: number;
  estimatedBytes: number;
}
