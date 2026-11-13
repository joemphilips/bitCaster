import Dexie, { type Table, type Transaction } from "dexie";
import type { BitcasterDB } from "./proof-db";
import { decodeDurableCustodyScopeInput } from "@bitcaster/client-sdk/durableCustody";
import type {
  RecoveryIndexKeysetProgress,
  RecoveryIndexKeysetRefusal,
  RecoveryIndexRestoreSource,
} from "@bitcaster/client-sdk/recoveryIndexRestore";
import { publishBrowserCtfRangeRecoveryWake } from "@/lib/browserCtfRangeOrderRecoveryWake";
import { normalizeUrl } from "@/lib/url";

// The record of the automatic seed restore event, of the keyset scans after
// a recovery index read, and of the keyset re-sync (ADR-039 and ADR-033,
// amendments 2026-11-09). The seed, the index and the mint can rebuild every
// restored proof, so a lost record only repeats mint work. It lives in its
// own database, so the wallet database schema does not change. Delete it
// together with the wallet database of its seed: a "generated" origin without
// the wallet data would skip the restore of that seed.

export interface SeedRestoreOriginRow {
  readonly scopeId: string;
  /**
   * `generated`: this browser profile generated the seed and holds every
   * proof of it. `entered`: the user entered the seed, so the restore runs.
   */
  readonly origin: "generated" | "entered";
  readonly recordedAtMs: number;
}

/**
 * The recovery index as the restore knows it (ADR-039, "Restore order").
 * Only `listed` and `release4-catalogue` let a restore have full coverage.
 */
export type SeedRestoreIndexState =
  /** The restore has not used an index read yet. */
  | "unread"
  | "listed"
  /** The engine holds no index for this seed. */
  | "absent"
  /** The browser cannot read the index. */
  | "undecodable"
  /** The read failed. Retry or the next wallet open reads again. */
  | "unavailable"
  /** A release 4 restore that walked the whole market catalogue completed. */
  | "release4-catalogue";

export interface SeedRestoreStateRow {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly schemaVersion: 3;
  /** The plan is complete and each keyset of it is scanned or refused. */
  readonly initialCompletedAtMs: number | null;
  /** The earlier asset-monitoring report was read with a signer. */
  readonly hintsDone: boolean;
  /** Failed reads of the earlier asset-monitoring report in a row. */
  readonly hintFailures: number;
  readonly index: SeedRestoreIndexState;
  /** The regular keysets of the mint listing are in the plan. */
  readonly planned: boolean;
  /** The counters that this restore start asked the mint about (ADR-039 budget). */
  readonly countersUsed: number;
  /** The restore stopped at its counter budget. Retry continues it with a new budget. */
  readonly budgetStopped: boolean;
  /** The user closed the CLI gap line of the restore result. The partial pointer stays. */
  readonly resultDismissedAtMs: number | null;
  readonly failures: number;
  readonly nextAttemptAtMs: number;
  readonly lastFailure: string | null;
  /** The most failures in a row of one condition listing or one keyset scan. */
  readonly itemFailures: number;
}

/** A market that a hint names. The restore lists its keysets at the mint. */
export interface SeedRestoreConditionRow {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly conditionId: string;
  readonly schemaVersion: 3;
  readonly order: number;
  readonly listed: boolean;
  /** Descriptors of the listing that are not bitCaster keysets. */
  readonly foreign: number;
  readonly failures: number;
  readonly nextAttemptAtMs: number;
}

export type SeedRestoreKeysetState =
  /** The scan continues at `progress`. */
  | "queued"
  /** The gap rule ended the scan. A PENDING proof waits in its deferral marker. */
  | "complete"
  /** The mint keys do not derive the keyset id with its identity. Retry tries again. */
  | "unverifiable"
  /** The mint answer failed a check (`refusal`). Retry tries again. */
  | "implausible";

/**
 * One keyset that the restore or an index read scans (ADR-051 "Restore").
 * The scan starts at counter 0 and keeps its position after each window.
 */
