import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  validateDurableProofOperationLink,
  validateDurableTradePrivateKeyBinding,
  validateDurableTradeSession,
  verifyDurableTradeSessionCipherIntegrity,
  type DurableTradeProofOperationLink,
  type DurableTradeSession,
  type DurableTradeSessionRecord,
} from "@bitcaster/client-sdk/durableTradeRecovery";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { parseMarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";
import { isStrictAtomicSwapP2pkProofArtifact } from "@bitcaster/client-sdk/cashuProofArtifact";
import type { ActiveSwap } from "./activeSwaps";
import { sameValue } from "./durable-custody-dexie-model";
import { normalizeUrl } from "../lib/url";
import type { ProofOperationKind, SwapSessionRecord } from "./proof-db";

export const GUI_SWAP_ADAPTER_SCHEMA_VERSION = 1;

export type GuiSwapSessionRecord = DurableTradeSessionRecord<ActiveSwap> &
  SwapSessionRecord & {
    adapterSchemaVersion: typeof GUI_SWAP_ADAPTER_SCHEMA_VERSION;
  };

export const MAX_ACTIVE_GUI_SWAP_SESSIONS = 32;

export function createGuiSwapSessionRecord(
  swap: ActiveSwap,
  session: DurableTradeSession,
  walletId: string,
  priorRecord: SwapSessionRecord | undefined,
  durableTradeRecovery?: DurableTradeProofOperationLink,
): GuiSwapSessionRecord {
  if (priorRecord !== undefined && !isGuiSwapSessionRecord(priorRecord)) {
    throw new Error("The existing durable swap row is invalid");
  }
  const priorSession = priorRecord?.session;
  if (priorSession && validateDurableTradeSession(priorSession) !== null) {
    throw new Error("Cannot update an invalid durable swap session");
  }
  if (
    priorRecord &&
    !isAdapterStateBoundToSession(priorRecord.adapterState, priorRecord.session)
  ) {
    throw new Error("Cannot update an invalid durable swap session");
  }
  const normalizedMintUrl = normalizeUrl(session.mintUrl);
  if (
    priorSession?.mintUrl !== undefined &&
    normalizeUrl(priorSession.mintUrl) !== normalizedMintUrl
  ) {
    throw new Error("Cannot retarget a durable swap to another mint");
  }
  if (
    swap.mintUrl !== null &&
    normalizeUrl(swap.mintUrl) !== normalizedMintUrl
  ) {
    throw new Error("Active swap mint does not match its durable session");
  }
  const adapterState = mergeGuiAdapterState(
    priorRecord?.adapterState,
    cloneActiveSwap({ ...swap, mintUrl: normalizedMintUrl }),
  );
  if (!isPersistedActiveSwap(adapterState)) {
    throw new Error("The durable swap adapter state is invalid");
  }
  const nextSession = mergeGuiProofOperationLink(
    session,
    priorSession,
    durableTradeRecovery,
  );
  if (!isAdapterStateBoundToSession(adapterState, nextSession)) {
    throw new Error("The durable swap state does not match its SDK session");
  }
  return {
    adapterSchemaVersion: GUI_SWAP_ADAPTER_SCHEMA_VERSION,
    walletId,
    tradeId: swap.tradeId,
    active: isTerminalGuiSwapStep(adapterState.step) ? 0 : 1,
    session: nextSession,
    adapterState,
    updatedAt: Date.now(),
  };
}

export function durableSessionFromActiveSwap(
  swap: ActiveSwap,
  mintUrl: string,
): DurableTradeSession | null {
  if (
    !swap.role ||
    !swap.counterpartyPubkey ||
    swap.sellerLocktime === null ||
    swap.buyerLocktime === null
  ) {
    return null;
  }
  const normalizedMintUrl = normalizeUrl(mintUrl);
  if (
    swap.mintUrl !== null &&
    normalizeUrl(swap.mintUrl) !== normalizedMintUrl
  ) {
    throw new Error("Active swap mint cannot be changed");
  }
  const receivedCiphers = journalCiphers([
    [
      "adaptor-point",
      swap.role === "buyer" ? swap.messages.adaptorPoint : undefined,
    ],
    [
      "locked-proofs-seller",
      swap.role === "buyer" ? swap.messages.lockedProofsSeller : undefined,
    ],
    [
      "locked-proofs-buyer",
      swap.role === "seller" ? swap.messages.lockedProofsBuyer : undefined,
    ],
  ]);
  const outboundCiphers = journalCiphers([
    [
      "adaptor-point",
      swap.role === "seller" ? swap.sellerState?.adaptorPointCipher : undefined,
    ],
    [
      "locked-proofs-seller",
      swap.role === "seller" ? swap.sellerState?.lockedProofsCipher : undefined,
    ],
    [
      "locked-proofs-buyer",
      swap.role === "buyer" ? swap.buyerState?.lockedProofsCipher : undefined,
    ],
  ]);
  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId: swap.tradeId,
    role: swap.role,
    localProtocolPubkey: swap.ephemeralPubkeyHex.toLowerCase(),
    counterpartyProtocolPubkey: swap.counterpartyPubkey.toLowerCase(),
    mintUrl: normalizedMintUrl,
    sellerLocktimeSecs: swap.sellerLocktime,
    buyerLocktimeSecs: swap.buyerLocktime,
    ephemeralKeyHandle: {
      keyId: `gui-swap-session:${swap.tradeId}`,
      tradeId: swap.tradeId,
      role: swap.role,
      localProtocolPubkey: swap.ephemeralPubkeyHex.toLowerCase(),
      counterpartyProtocolPubkey: swap.counterpartyPubkey.toLowerCase(),
      mintUrl: normalizedMintUrl,
      sellerLocktimeSecs: swap.sellerLocktime,
      buyerLocktimeSecs: swap.buyerLocktime,
    },
    stage:
      swap.step === "awaiting-confirmation"
        ? "reconciliation-complete"
        : "intent",
    proofOperations: [],
    receivedCiphers,
    outboundCiphers,
  };
}

