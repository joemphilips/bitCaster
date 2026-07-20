import type { ProofLike } from "@cashu/cashu-ts";
import {
  type CONDITIONAL_RECOVERY_SESSION_SCHEMA_VERSION,
  type ConditionalRecoveryBatchBinding,
  type ConditionalRecoveryKeysetTerminalEvidence,
  type ConditionalRecoverySessionScan,
  type ConditionalRecoverySessionTransition,
  type ConditionalRecoverySkipEvidence,
  type ConditionalRecoveryTerminalEvidence,
} from "./emergencyConditionalRecoverySession.ts";

export const CONDITIONAL_RECOVERY_CATALOGUE_VERSION = 1 as const;
export const CONDITIONAL_RECOVERY_CHECKPOINT_VERSION = 1 as const;
export const CONDITIONAL_RECOVERY_MAX_PAGE_SIZE = 100 as const;
export const CONDITIONAL_RECOVERY_MAX_CURSOR_BYTES = 2_048 as const;
export const CONDITIONAL_RECOVERY_MAX_PAGES = 1_000 as const;
export const CONDITIONAL_RECOVERY_MAX_KEYSETS = 10_000 as const;
export const CONDITIONAL_RECOVERY_MAX_PAGE_BYTES = 16 * 1_024 * 1_024;
export const CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES = 64 * 1_024 * 1_024;
export const CONDITIONAL_RECOVERY_MAX_CHECKPOINT_BYTES =
  CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES;
export const CONDITIONAL_RECOVERY_MAX_KEYS_PER_KEYSET = 1_024 as const;
export const CONDITIONAL_RECOVERY_MAX_DERIVATION_BATCH_SIZE = 100 as const;
export const CONDITIONAL_RECOVERY_GAP_LIMIT = 100 as const;
export const CONDITIONAL_RECOVERY_MAX_NUT07_AUDIT_BYTES = 64 * 1_024 * 1_024;
export const CONDITIONAL_RECOVERY_MAX_TOTAL_PROOFS = 100_000 as const;
export const CONDITIONAL_RECOVERY_MAX_WORK_UNITS = 1_000_000 as const;
export const CONDITIONAL_RECOVERY_MAX_UNIT_BYTES = 64 as const;
export const CONDITIONAL_RECOVERY_MAX_OUTCOME_COLLECTION_BYTES = 16 * 1_024;
export const CONDITIONAL_RECOVERY_WALLET_SCOPE_SCHEMA_VERSION = 1 as const;
export const CONDITIONAL_RECOVERY_AUTHORITY_MAX_AGE_MS = 60_000 as const;
export interface ConditionalRecoveryCapability {
  readonly version: typeof CONDITIONAL_RECOVERY_CATALOGUE_VERSION;
  readonly maxPageSize: number;
}

export interface ConditionalRecoveryWalletScope {
  readonly schemaVersion: typeof CONDITIONAL_RECOVERY_WALLET_SCOPE_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly unit: string;
}

export interface ConditionalRecoveryKeysetMetadata {
  readonly id: string;
  readonly unit: string;
  readonly active: boolean;
  readonly inputFeePpk: number | null;
  readonly finalExpiry: number | null;
  readonly conditionId: string;
  readonly outcomeCollection: string;
  readonly outcomeCollectionId: string;
  readonly registeredAt: number;
}

export interface ConditionalRecoveryBudget {
  readonly transportBytes: number;
  readonly serializedBytes: number;
  readonly workUnits: number;
  readonly proofCount: number;
}

export interface ConditionalCatalogueProgress {
  readonly capability: ConditionalRecoveryCapability;
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly pageCount: number;
  readonly cursorDigests: readonly string[];
  readonly budget: ConditionalRecoveryBudget;
}

export interface ConditionalCatalogueCheckpoint extends ConditionalCatalogueProgress {
  readonly schemaVersion: typeof CONDITIONAL_RECOVERY_CHECKPOINT_VERSION;
  readonly terminalComplete: boolean;
  readonly currentCursor: string | null;
  readonly keysets: readonly ConditionalRecoveryKeysetMetadata[];
}

