import { Mint as CashuMint } from "@cashu/cashu-ts";
import {
  EngineClientError,
  isDefinitiveOrderSubmissionError,
  type NostrKind1Event,
  type SubmitOrderResponse,
} from "@bitcaster/client-sdk/engineClient";
import {
  loadCtfRangeMintMetadata,
  type CtfRangeMintMetadataClient,
} from "@bitcaster/client-sdk/ctfRangeMintMetadata";
import type { TradeTicket } from "@bitcaster/client-sdk/tradeTicket";
import { planCtfRangeSourceConsolidation } from "@bitcaster/client-sdk/ctfRangeSourceOperation";
import { planCtfRangeOrderAuthorization } from "@bitcaster/client-sdk/ctfRangeOrderAuthorization";
import { createEncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { toSeed } from "@/lib/bip39";
import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import type { MarketDetail } from "@/types/market-detail";
import {
  getProofAmountInventoryForKeyset,
  getSelectableUnitProofsForAmounts,
  db,
} from "@/stores/proof-db";
import { getWalletForMnemonicUnit } from "@/stores/wallet";
import {
  BrowserCtfRangeOrderCoordinator,
  BrowserCtfRangeOrderError,
  buildBrowserCtfRangeOrderPreparation,
  type BrowserCtfRangeOrderErrorCode,
} from "./browserCtfRangeOrderCoordinator";
import { createAuthenticatedBrowserEngineClient } from "./markets";
import { readCtfRangePreparation } from "@/stores/ctf-range-order-db";
import { recordBrowserCtfRangeMessage } from "@/stores/ctf-range-order-messages";
import { recoverBrowserFundedAsset } from "./browserFundedAssetRecovery";
import { activeBrowserWalletScopeId } from "./browserWalletProfile";

const MINT_METADATA_CACHE_TTL_MS = 30_000;
const MINT_METADATA_CACHE_LIMIT = 64;
const ADMISSION_POLICY_CACHE_TTL_MS = 30_000;
const BROWSER_CONSOLIDATION_ROUNDS_MAX = 256;
const mintMetadataCache = new Map<
  string,
  { expiresAtMs: number; value: ReturnType<typeof loadCtfRangeMintMetadata> }
>();
let admissionPolicyCache:
  | {
      expiresAtMs: number;
      value: ReturnType<
        ReturnType<
          typeof createAuthenticatedBrowserEngineClient
        >["getSettlementCapabilityAdmissionPolicy"]
      >;
    }
  | undefined;

export interface BrowserCtfRangeOrderSubmission {
  readonly market: MarketDetail;
  readonly ticket: TradeTicket;
  readonly clientOrderId: string;
  readonly mintUrl: string;
  readonly mnemonic: string;
  readonly comment?: NostrKind1Event | null;
  readonly expectedConsolidationFeeSubunits: number;
}

export interface BrowserCtfRangeOrderFeePreview {
  readonly consolidationFeeSubunits: number;
  readonly sourceFeeSubunits: number;
}

export async function previewBrowserCtfRangeOrderFees(input: {
  readonly market: MarketDetail;
  readonly ticket: TradeTicket;
  readonly mintUrl: string;
}): Promise<BrowserCtfRangeOrderFeePreview> {
  const { preparation } = await loadBrowserRangePreparation({
    ...input,
    clientOrderId: crypto.randomUUID(),
  });
  const plan = await loadBrowserRangeConsolidationPlan(preparation);
  if (plan.kind !== "ready") {
    throw new BrowserCtfRangeOrderError(
      plan.kind === "insufficient" ? "insufficient-funds" : "source-preparation-failed",
      consolidationPlanMessage(plan.kind),
    );
  }
  return {
    consolidationFeeSubunits: safeFeeSubunits(plan.consolidationFee),
    sourceFeeSubunits: safeFeeSubunits(plan.sourceFee),
  };
}

export async function submitBrowserCtfRangeOrder(
  input: BrowserCtfRangeOrderSubmission,
): Promise<SubmitOrderResponse> {
  const words = input.mnemonic.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error("The wallet seed is unavailable.");

  const seed = toSeed(words);
  const scopeId = browserWalletScopeIdFromMnemonic(input.mnemonic);
  if (scopeId === null) throw new Error("The wallet profile is unavailable.");
  const { engine, preparation } = await loadBrowserRangePreparation(input);
  const coordinator = createBrowserCtfRangeCoordinator(
    engine,
    input.mnemonic,
    isLoopbackMint(input.mintUrl),
  );
  try {
    const candidates = await consolidateBrowserRangeSource({
      coordinator,
      seed,
      preparation,
      mnemonic: input.mnemonic,
      scopeId,
      expectedConsolidationFeeSubunits: input.expectedConsolidationFeeSubunits,
    });
    return await coordinator.prepareAndSubmit({
      seed,
      preparation,
      candidates,
      comment: input.comment ?? null,
    });
  } catch (error) {
    if (error instanceof BrowserCtfRangeOrderError) {
      const record = await readCtfRangePreparation(scopeId, preparation.operationId);
      if (record !== null || error.code === "asset-recovery-failed") {
        await persistRangeMessages({
          scopeId,
          operationId: preparation.operationId,
          revision: record?.revision ?? 0,
          code: error.code,
          observedAtMs: Date.now(),
        });
      }
    }
    throw error;
  }
}

async function consolidateBrowserRangeSource(input: {
  coordinator: BrowserCtfRangeOrderCoordinator;
  seed: Uint8Array;
  preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>;
  mnemonic: string;
  scopeId: string;
  expectedConsolidationFeeSubunits: number;
}) {
  const plan = await recoverRangeSourcePlan(input);
  const consolidationFee = safeFeeSubunits(plan.consolidationFee);
  if (input.expectedConsolidationFeeSubunits !== consolidationFee) {
    throw new BrowserCtfRangeOrderError(
      "source-preparation-failed",
      "Wallet proof fees changed. Review the updated trade cost and try again.",
    );
  }
  await executeConsolidationRounds(input, plan);
  return selectedRangeSourceProofs(input, plan.selectedInputs);
}

async function recoverRangeSourcePlan(input: {
  seed: Uint8Array;
  preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>;
  mnemonic: string;
  scopeId: string;
}): Promise<ReadyRangeSourcePlan> {
  const recovery = await recoverBrowserFundedAsset({
    database: db,
    scopeId: input.scopeId,
    seed: input.seed,
    mnemonic: input.mnemonic,
    asset: rangeSourceAsset(input.preparation),
    requiredAmount: rangeSourceRequiredAmount(input.preparation),
    loadPlan: () => loadBrowserRangeConsolidationPlan(input.preparation),
    isCurrentProfile: () => activeBrowserWalletScopeId() === input.scopeId,
  });
  switch (recovery.kind) {
    case "ready":
      return readyRangeSourcePlan(recovery.plan);
    case "recovered":
      return postRecoveryRangeSourcePlan(
        await loadBrowserRangeConsolidationPlan(input.preparation),
      );
    case "persistent-error":
      throw assetRecoveryFailed();
    case "unavailable":
      throw rangeSourcePlanError("insufficient");
    case "not-recoverable":
      throw rangeSourcePlanError(
        recovery.plan.kind === "ready" ? "insufficient" : recovery.plan.kind,
      );
    default:
      throw new Error("browser range recovery outcome is invalid");
  }
}

function postRecoveryRangeSourcePlan(
  plan: Awaited<ReturnType<typeof loadBrowserRangeConsolidationPlan>>,
): ReadyRangeSourcePlan {
  if (plan.kind === "ready") return plan;
  if (plan.kind === "insufficient") throw assetRecoveryFailed();
  throw rangeSourcePlanError(plan.kind);
}

type ReadyRangeSourcePlan = Extract<
  Awaited<ReturnType<typeof loadBrowserRangeConsolidationPlan>>,
  { kind: "ready" }
>;

function readyRangeSourcePlan(
  plan: Awaited<ReturnType<typeof loadBrowserRangeConsolidationPlan>>,
): ReadyRangeSourcePlan {
  if (plan.kind === "ready") return plan;
  throw rangeSourcePlanError(plan.kind);
}

function rangeSourcePlanError(kind: "insufficient" | "not-reducible" | "round-limit") {
  return new BrowserCtfRangeOrderError(
    kind === "insufficient" ? "insufficient-funds" : "source-preparation-failed",
    consolidationPlanMessage(kind),
  );
}

function assetRecoveryFailed() {
  return new BrowserCtfRangeOrderError(
    "asset-recovery-failed",
    "The wallet could not recover the exact funds for this order.",
  );
}

async function executeConsolidationRounds(
  input: {
    coordinator: BrowserCtfRangeOrderCoordinator;
    seed: Uint8Array;
    preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>;
  },
  plan: Extract<Awaited<ReturnType<typeof loadBrowserRangeConsolidationPlan>>, { kind: "ready" }>,
) {
  for (const [round, plannedRound] of plan.consolidationRounds.entries()) {
    const proofs = await selectedRangeSourceProofs(input, plannedRound.inputs);
    await input.coordinator.consolidateRound({
      seed: input.seed,
      preparation: input.preparation,
      round,
      inputs: proofs,
      plannedRound,
    });
  }
}

function selectedRangeSourceProofs(
  input: { preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation> },
  amounts: readonly string[],
) {
  return getSelectableUnitProofsForAmounts(input.preparation.mintUrl, {
    unit: "msat",
    keysetId: input.preparation.offerKeyset.id,
    conditional: input.preparation.side === "Sell",
    amounts,
  });
}

function rangeSourceAsset(preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>) {
  if (preparation.side === "Buy") {
    return createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: preparation.mintUrl,
      unit: "msat",
      asset: { kind: "ordinary" },
    });
  }
  const offer = preparation.offerKeyset as typeof preparation.offerKeyset & {
    readonly conditionId: string;
    readonly outcomeCollection: string;
    readonly outcomeCollectionId: string;
    readonly registeredAt: number;
  };
  return createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: preparation.mintUrl,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: offer.conditionId,
      outcomeLabel: offer.outcomeCollection,
      outcomeCollectionId: offer.outcomeCollectionId,
      registeredAt: offer.registeredAt,
      finalExpiry: offer.finalExpiry,
    },
  });
}

