import Dexie, { type Table } from "dexie";
import { Amount, type Proof } from "@cashu/cashu-ts";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  COLLATERAL_UNIT_REGISTRY,
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
  type CashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import type { CtfProofOperationCompletion } from "@bitcaster/client-sdk/ctfSplit";
import {
  readAuthenticatedCtfRedeemTerminalEvidence,
  type AuthenticatedCtfRedeemTerminalEvidence,
} from "@bitcaster/client-sdk/ctfRedeem";
import type { CtfRangeOrderPreparationRecord } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import { normalizeUrl } from "../lib/url";
import type {
  BrowserCustodyActiveWorkRow,
  BrowserCustodyArtifactRow,
  BrowserCustodyOperationRow,
  BrowserCustodyProofRow,
  BrowserCustodyReservationRow,
  BrowserCustodyScopeRow,
} from "./durable-custody-types";
import type { BrowserProofBackupAuthorityRow } from "./browser-proof-backup-authority";
import type {
  PersistedEncryptedWalletBackupBuildCursor,
  PersistedEncryptedWalletBackupPackBinding,
  PersistedEncryptedWalletBackupPackControl,
  PersistedEncryptedWalletBackupPreparedBuildRecord,
  PersistedEncryptedWalletBackupStagedObject,
} from "@bitcaster/client-sdk/encryptedWalletBackupPackPersistence";
import type {
  EncryptedWalletBackupActiveUploadAttemptRecord,
  EncryptedWalletBackupUploadBatchRecord,
} from "@bitcaster/client-sdk/encryptedWalletBackupSync";
import type { EncryptedWalletBackupSyncAttemptRecord } from "@bitcaster/client-sdk/encryptedWalletBackup";
import type { EncryptedWalletBackupAccountOperationResultRecord } from "@bitcaster/client-sdk/encryptedWalletBackupEnrollment";
import type { EncryptedWalletBackupSnapshotCleanupJob } from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotCleanup";
import type { EncryptedWalletBackupRestoreProofRecord } from "@bitcaster/client-sdk/encryptedWalletBackup";
import type { DurableWalletStorageClassification } from "@bitcaster/client-sdk/recoverableWalletStorage";

/** Canonical encrypted wallet-backup control row. The SDK owns its CBOR codec. */
export interface EncryptedWalletBackupDexieControlRow {
  scopeKey: string;
  realm: string;
  vaultId: string;
  snapshotId: string;
  snapshotRevision: number;
  generation: number;
  canonical: Uint8Array;
}

/** Canonical encrypted wallet-backup snapshot pin. The SDK owns its CBOR codec. */
export interface EncryptedWalletBackupDexieSnapshotPinRow {
  realm: string;
  vaultId: string;
  snapshotId: string;
  snapshotRevision: number;
  generation: number;
  recordKindCode: 0;
  recordId: string;
  commitment: string;
  sourceRevision: number;
  sourceBodyReference: string;
  canonical: Uint8Array;
}

/** Immutable prepared source. It is re-read before a snapshot pin is written. */
export interface EncryptedWalletBackupDexiePreparedSourceRow {
  realm: string;
  vaultId: string;
  recordKindCode: 0;
  recordId: string;
  commitment: string;
  bodyReference: string;
  revision: number;
  snapshotId: string;
  snapshotRevision: number;
  generation: number;
  canonicalDescriptor: Uint8Array;
}

/** Prepared build row with an adapter-private exact canonical size. */
export interface EncryptedWalletBackupDexiePreparedRecordRow extends PersistedEncryptedWalletBackupPreparedBuildRecord {
  preparedRecordSerializedBytes: number;
}

/** Pack binding with the exact canonical size of its prepared build row. */
export interface EncryptedWalletBackupDexiePackBindingRow extends PersistedEncryptedWalletBackupPackBinding {
  preparedRecordSerializedBytes: number;
}

/** Canonical encrypted wallet-backup manifest page. The SDK owns its CBOR codec. */
export interface EncryptedWalletBackupDexieManifestPageRow {
  realm: string;
  vaultId: string;
  snapshotId: string;
  snapshotRevision: number;
  pageIndex: number;
  generation: number;
  objectId: string;
  digest: string;
  canonical: Uint8Array;
}

/** Opaque SDK-owned upload aggregate. The indexed fields support bounded reads. */
export interface EncryptedWalletBackupDexieUploadAttemptRow {
  attemptId: string;
  realm: string;
  vaultId: string;
  record: EncryptedWalletBackupActiveUploadAttemptRecord;
}

/** Opaque SDK-owned upload cursor. */
export interface EncryptedWalletBackupDexieUploadCursorRow {
  attemptId: string;
  canonicalCursor: Uint8Array;
}

/** Opaque SDK-owned upload batch. The attempt ID is its bounded partition key. */
export interface EncryptedWalletBackupDexieUploadBatchRow {
  batchId: string;
  attemptId: string;
  authorityDigest: string;
  record: Omit<
    EncryptedWalletBackupUploadBatchRecord,
    "canonicalTargetHead" | "canonicalTargetReferenceSet" | "canonicalInheritedReferenceSet"
  >;
}

/** Opaque SDK-owned CAS retry record. uploadAttemptId is unique by schema. */
export interface EncryptedWalletBackupDexieUploadCasAttemptRow {
  attemptId: string;
  uploadAttemptId: string;
  record: EncryptedWalletBackupSyncAttemptRecord;
}

/** The latest authenticated enrollment lifecycle receipt for one vault. */
export interface EncryptedWalletBackupDexieEnrollmentResultRow {
  realm: string;
  vaultId: string;
  record: EncryptedWalletBackupAccountOperationResultRecord;
}

/** One durable retry schedule for one wallet scope and encrypted-backup vault. */
export interface EncryptedWalletBackupDexieRetrySchedulerRow {
  scopeId: string;
  realm: string;
  vaultId: string;
  attemptId: string;
  retryStreak: number;
  retryNotBeforeUnixMilliseconds: number;
}

/** One resumable metadata cleanup job for one encrypted-backup vault. */
export interface EncryptedWalletBackupDexieSnapshotCleanupRow {
  realm: string;
  vaultId: string;
  job: EncryptedWalletBackupSnapshotCleanupJob;
}

/** Exact SDK-owned restored-proof authority for one browser wallet scope. */
export interface EncryptedWalletBackupDexieRestoreProofRow {
  scopeId: string;
  proofId: string;
  storageClassification: DurableWalletStorageClassification;
  proof: EncryptedWalletBackupRestoreProofRecord | null;
}

interface StoredProofMetadata {
  mintUrl: string;
  /** Local-only reservation owner. Reserved proofs are hidden from spendable balances. */
  reservedBy?: string;
  /** Exact terminal CTF redeem operation. Terminal proofs are never spendable. */
  terminalOperationId?: string;
  /** NUT-CTF condition id when this proof is bound to a conditional keyset. */
  conditionId?: string;
  /** NUT-CTF outcome collection label, e.g. "YES" or "Alice|Bob". */
  outcomeCollection?: string;
  /** Convenience mirror for the app's per-outcome market id. */
  marketId?: string;
  /** Base asset for this proof's amount sub-units. Missing legacy rows are sats. */
  baseAsset?: string;
  /** Exact Cashu keyset unit. Missing legacy rows are excluded from spend operations. */
  unit?: CashuProofUnit;
  /** Timestamp (ms since epoch) when this proof was added to the wallet */
  receivedAt?: number;
}

