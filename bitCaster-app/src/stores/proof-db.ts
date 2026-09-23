import Dexie, { type Table } from "dexie";
import type { DurableBolt11MintQuote } from "@bitcaster/client-sdk/durableBolt11MintQuote";
import {
  decodeDurableOutgoingCashuTransfer,
  type DurableOutgoingCashuTransfer,
} from "@bitcaster/client-sdk/durableOutgoingCashuTransfer";
import {
  decodeDurableCustodyProofMaterialRecord,
  deserializeDurableCustodyProofArtifact,
} from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { Amount, type Proof } from "@cashu/cashu-ts";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  decodeDurableCustodyScopeId,
  deriveDurableCustodyArtifactFingerprint,
} from "@bitcaster/client-sdk/durableCustody";
import {
  COLLATERAL_UNIT_REGISTRY,
  parseMarketDivisibility,
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
  type CashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import { deriveMarketFundingProductBinding } from "@bitcaster/client-sdk/marketFundingDelivery";
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
import { decodeBrowserCustodyProofRow } from "./durable-custody-types";
import type { BrowserProofBackupAuthorityTableRow } from "./browser-proof-backup-authority";
import type { EncryptedWalletBackupAccountOperationResultRecord } from "@bitcaster/client-sdk/encryptedWalletBackupEnrollment";
import {
  BrowserWalletCounterDexieStore,
  type BrowserWalletCounterAdvanceResult,
} from "./browser-wallet-counter-db";
import type { EncryptedWalletBackupV2DesiredAssetRow } from "./browser-encrypted-wallet-backup-v2-desired-asset";
import type {
  TargetedAssetRecoveryAttemptKey,
  TargetedAssetRecoveryCompletedOutcome,
} from "@bitcaster/client-sdk/targetedAssetRecovery";

/** The latest authenticated enrollment lifecycle receipt for one wallet. */
export interface EncryptedWalletBackupDexieEnrollmentResultRow {
  realm: string;
  walletId: string;
  record: EncryptedWalletBackupAccountOperationResultRecord;
}

/** One durable retry schedule for one wallet scope and encrypted-backup wallet. */
export interface EncryptedWalletBackupDexieRetrySchedulerRow {
  scopeId: string;
  realm: string;
  walletId: string;
  attemptId: string;
  retryStreak: number;
  retryNotBeforeUnixMilliseconds: number;
}

/** One authoritative NUT-13 allocation cursor for one wallet scope and keyset. */
export interface BrowserWalletCounterCursorRow {
  scopeId: string;
  keysetId: string;
  next: number;
}

/** One normalized mint and unit context that uses an authoritative keyset cursor. */
export interface BrowserWalletCounterAssociationRow {
  scopeId: string;
  normalizedMint: string;
  unit: CashuProofUnit;
  keysetId: string;
  recoveryComplete: boolean;
}

/** One immutable prepared V2 mutation for one scoped wallet authority. */
export interface EncryptedWalletBackupV2PreparedMutationRow {
  scopeId: string;
  realm: string;
  walletId: string;
  enrollmentEpoch: number;
  mutationId: string;
  requestDigest: string;
  canonicalUploadGroup: Uint8Array;
  createdAtUnixMilliseconds: number;
  localAssetKey: string;
  assetLocator: string;
  custodyRevision: string;
  desiredAction: "replace" | "remove";
  activeProofCount: number;
}

/** One accepted V2 current head for one scoped wallet authority. */
export interface EncryptedWalletBackupV2AcceptedHeadRow {
  scopeId: string;
  realm: string;
  walletId: string;
  enrollmentEpoch: number;
  headVersion: number;
  activeBundleCount: number;
  activeObjectCount: number;
  activeSetDigest: string;
  canonicalCurrentHead: Uint8Array;
  localRecoveryStatus: "ready" | "recovery-required";
  localRecoveryReason: "none" | "genuine-conflict";
  localRecoveryVersion: number;
}

/** One current verified V2 receipt for one opaque local asset. */
export interface EncryptedWalletBackupV2AssetReceiptRow {
  scopeId: string;
  realm: string;
  walletId: string;
  enrollmentEpoch: number;
  localAssetKey: string;
  assetLocator: string;
  custodyRevision: string;
  bundleId: string;
  bundleDescriptorDigest: string;
  canonicalSignedMutation: Uint8Array;
  canonicalSignedReceipt: Uint8Array;
}

/** One active V2 bundle descriptor for one scoped wallet authority. */
export interface EncryptedWalletBackupV2ActiveDescriptorRow {
  scopeId: string;
  realm: string;
  walletId: string;
  enrollmentEpoch: number;
  bundleId: string;
  assetLocator: string;
  declaredAmount: string;
  custodyRevision: string;
  payloadCommitment: string;
  objectCount: number;
  canonicalDescriptor: Uint8Array;
}

/** One completed automatic recovery attempt for one exact authority tuple. */
export interface BrowserTargetedAssetRecoveryAttemptRow extends TargetedAssetRecoveryAttemptKey {
  outcome: TargetedAssetRecoveryCompletedOutcome;
  completedAtUnixMilliseconds: number;
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
  | "conditional-keyset-swap"
  | "ctf-range-refund"
  | "ctf-split"
  | "ctf-merge"
  | "ctf-consolidation"
  | "proof-consolidation"
  | "ctf-redeem"
  | "ctf-condition-registration"
  | "wallet-send"
  | "regular-split"
  | "proof-split"
  | "wallet-mint";
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

/**
 * One browser-local mint quote authority. `quote` is the SDK-owned record.
 * The indexed fields duplicate only its identity and current recovery state.
 */
export interface BrowserMintQuoteRow {
  scopeId: string;
  paymentMethod: "bolt11";
  quoteRecordId: string;
  observedState: "UNPAID" | "PAID" | "ISSUED";
  recoveryState: "pending" | "completed";
  lastRecoveryAttemptAtMs: number;
  quote: DurableBolt11MintQuote;
}

/** Local-only bearer authority. This table is deliberately not part of proof backup. */
export interface BrowserOutgoingCashuTransferRow {
  scopeId: string;
  mintUrl: string;
  /** Derived from transfer state. Only `pending` rows require mint recovery. */
  mintRecoveryState: "pending" | "complete";
  /** Derived from transfer state. Nonterminal authority blocks seed handoff. */
  localAuthorityState: "nonterminal" | "terminal";
  /** Indexed only for one explicit bearer-withdrawal resume lookup. */
  bearerMintUrl: string | null;
  dueAtMs: number;
  transferId: string;
  /** A durable-recipient product binding enables one bounded product resume lookup. */
  recipientBinding: string | null;
  /**
   * The indexed predecessor relation for a durable-recipient transfer.
   * The empty string is reserved for the first transfer in a sequence.
   * Unsequenced transfers omit this property so they do not enter the index.
   */
  predecessorKey?: string;
  /** Reserved records have a matching local-only physical admission row. */
  admissionState: "reserved" | "consumed";
  transfer: DurableOutgoingCashuTransfer;
}

/** One scoped market-funding sequence head. This row is coordination state only. */
export interface BrowserMarketFundingHeadRow {
  scopeId: string;
  recipientBinding: string;
  transferId: string;
  revision: number;
  mintUrl: string;
  unit: string;
  accountSubject: string;
  conditionId: string;
  divisibility: number;
}

/** Derive the indexed predecessor component. Undefined excludes unsequenced rows from the index. */
export function browserOutgoingPredecessorKey(
  transfer: DurableOutgoingCashuTransfer,
): string | undefined {
  const sequence = transfer.recipientSequence;
  if (sequence === null) return undefined;
  return sequence.predecessorTransferId ?? "";
}

/** Validate one outgoing row and its derived indexes before a browser write. */
export function decodeBrowserOutgoingCashuTransferRow(
  scopeId: string,
  row: BrowserOutgoingCashuTransferRow,
): DurableOutgoingCashuTransfer {
  const transfer = decodeDurableOutgoingCashuTransfer(row.transfer);
  const expectedPredecessorKey = browserOutgoingPredecessorKey(transfer);
  const expectedRowKeys = [
    "admissionState",
    "bearerMintUrl",
    "dueAtMs",
    "localAuthorityState",
    "mintRecoveryState",
    "mintUrl",
    "recipientBinding",
    "scopeId",
    "transfer",
    "transferId",
    ...(expectedPredecessorKey === undefined ? [] : ["predecessorKey"]),
  ].sort();
  const actualRowKeys = Object.keys(row).sort();
  if (
    actualRowKeys.length !== expectedRowKeys.length ||
    actualRowKeys.some((key, index) => key !== expectedRowKeys[index]) ||
    row.scopeId !== scopeId ||
    row.transferId !== transfer.transferId ||
    row.mintUrl !== transfer.mintUrl ||
    row.mintRecoveryState !== browserOutgoingMintRecoveryState(transfer) ||
    row.localAuthorityState !== browserOutgoingLocalAuthorityState(transfer) ||
    row.bearerMintUrl !== browserOutgoingBearerMintUrl(transfer) ||
    row.dueAtMs !== transfer.recovery.dueAtMs ||
    row.recipientBinding !== browserOutgoingRecipientBinding(transfer) ||
    (expectedPredecessorKey === undefined
      ? row.predecessorKey !== undefined
      : row.predecessorKey !== expectedPredecessorKey) ||
    (row.admissionState !== "reserved" && row.admissionState !== "consumed") ||
    transfer.walletScopeId !== scopeId
  ) {
    throw new Error("browser outgoing transfer row is foreign");
  }
  return transfer;
}

/** Compare immutable request identity before accepting any higher-revision rewrite. */
export function assertBrowserOutgoingCashuTransferImmutableIdentity(
  currentRow: BrowserOutgoingCashuTransferRow,
  replacementRow: BrowserOutgoingCashuTransferRow,
): void {
  const current = decodeBrowserOutgoingCashuTransferRow(currentRow.scopeId, currentRow);
  const replacement = decodeBrowserOutgoingCashuTransferRow(replacementRow.scopeId, replacementRow);
  if (
    currentRow.scopeId !== replacementRow.scopeId ||
    current.transferId !== replacement.transferId ||
    current.walletScopeId !== replacement.walletScopeId ||
    current.mintUrl !== replacement.mintUrl ||
    current.unit !== replacement.unit ||
    current.requestedAmount !== replacement.requestedAmount ||
    deriveDurableCustodyArtifactFingerprint(current.deliveryIntent) !==
      deriveDurableCustodyArtifactFingerprint(replacement.deliveryIntent) ||
    deriveDurableCustodyArtifactFingerprint(current.recipientSequence) !==
      deriveDurableCustodyArtifactFingerprint(replacement.recipientSequence) ||
    deriveDurableCustodyArtifactFingerprint(current.walletSendOperation) !==
      deriveDurableCustodyArtifactFingerprint(replacement.walletSendOperation) ||
    deriveDurableCustodyArtifactFingerprint(current.walletSendOperationAuthority) !==
      deriveDurableCustodyArtifactFingerprint(replacement.walletSendOperationAuthority) ||
    deriveDurableCustodyArtifactFingerprint(current.keepProofDerivationLocators) !==
      deriveDurableCustodyArtifactFingerprint(replacement.keepProofDerivationLocators)
  ) {
    throw new Error("browser outgoing transfer immutable request identity conflicts");
  }
}

/** Decode and validate one persisted market-funding head projection. */
export function decodeBrowserMarketFundingHeadRow(value: unknown): BrowserMarketFundingHeadRow {
  if (typeof value !== "object" || value === null) {
    throw new Error("browser market funding head is invalid");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const expected = [
    "accountSubject",
    "conditionId",
    "divisibility",
    "mintUrl",
    "recipientBinding",
    "revision",
    "scopeId",
    "transferId",
    "unit",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("browser market funding head has unexpected fields");
  }
  if (
    typeof row.scopeId !== "string" ||
    typeof row.recipientBinding !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.recipientBinding) ||
    typeof row.transferId !== "string" ||
    row.transferId.length === 0 ||
    typeof row.accountSubject !== "string" ||
    row.accountSubject.length === 0 ||
    row.accountSubject.length > 256 ||
    /[^\x20-\x7e]/.test(row.accountSubject) ||
    row.accountSubject.includes("\0") ||
    typeof row.conditionId !== "string" ||
    !/^[0-9a-f]{1,128}$/.test(row.conditionId) ||
    typeof row.unit !== "string" ||
    row.unit !== "msat" ||
    row.unit.length === 0 ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    parseMarketDivisibility(row.divisibility) === null
  ) {
    throw new Error("browser market funding head fields are invalid");
  }
  const mintUrl = normalizeUrl(row.mintUrl as string);
  const divisibility = parseMarketDivisibility(row.divisibility);
  if (divisibility === null) throw new Error("browser market funding divisibility is invalid");
  if (
    deriveMarketFundingProductBinding({
      conditionId: row.conditionId as string,
      divisibility,
      accountSubject: row.accountSubject as string,
    }) !== row.recipientBinding
  ) {
    throw new Error("browser market funding head product binding is foreign");
  }
  return {
    scopeId: row.scopeId as string,
    recipientBinding: row.recipientBinding as string,
    transferId: row.transferId as string,
    revision: row.revision as number,
    mintUrl,
    unit: row.unit as string,
    accountSubject: row.accountSubject as string,
    conditionId: row.conditionId as string,
    divisibility,
  };
}

/** Read one scoped market-funding head. The row is decoded before it leaves storage. */
export async function readBrowserMarketFundingHead(
  scopeId: string,
  recipientBinding: string,
  database: BitcasterDB = db,
): Promise<BrowserMarketFundingHeadRow | null> {
  const row = await database.marketFundingHeads.get([scopeId, recipientBinding]);
  return row === undefined ? null : decodeBrowserMarketFundingHeadRow(row);
}

/** Resolve the exact first successor for one predecessor in one recipient sequence. */
export async function findBrowserOutgoingCashuTransferByPredecessor(input: {
  readonly scopeId: string;
  readonly recipientBinding: string;
  readonly predecessorTransferId: string | null;
  readonly database?: BitcasterDB;
}): Promise<BrowserOutgoingCashuTransferRow | null> {
  const predecessorKey = input.predecessorTransferId ?? "";
  const rows = await (input.database ?? db).outgoingCashuTransfers
    .where("[scopeId+recipientBinding+predecessorKey]")
    .equals([input.scopeId, input.recipientBinding, predecessorKey])
    .toArray();
  if (rows.length > 1) throw new Error("browser outgoing predecessor relation is ambiguous");
  if (rows.length === 0) return null;
  const row = rows[0]!;
  decodeBrowserOutgoingCashuTransferRow(input.scopeId, row);
  return row;
}

function browserOutgoingMintRecoveryState(
  transfer: DurableOutgoingCashuTransfer,
): BrowserOutgoingCashuTransferRow["mintRecoveryState"] {
  switch (transfer.deliveryState) {
    case "prepared":
      return "pending";
    case "delivery-pending":
    case "recipient-acknowledged":
    case "bearer-spent":
    case "bearer-partial":
    case "reclaim-prepared":
    case "reclaimed":
      return "complete";
    default:
      return assertNever(transfer.deliveryState);
  }
}

function browserOutgoingLocalAuthorityState(
  transfer: DurableOutgoingCashuTransfer,
): BrowserOutgoingCashuTransferRow["localAuthorityState"] {
  switch (transfer.deliveryState) {
    case "prepared":
    case "delivery-pending":
    case "bearer-partial":
    case "reclaim-prepared":
      return "nonterminal";
    case "recipient-acknowledged":
    case "bearer-spent":
    case "reclaimed":
      return "terminal";
    default:
      return assertNever(transfer.deliveryState);
  }
}

function browserOutgoingRecipientBinding(transfer: DurableOutgoingCashuTransfer): string | null {
  return transfer.deliveryIntent.policy === "durable-recipient-ack"
    ? transfer.deliveryIntent.opaqueProductBinding
    : null;
}

function browserOutgoingBearerMintUrl(transfer: DurableOutgoingCashuTransfer): string | null {
  return transfer.deliveryIntent.policy === "bearer-spend-classification" ? transfer.mintUrl : null;
}

function assertNever(value: never): never {
  throw new Error(`unexpected browser outgoing delivery state: ${String(value)}`);
}

/** Local-only physical storage reservation. This row must never enter proof backup. */
export interface BrowserOutgoingCashuTransferAdmissionRow {
  scopeId: string;
  transferId: string;
  reservedBytes: number;
  padding: Uint8Array;
}

/** One local coordination pointer for the current unresolved Participation Score delivery. */
export interface BrowserParticipationScoreDeliveryPointerRow {
  scopeId: string;
  mintUrl: string;
  accountSubject: string;
  deliveryId: string;
  purchaseEpoch: number;
  revision: number;
}

export const DURABLE_BOLT11_MINT_QUOTE_OPERATION_METADATA_KEY = "durableBolt11MintQuoteRecordId";

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
  custodyProofBackupAuthorities!: Table<BrowserProofBackupAuthorityTableRow, [string, string]>;
  custodyConditionalKeysets!: Table<
    import("./durable-custody-types").BrowserCustodyConditionalKeysetRow,
    [string, string, string, string]
  >;
  encryptedWalletBackupEnrollmentResults!: Table<
    EncryptedWalletBackupDexieEnrollmentResultRow,
    [string, string]
  >;
  encryptedWalletBackupRetrySchedulers!: Table<
    EncryptedWalletBackupDexieRetrySchedulerRow,
    [string, string, string]
  >;
  encryptedWalletBackupV2DesiredAssets!: Table<
    EncryptedWalletBackupV2DesiredAssetRow,
    [string, string]
  >;
  walletCounterCursors!: Table<BrowserWalletCounterCursorRow, [string, string]>;
  walletCounterAssociations!: Table<
    BrowserWalletCounterAssociationRow,
    [string, string, CashuProofUnit, string]
  >;
  encryptedWalletBackupV2PreparedMutations!: Table<
    EncryptedWalletBackupV2PreparedMutationRow,
    [string, string, string, number]
  >;
  encryptedWalletBackupV2AcceptedHeads!: Table<
    EncryptedWalletBackupV2AcceptedHeadRow,
    [string, string, string, number]
  >;
  encryptedWalletBackupV2AssetReceipts!: Table<
    EncryptedWalletBackupV2AssetReceiptRow,
    [string, string, string, number, string]
  >;
  encryptedWalletBackupV2ActiveDescriptors!: Table<
    EncryptedWalletBackupV2ActiveDescriptorRow,
    [string, string, string, number, string]
  >;
  targetedAssetRecoveryAttempts!: Table<
    BrowserTargetedAssetRecoveryAttemptRow,
    [string, string, number, string]
  >;
  mintQuotes!: Table<BrowserMintQuoteRow, [string, "bolt11", string]>;
  outgoingCashuTransfers!: Table<BrowserOutgoingCashuTransferRow, [string, string]>;
  marketFundingHeads!: Table<BrowserMarketFundingHeadRow, [string, string]>;
  outgoingCashuTransferAdmissions!: Table<
    BrowserOutgoingCashuTransferAdmissionRow,
    [string, string]
  >;
  participationScoreDeliveryPointers!: Table<
    BrowserParticipationScoreDeliveryPointerRow,
    [string, string, string]
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
      custodyProofs:
        "&[scopeId+proofId], [scopeId+selectability], [scopeId+normalizedMint+unit+selectability], [scopeId+conditionId+outcomeCollection+selectability], [scopeId+normalizedMint+unit+keysetId+selectability], [scopeId+normalizedMint+unit+assetKind+selectability], [scopeId+normalizedMint+unit+conditionId+outcomeCollection+selectability]",
      custodyProofBackupAuthorities:
        "&[scopeId+proofId], [scopeId+backupState+proofId], [scopeId+proofState+proofId], &backupRecordId, [scopeId+admissionOperationId]",
      custodyConditionalKeysets:
        "&[scopeId+normalizedMint+unit+keysetId], [scopeId+normalizedMint+unit+conditionId+outcomeCollectionId]",
      walletCounterCursors: "&[scopeId+keysetId], scopeId",
      walletCounterAssociations:
        "&[scopeId+normalizedMint+unit+keysetId], scopeId, [scopeId+keysetId], [scopeId+normalizedMint+unit]",
      encryptedWalletBackupV2DesiredAssets:
        "&[scopeId+localAssetKey], [scopeId+mintUrl+unit+assetIdentity], [scopeId+localAssetKey], [scopeId+syncState+localAssetKey]",
      encryptedWalletBackupWalletEnrollmentResults: "&[realm+walletId]",
      encryptedWalletBackupWalletRetrySchedulers: "&[scopeId+realm+walletId]",
      encryptedWalletBackupV2WalletPreparedMutations: "&[scopeId+realm+walletId+enrollmentEpoch]",
      encryptedWalletBackupV2WalletAcceptedHeads: "&[scopeId+realm+walletId+enrollmentEpoch]",
      encryptedWalletBackupV2WalletAssetReceipts:
        "&[scopeId+realm+walletId+enrollmentEpoch+localAssetKey], [scopeId+realm+walletId+enrollmentEpoch]",
      encryptedWalletBackupV2WalletActiveDescriptors:
        "&[scopeId+realm+walletId+enrollmentEpoch+bundleId], [scopeId+realm+walletId+enrollmentEpoch]",
      targetedAssetRecoveryAttempts:
        "&[scopeId+assetLocator+backupHeadVersion+monitoringFactVersion], scopeId, [scopeId+completedAtUnixMilliseconds+assetLocator+backupHeadVersion+monitoringFactVersion]",
    });
    this.version(10).stores({
      custodyProofs:
        "&[scopeId+proofId], [scopeId+selectability], [scopeId+selectability+proofId], [scopeId+normalizedMint+unit+selectability], [scopeId+conditionId+outcomeCollection+selectability], [scopeId+normalizedMint+unit+keysetId+selectability], [scopeId+normalizedMint+unit+assetKind+selectability], [scopeId+normalizedMint+unit+conditionId+outcomeCollection+selectability]",
    });
    this.version(11).stores({
      mintQuotes:
        "&[scopeId+paymentMethod+quoteRecordId], [scopeId+paymentMethod+observedState+quoteRecordId], [scopeId+paymentMethod+recoveryState+lastRecoveryAttemptAtMs+quoteRecordId]",
    });
    this.version(12).stores({
      proofs:
        "&secret, mintUrl, marketId, conditionId, outcomeCollection, reservedBy, terminalOperationId, [mintUrl+unit+id], [mintUrl+unit+id+amount+secret]",
      outgoingCashuTransfers:
        "&[scopeId+transferId], [scopeId+mintUrl+mintRecoveryState+dueAtMs+transferId], [scopeId+mintRecoveryState+dueAtMs+mintUrl+transferId], [scopeId+localAuthorityState+transferId], [scopeId+recipientBinding+transferId]",
      outgoingCashuTransferAdmissions: "&[scopeId+transferId]",
    });
    this.version(13).stores({
      participationScoreDeliveryPointers: "&[scopeId+mintUrl+accountSubject], [scopeId+deliveryId]",
    });
    this.version(14)
      .stores({
        outgoingCashuTransfers:
          "&[scopeId+transferId], [scopeId+mintUrl+mintRecoveryState+dueAtMs+transferId], [scopeId+mintRecoveryState+dueAtMs+mintUrl+transferId], [scopeId+localAuthorityState+transferId], [scopeId+bearerMintUrl+localAuthorityState+transferId], [scopeId+recipientBinding+transferId]",
      })
      .upgrade(async (transaction) => {
        await transaction
          .table("outgoingCashuTransfers")
          .toCollection()
          .modify((row) => {
            row.bearerMintUrl =
              row.transfer?.deliveryIntent?.policy === "bearer-spend-classification"
                ? row.mintUrl
                : null;
          });
      });
    this.version(15).stores({
      proofs:
        "&secret, mintUrl, marketId, conditionId, outcomeCollection, reservedBy, terminalOperationId, [mintUrl+unit+id], [mintUrl+unit+id+amount+secret]",
      custodyProofs:
        "&[scopeId+proofId], [scopeId+selectability], [scopeId+selectability+proofId], [scopeId+normalizedMint+unit+selectability], [scopeId+conditionId+outcomeCollection+selectability], [scopeId+normalizedMint+unit+keysetId+selectability], [scopeId+normalizedMint+unit+assetKind+selectability], [scopeId+normalizedMint+unit+conditionId+outcomeCollection+selectability], [scopeId+normalizedMint+unit+assetKind+selectability+curve+amount+proofId]",
    });
    this.version(16).stores({
      custodyProofs:
        "&[scopeId+proofId], [scopeId+selectability], [scopeId+selectability+proofId], [scopeId+normalizedMint+unit+selectability], [scopeId+conditionId+outcomeCollection+selectability], [scopeId+normalizedMint+unit+keysetId+selectability], [scopeId+normalizedMint+unit+assetKind+selectability], [scopeId+normalizedMint+unit+conditionId+outcomeCollection+selectability], [scopeId+normalizedMint+unit+assetKind+selectability+curve+amount+proofId], [scopeId+normalizedMint+unit+keysetId+assetKind+selectability+curve+amount+proofId], [scopeId+normalizedMint+unit+keysetId+conditionId+outcomeCollection+selectability+curve+amount+proofId]",
    });
    this.version(17).stores({
      outgoingCashuTransfers:
        "&[scopeId+transferId], [scopeId+mintUrl+mintRecoveryState+dueAtMs+transferId], [scopeId+mintRecoveryState+dueAtMs+mintUrl+transferId], [scopeId+localAuthorityState+transferId], [scopeId+bearerMintUrl+localAuthorityState+transferId], [scopeId+recipientBinding+transferId], &[scopeId+recipientBinding+predecessorKey]",
      marketFundingHeads: "&[scopeId+recipientBinding], [scopeId+transferId]",
    });
    this.version(18).stores({
      custodyProofs:
        "&[scopeId+proofId], [scopeId+selectability], [scopeId+selectability+proofId], [scopeId+normalizedMint+unit+selectability], [scopeId+conditionId+outcomeCollection+selectability], [scopeId+normalizedMint+unit+keysetId+selectability], [scopeId+normalizedMint+unit+assetKind+selectability], [scopeId+normalizedMint+unit+conditionId+outcomeCollection+selectability], [scopeId+normalizedMint+unit+assetKind+selectability+curve+amount+proofId], [scopeId+normalizedMint+unit+keysetId+assetKind+selectability+curve+amount+proofId], [scopeId+normalizedMint+unit+keysetId+conditionId+outcomeCollection+selectability+curve+amount+proofId], [scopeId+normalizedMint+unit+conditionId+selectability+proofId]",
    });
    this.version(19)
      .stores({
        encryptedWalletBackupV2WalletAcceptedHeads: "&[scopeId+realm+walletId+enrollmentEpoch]",
      })
      .upgrade(async (transaction) => {
        await transaction
          .table("encryptedWalletBackupV2WalletAcceptedHeads")
          .toCollection()
          .modify((row) => {
            row.localRecoveryStatus = "ready";
            row.localRecoveryReason = "none";
            row.localRecoveryVersion = 0;
          });
      });
    this.encryptedWalletBackupEnrollmentResults = this.table(
      "encryptedWalletBackupWalletEnrollmentResults",
    );
    this.encryptedWalletBackupRetrySchedulers = this.table(
      "encryptedWalletBackupWalletRetrySchedulers",
    );
    this.encryptedWalletBackupV2PreparedMutations = this.table(
      "encryptedWalletBackupV2WalletPreparedMutations",
    );
    this.encryptedWalletBackupV2AcceptedHeads = this.table(
      "encryptedWalletBackupV2WalletAcceptedHeads",
    );
    this.encryptedWalletBackupV2AssetReceipts = this.table(
      "encryptedWalletBackupV2WalletAssetReceipts",
    );
    this.encryptedWalletBackupV2ActiveDescriptors = this.table(
      "encryptedWalletBackupV2WalletActiveDescriptors",
    );
    this.targetedAssetRecoveryAttempts = this.table("targetedAssetRecoveryAttempts");
    this.mintQuotes = this.table("mintQuotes");
    this.outgoingCashuTransfers = this.table("outgoingCashuTransfers");
    this.marketFundingHeads = this.table("marketFundingHeads");
    this.outgoingCashuTransferAdmissions = this.table("outgoingCashuTransferAdmissions");
    this.participationScoreDeliveryPointers = this.table("participationScoreDeliveryPointers");
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
 * Read the current browser custody proofs for a wallet scope.
 *
 * The legacy `proofs` table is a compatibility cache. It can retain a
 * predecessor after an atomic send, so portfolio readers must use this
 * canonical source when the custody tables are available. A missing custody
 * table returns `null` instead of falling back to that cache.
 */
