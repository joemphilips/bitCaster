import Dexie from "dexie";
import type { MintQuoteResponse, OperationCounters, Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  bindDurableBolt11MintQuoteOperation,
  createDurableBolt11MintQuote,
  decodeDurableBolt11MintQuote,
  hideDurableBolt11MintQuote,
  observeDurableBolt11MintQuoteState,
  verifyDurableBolt11MintQuoteRetry,
  type DurableBolt11MintQuote,
  type DurableBolt11MintQuoteNut04State,
} from "@bitcaster/client-sdk/durableBolt11MintQuote";
import {
  requireDurableWalletMintJournal,
  runDurableWalletMintOperation,
  serializeDurableWalletMintOperation,
  toDurableCustodyProofOperationInput,
} from "@bitcaster/client-sdk/durableWalletOperation";
import {
  COLLATERAL_UNIT_REGISTRY,
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
  type CashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import { getWalletForMnemonicUnit } from "@/stores/wallet";
import {
  getProofOperation,
  prepareProofOperation,
  DURABLE_BOLT11_MINT_QUOTE_OPERATION_METADATA_KEY,
  type BitcasterDB,
  type BrowserMintQuoteRow,
  type StoredOutputData,
} from "@/stores/proof-db";
import { normalizeUrl } from "@/lib/url";
import {
  browserDurableWalletMintStore,
  captureBrowserMintPersistenceContext,
  restoreExactMintOutputs,
  type BrowserMintPersistenceContext,
} from "@/lib/cashu";

export const BROWSER_BOLT11_MINT_RECOVERY_LIMIT = 64;

export interface CreateBrowserDurableBolt11MintQuoteInput {
  readonly amount: number;
  readonly mintUrl?: string;
  readonly unit: CashuProofUnit | string;
}

export interface BrowserDurableBolt11MintQuoteResult {
  readonly quote: DurableBolt11MintQuote;
  readonly invoiceRequest: string;
}

interface CoordinatorContext extends BrowserMintPersistenceContext {
  readonly mnemonic: string;
}

/** Create the invoice authority before any caller can expose its invoice. */
export async function createBrowserDurableBolt11MintQuote(
  input: CreateBrowserDurableBolt11MintQuoteInput,
): Promise<BrowserDurableBolt11MintQuoteResult> {
  const context = captureBrowserMintPersistenceContext();
  const unit = requireUnit(input.unit);
  const amount = requireAmount(input.amount);
  const mintUrl = normalizeUrl(input.mintUrl ?? context.activeMintUrl);
  const wallet = await getWalletForMnemonicUnit(mintUrl, unit, context.mnemonic);
  context.requireCapturedProfile();
  const mintQuote = await wallet.createMintQuote(amount);
  context.requireCapturedProfile();
  const quote = quoteFromMintResponse(mintUrl, unit, amount, mintQuote);
  const prepared = await prepareExactMintOperation({ context, wallet, quote, mintQuote, unit });
  context.requireCapturedProfile();
  const persisted = await persistQuoteAndOperation({ context, quote, ...prepared, unit });
  context.requireCapturedProfile();
  return { quote: persisted, invoiceRequest: persisted.invoiceRequest };
}

/** Hide only the invoice presentation. The durable recovery authority remains. */
export async function hideBrowserDurableBolt11MintQuote(quoteRecordId: string): Promise<void> {
  const context = captureBrowserMintPersistenceContext();
  context.requireCapturedProfile();
  await context.database.transaction("rw", context.database.mintQuotes, async () => {
    const row = await context.database.mintQuotes.get([context.scopeId, "bolt11", quoteRecordId]);
    if (!row) throw new Error("BOLT11 mint quote is absent");
    const quote = hideDurableBolt11MintQuote(readQuoteRow(context.scopeId, row));
    context.requireCapturedProfile();
    await context.database.mintQuotes.put(
      toQuoteRow(context.scopeId, quote, row.recoveryState, row.lastRecoveryAttemptAtMs),
    );
  });
  context.requireCapturedProfile();
}

/** Recover one bounded page. It never creates a fresh quote or output plan. */
export async function recoverBrowserDurableBolt11MintQuotes(): Promise<{
  pending: number;
  hasMore: boolean;
}> {
  return recoverBrowserDurableBolt11MintQuotesInPass({ passCutoffMs: Date.now() });
}

export async function recoverBrowserDurableBolt11MintQuotesInPass(input: {
  readonly passCutoffMs: number;
}): Promise<{ pending: number; hasMore: boolean }> {
  requirePassCutoff(input.passCutoffMs);
  let context: CoordinatorContext;
  try {
    context = captureBrowserMintPersistenceContext();
  } catch {
    return { pending: 0, hasMore: false };
  }
  const page = await currentScopeQuoteRows(context.database, context.scopeId, input.passCutoffMs);
  context.requireCapturedProfile();
  let pending = 0;
  for (const row of page.rows) {
    if (!(await recoverQuoteRow(context, row, input.passCutoffMs))) pending += 1;
  }
  return { pending, hasMore: page.hasMore };
}

async function prepareExactMintOperation(input: {
  context: CoordinatorContext;
  wallet: CashuWallet;
  quote: DurableBolt11MintQuote;
  mintQuote: MintQuoteResponse;
  unit: CashuProofUnit;
}): Promise<{
  operation: ReturnType<typeof serializeDurableWalletMintOperation>;
  counters: { keysetId: string; start: number; count: number };
}> {
  let counters: OperationCounters | undefined;
  const preview = await input.wallet.prepareMint(
    "bolt11",
    Number(input.quote.requestedAmount),
    input.mintQuote,
    {
      onCountersReserved: (reserved) => {
        counters = reserved;
      },
    },
  );
  input.context.requireCapturedProfile();
  if (!counters || counters.count <= 0)
    throw new Error("Cashu mint did not reserve a recovery range");
  return {
    operation: serializeDurableWalletMintOperation({
      operationId: input.quote.walletMintOperationId,
      mintUrl: input.quote.mintUrl,
      unit: input.unit,
      preview,
    }),
    counters: { keysetId: counters.keysetId, start: counters.start, count: counters.count },
  };
}

async function persistQuoteAndOperation(input: {
  context: CoordinatorContext;
  quote: DurableBolt11MintQuote;
  operation: ReturnType<typeof serializeDurableWalletMintOperation>;
  counters: { keysetId: string; start: number; count: number };
  unit: CashuProofUnit;
}): Promise<DurableBolt11MintQuote> {
  const bound = bindDurableBolt11MintQuoteOperation(input.quote, input.operation);
  const custody = toDurableCustodyProofOperationInput(input.operation);
  input.context.requireCapturedProfile();
  return input.context.database.transaction(
    "rw",
    input.context.database.mintQuotes,
    input.context.database.proofOperations,
    async () => {
      const existing = await input.context.database.mintQuotes.get([
        input.context.scopeId,
        "bolt11",
        bound.quoteRecordId,
      ]);
      input.context.requireCapturedProfile();
      const persisted = existing
        ? verifyExistingQuote(input.context.scopeId, existing, bound, input.operation)
        : bound;
      input.context.requireCapturedProfile();
      await prepareProofOperation(
        proofOperationInput(
          input.operation,
          custody,
          input.counters,
          input.unit,
          bound.quoteRecordId,
        ),
        input.context.database,
      );
      input.context.requireCapturedProfile();
      if (!existing) {
        input.context.requireCapturedProfile();
        await input.context.database.mintQuotes.add(toQuoteRow(input.context.scopeId, bound));
      }
      return persisted;
    },
  );
}

function proofOperationInput(
  operation: ReturnType<typeof serializeDurableWalletMintOperation>,
  custody: ReturnType<typeof toDurableCustodyProofOperationInput>,
  counters: { keysetId: string; start: number; count: number },
  unit: CashuProofUnit,
  quoteRecordId: string,
) {
  return {
    operationId: operation.operationId,
    kind: "wallet-mint" as const,
    mintUrl: operation.mintUrl,
    inputs: [],
    outputs: structuredClone(custody.outputs) as unknown as Record<string, StoredOutputData[]>,
    metadata: {
      ...custody.metadata,
      baseAsset: COLLATERAL_UNIT_REGISTRY[unit].baseAsset,
      [DURABLE_BOLT11_MINT_QUOTE_OPERATION_METADATA_KEY]: quoteRecordId,
      keysetId: counters.keysetId,
      counterStart: counters.start,
      counterCount: counters.count,
    },
  };
}

function verifyExistingQuote(
  scopeId: string,
  row: BrowserMintQuoteRow,
  quote: DurableBolt11MintQuote,
  operation: ReturnType<typeof serializeDurableWalletMintOperation>,
): DurableBolt11MintQuote {
  const existing = readQuoteRow(scopeId, row);
  assertSameQuoteRequest(existing, quote);
  return verifyDurableBolt11MintQuoteRetry(existing, operation);
}

function assertSameQuoteRequest(
  existing: DurableBolt11MintQuote,
  candidate: DurableBolt11MintQuote,
): void {
  const fields: (keyof DurableBolt11MintQuote)[] = [
    "quoteRecordId",
    "mintUrl",
    "unit",
    "paymentMethod",
    "requestedAmount",
    "quoteId",
    "invoiceRequest",
    "expiryUnixSeconds",
    "walletMintOperationId",
  ];
  if (fields.some((field) => existing[field] !== candidate[field])) {
    throw new Error("BOLT11 mint quote already exists with conflicting request");
  }
}

async function recoverQuoteRow(
  context: CoordinatorContext,
  row: BrowserMintQuoteRow,
  passCutoffMs: number,
): Promise<boolean> {
  try {
    const quote = readQuoteRow(context.scopeId, row);
    const unit = requireUnit(quote.unit);
    const wallet = await getWalletForMnemonicUnit(quote.mintUrl, unit, context.mnemonic);
    context.requireCapturedProfile();
    const observed = asNut04State((await wallet.checkMintQuote(quote.quoteId)).state);
    const current = await markQuoteRecoveryAttempt(
      context,
      quote.quoteRecordId,
      passCutoffMs,
      observed,
    );
    if (observed === null || observed === "UNPAID") return false;
    const operation = await exactBoundOperation(context.database, current);
    const baseAsset = normalizeMarketBaseAsset(COLLATERAL_UNIT_REGISTRY[unit].baseAsset);
    context.requireCapturedProfile();
    const result = await runDurableWalletMintOperation({
      mode: "recover",
      operationId: operation.operationId,
      wallet,
      store: browserDurableWalletMintStore({ baseAsset, context, unit, wallet }),
      restoreExactOutputs: (restore) => restoreExactMintOutputs(wallet, restore),
    });
    context.requireCapturedProfile();
    if (result.state === "nonterminal") return false;
    await markQuoteRecoveryCompleted(context, current.quoteRecordId);
    context.requireCapturedProfile();
    return true;
  } catch {
    await markQuoteRecoveryAttempt(context, row.quoteRecordId, passCutoffMs, null).catch(() => {});
    return false;
  }
}

async function markQuoteRecoveryAttempt(
  context: CoordinatorContext,
  quoteRecordId: string,
  passCutoffMs: number,
  observed: DurableBolt11MintQuoteNut04State | null,
): Promise<DurableBolt11MintQuote> {
  context.requireCapturedProfile();
  await context.database.transaction("rw", context.database.mintQuotes, async () => {
    const existing = await context.database.mintQuotes.get([
      context.scopeId,
      "bolt11",
      quoteRecordId,
    ]);
    if (!existing) throw new Error("BOLT11 mint quote disappeared during recovery");
    context.requireCapturedProfile();
    const quote = readQuoteRow(context.scopeId, existing);
    const next = observed === null ? quote : observeDurableBolt11MintQuoteState(quote, observed);
    context.requireCapturedProfile();
    await context.database.mintQuotes.put(
      toQuoteRow(context.scopeId, next, existing.recoveryState, passCutoffMs),
    );
  });
  context.requireCapturedProfile();
  const row = await context.database.mintQuotes.get([context.scopeId, "bolt11", quoteRecordId]);
  if (!row) throw new Error("BOLT11 mint quote disappeared during recovery");
  return readQuoteRow(context.scopeId, row);
}

async function exactBoundOperation(database: BitcasterDB, quote: DurableBolt11MintQuote) {
  const record = await getProofOperation(quote.walletMintOperationId, database);
  if (!record) throw new Error("BOLT11 mint quote wallet operation is absent");
  const operation = requireDurableWalletMintJournal({
    operationId: record.operationId,
    kind: record.kind,
    mintUrl: record.mintUrl,
    unit: record.metadata.unit,
    outputs: record.outputs,
    metadata: record.metadata,
  });
  verifyDurableBolt11MintQuoteRetry(quote, operation);
  return operation;
}

async function currentScopeQuoteRows(database: BitcasterDB, scopeId: string, passCutoffMs: number) {
  const rows = await database.mintQuotes
    .where("[scopeId+paymentMethod+recoveryState+lastRecoveryAttemptAtMs+quoteRecordId]")
    .between(
      [scopeId, "bolt11", "pending", Dexie.minKey, Dexie.minKey],
      [scopeId, "bolt11", "pending", passCutoffMs, Dexie.minKey],
      true,
      false,
    )
    .limit(BROWSER_BOLT11_MINT_RECOVERY_LIMIT + 1)
    .toArray();
  return {
    rows: rows.slice(0, BROWSER_BOLT11_MINT_RECOVERY_LIMIT),
    hasMore: rows.length > BROWSER_BOLT11_MINT_RECOVERY_LIMIT,
  };
}

function quoteFromMintResponse(
  mintUrl: string,
  unit: CashuProofUnit,
  amount: number,
  response: MintQuoteResponse,
): DurableBolt11MintQuote {
  return createDurableBolt11MintQuote({
    mintUrl,
    unit,
    requestedAmount: String(amount),
    quoteId: response.quote,
    invoiceRequest: response.request,
    expiryUnixSeconds: response.expiry ?? null,
  });
}

function toQuoteRow(
  scopeId: string,
  quote: DurableBolt11MintQuote,
  recoveryState: BrowserMintQuoteRow["recoveryState"] = "pending",
  lastRecoveryAttemptAtMs = 0,
): BrowserMintQuoteRow {
  const decoded = decodeDurableBolt11MintQuote(quote);
  return {
    scopeId,
    paymentMethod: "bolt11",
    quoteRecordId: decoded.quoteRecordId,
    observedState: decoded.observedState,
    recoveryState,
    lastRecoveryAttemptAtMs,
    quote: decoded,
  };
}

function readQuoteRow(scopeId: string, row: BrowserMintQuoteRow): DurableBolt11MintQuote {
  const quote = decodeDurableBolt11MintQuote(row.quote);
  if (
    row.scopeId !== scopeId ||
    row.paymentMethod !== "bolt11" ||
    row.quoteRecordId !== quote.quoteRecordId ||
    row.observedState !== quote.observedState ||
    (row.recoveryState !== "pending" && row.recoveryState !== "completed") ||
    !Number.isSafeInteger(row.lastRecoveryAttemptAtMs) ||
    row.lastRecoveryAttemptAtMs < 0
  ) {
    throw new Error("BOLT11 mint quote row is foreign");
  }
  return quote;
}

async function markQuoteRecoveryCompleted(
  context: CoordinatorContext,
  quoteRecordId: string,
): Promise<void> {
  context.requireCapturedProfile();
  await context.database.transaction("rw", context.database.mintQuotes, async () => {
    const row = await context.database.mintQuotes.get([context.scopeId, "bolt11", quoteRecordId]);
    if (!row) throw new Error("BOLT11 mint quote disappeared during recovery");
    context.requireCapturedProfile();
    await context.database.mintQuotes.put(
      toQuoteRow(
        context.scopeId,
        readQuoteRow(context.scopeId, row),
        "completed",
        row.lastRecoveryAttemptAtMs,
      ),
    );
  });
}

function asNut04State(value: unknown): DurableBolt11MintQuoteNut04State | null {
  switch (value) {
    case "UNPAID":
    case "PAID":
    case "ISSUED":
      return value;
    default:
      return null;
  }
}

function requireUnit(unit: string): CashuProofUnit {
  const parsed = parseCashuProofUnit(unit);
  if (!parsed) throw new Error(`Unsupported Cashu proof unit '${unit}'`);
  return parsed;
}

function requireAmount(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("Mint quote amount is invalid");
  return amount;
}

function requirePassCutoff(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("BOLT11 recovery pass is invalid");
}