export function isGuiSwapSessionRecord(
  value: unknown,
): value is GuiSwapSessionRecord {
  const row = value as Partial<GuiSwapSessionRecord>;
  return (
    typeof value === "object" &&
    value !== null &&
    hasExactGuiSwapSessionRecordKeys(value) &&
    row.adapterSchemaVersion === GUI_SWAP_ADAPTER_SCHEMA_VERSION &&
    typeof row.walletId === "string" &&
    /^[0-9a-f]{64}$/.test(row.walletId) &&
    typeof row.tradeId === "string" &&
    row.tradeId === row.session?.tradeId &&
    row.tradeId === row.adapterState?.tradeId &&
    Number.isSafeInteger(row.updatedAt) &&
    (row.active === 0 || row.active === 1) &&
    isPersistedActiveSwap(row.adapterState) &&
    row.active === (isTerminalGuiSwapStep(row.adapterState.step) ? 0 : 1)
  );
}

export function guiSwapSessionValidationError(
  value: unknown,
  expectedWalletId: string,
): string | null {
  if (!isGuiSwapSessionRecord(value)) {
    return "GUI durable swap row is invalid";
  }
  if (value.walletId !== expectedWalletId) {
    return "GUI durable swap row belongs to another wallet scope";
  }
  const sessionError = validateDurableTradeSession(value.session);
  if (sessionError) return sessionError;
  if (!isAdapterStateBoundToSession(value.adapterState, value.session)) {
    return "GUI durable swap adapter state conflicts with its SDK session";
  }
  return null;
}

export async function guiSwapSessionIntegrityError(
  value: unknown,
  expectedWalletId: string,
): Promise<string | null> {
  const validationError = guiSwapSessionValidationError(
    value,
    expectedWalletId,
  );
  if (validationError) return validationError;
  return verifyDurableTradeSessionCipherIntegrity(
    (value as GuiSwapSessionRecord).session,
    sha256Hex,
  );
}

