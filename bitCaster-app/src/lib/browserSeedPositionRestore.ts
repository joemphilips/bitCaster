import type { Proof, Wallet as CashuWallet } from "@cashu/cashu-ts";
import Dexie from "dexie";
import {
  validateConditionalKeysetSeedRecoveryAuthority,
  validateConditionalKeysetSeedRecoveryDescriptor,
  type ConditionalKeysetSeedRecoveryDescriptor,
} from "@bitcaster/client-sdk/conditionalKeysetSeedRecovery";
import type { RecoveryIndexEntry } from "@bitcaster/client-sdk/recoveryIndexDocument";
import {
  planRecoveryIndexRestore,
  RECOVERY_INDEX_KEYSET_PROGRESS_START,
  RECOVERY_INDEX_RESTORE_COUNTER_BUDGET,
  runRecoveryIndexRestorePass,
  scanRecoveryIndexKeyset,
  type RecoveryIndexKeysetScan,
  type RecoveryIndexRestoreSource,
} from "@bitcaster/client-sdk/recoveryIndexRestore";
import {
  SEED_POSITION_RESYNC_COUNTERS,
  listSeedRestoreConditionKeysets,
  probeSeedRestoreKeysets,
  resolveSeedRestoreKeyset,
  seedRestoreHintEntries,
  type SeedRestoreKeysetListing,
  type SeedRestoreKeysetResolution,
  type SeedRestoreProbeTarget,
} from "@bitcaster/client-sdk/seedPositionRestore";
import { canonicalizeMintIdentityUrl } from "@bitcaster/client-sdk/tokenImportValidation";
import { toSeed } from "@/lib/bip39";
import {
  activeBrowserWalletScopeId,
  browserWalletIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import {
  activeBrowserRecoveryIndex,
  type BrowserRecoveryIndexRead,
} from "@/lib/browserRecoveryIndex";
import { createAuthenticatedBrowserEngineClient } from "@/lib/markets";
import { getNdk } from "@/lib/nostr";
import { normalizeUrl } from "@/lib/url";
import {
  admitBrowserRecoveryIndexWindow,
  CounterRecoveryPostponedError,
  restoreBrowserConditionalKeyset,
  rescanBrowserRegularKeyset,
  type BrowserRecoveryIndexWindowKeyset,
  type KeysetRecoveryResult,
} from "@/lib/cashu";
import { useActivityLogStore } from "@/stores/activity-log";
import { BrowserWalletCounterDexieStore } from "@/stores/browser-wallet-counter-db";
import { decodeBrowserCustodyConditionalKeysetRow } from "@/stores/durable-custody-types";
import { db } from "@/stores/proof-db";
import {
  browserSeedRestoreRuns,
  initialSeedRestoreResyncSchedule,
  initialSeedRestoreState,
  postponeSeedRestoreDeferral,
  recordSeedRestoreDeferral,
  recordSeedRestoreDeferralFailure,
  SEED_RESTORE_PERSISTENT_FAILURES,
  seedRestoreBackoffMs,
  seedRestoreDatabase,
  settleSeedRestoreDeferral,
  type SeedRestoreCondition,
  type SeedRestoreConditionRow,
  type SeedRestoreIndexState,
  type SeedRestoreKeysetRow,
  type SeedRestoreResyncRow,
  type SeedRestoreStateRow,
} from "@/stores/seed-restore-db";
import { claimSeedRestoreStart, releaseSeedRestoreStart } from "@/stores/seed-restore-starts";
import { useWalletStore } from "@/stores/wallet";

// The automatic seed restore event of ADR-039 (amendment 2026-11-09), the
// keyset scans after a recovery index read (ADR-033), and the keyset re-sync
// (ADR-033, amendment 2026-11-04).
//
// - A seed entry starts the restore: at most four starts per browser in 24
//   hours, and no scan on a timer. It scans the listed keysets of the
//   recovery index, the regular keysets of the mint listing, and the keysets
//   of the hinted markets, in that order (SDK planner). It never reads the
//   market catalogue or the whole mint listing. Each restore start has the
//   SDK counter budget.
// - After an index read, a listed keyset with no local cursor gets the same
//   scan, also in a browser that generated the seed.
// - Only evidence of another client starts a re-sync.

/** After this many failures in a row, the UI shows a persistent error. */
export { SEED_RESTORE_PERSISTENT_FAILURES };
const ASSET_MONITORING_HINT_PAGES = 4;
/** Hinted markets that one pass lists at the mint. */
const PASS_CONDITION_LISTINGS = 8;
/** Pages of the unfiltered mint listing that the re-sync reads to find one keyset. */
const RESYNC_RESOLVE_LISTING_PAGES = 20;
const MINT_LISTING_PAGE_SIZE = 100;
const SOURCE_ORDER: Readonly<Record<RecoveryIndexRestoreSource, number>> = {
  listed: 0,
  regular: 1,
  hint: 2,
};

export type BrowserSeedPositionRestorePassStatus =
  | "skipped"
  | "complete"
  | "more"
  | "waiting"
  | "failed";

export interface BrowserSeedPositionRestorePassResult {
  readonly status: BrowserSeedPositionRestorePassStatus;
  /** The earliest time at which a backed-off item is due again, or null. */
  readonly retryAtMs: number | null;
  /** The earlier asset-monitoring report was read, or the read failed too often. */
  readonly hintsSettled: boolean;
}

export interface BrowserSeedPositionRestoreInput {
  readonly scopeId: string;
  readonly mnemonic: string;
  readonly mintUrl: string;
  readonly now?: () => number;
  /** Yields the main thread between derivation chunks of the re-sync probe. */
  readonly yieldControl?: () => Promise<void>;
  /** The counters of one restore start. The default is the SDK budget. */
  readonly counterBudget?: number;
}

const reportGates = new Map<
  string,
  { promise: Promise<void>; resolve: () => void; released: boolean }
>();

function reportGate(scopeId: string) {
  let gate = reportGates.get(scopeId);
  if (gate === undefined) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    gate = { promise, resolve, released: false };
    reportGates.set(scopeId, gate);
  }
  return gate;
}

/**
 * True when the first asset-monitoring report of this wallet can go: this
 * profile generated the seed, or each wallet mint read the earlier report
 * with a signer. A read that keeps failing settles after a bound, so a broken
 * read does not hold the report forever.
 */
export async function browserSeedPositionRestoreHintsSettled(scopeId: string): Promise<boolean> {
  if (!(await browserSeedRestoreRuns(scopeId, db))) return true;
  const states = await statesOfScope(scopeId);
  return states.length > 0 && states.every(hintsSettled);
}

