import { useMemo, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  classifyWalletRecoveryStatus,
  sameWalletRecoveryTag,
  WALLET_RECOVERY_PERSISTENT_FAILURES,
  type WalletRecoveryFailureCount,
  type WalletRecoveryPendingReason,
  type WalletRecoveryStageObservation,
  type WalletRecoveryStatus,
  type WalletRecoveryTag,
} from "@bitcaster/client-sdk/walletRecoveryStatus";
import {
  activeBrowserWalletActivation,
  browserWalletDatabaseName,
  browserWalletScopeIdFromMnemonic,
  subscribeBrowserWalletActivation,
} from "@/lib/browserWalletProfile";
import {
  getWalletRecoveryPassSummary,
  subscribeWalletRecoveryPassSummary,
  walletRecoveryMintUrls,
  walletRecoveryTag,
  type WalletRecoveryCounterStage,
  type WalletRecoveryPassSummary,
  type WalletRecoverySeedRestoreStage,
  type WalletRecoveryWalletStage,
} from "@/lib/walletRecoveryPassSummary";
import { db, type BrowserWalletCounterAssociationRow } from "@/stores/proof-db";
import {
  isSeedRestoreScanCapped,
  readBrowserSeedRestoreRuns,
  readSeedRestoreResyncRow,
  seedRestoreDatabase,
  seedRestoreKeysetRefused,
  seedRestoreResultIsPartial,
  type SeedRestoreKeysetRow,
  type SeedRestoreResyncRow,
  type SeedRestoreResyncScheduleRow,
  type SeedRestoreStateRow,
} from "@/stores/seed-restore-db";
import { useWalletStore } from "@/stores/wallet";

/** The durable recovery rows of one wallet mint. */
export interface WalletRecoveryDurableMintRows {
  readonly state: SeedRestoreStateRow | null;
  /** The keysets that the restore or an index read scans. */
  readonly keysets: readonly SeedRestoreKeysetRow[];
  readonly resync: readonly SeedRestoreResyncRow[];
  readonly schedule: SeedRestoreResyncScheduleRow | null;
  readonly associations: readonly BrowserWalletCounterAssociationRow[];
}

/** One read of the durable recovery rows, tagged with the activation and mint set it read. */
export type WalletRecoveryDurableRead =
  | {
      readonly kind: "ok";
      readonly tag: WalletRecoveryTag;
      /** The seed restore event runs for this profile (ADR-039, amendment 2026-11-09). */
      readonly restoreRuns: boolean;
      /** Keyed by the normalized mint URL. */
      readonly mints: ReadonlyMap<string, WalletRecoveryDurableMintRows>;
    }
  | { readonly kind: "failed"; readonly tag: WalletRecoveryTag };

const WALLET_STAGES: readonly WalletRecoveryWalletStage[] = [
  "receives",
  "mints",
  "rangeOrders",
  "outgoing",
];
const REGULAR_COUNTER_UNIT = "msat";

/**
 * The status of the automatic wallet recovery of the active wallet (issue
 * #161). It combines this page's pass summary with the durable recovery rows,
 * and classifies them with the SDK rule.
 */
export function useWalletRecoveryStatus(): WalletRecoveryStatus {
  // Read the store through its external-store interface. Many component tests
  // replace the wallet store with a plain object that has only `getState`.
  const walletKey = useSyncExternalStore(subscribeToWallet, readWalletKey, readWalletKey);
  const activation = useSyncExternalStore(
    subscribeBrowserWalletActivation,
    activeBrowserWalletActivation,
    activeBrowserWalletActivation,
  );
  const summary = useSyncExternalStore(
    subscribeWalletRecoveryPassSummary,
    getWalletRecoveryPassSummary,
    getWalletRecoveryPassSummary,
  );
  const [mnemonic = "", mintKey = ""] = walletKey.split("\u0000");
  const mintUrls = useMemo(() => walletRecoveryMintUrls(mintKey.split("\n")), [mintKey]);
  const scopeId = activeWalletScopeId(mnemonic, activation.scopeId);
  const current = useMemo(
    () =>
      scopeId === null ? null : walletRecoveryTag({ scopeId, epoch: activation.epoch }, mintUrls),
    [scopeId, activation.epoch, mintUrls],
  );
  // The deps carry the epoch, so a kept result of an earlier activation has another tag.
  const durable = useLiveQuery(
    () => (current === null ? undefined : readWalletRecoveryDurableRows(current, mintUrls)),
    [current],
  );
  return useMemo(
    () => browserWalletRecoveryStatus({ current, mintUrls, summary, durable }),
    [current, mintUrls, summary, durable],
  );
}