function rangeSourceRequiredAmount(
  preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>,
): bigint {
  return BigInt(
    planCtfRangeOrderAuthorization({
      side: preparation.side,
      priceNumerator: preparation.priceNumerator,
      amountSubunits: preparation.amountSubunits,
      divisibility: preparation.divisibility,
      inputFeePpk: preparation.offerKeyset.inputFeePpk,
      offerKeysetKeys: preparation.offerKeyset.keys,
      maxPoolEntries: preparation.maxPoolEntries,
      maxInputs: preparation.maxInputs,
    }).inputAmount,
  );
}

async function loadBrowserRangePreparation(input: {
  readonly market: MarketDetail;
  readonly ticket: TradeTicket;
  readonly clientOrderId: string;
  readonly mintUrl: string;
}) {
  const engine = createAuthenticatedBrowserEngineClient();
  const mint = new CashuMint(input.mintUrl) as unknown as CtfRangeMintMetadataClient;
  const [policy, mintFacts] = await Promise.all([
    loadCachedAdmissionPolicy(engine),
    loadCachedMintMetadata({
      mint,
      mintUrl: input.mintUrl,
      conditionId: input.market.id,
      observedAt: Math.floor(Date.now() / 1_000),
      allowInsecureLoopbackHttp: isLoopbackMint(input.mintUrl),
    }),
  ]);
  return {
    engine,
    preparation: buildBrowserCtfRangeOrderPreparation({
      request: {
        ...input.ticket.request,
        clientOrderId: input.clientOrderId,
        marketId: input.ticket.marketId,
        conditionId: input.market.id,
        minimumFillAmountSubunits: input.market.divisibility,
        baseAsset: "sat",
        collateralUnit: "msat",
        divisibility: input.market.divisibility,
        timeInForce:
          input.ticket.request.timeInForce === "GTC" ? "FOK" : input.ticket.request.timeInForce,
        expiresAt: null,
        mintUrl: input.mintUrl,
      },
      policy,
      mintFacts,
      market: input.market,
      nowUnixSeconds: Math.floor(Date.now() / 1_000),
      randomId: () => crypto.randomUUID(),
    }),
  };
}

