import type { Wallet as CashuWallet } from "@cashu/cashu-ts";
import Dexie, { type Table } from "dexie";
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
  initialSeedRestoreResyncSchedule,
  initialSeedRestoreState,
  isBrowserSeedGeneratedHere,
  postponeSeedRestoreDeferral,
  recordSeedRestoreDeferral,
  recordSeedRestoreDeferralFailure,
  seedRestoreBackoffMs,
  seedRestoreDatabase,
  type SeedRestoreCondition,
  type SeedRestoreConditionRow,
  type SeedRestoreKeysetDescriptor,
  type SeedRestoreKeysetRow,
  type SeedRestoreResyncRow,
  type SeedRestoreStateRow,
} from "@/stores/seed-restore-db";
import { claimSeedRestoreStart } from "@/stores/seed-restore-starts";
import { useWalletStore } from "@/stores/wallet";

// The automatic seed restore event of ADR-039 and the keyset re-sync of
// ADR-033 (amendments 2026-11-04). They are a release 4 measure: the release 5
// wallet-id backup replaces them with its counter high-water marks, and this
// scan then stays only as a fallback. Operator decision 2026-11-04: no scan
// runs on a timer. A seed entry starts the restore (at most four starts per
// browser in 24 hours), and only evidence of another client starts a re-sync.

/** Work bounds of one round. A pass runs rounds until its time budget ends. */
const ROUND_CATALOGUE_PAGES = 4;
const ROUND_LISTINGS = 8;
const ROUND_PROBE_OUTPUTS = 1024;
const ROUND_FULL_SCANS = 4;
const PASS_TIME_BUDGET_MS = 15_000;
/** After this many failures in a row, the UI shows a persistent error. */
export const SEED_RESTORE_PERSISTENT_FAILURES = 3;
const ASSET_MONITORING_HINT_PAGES = 4;
/** Pages of the unfiltered mint listing that the re-sync reads to find one keyset. */
const RESYNC_RESOLVE_LISTING_PAGES = 20;
const MINT_LISTING_PAGE_SIZE = 100;

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
  /** Yields the main thread between derivation chunks. */
  readonly yieldControl?: () => Promise<void>;
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
  if (await isBrowserSeedGeneratedHere(scopeId)) return true;
  const states = await seedRestoreDatabase(scopeId)
    .states.where("[scopeId+mintUrl]")
    .between([scopeId, ""], [scopeId, "\uffff"], true, true)
    .toArray();
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

/**
 * Clears every backoff of a failed restore or re-sync, and restarts a
 * catalogue walk that has not ended (its saved cursor can be stale). The
 * caller then wakes the recovery pass.
 */
export async function retryBrowserSeedPositionRestore(scopeId: string): Promise<void> {
  const database = seedRestoreDatabase(scopeId);
  const ofScope = <T, K>(table: Table<T, K>) =>
    table.where("[scopeId+mintUrl]").between([scopeId, ""], [scopeId, "\uffff"], true, true);
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
      await ofScope(database.states).modify((state: SeedRestoreStateRow) => {
        Object.assign(state, {
          failures: 0,
          nextAttemptAtMs: 0,
          lastFailure: null,
          itemFailures: 0,
          // An unfinished walk starts again at the first page: its cursor can be stale.
          ...(state.catalogueDone ? {} : { catalogueSource: null, catalogueCursor: null }),
        });
      });
      await ofScope(database.conditions).modify((row: SeedRestoreConditionRow) => {
        if (!row.listed) Object.assign(row, { failures: 0, nextAttemptAtMs: 0 });
      });
      await ofScope(database.keysets).modify((row: SeedRestoreKeysetRow) => {
        if (row.state === "failed") Object.assign(row, { failures: 0, nextAttemptAtMs: 0 });
      });
      await ofScope(database.resync).modify((row: SeedRestoreResyncRow) => {
        if (row.waitReason === "admission-failed") {
          Object.assign(row, { failures: 0, nextAttemptAtMs: 0 });
        }
      });
      await ofScope(database.resyncSchedules).modify((row) => {
        Object.assign(row as object, { probeFailures: 0, nextProbeAtMs: 0 });
      });
    },
  );
}

