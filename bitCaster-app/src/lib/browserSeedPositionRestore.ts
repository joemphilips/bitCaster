import type { Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  validateConditionalKeysetSeedRecoveryAuthority,
  validateConditionalKeysetSeedRecoveryDescriptor,
} from "@bitcaster/client-sdk/conditionalKeysetSeedRecovery";
import {
  SEED_POSITION_PROBE_COUNTERS,
  SEED_POSITION_RESYNC_COUNTERS,
  listSeedRestoreConditionKeysets,
  probeSeedRestoreKeysets,
  readSeedRestoreCataloguePage,
  readSeedRestoreMintConditionPage,
  type SeedRestoreProbeTarget,
} from "@bitcaster/client-sdk/seedPositionRestore";
import { toSeed } from "@/lib/bip39";
import {
  activeBrowserWalletScopeId,
  browserWalletIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import { createAuthenticatedBrowserEngineClient } from "@/lib/markets";
import { getNdk } from "@/lib/nostr";
import { normalizeUrl } from "@/lib/url";
import {
  restoreBrowserConditionalKeyset,
  rescanBrowserRegularKeyset,
  type KeysetRecoveryResult,
} from "@/lib/cashu";
import { useActivityLogStore } from "@/stores/activity-log";
import { BrowserWalletCounterDexieStore } from "@/stores/browser-wallet-counter-db";
import { decodeBrowserCustodyConditionalKeysetRow } from "@/stores/durable-custody-types";
import { db } from "@/stores/proof-db";
import {
  clearSeedRestoreResyncPending,
  initialSeedRestoreState,
  isBrowserSeedGeneratedHere,
  recordSeedRestoreResyncFinding,
  seedRestoreDatabase,
  type SeedRestoreConditionRow,
  type SeedRestoreKeysetDescriptor,
  type SeedRestoreKeysetRow,
  type SeedRestoreStateRow,
} from "@/stores/seed-restore-db";
import { useWalletStore } from "@/stores/wallet";

// The automatic seed restore event of ADR-039 (amendment 2026-11-04). It is a
// release 4 measure: the release 5 wallet-id backup replaces it, and this scan
// then stays only as a fallback.

/** Work bounds of one round. A pass runs rounds until its time budget ends. */
const ROUND_CATALOGUE_PAGES = 4;
const ROUND_LISTINGS = 8;
const ROUND_PROBE_OUTPUTS = 1024;
const ROUND_FULL_SCANS = 4;
const PASS_TIME_BUDGET_MS = 15_000;
/** Keysets with no signature that one later pass probes again, at most each interval. */
const REPROBE_KEYSETS = 8;
const REPROBE_INTERVAL_MS = 60 * 60_000;
/** After this many failed passes in a row, the UI shows a persistent error. */
export const SEED_RESTORE_PERSISTENT_FAILURES = 3;
// The F13 range-recovery backoff bounds.
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const ASSET_MONITORING_HINT_PAGES = 4;

export type BrowserSeedPositionRestorePassStatus =
  | "skipped"
  | "complete"
  | "more"
  | "waiting"
  | "failed";

export interface BrowserSeedPositionRestorePassResult {
  readonly status: BrowserSeedPositionRestorePassStatus;
  /** A keyset waits for a retry after a backoff (a PENDING proof or a failed scan). */
  readonly retryLater?: boolean;
}

export interface BrowserSeedPositionRestoreInput {
  readonly scopeId: string;
  readonly mnemonic: string;
  readonly mintUrl: string;
  readonly now?: () => number;
  /** Yields the main thread between derivation chunks. */
  readonly yieldControl?: () => Promise<void>;
}

const firstPassWaiters = new Map<
  string,
  { promise: Promise<void>; resolve: () => void; ended: boolean }
>();

function firstPassWaiter(scopeId: string) {
  let waiter = firstPassWaiters.get(scopeId);
  if (waiter === undefined) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    waiter = { promise, resolve, ended: false };
    firstPassWaiters.set(scopeId, waiter);
  }
  return waiter;
}

/**
 * Resolves when the first restore pass of this wallet scope ended in this page
 * load, or at once when it ended earlier. The first asset-monitoring report of
 * a new profile waits for it, because the engine keeps only the latest report
 * and the pass reads the earlier report as a hint.
 */
