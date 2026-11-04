import Dexie, { type Table } from "dexie";
import { decodeDurableCustodyScopeInput } from "@bitcaster/client-sdk/durableCustody";
import { publishBrowserCtfRangeRecoveryWake } from "@/lib/browserCtfRangeOrderRecoveryWake";

// The record of the automatic seed restore event and of the keyset re-sync
// (ADR-039 and ADR-033, amendments 2026-11-04). The seed and the mint can
// rebuild every restored proof, so a lost record only repeats mint work. It
// lives in its own database, so the wallet database schema and the previous
// release that reads it do not change. Delete it together with the wallet
// database of its seed: a "generated" origin without the wallet data would
// skip the restore of that seed.

export interface SeedRestoreOriginRow {
  readonly scopeId: string;
  /** This browser profile generated the seed. It holds every proof of it. */
  readonly origin: "generated";
  readonly recordedAtMs: number;
}

export interface SeedRestoreStateRow {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly schemaVersion: 2;
  /** The first pass ended (complete, out of budget, or failed). */
  readonly firstPassEndedAtMs: number | null;
  /** Every condition was listed and every listed keyset was probed or scanned. */
  readonly initialCompletedAtMs: number | null;
  /** The earlier asset-monitoring report was read with a signer. */
  readonly hintsDone: boolean;
  /** Failed reads of the earlier asset-monitoring report in a row. */
  readonly hintFailures: number;
  /** The source of the current catalogue walk. A later walk tries the engine first again. */
  readonly catalogueSource: "engine" | "mint" | null;
  readonly catalogueCursor: string | null;
  readonly catalogueDone: boolean;
  /** When the last catalogue walk ended. A later walk looks for new markets. */
  readonly catalogueWalkedAtMs: number | null;
  /** Insertion order of the next condition or keyset row. */
  readonly nextOrder: number;
  readonly failures: number;
  readonly nextAttemptAtMs: number;
  readonly lastFailure: string | null;
  /** The most failures in a row of one condition listing or one keyset scan. */
  readonly itemFailures: number;
  /** The last probe again of keysets with no signature. */
  readonly lastReprobeAtMs: number | null;
}

export interface SeedRestoreConditionRow {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly conditionId: string;
  /** Catalogue outcomes, or null when only a hint or the mint names the market. */
  readonly outcomes: readonly string[] | null;
  /** 0: a hint names the market. 1: the catalogue or the mint listing. */
  readonly priority: 0 | 1;
  readonly order: number;
  readonly listed: boolean;
  readonly foreign: number;
  readonly failures: number;
  readonly nextAttemptAtMs: number;
}

export interface SeedRestoreKeysetDescriptor {
  readonly id: string;
  readonly unit: string;
  readonly active: boolean;
  readonly inputFeePpk: number;
  readonly finalExpiry: number | null;
  readonly conditionId: string;
  readonly outcomeCollection: string;
  readonly outcomeCollectionId: string;
  readonly registeredAt: number;
}

export type SeedRestoreKeysetState =
  /** Not probed yet. */
  | "queued"
  /** Probed with no signature. Not final: later passes probe it again. */
  | "no-signature"
  /** Fully scanned. A PENDING proof that the scan found waits in the deferral marker. */
  | "restored"
  /** A scan failed. A later pass tries again after a backoff. */
  | "failed";

export interface SeedRestoreKeysetRow {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly keysetId: string;
  readonly descriptor: SeedRestoreKeysetDescriptor;
  readonly priority: 0 | 1;
  readonly order: number;
  readonly state: SeedRestoreKeysetState;
  readonly probedAtMs: number | null;
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
  /** The local cursor at the last re-sync. A change shows local activity. */
  readonly observedCursor: number | null;
  readonly activeAtMs: number | null;
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
  /** Attempts in a row that did not admit the deferral. They set the backoff. */
  readonly failures: number;
  readonly nextAttemptAtMs: number;
}

/** The re-sync schedule of keysets in use for one wallet mint. */
export interface SeedRestoreResyncScheduleRow {
  readonly scopeId: string;
  readonly mintUrl: string;
  /** The last probe of keysets in use. The routine probe runs at most once a day. */
  readonly lastProbeAtMs: number | null;
  /** Evidence that another client used the seed. A value above `handledEvidence` asks for a probe at once. */
  readonly evidence: number;
  readonly handledEvidence: number;
  readonly probeFailures: number;
  readonly nextProbeAtMs: number;
}

export class SeedRestoreDB extends Dexie {
  origins!: Table<SeedRestoreOriginRow, string>;
  states!: Table<SeedRestoreStateRow, [string, string]>;
  conditions!: Table<SeedRestoreConditionRow, [string, string, string]>;
  keysets!: Table<SeedRestoreKeysetRow, [string, string, string]>;
  resync!: Table<SeedRestoreResyncRow, [string, string, string]>;
  resyncSchedules!: Table<SeedRestoreResyncScheduleRow, [string, string]>;

