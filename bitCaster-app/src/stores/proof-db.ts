import Dexie, { type Table } from "dexie";
import type { Proof } from "@cashu/cashu-ts";
import { isStrictCashuProofArtifact } from "@bitcaster/client-sdk/cashuProofArtifact";
import {
  deriveDurableCustodyProofId,
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
} from "@bitcaster/client-sdk/durableCustody";
import {
  amountToNumber,
  sameCashuProofArtifact,
} from "@bitcaster/client-sdk/proofSelection";
import {
  COLLATERAL_UNIT_REGISTRY,
  normalizeMarketBaseAsset,
  parseMarketBaseAsset,
  parseCashuProofUnit,
  type CashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import { normalizeUrl } from "../lib/url";
import {
  validateDurableProofOperationLink,
  type DurableTradePendingIntent,
  type DurableTradeProofOperationLink,
  type DurableTradeSession,
} from "@bitcaster/client-sdk/durableTradeRecovery";
import type {
  DexieCustodyOperationRow,
  DexieCustodyProofReservationRow,
  DexieCustodyScopeRow,
  DexieCustodyScopeStateRow,
  DexieCustodySessionLinkRow,
} from "./durable-custody-dexie";
import type { GuiPartialLockFailureRecord } from "./partial-lock-failure-model";
import type { PendingLocalWalletPaymentRow } from "./pending-local-wallet-payment-model";
import type { PendingTradeRecord } from "./pendingTrades";
import type { WalletActivityRow } from "./wallet-activity-projection";
import type {
  GuiDurableStorageAccountingRow,
  GuiDurableStorageHeadroomRow,
} from "./gui-durable-storage-admission-model";
import { createGuiDurableStorageRowArtifact } from "./gui-durable-storage-artifacts";
import {
  walletIdFromHeldGuiWalletLock,
  withGuiWalletLock,
  type GuiWalletLockContext,
} from "./gui-wallet-lock";

export interface StoredProof extends Proof {
  /** Derived physical identity. Present only after durable preparation/read. */
  proofId?: string;
  /** Seed-derived wallet identity. Required on every physical Dexie row. */
  walletId?: string;
  mintUrl: string;
  /** Local-only reservation owner. Reserved proofs are hidden from spendable balances. */
  reservedBy?: string;
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
  /** Derived physical classification. Callers must not choose this value. */
  proofClass?: StoredProofClass;
  /** Derived physical reservation state. Callers must not choose this value. */
  selectability?: StoredProofSelectability;
}

export type StoredProofClass = "regular" | "ctf";
export type StoredProofSelectability = "spendable" | "reserved";

export type StoredProofRow = StoredProof & {
  proofId: string;
  walletId: string;
  baseAsset: string;
  unit: CashuProofUnit;
  receivedAt: number;
  proofClass: StoredProofClass;
  selectability: StoredProofSelectability;
};

export interface StoredOutputData {
  blindedMessage: {
    amount: number;
    id: string;
    B_: string;
  };
  blindingFactor: string;
  secret: string;
  ephemeralE?: string;
}

export type ProofOperationKind =
  | "swap-lock"
  | "swap-claim"
  | "conditional-keyset-swap"
  | "swap-refund"
  | "ctf-split"
  | "ctf-merge"
  | "ctf-redeem"
  | "ctf-condition-registration"
  | "regular-split"
  | "proof-split"
  | "wallet-mint"
  | "wallet-receive";
export type ProofOperationState =
  | "prepared"
  | "mint-submitted"
  | "completed"
  | "Failed";

export type ProofOperationPrimaryKey = [walletId: string, operationId: string];

export interface ProofOperationRecord {
  walletId: string;
  operationId: string;
  /** SDK recovery identity for a swap-owned operation. */
  durableTradeRecovery?: DurableTradeProofOperationLink;
  /** Indexed mirror of the SDK semantic operation id for exact recovery. */
  durableOperationId?: string;
  /** Indexed canonical custody-row identity; distinct from the trade-link id. */
  custodyOperationId: string;
  /** Indexed mirror that bounds recovery scans to one durable trade. */
  durableTradeId?: string;
  kind: ProofOperationKind;
  state: ProofOperationState;
  mintUrl: string;
  inputs: Proof[];
  outputs: Record<string, StoredOutputData[]>;
  metadata: Record<string, unknown> & { unit?: CashuProofUnit };
  resultProofs?: Record<string, Proof[]>;
  lastError: string | null;
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

/**
 * The opaque GUI payload is owned by the swap-session adapter; the common
 * session schema is owned by bitcaster-client-sdk.
 */
export interface SwapSessionRecord {
  adapterSchemaVersion: number;
  walletId: string;
  tradeId: string;
  active: 0 | 1;
  session: DurableTradeSession;
  adapterState: unknown;
  updatedAt: number;
}

/** Adapter-owned private key material for an SDK-defined pre-session intent. */
export interface SwapIntentRecord {
  walletId: string;
  tradeId: string;
  intent: DurableTradePendingIntent;
  ephemeralPrivkeyHex: string;
  submitted: boolean;
  updatedAt: number;
}

export interface GuiWalletCounterRow {
  walletId: string;
  keysetId: string;
  nextCounter: number;
  updatedAt: number;
}

let durableSwapStorageBlockedReason: string | null = null;
let rejectDurableSwapStorageOpen: ((error: Error) => void) | null = null;
let durableSwapStorageOpenInFlight: Promise<void> | null = null;
let durableSwapStorageOpenWalletId: string | null = null;
const DURABLE_SWAP_STORAGE_OPEN_TIMEOUT_MS = 5_000;
let guiWalletIdProvider: (() => string) | null = null;

export function configureGuiWalletIdProvider(provider: () => string): void {
  guiWalletIdProvider = provider;
}

export function currentGuiWalletId(): string {
  return requireGuiWalletId(guiWalletIdProvider?.());
}

async function withGuiProofWriterLock<T>(
  action: (walletId: string) => Promise<T>,
): Promise<T> {
  const walletId = currentGuiWalletId();
  return withGuiWalletLock(walletId, currentGuiWalletId, (lock) =>
    withHeldGuiProofWriterLock(lock, action),
  );
}

async function withHeldGuiProofWriterLock<T>(
  lock: GuiWalletLockContext,
  action: (walletId: string) => Promise<T>,
): Promise<T> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  return action(walletId);
}

export function requireGuiWalletId(walletId: unknown): string {
  if (typeof walletId !== "string" || !/^[0-9a-f]{64}$/.test(walletId)) {
    throw new Error(
      "GUI proof storage requires a valid seed-derived wallet id",
    );
  }
  return walletId;
}

export function isCtfProof(proof: StoredProof | Proof): boolean {
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

export class BitcasterDB extends Dexie {
  proofs!: Table<StoredProofRow, string>;
  proofOperations!: Table<ProofOperationRecord, ProofOperationPrimaryKey>;
  swapSessions!: Table<SwapSessionRecord>;
  swapIntents!: Table<SwapIntentRecord>;
  custodyScopes!: Table<DexieCustodyScopeRow, string>;
  custodyScopeStates!: Table<DexieCustodyScopeStateRow, string>;
  custodyOperations!: Table<DexieCustodyOperationRow, string>;
  custodySessionLinks!: Table<DexieCustodySessionLinkRow, string>;
  custodyProofReservations!: Table<DexieCustodyProofReservationRow, string>;
  partialLockFailures!: Table<
    GuiPartialLockFailureRecord & { walletId: string },
    [string, string]
  >;
  walletCounters!: Table<GuiWalletCounterRow, [string, string]>;
  pendingLocalWalletPayments!: Table<
    PendingLocalWalletPaymentRow,
    [string, string]
  >;
  pendingTrades!: Table<PendingTradeRecord, [string, string]>;
  walletActivities!: Table<WalletActivityRow, [string, string]>;
  durableStorageAccounting!: Table<GuiDurableStorageAccountingRow, string>;
  durableStorageHeadroom!: Table<GuiDurableStorageHeadroomRow, string>;

  constructor() {
    super("bitcaster");
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
      swapSessions: "tradeId, updatedAt",
    });
    this.version(6).stores({
      proofs:
        "secret, id, C, amount, mintUrl, receivedAt, conditionId, outcomeCollection, [conditionId+outcomeCollection], [mintUrl+conditionId+outcomeCollection]",
      proofOperations: "operationId, state, kind, mintUrl, updatedAt",
      swapSessions: "tradeId, updatedAt",
      swapIntents: "tradeId, updatedAt, submitted",
    });
    this.version(7).stores({
      proofs:
        "secret, id, C, amount, mintUrl, receivedAt, conditionId, outcomeCollection, [conditionId+outcomeCollection], [mintUrl+conditionId+outcomeCollection]",
      proofOperations:
        "operationId, state, kind, mintUrl, updatedAt, durableOperationId",
      swapSessions: "tradeId, updatedAt",
      swapIntents: "tradeId, updatedAt, submitted",
    });
    this.version(8).stores({
      proofs:
        "secret, id, C, amount, mintUrl, receivedAt, conditionId, outcomeCollection, [conditionId+outcomeCollection], [mintUrl+conditionId+outcomeCollection]",
      proofOperations:
        "operationId, state, kind, mintUrl, updatedAt, durableOperationId, durableTradeId, custodyOperationId",
      swapSessions: "tradeId, updatedAt",
      swapIntents: "tradeId, updatedAt, submitted",
    });
    // The feature was not deployed. Version 9 is intentionally a tombstone:
    // ownership and proof identities cannot be inferred safely from v1-v8.
    this.version(9).stores({
      proofs: null,
      proofOperations: null,
      swapSessions: null,
      swapIntents: null,
    });
    this.version(10)
      .stores({
        proofs:
          "proofId, walletId, [walletId+mintUrl], [walletId+mintUrl+unit+proofClass+selectability+amount], [walletId+conditionId+outcomeCollection], [walletId+mintUrl+conditionId+outcomeCollection], [walletId+reservedBy]",
        proofOperations:
          "operationId, walletId, [walletId+state], [walletId+kind], [walletId+mintUrl], [walletId+durableOperationId], [walletId+durableTradeId], updatedAt, custodyOperationId",
        swapSessions:
          "tradeId, walletId, [walletId+active], [walletId+updatedAt]",
        swapIntents:
          "tradeId, walletId, [walletId+updatedAt], [walletId+submitted]",
        custodyScopes: "scopeId, scopeKind, &marketId, &inventoryKey",
        custodyScopeStates: "scopeId",
        custodyOperations:
          "operationId, scopeId, active, [scopeId+operationId], [scopeId+active+operationId]",
        custodySessionLinks:
          "operationId, scopeId, sessionId, &[scopeId+sessionId+operationId]",
        custodyProofReservations:
          "proofId, scopeId, operationId, [scopeId+operationId]",
        partialLockFailures:
          "[walletId+tradeId], walletId, [walletId+refundLocktime], [walletId+createdAt]",
        walletCounters: "[walletId+keysetId], walletId",
        pendingLocalWalletPayments:
          "[walletId+depositId], walletId, [walletId+phase], &[walletId+splitOperationId], [walletId+nextAttemptAt+createdAt+depositId]",
        pendingTrades:
          "[walletId+orderId], walletId, &[walletId+clientOrderId], [walletId+submittedAt]",
      })
      .upgrade(async (transaction) => {
        // Also erase any locally-created development v9 database. There is no
        // production compatibility contract for this pre-release schema.
        await Promise.all(
          [
            "proofs",
            "proofOperations",
            "swapSessions",
            "swapIntents",
            "custodyScopes",
            "custodyScopeStates",
            "custodyOperations",
            "custodySessionLinks",
            "custodyProofReservations",
            "partialLockFailures",
            "walletCounters",
            "pendingLocalWalletPayments",
            "pendingTrades",
          ].map((tableName) => transaction.table(tableName).clear()),
        );
      });
    // Version 10 used operationId alone as the proof-operation primary key,
    // so two seed-derived wallets could overwrite each other. This feature is
    // undeployed: discard that incompatible development schema rather than
    // infer or partially preserve cross-table recovery authority.
    this.version(11).stores({
      proofs: null,
      proofOperations: null,
      swapSessions: null,
      swapIntents: null,
      custodyScopes: null,
      custodyScopeStates: null,
      custodyOperations: null,
      custodySessionLinks: null,
      custodyProofReservations: null,
      partialLockFailures: null,
      walletCounters: null,
      pendingLocalWalletPayments: null,
      pendingTrades: null,
    });
    this.version(12).stores({
      proofs:
        "proofId, walletId, [walletId+mintUrl], [walletId+mintUrl+unit+proofClass+selectability+amount], [walletId+conditionId+outcomeCollection], [walletId+mintUrl+conditionId+outcomeCollection], [walletId+reservedBy]",
      proofOperations:
        "[walletId+operationId], walletId, [walletId+state], [walletId+kind], [walletId+mintUrl], [walletId+durableOperationId], [walletId+durableTradeId], updatedAt, custodyOperationId",
      swapSessions:
        "tradeId, walletId, [walletId+active], [walletId+updatedAt]",
      swapIntents:
        "tradeId, walletId, [walletId+updatedAt], [walletId+submitted]",
      custodyScopes: "scopeId, scopeKind, &marketId, &inventoryKey",
      custodyScopeStates: "scopeId",
      custodyOperations:
        "operationId, scopeId, active, [scopeId+operationId], [scopeId+active+operationId]",
      custodySessionLinks:
        "operationId, scopeId, sessionId, &[scopeId+sessionId+operationId]",
      custodyProofReservations:
        "proofId, scopeId, operationId, [scopeId+operationId]",
      partialLockFailures:
        "[walletId+tradeId], walletId, [walletId+refundLocktime], [walletId+createdAt]",
      walletCounters: "[walletId+keysetId], walletId",
      pendingLocalWalletPayments:
        "[walletId+depositId], walletId, [walletId+phase], &[walletId+splitOperationId], [walletId+nextAttemptAt+createdAt+depositId]",
      pendingTrades:
        "[walletId+orderId], walletId, &[walletId+clientOrderId], [walletId+submittedAt]",
    });
    this.version(13).stores({
      proofs:
        "proofId, walletId, [walletId+mintUrl], [walletId+mintUrl+unit+proofClass+selectability+amount], [walletId+conditionId+outcomeCollection], [walletId+mintUrl+conditionId+outcomeCollection], [walletId+reservedBy]",
      proofOperations:
        "[walletId+operationId], walletId, [walletId+state], [walletId+kind], [walletId+mintUrl], [walletId+durableOperationId], [walletId+durableTradeId], updatedAt, custodyOperationId",
      swapSessions:
        "tradeId, walletId, [walletId+active], [walletId+updatedAt]",
      swapIntents:
        "tradeId, walletId, [walletId+updatedAt], [walletId+submitted]",
      custodyScopes: "scopeId, scopeKind, &marketId, &inventoryKey",
      custodyScopeStates: "scopeId",
      custodyOperations:
        "operationId, scopeId, active, [scopeId+operationId], [scopeId+active+operationId]",
      custodySessionLinks:
        "operationId, scopeId, sessionId, &[scopeId+sessionId+operationId]",
      custodyProofReservations:
        "proofId, scopeId, operationId, [scopeId+operationId]",
      partialLockFailures:
        "[walletId+tradeId], walletId, [walletId+refundLocktime], [walletId+createdAt]",
      walletCounters: "[walletId+keysetId], walletId",
      pendingLocalWalletPayments:
        "[walletId+depositId], walletId, [walletId+phase], &[walletId+splitOperationId], [walletId+nextAttemptAt+createdAt+depositId]",
      pendingTrades:
        "[walletId+orderId], walletId, &[walletId+clientOrderId], [walletId+submittedAt]",
      walletActivities:
        "[walletId+id], walletId, [walletId+date], [walletId+type]",
    });
    this.version(14).stores({
      proofs:
        "proofId, walletId, [walletId+mintUrl], [walletId+mintUrl+unit+proofClass+selectability+amount], [walletId+conditionId+outcomeCollection], [walletId+mintUrl+conditionId+outcomeCollection], [walletId+reservedBy]",
      proofOperations:
        "[walletId+operationId], walletId, [walletId+state], [walletId+kind], [walletId+mintUrl], [walletId+durableOperationId], [walletId+durableTradeId], updatedAt, custodyOperationId",
      swapSessions:
        "tradeId, walletId, [walletId+active], [walletId+updatedAt]",
      swapIntents:
        "tradeId, walletId, [walletId+updatedAt], [walletId+submitted]",
      custodyScopes: "scopeId, scopeKind, &marketId, &inventoryKey",
      custodyScopeStates: "scopeId",
      custodyOperations:
        "operationId, scopeId, active, [scopeId+operationId], [scopeId+active+operationId]",
      custodySessionLinks:
        "operationId, scopeId, sessionId, &[scopeId+sessionId+operationId]",
      custodyProofReservations:
        "proofId, scopeId, operationId, [scopeId+operationId]",
      partialLockFailures:
        "[walletId+tradeId], walletId, [walletId+refundLocktime], [walletId+createdAt]",
      walletCounters: "[walletId+keysetId], walletId",
      pendingLocalWalletPayments:
        "[walletId+depositId], walletId, [walletId+phase], &[walletId+splitOperationId], [walletId+nextAttemptAt+createdAt+depositId]",
      pendingTrades:
        "[walletId+orderId], walletId, &[walletId+clientOrderId], [walletId+submittedAt]",
      walletActivities:
        "[walletId+id], walletId, [walletId+date], [walletId+type]",
      durableStorageAccounting: "recordId",
      durableStorageHeadroom: "recordId",
    });
    // This custody schema remains undeployed. Version 15 deliberately drops
    // the incompatible development wallet state instead of inferring the new
    // indexed wallet/trade binding authority from nested records.
    this.version(15)
      .stores({
        custodyOperations:
          "operationId, scopeId, active, bindingKind, [scopeId+operationId], [scopeId+active+operationId]",
      })
      .upgrade(async (transaction) => {
        await Promise.all(
          [
            "proofs",
            "proofOperations",
            "swapSessions",
            "swapIntents",
            "custodyScopes",
            "custodyScopeStates",
            "custodyOperations",
            "custodySessionLinks",
            "custodyProofReservations",
            "partialLockFailures",
            "walletCounters",
            "pendingLocalWalletPayments",
            "pendingTrades",
            "walletActivities",
            "durableStorageAccounting",
            "durableStorageHeadroom",
          ].map((tableName) => transaction.table(tableName).clear()),
        );
      });
    this.on("blocked", () => {
      durableSwapStorageBlockedReason =
        "Durable swap storage upgrade is blocked by another open tab";
      rejectDurableSwapStorageOpen?.(
        new Error(durableSwapStorageBlockedReason),
      );
    });
  }
}