export async function browserSeedPositionRestoreFirstPass(scopeId: string): Promise<void> {
  const waiter = firstPassWaiter(scopeId);
  if (await isBrowserSeedGeneratedHere(scopeId)) return;
  const states = await seedRestoreDatabase(scopeId)
    .states.where("[scopeId+mintUrl]")
    .between([scopeId, ""], [scopeId, "\uffff"], true, true)
    .toArray();
  if (states.some((state) => state.firstPassEndedAtMs !== null)) return;
  await waiter.promise;
}

/** Ends the wait of `browserSeedPositionRestoreFirstPass` for this page load. */
export function endBrowserSeedPositionRestoreFirstPass(scopeId: string): void {
  const waiter = firstPassWaiter(scopeId);
  waiter.ended = true;
  waiter.resolve();
}

/**
 * The asset-monitoring report gate of one wallet scope. `released` is true
 * when the first pass of this page load already ended. Otherwise wait for it.
 */
export function browserSeedPositionRestoreGate(scopeId: string): {
  readonly released: boolean;
  readonly wait: Promise<void>;
} {
  const waiter = firstPassWaiter(scopeId);
  return waiter.ended
    ? { released: true, wait: Promise.resolve() }
    : { released: false, wait: browserSeedPositionRestoreFirstPass(scopeId) };
}

/** Clears the backoff of a failed restore. The caller then wakes the recovery pass. */
export async function retryBrowserSeedPositionRestore(scopeId: string): Promise<void> {
  const database = seedRestoreDatabase(scopeId);
  await database.transaction("rw", database.states, database.keysets, async () => {
    const states = await database.states
      .where("[scopeId+mintUrl]")
      .between([scopeId, ""], [scopeId, "\uffff"], true, true)
      .toArray();
    for (const state of states) {
      await database.states.put({ ...state, failures: 0, nextAttemptAtMs: 0, lastFailure: null });
    }
    await database.keysets
      .where("[scopeId+mintUrl]")
      .between([scopeId, ""], [scopeId, "\uffff"], true, true)
      .modify((row) => {
        if (row.state === "failed") Object.assign(row, { failures: 0, nextAttemptAtMs: 0 });
      });
  });
}

/** Runs one budgeted pass of the seed restore for one wallet mint. */
export async function runBrowserSeedPositionRestorePass(
  input: BrowserSeedPositionRestoreInput,
): Promise<BrowserSeedPositionRestorePassResult> {
  const now = input.now ?? Date.now;
  const mintUrl = normalizeUrl(input.mintUrl);
  const database = seedRestoreDatabase(input.scopeId);
  const isCurrent = () => activeBrowserWalletScopeId() === input.scopeId;
  if (await isBrowserSeedGeneratedHere(input.scopeId)) return { status: "skipped" };
  let state =
    (await database.states.get([input.scopeId, mintUrl])) ??
    initialSeedRestoreState(input.scopeId, mintUrl);
  if (now() < state.nextAttemptAtMs) {
    return {
      status: state.failures >= SEED_RESTORE_PERSISTENT_FAILURES ? "failed" : "waiting",
    };
  }
  const context: PassContext = {
    ...input,
    mintUrl,
    now,
    seed: toSeed(input.mnemonic.trim().split(/\s+/)),
    isCurrent,
    wallet: await walletForMint(mintUrl),
  };
  const started = now();
  try {
    if (!state.hintsDone) {
      await addAssetMonitoringHints(context);
      state = { ...(await readState(context)), hintsDone: true };
      await database.states.put(state);
    }
    await addActivityLogHints(context);
    let finished = false;
    while (!finished && now() - started < PASS_TIME_BUDGET_MS) {
      requireCurrent(context);
      const before = await readState(context);
      state = await walkCatalogue(context, before);
      const work =
        (state.catalogueCursor !== before.catalogueCursor ||
        state.catalogueDone !== before.catalogueDone
          ? 1
          : 0) +
        (await listConditions(context)) +
        (await scanHintedKeysets(context)) +
        (await probeCatalogueKeysets(context));
      finished = await initialRestoreDone(context);
      // Rows that wait for a backoff leave nothing to do in this pass.
      if (work === 0) break;
    }
    state = await readState(context);
    if (finished && state.initialCompletedAtMs === null) {
      state = { ...state, initialCompletedAtMs: now(), lastReprobeAtMs: now() };
    } else if (
      finished &&
      (state.lastReprobeAtMs === null || now() - state.lastReprobeAtMs >= REPROBE_INTERVAL_MS)
    ) {
      // A "no signature" mark is not final. Another client can use the keyset
      // later. Probe the oldest marks again within the budget.
      await reprobeKeysets(context);
      state = { ...(await readState(context)), lastReprobeAtMs: now() };
    }
    state = {
      ...state,
      firstPassEndedAtMs: state.firstPassEndedAtMs ?? now(),
      failures: 0,
      nextAttemptAtMs: 0,
      lastFailure: null,
    };
    await database.states.put(state);
    const retryLater = (await keysetRows(context)).some(
      (row) => row.state === "pending" || row.state === "failed",
    );
    return { status: finished ? "complete" : "more", retryLater };
  } catch (error) {
    if (!isCurrent()) return { status: "waiting" };
    const failed = await readState(context).catch(() => state);
    const failures = failed.failures + 1;
    await database.states.put({
      ...failed,
      firstPassEndedAtMs: failed.firstPassEndedAtMs ?? now(),
      failures,
      nextAttemptAtMs: now() + backoffMs(failures),
      lastFailure: failureCode(error),
    });
    return { status: failures >= SEED_RESTORE_PERSISTENT_FAILURES ? "failed" : "waiting" };
  }
}