  constructor(name: string) {
    super(name);
    this.version(2).stores({
      origins: "&scopeId",
      states: "&[scopeId+mintUrl]",
      conditions: "&[scopeId+mintUrl+conditionId], [scopeId+mintUrl]",
      keysets: "&[scopeId+mintUrl+keysetId], [scopeId+mintUrl]",
      resync: "&[scopeId+mintUrl+keysetId], [scopeId+mintUrl]",
      resyncSchedules: "&[scopeId+mintUrl]",
    });
  }
}

// The F13 range-recovery backoff bounds.
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 15 * 60_000;

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
    observedCursor: null,
    activeAtMs: null,
    findings: 0,
    lastFoundAtMs: null,
    lastHighestCounter: null,
    pendingFromCounter: null,
    waitReason: null,
    failures: 0,
    nextAttemptAtMs: 0,
  };
}

export function initialSeedRestoreResyncSchedule(
  scopeId: string,
  mintUrl: string,
): SeedRestoreResyncScheduleRow {
  return {
    scopeId,
    mintUrl,
    lastProbeAtMs: null,
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

/**
 * Settles the deferral of one keyset after a scan from `scannedFrom`
 * admitted its verified UNSPENT proofs. A PENDING proof keeps a marker at
 * its counter and backs off. A lower marker that the scan did not cover stays.
 */
export async function settleSeedRestoreDeferral(input: {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly keysetId: string;
  readonly scannedFrom: number;
  /** The lowest counter of a PENDING proof, or null when none waits. */
  readonly pendingFrom: number | null;
  readonly condition: SeedRestoreCondition | null;
  readonly nowMs: number;
}): Promise<void> {
  const database = seedRestoreDatabase(input.scopeId);
  await database.transaction("rw", database.resync, async () => {
    const key: [string, string, string] = [input.scopeId, input.mintUrl, input.keysetId];
    const existing = await database.resync.get(key);
    if (input.pendingFrom === null && existing?.pendingFromCounter == null) return;
    const row =
      existing ?? initialSeedRestoreResyncRow(input.scopeId, input.mintUrl, input.keysetId);
    if (row.pendingFromCounter !== null && row.pendingFromCounter < input.scannedFrom) return;
    if (input.pendingFrom === null) {
      await database.resync.put({
        ...row,
        pendingFromCounter: null,
        waitReason: null,
        failures: 0,
        nextAttemptAtMs: 0,
      });
      return;
    }
    const failures = row.waitReason === "pending-proof" ? row.failures + 1 : 1;
    await database.resync.put({
      ...row,
      condition: input.condition ?? row.condition,
      pendingFromCounter: requireCounter(input.pendingFrom, "pending counter"),
      waitReason: "pending-proof",
      failures,
      nextAttemptAtMs: input.nowMs + seedRestoreBackoffMs(failures),
    });
  });
}

/** Records a failed admission of one deferral and backs it off. */
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
 * reused outputs or spent inputs, or a probe hit) and wakes the recovery
 * pass. The next pass probes the keysets in use at once (ADR-033). Without a
 * mint URL, the evidence applies to every mint of the wallet.
 */
export async function requestBrowserKeysetResync(input: {
  readonly scopeId: string;
  readonly mintUrl?: string;
}): Promise<void> {
  const database = seedRestoreDatabase(input.scopeId);
  await database.transaction("rw", database.resyncSchedules, async () => {
    const rows =
      input.mintUrl === undefined
        ? await database.resyncSchedules
            .where("[scopeId+mintUrl]")
            .between([input.scopeId, ""], [input.scopeId, "\uffff"], true, true)
            .toArray()
        : [
            (await database.resyncSchedules.get([input.scopeId, input.mintUrl])) ??
              initialSeedRestoreResyncSchedule(input.scopeId, input.mintUrl),
          ];
    // A mint with no schedule yet probes on its first pass anyway.
    for (const row of rows) {
      await database.resyncSchedules.put({ ...row, evidence: row.evidence + 1 });
    }
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
    schemaVersion: 2,
    firstPassEndedAtMs: null,
    initialCompletedAtMs: null,
    hintsDone: false,
    hintFailures: 0,
    catalogueSource: null,
    catalogueCursor: null,
    catalogueDone: false,
    catalogueWalkedAtMs: null,
    nextOrder: 0,
    failures: 0,
    nextAttemptAtMs: 0,
    lastFailure: null,
    itemFailures: 0,
    lastReprobeAtMs: null,
  };
}

const pendingOriginWrites = new Map<string, Promise<void>>();

/**
 * Records that this browser profile generated the seed. The seed restore then
 * skips this profile: it holds every proof of the seed. Call it at generation.
 */
export function recordGeneratedBrowserSeed(scopeId: string, nowMs = Date.now()): Promise<void> {
  const write = seedRestoreDatabase(scopeId)
    .origins.put({ scopeId, origin: "generated", recordedAtMs: nowMs })
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
  await pendingOriginWrites.get(scopeId)?.catch(() => undefined);
  return (await seedRestoreDatabase(scopeId).origins.get(scopeId))?.origin === "generated";
}