export const db = new BitcasterDB();

/**
 * New protected swaps must not begin unless the IndexedDB recovery store is
 * writable. A blocked schema upgrade or open failure is therefore surfaced
 * before a proof reservation or mint operation can be prepared.
 */
export async function ensureDurableSwapStorage(
  walletId = currentGuiWalletId(),
): Promise<void> {
  requireGuiWalletId(walletId);
  if (durableSwapStorageBlockedReason) {
    throw new Error(durableSwapStorageBlockedReason);
  }
  if (
    durableSwapStorageOpenInFlight &&
    durableSwapStorageOpenWalletId !== walletId
  ) {
    throw new Error("Durable swap storage is opening for another wallet scope");
  }
  if (!durableSwapStorageOpenInFlight) {
    durableSwapStorageOpenWalletId = walletId;
    durableSwapStorageOpenInFlight = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out opening durable swap storage"));
      }, DURABLE_SWAP_STORAGE_OPEN_TIMEOUT_MS);
      rejectDurableSwapStorageOpen = reject;
      void db
        .open()
        .then(
          () => resolve(),
          (error) =>
            reject(error instanceof Error ? error : new Error(String(error))),
        )
        .finally(() => {
          clearTimeout(timeout);
          rejectDurableSwapStorageOpen = null;
        });
    }).finally(() => {
      durableSwapStorageOpenInFlight = null;
      durableSwapStorageOpenWalletId = null;
    });
  }
  try {
    await durableSwapStorageOpenInFlight;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Durable swap storage is unavailable: ${reason}`);
  }
  if (durableSwapStorageBlockedReason) {
    throw new Error(durableSwapStorageBlockedReason);
  }
}

export async function getProofs(
  mintUrl?: string,
  options: { includeReserved?: boolean } = {},
): Promise<StoredProof[]> {
  const walletId = currentGuiWalletId();
  return getProofsForWallet(walletId, mintUrl, options);
}

async function getProofsForWallet(
  walletId: string,
  mintUrl?: string,
  options: { includeReserved?: boolean } = {},
): Promise<StoredProof[]> {
  await ensureDurableSwapStorage(walletId);
  if (mintUrl) {
    const rows = await db.proofs
      .where("[walletId+mintUrl]")
      .equals([walletId, normalizeUrl(mintUrl)])
      .toArray();
    const normalized = rows.map((row) =>
      normalizeStoredProofForStorage(row, walletId),
    );
    return options.includeReserved
      ? normalized
      : normalized.filter((p) => !p.reservedBy);
  }
  const rows = await db.proofs.where("walletId").equals(walletId).toArray();
  const normalized = rows.map((row) =>
    normalizeStoredProofForStorage(row, walletId),
  );
  return options.includeReserved
    ? normalized
    : normalized.filter((p) => !p.reservedBy);
}

/**
 * Return regular proofs grouped by base asset for UI display only.
 * WARNING: this may combine different Cashu units (for example sat + msat)
 * and is unsafe for spend/settlement operations. Use `getUnitProofs` there.
 */
export async function getBaseProofs(
  mintUrl?: string,
  options: { includeReserved?: boolean; baseAsset?: string | null } = {},
): Promise<StoredProof[]> {
  const proofs = await getProofs(mintUrl, {
    includeReserved: options.includeReserved,
  });
  const baseAsset = normalizeMarketBaseAsset(options.baseAsset);
  return proofs.filter(
    (p) => !isCtfProof(p) && normalizeStoredProofBaseAsset(p) === baseAsset,
  );
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
  return proofs.filter(
    (p) => !isCtfProof(p) && normalizeStoredProofUnit(p) === unit,
  );
}

export async function getUnitProofsUnderLock(
  lock: GuiWalletLockContext,
  mintUrl: string | undefined,
  options: { includeReserved?: boolean; unit: CashuProofUnit | string },
): Promise<StoredProof[]> {
  const unit = parseCashuProofUnit(options.unit);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${options.unit}'`);
  const proofs = await getProofsForWallet(
    walletIdFromHeldGuiWalletLock(lock),
    mintUrl,
    { includeReserved: options.includeReserved },
  );
  return proofs.filter(
    (proof) => !isCtfProof(proof) && normalizeStoredProofUnit(proof) === unit,
  );
}