export async function getCanonicalCurrentProofs(
  scopeId: string,
  database: BitcasterDB = db,
): Promise<StoredProof[] | null> {
  if (database.custodyProofs === undefined) return null;
  return database.transaction("r", [database.custodyProofs], async () => {
    const [selectable, locked] = await Promise.all([
      database.custodyProofs
        .where("[scopeId+selectability]")
        .equals([scopeId, "selectable"])
        .toArray(),
      database.custodyProofs.where("[scopeId+selectability]").equals([scopeId, "locked"]).toArray(),
    ]);
    return [...selectable, ...locked]
      .map(decodeBrowserCustodyProofRow)
      .filter((row) => row.scopeId === scopeId)
      .map(storedProofFromCustodyRow);
  });
}

export async function getCanonicalSelectableProofs(
  scopeId: string,
  database: BitcasterDB = db,
): Promise<StoredProof[] | null> {
  const proofs = await getCanonicalCurrentProofs(scopeId, database);
  return proofs?.filter((proof) => !proof.reservedBy && !proof.terminalOperationId) ?? null;
}

export const CANONICAL_CTF_PROOF_PAGE_LIMIT_MAX = 256;

export async function getCanonicalCtfProofPage(
  mintUrl: string,
  options: {
    scopeId: string;
    conditionId: string;
    selectability: "selectable" | "locked";
    afterProofId?: string | null;
    limit?: number;
  },
  database: BitcasterDB = db,
): Promise<{ proofs: BrowserCustodyProofRow[]; nextProofId: string | null }> {
  const scopeId = decodeDurableCustodyScopeId(options.scopeId);
  const normalizedMint = normalizeUrl(mintUrl);
  const conditionId = options.conditionId;
  const afterProofId = options.afterProofId ?? null;
  const limit = options.limit ?? CANONICAL_CTF_PROOF_PAGE_LIMIT_MAX;
  if (!/^[0-9a-f]{64}$/.test(conditionId)) {
    throw new Error("CTF proof selection requires a canonical condition ID");
  }
  if (afterProofId !== null && !/^[0-9a-f]{64}$/.test(afterProofId)) {
    throw new Error("CTF proof selection cursor is invalid");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CANONICAL_CTF_PROOF_PAGE_LIMIT_MAX) {
    throw new Error("CTF proof selection page limit is invalid");
  }
  if (options.selectability !== "selectable" && options.selectability !== "locked") {
    throw new Error("CTF proof selection state is invalid");
  }
  const prefix = [scopeId, normalizedMint, "msat", conditionId, options.selectability];
  const rows = await database.custodyProofs
    .where("[scopeId+normalizedMint+unit+conditionId+selectability+proofId]")
    .between([...prefix, afterProofId ?? ""], [...prefix, "\uffff"], afterProofId === null, true)
    .limit(limit)
    .toArray();
  const proofs = rows.map(decodeBrowserCustodyProofRow);
  for (const proof of proofs) {
    if (
      proof.scopeId !== scopeId ||
      proof.normalizedMint !== normalizedMint ||
      proof.unit !== "msat" ||
      proof.conditionId !== conditionId ||
      proof.assetKind !== "conditional" ||
      proof.selectability !== options.selectability ||
      proof.curve !== "secp256k1" ||
      !/^01[0-9a-f]{64}$/.test(proof.keysetId) ||
      (afterProofId !== null && proof.proofId <= afterProofId)
    ) {
      throw new Error("canonical CTF proof selector row is invalid");
    }
  }
  return {
    proofs,
    nextProofId: proofs.length === limit ? proofs[proofs.length - 1]!.proofId : null,
  };
}