export interface BrowserKeysetResyncResult {
  /** The mint signed outputs above a local cursor: another client used the seed. */
  readonly usedElsewhere: boolean;
  readonly complete: boolean;
}

/**
 * Probes each keyset that this browser uses above its local cursor. Another
 * client with the same seed can sign outputs there, or this browser can lose
 * the record of a completed operation; a later local output at those counters
 * then fails with 11008. On a hit, it records a local diagnostic, scans from
 * the cursor, and admits verified UNSPENT proofs through the normal admission
 * path. When admission cannot run now (no keyset authority, or an order
 * coordinator holds the custody scope), it advances the counter only and
 * keeps the start counter, so a later pass admits the outputs.
 */
export async function resyncBrowserKeysetsInUse(input: {
  readonly scopeId: string;
  readonly mnemonic: string;
  readonly mintUrl: string;
  readonly yieldControl?: () => Promise<void>;
  readonly now?: () => number;
}): Promise<BrowserKeysetResyncResult> {
  const now = input.now ?? Date.now;
  const mintUrl = normalizeUrl(input.mintUrl);
  const isCurrentProfile = () => activeBrowserWalletScopeId() === input.scopeId;
  const associations = await db.walletCounterAssociations
    .where("[scopeId+normalizedMint+unit]")
    .equals([input.scopeId, mintUrl, "msat"])
    .toArray();
  const deferred = new Map(
    (
      await seedRestoreDatabase(input.scopeId)
        .resync.where("[scopeId+mintUrl]")
        .equals([input.scopeId, mintUrl])
        .toArray()
    )
      .filter((row) => row.pendingFromCounter !== null)
      .map((row) => [row.keysetId, row.pendingFromCounter!] as const),
  );
  const targets: SeedRestoreProbeTarget[] = [];
  const starts = new Map<string, number>();
  for (const association of associations) {
    if (association.recoveryComplete !== true) continue;
    const cursor = await db.walletCounterCursors.get([input.scopeId, association.keysetId]);
    const start = cursor?.next ?? 0;
    starts.set(association.keysetId, start);
    if (!deferred.has(association.keysetId)) {
      targets.push({ keysetId: association.keysetId, start, count: SEED_POSITION_RESYNC_COUNTERS });
    }
  }
  if (targets.length === 0 && deferred.size === 0) return { usedElsewhere: false, complete: true };
  const wallet = await walletForMint(mintUrl);
  const highest =
    targets.length === 0
      ? new Map<string, number | null>()
      : await probeSeedRestoreKeysets({
          seed: toSeed(input.mnemonic.trim().split(/\s+/)),
          targets,
          restore: (outputs) => wallet.mint.restore({ outputs }),
          ...(input.yieldControl === undefined ? {} : { yieldControl: input.yieldControl }),
        });
  let usedElsewhere = false;
  let complete = true;
  const work = new Map<string, number>(deferred);
  for (const [keysetId, last] of highest) {
    if (last === null) continue;
    usedElsewhere = true;
    const start = starts.get(keysetId) ?? 0;
    // Record first: the scan below can fail, and the outputs must not be lost.
    await recordSeedRestoreResyncFinding({
      scopeId: input.scopeId,
      mintUrl,
      keysetId,
      fromCounter: start,
      highestCounter: last,
      pending: true,
      nowMs: now(),
    });
    work.set(keysetId, Math.min(work.get(keysetId) ?? start, start));
  }
  const regularIds = new Set((await wallet.mint.getKeySets()).keysets.map(({ id }) => id));
  for (const [keysetId, start] of work) {
    if (!isCurrentProfile()) return { usedElsewhere, complete: false };
    let result: KeysetRecoveryResult | null = null;
    try {
      if (regularIds.has(keysetId)) {
        result = await rescanBrowserRegularKeyset({ mintUrl, keysetId, startCounter: start });
      } else {
        const authority = await localConditionalAuthority(input.scopeId, mintUrl, keysetId, wallet);
        if (authority !== null) {
          result = await restoreBrowserConditionalKeyset({
            mintUrl,
            authority,
            force: true,
            startCounter: start,
          });
        }
      }
    } catch {
      result = null;
    }
    const admitted =
      result !== null &&
      result.scannedKeysets.includes(keysetId) &&
      !(result.pendingKeysets ?? []).includes(keysetId);
    if (admitted) {
      await clearSeedRestoreResyncPending({
        scopeId: input.scopeId,
        mintUrl,
        keysetId,
        fromCounter: start,
      });
      continue;
    }
    complete = false;
    const last = highest.get(keysetId);
    if (last !== null && last !== undefined) {
      // Admission cannot run now. Move the cursor past the signed outputs, so
      // the next local output does not reuse them. The kept start counter
      // lets a later pass admit them.
      await new BrowserWalletCounterDexieStore({
        database: db,
        scopeId: input.scopeId,
        isCurrentProfile,
      }).advanceToAtLeastInContext({ mintUrl, unit: "msat" }, keysetId, last + 1, false);
    }
  }
  return { usedElsewhere, complete };
}