/**
 * Reads the durable recovery rows of the wallet mints of one tag. A read
 * failure gives a failed read, which the status shows as unavailable.
 */
export async function readWalletRecoveryDurableRows(
  tag: WalletRecoveryTag,
  mintUrls: readonly string[],
): Promise<WalletRecoveryDurableRead> {
  const { scopeId } = tag.activation;
  try {
    // The counter associations live in the wallet database of this scope.
    if (db.name !== browserWalletDatabaseName(scopeId)) {
      throw new Error("The wallet database is not the active wallet.");
    }
    const database = seedRestoreDatabase(scopeId);
    const restoreRuns = await readBrowserSeedRestoreRuns(scopeId, db);
    const mints = new Map<string, WalletRecoveryDurableMintRows>();
    for (const mintUrl of mintUrls) {
      const [state, keysets, resync, schedule, associations] = await Promise.all([
        database.states.get([scopeId, mintUrl]),
        database.keysets.where("[scopeId+mintUrl]").equals([scopeId, mintUrl]).toArray(),
        database.resync.where("[scopeId+mintUrl]").equals([scopeId, mintUrl]).toArray(),
        database.resyncSchedules.get([scopeId, mintUrl]),
        db.walletCounterAssociations
          .where("[scopeId+normalizedMint+unit]")
          .equals([scopeId, mintUrl, REGULAR_COUNTER_UNIT])
          .toArray(),
      ]);
      mints.set(mintUrl, {
        state: state ?? null,
        keysets,
        resync: resync.map(readKnownResyncRow),
        schedule: schedule ?? null,
        associations,
      });
    }
    return { kind: "ok", tag, restoreRuns, mints };
  } catch {
    return { kind: "failed", tag };
  }
}

const RESYNC_WAITS: ReadonlySet<SeedRestoreResyncRow["waitReason"]> = new Set([
  "pending-proof",
  "scan-budget",
  "admission-failed",
  null,
]);

/** An unknown stored wait reason fails the read. It never gets a business meaning. */
function readKnownResyncRow(row: SeedRestoreResyncRow): SeedRestoreResyncRow {
  if (!RESYNC_WAITS.has(row.waitReason))
    throw new Error("A seed restore deferral wait is unknown.");
  return readSeedRestoreResyncRow(row);
}

/**
 * Maps this page's pass summary and the durable rows to SDK observations,
 * and classifies them. A durable read of another tag is not known yet.
 * Durable rows of a mint outside the tag are not read.
 */
export function browserWalletRecoveryStatus(input: {
  readonly current: WalletRecoveryTag | null;
  readonly mintUrls: readonly string[];
  readonly summary: WalletRecoveryPassSummary | null;
  readonly durable: WalletRecoveryDurableRead | undefined;
}): WalletRecoveryStatus {
  const { current, mintUrls, durable } = input;
  if (current === null) {
    return classifyWalletRecoveryStatus({
      current,
      observations: "read-failed",
      persistentFailures: [],
    });
  }
  if (durable === undefined || !sameWalletRecoveryTag(durable.tag, current)) {
    return classifyWalletRecoveryStatus({
      current,
      observations: { tag: current, passSeq: 0, stages: [] },
      persistentFailures: [],
    });
  }
  if (durable.kind === "failed") {
    return classifyWalletRecoveryStatus({
      current,
      observations: "read-failed",
      persistentFailures: [],
    });
  }
  // A summary of another tag gives no stage. The SDK then classifies it as stale.
  const summary =
    input.summary !== null && sameWalletRecoveryTag(input.summary.tag, current)
      ? input.summary
      : null;
  const stages: WalletRecoveryStageObservation[] = [];
  const persistentFailures: WalletRecoveryFailureCount[] = [];
  for (const stage of WALLET_STAGES) stages.push(summary?.wallet[stage] ?? notRun(stage));
  for (const mintUrl of mintUrls) {
    const rows = durable.mints.get(mintUrl);
    if (rows === undefined) throw new Error("a wallet recovery read misses a wallet mint");
    const passed = summary?.mints.get(mintUrl);
    stages.push(regularCounterStage(mintUrl, passed?.regularCounters ?? null, rows));
    stages.push(passed?.resyncPass ?? notRun(`resyncPass ${mintUrl}`));
    resyncObservations(mintUrl, rows, stages, persistentFailures);
    restoreScanObservations(mintUrl, rows, stages, persistentFailures);
    if (durable.restoreRuns) {
      seedRestoreObservations(
        mintUrl,
        passed?.seedRestorePass ?? null,
        rows,
        stages,
        persistentFailures,
      );
    }
  }
  return classifyWalletRecoveryStatus({
    current,
    observations: {
      tag: input.summary?.tag ?? current,
      passSeq: input.summary?.passSeq ?? 0,
      stages,
    },
    persistentFailures,
  });
}