/**
 * Select a bounded regular-proof input set for a new operation. The compound
 * index keeps the scan within one wallet, mint, and Cashu unit; descending
 * denomination order minimizes input count without materializing the wallet's
 * complete proof inventory.
 */
export async function getBoundedUnitProofsForAmountUnderLock(
  lock: GuiWalletLockContext,
  mintUrl: string,
  options: { unit: CashuProofUnit | string; minimumAmount: number },
): Promise<StoredProof[]> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  const unit = parseCashuProofUnit(options.unit);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${options.unit}'`);
  if (
    !Number.isSafeInteger(options.minimumAmount) ||
    options.minimumAmount < 1
  ) {
    throw new Error("Proof selection amount is invalid");
  }
  const normalizedMintUrl = normalizeUrl(mintUrl);
  const rows = await db.proofs
    .where("[walletId+mintUrl+unit+proofClass+selectability+amount]")
    .between(
      [walletId, normalizedMintUrl, unit, "regular", "spendable", Dexie.minKey],
      [walletId, normalizedMintUrl, unit, "regular", "spendable", Dexie.maxKey],
    )
    .reverse()
    .limit(DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX)
    .toArray();
  const selected: StoredProof[] = [];
  let amount = 0;
  for (const row of rows) {
    const proof = normalizeStoredProofForStorage(row, walletId);
    selected.push(proof);
    amount += amountToNumber(proof.amount);
    if (amount >= options.minimumAmount) break;
  }
  return selected;
}