/** Converts one verified custody row to the Cashu proof shape used by readers. */
export function storedProofFromCustodyRow(row: BrowserCustodyProofRow): StoredProof {
  const { proof: material } = decodeDurableCustodyProofMaterialRecord(row);
  const proof = deserializeDurableCustodyProofArtifact({ schemaVersion: 1, ...material });
  return {
    ...proof,
    mintUrl: row.normalizedMint,
    baseAsset: row.baseAsset,
    unit: row.unit,
    receivedAt: row.receivedAtMs,
    ...(row.conditionId === null ? {} : { conditionId: row.conditionId }),
    ...(row.outcomeCollection === null ? {} : { outcomeCollection: row.outcomeCollection }),
    ...(row.reservationOperationId === null ? {} : { reservedBy: row.reservationOperationId }),
  };
}

export const BOUNDED_CANONICAL_REGULAR_PROOF_LIMIT_MAX = 512;
export const MARKET_FUNDING_INPUT_PROOF_LIMIT_MAX = BOUNDED_CANONICAL_REGULAR_PROOF_LIMIT_MAX;
export const PARTICIPATION_SCORE_INPUT_PROOF_LIMIT_MAX = BOUNDED_CANONICAL_REGULAR_PROOF_LIMIT_MAX;
export const BOUNDED_CANONICAL_RANGE_PROOF_LIMIT_MAX = 512;