/** Cashu-ready proof used by wallet and UI code. This type is never an IndexedDB row. */
export interface StoredProof extends Proof, StoredProofMetadata {}

/** Exact IndexedDB row. Structured clone stores the amount as a safe integer. */
export type StoredProofRow = Omit<Proof, "amount"> & StoredProofMetadata & { amount: number };

export interface StoredOutputData {
  blindedMessage: {
    amount: number;
    id: string;
    B_: string;
  };
  blindingFactor: string;
  secret: string;
}

export type ProofOperationKind =
  | "swap-lock"
  | "swap-claim"
  | "conditional-keyset-swap"
  | "swap-refund"
  | "ctf-split"
  | "ctf-merge"
  | "ctf-consolidation"
  | "proof-consolidation"
  | "ctf-redeem"
  | "ctf-condition-registration"
  | "wallet-send"
  | "regular-split"
  | "proof-split"
  | "wallet-mint"
  | "token-receive";
export type ProofOperationState = "prepared" | "completed" | "Failed";

export interface ProofOperationRecord {
  operationId: string;
  kind: ProofOperationKind;
  state: ProofOperationState;
  mintUrl: string;
  inputs: Proof[];
  outputs: Record<string, StoredOutputData[]>;
  metadata: Record<string, unknown> & { unit?: CashuProofUnit };
  resultProofs?: Record<string, Proof[]>;
  resultProofsDigest?: string;
  lastError?: string | null;
  /** Structured mint error code for failed operations, when available. */
  failureCode?: number | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface PrepareProofOperationInput {
  operationId: string;
  kind: ProofOperationKind;
  mintUrl: string;
  inputs: Proof[];
  outputs: Record<string, StoredOutputData[]>;
  metadata?: Record<string, unknown>;
}

export function isCtfProof(proof: StoredProof | StoredProofRow | Proof): boolean {
  const candidate = proof as Proof & {
    conditionId?: unknown;
    condition_id?: unknown;
    outcomeCollection?: unknown;
    outcome_collection?: unknown;
  };
  return (
    typeof candidate.conditionId === "string" ||
    typeof candidate.condition_id === "string" ||
    typeof candidate.outcomeCollection === "string" ||
    typeof candidate.outcome_collection === "string"
  );
}

export interface CtfRangePreparationSourceLinkRow {
  scopeId: string;
  rangeOperationId: string;
  sourceOperationId: string;
  reservationId: string;
}

export interface CtfRangePreparationConsolidationLinkRow {
  scopeId: string;
  rangeOperationId: string;
  round: number;
  operationId: string;
  reservationId: string;
}

export interface BrowserCtfRangeMessageRow {
  scopeId: string;
  operationId: string;
  revision: number;
  code: string;
  kind: "order" | "funds";
  status: "active" | "acknowledged";
  observedAtMs: number;
  acknowledgedAtMs: number | null;
}

export class BitcasterDB extends Dexie {
  proofs!: Table<StoredProofRow>;
  proofOperations!: Table<ProofOperationRecord>;
  ctfRangePreparations!: Table<CtfRangeOrderPreparationRecord, [string, string]>;
  ctfRangePreparationSources!: Table<CtfRangePreparationSourceLinkRow, [string, string]>;
  ctfRangePreparationConsolidations!: Table<
    CtfRangePreparationConsolidationLinkRow,
    [string, string, number]
  >;
  ctfRangeMessages!: Table<BrowserCtfRangeMessageRow, [string, string, number, string]>;
  custodyScopes!: Table<BrowserCustodyScopeRow, string>;
  custodyOperations!: Table<BrowserCustodyOperationRow, [string, string]>;
  custodyArtifacts!: Table<BrowserCustodyArtifactRow, [string, string, string]>;
  custodyProofs!: Table<BrowserCustodyProofRow, [string, string]>;
  custodyReservations!: Table<BrowserCustodyReservationRow, [string, string]>;
  custodyActiveWork!: Table<BrowserCustodyActiveWorkRow, [string, string]>;
  custodyProofBackupAuthorities!: Table<BrowserProofBackupAuthorityRow, [string, string]>;
  custodyConditionalKeysets!: Table<
    import("./durable-custody-types").BrowserCustodyConditionalKeysetRow,
    [string, string, string, string]
  >;
  encryptedWalletBackupBuildCursors!: Table<PersistedEncryptedWalletBackupBuildCursor, string>;
  encryptedWalletBackupPackControls!: Table<
    PersistedEncryptedWalletBackupPackControl,
    [string, string]
  >;
  encryptedWalletBackupPreparedRecords!: Table<
    EncryptedWalletBackupDexiePreparedRecordRow,
    [string, string]
  >;
  encryptedWalletBackupPackBindings!: Table<
    EncryptedWalletBackupDexiePackBindingRow,
    [string, string, string]
  >;
  encryptedWalletBackupStagedObjects!: Table<
    PersistedEncryptedWalletBackupStagedObject,
    [string, string]
  >;
  encryptedWalletBackupSnapshotControls!: Table<EncryptedWalletBackupDexieControlRow, string>;
  encryptedWalletBackupPreparedSources!: Table<
    EncryptedWalletBackupDexiePreparedSourceRow,
    [string, string, number, string, number, string]
  >;
  encryptedWalletBackupSnapshotPins!: Table<
    EncryptedWalletBackupDexieSnapshotPinRow,
    [string, string, string, number, number, string]
  >;
  encryptedWalletBackupManifestPassAResults!: Table<EncryptedWalletBackupDexieControlRow, string>;
  encryptedWalletBackupManifestCursors!: Table<EncryptedWalletBackupDexieControlRow, string>;
  encryptedWalletBackupManifestPages!: Table<
    EncryptedWalletBackupDexieManifestPageRow,
    [string, string, string, number, number]
  >;
  encryptedWalletBackupUploadAttempts!: Table<EncryptedWalletBackupDexieUploadAttemptRow, string>;
  encryptedWalletBackupUploadCursors!: Table<EncryptedWalletBackupDexieUploadCursorRow, string>;
  encryptedWalletBackupUploadBatches!: Table<EncryptedWalletBackupDexieUploadBatchRow, string>;
  encryptedWalletBackupUploadCasAttempts!: Table<
    EncryptedWalletBackupDexieUploadCasAttemptRow,
    string
  >;
  encryptedWalletBackupEnrollmentResults!: Table<
    EncryptedWalletBackupDexieEnrollmentResultRow,
    [string, string]
  >;
  encryptedWalletBackupRetrySchedulers!: Table<
    EncryptedWalletBackupDexieRetrySchedulerRow,
    [string, string, string]
  >;
  encryptedWalletBackupSnapshotCleanupJobs!: Table<
    EncryptedWalletBackupDexieSnapshotCleanupRow,
    [string, string]
  >;
  encryptedWalletBackupRestoreProofs!: Table<
    EncryptedWalletBackupDexieRestoreProofRow,
    [string, string]
  >;