function loadCachedAdmissionPolicy(
  engine: ReturnType<typeof createAuthenticatedBrowserEngineClient>,
) {
  const nowMs = Date.now();
  if (admissionPolicyCache && admissionPolicyCache.expiresAtMs > nowMs) {
    return admissionPolicyCache.value;
  }
  const value = engine.getSettlementCapabilityAdmissionPolicy().catch((error: unknown) => {
    if (admissionPolicyCache?.value === value) admissionPolicyCache = undefined;
    throw error;
  });
  admissionPolicyCache = { expiresAtMs: nowMs + ADMISSION_POLICY_CACHE_TTL_MS, value };
  return value;
}

async function loadBrowserRangeConsolidationPlan(
  preparation: ReturnType<typeof buildBrowserCtfRangeOrderPreparation>,
) {
  const inventory = await getProofAmountInventoryForKeyset(preparation.mintUrl, {
    unit: "msat",
    keysetId: preparation.offerKeyset.id,
    conditional: preparation.side === "Sell",
  });
  return planCtfRangeSourceConsolidation({
    preparation,
    inventory,
    maxRounds: BROWSER_CONSOLIDATION_ROUNDS_MAX,
  });
}

function safeFeeSubunits(value: string): number {
  const fee = Number(value);
  if (!Number.isSafeInteger(fee) || fee < 0) {
    throw new BrowserCtfRangeOrderError(
      "source-preparation-failed",
      "The wallet proof fee is invalid.",
    );
  }
  return fee;
}

