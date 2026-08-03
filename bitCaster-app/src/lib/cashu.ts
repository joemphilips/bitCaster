/**
 * cashu-ts wallet helpers for bitCaster.
 *
 * Responsibilities:
 *  - Initialize a CashuWallet connected to a configured mint
 *  - Provide typed helpers for CTF (Conditional Token Framework) operations
 *    as specified in NUT-CTF, NUT-CTF-split-merge, and NUT-CTF-numeric
 *  - Wrap common operations: mint, send, receive, melt
 */

import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  getEncodedTokenV4,
  getDecodedToken,
  type MintKeys,
  type Proof,
  type MintQuoteResponse,
  type MeltQuoteResponse,
  type PartialMintQuoteResponse,
  type Token,
  type OperationCounters,
  verifyProofsForReceive,
} from "@cashu/cashu-ts";
import { getWalletForMnemonicUnit, useWalletStore } from "@/stores/wallet";
import {
  activeBrowserWalletScopeId,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import { normalizeUrl } from "@/lib/url";
import {
  addProofs,
  getUnitProofs,
  getProofOperation,
  getProofOperations,
  markProofOperationCompleted,
  markProofOperationFailed,
  prepareProofOperation,
  removeProofs,
  db,
  type BitcasterDB,
  type StoredProof,
} from "@/stores/proof-db";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from "@bitcaster/client-sdk/ctfSplit";
import {
  buildKeysetRedeemOperationId,
  readAuthenticatedCtfRedeemTerminalEvidence,
  redeemOutcomeLegWithOperation,
} from "@bitcaster/client-sdk/ctfRedeem";
import {
  COLLATERAL_UNIT_REGISTRY,
  DEFAULT_MARKET_BASE_ASSET,
  collateralScaleForUnit,
  defaultCollateralUnit,
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
  type CashuProofUnit,
  type MarketBaseAsset,
} from "@bitcaster/client-sdk/marketUnits";
import { proofsWithOptionalConditionalMetadata } from "@/lib/conditionalKeysetMetadata";
import { admitBrowserReceivedProofs } from "@/lib/browserCustodyProofReceive";
import { toSeed } from "@/lib/bip39";
import {
  hydrateDurableWalletMintPreview,
  isDurableWalletMintDuplicateOutputsError,
  requireDurableWalletMintJournal,
  runDurableWalletMintOperation,
  serializeDurableWalletMintOperation,
  toDurableCustodyProofOperationInput,
} from "@bitcaster/client-sdk/durableWalletOperation";

// ---------------------------------------------------------------------------
// Default mint (can be overridden at runtime)
// ---------------------------------------------------------------------------

const DEFAULT_MINT_URL = normalizeUrl(import.meta.env.VITE_MINT_URL ?? "http://localhost:8085");

/**
 * Small sats buffer added to top-up prefills to cover NUT-05 melt fees and
 * the counterparty's expected fee contribution during atomic-swap. Users can
 * raise this in the UI; the prefill just avoids the common case where the
 * user funds exactly `deficit` and then can't afford mint-side overhead.
 */
export const FEE_BUFFER_SATS = 10;

// ---------------------------------------------------------------------------
// Singleton wallet — delegates to wallet store when available
// ---------------------------------------------------------------------------

let _wallet: CashuWallet | null = null;
let _mintUrl: string = DEFAULT_MINT_URL;
let _walletUnit: CashuProofUnit = defaultCollateralUnit("sat");

/** Return the shared CashuWallet, initialising it lazily. */
export async function getWallet(
  mintUrl: string | undefined,
  baseAsset: MarketBaseAsset,
): Promise<CashuWallet> {
  // If the wallet store has a mnemonic, delegate to it for deterministic secrets
  const store = useWalletStore.getState();
  const unit = defaultCollateralUnit(baseAsset);
  if (store.mnemonic) {
    return store.getWallet(mintUrl, baseAsset);
  }

  // Fallback for pre-setup usage
  const url = mintUrl ?? _mintUrl;

  if (!_wallet || url !== _mintUrl || unit !== _walletUnit) {
    _mintUrl = url;
    _walletUnit = unit;
    const mint = new CashuMint(url);
    _wallet = new CashuWallet(mint, { unit });
    await _wallet.loadMint();
  }

  return _wallet;
}

/** Return a wallet for an explicit Cashu unit (for non-CTF regular units). */
export async function getWalletForUnit(
  mintUrl: string | undefined,
  unit: string,
): Promise<CashuWallet> {
  const normalizedUnit = requireCashuProofUnit(unit);

  const store = useWalletStore.getState();
  if (store.mnemonic) {
    return store.getWalletForUnit(mintUrl, normalizedUnit);
  }

  const url = mintUrl ?? _mintUrl;
  if (!_wallet || url !== _mintUrl || normalizedUnit !== _walletUnit) {
    _mintUrl = url;
    _walletUnit = normalizedUnit;
    const mint = new CashuMint(url);
    _wallet = new CashuWallet(mint, { unit: normalizedUnit });
    await _wallet.loadMint();
  }

  return _wallet;
}

// ---------------------------------------------------------------------------
// Basic wallet operations
// ---------------------------------------------------------------------------

/** Request a Lightning invoice to fund the wallet. */
export async function createMintQuote(
  amountSats: number,
  mintUrl: string | undefined,
  baseAsset: MarketBaseAsset,
): Promise<MintQuoteResponse> {
  const wallet = await getWallet(mintUrl, baseAsset);
  return wallet.createMintQuote(collateralSubunitsFromBaseAmount(amountSats, baseAsset));
}

/** Request a Lightning invoice for an explicit Cashu unit, e.g. regular sat Score funds. */
export async function createMintQuoteForUnit(
  amount: number,
  mintUrl: string | undefined,
  unit: CashuProofUnit | string,
): Promise<MintQuoteResponse> {
  const wallet = await getWalletForUnit(mintUrl, unit);
  return wallet.createMintQuote(amount);
}

/** Mint proofs after the invoice in `quote` has been paid.
 *
 * Wraps cashu-ts `wallet.mintProofs` with a one-shot recovery+retry on CDK's
 * database-duplicate response. Older CDK builds surfaced this as the
 * misleading `"Invoice already paid or pending"` detail. Current CDK maps the
 * same database duplicate to `"Blinded message already signed or pending"` /
 * `ErrorCode::BlindedMessageAlreadySigned`. Both mean the wallet's
 * deterministic blinded outputs (counter-derived) collided with outputs the
 * mint already signed for this seed.
 *
 * When the safety net trips:
 *  1. Force a counter rescan against the relevant keysets (bypassing the
 *     idempotency flag — the flag's "scanned at startup" status is now
 *     irrelevant; we have evidence that another writer has advanced the
 *     mint's seen-outputs since then, e.g. another device with the same
 *     seed).
 *  2. Retry `wallet.mintProofs` ONCE. If the retry still fails — recovery
 *     didn't unstick the issue (e.g. recovery itself failed against the
 *     active keyset, or this is actually an unrelated error CDK rebadged) —
 *     propagate to the caller. */
export async function mintProofs(
  amountSats: number,
  quote: MintQuoteResponse,
  mintUrl: string | undefined,
  baseAsset: MarketBaseAsset,
): Promise<Proof[]> {
  const unit = defaultCollateralUnit(baseAsset);
  return mintAndStoreProofs({
    amount: collateralSubunitsFromBaseAmount(amountSats, baseAsset),
    quote,
    mintUrl,
    baseAsset,
    unit,
  });
}

interface MintAndStoreProofsInput {
  readonly amount: number;
  readonly quote: MintQuoteResponse;
  readonly mintUrl: string | undefined;
  readonly baseAsset: MarketBaseAsset;
  readonly unit: CashuProofUnit;
}

interface BrowserMintPersistenceContext {
  readonly activeMintUrl: string;
  readonly database: BitcasterDB;
  readonly seed: Uint8Array;
  readonly scopeId: string;
  requireCapturedProfile(): void;
}

async function mintAndStoreProofs(input: MintAndStoreProofsInput): Promise<Proof[]> {
  const { amount, quote, mintUrl, baseAsset, unit } = input;
  const context = captureBrowserMintPersistenceContext();
  const normalizedMintUrl = normalizeUrl(mintUrl ?? context.activeMintUrl);
  const wallet = await getWalletForMnemonicUnit(normalizedMintUrl, unit, context.mnemonic);
  context.requireCapturedProfile();
  let latestOperationId: string | null = null;
  const mintOnce = async (): Promise<Proof[]> => {
    const beforeCounters = snapshotCountersForSuccessfulMintRepair();
    let counters: OperationCounters | undefined;
    context.requireCapturedProfile();
    const preview = await wallet.prepareMint("bolt11", amount, quote, {
      onCountersReserved: (reserved) => {
        counters = reserved;
      },
    });
    context.requireCapturedProfile();
    if (!counters || counters.count <= 0) {
      throw new Error("Cashu mint did not reserve a deterministic recovery range");
    }
    const operationId = `wallet-mint:${crypto.randomUUID()}`;
    latestOperationId = operationId;
    const durable = serializeDurableWalletMintOperation({
      operationId,
      mintUrl: normalizedMintUrl,
      unit,
      preview,
    });
    const custody = toDurableCustodyProofOperationInput(durable);
    context.requireCapturedProfile();
    await prepareProofOperation(
      {
        operationId,
        kind: "wallet-mint",
        mintUrl: normalizedMintUrl,
        inputs: [],
        outputs: structuredClone(custody.outputs) as unknown as Record<
          string,
          import("@/stores/proof-db").StoredOutputData[]
        >,
        metadata: {
          ...custody.metadata,
          baseAsset,
          keysetId: counters.keysetId,
          counterStart: counters.start,
          counterCount: counters.count,
        },
      },
      context.database,
    );
    context.requireCapturedProfile();
    const result = await runDurableWalletMintOperation({
      mode: "execute",
      operationId,
      currentPreview: preview,
      wallet,
      store: browserDurableWalletMintStore({ baseAsset, context, unit, wallet }),
      restoreExactOutputs: (recovery) => restoreExactMintOutputs(wallet, recovery),
    });
    context.requireCapturedProfile();
    if (result.state === "nonterminal")
      throw new Error("wallet mint did not reach a terminal state");
    const proofs = result.proofs;
    context.requireCapturedProfile();
    repairCountersAfterSuccessfulMint(proofs, beforeCounters);
    context.requireCapturedProfile();
    return proofs;
  };
  try {
    return await mintOnce();
  } catch (err) {
    if (!isDurableWalletMintDuplicateOutputsError(err)) throw err;
    if (latestOperationId !== null) {
      context.requireCapturedProfile();
      await markProofOperationFailed(latestOperationId, err, context.database);
      context.requireCapturedProfile();
    }
    context.requireCapturedProfile();
    const url = normalizeUrl(mintUrl ?? context.activeMintUrl);
    const result = await recoverKeysetCountersForMint(url, { force: true, baseAsset });
    context.requireCapturedProfile();
    if (!result.scannedKeysets.length) {
      // Recovery couldn't scan the active unit (network down, restore not
      // supported for that unit, stale keyset metadata). Skip a bounded
      // deterministic counter window before the one allowed retry so local
      // wallets can still escape a stale counter without looping forever.
      const bumped = await bumpActiveKeysetCounter(wallet, baseAsset).catch(() => false);
      context.requireCapturedProfile();
      if (!bumped) throw err;
    }
    // ZustandCounterSource.reserve() reads from the live store on every
    // call (`stores/wallet.ts:65`), so the cached cashu-ts wallet picks up
    // the recovered counter on the retry without rebuilding the wallet.
    return await mintOnce();
  }
}

function captureBrowserMintPersistenceContext(): BrowserMintPersistenceContext & {
  readonly mnemonic: string;
} {
  const state = useWalletStore.getState();
  const mnemonic = state.mnemonic;
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  if (scopeId === null || !mnemonic) throw new Error("The wallet profile is unavailable");
  return {
    activeMintUrl: state.activeMintUrl,
    database: db,
    mnemonic,
    seed: toSeed(mnemonic.trim().split(/\s+/)),
    scopeId,
    requireCapturedProfile: () => {
      if (activeBrowserWalletScopeId() !== scopeId) {
        throw new Error("The wallet profile changed during mint recovery.");
      }
    },
  };
}

/** Mint proofs for an explicit Cashu unit, without market-collateral scaling. */
export async function mintProofsForUnit(
  amount: number,
  quote: MintQuoteResponse,
  mintUrl: string | undefined,
  unit: CashuProofUnit | string,
): Promise<Proof[]> {
  const proofUnit = requireCashuProofUnit(unit);
  return mintAndStoreProofs({
    amount,
    quote,
    mintUrl,
    baseAsset: COLLATERAL_UNIT_REGISTRY[proofUnit].baseAsset,
    unit: proofUnit,
  });
}

function browserDurableWalletMintStore(input: {
  readonly baseAsset: MarketBaseAsset;
  readonly context: BrowserMintPersistenceContext;
  readonly unit: CashuProofUnit;
  readonly wallet: CashuWallet;
}) {
  return {
    loadOperation: async (operationId: string) => {
      input.context.requireCapturedProfile();
      const record = await getProofOperation(operationId, input.context.database);
      input.context.requireCapturedProfile();
      if (!record) return null;
      const operation = requireDurableWalletMintJournal({
        operationId: record.operationId,
        kind: record.kind,
        mintUrl: record.mintUrl,
        unit: record.metadata.unit,
        outputs: record.outputs,
        metadata: record.metadata,
      });
      return mintSnapshotFromRecord(operation, record);
    },
    persistCompletedResult: async ({
      operation,
      result,
    }: {
      operation: ReturnType<typeof requireDurableWalletMintJournal>;
      result: { receive: readonly Proof[] };
    }) => {
      input.context.requireCapturedProfile();
      await persistBrowserMintProofs({
        operationId: operation.operationId,
        mintUrl: operation.mintUrl,
        baseAsset: input.baseAsset,
        unit: input.unit,
        wallet: input.wallet,
        proofs: result.receive,
        context: input.context,
      });
      input.context.requireCapturedProfile();
      return "completed" as const;
    },
  };
}

function mintSnapshotFromRecord(
  operation: ReturnType<typeof requireDurableWalletMintJournal>,
  record: Awaited<ReturnType<typeof getProofOperation>> & {},
) {
  if (record === null) throw new Error("durable wallet mint operation is absent");
  switch (record.state as string) {
    case "prepared":
      return { operation, state: "prepared", result: null } as const;
    case "completed": {
      const receive = record.resultProofs?.receive;
      return { operation, state: "completed", result: receive ? { receive } : null } as const;
    }
    case "Failed":
      throw new Error("durable wallet mint was abandoned");
    default:
      throw new Error("durable wallet mint state is invalid");
  }
}

async function restoreExactMintOutputs(
  wallet: CashuWallet,
  input: {
    readonly mintUrl: string;
    readonly unit: string;
    readonly outputs: readonly {
      blindedMessage: { amount: string; id: string; B_: string };
      blindingFactor: string;
      secret: string;
      ephemeralE: string | null;
    }[];
  },
): Promise<Proof[]> {
  const preview = hydrateDurableWalletMintPreview({
    schemaVersion: 1,
    operationId: "restore-only",
    kind: "wallet-mint",
    mintUrl: input.mintUrl,
    unit: input.unit,
    preview: {
      method: "bolt11",
      quoteExpiryUnixSeconds: null,
      payload: {
        quote: "restore-only",
        outputs: input.outputs.map((output) => output.blindedMessage),
        signature: null,
      },
      outputData: [...input.outputs],
      keysetId: input.outputs[0]?.blindedMessage.id ?? "",
    },
  });
  const response = await wallet.mint.restore({
    outputs: preview.outputData.map((output) => output.blindedMessage),
  });
  if (response.outputs.length !== response.signatures.length) {
    throw new Error("mint restore response is incomplete");
  }
  const signatures = new Map(
    response.outputs.map((output, index) => [output.B_, response.signatures[index]]),
  );
  if (
    signatures.size !== response.outputs.length ||
    response.outputs.length !== preview.outputData.length
  ) {
    throw new Error("mint restore response conflicts with persisted outputs");
  }
  const keyset = wallet.getKeyset(preview.keysetId);
  if (keyset.unit !== input.unit || !keyset.verify())
    throw new Error("mint restore keyset is invalid");
  const proofs = preview.outputData.map((output) => {
    const signature = signatures.get(output.blindedMessage.B_);
    if (!signature) throw new Error("mint restore response omits a persisted output");
    return output.toProof(signature, keyset);
  });
  return proofs;
}

/** Recover only persisted Lightning mints. Never create fresh blinded outputs at startup. */
export async function recoverPendingWalletMints(): Promise<{ pending: number }> {
  let context: ReturnType<typeof captureBrowserMintPersistenceContext>;
  try {
    context = captureBrowserMintPersistenceContext();
  } catch {
    return { pending: 0 };
  }
  const records = await getProofOperations(
    { states: ["prepared"], kinds: ["wallet-mint"] },
    context.database,
  );
  context.requireCapturedProfile();
  let pending = 0;
  for (const record of records) {
    try {
      context.requireCapturedProfile();
      const operation = requireDurableWalletMintJournal({
        operationId: record.operationId,
        kind: record.kind,
        mintUrl: record.mintUrl,
        unit: record.metadata.unit,
        outputs: record.outputs,
        metadata: record.metadata,
      });
      const unit = requireCashuProofUnit(operation.unit);
      const baseAsset = normalizeMarketBaseAsset(record.metadata.baseAsset as string);
      if (COLLATERAL_UNIT_REGISTRY[unit].baseAsset !== baseAsset) {
        throw new Error("durable wallet mint unit is incompatible with its base asset");
      }
      const wallet = await getWalletForMnemonicUnit(operation.mintUrl, unit, context.mnemonic);
      context.requireCapturedProfile();
      await runDurableWalletMintOperation({
        mode: "recover",
        operationId: operation.operationId,
        wallet,
        store: browserDurableWalletMintStore({
          baseAsset,
          context,
          unit,
          wallet,
        }),
        restoreExactOutputs: (input) => restoreExactMintOutputs(wallet, input),
      });
      context.requireCapturedProfile();
    } catch {
      pending += 1;
    }
  }
  return { pending };
}

async function persistBrowserMintProofs(input: {
  readonly operationId: string;
  readonly mintUrl: string;
  readonly baseAsset: MarketBaseAsset;
  readonly unit: CashuProofUnit;
  readonly wallet: CashuWallet;
  readonly proofs: readonly Proof[];
  readonly context: BrowserMintPersistenceContext;
}): Promise<void> {
  input.context.requireCapturedProfile();
  verifyProofsForReceive([...input.proofs], (keysetId) => input.wallet.getKeyset(keysetId), {
    requireDleq: true,
  });
  input.context.requireCapturedProfile();
  const stored = input.proofs.map((proof) => ({
    ...proof,
    mintUrl: input.mintUrl,
    baseAsset: input.baseAsset,
    unit: input.unit,
  }));
  await admitBrowserReceivedProofs({
    seed: input.context.seed,
    sourceOperationId: input.operationId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    wallet: input.wallet,
    proofs: stored,
    database: input.context.database,
  });
  input.context.requireCapturedProfile();
  await addProofs(stored, input.context.database);
  input.context.requireCapturedProfile();
  await markProofOperationCompleted(
    input.operationId,
    { receive: [...input.proofs] },
    input.context.database,
  );
  input.context.requireCapturedProfile();
}

function collateralSubunitsFromBaseAmount(
  amountSats: number,
  baseAsset?: MarketBaseAsset | string | null,
): number {
  const base = normalizeMarketBaseAsset(baseAsset);
  const unit = defaultCollateralUnit(base);
  const subunits = amountSats * collateralScaleForUnit(unit);
  if (!Number.isSafeInteger(subunits)) {
    throw new Error(`Amount exceeds safe integer range for ${unit}: ${amountSats}`);
  }
  return subunits;
}

function snapshotCountersForSuccessfulMintRepair(): Record<string, number> | null {
  if (!useWalletStore.getState().mnemonic) return null;
  return { ...useWalletStore.getState().keysetCounters };
}

function repairCountersAfterSuccessfulMint(
  proofs: Proof[],
  beforeCounters: Record<string, number> | null,
): void {
  if (!beforeCounters || proofs.length === 0) return;
  const mintedByKeyset = new Map<string, number>();
  for (const proof of proofs) {
    if (!proof.id) continue;
    mintedByKeyset.set(proof.id, (mintedByKeyset.get(proof.id) ?? 0) + 1);
  }
  if (mintedByKeyset.size === 0) return;
  useWalletStore.setState((s) => {
    let changed = false;
    const nextCounters = { ...s.keysetCounters };
    for (const [keysetId, mintedCount] of mintedByKeyset) {
      const floor = (beforeCounters[keysetId] ?? 0) + mintedCount;
      const current = nextCounters[keysetId] ?? 0;
      if (current < floor) {
        nextCounters[keysetId] = floor;
        changed = true;
      }
    }
    return changed ? { keysetCounters: nextCounters } : s;
  });
}

export interface KeysetRecoveryResult {
  /** Keyset IDs that were scanned (regardless of whether anything new was
   *  found). Empty means recovery couldn't run (e.g. mint unreachable). */
  scannedKeysets: string[];
  complete: boolean;
}

type RecoverableMintKeyset = {
  id: string;
  unit?: string | null;
};

const COUNTER_RECOVERY_FALLBACK_SKIP = 100;

function keysetCashuUnit(keyset: RecoverableMintKeyset): CashuProofUnit {
  return parseCashuProofUnit(keyset.unit) ?? defaultCollateralUnit(DEFAULT_MARKET_BASE_ASSET);
}

async function bumpActiveKeysetCounter(
  wallet: CashuWallet,
  baseAsset?: MarketBaseAsset | string | null,
): Promise<boolean> {
  const keyset = wallet.getKeyset();
  if (!keyset?.id) return false;
  useWalletStore.setState((s) => {
    const current = s.keysetCounters[keyset.id] ?? 0;
    return {
      keysetCounters: {
        ...s.keysetCounters,
        [keyset.id]: current + COUNTER_RECOVERY_FALLBACK_SKIP,
      },
    };
  });
  console.warn(
    `[cashu] counter recovery could not scan ${normalizeMarketBaseAsset(baseAsset)} keyset ${keyset.id}; advanced by ${COUNTER_RECOVERY_FALLBACK_SKIP}`,
  );
  return true;
}

/**
 * Walk the mint's seen-outputs space (via cashu-ts `batchRestore`) for every
 * keyset of `mintUrl`, advance `keysetCounters[keysetId]` past the highest
 * existing signed output, persist any UNSPENT recovered proofs to IndexedDB,
 * and mark the keyset recovered.
 *
 * Two callers:
 *  - `App.tsx` startup migration — once per mint at app load. Skips keysets
 *    whose `keysetCountersRecovered[id]` flag is already set (idempotent).
 *  - `mintProofs` safety-net catch — passes `{ force: true }` so the flag
 *    is BYPASSED. The flag captures "we scanned at app start"; a duplicate
 *    error proves our counter is stale despite the flag (e.g. another
 *    device minted with the same seed since startup).
 *
 * Returns the list of keyset IDs that were actually scanned so the caller
 * can decide whether a retry is worthwhile.
 */
export async function recoverKeysetCountersForMint(
  mintUrl: string,
  opts: { force?: boolean; baseAsset?: MarketBaseAsset | string | null } = {},
): Promise<KeysetRecoveryResult> {
  const url = normalizeUrl(mintUrl);
  const store = useWalletStore.getState();
  if (!store.mnemonic) return { scannedKeysets: [], complete: true };
  const scopeId = browserWalletScopeIdFromMnemonic(store.mnemonic);
  if (scopeId === null) return { scannedKeysets: [], complete: true };
  const requireCapturedProfile = () => {
    if (activeBrowserWalletScopeId() !== scopeId) {
      throw new Error("The wallet profile changed during counter recovery.");
    }
  };
  const requestedBaseAsset =
    opts.baseAsset === undefined || opts.baseAsset === null
      ? null
      : normalizeMarketBaseAsset(opts.baseAsset);
  const discoveryUnit = defaultCollateralUnit(requestedBaseAsset ?? DEFAULT_MARKET_BASE_ASSET);
  const discoveryWallet = (await store.getWalletForUnit(url, discoveryUnit)) as CashuWallet;
  // Use the wallet's freshly-loaded keysets via the underlying mint, not the
  // possibly-stale `store.mints[].keysets`. After mint key rotation the
  // store can be days behind; the duplicate-error path needs to scan
  // whatever keyset the wallet is actually trying to mint against right now.
  const fresh = await discoveryWallet.mint.getKeySets().catch(() => null);
  requireCapturedProfile();
  const keysets: RecoverableMintKeyset[] =
    fresh?.keysets ?? store.mints.find((m) => m.url === url)?.keysets ?? [];
  const units = Array.from(
    new Set(
      keysets
        .map(keysetCashuUnit)
        .filter(
          (unit) =>
            requestedBaseAsset === null ||
            COLLATERAL_UNIT_REGISTRY[unit].baseAsset === requestedBaseAsset,
        ),
    ),
  );
  const scanned: string[] = [];
  let complete = fresh !== null || keysets.length > 0;
  for (const unit of units) {
    const wallet =
      unit === discoveryUnit
        ? discoveryWallet
        : ((await store.getWalletForUnit(url, unit)) as CashuWallet);
    for (const keyset of keysets.filter((k) => keysetCashuUnit(k) === unit)) {
      const recovered = useWalletStore.getState().keysetCountersRecovered[keyset.id];
      if (!opts.force && recovered) continue;
      try {
        const { proofs, lastCounterWithSignature } = await wallet.batchRestore(
          300,
          100,
          0,
          keyset.id,
        );
        requireCapturedProfile();
        const next = lastCounterWithSignature !== undefined ? lastCounterWithSignature + 1 : 0;
        const current = useWalletStore.getState().keysetCounters[keyset.id] ?? 0;
        const advanced = Math.max(current, next);
        useWalletStore.setState((s) => ({
          keysetCounters: { ...s.keysetCounters, [keyset.id]: advanced },
        }));
        // CRITICAL: batchRestore returns ALL deterministic proofs the mint
        // ever signed for this seed, including SPENT ones. Persisting spent
        // proofs would inflate the displayed balance and cause spent-token
        // errors on the next spend. Filter via `groupProofsByState` and keep
        // only UNSPENT. PENDING is also excluded — those are mid-flight on
        // another device and will resolve to SPENT or UNSPENT shortly.
        if (proofs.length > 0) {
          // Classification failure is nonterminal. Let the outer catch keep
          // `keysetCountersRecovered` false so startup retries rather than
          // permanently suppressing proofs it could not safely classify.
          const grouped = await wallet.groupProofsByState(proofs);
          requireCapturedProfile();
          const safe = grouped.unspent;
          if (safe.length > 0) {
            const stored: StoredProof[] = safe.map((p) => ({
              ...p,
              mintUrl: url,
              baseAsset: COLLATERAL_UNIT_REGISTRY[unit].baseAsset,
              unit,
            }));
            await addProofs(stored);
            requireCapturedProfile();
          }
        }
        // Mark the scan complete only after every recovered UNSPENT proof is
        // durably stored. A quota/IndexedDB failure must leave this false so
        // the next startup retries the same keyset.
        useWalletStore.setState((s) => ({
          keysetCountersRecovered: {
            ...s.keysetCountersRecovered,
            [keyset.id]: true,
          },
        }));
        scanned.push(keyset.id);
      } catch {
        // Best-effort: if this keyset's recovery fails (mint unreachable,
        // keyset rotated, etc.) leave the flag unset so the next trip
        // retries. Fall through to the next keyset.
        complete = false;
      }
    }
  }
  return { scannedKeysets: scanned, complete };
}

/** Encode proofs as a cashuV4 token string ready to share. */
export function encodeToken(proofs: Proof[], mintUrl?: string, unit?: CashuProofUnit): string {
  const token: Token = { mint: mintUrl ?? _mintUrl, proofs, unit };
  return getEncodedTokenV4(token);
}

/** Decode a cashu token string into proofs.
 *  Fetches mint keyset IDs to expand v1 short keyset IDs when needed.
 *  Searches ALL configured mints' keysets (not just active) for cross-mint tokens. */
export async function decodeToken(tokenStr: string): Promise<Token> {
  // First try without keysets (works for v0 keyset IDs and full-length IDs)
  try {
    return getDecodedToken(tokenStr, []);
  } catch {
    // v1 short keyset IDs need expansion — try all configured mints' stored keysets first
    const store = useWalletStore.getState();
    const allStoredKeysetIds = store.mints.flatMap((m) => m.keysets ?? []).map((k) => k.id);

    if (allStoredKeysetIds.length > 0) {
      try {
        return getDecodedToken(tokenStr, allStoredKeysetIds);
      } catch {
        // Fall through to fetch from active mint
      }
    }

    // P8 fix: a v4 cashuB token from an unconfigured mint (e.g. a testnut
    // token pasted from cashu.me) lands here. The active-mint fallback below
    // would fetch the WRONG keysets and throw "Couldn't map short keyset ID".
    // Pre-extract the mint URL from the v4 CBOR payload so we can fetch
    // keysets from the issuing mint.
    const mintFromToken = extractMintUrlFromV4Token(tokenStr);
    const mintUrl = mintFromToken ?? store.activeMintUrl ?? _mintUrl;
    const mint = new CashuMint(mintUrl);
    const { keysets } = await mint.getKeySets();
    const keysetIds = keysets.map((k) => k.id);
    return getDecodedToken(tokenStr, keysetIds);
  }
}

/**
 * Extract the mint URL from a v4 cashuB token's CBOR payload without needing
 * keyset knowledge. Used as a pre-decode step so that a token issued by an
 * unconfigured mint (e.g. testnut.cashu.space pasted from cashu.me) can have
 * its keysets fetched directly rather than against the user's active mint —
 * which would otherwise throw "Couldn't map short keyset ID" and break the
 * receive flow. Returns null if the token isn't v4 or the parse fails.
 */
export function extractMintUrlFromV4Token(tokenStr: string): string | null {
  if (!tokenStr.startsWith("cashuB")) return null;
  try {
    const b64 = tokenStr.slice(6).replaceAll("-", "+").replaceAll("_", "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return walkCborForMintUrl(bytes);
  } catch {
    return null;
  }
}

// Minimal CBOR walker: read the top-level map and return the value of the
// "m" key (the v4 cashu mint-url field). Supports the small subset of CBOR
// that cashu v4 emits — see NUT-00 §3.2. CBOR major types per RFC 8949 §3.1:
// 0=uint, 1=neg-int, 2=bytes, 3=text, 4=array, 5=map, 6=tag, 7=simple/float.
// Additional info 24/25/26 means the length follows in 1/2/4 bytes.
function walkCborForMintUrl(b: Uint8Array): string | null {
  if ((b[0] & 0xe0) !== 0xa0) return null; // top-level must be a map
  const [n, start] = readLen(b, 0);
  let i = start;
  for (let e = 0; e < n; e++) {
    const [key, j] = readString(b, i);
    if (key === "m") return readString(b, j)[0];
    i = skipValue(b, j);
  }
  return null;
}

function readLen(b: Uint8Array, i: number): [number, number] {
  const ai = b[i] & 0x1f;
  if (ai < 24) return [ai, i + 1];
  if (ai === 24) return [b[i + 1], i + 2];
  if (ai === 25) return [(b[i + 1] << 8) | b[i + 2], i + 3];
  if (ai === 26)
    return [((b[i + 1] << 24) | (b[i + 2] << 16) | (b[i + 3] << 8) | b[i + 4]) >>> 0, i + 5];
  throw new Error("CBOR len > uint32");
}

function readString(b: Uint8Array, i: number): [string, number] {
  const major = b[i] >> 5;
  if (major !== 3 && major !== 2) throw new Error("CBOR not string");
  const [len, j] = readLen(b, i);
  return [new TextDecoder().decode(b.slice(j, j + len)), j + len];
}

function skipValue(b: Uint8Array, i: number): number {
  const major = b[i] >> 5;
  if (major === 0 || major === 1 || major === 7) return readLen(b, i)[1];
  if (major === 2 || major === 3) {
    const [len, j] = readLen(b, i);
    return j + len;
  }
  if (major === 4) {
    const [n, j] = readLen(b, i);
    let p = j;
    for (let k = 0; k < n; k++) p = skipValue(b, p);
    return p;
  }
  if (major === 5) {
    const [n, j] = readLen(b, i);
    let p = j;
    for (let k = 0; k < n; k++) {
      p = skipValue(b, p);
      p = skipValue(b, p);
    }
    return p;
  }
  if (major === 6) return skipValue(b, readLen(b, i)[1]);
  throw new Error("CBOR major " + major);
}

/**
 * Receive an external bearer token with an exact write-ahead recovery record.
 *
 * cashu-ts reserves the deterministic counter range while preparing the swap.
 * We persist that range before the mint call. If the process stops after the
 * mint commits but before IndexedDB stores the successor proofs, startup can
 * restore precisely this range through NUT-09 and classify it through NUT-07.
 */
export async function receiveAndStoreTokenRecoverably(
  tokenStr: string,
  mintUrl: string,
  baseAsset: MarketBaseAsset | string | null,
  unitValue: CashuProofUnit | string,
): Promise<StoredProof[]> {
  const unit = requireCashuProofUnit(unitValue);
  const normalizedMintUrl = normalizeUrl(mintUrl);
  const normalizedBaseAsset = normalizeMarketBaseAsset(baseAsset);
  const wallet = await getWalletForUnit(normalizedMintUrl, unit);
  let counters: OperationCounters | undefined;
  const preview = await wallet.prepareSwapToReceive(
    tokenStr,
    {
      onCountersReserved: (reserved) => {
        counters = reserved;
      },
    },
    { type: "deterministic", counter: 0 },
  );
  if (!counters || counters.count <= 0) {
    throw new Error("Cashu receive did not reserve a deterministic recovery range");
  }

  const operationId = `token-receive:${crypto.randomUUID()}`;
  await prepareProofOperation({
    operationId,
    kind: "token-receive",
    mintUrl: normalizedMintUrl,
    inputs: preview.inputs,
    outputs: {},
    metadata: {
      baseAsset: normalizedBaseAsset,
      unit,
      keysetId: counters.keysetId,
      counterStart: counters.start,
      counterCount: counters.count,
    },
  });

  const { keep } = await wallet.completeSwap(preview);
  const enrichedProofs = await proofsWithOptionalConditionalMetadata({
    mintUrl: normalizedMintUrl,
    proofs: keep,
  });
  const stored = enrichedProofs.map((proof) => ({
    ...proof,
    mintUrl: normalizedMintUrl,
    baseAsset: normalizedBaseAsset,
    unit,
  }));
  const mnemonic = useWalletStore.getState().mnemonic;
  if (!mnemonic) throw new Error("The wallet profile is unavailable");
  await admitBrowserReceivedProofs({
    seed: toSeed(mnemonic.split(" ")),
    sourceOperationId: operationId,
    mintUrl: normalizedMintUrl,
    unit,
    wallet,
    proofs: stored,
  });
  await addProofs(stored);
  await markProofOperationCompleted(operationId, { receive: keep });
  return stored;
}

/** Recover every nonterminal external-token receive from its exact counter range. */
export async function recoverPendingTokenReceives(): Promise<{ pending: number }> {
  const mnemonic = useWalletStore.getState().mnemonic;
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  if (scopeId === null) return { pending: 0 };
  const requireCapturedProfile = () => {
    if (activeBrowserWalletScopeId() !== scopeId) {
      throw new Error("The wallet profile changed during token recovery.");
    }
  };
  const operations = await getProofOperations({
    states: ["prepared"],
    kinds: ["token-receive"],
  });
  let pending = 0;
  for (const operation of operations) {
    try {
      requireCapturedProfile();
      const unit = requireCashuProofUnit(
        requiredReceiveMetadataString(operation.metadata.unit, "unit"),
      );
      const baseAsset = normalizeMarketBaseAsset(
        requiredReceiveMetadataString(operation.metadata.baseAsset, "baseAsset"),
      );
      const keysetId = requiredReceiveMetadataString(operation.metadata.keysetId, "keysetId");
      const counterStart = requiredReceiveMetadataInteger(
        operation.metadata.counterStart,
        "counterStart",
        0,
      );
      const counterCount = requiredReceiveMetadataInteger(
        operation.metadata.counterCount,
        "counterCount",
        1,
      );
      const wallet = await getWalletForMnemonicUnit(operation.mintUrl, unit, mnemonic);
      const restored = await wallet.restore(counterStart, counterCount, {
        keysetId,
      });
      requireCapturedProfile();
      if (restored.proofs.length > 0) {
        const states = await wallet.groupProofsByState(restored.proofs);
        requireCapturedProfile();
        if (states.unspent.length > 0) {
          const enrichedProofs = await proofsWithOptionalConditionalMetadata({
            mintUrl: operation.mintUrl,
            proofs: states.unspent,
          });
          const stored = enrichedProofs.map((proof) => ({
            ...proof,
            mintUrl: operation.mintUrl,
            baseAsset,
            unit,
          }));
          await admitBrowserReceivedProofs({
            seed: toSeed(mnemonic.split(" ")),
            sourceOperationId: operation.operationId,
            mintUrl: operation.mintUrl,
            unit,
            wallet,
            proofs: stored,
          });
          await addProofs(stored);
          requireCapturedProfile();
        }
        if (states.pending.length === 0) {
          await markProofOperationCompleted(operation.operationId, {
            receive: restored.proofs,
          });
        } else {
          pending += 1;
        }
        continue;
      }

      // No signed outputs can race a swap request that survived page teardown.
      // Query NUT-07 for observability, but never terminalize from a transient
      // UNSPENT answer: the mint may commit immediately afterward. The small
      // prepared record remains retryable until NUT-09 yields successors.
      await wallet.groupProofsByState(operation.inputs);
      pending += 1;
    } catch {
      // Keep the prepared journal. Startup will retry; custody recovery must
      // never become terminal merely because the mint or IndexedDB is
      // temporarily unavailable.
      pending += 1;
    }
  }
  return { pending };
}

function requiredReceiveMetadataString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`token receive journal is missing ${field}`);
}