  constructor(databaseName = "bitcaster") {
    super(databaseName);
    this.version(1).stores({
      proofs: "secret, id, C, amount, mintUrl",
    });
    this.version(2).stores({
      proofs: "secret, id, C, amount, mintUrl, receivedAt",
    });
    this.version(3).stores({
      proofs: "secret, id, C, amount, mintUrl, receivedAt",
      proofOperations: "operationId, state, kind, mintUrl, updatedAt",
    });
    this.version(4).stores({
      proofs:
        "secret, id, C, amount, mintUrl, receivedAt, conditionId, outcomeCollection, [conditionId+outcomeCollection], [mintUrl+conditionId+outcomeCollection]",
      proofOperations: "operationId, state, kind, mintUrl, updatedAt",
    });
    this.version(5).stores({
      proofs:
        "secret, id, C, amount, mintUrl, receivedAt, conditionId, outcomeCollection, [conditionId+outcomeCollection], [mintUrl+conditionId+outcomeCollection]",
      proofOperations: "operationId, state, kind, mintUrl, updatedAt",
      ctfRangePreparations:
        "&[scopeId+rangeOperationId], scopeId, [scopeId+clientOrderId], [scopeId+updatedAtMs+rangeOperationId]",
      ctfRangePreparationSources: "&[scopeId+rangeOperationId], &[scopeId+sourceOperationId]",
      ctfRangePreparationConsolidations:
        "&[scopeId+rangeOperationId+round], &[scopeId+operationId]",
    });
    this.version(6).stores({
      proofs:
        "secret, id, C, amount, mintUrl, receivedAt, conditionId, outcomeCollection, [conditionId+outcomeCollection], [mintUrl+conditionId+outcomeCollection]",
      proofOperations: "operationId, state, kind, mintUrl, updatedAt",
      ctfRangePreparations:
        "&[scopeId+rangeOperationId], scopeId, [scopeId+clientOrderId], [scopeId+updatedAtMs+rangeOperationId]",
      ctfRangePreparationSources: "&[scopeId+rangeOperationId], &[scopeId+sourceOperationId]",
      ctfRangePreparationConsolidations:
        "&[scopeId+rangeOperationId+round], &[scopeId+operationId]",
      custodyScopes: "&scopeId",
      custodyOperations: "&[scopeId+operationId], [scopeId+operationState]",
      custodyArtifacts: "&[scopeId+operationId+artifactId], [scopeId+operationId]",
      custodyProofs:
        "&[scopeId+proofId], [scopeId+normalizedMint+unit+selectability], [scopeId+conditionId+outcomeCollection+selectability]",
      custodyReservations:
        "&[scopeId+proofId], [scopeId+operationId], &[scopeId+operationId+inputPosition]",
      custodyActiveWork: "&[scopeId+operationId], [scopeId+nextAttemptAtMs+operationId]",
    });
    this.version(7).stores({
      proofs:
        "secret, id, C, amount, mintUrl, receivedAt, conditionId, outcomeCollection, [conditionId+outcomeCollection], [mintUrl+unit+id], [mintUrl+conditionId+outcomeCollection]",
      proofOperations: "operationId, state, kind, mintUrl, updatedAt",
      ctfRangePreparations:
        "&[scopeId+rangeOperationId], scopeId, [scopeId+clientOrderId], [scopeId+lifecycleState+createdAtMs+rangeOperationId]",
      ctfRangePreparationSources: "&[scopeId+rangeOperationId], &[scopeId+sourceOperationId]",
      ctfRangePreparationConsolidations:
        "&[scopeId+rangeOperationId+round], &[scopeId+operationId]",
      ctfRangeMessages:
        "&[scopeId+operationId+revision+code], [scopeId+status+observedAtMs+operationId+revision+code]",
      custodyScopes: "&scopeId",
      custodyOperations: "&[scopeId+operationId], [scopeId+operationState]",
      custodyArtifacts: "&[scopeId+operationId+artifactId], [scopeId+operationId]",
      custodyProofs:
        "&[scopeId+proofId], [scopeId+normalizedMint+unit+selectability], [scopeId+conditionId+outcomeCollection+selectability]",
      custodyReservations:
        "&[scopeId+proofId], [scopeId+operationId], &[scopeId+operationId+inputPosition]",
      custodyActiveWork: "&[scopeId+operationId], [scopeId+nextAttemptAtMs+operationId]",
    });
    this.version(8)
      .stores({
        custodyProofBackupAuthorities:
          "&[scopeId+proofId], [scopeId+backupState+proofId], [scopeId+proofState+proofId], &backupRecordId",
      })
      .upgrade(async (transaction) => {
        await Promise.all(
          [
            "proofs",
            "proofOperations",
            "ctfRangePreparations",
            "ctfRangePreparationSources",
            "ctfRangePreparationConsolidations",
            "ctfRangeMessages",
            "custodyScopes",
            "custodyOperations",
            "custodyArtifacts",
            "custodyProofs",
            "custodyReservations",
            "custodyActiveWork",
            "custodyProofBackupAuthorities",
          ].map((tableName) => transaction.table(tableName).clear()),
        );
      });
    this.version(9).stores({
      encryptedWalletBackupBuildCursors: "&buildId",
      encryptedWalletBackupPackControls: "&[buildId+packId]",
      encryptedWalletBackupPreparedRecords: "&[buildId+recordId]",
      encryptedWalletBackupPackBindings: "&[buildId+packId+recordId], &[buildId+packId+ordinal]",
      encryptedWalletBackupStagedObjects: "&[buildId+packId]",
    });
    this.version(10).stores({
      encryptedWalletBackupPreparedRecords: "&[buildId+recordId], recordId",
      encryptedWalletBackupPackBindings:
        "&[buildId+packId+recordId], &[buildId+packId+ordinal], [realm+vaultId+snapshotId+snapshotRevision+recordId]",
      encryptedWalletBackupStagedObjects:
        "&[buildId+packId], [realm+vaultId+generation+objectId+digest]",
      encryptedWalletBackupSnapshotControls:
        "&scopeKey, [realm+vaultId+snapshotId+snapshotRevision]",
      encryptedWalletBackupPreparedSources:
        "&[realm+vaultId+recordKindCode+recordId+revision+bodyReference], &[realm+vaultId+recordKindCode+commitment+revision+bodyReference], [realm+vaultId+recordKindCode+recordId]",
      encryptedWalletBackupSnapshotPins:
        "&[realm+vaultId+snapshotId+snapshotRevision+recordKindCode+recordId], &[realm+vaultId+snapshotId+snapshotRevision+recordKindCode+commitment], [realm+vaultId+snapshotId+snapshotRevision+recordKindCode+recordId+commitment]",
      encryptedWalletBackupManifestPassAResults:
        "&scopeKey, [realm+vaultId+snapshotId+snapshotRevision]",
      encryptedWalletBackupManifestCursors:
        "&scopeKey, [realm+vaultId+snapshotId+snapshotRevision]",
      encryptedWalletBackupManifestPages:
        "&[realm+vaultId+snapshotId+snapshotRevision+pageIndex], &[realm+vaultId+generation+objectId+digest], [realm+vaultId+snapshotId+snapshotRevision+pageIndex+objectId]",
      encryptedWalletBackupUploadAttempts: "&attemptId, &[realm+vaultId]",
      encryptedWalletBackupUploadCursors: "&attemptId",
      encryptedWalletBackupUploadBatches: "&batchId, attemptId",
      encryptedWalletBackupUploadCasAttempts: "&attemptId, &uploadAttemptId",
    });
    this.version(11).stores({
      encryptedWalletBackupEnrollmentResults: "&[realm+vaultId]",
    });
    this.version(12).stores({
      encryptedWalletBackupRetrySchedulers: "&[scopeId+realm+vaultId]",
    });
    this.version(13)
      .stores({
        custodyProofBackupAuthorities:
          "&[scopeId+proofId], [scopeId+backupState+proofId], [scopeId+proofState+proofId], &backupRecordId, [scopeId+admissionOperationId]",
        custodyConditionalKeysets: "&[scopeId+normalizedMint+unit+keysetId]",
      })
      .upgrade(async (transaction) => {
        await Promise.all(
          [
            "proofs",
            "proofOperations",
            "ctfRangePreparations",
            "ctfRangePreparationSources",
            "ctfRangePreparationConsolidations",
            "ctfRangeMessages",
            "custodyScopes",
            "custodyOperations",
            "custodyArtifacts",
            "custodyProofs",
            "custodyReservations",
            "custodyActiveWork",
            "custodyProofBackupAuthorities",
            "custodyConditionalKeysets",
            "encryptedWalletBackupBuildCursors",
            "encryptedWalletBackupPackControls",
            "encryptedWalletBackupPreparedRecords",
            "encryptedWalletBackupPackBindings",
            "encryptedWalletBackupStagedObjects",
            "encryptedWalletBackupSnapshotControls",
            "encryptedWalletBackupPreparedSources",
            "encryptedWalletBackupSnapshotPins",
            "encryptedWalletBackupManifestPassAResults",
            "encryptedWalletBackupManifestCursors",
            "encryptedWalletBackupManifestPages",
            "encryptedWalletBackupUploadAttempts",
            "encryptedWalletBackupUploadCursors",
            "encryptedWalletBackupUploadBatches",
            "encryptedWalletBackupUploadCasAttempts",
            "encryptedWalletBackupEnrollmentResults",
            "encryptedWalletBackupRetrySchedulers",
          ].map((tableName) => transaction.table(tableName).clear()),
        );
      });
    this.version(14)
      .stores({
        custodyProofBackupAuthorities:
          "&[scopeId+proofId], [scopeId+backupState+proofId], [scopeId+proofState+proofId], &backupRecordId, [scopeId+admissionOperationId]",
      })
      .upgrade(async (transaction) => {
        await Promise.all(
          [
            "custodyScopes",
            "custodyOperations",
            "custodyArtifacts",
            "custodyProofs",
            "custodyReservations",
            "custodyActiveWork",
            "custodyProofBackupAuthorities",
            "custodyConditionalKeysets",
            "encryptedWalletBackupBuildCursors",
            "encryptedWalletBackupPackControls",
            "encryptedWalletBackupPreparedRecords",
            "encryptedWalletBackupPackBindings",
            "encryptedWalletBackupStagedObjects",
            "encryptedWalletBackupSnapshotControls",
            "encryptedWalletBackupPreparedSources",
            "encryptedWalletBackupSnapshotPins",
            "encryptedWalletBackupManifestPassAResults",
            "encryptedWalletBackupManifestCursors",
            "encryptedWalletBackupManifestPages",
            "encryptedWalletBackupUploadAttempts",
            "encryptedWalletBackupUploadCursors",
            "encryptedWalletBackupUploadBatches",
            "encryptedWalletBackupUploadCasAttempts",
            "encryptedWalletBackupEnrollmentResults",
            "encryptedWalletBackupRetrySchedulers",
          ].map((tableName) => transaction.table(tableName).clear()),
        );
      });
    this.version(15)
      .stores({
        encryptedWalletBackupSnapshotControls:
          "&scopeKey, [realm+vaultId+snapshotId+snapshotRevision], [realm+vaultId+generation+snapshotId+snapshotRevision]",
        encryptedWalletBackupSnapshotPins:
          "&[realm+vaultId+snapshotId+snapshotRevision+recordKindCode+recordId], &[realm+vaultId+snapshotId+snapshotRevision+recordKindCode+commitment], [realm+vaultId+snapshotId+snapshotRevision+recordKindCode+recordId+commitment], [realm+vaultId+generation+snapshotId+snapshotRevision+recordKindCode+recordId+commitment], [realm+vaultId+recordKindCode+recordId+sourceRevision+sourceBodyReference]",
        encryptedWalletBackupPreparedSources:
          "&[realm+vaultId+recordKindCode+recordId+revision+bodyReference], &[realm+vaultId+recordKindCode+commitment+revision+bodyReference], [realm+vaultId+recordKindCode+recordId], [realm+vaultId+generation+snapshotId+snapshotRevision+recordKindCode+recordId+revision+bodyReference]",
        encryptedWalletBackupManifestPassAResults:
          "&scopeKey, [realm+vaultId+snapshotId+snapshotRevision], [realm+vaultId+generation+snapshotId+snapshotRevision]",
        encryptedWalletBackupManifestCursors:
          "&scopeKey, [realm+vaultId+snapshotId+snapshotRevision], [realm+vaultId+generation+snapshotId+snapshotRevision]",
        encryptedWalletBackupManifestPages:
          "&[realm+vaultId+snapshotId+snapshotRevision+pageIndex], &[realm+vaultId+generation+objectId+digest], [realm+vaultId+snapshotId+snapshotRevision+pageIndex+objectId], [realm+vaultId+generation+snapshotId+snapshotRevision+pageIndex]",
        encryptedWalletBackupSnapshotCleanupJobs: "&[realm+vaultId]",
      })
      .upgrade(async (transaction) => {
        await Promise.all(
          [
            "encryptedWalletBackupBuildCursors",
            "encryptedWalletBackupPackControls",
            "encryptedWalletBackupPreparedRecords",
            "encryptedWalletBackupPackBindings",
            "encryptedWalletBackupStagedObjects",
            "encryptedWalletBackupSnapshotControls",
            "encryptedWalletBackupPreparedSources",
            "encryptedWalletBackupSnapshotPins",
            "encryptedWalletBackupManifestPassAResults",
            "encryptedWalletBackupManifestCursors",
            "encryptedWalletBackupManifestPages",
            "encryptedWalletBackupUploadAttempts",
            "encryptedWalletBackupUploadCursors",
            "encryptedWalletBackupUploadBatches",
            "encryptedWalletBackupUploadCasAttempts",
            "encryptedWalletBackupEnrollmentResults",
            "encryptedWalletBackupRetrySchedulers",
            "encryptedWalletBackupSnapshotCleanupJobs",
          ].map((tableName) => transaction.table(tableName).clear()),
        );
      });
    this.version(16)
      .stores({
        encryptedWalletBackupRestoreProofs: "&[scopeId+proofId]",
      })
      .upgrade(async (transaction) => {
        await Promise.all(
          [
            "proofs",
            "proofOperations",
            "ctfRangePreparations",
            "ctfRangePreparationSources",
            "ctfRangePreparationConsolidations",
            "ctfRangeMessages",
            "custodyScopes",
            "custodyOperations",
            "custodyArtifacts",
            "custodyProofs",
            "custodyReservations",
            "custodyActiveWork",
            "custodyProofBackupAuthorities",
            "custodyConditionalKeysets",
            "encryptedWalletBackupBuildCursors",
            "encryptedWalletBackupPackControls",
            "encryptedWalletBackupPreparedRecords",
            "encryptedWalletBackupPackBindings",
            "encryptedWalletBackupStagedObjects",
            "encryptedWalletBackupSnapshotControls",
            "encryptedWalletBackupPreparedSources",
            "encryptedWalletBackupSnapshotPins",
            "encryptedWalletBackupManifestPassAResults",
            "encryptedWalletBackupManifestCursors",
            "encryptedWalletBackupManifestPages",
            "encryptedWalletBackupUploadAttempts",
            "encryptedWalletBackupUploadCursors",
            "encryptedWalletBackupUploadBatches",
            "encryptedWalletBackupUploadCasAttempts",
            "encryptedWalletBackupEnrollmentResults",
            "encryptedWalletBackupRetrySchedulers",
            "encryptedWalletBackupSnapshotCleanupJobs",
            "encryptedWalletBackupRestoreProofs",
          ].map((tableName) => transaction.table(tableName).clear()),
        );
      });
  }
}

export let db = new BitcasterDB("bitcaster-wallet-uninitialized");

export function activateBrowserWalletDatabase(scopeId: string): void {
  const databaseName = browserWalletDatabaseName(scopeId);
  if (db.name === databaseName) return;
  db.close();
  db = new BitcasterDB(databaseName);
}

export async function getProofs(
  mintUrl?: string,
  options: { includeReserved?: boolean; includeTerminal?: boolean } = {},
): Promise<StoredProof[]> {
  if (mintUrl) {
    const rows = await db.proofs.where("mintUrl").equals(normalizeUrl(mintUrl)).toArray();
    const normalized = rows.map(normalizeStoredProof);
    return normalized.filter((proof) => isReadableStoredProof(proof, options));
  }
  const rows = await db.proofs.toArray();
  const normalized = rows.map(normalizeStoredProof);
  return normalized.filter((proof) => isReadableStoredProof(proof, options));
}

/**
 * Return regular proofs grouped by base asset for UI display only.
 * WARNING: this may combine different Cashu units (for example sat + msat)
 * and is unsafe for spend/settlement operations. Use `getUnitProofs` there.
 */
export async function getBaseProofs(
  mintUrl: string | undefined,
  options: { includeReserved?: boolean; baseAsset: string },
): Promise<StoredProof[]> {
  const proofs = await getProofs(mintUrl, {
    includeReserved: options.includeReserved,
  });
  const baseAsset = normalizeMarketBaseAsset(options.baseAsset);
  return proofs.filter((p) => !isCtfProof(p) && normalizeStoredProofBaseAsset(p) === baseAsset);
}

/**
 * Return regular proofs by exact Cashu unit for spend/settlement operations.
 * Legacy rows without an explicit `unit` are intentionally excluded fail-closed.
 */
export async function getUnitProofs(
  mintUrl: string | undefined,
  options: { includeReserved?: boolean; unit: CashuProofUnit | string },
): Promise<StoredProof[]> {
  const unit = parseCashuProofUnit(options.unit);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${options.unit}'`);
  const proofs = await getProofs(mintUrl, {
    includeReserved: options.includeReserved,
  });
  return proofs.filter((p) => !isCtfProof(p) && normalizeStoredProofUnit(p) === unit);
}

export async function getSelectableUnitProofsForKeyset(
  mintUrl: string,
  options: {
    unit: CashuProofUnit | string;
    keysetId: string;
    conditional: boolean;
    limit: number;
  },
): Promise<StoredProof[]> {
  const unit = parseCashuProofUnit(options.unit);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${options.unit}'`);
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 256) {
    throw new Error("Range proof selection limit is invalid");
  }
  const selected: StoredProof[] = [];
  await db.proofs
    .where("[mintUrl+unit+id]")
    .equals([normalizeUrl(mintUrl), unit, options.keysetId])
    .each((row) => {
      const proof = normalizeStoredProof(row);
      if (!isSpendableStoredProof(proof) || isCtfProof(proof) !== options.conditional) {
        return;
      }
      selected.push(proof);
      selected.sort(
        (left, right) =>
          amountToNumber(right.amount) - amountToNumber(left.amount) ||
          left.secret.localeCompare(right.secret),
      );
      if (selected.length > options.limit) selected.pop();
    });
  return selected;
}