/** Read canonical selectable V2 proofs for one exact range source asset and keyset. */
export async function getBoundedCanonicalRangeProofsForKeyset(
  mintUrl: string,
  options: {
    scopeId: string;
    unit: CashuProofUnit | string;
    keysetId: string;
    asset:
      | { kind: "regular" }
      | { kind: "conditional"; conditionId: string; outcomeCollection: string };
  },
  database: BitcasterDB = db,
): Promise<StoredProof[]> {
  const unit = parseCashuProofUnit(options.unit);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${options.unit}'`);
  if (!/^01[0-9a-f]{64}$/.test(options.keysetId)) {
    throw new Error("Range proof selection requires a V2 keyset");
  }
  const normalizedMint = normalizeUrl(mintUrl);
  const rows = await canonicalRangeProofQuery(database, {
    ...options,
    normalizedMint,
    unit,
  })
    .reverse()
    .limit(BOUNDED_CANONICAL_RANGE_PROOF_LIMIT_MAX)
    .toArray();
  return rows
    .map(decodeBrowserCustodyProofRow)
    .flatMap((row) => {
      const proof = canonicalRangeProof(row, options, normalizedMint, unit);
      return proof === null ? [] : [proof];
    })
    .sort(
      (left, right) =>
        amountToNumber(right.amount) - amountToNumber(left.amount) ||
        left.secret.localeCompare(right.secret),
    );
}