/**
 * The coordinator runs the counters once. A result that is neither complete
 * nor failed completes only when every listed keyset has a complete counter
 * association and no deferral marker at this mint.
 */
function regularCounterStage(
  mintUrl: string,
  passed: WalletRecoveryCounterStage | null,
  rows: WalletRecoveryDurableMintRows,
): WalletRecoveryStageObservation {
  const stage = `regularCounters ${mintUrl}`;
  if (passed === null) return notRun(stage);
  if (passed.observation.state !== "pending") return passed.observation;
  const deferred = new Map(
    rows.resync.filter((row) => row.pendingFromCounter !== null).map((row) => [row.keysetId, row]),
  );
  const complete = new Set(
    rows.associations.filter((row) => row.recoveryComplete === true).map((row) => row.keysetId),
  );
  const postponed = new Set(passed.postponedKeysets);
  const waiting = [...new Set([...passed.pendingKeysets, ...passed.postponedKeysets])].filter(
    (keysetId) => !complete.has(keysetId) || deferred.has(keysetId),
  );
  if (waiting.length === 0) return { stage, state: "completed", coverage: "full" };
  let retryAtMs: number | null = null;
  for (const keysetId of waiting) {
    const due = dueAt(deferred.get(keysetId)?.nextAttemptAtMs ?? 0);
    if (due !== null && (retryAtMs === null || due < retryAtMs)) retryAtMs = due;
  }
  const reason: WalletRecoveryPendingReason = waiting.some((keysetId) => postponed.has(keysetId))
    ? "operation"
    : "proof-pending";
  return { stage, state: "pending", reason, retryAtMs };
}

/** The deferral markers and the evidence-triggered probe of the re-sync (ADR-033). */
function resyncObservations(
  mintUrl: string,
  rows: WalletRecoveryDurableMintRows,
  stages: WalletRecoveryStageObservation[],
  persistentFailures: WalletRecoveryFailureCount[],
): void {
  for (const row of rows.resync) {
    if (row.pendingFromCounter === null) continue;
    const source = `resync ${mintUrl} ${row.keysetId}`;
    const retryAtMs = dueAt(row.nextAttemptAtMs);
    switch (row.waitReason) {
      case "pending-proof":
        stages.push({ stage: source, state: "pending", reason: "proof-pending", retryAtMs });
        break;
      case "scan-budget":
        stages.push({ stage: source, state: "pending", reason: "scan-continues", retryAtMs });
        // At the continuation cap, only Retry continues the scan.
        persistentFailures.push({
          source,
          consecutiveFailures: isSeedRestoreScanCapped(row)
            ? Math.max(row.failures, WALLET_RECOVERY_PERSISTENT_FAILURES)
            : row.failures,
          retryAtMs,
        });
        break;
      case "admission-failed":
        stages.push({ stage: source, state: "pending", reason: "backoff", retryAtMs });
        persistentFailures.push({ source, consecutiveFailures: row.failures, retryAtMs });
        break;
      case null:
        // A marker that a probe hit wrote. The next re-sync admits it.
        stages.push({ stage: source, state: "pending", reason: "scan-continues", retryAtMs });
        break;
      default:
        throw new Error(`unknown seed restore deferral wait: ${JSON.stringify(row.waitReason)}`);
    }
  }
  const schedule = rows.schedule;
  if (schedule === null) return;
  const source = `resync probe ${mintUrl}`;
  const retryAtMs = dueAt(schedule.nextProbeAtMs);
  if (schedule.evidence > schedule.handledEvidence) {
    stages.push({ stage: source, state: "pending", reason: "probe-due", retryAtMs });
  }
  persistentFailures.push({ source, consecutiveFailures: schedule.probeFailures, retryAtMs });
}

/**
 * The keyset scans of the restore and of the index reads (ADR-051 "Restore").
 * A scan that continues keeps the recovery pending. A refused keyset ends its
 * scan, but the browser cannot know its funds, so empty holdings are not final.
 */