function hintsSettled(state: SeedRestoreStateRow): boolean {
  return state.hintsDone || state.hintFailures >= SEED_RESTORE_PERSISTENT_FAILURES;
}

/** Releases the asset-monitoring report gate of this wallet for this page load. */
export function releaseBrowserSeedPositionRestoreGate(scopeId: string): void {
  const gate = reportGate(scopeId);
  gate.released = true;
  gate.resolve();
}

/**
 * The asset-monitoring report gate of one wallet scope. The engine keeps only
 * the latest report, and the restore reads the earlier report as a hint. So
 * the first report of a new profile waits until the hints are settled.
 */
export function browserSeedPositionRestoreGate(scopeId: string): {
  readonly released: boolean;
  readonly wait: Promise<void>;
} {
  const gate = reportGate(scopeId);
  if (gate.released) return { released: true, wait: Promise.resolve() };
  return {
    released: false,
    wait: (async () => {
      if (await browserSeedPositionRestoreHintsSettled(scopeId)) return;
      await gate.promise;
    })(),
  };
}

function ofScope<T, K>(scopeId: string, table: Dexie.Table<T, K>) {
  return table.where("[scopeId+mintUrl]").between([scopeId, ""], [scopeId, "￿"], true, true);
}

function statesOfScope(scopeId: string): Promise<SeedRestoreStateRow[]> {
  return ofScope(scopeId, seedRestoreDatabase(scopeId).states).toArray();
}

/**
 * Retry of a failed or partial restore. It clears every backoff, starts a new
 * counter budget, and scans the refused keysets again. After an unavailable
 * index, it reads the index again; the SDK sends that read only after an
 * engine outage (ADR-039 "Restore order"). The caller then wakes the recovery
 * pass. Retry is not a new restore start.
 */
export async function retryBrowserSeedPositionRestore(scopeId: string): Promise<void> {
  const database = seedRestoreDatabase(scopeId);
  await database.transaction(
    "rw",
    [
      database.states,
      database.conditions,
      database.keysets,
      database.resync,
      database.resyncSchedules,
    ],
    async () => {
      await ofScope(scopeId, database.states).modify((state: SeedRestoreStateRow) => {
        Object.assign(state, {
          failures: 0,
          nextAttemptAtMs: 0,
          lastFailure: null,
          itemFailures: 0,
          countersUsed: 0,
          budgetStopped: false,
          resultDismissedAtMs: null,
        });
      });
      await ofScope(scopeId, database.conditions).modify((row: SeedRestoreConditionRow) => {
        if (!row.listed) Object.assign(row, { failures: 0, nextAttemptAtMs: 0 });
      });
      await ofScope(scopeId, database.keysets).modify((row: SeedRestoreKeysetRow) => {
        if (row.state === "complete") return;
        Object.assign(row, { state: "queued", refusal: null, failures: 0, nextAttemptAtMs: 0 });
      });
      await ofScope(scopeId, database.resync).modify((row: SeedRestoreResyncRow) => {
        if (row.waitReason === "admission-failed") {
          Object.assign(row, { failures: 0, nextAttemptAtMs: 0 });
        }
        // A scan continuation also starts a new chain: a new backoff and a new cap.
        if (row.waitReason === "scan-budget") {
          Object.assign(row, { failures: 0, nextAttemptAtMs: 0, scanContinuations: 0 });
        }
      });
      await ofScope(scopeId, database.resyncSchedules).modify((row) => {
        Object.assign(row as object, { probeFailures: 0, nextProbeAtMs: 0 });
      });
    },
  );
  if ((await statesOfScope(scopeId)).some(({ index }) => index === "unavailable")) {
    await activeBrowserRecoveryIndex(scopeId)
      ?.read("restore-retry")
      .catch(() => undefined);
  }
}

/** Closes the CLI gap line of the restore result. A later Retry shows it again. */
export async function dismissBrowserSeedRestoreResult(
  scopeId: string,
  nowMs = Date.now(),
): Promise<void> {
  const database = seedRestoreDatabase(scopeId);
  await ofScope(scopeId, database.states).modify((state: SeedRestoreStateRow) => {
    Object.assign(state, { resultDismissedAtMs: nowMs });
  });
}

/**
 * Records one recovery index read (ADR-033): each listed keyset of a wallet
 * mint with no local cursor gets a scan, and a restore that had no index yet
 * takes this one. An index read never starts a scan of a keyset that the
 * browser already uses. Returns true when the read added a scan.
 */
export async function recordBrowserRecoveryIndexRead(
  scopeId: string,
  read: BrowserRecoveryIndexRead,
  walletMintUrls: readonly string[],
): Promise<boolean> {
  const index = indexStateOf(read);
  const database = seedRestoreDatabase(scopeId);
  let added = false;
  await database.transaction("rw", database.states, database.keysets, async () => {
    for (const mintUrl of new Set(walletMintUrls.map(normalizeUrl))) {
      const state = await database.states.get([scopeId, mintUrl]);
      // Only a restore with no index yet, or after an outage, takes a later read.
      if (
        state !== undefined &&
        (state.index === "unread" || state.index === "unavailable") &&
        index !== state.index
      ) {
        await database.states.put({ ...state, index });
      }
      if (read.status !== "read") continue;
      const canonical = canonicalMint(mintUrl);
      const entries = read.scan.filter((entry) => entry.mintUrl === canonical);
      added = (await addTargets(scopeId, mintUrl, entries, "listed")) || added;
    }
  });
  return added;
}

function indexStateOf(read: BrowserRecoveryIndexRead): SeedRestoreIndexState {
  if (read.status === "failed") return "unavailable";
  switch (read.document.status) {
    case "listed":
      return "listed";
    case "absent":
      return "absent";
    case "undecodable":
      return "undecodable";
    case "unread":
      return "unavailable";
    default:
      return assertNever(read.document);
  }
}