function canonicalRangeProofQuery(
  database: BitcasterDB,
  options: Parameters<typeof getBoundedCanonicalRangeProofsForKeyset>[1] & {
    normalizedMint: string;
    unit: CashuProofUnit;
  },
) {
  const common = [options.scopeId, options.normalizedMint, options.unit, options.keysetId] as const;
  if (options.asset.kind === "regular") {
    return database.custodyProofs
      .where("[scopeId+normalizedMint+unit+keysetId+assetKind+selectability+curve+amount+proofId]")
      .between(
        [...common, "regular", "selectable", "secp256k1", 0, ""],
        [...common, "regular", "selectable", "secp256k1", Number.MAX_SAFE_INTEGER, "\uffff"],
        true,
        true,
      );
  }
  return database.custodyProofs
    .where(
      "[scopeId+normalizedMint+unit+keysetId+conditionId+outcomeCollection+selectability+curve+amount+proofId]",
    )
    .between(
      [
        ...common,
        options.asset.conditionId,
        options.asset.outcomeCollection,
        "selectable",
        "secp256k1",
        0,
        "",
      ],
      [
        ...common,
        options.asset.conditionId,
        options.asset.outcomeCollection,
        "selectable",
        "secp256k1",
        Number.MAX_SAFE_INTEGER,
        "\uffff",
      ],
      true,
      true,
    );
}