export async function getProofAmountInventoryForKeyset(
  mintUrl: string,
  options: {
    unit: CashuProofUnit | string;
    keysetId: string;
    conditional: boolean;
  },
): Promise<readonly { amount: string; count: number }[]> {
  const unit = parseCashuProofUnit(options.unit);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${options.unit}'`);
  const counts = new Map<number, number>();
  await db.proofs
    .where("[mintUrl+unit+id]")
    .equals([normalizeUrl(mintUrl), unit, options.keysetId])
    .each((row) => {
      const proof = normalizeStoredProof(row);
      if (!isSpendableStoredProof(proof) || isCtfProof(proof) !== options.conditional) return;
      const amount = amountToNumber(row.amount);
      const count = (counts.get(amount) ?? 0) + 1;
      if (!Number.isSafeInteger(count)) throw new Error("Proof amount count is too large");
      counts.set(amount, count);
    });
  return [...counts]
    .sort(([left], [right]) => right - left)
    .map(([amount, count]) => ({ amount: String(amount), count }));
}

export async function getSelectableUnitProofsForAmounts(
  mintUrl: string,
  options: {
    unit: CashuProofUnit | string;
    keysetId: string;
    conditional: boolean;
    amounts: readonly string[];
  },
): Promise<StoredProof[]> {
  const unit = parseCashuProofUnit(options.unit);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${options.unit}'`);
  if (options.amounts.length < 1 || options.amounts.length > 256) {
    throw new Error("Proof amount selection limit is invalid");
  }
  const wanted = new Map<number, number>();
  for (const rawAmount of options.amounts) {
    if (!/^[1-9][0-9]*$/.test(rawAmount)) throw new Error("Proof amount selection is invalid");
    const amount = Number(rawAmount);
    if (!Number.isSafeInteger(amount)) throw new Error("Proof amount selection is invalid");
    wanted.set(amount, (wanted.get(amount) ?? 0) + 1);
  }
  const selected: StoredProof[] = [];
  await db.proofs
    .where("[mintUrl+unit+id]")
    .equals([normalizeUrl(mintUrl), unit, options.keysetId])
    .each((row) => {
      const proof = normalizeStoredProof(row);
      if (!isSpendableStoredProof(proof) || isCtfProof(proof) !== options.conditional) return;
      const amount = amountToNumber(row.amount);
      const remaining = wanted.get(amount) ?? 0;
      if (remaining < 1) return;
      selected.push(proof);
      if (remaining === 1) wanted.delete(amount);
      else wanted.set(amount, remaining - 1);
    });
  if (wanted.size > 0 || selected.length !== options.amounts.length) {
    throw new Error("Proof inventory changed after consolidation planning");
  }
  return selected.sort(
    (left, right) =>
      amountToNumber(right.amount) - amountToNumber(left.amount) ||
      left.secret.localeCompare(right.secret),
  );
}