export interface ValidatedConditionalCataloguePage {
  readonly keysets: readonly ConditionalRecoveryKeysetMetadata[];
  readonly complete: boolean;
  readonly nextCursor: string | null;
  readonly progress: ConditionalCatalogueProgress;
}

export interface CompletedConditionalRecoveryCatalogue {
  readonly capability: ConditionalRecoveryCapability;
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly keysets: readonly ConditionalRecoveryKeysetMetadata[];
  readonly budget: ConditionalRecoveryBudget;
}

export interface ConditionalRecoveryAuthorityPort {
  readonly fetchMintInfo: (
    scope: ConditionalRecoveryWalletScope,
  ) => unknown | Promise<unknown>;
  readonly readWallClockMs: () => number | Promise<number>;
  readonly advanceAndReadHighWater: (input: {
    readonly scopeId: string;
    readonly mintUrl: string;
    readonly unit: string;
    readonly observedUnixSeconds: number;
  }) => number | Promise<number>;
}

export interface ConditionalCatalogueReplayPort {
  readonly fetchPage: (input: {
    readonly walletScope: ConditionalRecoveryWalletScope;
    readonly cursor: string | null;
    readonly maxPageSize: number;
  }) =>
    | { readonly response: unknown; readonly responseBytes: number }
    | Promise<{ readonly response: unknown; readonly responseBytes: number }>;
}

export interface ConditionalRecoveryAuthorityObservation {
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly capability: ConditionalRecoveryCapability;
  readonly effectiveTime: number;
}

export interface ConditionalRecoverySession {
  readonly schemaVersion: typeof CONDITIONAL_RECOVERY_SESSION_SCHEMA_VERSION;
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly sequence: number;
  readonly predecessorDigest: string | null;
  readonly transition: ConditionalRecoverySessionTransition;
  readonly evidenceDigest: string;
  readonly budget: ConditionalRecoveryBudget;
  readonly nut07AuditBytes: number;
  readonly catalogueDigest: string;
  readonly completedKeysetProofCount: number;
  readonly catalogueOrdinal: number | null;
  readonly activeKeysetId: string | null;
  readonly keysetMetadataDigest: string | null;
  readonly keysDigest: string | null;
  readonly scan: ConditionalRecoverySessionScan;
  readonly currentBatch: ConditionalRecoveryBatchBinding | null;
  readonly keysetTerminalEvidence: ConditionalRecoveryKeysetTerminalEvidence | null;
  readonly skipEvidence: ConditionalRecoverySkipEvidence | null;
  readonly terminalEvidence: ConditionalRecoveryTerminalEvidence | null;
  readonly digest: string;
}

export interface ConditionalRecoveryFreshExpiryEvidence {
  readonly catalogueOrdinal: number;
  readonly keysetId: string;
  readonly conditionId: string;
  readonly finalExpiry: number;
  readonly observedAt: number;
  readonly keysetMetadataDigest: string;
  readonly authorityDigest: string;
}


export interface ConditionalRecoveryKeysTransportPort {
  readonly fetchConditionalKeysEntity: (input: {
    readonly walletScope: ConditionalRecoveryWalletScope;
    readonly endpoint: string;
    readonly keysetId: string;
    readonly maxEntityBytes: number;
  }) => Promise<Uint8Array>;
}

export interface ConditionalRecoveryNut09TransportPort {
  readonly fetchNut09Entity: (input: {
    readonly walletScope: ConditionalRecoveryWalletScope;
    readonly endpoint: string;
    readonly requestBytes: Uint8Array;
    readonly maxEntityBytes: number;
  }) => Promise<Uint8Array>;
}

export interface ConditionalRecoveryNut07TransportPort {
  readonly fetchNut07Entity: (input: {
    readonly walletScope: ConditionalRecoveryWalletScope;
    readonly endpoint: string;
    readonly requestBytes: Uint8Array;
    readonly maxEntityBytes: number;
  }) => Promise<Uint8Array>;
}

export interface ConditionalRecoveryNut07CommitAuthority {
  readonly consumeForCommit: () => Readonly<{
    authorityDigest: string;
    monotonicAgeMs: number;
  }>;
}