function restoreScanObservations(
  mintUrl: string,
  rows: WalletRecoveryDurableMintRows,
  stages: WalletRecoveryStageObservation[],
  persistentFailures: WalletRecoveryFailureCount[],
): void {
  // A restore that stopped at its counter budget does not continue its plan
  // until Retry. Its result shows as partial, with Retry (ADR-039).
  const stopped = rows.state?.budgetStopped === true && rows.state.initialCompletedAtMs === null;
  for (const row of rows.keysets) {
    const stage = `restoreScan ${mintUrl} ${row.keysetId}`;
    if (seedRestoreKeysetRefused(row.state) || (stopped && row.state === "queued")) {
      stages.push({ stage, state: "completed", coverage: "limited" });
      continue;
    }
    if (row.state !== "queued") continue;
    const retryAtMs = dueAt(row.nextAttemptAtMs);
    stages.push({
      stage,
      state: "pending",
      reason: row.failures > 0 ? "backoff" : "scan-continues",
      retryAtMs,
    });
    persistentFailures.push({ source: stage, consecutiveFailures: row.failures, retryAtMs });
  }
}

/** The automatic seed restore (ADR-039, amendment 2026-11-09). */
function seedRestoreObservations(
  mintUrl: string,
  passed: WalletRecoverySeedRestoreStage | null,
  rows: WalletRecoveryDurableMintRows,
  stages: WalletRecoveryStageObservation[],
  persistentFailures: WalletRecoveryFailureCount[],
): void {
  const stage = `seedRestore ${mintUrl}`;
  const state = rows.state;
  if (state === null) {
    // A denied start writes no row. This page's pass knows its resume time.
    const startLimitRetryAtMs = passed?.startLimitRetryAtMs ?? null;
    stages.push(
      startLimitRetryAtMs === null
        ? notRun(stage)
        : { stage, state: "pending", reason: "start-limit", retryAtMs: startLimitRetryAtMs },
    );
    return;
  }
  persistentFailures.push({
    source: stage,
    consecutiveFailures: Math.max(state.failures, state.itemFailures),
    retryAtMs: dueAt(state.nextAttemptAtMs),
  });
  if (state.initialCompletedAtMs === null && !state.budgetStopped) {
    stages.push({
      stage,
      state: "pending",
      reason: "scan-continues",
      retryAtMs: dueAt(state.nextAttemptAtMs),
    });
    return;
  }
  const observation = passed?.observation ?? notRun(stage);
  // With no index, an unavailable index, or a stop at the budget, the result
  // is partial: empty holdings are not final (ADR-039 "Restore order").
  stages.push(
    observation.state === "completed" && seedRestoreResultIsPartial(state, rows.keysets)
      ? { ...observation, coverage: "limited" }
      : observation,
  );
}

function notRun(stage: string): WalletRecoveryStageObservation {
  return { stage, state: "not-run" };
}

/** A durable time of 0 means that the work is due now, not at a known time. */
function dueAt(ms: number): number | null {
  return ms > 0 ? ms : null;
}

/**
 * The scope of the wallet mnemonic when it is the active profile, or null.
 * A missing or invalid mnemonic, or one that is not the active profile, has
 * no recovery status.
 */
function activeWalletScopeId(mnemonic: string, activeScopeId: string | null): string | null {
  if (mnemonic === "" || activeScopeId === null) return null;
  try {
    return browserWalletScopeIdFromMnemonic(mnemonic) === activeScopeId ? activeScopeId : null;
  } catch {
    return null;
  }
}

/**
 * True when this browser holds a set-up wallet. Then a missing wallet profile
 * is an error that the status row reports. A visitor without a wallet sees
 * the wallet setup instead.
 */
export function useWalletProfileExpected(): boolean {
  return useSyncExternalStore(subscribeToWallet, readWalletExpected, readWalletExpected);
}

type WalletStoreLike = {
  getState?: () =>
    | { mnemonic?: string; setupComplete?: boolean; mints?: readonly { url: string }[] }
    | undefined;
  subscribe?: (listener: () => void) => () => void;
};

function subscribeToWallet(listener: () => void): () => void {
  return (useWalletStore as unknown as WalletStoreLike).subscribe?.(listener) ?? (() => {});
}

function readWalletKey(): string {
  const state = (useWalletStore as unknown as WalletStoreLike).getState?.();
  const mints = (state?.mints ?? []).map(({ url }) => url).join("\n");
  return `${state?.mnemonic ?? ""}\u0000${mints}`;
}

function readWalletExpected(): boolean {
  const state = (useWalletStore as unknown as WalletStoreLike).getState?.();
  return state?.setupComplete === true && (state.mnemonic ?? "") !== "";
}