function requiredReceiveMetadataInteger(value: unknown, field: string, minimum: number): number {
  if (Number.isSafeInteger(value) && (value as number) >= minimum) {
    return value as number;
  }
  throw new Error(`token receive journal has invalid ${field}`);
}

/**
 * Send `amountSats` using the provided proofs.
 * Returns `{ keep, send }` — store `keep` proofs, share `send` proofs.
 */
export async function sendProofs(
  amount: number,
  proofs: Proof[],
  options: { mintUrl?: string; unit: CashuProofUnit },
): Promise<{ keep: Proof[]; send: Proof[] }> {
  const wallet = await getWalletForUnit(options.mintUrl, options.unit);
  return wallet.send(amount, proofs);
}

/** Spend regular sat proofs into a Cashu token and persist local change. */
export async function spendRegularSatsAsToken(
  amountSats: number,
  mintUrl: string,
): Promise<string> {
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new Error("Amount must be a positive integer number of sats.");
  }
  const unit = defaultCollateralUnit("sat");
  const proofs = await getUnitProofs(mintUrl, { unit });
  const { keep, send } = await sendProofs(amountSats, proofs, {
    mintUrl,
    unit,
  });
  await removeProofs(proofs.map((proof) => proof.secret));
  if (keep.length > 0) {
    await addProofs(
      keep.map((proof) => ({
        ...proof,
        mintUrl,
        baseAsset: "sat",
        unit,
      })),
    );
  }
  return encodeToken(send, mintUrl);
}