function consolidationPlanMessage(kind: "insufficient" | "not-reducible" | "round-limit"): string {
  switch (kind) {
    case "insufficient":
      return "The wallet does not have enough exact funds for this order.";
    case "not-reducible":
      return "The wallet proofs cannot be reduced under the mint input limit.";
    case "round-limit":
      return "The wallet proof consolidation exceeded its safe round limit.";
  }
}

export async function recoverBrowserCtfRangeOrders(input: {
  readonly mnemonic: string;
  readonly mintUrls: readonly string[];
}): Promise<{
  readonly recovered: number;
  readonly pending: readonly {
    operationId: string;
    revision: number;
    code: BrowserCtfRangeOrderErrorCode;
  }[];
}> {
  const words = input.mnemonic.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { recovered: 0, pending: [] };
  const seed = toSeed(words);
  const scopeId = browserWalletScopeIdFromMnemonic(input.mnemonic);
  if (scopeId === null) return { recovered: 0, pending: [] };
  const coordinator = createBrowserCtfRangeCoordinator(
    createAuthenticatedBrowserEngineClient(),
    input.mnemonic,
    input.mintUrls.some(isLoopbackMint),
  );
  let after: Parameters<BrowserCtfRangeOrderCoordinator["recoverPage"]>[0]["after"];
  let recovered = 0;
  const pending: Array<{
    operationId: string;
    revision: number;
    code: BrowserCtfRangeOrderErrorCode;
  }> = [];
  let priorCursor = "";
  do {
    const page = await coordinator.recoverPage({
      seed,
      limit: 64,
      ...(after === undefined ? {} : { after }),
    });
    recovered += page.recoveredOperationIds.length;
    for (const message of page.pending) {
      pending.push(message);
      await persistRangeMessages({ scopeId, ...message, observedAtMs: Date.now() });
    }
    if (page.nextCursor === null) break;
    const cursor = JSON.stringify(page.nextCursor);
    if (cursor === priorCursor) throw new Error("Browser range recovery cursor did not advance.");
    priorCursor = cursor;
    after = page.nextCursor;
    await Promise.resolve();
  } while (after !== undefined);
  return { recovered, pending };
}