export interface SeedRestoreKeysetRow {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly keysetId: string;
  readonly schemaVersion: 3;
  readonly source: RecoveryIndexRestoreSource;
  /** The NUT-CTF identity that the index or the mint listing names. Null for a regular keyset. */
  readonly conditional: {
    readonly conditionId: string;
    readonly outcomeCollectionId: string;
  } | null;
  /** The outcome collection after the mint keys verified the keyset. */
  readonly outcomeCollection: string | null;
  readonly order: number;
  readonly state: SeedRestoreKeysetState;
  readonly refusal: RecoveryIndexKeysetRefusal | null;
  readonly progress: RecoveryIndexKeysetProgress;
  /** Failed scans in a row. They set the backoff. */
  readonly failures: number;
  readonly nextAttemptAtMs: number;
}

export interface SeedRestoreCondition {
  readonly conditionId: string;
  readonly outcomeCollection: string;
}

/** Why a deferral marker waits for a later pass. */
export type SeedRestoreDeferralWait =
  /** The mint reported a restored proof as PENDING. */
  | "pending-proof"
  /**
   * An admitting scan that covered every lower counter stopped at its counter
   * budget. The next pass continues the scan from the marker.
   */
  | "scan-budget"
  /** The admission scan failed, or the keyset authority was not found. */
  | "admission-failed";

/**
 * The re-sync record of one keyset that this browser uses (ADR-033,
 * amendment 2026-11-04). It holds the local activity, a local diagnostic of
 * outputs that another client signed, and the deferral marker of signed
 * outputs that wait for admission.
 */
export interface SeedRestoreResyncRow {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly keysetId: string;
  /** The condition of a conditional keyset. It locates the keyset authority at the mint. */
  readonly condition: SeedRestoreCondition | null;
  /** Local diagnostic: how many times the mint held outputs that this browser did not sign. */
  readonly findings: number;
  readonly lastFoundAtMs: number | null;
  readonly lastHighestCounter: number | null;
  /**
   * The deferral marker. Signed outputs from this counter wait for admission:
   * a counter-only advance skipped them, or a PENDING proof waits. A later pass
   * scans from here and admits the verified UNSPENT proofs. Null when nothing waits.
   */
  readonly pendingFromCounter: number | null;
  readonly waitReason: SeedRestoreDeferralWait | null;
  /**
   * Attempts in a row that did not admit the deferral. They set the backoff.
   * For a `scan-budget` marker they count failed scans of the continuation.
   */
  readonly failures: number;
  readonly nextAttemptAtMs: number;
  /** Budget continuations in a row of the covering scan. They set its cadence and its cap. */
  readonly scanContinuations: number;
  /**
   * The lowest counter of a PENDING proof that the covering scan passed while
   * it continues. When the scan ends, the marker moves here.
   */
  readonly pendingProofCounter: number | null;
  /** The `failures` of the PENDING proof marker, kept while the scan continues. */
  readonly pendingProofFailures: number;
}

/** The evidence-triggered re-sync of keysets in use for one wallet mint. */
export interface SeedRestoreResyncScheduleRow {
  readonly scopeId: string;
  readonly mintUrl: string;
  /** Evidence that another client used the seed. A value above `handledEvidence` asks for a probe at once. */
  readonly evidence: number;
  readonly handledEvidence: number;
  readonly probeFailures: number;
  readonly nextProbeAtMs: number;
}

const SEED_RESTORE_STORES = {
  origins: "&scopeId",
  states: "&[scopeId+mintUrl]",
  conditions: "&[scopeId+mintUrl+conditionId], [scopeId+mintUrl]",
  keysets: "&[scopeId+mintUrl+keysetId], [scopeId+mintUrl]",
  resync: "&[scopeId+mintUrl+keysetId], [scopeId+mintUrl]",
  resyncSchedules: "&[scopeId+mintUrl]",
} as const;

export class SeedRestoreDB extends Dexie {
  origins!: Table<SeedRestoreOriginRow, string>;
  states!: Table<SeedRestoreStateRow, [string, string]>;
  conditions!: Table<SeedRestoreConditionRow, [string, string, string]>;
  keysets!: Table<SeedRestoreKeysetRow, [string, string, string]>;
  resync!: Table<SeedRestoreResyncRow, [string, string, string]>;
  resyncSchedules!: Table<SeedRestoreResyncScheduleRow, [string, string]>;