/** Adds the keysets that have no scan row yet, after the existing rows. Call in a transaction. */
async function addTargets(
  scopeId: string,
  mintUrl: string,
  entries: readonly RecoveryIndexEntry[],
  source: RecoveryIndexRestoreSource,
): Promise<boolean> {
  if (entries.length === 0) return false;
  const table = seedRestoreDatabase(scopeId).keysets;
  const existing = await table.where("[scopeId+mintUrl]").equals([scopeId, mintUrl]).toArray();
  const known = new Set(existing.map(({ keysetId }) => keysetId));
  let order = existing.reduce((highest, row) => Math.max(highest, row.order + 1), 0);
  let added = false;
  const byKeyset = new Map(existing.map((row) => [row.keysetId, row]));
  for (const entry of entries) {
    const current = byKeyset.get(entry.keysetId);
    if (current !== undefined && source === "listed" && current.state === "complete") {
      // An index read lists a keyset that this browser scanned empty and holds
      // no cursor for: another client used it since (ADR-033). Scan it again.
      // A listed scan sets a cursor, so it runs once.
      await table.put({
        ...current,
        source,
        state: "queued",
        progress: RECOVERY_INDEX_KEYSET_PROGRESS_START,
        failures: 0,
        nextAttemptAtMs: 0,
      });
      byKeyset.delete(entry.keysetId);
      added = true;
      continue;
    }
    if (known.has(entry.keysetId)) continue;
    known.add(entry.keysetId);
    await table.put({
      scopeId,
      mintUrl,
      keysetId: entry.keysetId,
      schemaVersion: 3,
      source,
      conditional:
        entry.kind === "conditional"
          ? { conditionId: entry.conditionId, outcomeCollectionId: entry.outcomeCollectionId }
          : null,
      outcomeCollection: null,
      order,
      state: "queued",
      refusal: null,
      progress: RECOVERY_INDEX_KEYSET_PROGRESS_START,
      failures: 0,
      nextAttemptAtMs: 0,
    });
    order += 1;
    added = true;
  }
  return added;
}

interface PassContext extends BrowserSeedPositionRestoreInput {
  readonly mintUrl: string;
  /** The canonical mint URL of the recovery index entries. */
  readonly canonicalMintUrl: string;
  readonly now: () => number;
  readonly seed: Uint8Array;
  readonly walletId: string | null;
  readonly isCurrent: () => boolean;
  readonly wallet: CashuWallet;
}

/** Runs one pass of the seed restore and of the index-read scans for one wallet mint. */
export async function runBrowserSeedPositionRestorePass(
  input: BrowserSeedPositionRestoreInput,
): Promise<BrowserSeedPositionRestorePassResult> {
  const now = input.now ?? Date.now;
  const mintUrl = normalizeUrl(input.mintUrl);
  const database = seedRestoreDatabase(input.scopeId);
  const isCurrent = () => activeBrowserWalletScopeId() === input.scopeId;
  const runs = await browserSeedRestoreRuns(input.scopeId, db);
  let state: SeedRestoreStateRow | null = null;
  if (runs) {
    const deniedRetryAtMs = await claimRestoreStart(input.scopeId, mintUrl, now);
    if (deniedRetryAtMs !== null) {
      // The restoring notice stays while the start waits for a free slot.
      return { status: "waiting", retryAtMs: deniedRetryAtMs, hintsSettled: false };
    }
    state = await readState(input.scopeId, mintUrl);
    if (now() < state.nextAttemptAtMs) {
      return {
        status: state.failures >= SEED_RESTORE_PERSISTENT_FAILURES ? "failed" : "waiting",
        retryAtMs: state.nextAttemptAtMs,
        hintsSettled: hintsSettled(state),
      };
    }
  } else if ((await keysetRows(input.scopeId, mintUrl)).length === 0) {
    // This profile holds the wallet and no index read named another keyset.
    return { status: "skipped", retryAtMs: null, hintsSettled: true };
  }
  const context: PassContext = {
    ...input,
    mintUrl,
    canonicalMintUrl: canonicalMint(mintUrl),
    now,
    seed: toSeed(input.mnemonic.trim().split(/\s+/)),
    walletId: browserWalletIdFromMnemonic(input.mnemonic),
    isCurrent,
    wallet: await walletForMint(mintUrl),
  };
  try {
    if (state !== null) await prepareRestore(context, state);
    const scanned = await scanTargets(context);
    return await finishPass(context, scanned);
  } catch (error) {
    if (!isCurrent()) return { status: "waiting", retryAtMs: null, hintsSettled: false };
    if (error instanceof CounterRecoveryPostponedError) {
      // Custody work of this browser is in flight. The keyset waits; no failure.
      return {
        status: "waiting",
        retryAtMs: await waitingRetryAtMs(context),
        hintsSettled: state === null || hintsSettled(await readState(input.scopeId, mintUrl)),
      };
    }
    if (state === null) {
      return { status: "waiting", retryAtMs: await waitingRetryAtMs(context), hintsSettled: true };
    }
    const failed = await readState(input.scopeId, mintUrl).catch(() => state);
    const failures = failed.failures + 1;
    const nextAttemptAtMs = now() + seedRestoreBackoffMs(failures);
    await database.states.put({
      ...failed,
      failures,
      nextAttemptAtMs,
      lastFailure: failureCode(error),
    });
    return {
      status: failures >= SEED_RESTORE_PERSISTENT_FAILURES ? "failed" : "waiting",
      retryAtMs: nextAttemptAtMs,
      hintsSettled: hintsSettled(failed),
    };
  }
}

/**
 * A new restore of this seed counts toward the browser cap. A resumed scan
 * and Retry do not. Claim the start and write the first state row in one
 * transaction: a second tab then sees the row only after a granted claim, and
 * a denied claim writes no row. localStorage is not transactional, so a
 * failed write gives the start back. Returns the retry time of a denial.
 */
async function claimRestoreStart(
  scopeId: string,
  mintUrl: string,
  now: () => number,
): Promise<number | null> {
  const database = seedRestoreDatabase(scopeId);
  const claimed: { atMs: number | null } = { atMs: null };
  try {
    return await database.transaction("rw", database.states, async () => {
      if ((await ofScope(scopeId, database.states).count()) > 0) return null;
      // The claim is synchronous, so the transaction stays active.
      const atMs = now();
      const claim = claimSeedRestoreStart(atMs);
      if (!claim.granted) return claim.retryAtMs;
      claimed.atMs = atMs;
      await database.states.put(initialSeedRestoreState(scopeId, mintUrl));
      return null;
    });
  } catch (error) {
    if (claimed.atMs !== null) releaseSeedRestoreStart(claimed.atMs);
    throw error;
  }
}

/**
 * The restore part of a pass: the hints, the index of the restore start, the
 * regular keysets, and the keysets of the hinted markets.
 */