export async function selectAndReserveUnitProofs(
  mintUrl: string | undefined,
  options: { unit: CashuProofUnit | string; minimumAmount?: number },
  reservedBy: string,
): Promise<StoredProof[]> {
  const unit = parseCashuProofUnit(options.unit);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${options.unit}'`);
  const normalizedMintUrl = mintUrl ? normalizeUrl(mintUrl) : undefined;
  const minimumAmount = options.minimumAmount ?? 0;
  let selected: StoredProof[] = [];

  await db.transaction("rw", db.proofs, async () => {
    const rows = normalizedMintUrl
      ? await db.proofs.where("mintUrl").equals(normalizedMintUrl).toArray()
      : await db.proofs.toArray();
    const spendable = rows
      .map(normalizeStoredProof)
      .filter(
        (proof) =>
          isSpendableStoredProof(proof) &&
          !isCtfProof(proof) &&
          normalizeStoredProofUnit(proof) === unit,
      );

    const picked: StoredProof[] = [];
    let pickedAmount = 0;
    for (const proof of spendable) {
      picked.push(proof);
      pickedAmount += amountToNumber(proof.amount);
      if (minimumAmount > 0 && pickedAmount >= minimumAmount) break;
    }
    if (minimumAmount > 0 && pickedAmount < minimumAmount) {
      throw new Error("Insufficient spendable proofs for requested amount");
    }

    const currentRows = await db.proofs.bulkGet(picked.map((proof) => proof.secret));
    if (currentRows.length !== picked.length) {
      throw new Error("Selected proof reservation failed: proof set changed");
    }
    const current = currentRows.map((row) => (row ? normalizeStoredProof(row) : undefined));
    if (current.some((row) => !row || !isSpendableStoredProof(row))) {
      throw new Error("Selected proof reservation failed: proof is unavailable or missing");
    }

    selected = current.filter((row): row is StoredProof => !!row);
    if (selected.length > 0) {
      await db.proofs.bulkPut(selected.map((proof) => storedProofRow({ ...proof, reservedBy })));
    }
  });

  return selected;
}