  constructor(name: string) {
    super(name);
    this.version(2).stores(SEED_RESTORE_STORES);
    // Release 5b never walks the market catalogue (ADR-039, amendment
    // 2026-11-09). Forward-only: release 4 cannot open version 3.
    this.version(3).stores(SEED_RESTORE_STORES).upgrade(upgradeRelease4SeedRestore);
  }
}

/**
 * The release 4 rows hold a catalogue walk. A completed walk scanned every
 * market, so its restore stays complete. An unfinished one plans again
 * without the catalogue and keeps only its hinted markets.
 */
async function upgradeRelease4SeedRestore(transaction: Transaction): Promise<void> {
  const completed = new Set<string>();
  await transaction
    .table("states")
    .toCollection()
    .modify((row: Record<string, unknown>, ref: { value: unknown }) => {
      const done = typeof row.initialCompletedAtMs === "number";
      if (done) completed.add(`${String(row.scopeId)}\u0000${String(row.mintUrl)}`);
      ref.value = {
        ...initialSeedRestoreState(String(row.scopeId), String(row.mintUrl)),
        initialCompletedAtMs: done ? (row.initialCompletedAtMs as number) : null,
        hintsDone: row.hintsDone === true,
        hintFailures: typeof row.hintFailures === "number" ? row.hintFailures : 0,
        index: done ? "release4-catalogue" : "unread",
        planned: done,
      } satisfies SeedRestoreStateRow;
    });
  await transaction.table("keysets").clear();
  await transaction
    .table("conditions")
    .toCollection()
    .modify((row: Record<string, unknown>, ref: { value: unknown }) => {
      // A catalogue market (priority 1) or a market of a completed restore has no work.
      if (
        row.priority !== 0 ||
        completed.has(`${String(row.scopeId)}\u0000${String(row.mintUrl)}`)
      ) {
        delete (ref as { value?: unknown }).value;
        return;
      }
      ref.value = {
        scopeId: String(row.scopeId),
        mintUrl: String(row.mintUrl),
        conditionId: String(row.conditionId),
        schemaVersion: 3,
        order: typeof row.order === "number" ? row.order : 0,
        listed: false,
        foreign: 0,
        failures: 0,
        nextAttemptAtMs: 0,
      } satisfies SeedRestoreConditionRow;
    });
}

// The F13 range-recovery backoff bounds.
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 15 * 60_000;
/**
 * Scan continuations in a row that run at the next pass. A long keyset
 * history continues at once. Later continuations back off, so that a mint
 * that signs every queried output cannot keep the wallet scanning.
 */
const SCAN_BUDGET_CONTINUATIONS_AT_ONCE = 10;
/**
 * Scan continuations in a row of one keyset (300,000 counters at the SDK
 * budget) before automatic continuation stops. The restore then shows its
 * persistent error with Retry.
 */
export const SEED_RESTORE_SCAN_CONTINUATIONS_MAX = 100;
/** Failures in a row that show the persistent restore error with Retry. */
export const SEED_RESTORE_PERSISTENT_FAILURES = 3;

/** The delay before the next attempt after `failures` failed attempts in a row. */
export function seedRestoreBackoffMs(failures: number): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 10);
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
  // Jitter spreads the retries of many browsers after one mint outage.
  return Math.round(delay * (0.75 + Math.random() * 0.5));
}

export function initialSeedRestoreResyncRow(
  scopeId: string,
  mintUrl: string,
  keysetId: string,
): SeedRestoreResyncRow {
  return {
    scopeId,
    mintUrl,
    keysetId,
    condition: null,
    findings: 0,
    lastFoundAtMs: null,
    lastHighestCounter: null,
    pendingFromCounter: null,
    waitReason: null,
    failures: 0,
    nextAttemptAtMs: 0,
    scanContinuations: 0,
    pendingProofCounter: null,
    pendingProofFailures: 0,
  };
}

/**
 * A row that an earlier release wrote has no scan continuation fields. They
 * mean no continuation and no PENDING proof left behind.
 */
export function readSeedRestoreResyncRow(row: SeedRestoreResyncRow): SeedRestoreResyncRow {
  const stored = row as Partial<SeedRestoreResyncRow>;
  return {
    ...row,
    scanContinuations: stored.scanContinuations ?? 0,
    pendingProofCounter: stored.pendingProofCounter ?? null,
    pendingProofFailures: stored.pendingProofFailures ?? 0,
  };
}