async function prepareRestore(context: PassContext, initial: SeedRestoreStateRow): Promise<void> {
  const database = seedRestoreDatabase(context.scopeId);
  // The activity log names a market only while the restore is unfinished. A
  // later activity item is a trade of this browser, whose keysets can be in
  // use. The earlier asset-monitoring report is another profile's: it is read
  // once, also after the restore completed, and it settles the report gate.
  const unfinished = initial.initialCompletedAtMs === null;
  if (!hintsSettled(initial)) {
    const hints = await addAssetMonitoringHints(context);
    const read = await readState(context.scopeId, context.mintUrl);
    await database.states.put({
      ...read,
      hintsDone: hints === "read",
      hintFailures: hints === "failed" ? read.hintFailures + 1 : read.hintFailures,
    });
  }
  if (unfinished) await addActivityLogHints(context);
  if ((await readState(context.scopeId, context.mintUrl)).index === "unread") {
    // The wallet open read the index (ADR-033). The restore uses that read.
    await recordBrowserRecoveryIndexRead(context.scopeId, await lastIndexRead(context.scopeId), [
      context.mintUrl,
    ]);
    const state = await readState(context.scopeId, context.mintUrl);
    if (state.index === "unread") {
      await database.states.put({ ...state, index: "unavailable" });
    }
  }
  if (!(await readState(context.scopeId, context.mintUrl)).planned) {
    const regular = await regularKeysets(context);
    await database.transaction("rw", database.states, database.keysets, async () => {
      await addTargets(context.scopeId, context.mintUrl, regular, "regular");
      const state = await readState(context.scopeId, context.mintUrl);
      await database.states.put({ ...state, planned: true });
    });
  }
  await listHintedConditions(context);
}

/** The outcome of the latest recovery index read of the active wallet. */
async function lastIndexRead(scopeId: string): Promise<BrowserRecoveryIndexRead> {
  const outcome = await activeBrowserRecoveryIndex(scopeId)
    ?.lastRead()
    ?.catch(() => null);
  if (outcome == null) return { status: "failed" };
  switch (outcome.status) {
    case "read":
    case "skipped":
      return { status: "read", document: outcome.document, scan: outcome.scan };
    case "failed":
      return { status: "failed" };
    default:
      return assertNever(outcome);
  }
}

/** The regular msat keysets of the mint listing (NUT-02). */
async function regularKeysets(context: PassContext): Promise<readonly RecoveryIndexEntry[]> {
  const listing = await context.wallet.mint.getKeySets();
  const regular = listing.keysets
    .filter(({ unit }) => unit === "msat")
    .map(({ id }) => ({
      kind: "regular" as const,
      mintUrl: context.canonicalMintUrl,
      keysetId: id,
    }));
  return planRecoveryIndexRestore({
    listed: null,
    walletMints: [context.canonicalMintUrl],
    regular,
    hints: [],
  }).targets.map(({ entry }) => entry);
}

/** Lists the keysets of each due hinted market at the mint, with the condition filter. */
async function listHintedConditions(context: PassContext): Promise<void> {
  const database = seedRestoreDatabase(context.scopeId);
  const due = (await conditionRows(context))
    .filter((row) => !row.listed && row.nextAttemptAtMs <= context.now())
    .sort((left, right) => left.order - right.order)
    .slice(0, PASS_CONDITION_LISTINGS);
  for (const condition of due) {
    requireCurrent(context);
    let listing: SeedRestoreKeysetListing;
    try {
      listing = await listSeedRestoreConditionKeysets({
        conditionId: condition.conditionId,
        outcomes: null,
        mint: context.wallet.mint,
      });
    } catch {
      // One market must not stop the pass. Try it again after a backoff.
      const failures = condition.failures + 1;
      await database.conditions.put({
        ...condition,
        failures,
        nextAttemptAtMs: context.now() + seedRestoreBackoffMs(failures),
      });
      continue;
    }
    const hints = planRecoveryIndexRestore({
      listed: null,
      walletMints: [context.canonicalMintUrl],
      regular: [],
      hints: seedRestoreHintEntries(context.canonicalMintUrl, listing),
    }).targets.map(({ entry }) => entry);
    await database.transaction("rw", database.conditions, database.keysets, async () => {
      await addTargets(context.scopeId, context.mintUrl, hints, "hint");
      await database.conditions.put({
        ...condition,
        listed: true,
        foreign: listing.foreign,
        failures: 0,
        nextAttemptAtMs: 0,
      });
    });
  }
}

type PassScanResult =
  | { readonly status: "idle" }
  /** The restore stopped at the counter budget of its start. */
  | { readonly status: "stopped" }
  | Awaited<ReturnType<typeof runRecoveryIndexRestorePass<SeedRestoreKeysetRow>>>;

/**
 * Scans the due keysets in plan order with the SDK pass. A restore that has
 * not completed uses what remains of its start's budget. Other scans have one
 * budget in each pass. Each window is stored before the next.
 */
async function scanTargets(context: PassContext): Promise<PassScanResult> {
  const nowMs = context.now();
  const due = (await keysetRows(context.scopeId, context.mintUrl))
    .filter((row) => row.state === "queued" && row.nextAttemptAtMs <= nowMs)
    .sort(
      (left, right) =>
        SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] || left.order - right.order,
    );
  const scannable = await skipKeysetsInUse(context, due);
  if (scannable.length === 0) return { status: "idle" };
  const state = await seedRestoreDatabase(context.scopeId).states.get([
    context.scopeId,
    context.mintUrl,
  ]);
  const restoring = state !== undefined && state.initialCompletedAtMs === null;
  if (restoring && state.budgetStopped) return { status: "stopped" };
  const budget = context.counterBudget ?? RECOVERY_INDEX_RESTORE_COUNTER_BUDGET;
  const resolutions = new Map<string, Promise<SeedRestoreKeysetResolution>>();
  const listings = new Map<string, Promise<SeedRestoreKeysetListing>>();
  const conditionKeysets = (conditionId: string) => {
    let listing = listings.get(conditionId);
    if (listing === undefined) {
      listing = listSeedRestoreConditionKeysets({
        conditionId,
        outcomes: null,
        mint: context.wallet.mint,
      });
      listings.set(conditionId, listing);
    }
    return listing;
  };
  const resolve = (row: SeedRestoreKeysetRow) => {
    let resolution = resolutions.get(row.keysetId);
    if (resolution === undefined) {
      resolution = resolveSeedRestoreKeyset({
        entry: entryOf(context, row),
        mint: context.wallet.mint,
        conditionKeysets,
      });
      resolutions.set(row.keysetId, resolution);
    }
    return resolution;
  };
  return runRecoveryIndexRestorePass({
    keysets: scannable.map((row) => ({ target: row, progress: row.progress })),
    counterBudget: restoring ? Math.max(0, budget - state.countersUsed) : budget,
    scan: (row, request) => scanTarget(context, row, request, resolve),
    commit: async (row, scan) => commitTarget(context, row, scan, restoring, await resolve(row)),
  });
}