interface PassContext extends BrowserSeedPositionRestoreInput {
  readonly mintUrl: string;
  readonly now: () => number;
  readonly seed: Uint8Array;
  readonly isCurrent: () => boolean;
  readonly wallet: CashuWallet;
}

async function walletForMint(mintUrl: string): Promise<CashuWallet> {
  return (await useWalletStore.getState().getWalletForUnit(mintUrl, "msat")) as CashuWallet;
}

function requireCurrent(context: PassContext): void {
  if (!context.isCurrent()) throw new Error("The wallet profile changed during the seed restore.");
}

async function readState(context: PassContext): Promise<SeedRestoreStateRow> {
  return (
    (await seedRestoreDatabase(context.scopeId).states.get([context.scopeId, context.mintUrl])) ??
    initialSeedRestoreState(context.scopeId, context.mintUrl)
  );
}

async function conditionRows(context: PassContext): Promise<SeedRestoreConditionRow[]> {
  return seedRestoreDatabase(context.scopeId)
    .conditions.where("[scopeId+mintUrl]")
    .equals([context.scopeId, context.mintUrl])
    .toArray();
}

async function keysetRows(context: PassContext): Promise<SeedRestoreKeysetRow[]> {
  return seedRestoreDatabase(context.scopeId)
    .keysets.where("[scopeId+mintUrl]")
    .equals([context.scopeId, context.mintUrl])
    .toArray();
}