function hasExactGuiSwapSessionRecordKeys(value: object): boolean {
  const actual = Object.keys(value).sort();
  const expected = [
    "active",
    "adapterSchemaVersion",
    "adapterState",
    "session",
    "tradeId",
    "updatedAt",
    "walletId",
  ];
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isTerminalGuiSwapStep(step: ActiveSwap["step"]): boolean {
  return step === "completed" || step === "Failed";
}

export function isAdapterStateBoundToSession(
  swap: ActiveSwap,
  session: DurableTradeSession,
): boolean {
  return (
    swap.tradeId === session.tradeId &&
    swap.mintUrl === session.mintUrl &&
    swap.role === session.role &&
    validateDurableTradePrivateKeyBinding(
      swap.ephemeralPrivkeyHex,
      session.localProtocolPubkey,
    ) === null &&
    swap.ephemeralPubkeyHex.toLowerCase() === session.localProtocolPubkey &&
    swap.counterpartyPubkey?.toLowerCase() ===
      session.counterpartyProtocolPubkey &&
    swap.sellerLocktime === session.sellerLocktimeSecs &&
    swap.buyerLocktime === session.buyerLocktimeSecs &&
    adapterCiphersMatchSession(swap, session) &&
    adapterPrivateMaterialPrecedesProofOperations(swap, session)
  );
}

export async function sha256Hex(value: string): Promise<string> {
  return sha256HexSync(value);
}

export function durableStageForGuiProofOperation(
  kind: ProofOperationKind,
): "proof-reservation" | "claim" | "refund" | "mint-submission" {
  switch (kind) {
    case "swap-lock":
    case "conditional-keyset-swap":
      return "proof-reservation";
    case "swap-claim":
      return "claim";
    case "swap-refund":
      return "refund";
    case "ctf-split":
    case "ctf-merge":
    case "ctf-redeem":
    case "ctf-condition-registration":
    case "regular-split":
    case "proof-split":
      return "mint-submission";
    case "wallet-mint":
    case "wallet-receive":
    case "wallet-send":
      throw new Error("Ordinary wallet operation cannot bind to a trade stage");
  }
}

function mergeGuiProofOperationLink(
  session: DurableTradeSession,
  prior: DurableTradeSession | undefined,
  durableTradeRecovery: DurableTradeProofOperationLink | undefined,
): DurableTradeSession {
  const links = new Map<string, DurableTradeProofOperationLink>();
  for (const link of prior?.proofOperations ?? []) {
    if (validateDurableProofOperationLink(link) !== null) {
      throw new Error("Cannot retain an invalid GUI proof-operation link");
    }
    links.set(link.operationId, link);
  }
  if (durableTradeRecovery) {
    if (validateDurableProofOperationLink(durableTradeRecovery) !== null) {
      throw new Error("Cannot bind an invalid GUI proof-operation link");
    }
    links.set(durableTradeRecovery.operationId, durableTradeRecovery);
  }
  const proofOperations = [...links.values()];
  const receivedCiphers = mergeCipherJournal(
    prior?.receivedCiphers,
    session.receivedCiphers,
  );
  const outboundCiphers = mergeCipherJournal(
    prior?.outboundCiphers,
    session.outboundCiphers,
  );
  const stage = proofOperations.some((link) => link.state === "mint-submitted")
    ? "mint-submitted"
    : proofOperations.some((link) => link.state === "prepared")
      ? "proof-reserved"
      : proofOperations.length > 0
        ? "reconciliation-complete"
        : session.stage;
  return {
    ...session,
    revision: prior ? prior.revision + 1 : 0,
    stage,
    proofOperations,
    receivedCiphers,
    outboundCiphers,
  };
}

function mergeGuiAdapterState(
  prior: ActiveSwap | undefined,
  next: ActiveSwap,
): ActiveSwap {
  if (!prior) return next;
  assertImmutableGuiSwapBindings(prior, next);
  assertStepDoesNotRegress(prior.step, next.step);
  return {
    ...next,
    messages: mergePinnedRecord(prior.messages, next.messages),
    sellerState: mergeSellerState(prior.sellerState, next.sellerState),
    buyerPreparation: mergePinnedValue(
      prior.buyerPreparation,
      next.buyerPreparation,
    ),
    buyerState: mergePinnedValue(prior.buyerState, next.buyerState),
    settlementCompleteDelivery: mergeSettlementCompleteDelivery(
      prior.settlementCompleteDelivery,
      next.settlementCompleteDelivery,
    ),
    takerRecovery: mergeTakerRecovery(prior.takerRecovery, next.takerRecovery),
    recoveryAttempt: Math.max(
      prior.recoveryAttempt ?? 0,
      next.recoveryAttempt ?? 0,
    ),
    inFlightSteps: {},
  };
}

function cloneActiveSwap(swap: ActiveSwap): ActiveSwap {
  const clone = structuredClone(swap);
  if (swap.sellerState) {
    clone.sellerState = cloneSellerState(swap.sellerState);
  }
  return clone;
}

function cloneSellerState(
  state: NonNullable<ActiveSwap["sellerState"]>,
): NonNullable<ActiveSwap["sellerState"]> {
  return {
    ...state,
    adaptorPoint: cloneAdaptorPoint(state.adaptorPoint),
  };
}

function cloneAdaptorPoint(
  point: NonNullable<ActiveSwap["sellerState"]>["adaptorPoint"],
): NonNullable<ActiveSwap["sellerState"]>["adaptorPoint"] {
  return {
    secret: Uint8Array.from(point.secret),
    point: Uint8Array.from(point.point),
  };
}

function assertImmutableGuiSwapBindings(
  prior: ActiveSwap,
  next: ActiveSwap,
): void {
  const requiredBindings: Array<keyof ActiveSwap> = [
    "tradeId",
    "orderId",
    "marketId",
    "mintUrl",
    "ephemeralPrivkeyHex",
    "ephemeralPubkeyHex",
    "role",
    "counterpartyPubkey",
    "sellerLocktime",
    "buyerLocktime",
    "startedAt",
  ];
  const fillOnceBindings: Array<keyof ActiveSwap> = [
    "clientOrderId",
    "outcomeFaceAmountSats",
    "outcomeFaceAmountSubunits",
    "quotePaymentSats",
    "baseAsset",
    "divisibility",
    "side",
    "tokenSide",
    "priceSubunits",
    "amountSubunits",
    "timeInForce",
    "isTaker",
    "matchedAmountSubunits",
    "quotePaymentSubunits",
    "settlementKind",
    "sellerKeepOutcomeSetId",
    "sellerLockOutcomeSetId",
  ];
  if (
    requiredBindings.some((key) => !sameValue(prior[key], next[key])) ||
    fillOnceBindings.some(
      (key) =>
        prior[key] !== null &&
        prior[key] !== undefined &&
        !sameValue(prior[key], next[key]),
    )
  ) {
    throw new Error("Cannot change an immutable durable swap binding");
  }
}

function mergeSellerState(
  prior: ActiveSwap["sellerState"],
  next: ActiveSwap["sellerState"],
): ActiveSwap["sellerState"] {
  if (!prior) return next ? cloneSellerState(next) : null;
  if (!next || !sameValue(prior.adaptorPoint, next.adaptorPoint)) {
    throw new Error("Cannot erase or replace durable swap state");
  }
  return {
    adaptorPoint: cloneAdaptorPoint(prior.adaptorPoint),
    adaptorPointCipher: mergePinnedOptionalString(
      prior.adaptorPointCipher,
      next.adaptorPointCipher,
    ),
    lockedProofsCipher: mergePinnedOptionalString(
      prior.lockedProofsCipher,
      next.lockedProofsCipher,
    ),
  };
}

function mergePinnedValue<T>(prior: T | null, next: T | null): T | null {
  if (prior === null) return structuredClone(next);
  if (next === null || !sameValue(prior, next)) {
    throw new Error("Cannot erase or replace durable swap state");
  }
  return structuredClone(prior);
}

function mergePinnedRecord(
  prior: ActiveSwap["messages"],
  next: ActiveSwap["messages"],
): ActiveSwap["messages"] {
  const merged = { ...next };
  for (const messageType of [
    "adaptorPoint",
    "lockedProofsSeller",
    "lockedProofsBuyer",
  ] as const) {
    merged[messageType] = mergePinnedOptionalString(
      prior[messageType],
      next[messageType],
    );
  }
  return merged;
}

function mergePinnedOptionalString(
  prior: string | undefined,
  next: string | undefined,
): string | undefined {
  if (prior === undefined) return next;
  if (next !== prior) {
    throw new Error("Cannot erase or replace durable swap state");
  }
  return prior;
}

function mergeTakerRecovery(
  prior: ActiveSwap["takerRecovery"],
  next: ActiveSwap["takerRecovery"],
): ActiveSwap["takerRecovery"] {
  if (!prior) return structuredClone(next);
  if (!next || prior.clientOrderId !== next.clientOrderId) {
    throw new Error("Cannot erase or replace durable swap state");
  }
  if (prior.status === "submitted") {
    if (!sameValue(prior, next)) {
      throw new Error("Cannot erase or replace durable swap state");
    }
    return structuredClone(prior);
  }
  return structuredClone(next);
}

function mergeSettlementCompleteDelivery(
  prior: ActiveSwap["settlementCompleteDelivery"],
  next: ActiveSwap["settlementCompleteDelivery"],
): ActiveSwap["settlementCompleteDelivery"] {
  const rank: Record<ActiveSwap["settlementCompleteDelivery"], number> = {
    "not-ready": 0,
    pending: 1,
    delivered: 2,
  };
  if (rank[next] < rank[prior]) {
    throw new Error("Cannot regress durable settlement delivery");
  }
  return next;
}

function assertStepDoesNotRegress(
  prior: ActiveSwap["step"],
  next: ActiveSwap["step"],
): void {
  const rank: Record<ActiveSwap["step"], number> = {
    "awaiting-trade-created": 0,
    "awaiting-counterparty": 1,
    driving: 2,
    "awaiting-confirmation": 3,
    "awaiting-refund": 4,
    completed: 5,
    Failed: 5,
  };
  if (
    rank[next] < rank[prior] ||
    ((prior === "Failed" || prior === "completed") && next !== prior)
  ) {
    throw new Error("Cannot regress durable swap state");
  }
}

function mergeCipherJournal(
  prior: DurableTradeSession["receivedCiphers"] | undefined,
  next: DurableTradeSession["receivedCiphers"],
): DurableTradeSession["receivedCiphers"] {
  const merged = structuredClone(next);
  for (const messageType of [
    "adaptor-point",
    "locked-proofs-seller",
    "locked-proofs-buyer",
  ] as const) {
    const previous = prior?.[messageType];
    if (!previous) continue;
    if (!sameValue(previous, next[messageType])) {
      throw new Error("Cannot erase or replace durable swap state");
    }
    merged[messageType] = structuredClone(previous);
  }
  return merged;
}

function adapterCiphersMatchSession(
  swap: ActiveSwap,
  session: DurableTradeSession,
): boolean {
  const received = {
    "adaptor-point":
      swap.role === "buyer" ? swap.messages.adaptorPoint : undefined,
    "locked-proofs-seller":
      swap.role === "buyer" ? swap.messages.lockedProofsSeller : undefined,
    "locked-proofs-buyer":
      swap.role === "seller" ? swap.messages.lockedProofsBuyer : undefined,
  };
  const outbound = {
    "adaptor-point":
      swap.role === "seller" ? swap.sellerState?.adaptorPointCipher : undefined,
    "locked-proofs-seller":
      swap.role === "seller" ? swap.sellerState?.lockedProofsCipher : undefined,
    "locked-proofs-buyer":
      swap.role === "buyer" ? swap.buyerState?.lockedProofsCipher : undefined,
  };
  return (
    ["adaptor-point", "locked-proofs-seller", "locked-proofs-buyer"] as const
  ).every(
    (messageType) =>
      received[messageType] ===
        session.receivedCiphers[messageType]?.ciphertext &&
      outbound[messageType] ===
        session.outboundCiphers[messageType]?.ciphertext,
  );
}

function adapterPrivateMaterialPrecedesProofOperations(
  swap: ActiveSwap,
  session: DurableTradeSession,
): boolean {
  if (session.proofOperations.length === 0) return true;
  switch (swap.role) {
    case "seller":
      return swap.sellerState !== null;
    case "buyer":
      return swap.buyerPreparation !== null;
    default:
      return false;
  }
}

const ACTIVE_SWAP_FIELDS = new Set<keyof ActiveSwap>([
  "tradeId",
  "orderId",
  "clientOrderId",
  "marketId",
  "mintUrl",
  "ephemeralPrivkeyHex",
  "ephemeralPubkeyHex",
  "role",
  "counterpartyPubkey",
  "sellerLocktime",
  "buyerLocktime",
  "outcomeFaceAmountSats",
  "outcomeFaceAmountSubunits",
  "quotePaymentSats",
  "baseAsset",
  "divisibility",
  "side",
  "tokenSide",
  "priceSubunits",
  "amountSubunits",
  "timeInForce",
  "isTaker",
  "matchedAmountSubunits",
  "recoveryAttempt",
  "takerRecovery",
  "quotePaymentSubunits",
  "settlementKind",
  "sellerKeepOutcomeSetId",
  "sellerLockOutcomeSetId",
  "step",
  "messages",
  "sellerState",
  "buyerPreparation",
  "buyerState",
  "settlementCompleteDelivery",
  "inFlightSteps",
  "error",
  "startedAt",
]);

function isPersistedActiveSwap(value: unknown): value is ActiveSwap {
  if (!isRecord(value) || !hasOnlyKeys(value, ACTIVE_SWAP_FIELDS)) return false;
  const swap = value as Partial<ActiveSwap>;
  return (
    isNonEmptyString(swap.tradeId) &&
    isNonEmptyString(swap.orderId) &&
    isOptionalString(swap.clientOrderId) &&
    isNonEmptyString(swap.marketId) &&
    isNormalizedUrl(swap.mintUrl) &&
    isHex(swap.ephemeralPrivkeyHex, 64) &&
    isHex(swap.ephemeralPubkeyHex, 66) &&
    (swap.role === "seller" || swap.role === "buyer") &&
    isHex(swap.counterpartyPubkey, 66) &&
    isSafeInteger(swap.sellerLocktime) &&
    isSafeInteger(swap.buyerLocktime) &&
    swap.sellerLocktime > swap.buyerLocktime &&
    validSettlementFields(swap) &&
    validProtocolState(swap) &&
    isSafeInteger(swap.startedAt)
  );
}

function validSettlementFields(swap: Partial<ActiveSwap>): boolean {
  return (
    isNullableSafeInteger(swap.outcomeFaceAmountSats) &&
    isNullableSafeInteger(swap.outcomeFaceAmountSubunits) &&
    isNullableSafeInteger(swap.quotePaymentSats) &&
    isNullableSafeInteger(swap.quotePaymentSubunits) &&
    isOptionalNullableSafeInteger(swap.priceSubunits) &&
    isOptionalNullableSafeInteger(swap.amountSubunits) &&
    isOptionalNullableSafeInteger(swap.matchedAmountSubunits) &&
    isNullableCanonicalBaseAsset(swap.baseAsset) &&
    isNullablePositiveSafeInteger(swap.divisibility) &&
    isOptionalClosedValue(swap.side, ["Buy", "Sell"]) &&
    isOptionalClosedValue(swap.tokenSide, ["Outcome", "Complement"]) &&
    isOptionalClosedValue(swap.timeInForce, ["FAK", "FOK", "GTC"]) &&
    (swap.isTaker === undefined || typeof swap.isTaker === "boolean") &&
    isOptionalSafeInteger(swap.recoveryAttempt) &&
    isNullableString(swap.settlementKind) &&
    isNullableString(swap.sellerKeepOutcomeSetId) &&
    isNullableString(swap.sellerLockOutcomeSetId) &&
    validTakerRecovery(swap.takerRecovery)
  );
}

function isNullableCanonicalBaseAsset(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && parseMarketBaseAsset(value) === value)
  );
}