/**
 * A planned keyset that this browser already uses (a completed counter
 * association with a cursor) is complete: a scan from counter 0 would read
 * its outputs again. ADR-033: a scan never starts for a keyset in use.
 */
async function skipKeysetsInUse(
  context: PassContext,
  rows: readonly SeedRestoreKeysetRow[],
): Promise<SeedRestoreKeysetRow[]> {
  const scannable: SeedRestoreKeysetRow[] = [];
  for (const row of rows) {
    const [association, cursor] = await Promise.all([
      db.walletCounterAssociations.get([context.scopeId, context.mintUrl, "msat", row.keysetId]),
      db.walletCounterCursors.get([context.scopeId, row.keysetId]),
    ]);
    if (association?.recoveryComplete === true && cursor !== undefined) {
      await seedRestoreDatabase(context.scopeId).keysets.put({ ...row, state: "complete" });
      continue;
    }
    scannable.push(row);
  }
  return scannable;
}

async function scanTarget(
  context: PassContext,
  row: SeedRestoreKeysetRow,
  request: {
    readonly progress: SeedRestoreKeysetRow["progress"];
    readonly maxScannedCounters: number;
  },
  resolve: (row: SeedRestoreKeysetRow) => Promise<SeedRestoreKeysetResolution>,
): Promise<RecoveryIndexKeysetScan> {
  requireCurrent(context);
  try {
    const resolution = await resolve(row);
    if (resolution.status === "unverifiable") return { status: "unverifiable", scannedCounters: 0 };
    return await scanRecoveryIndexKeyset({
      seed: context.seed,
      entry: entryOf(context, row),
      keyset: resolution.keyset,
      restore: (outputs) => context.wallet.mint.restore({ outputs }),
      checkProofStates: async (proofs) =>
        (await context.wallet.checkProofsStates([...proofs])).map(({ state }) => state),
      progress: request.progress,
      maxScannedCounters: request.maxScannedCounters,
    });
  } catch (error) {
    // A failed mint request backs this keyset off. The pass stops, and the
    // next pass continues with the other keysets.
    const failures = row.failures + 1;
    await seedRestoreDatabase(context.scopeId).keysets.put({
      ...((await seedRestoreDatabase(context.scopeId).keysets.get([
        context.scopeId,
        context.mintUrl,
        row.keysetId,
      ])) ?? row),
      failures,
      nextAttemptAtMs: context.now() + seedRestoreBackoffMs(failures),
    });
    throw error;
  }
}

/**
 * Stores one window: the admitted proofs and the cursor in the wallet, then
 * the scan position of the keyset. A complete scan of a keyset with a signed
 * output, or of a listed keyset, moves the cursor by the ADR-051 rule. A
 * complete scan of an empty regular or hinted keyset leaves no cursor, so the
 * index does not list it. A PENDING proof keeps a deferral marker (ADR-033).
 */
async function commitTarget(
  context: PassContext,
  row: SeedRestoreKeysetRow,
  scan: RecoveryIndexKeysetScan,
  restoring: boolean,
  resolution: SeedRestoreKeysetResolution,
): Promise<void> {
  requireCurrent(context);
  const database = seedRestoreDatabase(context.scopeId);
  let next: SeedRestoreKeysetRow;
  switch (scan.status) {
    case "unverifiable":
    case "implausible":
      next = {
        ...row,
        state: scan.status,
        refusal: scan.status === "implausible" ? scan.reason : null,
        failures: 0,
        nextAttemptAtMs: 0,
      };
      break;
    case "complete":
    case "incomplete": {
      if (resolution.status !== "resolved") throw new Error("seed restore keyset is unresolved");
      const keyset: BrowserRecoveryIndexWindowKeyset =
        resolution.conditional === null
          ? { kind: "regular", id: row.keysetId }
          : { kind: "conditional", authority: resolution.conditional };
      const lastSigned = scan.progress.lastSignedCounter;
      const complete = scan.status === "complete";
      const keepsCursor = lastSigned !== null || row.source === "listed";
      if (complete || scan.unspent.length > 0 || lastSigned !== null) {
        await admitWindow(context, row, {
          mintUrl: context.mintUrl,
          keyset,
          proofs: scan.unspent as Proof[],
          counters: scan.unspentCounters,
          next:
            complete && keepsCursor
              ? scan.nextOutputCounter!
              : lastSigned === null
                ? 0
                : lastSigned + 1,
          recovery: complete && scan.pendingFromCounter === null ? "complete" : "incomplete",
        });
      }
      const condition =
        resolution.conditional === null
          ? null
          : {
              conditionId: resolution.conditional.conditionId.toLowerCase(),
              outcomeCollection: resolution.conditional.outcomeCollection,
            };
      if (complete && scan.pendingFromCounter !== null) {
        await settleSeedRestoreDeferral({
          scopeId: context.scopeId,
          mintUrl: context.mintUrl,
          keysetId: row.keysetId,
          scannedFrom: 0,
          pendingFrom: scan.pendingFromCounter,
          continueFrom: null,
          condition,
          nowMs: context.now(),
        });
      }
      next = {
        ...row,
        state: complete ? "complete" : "queued",
        outcomeCollection: condition?.outcomeCollection ?? null,
        progress: scan.progress,
        failures: 0,
        nextAttemptAtMs: 0,
      };
      break;
    }
    default:
      return assertNever(scan);
  }
  await database.transaction("rw", database.states, database.keysets, async () => {
    await database.keysets.put(next);
    if (!restoring || scan.scannedCounters === 0) return;
    const state = await database.states.get([context.scopeId, context.mintUrl]);
    if (state !== undefined) {
      await database.states.put({
        ...state,
        countersUsed: state.countersUsed + scan.scannedCounters,
      });
    }
  });
}

/**
 * Admit one window. With custody work in flight, the keyset waits a short
 * backoff with its stored position, and the pass stops: this is no failure.
 */
async function admitWindow(
  context: PassContext,
  row: SeedRestoreKeysetRow,
  window: Omit<Parameters<typeof admitBrowserRecoveryIndexWindow>[0], "scopeId" | "seed">,
): Promise<void> {
  try {
    await admitBrowserRecoveryIndexWindow({
      ...window,
      scopeId: context.scopeId,
      seed: context.seed,
    });
  } catch (error) {
    if (error instanceof CounterRecoveryPostponedError) {
      await seedRestoreDatabase(context.scopeId).keysets.put({
        ...row,
        nextAttemptAtMs: context.now() + seedRestoreBackoffMs(1),
      });
    }
    throw error;
  }
}