/** Runs one budgeted pass of the seed restore for one wallet mint. */
export async function runBrowserSeedPositionRestorePass(
  input: BrowserSeedPositionRestoreInput,
): Promise<BrowserSeedPositionRestorePassResult> {
  const now = input.now ?? Date.now;
  const mintUrl = normalizeUrl(input.mintUrl);
  const database = seedRestoreDatabase(input.scopeId);
  const isCurrent = () => activeBrowserWalletScopeId() === input.scopeId;
  if (await isBrowserSeedGeneratedHere(input.scopeId)) {
    return { status: "skipped", retryAtMs: null, hintsSettled: true };
  }
  // Write the first state row before the start is claimed, in one
  // transaction, so a failed write or a second tab uses no start.
  const created = await database.transaction("rw", database.states, async () => {
    const started = await database.states
      .where("[scopeId+mintUrl]")
      .between([input.scopeId, ""], [input.scopeId, "\uffff"], true, true)
      .count();
    if (started > 0) return false;
    await database.states.put(initialSeedRestoreState(input.scopeId, mintUrl));
    return true;
  });
  if (created) {
    // A new restore of this seed counts toward the browser cap. A resumed
    // scan and Retry do not. The restoring notice stays while it waits.
    const claim = claimSeedRestoreStart(now());
    if (!claim.granted) {
      await database.states.delete([input.scopeId, mintUrl]);
      return { status: "waiting", retryAtMs: claim.retryAtMs, hintsSettled: false };
    }
  }
  let state =
    (await database.states.get([input.scopeId, mintUrl])) ??
    initialSeedRestoreState(input.scopeId, mintUrl);
  if (now() < state.nextAttemptAtMs) {
    return {
      status: state.failures >= SEED_RESTORE_PERSISTENT_FAILURES ? "failed" : "waiting",
      retryAtMs: state.nextAttemptAtMs,
      hintsSettled: hintsSettled(state),
    };
  }
  const context: PassContext = {
    ...input,
    mintUrl,
    now,
    seed: toSeed(input.mnemonic.trim().split(/\s+/)),
    walletId: browserWalletIdFromMnemonic(input.mnemonic),
    isCurrent,
    wallet: await walletForMint(mintUrl),
  };
  const started = now();
  try {
    if (!hintsSettled(state)) {
      const hints = await addAssetMonitoringHints(context);
      const read = await readState(context);
      state = {
        ...read,
        hintsDone: hints === "read",
        hintFailures: hints === "failed" ? read.hintFailures + 1 : read.hintFailures,
      };
      await database.states.put(state);
    }
    await addActivityLogHints(context);
    let finished = false;
    let idle = false;
    while (now() - started < PASS_TIME_BUDGET_MS) {
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
      if (work === 0) {
        idle = true;
        break;
      }
    }
    state = await readState(context);
    if (finished && state.initialCompletedAtMs === null) {
      state = { ...state, initialCompletedAtMs: now() };
    }
    const waiting = await waitingWork(context);
    state = {
      ...state,
      failures: 0,
      nextAttemptAtMs: 0,
      lastFailure: null,
      itemFailures: waiting.itemFailures,
    };
    await database.states.put(state);
    const settled = hintsSettled(state);
    // A failed hint read tries again after a backoff. Without a signer, the
    // recovery hook runs a pass when the signer becomes ready.
    const hintRetryAtMs =
      settled || state.hintFailures === 0 ? null : now() + seedRestoreBackoffMs(state.hintFailures);
    return {
      // Out of budget with work left, the next pass continues soon.
      status: !idle ? "more" : finished ? "complete" : "waiting",
      retryAtMs: earliest(waiting.retryAtMs, hintRetryAtMs),
      hintsSettled: settled,
    };
  } catch (error) {
    if (!isCurrent()) return { status: "waiting", retryAtMs: null, hintsSettled: false };
    const failed = await readState(context).catch(() => state);
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
 * a buy probe hit) asks for a probe of every keyset in use; no probe runs on
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
  // output does not reuse them. The deferral marker keeps the outputs.
  const advancePastHit = async (keysetId: string) => {
    const last = input.highest.get(keysetId);
    if (last === undefined) return;
    await counters.advanceToAtLeastInContext(
      { mintUrl: input.mintUrl, unit: "msat" },
      keysetId,
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
    else await advancePastHit(row.keysetId);
  }
  if (due.length === 0) return;
  if (await hasCustodyWorkInFlight(input.scopeId)) {
    // A scan below the cursor could admit outputs of an operation of this
    // browser before the operation records them. The operation would then
    // stay stuck. Wait for it. The wait is not an admission failure.
    for (const row of due) {
      await advancePastHit(row.keysetId);
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
      await advancePastHit(row.keysetId);
      await postponeSeedRestoreDeferral({
        scopeId: input.scopeId,
        mintUrl: input.mintUrl,
        keysetId: row.keysetId,
        nextAttemptAtMs: input.now() + seedRestoreBackoffMs(1),
      });
      continue;
    }
    // Admission cannot run now (no keyset authority, or a failed scan).
    await advancePastHit(row.keysetId);
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

interface PassContext extends BrowserSeedPositionRestoreInput {
  readonly mintUrl: string;
  readonly now: () => number;
  readonly seed: Uint8Array;
  readonly walletId: string | null;
  readonly isCurrent: () => boolean;
  readonly wallet: CashuWallet;
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

/**
 * Adds restore work for markets. A hint (priority 0) can name a market that
 * the catalogue listed earlier: its keysets go back to the queue for a full
 * scan. The function returns the number of new conditions.
 */
async function addConditions(
  context: PassContext,
  markets: readonly { conditionId: string; outcomes: readonly string[] | null }[],
  priority: 0 | 1,
): Promise<number> {
  if (markets.length === 0) return 0;
  const database = seedRestoreDatabase(context.scopeId);
  let added = 0;
  await database.transaction(
    "rw",
    database.states,
    database.conditions,
    database.keysets,
    async () => {
      let state = await readState(context);
      for (const market of markets) {
        const key: [string, string, string] = [
          context.scopeId,
          context.mintUrl,
          market.conditionId,
        ];
        const existing = await database.conditions.get(key);
        if (existing !== undefined) {
          const outcomes = existing.outcomes ?? market.outcomes;
          const raise = priority < existing.priority;
          if (outcomes !== existing.outcomes || raise) {
            await database.conditions.put({
              ...existing,
              outcomes,
              ...(raise ? { priority } : {}),
            });
          }
          if (raise && existing.listed) await requeueForFullScan(context, market.conditionId);
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
        added += 1;
      }
      await database.states.put(state);
    },
  );
  return added;
}

/** A late hint names a listed market. A probe window can miss its first signature. */
async function requeueForFullScan(context: PassContext, conditionId: string): Promise<void> {
  await seedRestoreDatabase(context.scopeId)
    .keysets.where("[scopeId+mintUrl]")
    .equals([context.scopeId, context.mintUrl])
    .modify((row: SeedRestoreKeysetRow) => {
      if (row.descriptor.conditionId !== conditionId) return;
      Object.assign(row, {
        priority: 0,
        ...(row.state === "no-signature" ? { state: "queued", nextAttemptAtMs: 0 } : {}),
      });
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
    // A hint is optional. The catalogue scan still covers every market.
    return "failed";
  }
  await addConditions(
    context,
    [...conditionIds].map((conditionId) => ({ conditionId, outcomes: null })),
    0,
  );
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
  await addConditions(
    context,
    [...conditionIds].map((conditionId) => ({ conditionId, outcomes: null })),
    0,
  );
}

/**
 * Walks the market catalogue once for this restore. The catalogue sets the
 * scan scope. A first-page failure of the engine catalogue uses the strict
 * mint listing for this walk. Another page failure fails the pass; the walk
 * keeps its cursor, so a later pass resumes at that page after the backoff.
 */
async function walkCatalogue(
  context: PassContext,
  state: SeedRestoreStateRow,
): Promise<SeedRestoreStateRow> {
  const database = seedRestoreDatabase(context.scopeId);
  let current = state;
  for (let page = 0; page < ROUND_CATALOGUE_PAGES && !current.catalogueDone; page += 1) {
    if (current.catalogueSource !== "mint") {
      let result: Awaited<ReturnType<typeof readSeedRestoreCataloguePage>>;
      try {
        result = await readSeedRestoreCataloguePage({
          engineBaseUrl: window.location.origin,
          fetchImpl: fetch,
          cursor: current.catalogueCursor,
        });
      } catch (error) {
        if (current.catalogueSource === "engine") throw error;
        // Use the strict mint listing for this walk.
        current = { ...current, catalogueSource: "mint", catalogueCursor: null };
        continue;
      }
      await addConditions(context, result.markets, 1);
      current = {
        ...(await readState(context)),
        catalogueSource: "engine",
        catalogueCursor: result.nextCursor,
        catalogueDone: result.nextCursor === null,
      };
      await database.states.put(current);
      continue;
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
        nextAttemptAtMs: context.now() + seedRestoreBackoffMs(failures),
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
        // A hint can raise the priority while the listing runs.
        const latest =
          (await database.conditions.get([
            context.scopeId,
            context.mintUrl,
            condition.conditionId,
          ])) ?? condition;
        for (const descriptor of listing.keysets) {
          if (descriptor.finalExpiry !== null && descriptor.finalExpiry * 1000 <= nowMs) continue;
          const key: [string, string, string] = [context.scopeId, context.mintUrl, descriptor.id];
          if ((await database.keysets.get(key)) !== undefined) continue;
          await database.keysets.put({
            scopeId: context.scopeId,
            mintUrl: context.mintUrl,
            keysetId: descriptor.id,
            descriptor: { ...descriptor } satisfies SeedRestoreKeysetDescriptor,
            priority: latest.priority,
            order: state.nextOrder,
            state: "queued",
            failures: 0,
            nextAttemptAtMs: 0,
          });
          state = { ...state, nextOrder: state.nextOrder + 1 };
        }
        await database.states.put(state);
        await database.conditions.put({
          ...latest,
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

/** A hint names the market, so the full scan runs at once, without the probe window. */
async function scanHintedKeysets(context: PassContext): Promise<number> {
  const nowMs = context.now();
  const rows = (await keysetRows(context))
    .filter(
      (row) =>
        (row.priority === 0 && row.state === "queued") ||
        (row.state === "failed" && row.nextAttemptAtMs <= nowMs),
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
      await database.keysets.put({ ...row, state: "no-signature" });
    } else {
      await fullScan(context, row);
    }
  }
}

async function fullScan(context: PassContext, row: SeedRestoreKeysetRow): Promise<void> {
  requireCurrent(context);
  const database = seedRestoreDatabase(context.scopeId);
  let state: SeedRestoreKeysetRow["state"];
  try {
    const authority = await mintConditionalAuthority(context.wallet, row.descriptor);
    // No forced scan: a keyset that this browser uses and completed belongs
    // to the keyset re-sync.
    const result = await restoreBrowserConditionalKeyset({
      mintUrl: context.mintUrl,
      authority,
    });
    // A PENDING proof waits in its deferral marker, with its own backoff.
    state =
      result.complete || result.pendingKeysets?.includes(row.keysetId) === true
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
    nextAttemptAtMs: state === "restored" ? 0 : context.now() + seedRestoreBackoffMs(failures),
  });
}

/**
 * The initial restore is done when the catalogue walk ended, every condition
 * is listed, and every listed keyset was probed or scanned. A failed listing
 * or scan keeps it open, so the UI does not report an early completion.
 */
async function initialRestoreDone(context: PassContext): Promise<boolean> {
  const state = await readState(context);
  if (!state.catalogueDone) return false;
  if ((await conditionRows(context)).some((row) => !row.listed)) return false;
  return !(await keysetRows(context)).some(
    (row) => row.state === "queued" || row.state === "failed",
  );
}

/** Backed-off conditions and keyset scans: their next due time and their worst failure count. */
async function waitingWork(
  context: PassContext,
): Promise<{ retryAtMs: number | null; itemFailures: number }> {
  let retryAtMs: number | null = null;
  let itemFailures = 0;
  for (const row of await conditionRows(context)) {
    if (row.listed) continue;
    retryAtMs = earliest(retryAtMs, row.nextAttemptAtMs);
    itemFailures = Math.max(itemFailures, row.failures);
  }
  for (const row of await keysetRows(context)) {
    if (row.state !== "failed") continue;
    retryAtMs = earliest(retryAtMs, row.nextAttemptAtMs);
    itemFailures = Math.max(itemFailures, row.failures);
  }
  return { retryAtMs, itemFailures };
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
  let condition = row.condition ?? (await knownCondition(scopeId, mintUrl, row.keysetId));
  if (condition === null) {
    condition = await mintListedCondition(wallet, row.keysetId);
    if (condition === null) return null;
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
  return mintConditionalAuthority(wallet, descriptor satisfies SeedRestoreKeysetDescriptor);
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
  const listed = await seedRestoreDatabase(scopeId).keysets.get([scopeId, mintUrl, keysetId]);
  return listed === undefined
    ? null
    : {
        conditionId: listed.descriptor.conditionId,
        outcomeCollection: listed.descriptor.outcomeCollection,
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