/** Create a melt quote for a Lightning invoice. */
export async function createMeltQuote(
  invoice: string,
  mintUrl?: string,
): Promise<MeltQuoteResponse> {
  const wallet = await getWalletForUnit(mintUrl, "sat");
  return wallet.createMeltQuote(invoice);
}

/** Melt proofs to pay a Lightning invoice. */
export async function meltProofs(
  quote: MeltQuoteResponse,
  proofs: Proof[],
  mintUrl?: string,
): Promise<{ paid: boolean; change: Proof[] }> {
  const wallet = await getWalletForUnit(mintUrl, "sat");
  const response = await wallet.meltProofs(quote, proofs);
  return {
    paid: response.quote.state === "PAID",
    change: response.change ?? [],
  };
}

/** Check the status of a mint quote. */
export async function checkMintQuote(
  quoteId: string,
  mintUrl: string | undefined,
  baseAsset: MarketBaseAsset,
): Promise<PartialMintQuoteResponse> {
  const wallet = await getWallet(mintUrl, baseAsset);
  return wallet.checkMintQuote(quoteId);
}

/**
 * Discriminated terminal result of `waitForMintQuotePaid`.
 *
 * - `PAID`    — the mint reported the bolt11 paid; caller should mint proofs.
 * - `EXPIRED` — the bolt11's `expiry` (unix-seconds) has passed; the quote is
 *               unrecoverable and the caller MUST request a new one.
 * - `ERROR`   — terminal poll failure (e.g. mint returned a non-recoverable
 *               error, or `ISSUED` arrived before we minted — see below).
 *
 * `ISSUED` from the mint is treated as terminal `ERROR`: it means the proofs
 * for this quote were already minted by some other client/session, and the
 * mint will refuse to issue them again. There is no recovery from inside this
 * helper — the caller surfaces the error and the user re-requests.
 */