export async function getOutcomeProofs(
  mintUrl: string,
  conditionId: string,
  outcomeCollection: string,
  options: { includeReserved?: boolean; baseAsset?: string | null } = {},
): Promise<StoredProof[]> {
  return getOutcomeProofsForWallet(
    currentGuiWalletId(),
    mintUrl,
    conditionId,
    outcomeCollection,
    options,
  );
}

export async function getOutcomeProofsUnderLock(
  lock: GuiWalletLockContext,
  mintUrl: string,
  conditionId: string,
  outcomeCollection: string,
  options: { includeReserved?: boolean; baseAsset?: string | null } = {},
): Promise<StoredProof[]> {
  return getOutcomeProofsForWallet(
    walletIdFromHeldGuiWalletLock(lock),
    mintUrl,
    conditionId,
    outcomeCollection,
    options,
  );
}

async function getOutcomeProofsForWallet(
  walletId: string,
  mintUrl: string,
  conditionId: string,
  outcomeCollection: string,
  options: { includeReserved?: boolean; baseAsset?: string | null },
): Promise<StoredProof[]> {
  const normalizedMintUrl = normalizeUrl(mintUrl);
  await ensureDurableSwapStorage(walletId);
  const baseAsset = normalizeMarketBaseAsset(options.baseAsset);
  const indexed = await db.proofs
    .where("[walletId+mintUrl+conditionId+outcomeCollection]")
    .equals([walletId, normalizedMintUrl, conditionId, outcomeCollection])
    .toArray();
  if (indexed.length > 0) {
    const normalized = indexed
      .map((row) => normalizeStoredProofForStorage(row, walletId))
      .filter((proof) => normalizeStoredProofBaseAsset(proof) === baseAsset);
    return options.includeReserved
      ? normalized
      : normalized.filter((proof) => !proof.reservedBy);
  }

  const proofs = await getProofsForWallet(walletId, normalizedMintUrl, options);
  return proofs.filter((p) => {
    const candidate = p as StoredProof & {
      condition_id?: string;
      outcome_collection?: string;
    };
    const proofConditionId = candidate.conditionId ?? candidate.condition_id;
    const proofOutcome =
      candidate.outcomeCollection ?? candidate.outcome_collection;
    return (
      proofConditionId === conditionId &&
      proofOutcome === outcomeCollection &&
      normalizeStoredProofBaseAsset(p) === baseAsset
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
  options: { includeReserved?: boolean; baseAsset?: string | null } = {},
): Promise<StoredProof[]> {
  const proofs = await getProofs(mintUrl, options);
  const baseAsset = normalizeMarketBaseAsset(options.baseAsset);
  return proofs.filter((p) => {
    if (!isCtfProof(p)) return false;
    const candidate = p as StoredProof & { condition_id?: string };
    const proofConditionId = candidate.conditionId ?? candidate.condition_id;
    return (
      proofConditionId === conditionId &&
      normalizeStoredProofBaseAsset(p) === baseAsset
    );
  });
}

// Central normalization point — proofs arrive from many receive paths
// (deposit, atomic-swap change, NIP-17 payload) where `mintUrl` may come
// from a decoded token or a raw wallet config. Normalizing on write means
// the balance query (`getProofs(activeMintUrl)`) never has to worry about
// trailing-slash / protocol-case drift.
export async function addProofs(proofs: StoredProof[]): Promise<void> {
  return withGuiProofWriterLock((walletId) =>
    addProofsForWallet(walletId, proofs),
  );
}

async function addProofsForWallet(
  walletId: string,
  proofs: StoredProof[],
): Promise<void> {
  const now = Date.now();
  const stamped = proofs.map((proof) =>
    prepareStoredProofForWrite(proof, now, walletId),
  );
  await db.transaction("rw", db.proofs, async () => {
    const existing = await db.proofs.bulkGet(storedProofIds(stamped));
    assertRowsInWallet(existing, walletId);
    const next = stamped.map((proof, index) => {
      const current = existing[index];
      if (!current) return proof;
      assertSameStoredProofValue(current, proof);
      return requireStoredProofRow(current, walletId);
    });
    await db.proofs.bulkPut(next);
  });
}

export async function removeProofs(
  proofs: readonly StoredProof[],
): Promise<void> {
  return withGuiProofWriterLock((walletId) =>
    removeProofsForWallet(walletId, proofs),
  );
}

async function removeProofsForWallet(
  walletId: string,
  proofs: readonly StoredProof[],
): Promise<void> {
  const proofIds = storedProofIds(proofs);
  await db.transaction("rw", db.proofs, async () => {
    const rows = await db.proofs.bulkGet(proofIds);
    assertRowsMatchProofs(rows, proofs, walletId);
    await db.proofs.bulkDelete(proofIds);
  });
}

export async function replaceProofs(
  spentProofs: readonly StoredProof[],
  freshProofs: StoredProof[],
): Promise<void> {
  return withGuiProofWriterLock((walletId) =>
    replaceProofsForWallet(walletId, spentProofs, freshProofs),
  );
}

async function replaceProofsForWallet(
  walletId: string,
  spentProofs: readonly StoredProof[],
  freshProofs: StoredProof[],
): Promise<void> {
  const spentProofIds = storedProofIds(spentProofs);
  const now = Date.now();
  const stamped = freshProofs.map((proof) =>
    prepareStoredProofForWrite(proof, now, walletId),
  );
  const freshProofIds = storedProofIds(stamped);
  if (freshProofIds.some((proofId) => spentProofIds.includes(proofId))) {
    throw new Error("Stored proof replacement reuses spent authority");
  }
  await db.transaction("rw", db.proofs, async () => {
    const currentSpent = await db.proofs.bulkGet(spentProofIds);
    const currentFresh = await db.proofs.bulkGet(freshProofIds);
    assertRowsMatchProofs(currentSpent, spentProofs, walletId);
    assertRowsInWallet(currentFresh, walletId);
    currentFresh.forEach((row, index) => {
      if (row) assertSameStoredProofValue(row, stamped[index]!);
    });
    if (spentProofIds.length > 0) {
      await db.proofs.bulkDelete(spentProofIds);
    }
    if (stamped.length > 0) {
      await db.proofs.bulkPut(
        stamped.map((proof, index) => currentFresh[index] ?? proof),
      );
    }
  });
}

export async function reserveProofs(
  proofs: readonly StoredProof[],
  reservedBy: string,
): Promise<void> {
  return withGuiProofWriterLock((walletId) =>
    reserveProofsForWallet(walletId, proofs, reservedBy),
  );
}

async function reserveProofsForWallet(
  walletId: string,
  proofs: readonly StoredProof[],
  reservedBy: string,
): Promise<void> {
  const proofIds = storedProofIds(proofs);
  await db.transaction("rw", db.proofs, async () => {
    const rows = await db.proofs.bulkGet(proofIds);
    assertRowsMatchProofs(rows, proofs, walletId);
    await db.proofs.bulkPut(
      rows
        .filter((row): row is StoredProofRow => !!row)
        .map((row) =>
          normalizeStoredProofForStorage(
            withoutDerivedProofFields({ ...row, reservedBy }),
            walletId,
          ),
        ),
    );
  });
}

/**
 * Reserve a previously selected proof set only while every member remains
 * unreserved (or is already owned by this operation). This prevents two
 * concurrent swap flows from spending the same IndexedDB proof pool.
 */
export async function tryReserveProofs(
  proofs: readonly StoredProof[],
  reservedBy: string,
): Promise<boolean> {
  return withGuiProofWriterLock((walletId) =>
    tryReserveProofsForWallet(walletId, proofs, reservedBy),
  );
}

export async function tryReserveProofsUnderLock(
  lock: GuiWalletLockContext,
  proofs: readonly StoredProof[],
  reservedBy: string,
): Promise<boolean> {
  return withHeldGuiProofWriterLock(lock, (walletId) =>
    tryReserveProofsForWallet(walletId, proofs, reservedBy),
  );
}

async function tryReserveProofsForWallet(
  walletId: string,
  proofs: readonly StoredProof[],
  reservedBy: string,
): Promise<boolean> {
  const proofIds = storedProofIds(proofs);
  if (proofIds.length === 0) return true;

  let reserved = false;
  await db.transaction("rw", db.proofs, async () => {
    const rows = await db.proofs.bulkGet(proofIds);
    assertRowsMatchProofs(rows, proofs, walletId, true);
    if (
      rows.some(
        (row) => !row || (row.reservedBy && row.reservedBy !== reservedBy),
      )
    ) {
      return;
    }

    await db.proofs.bulkPut(
      rows.map((row) =>
        normalizeStoredProofForStorage(
          withoutDerivedProofFields({ ...row!, reservedBy }),
          walletId,
        ),
      ),
    );
    reserved = true;
  });

  return reserved;
}

export async function releaseProofReservation(
  reservedBy: string,
): Promise<void> {
  return withGuiProofWriterLock((walletId) =>
    releaseProofReservationForWallet(walletId, reservedBy),
  );
}

export async function releaseProofReservationUnderLock(
  lock: GuiWalletLockContext,
  reservedBy: string,
): Promise<void> {
  return withHeldGuiProofWriterLock(lock, (walletId) =>
    releaseProofReservationForWallet(walletId, reservedBy),
  );
}

async function releaseProofReservationForWallet(
  walletId: string,
  reservedBy: string,
): Promise<void> {
  const rows = await db.proofs
    .where("[walletId+reservedBy]")
    .equals([walletId, reservedBy])
    .toArray();
  if (rows.length === 0) return;
  await db.proofs.bulkPut(
    rows.map((row) =>
      normalizeStoredProofForStorage(
        withoutDerivedProofFields({ ...row, reservedBy: undefined }),
        walletId,
      ),
    ),
  );
}

export async function releaseProofReservations(
  proofs: readonly StoredProof[],
): Promise<void> {
  return withGuiProofWriterLock((walletId) =>
    releaseProofReservationsForWallet(walletId, proofs),
  );
}

async function releaseProofReservationsForWallet(
  walletId: string,
  proofs: readonly StoredProof[],
): Promise<void> {
  const rows = await db.proofs.bulkGet(storedProofIds(proofs));
  assertRowsMatchProofs(rows, proofs, walletId);
  const changed = rows
    .filter((row): row is StoredProofRow => !!row)
    .map((row) =>
      normalizeStoredProofForStorage(
        withoutDerivedProofFields({ ...row, reservedBy: undefined }),
        walletId,
      ),
    );
  if (changed.length === 0) return;
  await db.proofs.bulkPut(changed);
}

export async function getReservedProofs(
  reservedBy: string,
): Promise<StoredProof[]> {
  const walletId = currentGuiWalletId();
  return getReservedProofsForWallet(walletId, reservedBy);
}

export async function getReservedProofsUnderLock(
  lock: GuiWalletLockContext,
  reservedBy: string,
): Promise<StoredProof[]> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  return getReservedProofsForWallet(walletId, reservedBy);
}

async function getReservedProofsForWallet(
  walletId: string,
  reservedBy: string,
): Promise<StoredProof[]> {
  await ensureDurableSwapStorage(walletId);
  const rows = await db.proofs
    .where("[walletId+reservedBy]")
    .equals([walletId, reservedBy])
    .toArray();
  return rows.map((row) => normalizeStoredProofForStorage(row, walletId));
}

function assertRowsInWallet(
  rows: readonly (StoredProofRow | undefined)[],
  walletId: string,
): void {
  for (const row of rows) {
    if (row !== undefined) requireStoredProofRow(row, walletId);
  }
}

function assertRowsMatchProofs(
  rows: readonly (StoredProofRow | undefined)[],
  proofs: readonly StoredProof[],
  walletId: string,
  allowMissing = false,
): void {
  assertRowsInWallet(rows, walletId);
  rows.forEach((row, index) => {
    if (!row) {
      if (!allowMissing) throw new Error("Stored proof authority is missing");
      return;
    }
    assertSameStoredProofValue(row, proofs[index]!);
  });
}

function assertSameStoredProofValue(
  actual: StoredProofRow,
  expected: StoredProof,
): void {
  if (
    actual.proofId !== deriveStoredProofId(expected) ||
    !sameCashuProofArtifact(actual, expected) ||
    actual.mintUrl !== normalizeUrl(expected.mintUrl) ||
    actual.unit !== parseCashuProofUnit(expected.unit) ||
    actual.baseAsset !== normalizeStoredProofBaseAsset(expected) ||
    actual.conditionId !== expected.conditionId ||
    actual.outcomeCollection !== expected.outcomeCollection ||
    actual.marketId !== expected.marketId
  ) {
    throw new Error("Stored proof conflicts with existing authority");
  }
}

export function deriveStoredProofId(
  proof: Pick<StoredProof, "id" | "mintUrl" | "secret" | "unit">,
): string {
  const unit = parseCashuProofUnit(proof.unit);
  if (
    !unit ||
    typeof proof.id !== "string" ||
    proof.id.length === 0 ||
    typeof proof.secret !== "string" ||
    proof.secret.length === 0
  ) {
    throw new Error("Stored proof identity is invalid");
  }
  try {
    return deriveDurableCustodyProofId({
      normalizedMint: normalizeUrl(proof.mintUrl),
      unit,
      keysetId: proof.id,
      secret: proof.secret,
    });
  } catch {
    throw new Error("Stored proof identity is invalid");
  }
}

export function storedProofIds(
  proofs: readonly Pick<StoredProof, "id" | "mintUrl" | "secret" | "unit">[],
): string[] {
  const ids = proofs.map(deriveStoredProofId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Stored proof set contains duplicate authority");
  }
  return ids;
}

export function locateStoredProofs(
  proofs: readonly {
    id?: string;
    amount: unknown;
    secret: string;
    C: string;
  }[],
  mintUrl: string,
  unitValue: CashuProofUnit | string | undefined,
): StoredProof[] {
  const unit = parseCashuProofUnit(unitValue);
  if (!unit) throw new Error("Stored proof set has no supported Cashu unit");
  const normalizedMint = normalizeUrl(mintUrl);
  return proofs.map((proof) => {
    if (!proof.id) throw new Error("Stored proof identity is invalid");
    return {
      ...proof,
      id: proof.id,
      amount: proof.amount as Proof["amount"],
      mintUrl: normalizedMint,
      unit,
    };
  });
}

export function requireStoredProofRow(
  proof: StoredProofRow,
  walletId = currentGuiWalletId(),
): StoredProofRow {
  requireGuiWalletId(walletId);
  if (proof.walletId !== walletId) {
    throw new Error("Stored proof belongs to another wallet scope");
  }
  if (!isProof(proof, walletId, proof.mintUrl)) {
    throw new Error("Stored proof identity is invalid");
  }
  const unit = parseCashuProofUnit(proof.unit);
  const amount = amountToNumber(proof.amount);
  const expectedProofId = deriveStoredProofId(proof);
  const expectedProofClass = deriveStoredProofClass(proof);
  const expectedSelectability = deriveStoredProofSelectability(proof);
  if (
    proof.proofId !== expectedProofId ||
    !unit ||
    typeof proof.baseAsset !== "string" ||
    proof.baseAsset.length === 0 ||
    typeof proof.receivedAt !== "number" ||
    !Number.isSafeInteger(proof.receivedAt) ||
    proof.receivedAt < 0 ||
    typeof proof.C !== "string" ||
    proof.C.length === 0 ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    proof.mintUrl !== normalizeUrl(proof.mintUrl) ||
    parseMarketBaseAsset(proof.baseAsset) !== proof.baseAsset ||
    COLLATERAL_UNIT_REGISTRY[unit].baseAsset !== proof.baseAsset ||
    !hasValidProofClassificationAuthority(proof) ||
    (proof.reservedBy !== undefined &&
      (typeof proof.reservedBy !== "string" ||
        proof.reservedBy.length === 0 ||
        proof.reservedBy.length > 512)) ||
    proof.proofClass !== expectedProofClass ||
    proof.selectability !== expectedSelectability
  ) {
    throw new Error("Stored proof identity is invalid");
  }
  const result: StoredProofRow = {
    ...proof,
    amount: amount as never,
    unit,
  };
  createGuiDurableStorageRowArtifact({
    table: "proofs",
    key: result.proofId,
    artifactRole: "proof-post-image",
    row: result,
  });
  return result;
}

export function normalizeStoredProofForStorage(
  proof: StoredProof,
  walletId = currentGuiWalletId(),
): StoredProofRow {
  requireGuiWalletId(walletId);
  if (proof.walletId !== undefined && proof.walletId !== walletId) {
    throw new Error("Stored proof belongs to another wallet scope");
  }
  const unit = normalizeStoredProofUnit(proof);
  const proofClass = deriveStoredProofClass(proof);
  const selectability = deriveStoredProofSelectability(proof);
  assertSuppliedDerivedProofFields(proof, proofClass, selectability);
  if (
    !unit ||
    proof.receivedAt === undefined ||
    !Number.isSafeInteger(proof.receivedAt) ||
    proof.receivedAt < 0
  ) {
    throw new Error("Stored proof identity is invalid");
  }
  const normalized: StoredProofRow = {
    ...proof,
    proofId: deriveStoredProofId({ ...proof, unit }),
    walletId,
    amount: amountToNumber(proof.amount) as never,
    mintUrl: normalizeUrl(proof.mintUrl),
    baseAsset: normalizeStoredProofBaseAsset({ ...proof, unit }),
    unit,
    receivedAt: proof.receivedAt,
    proofClass,
    selectability,
  };
  if (proof.proofId !== undefined && proof.proofId !== normalized.proofId) {
    throw new Error("Stored proof identity is invalid");
  }
  return requireStoredProofRow(normalized, walletId);
}

function deriveStoredProofClass(proof: StoredProof): StoredProofClass {
  return isCtfProof(proof) ? "ctf" : "regular";
}

function hasValidProofClassificationAuthority(proof: StoredProof): boolean {
  return hasValidCtfMetadataRelation(
    proof as unknown as Record<string, unknown>,
  );
}

function deriveStoredProofSelectability(
  proof: StoredProof,
): StoredProofSelectability {
  return proof.reservedBy === undefined ? "spendable" : "reserved";
}

function assertSuppliedDerivedProofFields(
  proof: StoredProof,
  proofClass: StoredProofClass,
  selectability: StoredProofSelectability,
): void {
  if (
    (proof.proofClass !== undefined && proof.proofClass !== proofClass) ||
    (proof.selectability !== undefined && proof.selectability !== selectability)
  ) {
    throw new Error("Stored proof classification is invalid");
  }
}

function withoutDerivedProofFields(proof: StoredProof): StoredProof {
  const {
    proofClass: _proofClass,
    selectability: _selectability,
    ...authority
  } = proof;
  return authority;
}

export function prepareStoredProofForWrite(
  proof: StoredProof,
  now = Date.now(),
  walletId = currentGuiWalletId(),
): StoredProofRow {
  return normalizeStoredProofForStorage(
    withoutDerivedProofFields({
      ...validateStoredProofUnitInvariant(proof),
      receivedAt: proof.receivedAt ?? now,
    }),
    walletId,
  );
}

function normalizeStoredProofBaseAsset(proof: StoredProof): string {
  const unit = parseCashuProofUnit(proof.unit);
  if (unit && !proof.baseAsset) return COLLATERAL_UNIT_REGISTRY[unit].baseAsset;
  const baseAsset = parseMarketBaseAsset(proof.baseAsset);
  if (!baseAsset) throw new Error("Stored proof base asset is invalid");
  return baseAsset;
}

export function normalizeStoredProofUnit(
  proof: StoredProof,
): CashuProofUnit | undefined {
  return parseCashuProofUnit(proof.unit) ?? undefined;
}

function validateStoredProofUnitInvariant(proof: StoredProof): StoredProof {
  const unit = parseCashuProofUnit(proof.unit);
  if (!unit) throw new Error("Stored proof has no supported Cashu unit");
  const unitInfo = COLLATERAL_UNIT_REGISTRY[unit];
  const baseAsset = proof.baseAsset
    ? parseMarketBaseAsset(proof.baseAsset)
    : unitInfo.baseAsset;
  if (unitInfo.baseAsset !== baseAsset) {
    throw new Error("Stored proof unit is incompatible with its base asset");
  }
  return proof;
}

export async function getProofOperation(
  operationId: string,
): Promise<ProofOperationRecord | null> {
  const walletId = currentGuiWalletId();
  return getProofOperationForWallet(walletId, operationId);
}

export async function getProofOperationUnderLock(
  lock: GuiWalletLockContext,
  operationId: string,
): Promise<ProofOperationRecord | null> {
  return getProofOperationForWallet(
    walletIdFromHeldGuiWalletLock(lock),
    operationId,
  );
}

export async function getProofOperationForWallet(
  walletId: string,
  operationId: string,
): Promise<ProofOperationRecord | null> {
  await ensureDurableSwapStorage(walletId);
  const row = await db.proofOperations.get(
    proofOperationPrimaryKey(walletId, operationId),
  );
  if (!row) return null;
  return requireProofOperationRecord(row, walletId, operationId);
}

export function proofOperationPrimaryKey(
  walletId: unknown,
  operationId: unknown,
): ProofOperationPrimaryKey {
  return [requireGuiWalletId(walletId), requireProofOperationId(operationId)];
}

export function requireProofOperationRecord(
  value: unknown,
  expectedWalletId?: string,
  expectedOperationId?: string,
): ProofOperationRecord {
  if (!isRecord(value)) throw new Error("Stored proof operation is invalid");
  if (!hasProofOperationRecordFields(value)) {
    throw new Error("Stored proof operation is invalid");
  }
  const walletId = requireGuiWalletId(value.walletId);
  const operationId = requireProofOperationId(value.operationId);
  if (
    (expectedWalletId !== undefined && walletId !== expectedWalletId) ||
    (expectedOperationId !== undefined && operationId !== expectedOperationId)
  ) {
    throw new Error("Proof operation belongs to another wallet scope");
  }
  requireProofOperationScalarFields(value);
  requireProofOperationArtifacts(value, walletId);
  if (!hasValidProofOperationLifecycle(value)) {
    throw invalidProofOperation("lifecycle");
  }
  const durableLink = value.durableTradeRecovery;
  if (!hasValidProofOperationLink(value, durableLink, operationId)) {
    throw new Error("Stored proof operation recovery binding is invalid");
  }
  const result = value as unknown as ProofOperationRecord;
  createGuiDurableStorageRowArtifact({
    table: "proofOperations",
    key: [walletId, operationId],
    artifactRole: "exact-operation",
    row: result,
  });
  return result;
}

function requireProofOperationScalarFields(
  value: Record<string, unknown>,
): void {
  if (!isProofOperationKind(value.kind)) throw invalidProofOperation("kind");
  if (!isProofOperationState(value.state)) throw invalidProofOperation("state");
  if (!isNormalizedMintUrl(value.mintUrl))
    throw invalidProofOperation("mint URL");
  if (!isOptionalNonNegativeInteger(value.failureCode)) {
    throw invalidProofOperation("failure code");
  }
  if (
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    throw invalidProofOperation("timestamps");
  }
  if (
    !isOptionalIdentifier(value.durableOperationId) ||
    !isOptionalIdentifier(value.durableTradeId) ||
    !isIdentifier(value.custodyOperationId)
  ) {
    throw invalidProofOperation("operation identity");
  }
}

function requireProofOperationArtifacts(
  value: Record<string, unknown>,
  walletId: string,
): void {
  if (!isProofArray(value.inputs, walletId, value.mintUrl as string)) {
    throw invalidProofOperation("inputs");
  }
  if (!isOutputGroups(value.outputs)) throw invalidProofOperation("outputs");
  if (!isRecord(value.metadata) || !isMetadataUnitValid(value.metadata)) {
    throw invalidProofOperation("metadata");
  }
  if (
    value.resultProofs !== undefined &&
    !isProofGroups(value.resultProofs, walletId, value.mintUrl as string)
  ) {
    throw invalidProofOperation("result proofs");
  }
  if (value.lastError !== null && typeof value.lastError !== "string") {
    throw invalidProofOperation("last error");
  }
}

function invalidProofOperation(reason: string): Error {
  return new Error(`Stored proof operation is invalid: ${reason}`);
}

const PROOF_OPERATION_RECORD_FIELDS = [
  "walletId",
  "operationId",
  "durableTradeRecovery",
  "durableOperationId",
  "custodyOperationId",
  "durableTradeId",
  "kind",
  "state",
  "mintUrl",
  "inputs",
  "outputs",
  "metadata",
  "resultProofs",
  "lastError",
  "failureCode",
  "createdAt",
  "updatedAt",
] as const;

const REQUIRED_PROOF_OPERATION_RECORD_FIELDS = [
  "walletId",
  "operationId",
  "custodyOperationId",
  "kind",
  "state",
  "mintUrl",
  "inputs",
  "outputs",
  "metadata",
  "lastError",
  "createdAt",
  "updatedAt",
] as const;

function hasProofOperationRecordFields(
  value: Record<string, unknown>,
): boolean {
  return (
    hasOnlyKnownFields(value, PROOF_OPERATION_RECORD_FIELDS) &&
    REQUIRED_PROOF_OPERATION_RECORD_FIELDS.every((field) => field in value)
  );
}

function hasValidProofOperationLifecycle(
  value: Record<string, unknown>,
): boolean {
  switch (value.state) {
    case "prepared":
    case "mint-submitted":
      return value.lastError === null && value.failureCode === undefined;
    case "completed":
      return (
        value.resultProofs !== undefined &&
        value.lastError === null &&
        value.failureCode === undefined
      );
    case "Failed":
      return (
        value.resultProofs === undefined &&
        typeof value.lastError === "string" &&
        isNonNegativeInteger(value.failureCode)
      );
    default:
      return false;
  }
}

function hasValidProofOperationLink(
  value: Record<string, unknown>,
  link: unknown,
  operationId: string,
): boolean {
  if (link === undefined) {
    return (
      value.durableOperationId === undefined &&
      value.durableTradeId === undefined
    );
  }
  const durableLink = link as DurableTradeProofOperationLink;
  return (
    validateDurableProofOperationLink(durableLink) === null &&
    durableLink.operationKey === operationId &&
    value.durableOperationId === durableLink.operationId &&
    value.durableTradeId === durableLink.tradeId &&
    durableLink.state === durableLinkState(value.state)
  );
}

function durableLinkState(value: unknown): string | null {
  switch (value) {
    case "prepared":
      return "prepared";
    case "mint-submitted":
      return "mint-submitted";
    case "completed":
      return "reconciled";
    case "Failed":
    default:
      return null;
  }
}

function requireProofOperationId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("Stored proof operation id is invalid");
  }
  return value;
}