/** Adds markets with a hint first. A hint can only add restore work. */
async function addConditions(
  context: PassContext,
  markets: readonly { conditionId: string; outcomes: readonly string[] | null }[],
  priority: 0 | 1,
): Promise<void> {
  if (markets.length === 0) return;
  const database = seedRestoreDatabase(context.scopeId);
  await database.transaction("rw", database.states, database.conditions, async () => {
    let state = await readState(context);
    for (const market of markets) {
      const key: [string, string, string] = [context.scopeId, context.mintUrl, market.conditionId];
      const existing = await database.conditions.get(key);
      if (existing !== undefined) {
        const outcomes = existing.outcomes ?? market.outcomes;
        const raise = priority < existing.priority && !existing.listed;
        if (outcomes !== existing.outcomes || raise) {
          await database.conditions.put({
            ...existing,
            outcomes,
            ...(raise ? { priority } : {}),
          });
        }
        continue;
      }
      await database.conditions.put({
        scopeId: context.scopeId,
        mintUrl: context.mintUrl,
        conditionId: market.conditionId,
        outcomes: market.outcomes === null ? null : [...market.outcomes],
        priority,
        order: state.nextOrder,
        listed: false,
        foreign: 0,
        failures: 0,
        nextAttemptAtMs: 0,
      });
      state = { ...state, nextOrder: state.nextOrder + 1 };
    }
    await database.states.put(state);
  });
}

