import Dexie from "dexie";
import {
  createSpeculativeCounterTranscript,
  type SpeculativeCounterTranscript,
} from "@bitcaster/client-sdk/speculativeCounterTranscript";
import {
  BrowserWalletCounterDexieStore,
  BrowserWalletCounterSnapshotConflictError,
} from "@/stores/browser-wallet-counter-db";
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
import { getWalletForMnemonicUnit, createUncachedWalletForMnemonicUnit } from "@/stores/wallet";
import {
  getProofOperation,
  prepareProofOperation,
  DURABLE_BOLT11_MINT_QUOTE_OPERATION_METADATA_KEY,
  type BitcasterDB,
  type BrowserMintQuoteRow,
  type StoredOutputData,
} from "@/stores/proof-db";
import { normalizeUrl } from "@/lib/url";
import { requireBrowserWalletNewWritePermission } from "@/lib/browserWalletNewWritePermission";
import { withWalletProfileLock } from "@/lib/walletProfileLock";
import {
  browserDurableWalletMintStore,
  captureBrowserMintPersistenceContext,
  restoreExactMintOutputs,
  waitForMintQuotePaidForUnit,
  type MintQuoteWaitResult,
  type WaitForMintQuoteOptions,
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

export interface ActiveBrowserDurableBolt11MintQuoteSubscription {
  readonly quote: DurableBolt11MintQuote;
  readonly onResult: (result: MintQuoteWaitResult) => void;
  readonly options?: WaitForMintQuoteOptions;
}

interface CoordinatorContext extends BrowserMintPersistenceContext {
  readonly mnemonic: string;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly observePrepared?: (
    operation: ReturnType<typeof serializeDurableWalletMintOperation>,
  ) => Promise<void>;
  readonly injectPreparationFault?: (
    phase: "counter-written" | "journal-bound" | "after-commit",
  ) => void;
}

/** Create the invoice authority before any caller can expose its invoice. */
export async function createBrowserDurableBolt11MintQuote(
  input: CreateBrowserDurableBolt11MintQuoteInput,
): Promise<BrowserDurableBolt11MintQuoteResult> {
  const context: CoordinatorContext = captureBrowserMintPersistenceContext();
  const unit = requireUnit(input.unit);
  const amount = requireAmount(input.amount);
  const mintUrl = normalizeUrl(input.mintUrl ?? context.activeMintUrl);
  const wallet = await getWalletForMnemonicUnit(mintUrl, unit, context.mnemonic);
  return withWalletProfileLock(
    context.scopeId,
    async () => {
      context.requireCapturedProfile();
      await requireBrowserWalletNewWritePermission({
        database: context.database,
        scopeId: context.scopeId,
      });
      const mintQuote = await wallet.createMintQuote(amount);
      context.requireCapturedProfile();
      const quote = quoteFromMintResponse(mintUrl, unit, amount, mintQuote);
      const selected = wallet.getKeyset();
      if (
        !selected ||
        !/^01[0-9a-f]{64}$/.test(selected.id) ||
        selected.unit !== unit ||
        selected.conditional !== undefined ||
        selected.verify() !== true
      )
        throw new Error("BOLT11 mint output keyset is invalid");
      const pinned = {
        id: selected.id,
        unit: selected.unit,
        fee: selected.fee,
        expiry: selected.expiry,
        keys: { ...selected.keys },
      };
      const counters = new BrowserWalletCounterDexieStore({
        database: context.database,
        scopeId: context.scopeId,
        isCurrentProfile: () => {
          context.requireCapturedProfile();
          return true;
        },
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const transcript = createSpeculativeCounterTranscript([
          await counters.readSnapshotInContext({ mintUrl, unit }, pinned.id),
        ]);
        const draftWallet = await createUncachedWalletForMnemonicUnit({
          mintUrl,
          unit,
          mnemonic: context.mnemonic,
          scopeId: context.scopeId,
          database: context.database,
          requireCapturedProfile: context.requireCapturedProfile,
          counterSource: transcript.counterSource,
        });
        const keyset = draftWallet.getKeyset(pinned.id);
        if (
          keyset.id !== pinned.id ||
          keyset.unit !== pinned.unit ||
          keyset.fee !== pinned.fee ||
          keyset.expiry !== pinned.expiry ||
          keyset.conditional !== undefined ||
          keyset.verify() !== true ||
          JSON.stringify(Object.entries(keyset.keys).sort()) !==
            JSON.stringify(Object.entries(pinned.keys).sort())
        )
          throw new Error("BOLT11 mint pinned keyset changed");
        const prepared = await prepareExactMintOperation({
          context,
          wallet: draftWallet,
          quote,
          mintQuote,
          unit,
          keysetId: pinned.id,
          transcript,
        });
        context.requireCapturedProfile();
        await context.observePrepared?.(structuredClone(prepared.operation));
        context.requireCapturedProfile();
        try {
          const persisted = await persistQuoteAndOperation({
            context,
            quote,
            ...prepared,
            unit,
            transcript,
            counterStore: counters,
          });
          context.injectPreparationFault?.("after-commit");
          context.requireCapturedProfile();
          return { quote: persisted, invoiceRequest: persisted.invoiceRequest };
        } catch (error) {
          context.requireCapturedProfile();
          const saved = await context.database.transaction(
            "r",
            [context.database.mintQuotes, context.database.proofOperations],
            () => selectSavedQuote(context, quote),
          );
          context.requireCapturedProfile();
          if (saved !== null) return { quote: saved, invoiceRequest: saved.invoiceRequest };
          if (!(error instanceof BrowserWalletCounterSnapshotConflictError) || attempt === 2)
            throw error;
        }
      }
      throw new Error("BOLT11 mint preparation exhausted");
    },
    context.lockManager,
  );
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

/** Subscribe one visible quote. PAID is reported only after exact admission. */
export async function subscribeActiveBrowserDurableBolt11MintQuote(
  input: ActiveBrowserDurableBolt11MintQuoteSubscription,
): Promise<() => void> {
  const quote = decodeDurableBolt11MintQuote(input.quote);
  return waitForMintQuotePaidForUnit(
    toMintQuoteResponse(quote),
    (result) => forwardActiveQuoteResult(input, result),
    input.options,
    quote.mintUrl,
    requireUnit(quote.unit),
  );
}

async function forwardActiveQuoteResult(
  input: ActiveBrowserDurableBolt11MintQuoteSubscription,
  result: MintQuoteWaitResult,
): Promise<void> {
  if (result.status !== "PAID") {
    input.onResult(result);
    return;
  }
  try {
    await recoverBrowserDurableBolt11MintQuotePaid(input.quote.quoteRecordId);
    input.onResult(result);
  } catch (error) {
    input.onResult({ status: "ERROR", error: asError(error), quote: result.quote });
  }
}

/** Recover the bound operation after authoritative PAID waiter evidence. */
export async function recoverBrowserDurableBolt11MintQuotePaid(
  quoteRecordId: string,
): Promise<void> {
  const context = captureBrowserMintPersistenceContext();
  const row = await context.database.mintQuotes.get([context.scopeId, "bolt11", quoteRecordId]);
  context.requireCapturedProfile();
  if (!row) throw new Error("BOLT11 mint quote is absent");
  const quote = readQuoteRow(context.scopeId, row);
  const observed = await markQuoteRecoveryAttempt(context, quote.quoteRecordId, Date.now(), "PAID");
  await recoverExactBoundQuote(context, observed);
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
  keysetId: string;
  transcript: SpeculativeCounterTranscript;
}): Promise<{
  operation: ReturnType<typeof serializeDurableWalletMintOperation>;
  counters: { keysetId: string; start: number; count: number };
}> {
  let callbacks = 0;
  let counters: OperationCounters | undefined;
  const preview = await input.wallet.prepareMint(
    "bolt11",
    Number(input.quote.requestedAmount),
    input.mintQuote,
    {
      keysetId: input.keysetId,
      onCountersReserved: (reserved) => {
        callbacks += 1;
        counters = reserved;
      },
    },
  );
  input.context.requireCapturedProfile();
  const allocations = input.transcript.allocations();
  const allocation = allocations[0];
  if (
    callbacks !== 1 ||
    !counters ||
    counters.count <= 0 ||
    allocations.length !== 1 ||
    !allocation ||
    allocation.keysetId !== input.keysetId ||
    counters.keysetId !== input.keysetId ||
    counters.start !== allocation.start ||
    counters.count !== allocation.count ||
    counters.next !== allocation.start + allocation.count ||
    preview.outputData.length !== allocation.count ||
    preview.outputData.some((output) => output.blindedMessage.id !== input.keysetId)
  )
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
  transcript: SpeculativeCounterTranscript;
  counterStore: BrowserWalletCounterDexieStore;
}): Promise<DurableBolt11MintQuote> {
  const bound = bindDurableBolt11MintQuoteOperation(input.quote, input.operation);
  const custody = toDurableCustodyProofOperationInput(input.operation);
  input.context.requireCapturedProfile();
  return input.context.database.transaction(
    "rw",
    [
      input.context.database.mintQuotes,
      input.context.database.proofOperations,
      input.context.database.walletCounterAssociations,
      input.context.database.walletCounterCursors,
      input.context.database.custodyProofs,
      input.context.database.custodyProofBackupAuthorities,
      input.context.database.custodyConditionalKeysets,
      input.context.database.encryptedWalletBackupV2DesiredAssets,
      input.context.database.encryptedWalletBackupOwnerAcceptedHeads,
      input.context.database.encryptedWalletBackupV2AcceptedHeads,
    ],
    async () => {
      input.context.requireCapturedProfile();
      await requireBrowserWalletNewWritePermission({
        database: input.context.database,
        scopeId: input.context.scopeId,
      });
      input.context.requireCapturedProfile();
      const existing = await selectSavedQuote(input.context, input.quote);
      if (existing !== null) return existing;
      const changes = input.transcript.changes();
      if (
        changes.length !== 1 ||
        changes[0]!.keysetId !== input.counters.keysetId ||
        changes[0]!.nextCounter !== input.counters.start + input.counters.count ||
        (changes[0]!.expectedNextCounter ?? 0) !== input.counters.start
      )
        throw new Error("BOLT11 mint counter transcript is invalid");
      await input.counterStore.compareAndAdvanceInCurrentTransaction(
        Dexie.currentTransaction!,
        { mintUrl: input.quote.mintUrl, unit: input.unit },
        changes[0]!,
      );
      input.context.injectPreparationFault?.("counter-written");
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
      input.context.injectPreparationFault?.("journal-bound");
      await input.context.database.mintQuotes.add(toQuoteRow(input.context.scopeId, bound));
      await requireBrowserWalletNewWritePermission({
        database: input.context.database,
        scopeId: input.context.scopeId,
      });
      input.context.requireCapturedProfile();
      return bound;
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

async function selectSavedQuote(
  context: CoordinatorContext,
  candidate: DurableBolt11MintQuote,
): Promise<DurableBolt11MintQuote | null> {
  context.requireCapturedProfile();
  const row = await context.database.mintQuotes.get([
    context.scopeId,
    "bolt11",
    candidate.quoteRecordId,
  ]);
  if (row === undefined) {
    if (await getProofOperation(candidate.walletMintOperationId, context.database))
      throw new Error("BOLT11 mint quote binding is incomplete");
    return null;
  }
  const saved = readQuoteRow(context.scopeId, row);
  assertSameQuoteRequest(saved, candidate);
  await exactBoundOperation(context.database, saved);
  context.requireCapturedProfile();
  return saved;
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
    await recoverExactBoundQuote(context, current);
    return true;
  } catch {
    await markQuoteRecoveryAttempt(context, row.quoteRecordId, passCutoffMs, null).catch(() => {});
    return false;
  }
}

async function recoverExactBoundQuote(
  context: CoordinatorContext,
  quote: DurableBolt11MintQuote,
): Promise<void> {
  const unit = requireUnit(quote.unit);
  const wallet = await getWalletForMnemonicUnit(quote.mintUrl, unit, context.mnemonic);
  context.requireCapturedProfile();
  const operation = await exactBoundOperation(context.database, quote);
  const baseAsset = normalizeMarketBaseAsset(COLLATERAL_UNIT_REGISTRY[unit].baseAsset);
  const result = await runDurableWalletMintOperation({
    mode: "recover",
    operationId: operation.operationId,
    wallet,
    store: browserDurableWalletMintStore({ baseAsset, context, unit, wallet }),
    restoreExactOutputs: (restore) => restoreExactMintOutputs(wallet, restore),
  });
  context.requireCapturedProfile();
  if (result.state === "nonterminal") throw new Error("BOLT11 mint quote remains pending");
  await markQuoteRecoveryCompleted(context, quote.quoteRecordId);
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

function toMintQuoteResponse(quote: DurableBolt11MintQuote): MintQuoteResponse {
  return {
    quote: quote.quoteId,
    request: quote.invoiceRequest,
    expiry: quote.expiryUnixSeconds ?? undefined,
  } as MintQuoteResponse;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