function isProofOperationKind(value: unknown): value is ProofOperationKind {
  return (
    value === "swap-lock" ||
    value === "swap-claim" ||
    value === "conditional-keyset-swap" ||
    value === "swap-refund" ||
    value === "ctf-split" ||
    value === "ctf-merge" ||
    value === "ctf-redeem" ||
    value === "ctf-condition-registration" ||
    value === "regular-split" ||
    value === "proof-split" ||
    value === "wallet-mint" ||
    value === "wallet-receive"
  );
}

function isProofOperationState(value: unknown): value is ProofOperationState {
  return (
    value === "prepared" ||
    value === "mint-submitted" ||
    value === "completed" ||
    value === "Failed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROOF_FIELDS = [
  "id",
  "amount",
  "secret",
  "C",
  "dleq",
  "p2pk_e",
  "witness",
  "proofId",
  "walletId",
  "mintUrl",
  "reservedBy",
  "conditionId",
  "condition_id",
  "outcomeCollection",
  "outcome_collection",
  "marketId",
  "baseAsset",
  "unit",
  "receivedAt",
  "proofClass",
  "selectability",
] as const;

function isProofArray(
  value: unknown,
  walletId: string,
  mintUrl: string,
): boolean {
  if (!Array.isArray(value)) return false;
  const proofs = value.filter((proof) => isProof(proof, walletId, mintUrl));
  return (
    proofs.length === value.length &&
    new Set(proofs.map((proof) => proof.secret)).size === proofs.length
  );
}

function isProofGroups(
  value: unknown,
  walletId: string,
  mintUrl: string,
): boolean {
  if (!isRecord(value)) return false;
  const groups = Object.entries(value);
  if (
    !groups.every(
      ([label, proofs]) => isGroupLabel(label) && Array.isArray(proofs),
    )
  ) {
    return false;
  }
  const proofs = groups.flatMap(([, items]) => items as unknown[]);
  return (
    proofs.every((proof) => isProof(proof, walletId, mintUrl)) &&
    new Set(proofs.map((proof) => (proof as Record<string, unknown>).secret))
      .size === proofs.length
  );
}

function isProof(
  value: unknown,
  walletId?: string,
  mintUrl?: string,
): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKnownFields(value, PROOF_FIELDS))
    return false;
  return (
    isStrictCashuProofArtifact(projectCashuProofArtifact(value)) &&
    hasValidStoredProofExtensions(value, walletId, mintUrl)
  );
}