export async function recoverBrowserCtfRangeOrder(input: {
  readonly mnemonic: string;
  readonly mintUrls: readonly string[];
  readonly clientOrderId: string;
}): Promise<{
  readonly recovered: number;
  readonly pending: readonly {
    operationId: string;
    revision: number;
    code: BrowserCtfRangeOrderErrorCode;
  }[];
}> {
  const words = input.mnemonic.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { recovered: 0, pending: [] };
  const seed = toSeed(words);
  const scopeId = browserWalletScopeIdFromMnemonic(input.mnemonic);
  if (scopeId === null) return { recovered: 0, pending: [] };
  const coordinator = createBrowserCtfRangeCoordinator(
    createAuthenticatedBrowserEngineClient(),
    input.mnemonic,
    input.mintUrls.some(isLoopbackMint),
  );
  const recovery = await coordinator.recoverClientOrder({
    seed,
    clientOrderId: input.clientOrderId,
  });
  for (const message of recovery.pending) {
    await persistRangeMessages({ scopeId, ...message, observedAtMs: Date.now() });
  }
  return { recovered: recovery.recoveredOperationIds.length, pending: recovery.pending };
}

async function persistRangeMessages(input: {
  scopeId: string;
  operationId: string;
  revision: number;
  code: BrowserCtfRangeOrderErrorCode;
  observedAtMs: number;
}): Promise<void> {
  const kind = orderFailureCode(input.code) ? "order" : "funds";
  await recordBrowserCtfRangeMessage({ ...input, kind });
  if (kind === "order") {
    await recordBrowserCtfRangeMessage({ ...input, code: "recovery-pending", kind: "funds" });
  }
}

function orderFailureCode(code: BrowserCtfRangeOrderErrorCode): boolean {
  return (
    code === "invalid-order-type" ||
    code === "capability-creation-failed" ||
    code === "capability-validation-failed" ||
    code === "order-submission-rejected" ||
    code === "order-submission-uncertain"
  );
}

function createBrowserCtfRangeCoordinator(
  engine: ReturnType<typeof createAuthenticatedBrowserEngineClient>,
  mnemonic: string,
  allowInsecureLoopbackHttp: boolean,
): BrowserCtfRangeOrderCoordinator {
  return new BrowserCtfRangeOrderCoordinator({
    wallet: (mintUrl) => getWalletForMnemonicUnit(mintUrl, "msat", mnemonic),
    engine,
    allowInsecureLoopbackHttp,
    isDefinitiveOrderRejection: (error) =>
      error instanceof EngineClientError && isDefinitiveOrderSubmissionError(error),
  });
}

function isLoopbackMint(mintUrl: string): boolean {
  const hostname = new URL(mintUrl).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function loadCachedMintMetadata(
  input: Parameters<typeof loadCtfRangeMintMetadata>[0],
): ReturnType<typeof loadCtfRangeMintMetadata> {
  const key = `${new URL(input.mintUrl).toString()}\0${input.conditionId}`;
  const nowMs = Date.now();
  const cached = mintMetadataCache.get(key);
  if (cached && cached.expiresAtMs > nowMs) {
    mintMetadataCache.delete(key);
    mintMetadataCache.set(key, cached);
    return cached.value;
  }
  if (cached) mintMetadataCache.delete(key);
  const value = loadCtfRangeMintMetadata(input).catch((error: unknown) => {
    if (mintMetadataCache.get(key)?.value === value) mintMetadataCache.delete(key);
    throw error;
  });
  mintMetadataCache.set(key, { expiresAtMs: nowMs + MINT_METADATA_CACHE_TTL_MS, value });
  while (mintMetadataCache.size > MINT_METADATA_CACHE_LIMIT) {
    const oldest = mintMetadataCache.keys().next().value;
    if (oldest === undefined) break;
    mintMetadataCache.delete(oldest);
  }
  return value;
}