function isNullablePositiveSafeInteger(value: unknown): boolean {
  return (
    value === null || (Number.isSafeInteger(value) && (value as number) > 0)
  );
}

function validProtocolState(swap: Partial<ActiveSwap>): boolean {
  return (
    isClosedValue(swap.step, [
      "awaiting-trade-created",
      "awaiting-counterparty",
      "driving",
      "awaiting-confirmation",
      "awaiting-refund",
      "completed",
      "Failed",
    ]) &&
    validMessages(swap.messages) &&
    validSellerState(swap.sellerState) &&
    validBuyerPreparation(swap.buyerPreparation) &&
    validBuyerState(swap.buyerState, swap) &&
    validSettlementDelivery(swap) &&
    validInFlightSteps(swap.inFlightSteps) &&
    isNullableString(swap.error)
  );
}

function validBuyerPreparation(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasOnlyKeys(value, new Set(["lockedProofsCipherIv"])) &&
      isUint8Array(value.lockedProofsCipherIv) &&
      value.lockedProofsCipherIv.length === 12)
  );
}

function validSettlementDelivery(swap: Partial<ActiveSwap>): boolean {
  if (
    !isClosedValue(swap.settlementCompleteDelivery, [
      "not-ready",
      "pending",
      "delivered",
    ])
  ) {
    return false;
  }
  switch (swap.step) {
    case "awaiting-trade-created":
    case "awaiting-counterparty":
    case "driving":
      return swap.settlementCompleteDelivery === "not-ready";
    case "awaiting-confirmation":
      return swap.settlementCompleteDelivery !== "not-ready";
    case "awaiting-refund":
      return true;
    case "completed":
    case "Failed":
      return true;
    default:
      return false;
  }
}