/** Records the result of a pass: the completion of the restore, its budget stop, and its waits. */
async function finishPass(
  context: PassContext,
  scanned: PassScanResult,
): Promise<BrowserSeedPositionRestorePassResult> {
  const database = seedRestoreDatabase(context.scopeId);
  const stored = await database.states.get([context.scopeId, context.mintUrl]);
  const rows = await keysetRows(context.scopeId, context.mintUrl);
  const queued = rows.filter(({ state }) => state === "queued");
  const conditions = (await conditionRows(context)).filter(({ listed }) => !listed);
  const restoring = stored !== undefined && stored.initialCompletedAtMs === null;
  const budgetStopped =
    restoring && (stored.budgetStopped || (scanned.status === "budget" && queued.length > 0));
  const itemFailures = Math.max(
    0,
    ...queued.map(({ failures }) => failures),
    ...conditions.map(({ failures }) => failures),
  );
  const retryAtMs = await waitingRetryAtMs(context);
  if (stored !== undefined) {
    const done =
      stored.planned && stored.index !== "unread" && queued.length === 0 && conditions.length === 0;
    await database.states.put({
      ...stored,
      initialCompletedAtMs: stored.initialCompletedAtMs ?? (done ? context.now() : null),
      budgetStopped,
      failures: 0,
      nextAttemptAtMs: 0,
      lastFailure: null,
      itemFailures,
    });
  }
  const settled = stored === undefined || hintsSettled(stored);
  // A failed hint read tries again after a backoff. Without a signer, the
  // recovery hook runs a pass when the signer becomes ready.
  const hintRetryAtMs =
    stored === undefined || settled || stored.hintFailures === 0
      ? null
      : context.now() + seedRestoreBackoffMs(stored.hintFailures);
  const due = queued.some(({ nextAttemptAtMs }) => nextAttemptAtMs <= context.now());
  return {
    // Out of budget with work left, the next pass continues soon. A restore
    // at its own budget shows its partial result until Retry.
    status: budgetStopped
      ? "complete"
      : due || conditions.some(({ nextAttemptAtMs }) => nextAttemptAtMs <= context.now())
        ? "more"
        : queued.length > 0 || conditions.length > 0
          ? "waiting"
          : "complete",
    retryAtMs: budgetStopped ? null : earliest(retryAtMs, hintRetryAtMs),
    hintsSettled: settled,
  };
}

/** The next due time of a backed-off keyset scan or market listing. */
async function waitingRetryAtMs(context: PassContext): Promise<number | null> {
  let retryAtMs: number | null = null;
  for (const row of await keysetRows(context.scopeId, context.mintUrl)) {
    if (row.state === "queued" && row.nextAttemptAtMs > context.now()) {
      retryAtMs = earliest(retryAtMs, row.nextAttemptAtMs);
    }
  }
  for (const row of await conditionRows(context)) {
    if (!row.listed && row.nextAttemptAtMs > context.now()) {
      retryAtMs = earliest(retryAtMs, row.nextAttemptAtMs);
    }
  }
  return retryAtMs;
}

function entryOf(context: PassContext, row: SeedRestoreKeysetRow): RecoveryIndexEntry {
  return row.conditional === null
    ? { kind: "regular", mintUrl: context.canonicalMintUrl, keysetId: row.keysetId }
    : {
        kind: "conditional",
        mintUrl: context.canonicalMintUrl,
        keysetId: row.keysetId,
        conditionId: row.conditional.conditionId,
        outcomeCollectionId: row.conditional.outcomeCollectionId,
      };
}

function canonicalMint(mintUrl: string): string {
  return canonicalizeMintIdentityUrl(mintUrl);
}

async function walletForMint(mintUrl: string): Promise<CashuWallet> {
  return (await useWalletStore.getState().getWalletForUnit(mintUrl, "msat")) as CashuWallet;
}

function requireCurrent(context: PassContext): void {
  if (!context.isCurrent()) throw new Error("The wallet profile changed during the seed restore.");
}