export interface ConditionalRecoveryNut07AuditPayload {
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly keysetId: string;
  readonly expectedSessionDigest: string;
  readonly stagedBatchId: string;
  readonly proofYDigest: string;
  readonly proofYs: readonly string[];
  readonly requestBytes: Uint8Array;
  readonly responseBytes: Uint8Array;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly results: readonly ConditionalRecoveryNut07Result[];
  readonly issuedAt: number;
  readonly deadline: number;
  readonly authorityDigest: string;
}

export type ConditionalRecoveryProofDispositionRow =
  | Readonly<{
      proofIdentity: string;
      state: "UNSPENT";
      disposition: "selectable-wallet-custody" | "expired-keyset";
      proof: CanonicalConditionalRecoveryProof;
    }>
  | Readonly<{
      proofIdentity: string;
      state: "PENDING";
      disposition: "pending-mint-state" | "expired-keyset";
      proof: CanonicalConditionalRecoveryProof;
    }>
  | Readonly<{
      proofIdentity: string;
      state: "SPENT";
      disposition: "spent-audit";
      proof: CanonicalConditionalRecoveryProof;
    }>;

export interface ConditionalRecoverySessionCasPort {
  readonly readCurrentDigest: (
    walletScope: ConditionalRecoveryWalletScope,
  ) => string | null;
  readonly compareAndSwap: (input: {
    readonly walletScope: ConditionalRecoveryWalletScope;
    readonly expectedDigest: string | null;
    readonly successor: ConditionalRecoverySession;
  }) => boolean;
  readonly compareAndSwapStageConditionalKeys: (input: {
    readonly walletScope: ConditionalRecoveryWalletScope;
    readonly expectedDigest: string;
    readonly successor: ConditionalRecoverySession;
    readonly keysetId: string;
    readonly catalogueOrdinal: number;
    readonly keysBytes: Uint8Array;
  }) => Promise<boolean>;
  readonly compareAndSwapStageNut09Request: (input: {
    readonly walletScope: ConditionalRecoveryWalletScope;
    readonly expectedDigest: string;
    readonly successor: ConditionalRecoverySession;
    readonly requestBytes: Uint8Array;
  }) => Promise<boolean>;
  readonly compareAndSwapStageNut09Response: (input: {
    readonly expectedSessionDigest: string;
    readonly successor: ConditionalRecoverySession;
    readonly stagedBatchId: string;
    readonly requestBytes: Uint8Array;
    readonly responseBytes: Uint8Array;
    readonly rows: readonly CanonicalConditionalRecoveryProof[];
  }) => Promise<boolean>;
  readonly compareAndSwapInsertUnique: ConditionalRecoveryAdmissionPort["compareAndSwapInsertUnique"];
  readonly compareAndSwapRetainExpiredKeyset: (input: {
    readonly expectedSessionDigest: string;
    readonly successor: ConditionalRecoverySession;
    readonly stagedBatchId: string;
    readonly expiryAuthority: ConditionalRecoveryFreshExpiryEvidence;
    readonly rows: readonly ConditionalRecoveryProofDispositionRow[];
  }) => Promise<boolean>;
}

export interface SeedDerivedConditionalRecoveryOutput {
  readonly counter: number;
  readonly id: string;
  readonly amount: string;
  readonly B_: string;
  readonly Y: string;
}

export interface SeedDerivedConditionalRecoveryPlan {
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly keysetId: string;
  readonly outputs: readonly SeedDerivedConditionalRecoveryOutput[];
  readonly digest: string;
  readonly session: ConditionalRecoverySession;
}

export interface ConditionalRecoveryNut13DerivationPort {
  readonly deriveSeedOutputs: (input: {
    readonly walletScope: ConditionalRecoveryWalletScope;
    readonly keysetId: string;
    readonly startCounter: number;
    readonly count: number;
  }) =>
    | readonly {
        readonly counter: unknown;
        readonly id: unknown;
        readonly amount: unknown;
        readonly B_: unknown;
        readonly Y: unknown;
        readonly unblind: (signature: unknown) => ProofLike;
      }[]
    | Promise<
        readonly {
          readonly counter: unknown;
          readonly id: unknown;
          readonly amount: unknown;
          readonly B_: unknown;
          readonly Y: unknown;
          readonly unblind: (signature: unknown) => ProofLike;
        }[]
      >;
}