export type MintQuoteWaitResult =
  | { status: "PAID"; quote: PartialMintQuoteResponse }
  | { status: "EXPIRED"; quote?: PartialMintQuoteResponse }
  | { status: "ERROR"; error: Error; quote?: PartialMintQuoteResponse };

export interface WaitForMintQuoteOptions {
  /** Bolt11 expiry as unix-seconds. Defaults to the quote's own `expiry`. */
  expiresAtSec?: number;
  /** Poll interval. Default 2s — short enough to mask <3s fakewallet latency. */
  pollIntervalMs?: number;
  /** Fired on each non-terminal poll error so the UI can surface diagnostics
   *  without tearing the wait down. */
  onTransientError?: (error: Error) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Subscribe to mint quote payment updates. Runs NUT-17 WS and polling
 * concurrently — whichever sees PAID first wins — so we don't hang when the
 * WS silently drops its subscription ACK (cashu-ts only registers the sub
 * listener *after* the ACK; if it never arrives, no error, no callback).
 *
 * Returns an unsubscribe function that tears down both paths AND the expiry
 * timer. The single `onResult` callback fires exactly once with a terminal
 * `MintQuoteWaitResult` (or never, if the caller unsubscribes first).
 *
 * Bounded by the bolt11's `expiry`: once that timestamp passes the wait
 * resolves to `EXPIRED` instead of polling forever — the bug behind P8's
 * "Waiting for payment…" forever symptom.
 */
export async function waitForMintQuotePaid(
  quote: MintQuoteResponse,
  onResult: (result: MintQuoteWaitResult) => void,
  options: WaitForMintQuoteOptions = {},
  mintUrl: string | undefined,
  baseAsset: MarketBaseAsset,
): Promise<() => void> {
  const wallet = await getWallet(mintUrl, baseAsset);
  return waitForMintQuotePaidWithWallet(wallet, quote, onResult, options);
}

/** Subscribe to mint quote payment updates for an explicit Cashu unit. */
export async function waitForMintQuotePaidForUnit(
  quote: MintQuoteResponse,
  onResult: (result: MintQuoteWaitResult) => void,
  options: WaitForMintQuoteOptions = {},
  mintUrl: string | undefined,
  unit: CashuProofUnit | string,
): Promise<() => void> {
  const wallet = await getWalletForUnit(mintUrl, unit);
  return waitForMintQuotePaidWithWallet(wallet, quote, onResult, options);
}

function waitForMintQuotePaidWithWallet(
  wallet: CashuWallet,
  quote: MintQuoteResponse,
  onResult: (result: MintQuoteWaitResult) => void,
  options: WaitForMintQuoteOptions = {},
): () => void {
  const expiresAtSec = options.expiresAtSec ?? quote.expiry ?? undefined;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let done = false;
  const isDone = () => done;
  const fire = (result: MintQuoteWaitResult) => {
    if (done) return;
    done = true;
    onResult(result);
  };

  const wsUnsub = subscribeWsForPaid(wallet, quote.quote, fire, isDone);
  const expiryTimer = scheduleExpiryTimer(expiresAtSec, fire);
  const pollHandle = startMintQuotePoll(
    wallet,
    quote.quote,
    pollIntervalMs,
    fire,
    isDone,
    options.onTransientError,
  );

  return () => {
    done = true;
    pollHandle.cancel();
    if (expiryTimer) clearTimeout(expiryTimer);
    wsUnsub.cancel();
  };
}

/** Map a poll-observed MintQuoteState into a terminal result, or `null` if
 *  we should keep polling. Total mapping — a new upstream variant breaks
 *  compilation, not silently. */
function classifyPollState(q: PartialMintQuoteResponse): MintQuoteWaitResult | null {
  switch (q.state) {
    case "PAID":
      return { status: "PAID", quote: q };
    case "ISSUED":
      return {
        status: "ERROR",
        quote: q,
        error: new Error(
          "Mint reports quote already issued — proofs were minted elsewhere; request a new invoice.",
        ),
      };
    case "UNPAID":
      return null;
    default:
      return assertNeverState(q.state);
  }
}

function startMintQuotePoll(
  wallet: CashuWallet,
  quoteId: string,
  intervalMs: number,
  fire: (r: MintQuoteWaitResult) => void,
  isDone: () => boolean,
  onTransientError?: (e: Error) => void,
): { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (isDone()) return;
    try {
      const q = await wallet.checkMintQuote(quoteId);
      const terminal = classifyPollState(q);
      if (terminal) {
        fire(terminal);
        return;
      }
    } catch (e) {
      onTransientError?.(e as Error);
    }
    if (!isDone()) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return {
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

function subscribeWsForPaid(
  wallet: CashuWallet,
  quoteId: string,
  fire: (r: MintQuoteWaitResult) => void,
  isDone: () => boolean,
): { cancel: () => void } {
  let unsub: (() => void) | null = null;
  wallet.on
    .mintQuotePaid(
      quoteId,
      (response: PartialMintQuoteResponse) => fire({ status: "PAID", quote: response }),
      (error: Error) => {
        // Surface as a transient error — polling will continue and may still
        // resolve to PAID or EXPIRED. Don't fire a terminal ERROR on a WS hiccup.
        console.warn("[cashu] mintQuotePaid WS error", error);
      },
    )
    .then((u) => {
      if (isDone()) u();
      else unsub = u;
    })
    .catch((e) => {
      console.warn("[cashu] mintQuotePaid WS subscribe failed, polling only", e);
    });
  return { cancel: () => unsub?.() };
}

function scheduleExpiryTimer(
  expiresAtSec: number | undefined,
  fire: (r: MintQuoteWaitResult) => void,
): ReturnType<typeof setTimeout> | null {
  if (!expiresAtSec || !Number.isFinite(expiresAtSec)) return null;
  const msUntilExpiry = expiresAtSec * 1000 - Date.now();
  if (msUntilExpiry <= 0) {
    // Already expired at call time — fire on next tick so the caller's
    // returned-unsub handle is set before the callback runs.
    return setTimeout(() => fire({ status: "EXPIRED" }), 0);
  }
  return setTimeout(() => fire({ status: "EXPIRED" }), msUntilExpiry);
}

function assertNeverState(s: never): never {
  throw new Error(`unhandled MintQuoteState: ${JSON.stringify(s)}`);
}

// ---------------------------------------------------------------------------
// CTF (Conditional Token Framework) types — NUT-CTF
// ---------------------------------------------------------------------------

/**
 * A condition_id uniquely identifies a specific outcome of a prediction market.
 * It is a 32-byte hex string derived by the mint from the oracle announcement.
 */
export type ConditionId = string;

/**
 * A CTF proof is a regular Cashu proof whose keyset is bound to a condition_id.
 * At settlement, the mint will only allow spending the proof whose outcome
 * matches the oracle's attestation.
 */
export interface CtfProof extends Proof {
  /** The condition_id this proof is locked to. */
  conditionId: ConditionId;
}

/**
 * Represents a prediction market position:
 *  - `conditionId` identifies the outcome
 *  - `proofs` are the CTF-locked ecash tokens
 *  - `amountSats` is the total face value
 */
export interface MarketPosition {
  conditionId: ConditionId;
  proofs: Proof[];
  amountSats: number;
  mintUrl?: string;
  outcomeCollection?: string;
  baseAsset: MarketBaseAsset;
}

// ---------------------------------------------------------------------------
// CTF helpers (stubs — full implementation follows NUT-CTF API shape)
// ---------------------------------------------------------------------------

/**
 * Mint CTF tokens for a given condition_id (NUT-CTF §3 — Mint CTF tokens).
 *
 * The mint will return proofs locked to the supplied conditionId.
 * These proofs can only be spent if the oracle attests to that condition.
 *
 * @param conditionId - hex condition_id from the mint's /v1/ctf/conditions endpoint
 * @param amountSats  - amount to lock
 * @param quote       - a paid MintQuoteResponse
 */
export async function mintCtfProofs(
  conditionId: ConditionId,
  amountSats: number,
  quote: MintQuoteResponse,
): Promise<CtfProof[]> {
  const wallet = await getWallet(undefined, DEFAULT_MARKET_BASE_ASSET);
  // NUT-CTF extends CashuWallet with a conditionId option on mintProofs.
  // Once cashu-ts ships NUT-CTF support this call becomes:
  //   wallet.mintProofs(amountSats, quote.quote, { conditionId })
  const proofs = await wallet.mintProofs(amountSats, quote.quote);
  return proofs.map((p) => ({ ...p, conditionId }));
}

/**
 * Settle CTF tokens after oracle attestation (NUT-CTF §5 — Settle).
 *
 * The wallet sends the winning CTF proofs to the mint along with the
 * oracle's attestation signature, and receives regular sat proofs in return.
 *
 * @param position - the winning MarketPosition
 * @returns regular Cashu proofs redeemable as sats
 */
export async function settleCtfPosition(position: MarketPosition): Promise<Proof[]> {
  validateRedeemPosition(position);
  const mintUrl = normalizeUrl(position.mintUrl ?? useWalletStore.getState().activeMintUrl);
  const baseAsset = normalizeMarketBaseAsset(position.baseAsset);

  // A composite ("A|B") position spans MULTIPLE primitive keysets, but the
  // mint enforces a single-keyset rule per redeem (redeem_outcome.rs §1). So
  // we bucket the position's proofs by their REAL keyset id (`Proof.id`) and
  // issue one redeem per keyset. We deliberately do NOT trust the position's
  // `outcomeCollection` label for bucketing — settlement persists proofs
  // inconsistently (composite-label vs per-primitive), so the keyset id is
  // the only reliable grouping key.
  const legs = groupProofsByKeyset(position.proofs);

  // We resolve the attestation only for its oracle witness. The attested
  // OUTCOME is intentionally NOT used to pre-classify legs locally — only the
  // mint may condemn a proof (see `redeemKeysetLeg`).
  const { witnessJson } = await fetchConditionAttestation(position.conditionId);

  const redeemed: Proof[] = [];
  for (const [keysetId, legProofs] of legs) {
    const legResult = await redeemKeysetLeg({
      conditionId: position.conditionId,
      keysetId,
      proofs: legProofs,
      mintUrl,
      witnessJson,
      baseAsset,
    });
    redeemed.push(...legResult);
  }
  return redeemed;
}

/** Group a position's proofs by their real keyset id (`Proof.id`). */
function groupProofsByKeyset(proofs: Proof[]): Map<string, Proof[]> {
  const byKeyset = new Map<string, Proof[]>();
  for (const proof of proofs) {
    byKeyset.set(proof.id, [...(byKeyset.get(proof.id) ?? []), proof]);
  }
  return byKeyset;
}

interface RedeemKeysetLegInput {
  conditionId: string;
  keysetId: string;
  proofs: Proof[];
  mintUrl: string;
  witnessJson: string;
  baseAsset: MarketBaseAsset;
}

/**
 * Redeem (or discard) one keyset leg of a CTF position.
 *
 * EVERY leg is presented to the mint — we never pre-classify a leg as a loser
 * from its stored `outcomeCollection` label. The label can be stale or wrong
 * (settlement persists composite vs per-primitive labels inconsistently), and
 * these are bearer proofs: destroying a mislabelled would-be-winner on a label
 * alone is irreversible value loss. The mint is the sole authority that may
 * condemn a proof.
 *
 * Winning leg  → mint signs the redeem, credit regular proofs, remove inputs.
 *                Transient failures are forward-recoverable via the op-id.
 * Losing leg   → the mint AUTHORITATIVELY rejects it with the terminal
 *                `OracleNotAttestedOutcome` (13015) code. ONLY THEN do we remove
 *                the now-worthless proofs locally, and we surface NO error — a
 *                composite position legitimately carries a losing leg.
 */
async function redeemKeysetLeg(input: RedeemKeysetLegInput): Promise<Proof[]> {
  const { conditionId, keysetId, proofs, mintUrl, witnessJson, baseAsset } = input;
  const unit = defaultCollateralUnit(baseAsset);
  const operationId = buildKeysetRedeemOperationId({
    mintUrl,
    unit,
    conditionId,
    keysetId,
    proofs,
  });
  const existing = (await getProofOperation(operationId)) as CtfProofOperationRecord | null;
  const wallet = await getWallet(mintUrl, baseAsset);
  const result = await redeemOutcomeLegWithOperation({
    mintUrl,
    operationId,
    wallet,
    proofOperationStore: ctfRedeemProofOperationStore(),
    conditionId,
    outcome: keysetId,
    outcomeKeysetId: keysetId,
    unit,
    oracleWitness: witnessJson,
    proofs,
    regularKeyset: await getFrontendRegularKeyset(wallet, baseAsset),
    onLosingLeg: async (inputs) => {
      await removeProofs(inputs.map((proof) => proof.secret));
    },
  });

  if (result.losing) {
    if (existing?.state === "Failed") {
      await removeProofs(proofs.map((proof) => proof.secret));
    }
    return [];
  }
  if (existing?.state !== "completed") {
    await addProofs(result.proofs.map((proof) => ({ ...proof, mintUrl, baseAsset, unit })));
    await removeProofs(proofs.map((proof) => proof.secret));
  }
  return result.proofs;
}

async function getFrontendRegularKeyset(
  wallet: CashuWallet,
  baseAsset: MarketBaseAsset,
): Promise<MintKeys> {
  const response = await wallet.mint.getKeys();
  const keyset =
    response.keysets.find(
      (candidate) => candidate.unit === baseAsset && candidate.active !== false,
    ) ??
    response.keysets.find((candidate) => candidate.unit === baseAsset) ??
    response.keysets[0];
  if (!keyset) throw new Error("Mint did not return a regular keyset");
  return keyset;
}

function ctfRedeemProofOperationStore(): CtfProofOperationStore {
  return {
    getProofOperation: async (operationId) =>
      (await getProofOperation(operationId)) as CtfProofOperationRecord | null,
    prepareProofOperation: async (input) =>
      (await prepareProofOperation(input)) as CtfProofOperationRecord,
    markProofOperationCompleted: async (operationId, completion) =>
      (await markProofOperationCompleted(operationId, completion)) as CtfProofOperationRecord,
    markProofOperationFailed: async (operationId, message, terminalEvidence) => {
      const evidence = readAuthenticatedCtfRedeemTerminalEvidence(terminalEvidence);
      const error = new Error(message) as Error & { code: number };
      error.code = evidence.rejectionBody.code;
      return (await markProofOperationFailed(operationId, error)) as CtfProofOperationRecord;
    },
  };
}

export async function discardCtfPosition(position: MarketPosition): Promise<number> {
  validateRedeemPosition(position);
  await removeProofs(position.proofs.map((proof) => proof.secret));
  return position.amountSats;
}

interface ConditionAttestationResponse {
  conditionId: string;
  attestedOutcome: string;
  oracleWitness: unknown;
}

function validateRedeemPosition(position: MarketPosition): void {
  if (!/^[0-9a-fA-F]{64}$/.test(position.conditionId)) {
    throw new Error("conditionId must be a 64-character hex string for CTF redeem");
  }
  if (!Number.isSafeInteger(position.amountSats) || position.amountSats <= 0) {
    throw new Error("amountSats must be a positive safe integer");
  }
  if (position.proofs.length === 0) {
    throw new Error("CTF redeem requires at least one proof");
  }
  const proofTotal = position.proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0);
  if (proofTotal !== position.amountSats) {
    throw new Error(
      `CTF redeem proof total ${proofTotal} sats does not match position amount ${position.amountSats}`,
    );
  }
}

interface ResolvedConditionAttestation {
  witnessJson: string;
  attestedOutcome: string;
}

async function fetchConditionAttestation(
  conditionId: string,
): Promise<ResolvedConditionAttestation> {
  const response = await fetch(`/api/v1/conditions/${conditionId}/attestation`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Condition attestation lookup failed with HTTP ${response.status}: ${body}`);
  }
  const body = (await response.json()) as ConditionAttestationResponse;
  if (body.conditionId.toLowerCase() !== conditionId.toLowerCase()) {
    throw new Error("Condition attestation response did not match requested condition");
  }
  if (body.oracleWitness == null) {
    throw new Error("Condition attestation response did not include an oracle witness");
  }
  return {
    witnessJson: JSON.stringify(body.oracleWitness),
    attestedOutcome: body.attestedOutcome ?? "",
  };
}

function requireCashuProofUnit(value: string | null | undefined): CashuProofUnit {
  const unit = parseCashuProofUnit(value);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${value ?? ""}'`);
  return unit;
}
