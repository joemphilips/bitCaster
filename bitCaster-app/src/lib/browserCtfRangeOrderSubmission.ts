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
import { toSeed } from "@/lib/bip39";
import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import type { MarketDetail } from "@/types/market-detail";
import { getSelectableUnitProofsForKeyset } from "@/stores/proof-db";
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

const MINT_METADATA_CACHE_TTL_MS = 30_000;
const MINT_METADATA_CACHE_LIMIT = 64;
const mintMetadataCache = new Map<
  string,
  { expiresAtMs: number; value: ReturnType<typeof loadCtfRangeMintMetadata> }
>();

export interface BrowserCtfRangeOrderSubmission {
  readonly market: MarketDetail;
  readonly ticket: TradeTicket;
  readonly clientOrderId: string;
  readonly mintUrl: string;
  readonly mnemonic: string;
  readonly comment?: NostrKind1Event | null;
}

export async function submitBrowserCtfRangeOrder(
  input: BrowserCtfRangeOrderSubmission,
): Promise<SubmitOrderResponse> {
  const words = input.mnemonic.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error("The wallet seed is unavailable.");

  const seed = toSeed(words);
  const scopeId = browserWalletScopeIdFromMnemonic(input.mnemonic);
  if (scopeId === null) throw new Error("The wallet profile is unavailable.");
  const engine = createAuthenticatedBrowserEngineClient();
  const mint = new CashuMint(input.mintUrl) as unknown as CtfRangeMintMetadataClient;
  const [policy, mintFacts] = await Promise.all([
    engine.getSettlementCapabilityAdmissionPolicy(),
    loadCachedMintMetadata({
      mint,
      mintUrl: input.mintUrl,
      conditionId: input.market.id,
      observedAt: Math.floor(Date.now() / 1_000),
      allowInsecureLoopbackHttp: isLoopbackMint(input.mintUrl),
    }),
  ]);
  const preparation = buildBrowserCtfRangeOrderPreparation({
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
  });
  const candidates = await getSelectableUnitProofsForKeyset(input.mintUrl, {
    unit: "msat",
    keysetId: preparation.offerKeyset.id,
    conditional: preparation.side === "Sell",
    limit: preparation.maxInputs,
  });
  const coordinator = createBrowserCtfRangeCoordinator(
    engine,
    input.mnemonic,
    isLoopbackMint(input.mintUrl),
  );
  try {
    return await coordinator.prepareAndSubmit({
      seed,
      preparation,
      candidates,
      comment: input.comment ?? null,
    });
  } catch (error) {
    if (error instanceof BrowserCtfRangeOrderError) {
      const record = await readCtfRangePreparation(scopeId, preparation.operationId);
      if (record !== null) {
        await persistRangeMessages({
          scopeId,
          operationId: preparation.operationId,
          revision: record.revision,
          code: error.code,
          observedAtMs: Date.now(),
        });
      }
    }
    throw error;
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