function canonicalRangeProof(
  row: BrowserCustodyProofRow,
  options: Parameters<typeof getBoundedCanonicalRangeProofsForKeyset>[1],
  normalizedMint: string,
  unit: CashuProofUnit,
): StoredProof | null {
  if (
    row.scopeId !== options.scopeId ||
    row.normalizedMint !== normalizedMint ||
    row.unit !== unit ||
    row.keysetId !== options.keysetId ||
    row.selectability !== "selectable" ||
    row.curve !== "secp256k1"
  ) {
    throw new Error("canonical range proof selector row is invalid");
  }
  if (options.asset.kind === "regular") {
    if (row.assetKind !== "regular" || row.conditionId !== null || row.outcomeCollection !== null) {
      return null;
    }
  } else if (
    row.assetKind !== "conditional" ||
    row.conditionId !== options.asset.conditionId ||
    row.outcomeCollection !== options.asset.outcomeCollection
  ) {
    return null;
  }
  const { proof: material } = decodeDurableCustodyProofMaterialRecord(row);
  return {
    ...deserializeDurableCustodyProofArtifact({ schemaVersion: 1, ...material }),
    mintUrl: row.normalizedMint,
    baseAsset: row.baseAsset,
    unit: row.unit,
    ...(row.assetKind === "conditional"
      ? {
          conditionId: row.conditionId!,
          outcomeCollection: row.outcomeCollection!,
          marketId: `${row.conditionId}-${row.outcomeCollection}`,
        }
      : {}),
  } satisfies StoredProof;
}