function projectCashuProofArtifact(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: value.id,
    amount: value.amount,
    secret: value.secret,
    C: value.C,
    ...(Object.hasOwn(value, "dleq") ? { dleq: value.dleq } : {}),
    ...(Object.hasOwn(value, "p2pk_e") ? { p2pk_e: value.p2pk_e } : {}),
    ...(Object.hasOwn(value, "witness") ? { witness: value.witness } : {}),
  };
}

function hasValidStoredProofExtensions(
  proof: Record<string, unknown>,
  walletId?: string,
  mintUrl?: string,
): boolean {
  if (
    !isOptionalIdentifier(proof.reservedBy) ||
    !isOptionalIdentifier(proof.conditionId) ||
    !isOptionalIdentifier(proof.condition_id) ||
    !isOptionalIdentifier(proof.outcomeCollection) ||
    !isOptionalIdentifier(proof.outcome_collection) ||
    !isOptionalIdentifier(proof.marketId) ||
    !isOptionalTimestamp(proof.receivedAt)
  ) {
    return false;
  }
  if (!hasValidStoredProofIdentityFields(proof, walletId, mintUrl))
    return false;
  return hasValidStoredProofClassification(proof);
}

function hasValidStoredProofIdentityFields(
  proof: Record<string, unknown>,
  walletId?: string,
  mintUrl?: string,
): boolean {
  const unit =
    proof.unit === undefined || typeof proof.unit !== "string"
      ? undefined
      : (parseCashuProofUnit(proof.unit) ?? undefined);
  const baseAsset =
    proof.baseAsset === undefined || typeof proof.baseAsset !== "string"
      ? undefined
      : (parseMarketBaseAsset(proof.baseAsset) ?? undefined);
  if (
    (proof.walletId !== undefined && proof.walletId !== walletId) ||
    (proof.mintUrl !== undefined &&
      (!isNormalizedMintUrl(proof.mintUrl) || proof.mintUrl !== mintUrl)) ||
    (proof.unit !== undefined && unit !== proof.unit) ||
    (proof.baseAsset !== undefined && baseAsset !== proof.baseAsset) ||
    (unit !== undefined &&
      baseAsset !== undefined &&
      COLLATERAL_UNIT_REGISTRY[unit].baseAsset !== baseAsset)
  ) {
    return false;
  }
  return proof.proofId === undefined || hasValidStoredProofId(proof, unit);
}