export interface ConditionalRecoveryNut09RequestAuthorization {
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly keysetId: string;
  readonly outputs: readonly Readonly<{
    id: string;
    amount: string;
    B_: string;
  }>[];
  readonly requestBytes: Uint8Array;
  readonly requestDigest: string;
  readonly planDigest: string;
  readonly session: ConditionalRecoverySession;
}

export interface ConditionalRecoveryAdmissionPort {
  readonly compareAndSwapInsertUnique: (input: {
    readonly walletScope: ConditionalRecoveryWalletScope;
    readonly expectedSessionDigest: string;
    readonly successorSession: ConditionalRecoverySession;
    readonly stagedBatchId: string;
    readonly rows: readonly ConditionalRecoveryProofDispositionRow[];
    readonly nut07Authority: ConditionalRecoveryNut07CommitAuthority;
    readonly nut07Audit: ConditionalRecoveryNut07AuditPayload;
  }) => boolean;
}

export interface ValidatedConditionalRecoveryTarget {
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly metadata: ConditionalRecoveryKeysetMetadata;
  readonly keys: Readonly<Record<string, string>>;
  readonly validatedAt: number;
  readonly budget: ConditionalRecoveryBudget;
  readonly session: ConditionalRecoverySession;
}

export interface ConditionalRecoveryFreshIneligibleSkip {
  readonly reason: "freshly-proven-ineligible";
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly keysetId: string;
  readonly catalogueOrdinal: number;
  readonly authorityDigest: string;
  readonly budget: ConditionalRecoveryBudget;
  readonly session: ConditionalRecoverySession;
}

export interface CanonicalConditionalRecoveryProof {
  readonly id: string;
  readonly amount: string;
  readonly secret: string;
  readonly C: string;
  readonly dleq: Readonly<{ e: string; s: string; r: string }>;
  readonly p2pk_e: string | null;
  readonly witness: string | Readonly<Record<string, unknown>> | null;
}

export interface ChargedConditionalRecoveryProofBatch {
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly keysetId: string;
  readonly proofCount: number;
  readonly proofBodyDigest: string;
  readonly proofYDigest: string;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly planDigest: string;
  readonly stagedBatchId: string | null;
  readonly proofIdentities: readonly string[];
  readonly proofs: readonly ProofLike[];
  readonly session: ConditionalRecoverySession;
  readonly budget: ConditionalRecoveryBudget;
}

export type ConditionalRecoveryNut07State = "UNSPENT" | "PENDING" | "SPENT";

export interface ConditionalRecoveryNut07Result {
  readonly proofIndex: number;
  readonly state: ConditionalRecoveryNut07State;
}

export interface ConditionalRecoveryNut07Classification {
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly keysetId: string;
  readonly results: readonly ConditionalRecoveryNut07Result[];
  readonly proofCount: number;
  readonly proofBodyDigest: string;
  readonly proofYDigest: string;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly planDigest: string;
  readonly proofIdentities: readonly string[];
  readonly session: ConditionalRecoverySession;
  readonly budget: ConditionalRecoveryBudget;
}

export interface VerifiedConditionalRecoveryProofBatch {
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly keysetId: string;
  readonly proofCount: number;
  readonly proofBodyDigest: string;
  readonly proofYDigest: string;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly planDigest: string;
  readonly proofIdentities: readonly string[];
  readonly session: ConditionalRecoverySession;
  readonly verifiedAt: number;
  readonly budget: ConditionalRecoveryBudget;
}

export interface ConditionalRecoveryAdmissionAuthorization {
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly keysetId: string;
  readonly authorizedAt: number;
  readonly session: ConditionalRecoverySession;
  readonly selectableProofs: readonly CanonicalConditionalRecoveryProof[];
  readonly pendingProofs: readonly CanonicalConditionalRecoveryProof[];
  readonly spentProofs: readonly CanonicalConditionalRecoveryProof[];
}