/** Reads the conditions of the earlier asset-monitoring report, before this profile reports. */
async function addAssetMonitoringHints(context: PassContext): Promise<void> {
  const signer = getNdk().signer;
  const walletId = browserWalletIdFromMnemonic(context.mnemonic);
  if (!signer || walletId === null) return;
  const conditionIds = new Set<string>();
  try {
    const client = createAuthenticatedBrowserEngineClient(signer);
    let cursor: string | undefined;
    for (let page = 0; page < ASSET_MONITORING_HINT_PAGES; page += 1) {
      const response = await client.getAssetMonitoringAssets({
        walletId,
        pageSize: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const { asset } of response.assets) {
        if (
          asset.kind === "conditional" &&
          normalizeUrl(asset.canonicalMintUrl) === context.mintUrl
        ) {
          conditionIds.add(asset.conditionId);
        }
      }
      if (!response.nextCursor) break;
      cursor = response.nextCursor;
    }
  } catch {
    // A hint is optional. The catalogue scan still covers every market.
  }
  await addConditions(
    context,
    [...conditionIds].map((conditionId) => ({ conditionId, outcomes: null })),
    0,
  );
}

/** Reads markets of this wallet from the NIP-78 activity log when it is available. */
async function addActivityLogHints(context: PassContext): Promise<void> {
  const walletId = browserWalletIdFromMnemonic(context.mnemonic);
  const conditionIds = new Set<string>();
  for (const item of useActivityLogStore.getState().items) {
    if (item.walletId !== walletId || typeof item.marketId !== "string") continue;
    const conditionId = item.marketId.slice(0, 64);
    if (/^[0-9a-f]{64}$/.test(conditionId) && item.marketId.charAt(64) === "-") {
      conditionIds.add(conditionId);
    }
  }
  await addConditions(
    context,
    [...conditionIds].map((conditionId) => ({ conditionId, outcomes: null })),
    0,
  );
}

async function walkCatalogue(
  context: PassContext,
  state: SeedRestoreStateRow,
): Promise<SeedRestoreStateRow> {
  const database = seedRestoreDatabase(context.scopeId);
  let current = state;
  for (let page = 0; page < ROUND_CATALOGUE_PAGES && !current.catalogueDone; page += 1) {
    if (current.catalogueSource !== "mint") {
      try {
        const result = await readSeedRestoreCataloguePage({
          engineBaseUrl: window.location.origin,
          fetchImpl: fetch,
          cursor: current.catalogueCursor,
        });
        await addConditions(context, result.markets, 1);
        current = {
          ...(await readState(context)),
          catalogueSource: "engine",
          catalogueCursor: result.nextCursor,
          catalogueDone: result.nextCursor === null,
        };
        await database.states.put(current);
        continue;
      } catch (error) {
        // Fall back to the mint listing only when no catalogue page was read.
        if (current.catalogueSource === "engine") throw error;
        current = { ...current, catalogueSource: "mint", catalogueCursor: null };
      }
    }
    const result = await readSeedRestoreMintConditionPage({
      mint: context.wallet.mint,
      cursor: current.catalogueCursor,
    });
    await addConditions(
      context,
      result.conditionIds.map((conditionId) => ({ conditionId, outcomes: null })),
      1,
    );
    current = {
      ...(await readState(context)),
      catalogueSource: "mint",
      catalogueCursor: result.nextCursor,
      catalogueDone: result.nextCursor === null,
    };
    await database.states.put(current);
  }
  return current;
}

function byPriorityAndOrder<T extends { priority: number; order: number }>(left: T, right: T) {
  return left.priority - right.priority || left.order - right.order;
}

async function listConditions(context: PassContext): Promise<number> {
  const database = seedRestoreDatabase(context.scopeId);
  const due = (await conditionRows(context))
    .filter((row) => !row.listed && row.nextAttemptAtMs <= context.now())
    .sort(byPriorityAndOrder)
    .slice(0, ROUND_LISTINGS);
  for (const condition of due) {
    requireCurrent(context);
    let listing: Awaited<ReturnType<typeof listSeedRestoreConditionKeysets>>;
    try {
      listing = await listSeedRestoreConditionKeysets({
        conditionId: condition.conditionId,
        outcomes: condition.outcomes,
        mint: context.wallet.mint,
      });
    } catch {
      // One condition must not stop the pass. Try it again after a backoff.
      const failures = condition.failures + 1;
      await database.conditions.put({
        ...condition,
        failures,
        nextAttemptAtMs: context.now() + backoffMs(failures),
      });
      continue;
    }
    const nowMs = context.now();
    await database.transaction(
      "rw",
      database.states,
      database.conditions,
      database.keysets,
      async () => {
        let state = await readState(context);
        for (const descriptor of listing.keysets) {
          if (descriptor.finalExpiry !== null && descriptor.finalExpiry * 1000 <= nowMs) continue;
          const key: [string, string, string] = [context.scopeId, context.mintUrl, descriptor.id];
          if ((await database.keysets.get(key)) !== undefined) continue;
          await database.keysets.put({
            scopeId: context.scopeId,
            mintUrl: context.mintUrl,
            keysetId: descriptor.id,
            descriptor: { ...descriptor } satisfies SeedRestoreKeysetDescriptor,
            priority: condition.priority,
            order: state.nextOrder,
            state: "queued",
            probedAtMs: null,
            failures: 0,
            nextAttemptAtMs: 0,
          });
          state = { ...state, nextOrder: state.nextOrder + 1 };
        }
        await database.states.put(state);
        await database.conditions.put({
          ...condition,
          listed: true,
          foreign: listing.foreign,
          failures: 0,
          nextAttemptAtMs: 0,
        });
      },
    );
  }
  return due.length;
}

function dueForScan(row: SeedRestoreKeysetRow, nowMs: number): boolean {
  return (row.state === "pending" || row.state === "failed") && row.nextAttemptAtMs <= nowMs;
}

/** A hint names the market, so the full scan runs at once, without the probe window. */
async function scanHintedKeysets(context: PassContext): Promise<number> {
  const rows = (await keysetRows(context))
    .filter(
      (row) => (row.priority === 0 && row.state === "queued") || dueForScan(row, context.now()),
    )
    .sort(byPriorityAndOrder)
    .slice(0, ROUND_FULL_SCANS);
  for (const row of rows) await fullScan(context, row);
  return rows.length;
}

async function probeCatalogueKeysets(context: PassContext): Promise<number> {
  const rows = (await keysetRows(context))
    .filter((row) => row.state === "queued")
    .sort(byPriorityAndOrder)
    .slice(0, Math.floor(ROUND_PROBE_OUTPUTS / SEED_POSITION_PROBE_COUNTERS));
  await probeAndScan(context, rows);
  return rows.length;
}

async function reprobeKeysets(context: PassContext): Promise<void> {
  const rows = (await keysetRows(context))
    .filter((row) => row.state === "no-signature")
    .sort((left, right) => (left.probedAtMs ?? 0) - (right.probedAtMs ?? 0))
    .slice(0, REPROBE_KEYSETS);
  await probeAndScan(context, rows);
}

async function probeAndScan(
  context: PassContext,
  rows: readonly SeedRestoreKeysetRow[],
): Promise<void> {
  if (rows.length === 0) return;
  requireCurrent(context);
  const highest = await probeSeedRestoreKeysets({
    seed: context.seed,
    targets: rows.map((row) => ({
      keysetId: row.keysetId,
      start: 0,
      count: SEED_POSITION_PROBE_COUNTERS,
    })),
    restore: (outputs) => context.wallet.mint.restore({ outputs }),
    ...(context.yieldControl === undefined ? {} : { yieldControl: context.yieldControl }),
  });
  const database = seedRestoreDatabase(context.scopeId);
  for (const row of rows) {
    if (highest.get(row.keysetId) === null) {
      await database.keysets.put({ ...row, state: "no-signature", probedAtMs: context.now() });
    } else {
      await fullScan(context, { ...row, probedAtMs: context.now() });
    }
  }
}

async function fullScan(context: PassContext, row: SeedRestoreKeysetRow): Promise<void> {
  requireCurrent(context);
  const database = seedRestoreDatabase(context.scopeId);
  let state: SeedRestoreKeysetRow["state"];
  try {
    const authority = await mintConditionalAuthority(context.wallet, row.descriptor);
    const result = await restoreBrowserConditionalKeyset({
      mintUrl: context.mintUrl,
      authority,
      // A restored keyset scanned again finds proofs that arrived since.
      force: row.state === "pending" || row.state === "no-signature",
    });
    state = result.pendingKeysets?.includes(row.keysetId)
      ? "pending"
      : result.complete
        ? "restored"
        : "failed";
  } catch {
    state = "failed";
  }
  const failures = state === "restored" ? 0 : row.failures + 1;
  await database.keysets.put({
    ...row,
    state,
    failures,
    nextAttemptAtMs: state === "restored" ? 0 : context.now() + backoffMs(failures),
  });
}

async function initialRestoreDone(context: PassContext): Promise<boolean> {
  const state = await readState(context);
  if (!state.catalogueDone) return false;
  if ((await conditionRows(context)).some((row) => !row.listed && row.failures === 0)) return false;
  return !(await keysetRows(context)).some((row) => row.state === "queued");
}

async function mintConditionalAuthority(
  wallet: CashuWallet,
  descriptor: SeedRestoreKeysetDescriptor,
) {
  const response = await wallet.mint.getKeys(descriptor.id);
  const keys = response.keysets.find(({ id }) => id === descriptor.id)?.keys;
  return validateConditionalKeysetSeedRecoveryAuthority({
    id: descriptor.id,
    unit: descriptor.unit,
    active: descriptor.active,
    input_fee_ppk: descriptor.inputFeePpk,
    ...(descriptor.finalExpiry === null ? {} : { final_expiry: descriptor.finalExpiry }),
    condition_id: descriptor.conditionId,
    outcome_collection: descriptor.outcomeCollection,
    outcome_collection_id: descriptor.outcomeCollectionId,
    registered_at: descriptor.registeredAt,
    keys: keys === undefined ? undefined : { ...keys },
  });
}

/** A local conditional keyset authority: admitted proofs, or a restore listing. */
async function localConditionalAuthority(
  scopeId: string,
  mintUrl: string,
  keysetId: string,
  wallet: CashuWallet,
) {
  const listed = await seedRestoreDatabase(scopeId).keysets.get([scopeId, mintUrl, keysetId]);
  const row = await db.custodyConditionalKeysets.get([scopeId, mintUrl, "msat", keysetId]);
  const conditionId =
    row === undefined
      ? listed?.descriptor.conditionId
      : decodeBrowserCustodyConditionalKeysetRow(row).conditionId;
  if (conditionId === undefined) return null;
  // Read the current descriptor, so the activity flag of a resolved market is exact.
  const page = await wallet.mint.getConditionalKeysets({ condition_id: conditionId, limit: 100 });
  const value = page.keysets.find(({ id }) => id === keysetId);
  if (value === undefined) return null;
  return mintConditionalAuthority(
    wallet,
    validateConditionalKeysetSeedRecoveryDescriptor(value) satisfies SeedRestoreKeysetDescriptor,
  );
}

function backoffMs(failures: number): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 10);
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
  // Jitter spreads the retries of many browsers after one mint outage.
  return Math.round(delay * (0.75 + Math.random() * 0.5));
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}