function earliest(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

async function readState(scopeId: string, mintUrl: string): Promise<SeedRestoreStateRow> {
  return (
    (await seedRestoreDatabase(scopeId).states.get([scopeId, mintUrl])) ??
    initialSeedRestoreState(scopeId, mintUrl)
  );
}

async function conditionRows(context: PassContext): Promise<SeedRestoreConditionRow[]> {
  return seedRestoreDatabase(context.scopeId)
    .conditions.where("[scopeId+mintUrl]")
    .equals([context.scopeId, context.mintUrl])
    .toArray();
}

async function keysetRows(scopeId: string, mintUrl: string): Promise<SeedRestoreKeysetRow[]> {
  return seedRestoreDatabase(scopeId)
    .keysets.where("[scopeId+mintUrl]")
    .equals([scopeId, mintUrl])
    .toArray();
}

/** Adds the markets that a hint names. Their keysets come from the mint listing of each market. */
async function addConditions(
  context: PassContext,
  conditionIds: ReadonlySet<string>,
): Promise<void> {
  if (conditionIds.size === 0) return;
  const database = seedRestoreDatabase(context.scopeId);
  await database.transaction("rw", database.conditions, async () => {
    const existing = await conditionRows(context);
    const known = new Set(existing.map(({ conditionId }) => conditionId));
    let order = existing.reduce((highest, row) => Math.max(highest, row.order + 1), 0);
    for (const conditionId of conditionIds) {
      if (known.has(conditionId)) continue;
      await database.conditions.put({
        scopeId: context.scopeId,
        mintUrl: context.mintUrl,
        conditionId,
        schemaVersion: 3,
        order,
        listed: false,
        foreign: 0,
        failures: 0,
        nextAttemptAtMs: 0,
      });
      order += 1;
    }
  });
}

/**
 * Reads the conditions of the earlier asset-monitoring report, before this
 * profile reports. The result is "read" only after a read with a signer.
 */
async function addAssetMonitoringHints(
  context: PassContext,
): Promise<"read" | "no-signer" | "failed"> {
  const signer = getNdk().signer;
  if (!signer || context.walletId === null) return "no-signer";
  const conditionIds = new Set<string>();
  try {
    const client = createAuthenticatedBrowserEngineClient(signer);
    let cursor: string | undefined;
    for (let page = 0; page < ASSET_MONITORING_HINT_PAGES; page += 1) {
      const response = await client.getAssetMonitoringAssets({
        walletId: context.walletId,
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
    // A hint is optional: the index and the regular keysets still restore.
    return "failed";
  }
  await addConditions(context, conditionIds);
  return "read";
}

/** Reads markets of this wallet from the NIP-78 activity log when it is available. */
async function addActivityLogHints(context: PassContext): Promise<void> {
  const conditionIds = new Set<string>();
  for (const item of useActivityLogStore.getState().items) {
    if (item.walletId !== context.walletId || typeof item.marketId !== "string") continue;
    const conditionId = item.marketId.slice(0, 64);
    if (/^[0-9a-f]{64}$/.test(conditionId) && item.marketId.charAt(64) === "-") {
      conditionIds.add(conditionId);
    }
  }
  await addConditions(context, conditionIds);
}

export interface BrowserKeysetResyncResult {
  /** The mint signed outputs above a local cursor: another client used the seed. */
  readonly usedElsewhere: boolean;
  /** The earliest time at which waiting work is due again, or null. */
  readonly retryAtMs: number | null;
}

/**
 * Re-syncs the keysets that this browser uses (ADR-033, amendment
 * 2026-11-04). Another client with the same seed can sign outputs above a
 * local cursor, and a later local output at those counters then fails with
 * 11008. Only evidence that another client used the seed (a mint refusal or
 * a hit of the order output check) asks for a probe of every keyset in use; no probe runs on
 * a timer. On a hit, it records a local diagnostic and a deferral marker,
 * then admits the verified UNSPENT proofs. Each deferral has its own backoff.
 * A deferral that cannot be admitted gets a counter-only advance, so a later
 * pass admits it.
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
  const database = seedRestoreDatabase(input.scopeId);
  const isCurrentProfile = () => activeBrowserWalletScopeId() === input.scopeId;
  const startedAtMs = now();
  const schedule =
    (await database.resyncSchedules.get([input.scopeId, mintUrl])) ??
    initialSeedRestoreResyncSchedule(input.scopeId, mintUrl);
  const probeDue =
    schedule.evidence > schedule.handledEvidence && startedAtMs >= schedule.nextProbeAtMs;
  const targets: SeedRestoreProbeTarget[] = [];
  if (probeDue) {
    const deferred = new Set(
      (await resyncRows(input.scopeId, mintUrl))
        .filter((row) => row.pendingFromCounter !== null)
        .map(({ keysetId }) => keysetId),
    );
    const associations = await db.walletCounterAssociations
      .where("[scopeId+normalizedMint+unit]")
      .equals([input.scopeId, mintUrl, "msat"])
      .toArray();
    for (const association of associations) {
      // The deferral of a keyset scans it from its marker.
      if (association.recoveryComplete !== true || deferred.has(association.keysetId)) continue;
      // An association without a cursor (an empty scan) holds no output of this browser.
      const cursor = await db.walletCounterCursors.get([input.scopeId, association.keysetId]);
      if (cursor === undefined) continue;
      targets.push({
        keysetId: association.keysetId,
        start: cursor.next,
        count: SEED_POSITION_RESYNC_COUNTERS,
      });
    }
  }
  const wallet = await walletForMint(mintUrl);
  let usedElsewhere = false;
  const highest = new Map<string, number>();
  let probeRetryAtMs: number | null = null;
  if (probeDue) {
    try {
      const found =
        targets.length === 0
          ? new Map<string, number | null>()
          : await probeSeedRestoreKeysets({
              seed: toSeed(input.mnemonic.trim().split(/\s+/)),
              targets,
              restore: (outputs) => wallet.mint.restore({ outputs }),
              ...(input.yieldControl === undefined ? {} : { yieldControl: input.yieldControl }),
            });
      for (const target of targets) {
        const last = found.get(target.keysetId) ?? null;
        if (last === null) continue;
        usedElsewhere = true;
        highest.set(target.keysetId, last);
        // Record first: the scan below can fail, and the outputs must not be lost.
        await recordSeedRestoreDeferral({
          scopeId: input.scopeId,
          mintUrl,
          keysetId: target.keysetId,
          fromCounter: target.start,
          highestCounter: last,
          condition: null,
          finding: true,
          nowMs: now(),
        });
      }
      await database.resyncSchedules.put({
        ...schedule,
        ...(await database.resyncSchedules.get([input.scopeId, mintUrl])),
        handledEvidence: schedule.evidence,
        probeFailures: 0,
        nextProbeAtMs: 0,
      });
    } catch (error) {
      if (!isCurrentProfile()) throw error;
      const current = (await database.resyncSchedules.get([input.scopeId, mintUrl])) ?? schedule;
      const probeFailures = current.probeFailures + 1;
      probeRetryAtMs = now() + seedRestoreBackoffMs(probeFailures);
      await database.resyncSchedules.put({
        ...current,
        probeFailures,
        nextProbeAtMs: probeRetryAtMs,
      });
    }
  }
  await admitDueDeferrals({ ...input, mintUrl, now, wallet, highest, isCurrentProfile });
  const outstanding = (await resyncRows(input.scopeId, mintUrl)).filter(
    (row) => row.pendingFromCounter !== null,
  );
  const latest = await database.resyncSchedules.get([input.scopeId, mintUrl]);
  // Evidence that arrived during this run asks for another run soon, but not
  // before the probe backoff ends.
  const evidenceRetryAtMs =
    latest !== undefined && latest.evidence > latest.handledEvidence
      ? Math.max(now(), latest.nextProbeAtMs)
      : null;
  return {
    usedElsewhere,
    retryAtMs: earliest(
      earliest(probeRetryAtMs, evidenceRetryAtMs),
      outstanding.reduce<number | null>(
        (soonest, row) => earliest(soonest, row.nextAttemptAtMs),
        null,
      ),
    ),
  };
}

async function admitDueDeferrals(input: {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly now: () => number;
  readonly wallet: CashuWallet;
  readonly highest: ReadonlyMap<string, number>;
  readonly isCurrentProfile: () => boolean;
}): Promise<void> {
  const counters = new BrowserWalletCounterDexieStore({
    database: db,
    scopeId: input.scopeId,
    isCurrentProfile: input.isCurrentProfile,
  });
  // Move the cursor past the signed outputs of a hit, so the next local
  // output does not reuse them. The deferral marker keeps the outputs. A
  // marker records a condition only after the mint keys verified it, so the
  // association keeps the conditional form for the recovery index.
  const advancePastHit = async (row: SeedRestoreResyncRow) => {
    const last = input.highest.get(row.keysetId);
    if (last === undefined) return;
    await counters.advanceToAtLeastInContext(
      {
        mintUrl: input.mintUrl,
        unit: "msat",
        ...(row.condition === null ? {} : { conditional: { ...row.condition } }),
      },
      row.keysetId,
      last + 1,
      false,
    );
  };
  const deferred = (await resyncRows(input.scopeId, input.mintUrl)).filter(
    (row) => row.pendingFromCounter !== null,
  );
  const due: SeedRestoreResyncRow[] = [];
  for (const row of deferred) {
    if (row.nextAttemptAtMs <= input.now()) due.push(row);
    else await advancePastHit(row);
  }
  if (due.length === 0) return;
  if (await hasCustodyWorkInFlight(input.scopeId)) {
    // A scan below the cursor could admit outputs of an operation of this
    // browser before the operation records them. The operation would then
    // stay stuck. Wait for it. The wait is not an admission failure.
    for (const row of due) {
      await advancePastHit(row);
      await postponeSeedRestoreDeferral({
        scopeId: input.scopeId,
        mintUrl: input.mintUrl,
        keysetId: row.keysetId,
        nextAttemptAtMs: input.now() + seedRestoreBackoffMs(1),
      });
    }
    return;
  }
  const regularIds = new Set((await input.wallet.mint.getKeySets()).keysets.map(({ id }) => id));
  for (const row of due) {
    if (!input.isCurrentProfile()) return;
    const start = row.pendingFromCounter!;
    let result: KeysetRecoveryResult | null = null;
    try {
      if (regularIds.has(row.keysetId)) {
        result = await rescanBrowserRegularKeyset({
          mintUrl: input.mintUrl,
          keysetId: row.keysetId,
          startCounter: start,
        });
      } else {
        const authority = await localConditionalAuthority(
          input.scopeId,
          input.mintUrl,
          row,
          input.wallet,
        );
        if (authority !== null) {
          result = await restoreBrowserConditionalKeyset({
            mintUrl: input.mintUrl,
            authority,
            force: true,
            startCounter: start,
          });
        }
      }
    } catch {
      result = null;
    }
    // The scan settled the marker: it admitted the outputs, or it backed off a PENDING proof.
    if (result?.scannedKeysets.includes(row.keysetId) === true) continue;
    if (result?.postponedKeysets?.includes(row.keysetId) === true) {
      // An operation started during the scan. Wait for it; this is no failure.
      await advancePastHit(row);
      await postponeSeedRestoreDeferral({
        scopeId: input.scopeId,
        mintUrl: input.mintUrl,
        keysetId: row.keysetId,
        nextAttemptAtMs: input.now() + seedRestoreBackoffMs(1),
      });
      continue;
    }
    // Admission cannot run now (no keyset authority, or a failed scan).
    await advancePastHit(row);
    await recordSeedRestoreDeferralFailure({
      scopeId: input.scopeId,
      mintUrl: input.mintUrl,
      keysetId: row.keysetId,
      nowMs: input.now(),
    });
  }
}

async function resyncRows(scopeId: string, mintUrl: string): Promise<SeedRestoreResyncRow[]> {
  return seedRestoreDatabase(scopeId)
    .resync.where("[scopeId+mintUrl]")
    .equals([scopeId, mintUrl])
    .toArray();
}

async function hasCustodyWorkInFlight(scopeId: string): Promise<boolean> {
  return (
    (await db.custodyActiveWork
      .where("[scopeId+operationId]")
      .between([scopeId, Dexie.minKey], [scopeId, Dexie.maxKey], true, true)
      .count()) > 0
  );
}

async function mintConditionalAuthority(
  wallet: CashuWallet,
  descriptor: ConditionalKeysetSeedRecoveryDescriptor,
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

/**
 * Finds the condition of a deferred conditional keyset: the deferral marker,
 * the admitted proofs, the restore listing, or at last the mint listing. It
 * then reads the current descriptor at the mint, so the activity flag of a
 * resolved market is exact, and validates the keyset authority.
 */
async function localConditionalAuthority(
  scopeId: string,
  mintUrl: string,
  row: SeedRestoreResyncRow,
  wallet: CashuWallet,
) {
  const condition =
    row.condition ??
    (await knownCondition(scopeId, mintUrl, row.keysetId)) ??
    (await mintListedCondition(wallet, row.keysetId));
  if (condition === null) return null;
  const page = await wallet.mint.getConditionalKeysets({
    condition_id: condition.conditionId,
    limit: MINT_LISTING_PAGE_SIZE,
  });
  const value = page.keysets.find(({ id }) => id === row.keysetId);
  if (value === undefined) return null;
  const descriptor = validateConditionalKeysetSeedRecoveryDescriptor(value);
  if (
    descriptor.conditionId !== condition.conditionId ||
    descriptor.outcomeCollection !== condition.outcomeCollection
  ) {
    return null;
  }
  const authority = await mintConditionalAuthority(wallet, descriptor);
  if (row.condition === null) {
    // The mint keys derived the keyset id with this condition.
    await recordSeedRestoreDeferral({
      scopeId,
      mintUrl,
      keysetId: row.keysetId,
      fromCounter: row.pendingFromCounter!,
      highestCounter: null,
      condition,
      finding: false,
      nowMs: Date.now(),
    });
  }
  return authority;
}

async function knownCondition(
  scopeId: string,
  mintUrl: string,
  keysetId: string,
): Promise<SeedRestoreCondition | null> {
  const custody = await db.custodyConditionalKeysets.get([scopeId, mintUrl, "msat", keysetId]);
  if (custody !== undefined) {
    const decoded = decodeBrowserCustodyConditionalKeysetRow(custody);
    return { conditionId: decoded.conditionId, outcomeCollection: decoded.outcomeCollection };
  }
  const target = await seedRestoreDatabase(scopeId).keysets.get([scopeId, mintUrl, keysetId]);
  return target?.conditional == null || target.outcomeCollection === null
    ? null
    : {
        conditionId: target.conditional.conditionId,
        outcomeCollection: target.outcomeCollection,
      };
}

/** Pages through the unfiltered mint listing for one keyset id, within a bound. */
async function mintListedCondition(
  wallet: CashuWallet,
  keysetId: string,
): Promise<SeedRestoreCondition | null> {
  let cursor: string | undefined;
  for (let page = 0; page < RESYNC_RESOLVE_LISTING_PAGES; page += 1) {
    const response = await wallet.mint.getConditionalKeysets({
      limit: MINT_LISTING_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const value = response.keysets.find(({ id }) => id === keysetId);
    if (value !== undefined) {
      const descriptor = validateConditionalKeysetSeedRecoveryDescriptor(value);
      return {
        conditionId: descriptor.conditionId,
        outcomeCollection: descriptor.outcomeCollection,
      };
    }
    if (response.next_cursor == null) return null;
    cursor = response.next_cursor;
  }
  return null;
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

function assertNever(value: never): never {
  throw new Error(`unknown seed restore value: ${JSON.stringify(value)}`);
}