function hasValidStoredProofId(
  proof: Record<string, unknown>,
  unit: CashuProofUnit | undefined,
): boolean {
  if (
    !isLowerHex(proof.proofId, 64) ||
    !unit ||
    typeof proof.mintUrl !== "string"
  ) {
    return false;
  }
  try {
    return (
      proof.proofId ===
      deriveStoredProofId({
        id: proof.id as string,
        secret: proof.secret as string,
        mintUrl: proof.mintUrl,
        unit,
      })
    );
  } catch {
    return false;
  }
}

function hasValidStoredProofClassification(
  proof: Record<string, unknown>,
): boolean {
  if (!hasValidCtfMetadataRelation(proof)) return false;
  const conditionId = proof.conditionId ?? proof.condition_id;
  const outcomeCollection = proof.outcomeCollection ?? proof.outcome_collection;
  const expectedClass =
    conditionId !== undefined || outcomeCollection !== undefined
      ? "ctf"
      : "regular";
  const expectedSelectability =
    proof.reservedBy === undefined ? "spendable" : "reserved";
  return (
    (proof.proofClass === undefined || proof.proofClass === expectedClass) &&
    (proof.selectability === undefined ||
      proof.selectability === expectedSelectability)
  );
}

function hasValidCtfMetadataRelation(proof: Record<string, unknown>): boolean {
  const fields = [
    "conditionId",
    "condition_id",
    "outcomeCollection",
    "outcome_collection",
    "marketId",
  ] as const;
  const present = fields.filter((field) => Object.hasOwn(proof, field));
  if (present.length === 0) return true;
  if (present.some((field) => !isIdentifier(proof[field]))) return false;
  if (
    (Object.hasOwn(proof, "conditionId") &&
      Object.hasOwn(proof, "condition_id") &&
      proof.conditionId !== proof.condition_id) ||
    (Object.hasOwn(proof, "outcomeCollection") &&
      Object.hasOwn(proof, "outcome_collection") &&
      proof.outcomeCollection !== proof.outcome_collection)
  ) {
    return false;
  }
  const conditionId = proof.conditionId ?? proof.condition_id;
  const outcomeCollection = proof.outcomeCollection ?? proof.outcome_collection;
  return (
    isIdentifier(conditionId) &&
    isIdentifier(outcomeCollection) &&
    isIdentifier(proof.marketId) &&
    proof.marketId === `${conditionId}-${outcomeCollection}`
  );
}