function validMessages(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(
      value,
      new Set(["adaptorPoint", "lockedProofsSeller", "lockedProofsBuyer"]),
    ) &&
    Object.values(value).every(
      (entry) => entry === undefined || typeof entry === "string",
    )
  );
}

function validSellerState(value: unknown): boolean {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set(["adaptorPoint", "adaptorPointCipher", "lockedProofsCipher"]),
    ) ||
    !isOptionalString(value.adaptorPointCipher) ||
    !isOptionalString(value.lockedProofsCipher)
  ) {
    return false;
  }
  return validAdaptorPoint(value.adaptorPoint);
}

function validAdaptorPoint(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const secret = value.secret;
  const point = value.point;
  if (
    !hasOnlyKeys(value, new Set(["secret", "point"])) ||
    !isUint8Array(secret) ||
    !isUint8Array(point) ||
    secret.length !== 32 ||
    point.length !== 33
  ) {
    return false;
  }
  try {
    const expected = secp256k1.getPublicKey(secret, true);
    return expected.every((byte, index) => byte === point[index]);
  } catch {
    return false;
  }
}

function isUint8Array(value: unknown): value is Uint8Array {
  const candidate = value as {
    BYTES_PER_ELEMENT?: number;
    byteLength?: number;
    length?: number;
  };
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]" &&
    candidate.BYTES_PER_ELEMENT === 1 &&
    candidate.byteLength === candidate.length
  );
}