export async function getOutcomeProofs(
  mintUrl: string,
  conditionId: string,
  outcomeCollection: string,
  options: { includeReserved?: boolean; includeTerminal?: boolean; baseAsset: string },
): Promise<StoredProof[]> {
  const normalizedMintUrl = normalizeUrl(mintUrl);
  const baseAsset = normalizeMarketBaseAsset(options.baseAsset);
  const indexed = await db.proofs
    .where("[mintUrl+conditionId+outcomeCollection]")
    .equals([normalizedMintUrl, conditionId, outcomeCollection])
    .toArray();
  if (indexed.length > 0) {
    const normalized = indexed
      .map(normalizeStoredProof)
      .filter(
        (proof) =>
          normalizeStoredProofBaseAsset(proof) === baseAsset &&
          normalizeStoredProofUnit(proof) === "msat",
      );
    return normalized.filter((proof) => isReadableStoredProof(proof, options));
  }

  const proofs = await getProofs(normalizedMintUrl, options);
  return proofs.filter((p) => {
    const candidate = p as StoredProof & {
      condition_id?: string;
      outcome_collection?: string;
    };
    const proofConditionId = candidate.conditionId ?? candidate.condition_id;
    const proofOutcome = candidate.outcomeCollection ?? candidate.outcome_collection;
    return (
      proofConditionId === conditionId &&
      proofOutcome === outcomeCollection &&
      normalizeStoredProofBaseAsset(p) === baseAsset &&
      normalizeStoredProofUnit(p) === "msat"
    );
  });
}

/**
 * Return ALL of a condition's CTF proofs at a mint, regardless of how the
 * outcome was labelled when persisted.
 *
 * A composite ("A|B") position lives as proofs spanning MULTIPLE primitive
 * keysets, and settlement persists them inconsistently: sometimes under the
 * composite `outcomeCollection="A|B"` label, sometimes per-primitive
 * (`outcomeCollection="A"` / `"B"`). A label-scoped query (`getOutcomeProofs`)
 * therefore misses proofs. The redeem path must bucket by the proof's real
 * `keyset_id` (`Proof.id`), so it needs every CTF proof of the condition —
 * not a label slice. This query gathers them by `conditionId` only.
 */
export async function getConditionCtfProofs(
  mintUrl: string,
  conditionId: string,
  options: { includeReserved?: boolean; baseAsset: string },
): Promise<StoredProof[]> {
  const normalizedMintUrl = normalizeUrl(mintUrl);
  const proofs = await db.proofs
    .where("[mintUrl+conditionId+outcomeCollection]")
    .between(
      [normalizedMintUrl, conditionId, Dexie.minKey],
      [normalizedMintUrl, conditionId, Dexie.maxKey],
    )
    .toArray();
  const baseAsset = normalizeMarketBaseAsset(options.baseAsset);
  return proofs.map(normalizeStoredProof).filter((p) => {
    if (!isCtfProof(p)) return false;
    return (
      normalizeStoredProofBaseAsset(p) === baseAsset &&
      normalizeStoredProofUnit(p) === "msat" &&
      isReadableStoredProof(p, { ...options, includeTerminal: true })
    );
  });
}

// Central normalization point — proofs arrive from many receive paths
// (deposit, atomic-swap change, NIP-17 payload) where `mintUrl` may come
// from a decoded token or a raw wallet config. Normalizing on write means
// the balance query (`getProofs(activeMintUrl)`) never has to worry about
// trailing-slash / protocol-case drift.
export async function addProofs(proofs: StoredProof[], database: BitcasterDB = db): Promise<void> {
  const now = Date.now();
  const incomingRows = proofs.map((proof) =>
    storedProofRow(
      normalizeAndValidateStoredProof({
        ...proof,
        receivedAt: proof.receivedAt ?? now,
      }),
    ),
  );
  await database.transaction("rw", database.proofs, async () => {
    const currentRows = await database.proofs.bulkGet(incomingRows.map((row) => row.secret));
    const rows = incomingRows.map((row, index) =>
      preserveStoredProofTerminalBinding(row, currentRows[index]),
    );
    await database.proofs.bulkPut(rows);
  });
}

function preserveStoredProofTerminalBinding(
  incoming: StoredProofRow,
  current: StoredProofRow | undefined,
): StoredProofRow {
  const currentTerminalOperationId = current?.terminalOperationId;
  if (currentTerminalOperationId === undefined) return incoming;
  if (
    incoming.terminalOperationId !== undefined &&
    incoming.terminalOperationId !== currentTerminalOperationId
  ) {
    throw new Error("Stored proof terminal operation conflicts with existing authority");
  }
  return { ...incoming, terminalOperationId: currentTerminalOperationId };
}

export async function removeProofs(secrets: string[]): Promise<void> {
  await db.proofs.bulkDelete(secrets);
}