const OUTPUT_FIELDS = [
  "blindedMessage",
  "blindingFactor",
  "secret",
  "ephemeralE",
] as const;

function isOutputGroups(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const groups = Object.entries(value);
  if (
    !groups.every(
      ([label, outputs]) => isGroupLabel(label) && Array.isArray(outputs),
    )
  ) {
    return false;
  }
  const outputs = groups.flatMap(([, items]) => items as unknown[]);
  return (
    outputs.every(isStoredOutput) &&
    new Set(outputs.map((output) => (output as Record<string, unknown>).secret))
      .size === outputs.length
  );
}

function isStoredOutput(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKnownFields(value, OUTPUT_FIELDS) &&
    hasRequiredFields(value, ["blindedMessage", "blindingFactor", "secret"]) &&
    isBlindedMessage(value.blindedMessage) &&
    isLowerHexText(value.blindingFactor, 512) &&
    isLowerHexText(value.secret, 2_048) &&
    isOptionalPoint(value.ephemeralE, [66])
  );
}

function isBlindedMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactFields(value, ["amount", "id", "B_"]) &&
    isNonNegativeInteger(value.amount) &&
    isIdentifier(value.id) &&
    isPoint(value.B_, [66, 96])
  );
}

function isMetadataUnitValid(metadata: Record<string, unknown>): boolean {
  return (
    metadata.unit === undefined ||
    (typeof metadata.unit === "string" &&
      parseCashuProofUnit(metadata.unit) === metadata.unit)
  );
}

function isGroupLabel(value: string): boolean {
  return value.length > 0 && value.length <= 512;
}

function hasOnlyKnownFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return Object.keys(value).every((field) => fields.includes(field));
}

function hasRequiredFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => field in value);
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return (
    Object.keys(value).length === fields.length &&
    hasRequiredFields(value, fields)
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function isLowerHexText(value: unknown, maximumLength: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.length % 2 === 0 &&
    /^[a-f0-9]+$/.test(value)
  );
}

function isLowerHex(value: unknown, length: number): boolean {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[a-f0-9]+$/.test(value)
  );
}

function isPoint(value: unknown, lengths: readonly number[]): boolean {
  return (
    typeof value === "string" &&
    lengths.includes(value.length) &&
    /^[a-f0-9]+$/.test(value)
  );
}

function isOptionalPoint(value: unknown, lengths: readonly number[]): boolean {
  return value === undefined || isPoint(value, lengths);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

function isOptionalIdentifier(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.length > 0 && value.length <= 512)
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function isNormalizedMintUrl(value: unknown): value is string {
  if (typeof value !== "string" || normalizeUrl(value) !== value) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