function validBuyerState(value: unknown, swap: Partial<ActiveSwap>): boolean {
  if (value === null) return true;
  if (
    swap.role !== "buyer" ||
    typeof swap.ephemeralPubkeyHex !== "string" ||
    typeof swap.counterpartyPubkey !== "string" ||
    !Number.isSafeInteger(swap.buyerLocktime)
  ) {
    return false;
  }
  const binding = {
    lockerPubkey: swap.ephemeralPubkeyHex,
    counterpartyPubkey: swap.counterpartyPubkey,
    locktime: swap.buyerLocktime as number,
  };
  return (
    isRecord(value) &&
    hasOnlyKeys(
      value,
      new Set([
        "ownPreSigsHex",
        "lockedSatProofs",
        "lockedProofsCipher",
        "sellerPreSigsHex",
      ]),
    ) &&
    isStringArray(value.ownPreSigsHex) &&
    Array.isArray(value.lockedSatProofs) &&
    value.lockedSatProofs.length > 0 &&
    value.lockedSatProofs.every((proof) =>
      isStrictAtomicSwapP2pkProofArtifact(proof, binding),
    ) &&
    typeof value.lockedProofsCipher === "string" &&
    isStringArray(value.sellerPreSigsHex)
  );
}

function validInFlightSteps(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, new Set(["seller-open", "buyer-respond", "settle"])) &&
    Object.values(value).every((entry) => entry === true)
  );
}