/** Read one bounded largest-first regular candidate set across canonical V2 keysets. */
export async function getBoundedCanonicalRegularProofs(
  mintUrl: string,
  options: { scopeId: string; unit: CashuProofUnit | string },
  database: BitcasterDB = db,
): Promise<StoredProof[]> {
  return getBoundedCanonicalV2Proofs(
    mintUrl,
    options.unit,
    options.scopeId,
    BOUNDED_CANONICAL_REGULAR_PROOF_LIMIT_MAX,
    database,
  );
}

async function getBoundedCanonicalV2Proofs(
  mintUrl: string,
  requestedUnit: CashuProofUnit | string,
  scopeId: string,
  limit: number,
  database: BitcasterDB,
): Promise<StoredProof[]> {
  const unit = parseCashuProofUnit(requestedUnit);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${requestedUnit}'`);
  const normalizedMint = normalizeUrl(mintUrl);
  const rows = await database.custodyProofs
    .where("[scopeId+normalizedMint+unit+assetKind+selectability+curve+amount+proofId]")
    .between(
      [scopeId, normalizedMint, unit, "regular", "selectable", "secp256k1", 0, ""],
      [
        scopeId,
        normalizedMint,
        unit,
        "regular",
        "selectable",
        "secp256k1",
        Number.MAX_SAFE_INTEGER,
        "\uffff",
      ],
      true,
      true,
    )
    .reverse()
    .limit(limit)
    .toArray();
  return rows
    .map(decodeBrowserCustodyProofRow)
    .map((row) => {
      if (
        row.scopeId !== scopeId ||
        row.normalizedMint !== normalizedMint ||
        row.unit !== unit ||
        row.assetKind !== "regular" ||
        row.selectability !== "selectable" ||
        row.curve !== "secp256k1"
      ) {
        throw new Error("canonical custody proof selector row is invalid");
      }
      if (!/^01[0-9a-f]{64}$/.test(row.keysetId)) {
        throw new Error("canonical custody selector requires a V2 keyset");
      }
      const { proof: material } = decodeDurableCustodyProofMaterialRecord(row);
      return {
        ...deserializeDurableCustodyProofArtifact({ schemaVersion: 1, ...material }),
        mintUrl: row.normalizedMint,
        baseAsset: row.baseAsset,
        unit: row.unit,
      } satisfies StoredProof;
    })
    .sort(
      (left, right) =>
        amountToNumber(right.amount) - amountToNumber(left.amount) ||
        left.secret.localeCompare(right.secret),
    );
}

