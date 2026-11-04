import Dexie, { type Table } from "dexie";
import { decodeDurableCustodyScopeInput } from "@bitcaster/client-sdk/durableCustody";

// Progress of the automatic seed restore event (ADR-039, amendment
// 2026-11-04). This is a cache. Its loss restarts the restore. It lives in its
// own database, so the wallet database schema and the previous release that
// reads it do not change. The browser deletes both databases of an origin
// together, so an absent origin row means that the wallet data also went away.

export interface SeedRestoreOriginRow {
  readonly scopeId: string;
  /** This browser profile generated the seed. It holds every proof of it. */
  readonly origin: "generated";
  readonly recordedAtMs: number;
}

export interface SeedRestoreStateRow {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly schemaVersion: 1;
  /** The first pass ended (complete, out of budget, or failed). */
  readonly firstPassEndedAtMs: number | null;
  /** Every listed keyset was probed or scanned at least once. */
  readonly initialCompletedAtMs: number | null;
  readonly hintsDone: boolean;
  readonly catalogueSource: "engine" | "mint" | null;
  readonly catalogueCursor: string | null;
  readonly catalogueDone: boolean;
  /** Insertion order of the next condition or keyset row. */
  readonly nextOrder: number;
  readonly failures: number;
  readonly nextAttemptAtMs: number;
  readonly lastFailure: string | null;
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
  /** Probed with no signature. Not final: later startups probe it again. */
  | "no-signature"
  /** Fully scanned. */
  | "restored"
  /** A restored proof was PENDING. A later pass scans it again. */
  | "pending"
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

/**
 * Signed outputs that the mint holds above the local cursor of a keyset in
 * use: another client used the seed, or this browser lost an operation record.
 */
export interface SeedRestoreResyncRow {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly keysetId: string;
  /** Local diagnostic: how many times a startup found such outputs. */
  readonly findings: number;
  readonly lastFoundAtMs: number;
  readonly lastHighestCounter: number;
  /**
   * The counter advanced past outputs that were not admitted yet (for
   * example while an order coordinator held the custody scope). The next pass
   * scans from here and admits them. Null when nothing waits.
   */
  readonly pendingFromCounter: number | null;
}

export class SeedRestoreDB extends Dexie {
  origins!: Table<SeedRestoreOriginRow, string>;
  states!: Table<SeedRestoreStateRow, [string, string]>;
  conditions!: Table<SeedRestoreConditionRow, [string, string, string]>;
  keysets!: Table<SeedRestoreKeysetRow, [string, string, string]>;
  resync!: Table<SeedRestoreResyncRow, [string, string, string]>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      origins: "&scopeId",
      states: "&[scopeId+mintUrl]",
      conditions: "&[scopeId+mintUrl+conditionId], [scopeId+mintUrl]",
      keysets: "&[scopeId+mintUrl+keysetId], [scopeId+mintUrl]",
      resync: "&[scopeId+mintUrl+keysetId], [scopeId+mintUrl]",
    });
  }
}

/**
 * Records signed outputs above a local cursor. With `pending`, it keeps the
 * lowest counter that still waits for admission; a later pass scans from it.
 */
export async function recordSeedRestoreResyncFinding(input: {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly keysetId: string;
  readonly fromCounter: number;
  readonly highestCounter: number;
  readonly pending: boolean;
  readonly nowMs?: number;
}): Promise<void> {
  const database = seedRestoreDatabase(input.scopeId);
  await database.transaction("rw", database.resync, async () => {
    const key: [string, string, string] = [input.scopeId, input.mintUrl, input.keysetId];
    const existing = await database.resync.get(key);
    const pendingFromCounter = !input.pending
      ? (existing?.pendingFromCounter ?? null)
      : existing?.pendingFromCounter == null
        ? input.fromCounter
        : Math.min(existing.pendingFromCounter, input.fromCounter);
    await database.resync.put({
      scopeId: input.scopeId,
      mintUrl: input.mintUrl,
      keysetId: input.keysetId,
      findings: (existing?.findings ?? 0) + 1,
      lastFoundAtMs: input.nowMs ?? Date.now(),
      lastHighestCounter: input.highestCounter,
      pendingFromCounter,
    });
  });
}

/** Clears the pending rescan of one keyset after its outputs were admitted. */
export async function clearSeedRestoreResyncPending(input: {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly keysetId: string;
  readonly fromCounter: number;
}): Promise<void> {
  const database = seedRestoreDatabase(input.scopeId);
  await database.transaction("rw", database.resync, async () => {
    const key: [string, string, string] = [input.scopeId, input.mintUrl, input.keysetId];
    const existing = await database.resync.get(key);
    // A newer deferral below the scanned start stays.
    if (existing?.pendingFromCounter == null || existing.pendingFromCounter < input.fromCounter) {
      return;
    }
    await database.resync.put({ ...existing, pendingFromCounter: null });
  });
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

export function initialSeedRestoreState(scopeId: string, mintUrl: string): SeedRestoreStateRow {
  return {
    scopeId,
    mintUrl,
    schemaVersion: 1,
    firstPassEndedAtMs: null,
    initialCompletedAtMs: null,
    hintsDone: false,
    catalogueSource: null,
    catalogueCursor: null,
    catalogueDone: false,
    nextOrder: 0,
    failures: 0,
    nextAttemptAtMs: 0,
    lastFailure: null,
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