export function initialSeedRestoreResyncSchedule(
  scopeId: string,
  mintUrl: string,
): SeedRestoreResyncScheduleRow {
  return {
    scopeId,
    mintUrl,
    evidence: 0,
    handledEvidence: 0,
    probeFailures: 0,
    nextProbeAtMs: 0,
  };
}

function requireCounter(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

/**
 * Writes the deferral marker of signed outputs from `fromCounter` before a
 * counter-only advance skips them. It keeps the lowest waiting counter and
 * the earlier backoff. With `finding`, it also counts a local diagnostic.
 */
export async function recordSeedRestoreDeferral(input: {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly keysetId: string;
  readonly fromCounter: number;
  readonly highestCounter: number | null;
  readonly condition: SeedRestoreCondition | null;
  readonly finding: boolean;
  readonly nowMs: number;
}): Promise<void> {
  const fromCounter = requireCounter(input.fromCounter, "deferral counter");
  const database = seedRestoreDatabase(input.scopeId);
  await database.transaction("rw", database.resync, async () => {
    const key: [string, string, string] = [input.scopeId, input.mintUrl, input.keysetId];
    const existing =
      (await database.resync.get(key)) ??
      initialSeedRestoreResyncRow(input.scopeId, input.mintUrl, input.keysetId);
    await database.resync.put({
      ...existing,
      condition: input.condition ?? existing.condition,
      findings: existing.findings + (input.finding ? 1 : 0),
      lastFoundAtMs: input.finding ? input.nowMs : existing.lastFoundAtMs,
      lastHighestCounter: input.highestCounter ?? existing.lastHighestCounter,
      pendingFromCounter:
        existing.pendingFromCounter === null
          ? fromCounter
          : Math.min(existing.pendingFromCounter, fromCounter),
    });
  });
}

/** Keeps the condition of a conditional keyset that this browser uses. */
export async function recordSeedRestoreCondition(input: {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly keysetId: string;
  readonly condition: SeedRestoreCondition;
}): Promise<void> {
  const database = seedRestoreDatabase(input.scopeId);
  await database.transaction("rw", database.resync, async () => {
    const key: [string, string, string] = [input.scopeId, input.mintUrl, input.keysetId];
    const existing =
      (await database.resync.get(key)) ??
      initialSeedRestoreResyncRow(input.scopeId, input.mintUrl, input.keysetId);
    if (
      existing.condition?.conditionId === input.condition.conditionId &&
      existing.condition.outcomeCollection === input.condition.outcomeCollection
    ) {
      return;
    }
    await database.resync.put({ ...existing, condition: { ...input.condition } });
  });
}

/**
 * Settles the deferral of one keyset after a scan from `scannedFrom`
 * admitted its verified UNSPENT proofs. A lower marker that the scan did not
 * cover stays.
 *
 * A covering scan that stopped at its counter budget keeps a marker where it
 * stopped, and the next pass continues from there. An existing continuation
 * never moves back. A PENDING proof that the scan passed waits beside the
 * continuation; when the scan ends, the marker moves to it and backs off.
 */
export async function settleSeedRestoreDeferral(input: {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly keysetId: string;
  readonly scannedFrom: number;
  /** The lowest counter of a PENDING proof that this scan found, or null. */
  readonly pendingFrom: number | null;
  /**
   * Where a scan that covered every lower counter stopped at its counter
   * budget, or null when the scan ended at the gap limit.
   */
  readonly continueFrom: number | null;
  readonly condition: SeedRestoreCondition | null;
  readonly nowMs: number;
}): Promise<void> {
  const database = seedRestoreDatabase(input.scopeId);
  await database.transaction("rw", database.resync, async () => {
    const key: [string, string, string] = [input.scopeId, input.mintUrl, input.keysetId];
    const stored = await database.resync.get(key);
    const row =
      stored === undefined
        ? initialSeedRestoreResyncRow(input.scopeId, input.mintUrl, input.keysetId)
        : readSeedRestoreResyncRow(stored);
    if (
      input.pendingFrom === null &&
      input.continueFrom === null &&
      row.pendingFromCounter === null &&
      row.pendingProofCounter === null
    ) {
      return;
    }
    if (row.pendingFromCounter !== null && row.pendingFromCounter < input.scannedFrom) return;
    // A PENDING proof that this scan did not check again: below its start, or
    // above the counter where it stopped.
    const unchecked = (counter: number | null) =>
      counter !== null &&
      (counter < input.scannedFrom ||
        (input.continueFrom !== null && counter >= input.continueFrom))
        ? counter
        : null;
    const pendingProof = lowest(
      lowest(
        unchecked(row.pendingProofCounter),
        row.waitReason === "pending-proof" ? unchecked(row.pendingFromCounter) : null,
      ),
      input.pendingFrom,
    );
    const pendingProofFailures =
      row.waitReason === "pending-proof" ? row.failures : row.pendingProofFailures;
    if (input.continueFrom !== null) {
      const continuing = row.waitReason === "scan-budget" && row.pendingFromCounter !== null;
      const scanContinuations = (continuing ? row.scanContinuations : 0) + 1;
      const capped = scanContinuations > SEED_RESTORE_SCAN_CONTINUATIONS_MAX;
      await database.resync.put({
        ...row,
        condition: input.condition ?? row.condition,
        pendingFromCounter: requireCounter(
          continuing ? Math.max(row.pendingFromCounter!, input.continueFrom) : input.continueFrom,
          "scan continuation counter",
        ),
        waitReason: "scan-budget",
        scanContinuations,
        pendingProofCounter: pendingProof,
        pendingProofFailures: pendingProof === null ? 0 : pendingProofFailures,
        // At the cap the restore shows its persistent error. Only Retry continues.
        failures: capped ? Math.max(row.failures, SEED_RESTORE_PERSISTENT_FAILURES) : 0,
        nextAttemptAtMs:
          input.nowMs +
          (capped
            ? BACKOFF_MAX_MS
            : scanContinuations <= SCAN_BUDGET_CONTINUATIONS_AT_ONCE
              ? 0
              : seedRestoreBackoffMs(scanContinuations - SCAN_BUDGET_CONTINUATIONS_AT_ONCE)),
      });
      return;
    }
    if (pendingProof === null) {
      await database.resync.put({
        ...row,
        pendingFromCounter: null,
        waitReason: null,
        failures: 0,
        nextAttemptAtMs: 0,
        scanContinuations: 0,
        pendingProofCounter: null,
        pendingProofFailures: 0,
      });
      return;
    }
    const failures = pendingProofFailures + 1;
    await database.resync.put({
      ...row,
      condition: input.condition ?? row.condition,
      pendingFromCounter: requireCounter(pendingProof, "pending counter"),
      waitReason: "pending-proof",
      failures,
      nextAttemptAtMs: input.nowMs + seedRestoreBackoffMs(failures),
      scanContinuations: 0,
      pendingProofCounter: null,
      pendingProofFailures: 0,
    });
  });
}

/** True when automatic continuation of this marker stopped at the cap. Only Retry resumes it. */
export function isSeedRestoreScanCapped(row: SeedRestoreResyncRow | undefined): boolean {
  return (
    row !== undefined &&
    row.waitReason === "scan-budget" &&
    readSeedRestoreResyncRow(row).scanContinuations > SEED_RESTORE_SCAN_CONTINUATIONS_MAX
  );
}

function lowest(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

/** Postpones one deferral without a failure, for example while local work is in flight. */
export async function postponeSeedRestoreDeferral(input: {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly keysetId: string;
  readonly nextAttemptAtMs: number;
}): Promise<void> {
  const database = seedRestoreDatabase(input.scopeId);
  await database.transaction("rw", database.resync, async () => {
    const row = await database.resync.get([input.scopeId, input.mintUrl, input.keysetId]);
    if (row?.pendingFromCounter == null) return;
    await database.resync.put({
      ...row,
      nextAttemptAtMs: Math.max(row.nextAttemptAtMs, input.nextAttemptAtMs),
    });
  });
}

/**
 * Records a failed admission of one deferral and backs it off. A failed scan
 * of a continuation keeps its position, its coverage, and its backoff.
 */
export async function recordSeedRestoreDeferralFailure(input: {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly keysetId: string;
  readonly nowMs: number;
}): Promise<void> {
  const database = seedRestoreDatabase(input.scopeId);
  await database.transaction("rw", database.resync, async () => {
    const row = await database.resync.get([input.scopeId, input.mintUrl, input.keysetId]);
    if (row?.pendingFromCounter == null) return;
    if (row.waitReason === "scan-budget") {
      const failures = row.failures + 1;
      await database.resync.put({
        ...row,
        failures,
        nextAttemptAtMs: Math.max(
          row.nextAttemptAtMs,
          input.nowMs + seedRestoreBackoffMs(failures),
        ),
      });
      return;
    }
    const failures = row.waitReason === "admission-failed" ? row.failures + 1 : 1;
    await database.resync.put({
      ...row,
      waitReason: "admission-failed",
      failures,
      nextAttemptAtMs: input.nowMs + seedRestoreBackoffMs(failures),
    });
  });
}

/**
 * Records evidence that another client used the seed (a mint refusal of
 * reused outputs or spent inputs, or a hit of the order output check) at one mint, and wakes
 * the recovery pass. The next pass probes the keysets in use at that mint at
 * once (ADR-033). It creates the re-sync row when the mint has none yet.
 */
export async function requestBrowserKeysetResync(input: {
  readonly scopeId: string;
  readonly mintUrl: string;
}): Promise<void> {
  const mintUrl = normalizeUrl(input.mintUrl);
  const database = seedRestoreDatabase(input.scopeId);
  await database.transaction("rw", database.resyncSchedules, async () => {
    const row =
      (await database.resyncSchedules.get([input.scopeId, mintUrl])) ??
      initialSeedRestoreResyncSchedule(input.scopeId, mintUrl);
    await database.resyncSchedules.put({ ...row, evidence: row.evidence + 1 });
  });
  publishBrowserCtfRangeRecoveryWake({ scopeId: input.scopeId });
}

let current: SeedRestoreDB | null = null;

export function seedRestoreDatabaseName(scopeId: string): string {
  const scope = decodeDurableCustodyScopeInput(scopeId);
  if (scope.scopeKind !== "wallet") throw new Error("The seed restore needs a wallet scope.");
  return `bitcaster-seed-restore-${scope.walletId}`;
}

/** Returns the seed restore database of one wallet scope, and closes another one. */
export function seedRestoreDatabase(scopeId: string): SeedRestoreDB {
  const name = seedRestoreDatabaseName(scopeId);
  if (current?.name === name) return current;
  current?.close();
  current = new SeedRestoreDB(name);
  return current;
}

/**
 * Deletes the seed restore record of one wallet scope. Call it with the
 * deletion of the wallet database of the same seed.
 */
export async function deleteSeedRestoreDatabase(scopeId: string): Promise<void> {
  const name = seedRestoreDatabaseName(scopeId);
  await pendingOriginWrites.get(scopeId)?.catch(() => undefined);
  if (current?.name === name) {
    current.close();
    current = null;
  }
  await Dexie.delete(name);
}

export function initialSeedRestoreState(scopeId: string, mintUrl: string): SeedRestoreStateRow {
  return {
    scopeId,
    mintUrl,
    schemaVersion: 3,
    initialCompletedAtMs: null,
    hintsDone: false,
    hintFailures: 0,
    index: "unread",
    planned: false,
    countersUsed: 0,
    budgetStopped: false,
    resultDismissedAtMs: null,
    failures: 0,
    nextAttemptAtMs: 0,
    lastFailure: null,
    itemFailures: 0,
  };
}

/**
 * The result of a seed restore (ADR-039, "Restore order"). With no index,
 * an unavailable index, a refused keyset, or a stop at the counter budget,
 * the result is partial: the GUI shows the CLI pointer, and empty holdings
 * are not final.
 */
export function seedRestoreResultIsPartial(
  state: SeedRestoreStateRow,
  keysets: readonly SeedRestoreKeysetRow[],
): boolean {
  return (
    !seedRestoreIndexCovers(state.index) ||
    state.budgetStopped ||
    keysets.some(({ state: keyset }) => seedRestoreKeysetRefused(keyset))
  );
}

/** A partial result that Retry can change. */
export function seedRestoreResultIsRetryable(
  state: SeedRestoreStateRow,
  keysets: readonly SeedRestoreKeysetRow[],
): boolean {
  return (
    state.index === "unavailable" ||
    state.budgetStopped ||
    keysets.some(({ state: keyset }) => seedRestoreKeysetRefused(keyset))
  );
}

function seedRestoreIndexCovers(index: SeedRestoreIndexState): boolean {
  switch (index) {
    case "listed":
    case "release4-catalogue":
      return true;
    case "unread":
    case "absent":
    case "undecodable":
    case "unavailable":
      return false;
    default:
      return assertNever(index);
  }
}

export function seedRestoreKeysetRefused(state: SeedRestoreKeysetState): boolean {
  switch (state) {
    case "unverifiable":
    case "implausible":
      return true;
    case "queued":
    case "complete":
      return false;
    default:
      return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new Error(`unknown seed restore value: ${JSON.stringify(value)}`);
}

const pendingOriginWrites = new Map<string, Promise<void>>();

/**
 * Records that this browser profile generated the seed. The seed restore then
 * skips this profile: it holds every proof of the seed. Call it at generation.
 */
export function recordGeneratedBrowserSeed(scopeId: string, nowMs = Date.now()): Promise<void> {
  return recordOrigin(scopeId, "generated", nowMs);
}

function recordOrigin(
  scopeId: string,
  origin: SeedRestoreOriginRow["origin"],
  nowMs: number,
): Promise<void> {
  const write = seedRestoreDatabase(scopeId)
    .origins.put({ scopeId, origin, recordedAtMs: nowMs })
    .then(() => undefined);
  pendingOriginWrites.set(scopeId, write);
  void write
    .finally(() => {
      if (pendingOriginWrites.get(scopeId) === write) pendingOriginWrites.delete(scopeId);
    })
    .catch(() => undefined);
  return write;
}

/** True when this browser profile generated the seed and still holds its records. */
export async function isBrowserSeedGeneratedHere(scopeId: string): Promise<boolean> {
  return (await browserSeedOrigin(scopeId)) === "generated";
}

/**
 * Records a seed entry: the user entered the seed (setup, import, or wallet
 * replacement). The seed restore then runs for it. Call it before the
 * profile of the seed is activated.
 */
export function recordEnteredBrowserSeed(scopeId: string, nowMs = Date.now()): Promise<void> {
  return recordOrigin(scopeId, "entered", nowMs);
}

/** The origin of the seed in this browser profile, or null without a record. */
export async function browserSeedOrigin(
  scopeId: string,
): Promise<SeedRestoreOriginRow["origin"] | null> {
  await pendingOriginWrites.get(scopeId)?.catch(() => undefined);
  const origin = (await seedRestoreDatabase(scopeId).origins.get(scopeId))?.origin;
  switch (origin) {
    case "generated":
    case "entered":
      return origin;
    case undefined:
      return null;
    default:
      throw new Error("The seed restore origin is unknown.");
  }
}

/**
 * Whether the automatic seed restore event runs for this profile (ADR-039,
 * amendment 2026-11-09). It runs after a seed entry, and it continues a
 * restore that already started. A profile without an origin record that
 * holds local counter cursors used the wallet before origin records existed:
 * it holds the proofs, so it does not run the event. It only uploads its
 * index. An empty profile without a record holds nothing, so it restores.
 */
export async function browserSeedRestoreRuns(
  scopeId: string,
  database: BitcasterDB,
): Promise<boolean> {
  await pendingOriginWrites.get(scopeId)?.catch(() => undefined);
  return readBrowserSeedRestoreRuns(scopeId, database);
}

/**
 * `browserSeedRestoreRuns` with Dexie reads only, for a live query: a live
 * query observes only the tables of its Dexie reads.
 */
export async function readBrowserSeedRestoreRuns(
  scopeId: string,
  database: BitcasterDB,
): Promise<boolean> {
  const restore = seedRestoreDatabase(scopeId);
  const origin = (await restore.origins.get(scopeId))?.origin;
  switch (origin) {
    case "generated":
      return false;
    case "entered":
      return true;
    case undefined: {
      const started = await restore.states
        .where("[scopeId+mintUrl]")
        .between([scopeId, ""], [scopeId, "\uffff"], true, true)
        .count();
      if (started > 0) return true;
      return (await database.walletCounterCursors.where("scopeId").equals(scopeId).count()) === 0;
    }
    default:
      throw new Error("The seed restore origin is unknown.");
  }
}