function validTakerRecovery(value: unknown): boolean {
  if (value === undefined) return true;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set(["clientOrderId", "status", "replacementOrderId"]),
    ) ||
    !isNonEmptyString(value.clientOrderId) ||
    !isOptionalString(value.replacementOrderId)
  ) {
    return false;
  }
  switch (value.status) {
    case "pending":
      return true;
    case "submitted":
      return isNonEmptyString(value.replacementOrderId);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isOptionalSafeInteger(value: unknown): boolean {
  return value === undefined || Number.isSafeInteger(value);
}

function isNullableSafeInteger(value: unknown): boolean {
  return value === null || Number.isSafeInteger(value);
}

function isOptionalNullableSafeInteger(value: unknown): boolean {
  return value === undefined || isNullableSafeInteger(value);
}

function isHex(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[0-9a-f]+$/i.test(value)
  );
}

function isNormalizedUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return normalizeUrl(value) === value;
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isClosedValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isOptionalClosedValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T | undefined {
  return value === undefined || isClosedValue(value, allowed);
}

function journalCiphers(
  input: Array<
    [keyof DurableTradeSession["receivedCiphers"], string | undefined]
  >,
): DurableTradeSession["receivedCiphers"] {
  const output: DurableTradeSession["receivedCiphers"] = {};
  for (const [messageType, ciphertext] of input) {
    if (!ciphertext) continue;
    output[messageType] = { ciphertext, sha256: sha256HexSync(ciphertext) };
  }
  return output;
}

function sha256HexSync(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}