export async function replaceProofs(
  spentSecrets: string[],
  freshProofs: StoredProof[],
): Promise<void> {
  const uniqueSpentSecrets = [...new Set(spentSecrets)];
  const now = Date.now();
  const stamped = freshProofs.map((p) =>
    normalizeAndValidateStoredProof({
      ...p,
      receivedAt: p.receivedAt ?? now,
    }),
  );
  await db.transaction("rw", db.proofs, async () => {
    if (uniqueSpentSecrets.length > 0) {
      await db.proofs.bulkDelete(uniqueSpentSecrets);
    }
    if (stamped.length > 0) {
      await db.proofs.bulkPut(stamped.map(storedProofRow));
    }
  });
}

export async function reserveProofs(secrets: string[], reservedBy: string): Promise<void> {
  const secretSet = new Set(secrets);
  await db.transaction("rw", db.proofs, async () => {
    const rows = await db.proofs.bulkGet(secrets);
    if (rows.some((row) => row && normalizeStoredProof(row).terminalOperationId !== undefined)) {
      throw new Error("Terminal proof cannot be reserved");
    }
    await db.proofs.bulkPut(
      rows
        .filter((row): row is StoredProofRow => !!row && secretSet.has(row.secret))
        .map((row) => ({ ...row, reservedBy })),
    );
  });
}

export async function releaseProofReservation(reservedBy: string): Promise<void> {
  const rows = await db.proofs.filter((proof) => proof.reservedBy === reservedBy).toArray();
  if (rows.length === 0) return;
  await db.proofs.bulkPut(rows.map(({ reservedBy: _reservedBy, ...row }) => row));
}

export async function releaseProofReservationsBySecret(secrets: string[]): Promise<void> {
  const rows = await db.proofs.bulkGet(secrets);
  const changed = rows
    .filter((row): row is StoredProofRow => !!row)
    .map(({ reservedBy: _reservedBy, ...row }) => row);
  if (changed.length === 0) return;
  await db.proofs.bulkPut(changed);
}

export async function getReservedProofs(reservedBy: string): Promise<StoredProof[]> {
  const rows = await db.proofs.filter((proof) => proof.reservedBy === reservedBy).toArray();
  return rows.map(normalizeStoredProof);
}

// One-shot migration: existing rows may have un-normalized mintUrl values
// stored before addProofs normalized on write. Callers should gate this on
// a persisted flag so it runs once per device.
export async function normalizeStoredMintUrls(): Promise<number> {
  const rows = await db.proofs.toArray();
  let changed = 0;
  await db.transaction("rw", db.proofs, async () => {
    for (const row of rows) {
      const normalized = normalizeUrl(row.mintUrl);
      if (normalized !== row.mintUrl) {
        await db.proofs.put({ ...row, mintUrl: normalized });
        changed++;
      }
    }
  });
  return changed;
}

export function normalizeAndValidateStoredProof(proof: StoredProof): StoredProof {
  return normalizeStoredProof(validateStoredProofUnitInvariant(proof));
}

function normalizeStoredProof(proof: StoredProof | StoredProofRow): StoredProof {
  const {
    terminalOperationId: rawTerminalOperationId,
    conditionId: _conditionId,
    outcomeCollection: _outcomeCollection,
    condition_id: _legacyConditionId,
    outcome_collection: _legacyOutcomeCollection,
    ...rest
  } = proof as StoredProof & { condition_id?: string; outcome_collection?: string };
  const terminalOperationId = normalizeStoredProofTerminalOperationId(rawTerminalOperationId);
  return {
    ...rest,
    ...normalizeStoredProofCtfMetadata(proof),
    amount: Amount.from(amountToNumber(proof.amount)),
    mintUrl: normalizeUrl(proof.mintUrl),
    baseAsset: normalizeStoredProofBaseAsset(proof),
    unit: normalizeStoredProofUnit(proof),
    ...(terminalOperationId === undefined ? {} : { terminalOperationId }),
  };
}

export function storedProofFromRow(proof: StoredProofRow): StoredProof {
  return normalizeStoredProof(proof);
}

export function storedProofRow(proof: StoredProof): StoredProofRow {
  const {
    terminalOperationId: rawTerminalOperationId,
    conditionId: _conditionId,
    outcomeCollection: _outcomeCollection,
    condition_id: _legacyConditionId,
    outcome_collection: _legacyOutcomeCollection,
    ...rest
  } = proof as StoredProof & { condition_id?: string; outcome_collection?: string };
  const terminalOperationId = normalizeStoredProofTerminalOperationId(rawTerminalOperationId);
  return {
    ...rest,
    ...normalizeStoredProofCtfMetadata(proof),
    amount: amountToNumber(proof.amount),
    mintUrl: normalizeUrl(proof.mintUrl),
    baseAsset: normalizeStoredProofBaseAsset(proof),
    unit: normalizeStoredProofUnit(proof),
    ...(terminalOperationId === undefined ? {} : { terminalOperationId }),
  };
}

function normalizeStoredProofCtfMetadata(proof: StoredProof | StoredProofRow): {
  conditionId?: string;
  outcomeCollection?: string;
} {
  const candidate = proof as StoredProof & {
    condition_id?: string;
    outcome_collection?: string;
  };
  const conditionId = candidate.conditionId ?? candidate.condition_id;
  const outcomeCollection = candidate.outcomeCollection ?? candidate.outcome_collection;
  if (
    (candidate.conditionId !== undefined &&
      candidate.condition_id !== undefined &&
      candidate.conditionId !== candidate.condition_id) ||
    (candidate.outcomeCollection !== undefined &&
      candidate.outcome_collection !== undefined &&
      candidate.outcomeCollection !== candidate.outcome_collection) ||
    (conditionId === undefined) !== (outcomeCollection === undefined)
  ) {
    throw new Error("Stored proof CTF metadata is invalid");
  }
  return conditionId === undefined ? {} : { conditionId, outcomeCollection: outcomeCollection! };
}

function normalizeStoredProofTerminalOperationId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw new Error("Stored proof terminal operation is invalid");
  }
  return value;
}

function isReadableStoredProof(
  proof: StoredProof,
  options: { includeReserved?: boolean; includeTerminal?: boolean },
): boolean {
  return (
    (options.includeReserved || !proof.reservedBy) &&
    (options.includeTerminal || proof.terminalOperationId === undefined)
  );
}

function isSpendableStoredProof(proof: StoredProof): boolean {
  return !proof.reservedBy && proof.terminalOperationId === undefined;
}

function normalizeStoredProofBaseAsset(proof: StoredProof | StoredProofRow): string {
  const unit = parseCashuProofUnit(proof.unit);
  if (unit && !proof.baseAsset) return COLLATERAL_UNIT_REGISTRY[unit].baseAsset;
  return normalizeMarketBaseAsset(proof.baseAsset);
}

export function normalizeStoredProofUnit(
  proof: StoredProof | StoredProofRow,
): CashuProofUnit | undefined {
  return parseCashuProofUnit(proof.unit) ?? undefined;
}