// Central normalization point — proofs arrive from many receive paths
// (deposit, atomic-swap change, NIP-17 payload) where `mintUrl` may come
// from a decoded token or a raw wallet config. Normalizing on write means
// the balance query (`getProofs(activeMintUrl)`) never has to worry about
// trailing-slash / protocol-case drift.
export async function addProofs(proofs: StoredProof[], database: BitcasterDB = db): Promise<void> {
  const incomingRows = normalizedStoredProofRows(proofs);
  await database.transaction("rw", database.proofs, async () => {
    await putNormalizedStoredProofRows(database, incomingRows);
  });
}

/** Add compatibility-cache rows without replacing reservations or terminal bindings. */
export async function addProofsIfMissing(
  proofs: readonly StoredProof[],
  database: BitcasterDB = db,
): Promise<void> {
  const incomingRows = normalizedStoredProofRows([...proofs]);
  if (incomingRows.length === 0) return;
  await database.transaction("rw", database.proofs, async () => {
    const current = await database.proofs.bulkGet(incomingRows.map(({ secret }) => secret));
    const missing = incomingRows.filter((_, index) => current[index] === undefined);
    if (missing.length > 0) await database.proofs.bulkAdd(missing);
  });
}

/** Atomically admits restored proofs and advances their authoritative NUT-13 high-water mark. */
export async function restoreProofsAndAdvanceCounter(
  input: {
    readonly proofs: StoredProof[];
    readonly scopeId: string;
    readonly mintUrl: string;
    readonly unit: CashuProofUnit | string;
    readonly keysetId: string;
    readonly restoredNext: number;
    readonly isCurrentProfile: () => boolean;
  },
  database: BitcasterDB = db,
): Promise<BrowserWalletCounterAdvanceResult> {
  const rows = normalizedStoredProofRows(input.proofs);
  const counters = new BrowserWalletCounterDexieStore({
    database,
    scopeId: input.scopeId,
    isCurrentProfile: input.isCurrentProfile,
  });
  return counters.restoreInContext(
    { mintUrl: input.mintUrl, unit: input.unit },
    input.keysetId,
    input.restoredNext,
    rows.length > 0,
    () => putNormalizedStoredProofRows(database, rows),
  );
}

export async function isWalletCounterRecoveryComplete(
  input: {
    readonly scopeId: string;
    readonly mintUrl: string;
    readonly unit: CashuProofUnit | string;
    readonly keysetId: string;
    readonly isCurrentProfile: () => boolean;
  },
  database: BitcasterDB = db,
): Promise<boolean> {
  return new BrowserWalletCounterDexieStore({
    database,
    scopeId: input.scopeId,
    isCurrentProfile: input.isCurrentProfile,
  }).isRecoveryComplete({ mintUrl: input.mintUrl, unit: input.unit }, input.keysetId);
}

function normalizedStoredProofRows(proofs: StoredProof[]): StoredProofRow[] {
  const now = Date.now();
  return proofs.map((proof) =>
    storedProofRow(
      normalizeAndValidateStoredProof({
        ...proof,
        receivedAt: proof.receivedAt ?? now,
      }),
    ),
  );
}

async function putNormalizedStoredProofRows(
  database: BitcasterDB,
  incomingRows: StoredProofRow[],
): Promise<void> {
  if (incomingRows.length === 0) return;
  const currentRows = await database.proofs.bulkGet(incomingRows.map((row) => row.secret));
  const rows = incomingRows.map((row, index) =>
    preserveStoredProofTerminalBinding(row, currentRows[index]),
  );
  await database.proofs.bulkPut(rows);
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