function validateStoredProofUnitInvariant(proof: StoredProof): StoredProof {
  if (!proof.unit) throw new Error("Stored proof unit is required");
  const unit = parseCashuProofUnit(proof.unit);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${proof.unit}'`);
  const unitInfo = COLLATERAL_UNIT_REGISTRY[unit];
  const baseAsset = proof.baseAsset
    ? normalizeMarketBaseAsset(proof.baseAsset)
    : unitInfo.baseAsset;
  if (unitInfo.baseAsset !== baseAsset) {
    throw new Error(
      `Stored proof unit '${proof.unit}' is not compatible with base asset '${proof.baseAsset}'`,
    );
  }
  if (isCtfProof(proof) && unit !== "msat") {
    throw new Error("CTF proofs require exact Cashu unit 'msat'");
  }
  return proof;
}

export async function getProofOperation(
  operationId: string,
  database: BitcasterDB = db,
): Promise<ProofOperationRecord | null> {
  return (await database.proofOperations.get(operationId)) ?? null;
}

export async function getProofOperations(
  input: {
    mintUrl?: string;
    states?: ProofOperationState[];
    kinds?: ProofOperationKind[];
    operationIdPrefix?: string;
  } = {},
  database: BitcasterDB = db,
): Promise<ProofOperationRecord[]> {
  const mintUrl = input.mintUrl ? normalizeUrl(input.mintUrl) : undefined;
  const stateSet = input.states ? new Set(input.states) : null;
  const kindSet = input.kinds ? new Set(input.kinds) : null;
  return (
    await database.proofOperations
      .filter((operation) => {
        if (mintUrl && operation.mintUrl !== mintUrl) return false;
        if (stateSet && !stateSet.has(operation.state)) return false;
        if (kindSet && !kindSet.has(operation.kind)) return false;
        if (input.operationIdPrefix && !operation.operationId.startsWith(input.operationIdPrefix)) {
          return false;
        }
        return true;
      })
      .toArray()
  ).map((operation) => ({
    ...operation,
    mintUrl: normalizeUrl(operation.mintUrl),
  }));
}

export async function prepareProofOperation(
  input: PrepareProofOperationInput,
  database: BitcasterDB = db,
): Promise<ProofOperationRecord> {
  const existing = await getProofOperation(input.operationId, database);
  if (existing) {
    assertCompatibleProofOperation(existing, input);
    return existing;
  }

  const now = Date.now();
  const record: ProofOperationRecord = {
    operationId: input.operationId,
    kind: input.kind,
    state: "prepared",
    mintUrl: normalizeUrl(input.mintUrl),
    inputs: structuredClone(input.inputs),
    outputs: structuredClone(input.outputs),
    metadata: structuredClone(input.metadata ?? {}),
    resultProofs: undefined,
    resultProofsDigest: undefined,
    lastError: null,
    failureCode: undefined,
    createdAt: now,
    updatedAt: now,
  };
  await database.proofOperations.put(record);
  return record;
}

export async function markProofOperationCompleted(
  operationId: string,
  completion: Record<string, Proof[]> | CtfProofOperationCompletion,
  database: BitcasterDB = db,
): Promise<ProofOperationRecord> {
  const existing = await getRequiredProofOperation(operationId, database);
  const ctfCompletion = isCtfProofOperationCompletion(completion);
  if (isSdkCtfProofOperationKind(existing.kind) && !ctfCompletion) {
    throw new Error(`Proof operation ${operationId} requires an SDK completion`);
  }
  if (ctfCompletion && completion.kind !== existing.kind) {
    throw new Error(
      `Proof operation ${operationId} kind ${existing.kind} does not match completion ${completion.kind}`,
    );
  }
  const resultProofs = ctfCompletion ? completion.resultProofs : completion;
  const updated: ProofOperationRecord = {
    ...existing,
    state: "completed",
    resultProofs: structuredClone(resultProofs),
    resultProofsDigest:
      ctfCompletion && "resultProofsDigest" in completion
        ? completion.resultProofsDigest
        : undefined,
    lastError: null,
    failureCode: undefined,
    updatedAt: Date.now(),
  };
  await database.proofOperations.put(updated);
  return updated;
}

function isCtfProofOperationCompletion(
  value: Record<string, Proof[]> | CtfProofOperationCompletion,
): value is CtfProofOperationCompletion {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string" &&
    "resultProofs" in value
  );
}

function isSdkCtfProofOperationKind(kind: ProofOperationKind): boolean {
  return (
    kind === "ctf-split" ||
    kind === "ctf-merge" ||
    kind === "ctf-redeem" ||
    kind === "regular-split"
  );
}

export async function markProofOperationFailed(
  operationId: string,
  error: unknown,
  database: BitcasterDB = db,
): Promise<ProofOperationRecord> {
  const existing = await getRequiredProofOperation(operationId, database);
  if (existing.kind === "ctf-redeem" && mintErrorCode(error) === 13015) {
    throw new Error("CTF redeem terminal failure requires authenticated mint evidence");
  }
  const updated: ProofOperationRecord = {
    ...existing,
    state: "Failed",
    lastError: error instanceof Error ? error.message : String(error),
    failureCode: mintErrorCode(error),
    updatedAt: Date.now(),
  };
  await database.proofOperations.put(updated);
  return updated;
}

export async function markCtfRedeemTerminalFailure(
  operationId: string,
  message: string,
  terminalEvidence: AuthenticatedCtfRedeemTerminalEvidence,
  database: BitcasterDB = db,
): Promise<ProofOperationRecord> {
  const evidence = readAuthenticatedCtfRedeemTerminalEvidence(terminalEvidence);
  const existing = await getRequiredProofOperation(operationId, database);
  if (
    existing.operationId !== evidence.operationId ||
    existing.kind !== "ctf-redeem" ||
    normalizeUrl(existing.mintUrl) !== evidence.normalizedMint
  ) {
    throw new Error("CTF redeem terminal evidence is foreign");
  }
  if (existing.state === "Failed") {
    if (existing.failureCode !== evidence.rejectionBody.code) {
      throw new Error("CTF redeem terminal failure conflicts");
    }
    return existing;
  }
  if (existing.state !== "prepared") {
    throw new Error("CTF redeem terminal failure is stale");
  }
  const updated: ProofOperationRecord = {
    ...existing,
    state: "Failed",
    lastError: message,
    failureCode: evidence.rejectionBody.code,
    updatedAt: Date.now(),
  };
  await database.proofOperations.put(updated);
  return updated;
}

function mintErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

async function getRequiredProofOperation(
  operationId: string,
  database: BitcasterDB = db,
): Promise<ProofOperationRecord> {
  const existing = await getProofOperation(operationId, database);
  if (!existing) throw new Error(`Missing proof operation ${operationId}`);
  return existing;
}

function assertCompatibleProofOperation(
  existing: ProofOperationRecord,
  input: PrepareProofOperationInput,
): void {
  if (
    existing.kind !== input.kind ||
    existing.mintUrl !== normalizeUrl(input.mintUrl) ||
    JSON.stringify(existing.inputs) !== JSON.stringify(input.inputs) ||
    JSON.stringify(existing.outputs) !== JSON.stringify(input.outputs) ||
    JSON.stringify(existing.metadata) !== JSON.stringify(input.metadata ?? {})
  ) {
    throw new Error(`Proof operation ${input.operationId} already exists with different inputs`);
  }
}
