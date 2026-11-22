import {
  sameWalletRecoveryTag,
  walletRecoveryMintSetTag,
  type WalletRecoveryActivation,
  type WalletRecoveryPendingReason,
  type WalletRecoveryStageObservation,
  type WalletRecoveryTag,
} from "@bitcaster/client-sdk/walletRecoveryStatus";
import type { BrowserSeedPositionRestorePassResult } from "@/lib/browserSeedPositionRestore";
import type { KeysetRecoveryResult } from "@/lib/cashu";
import { normalizeUrl } from "@/lib/url";

/**
 * The display-only summary of the recovery passes of the current wallet
 * activation (issue #161). It holds the stage results that no durable record
 * keeps, so the recovery status can tell a stage that ran from one that did
 * not run yet.
 *
 * - It lives in page memory only. A reload starts without a pass.
 * - Only the recovery coordinator writes it. Only the recovery status reads
 *   it. Spending, backup, admission, scheduling and the engine never read it.
 * - A pass shows each stage result at once. A pass that the activation
 *   stopped is dropped with all its writes. Only a pass that ran every stage
 *   increments `passSeq`.
 */

export type WalletRecoveryWalletStage = "receives" | "mints" | "rangeOrders" | "outgoing";

/** The result of one stage run, before the summary adds the failure count. */
export type WalletRecoveryStageOutcome =
  | { readonly state: "completed" }
  | {
      readonly state: "pending";
      readonly reason: WalletRecoveryPendingReason;
      readonly retryAtMs: number | null;
    }
  | { readonly state: "failed"; readonly retryAtMs: number | null };

export interface WalletRecoveryCounterStage {
  readonly observation: WalletRecoveryStageObservation;
  /**
   * The keysets of a counter result that is neither complete nor failed. The
   * coordinator does not run the counters again, so these keysets complete
   * only through their durable association and re-sync rows.
   */
  readonly pendingKeysets: readonly string[];
  /** The keysets whose scan met custody work in flight. */
  readonly postponedKeysets: readonly string[];
}

export interface WalletRecoverySeedRestoreStage {
  readonly observation: WalletRecoveryStageObservation;
  /**
   * The resume time of a pass that returned `waiting`. Without a restore row,
   * that result is a denial of the start limit.
   */
  readonly startLimitRetryAtMs: number | null;
}

export interface WalletRecoveryMintPassSummary {
  readonly regularCounters: WalletRecoveryCounterStage | null;
  readonly resyncPass: WalletRecoveryStageObservation | null;
  readonly seedRestorePass: WalletRecoverySeedRestoreStage | null;
}

export interface WalletRecoveryPassSummary {
  readonly tag: WalletRecoveryTag;
  /** Passes of this tag that ran every stage. */
  readonly passSeq: number;
  readonly wallet: Readonly<
    Record<WalletRecoveryWalletStage, WalletRecoveryStageObservation | null>
  >;
  /** Keyed by the normalized mint URL. */
  readonly mints: ReadonlyMap<string, WalletRecoveryMintPassSummary>;
}

export interface WalletRecoveryPassWriter {
  walletStage(stage: WalletRecoveryWalletStage, outcome: WalletRecoveryStageOutcome): void;
  /** `"error"`: the counter recovery of this mint threw. */
  regularCounters(
    mintUrl: string,
    result: KeysetRecoveryResult | "error",
    failureRetryAtMs: number,
  ): void;
  resyncPass(mintUrl: string, outcome: WalletRecoveryStageOutcome): void;
  /** `"error"`: the restore pass of this mint threw. */
  seedRestorePass(
    mintUrl: string,
    result: BrowserSeedPositionRestorePassResult | "error",
    continueAtMs: number,
  ): void;
  /** The pass ran every stage. */
  complete(): void;
  /** The pass stopped early. Its writes are dropped. */
  discard(): void;
}

/** The normalized, nonempty and distinct wallet mint URLs, in their first order. */
export function walletRecoveryMintUrls(urls: readonly string[]): string[] {
  const normalized = urls.map(normalizeUrl).filter((url) => url !== "");
  return [...new Set(normalized)];
}

export function walletRecoveryTag(
  activation: WalletRecoveryActivation,
  mintUrls: readonly string[],
): WalletRecoveryTag {
  return {
    activation: { scopeId: activation.scopeId, epoch: activation.epoch },
    mintSetTag: walletRecoveryMintSetTag(walletRecoveryMintUrls(mintUrls)),
  };
}

const NO_WALLET_STAGES: WalletRecoveryPassSummary["wallet"] = Object.freeze({
  receives: null,
  mints: null,
  rangeOrders: null,
  outgoing: null,
});
const NO_MINT_STAGES: WalletRecoveryMintPassSummary = Object.freeze({
  regularCounters: null,
  resyncPass: null,
  seedRestorePass: null,
});

/** The summary of the passes that ran every stage. */
let base: WalletRecoveryPassSummary | null = null;
/** The pass that runs now. Its record shows its writes before it ends. */
let open: { readonly token: object; record: WalletRecoveryPassSummary } | null = null;
const listeners = new Set<() => void>();

export function getWalletRecoveryPassSummary(): WalletRecoveryPassSummary | null {
  return open?.record ?? base;
}

export function subscribeWalletRecoveryPassSummary(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Starts a pass of the coordinator. A pass of another tag replaces the
 * record. A pass that is still open is dropped: its coordinator stopped.
 * A write while `isCurrent` is false drops the pass.
 */
export function beginWalletRecoveryPass(
  tag: WalletRecoveryTag,
  isCurrent: () => boolean,
): WalletRecoveryPassWriter {
  const before = getWalletRecoveryPassSummary();
  if (base === null || !sameWalletRecoveryTag(base.tag, tag)) {
    base = Object.freeze({ tag, passSeq: 0, wallet: NO_WALLET_STAGES, mints: new Map() });
  }
  const token = {};
  open = { token, record: base };
  notifyIfChanged(before);

  const isOpen = () => open?.token === token;
  const write = (update: (record: WalletRecoveryPassSummary) => WalletRecoveryPassSummary) => {
    if (!isOpen()) return;
    if (!isCurrent()) {
      drop();
      return;
    }
    open!.record = Object.freeze(update(open!.record));
    notify();
  };
  const drop = () => {
    if (!isOpen()) return;
    const previous = getWalletRecoveryPassSummary();
    open = null;
    notifyIfChanged(previous);
  };
  const writeMint = (
    mintUrl: string,
    update: (
      stages: WalletRecoveryMintPassSummary,
      name: (stage: string) => string,
    ) => Partial<WalletRecoveryMintPassSummary>,
  ) => {
    const url = normalizeUrl(mintUrl);
    write((record) => {
      const stages = record.mints.get(url) ?? NO_MINT_STAGES;
      const mints = new Map(record.mints);
      mints.set(url, Object.freeze({ ...stages, ...update(stages, (stage) => `${stage} ${url}`) }));
      return { ...record, mints };
    });
  };

  return {
    walletStage(stage, outcome) {
      write((record) => ({
        ...record,
        wallet: Object.freeze({
          ...record.wallet,
          [stage]: observe(stage, outcome, record.wallet[stage]),
        }),
      }));
    },
    regularCounters(mintUrl, result, failureRetryAtMs) {
      writeMint(mintUrl, (stages, name) => {
        const previous = stages.regularCounters?.observation ?? null;
        const stage = name("regularCounters");
        if (result === "error" || result.failed === true) {
          return {
            regularCounters: {
              observation: observe(
                stage,
                { state: "failed", retryAtMs: failureRetryAtMs },
                previous,
              ),
              pendingKeysets: [],
              postponedKeysets: [],
            },
          };
        }
        if (result.complete) {
          return {
            regularCounters: {
              observation: observe(stage, { state: "completed" }, previous),
              pendingKeysets: [],
              postponedKeysets: [],
            },
          };
        }
        const postponedKeysets = [...(result.postponedKeysets ?? [])];
        return {
          regularCounters: {
            observation: observe(
              stage,
              {
                state: "pending",
                reason: postponedKeysets.length > 0 ? "operation" : "proof-pending",
                retryAtMs: null,
              },
              previous,
            ),
            pendingKeysets: [...(result.pendingKeysets ?? [])],
            postponedKeysets,
          },
        };
      });
    },
    resyncPass(mintUrl, outcome) {
      writeMint(mintUrl, (stages, name) => ({
        resyncPass: observe(name("resyncPass"), outcome, stages.resyncPass),
      }));
    },
    seedRestorePass(mintUrl, result, continueAtMs) {
      writeMint(mintUrl, (stages, name) => ({
        seedRestorePass: {
          observation: observe(
            name("seedRestorePass"),
            seedRestoreOutcome(result, continueAtMs),
            stages.seedRestorePass?.observation ?? null,
          ),
          startLimitRetryAtMs:
            result !== "error" && result.status === "waiting" ? result.retryAtMs : null,
        },
      }));
    },
    complete() {
      if (!isOpen()) return;
      if (!isCurrent()) {
        drop();
        return;
      }
      base = Object.freeze({ ...open!.record, passSeq: base!.passSeq + 1 });
      open = null;
      notify();
    },
    discard: drop,
  };
}

/**
 * A `waiting` pass result with a restore row waits for a backoff or for
 * other work, so the row decides. A `failed` result counts its failures in
 * the restore row, which the status reads.
 */
function seedRestoreOutcome(
  result: BrowserSeedPositionRestorePassResult | "error",
  continueAtMs: number,
): WalletRecoveryStageOutcome {
  if (result === "error") return { state: "failed", retryAtMs: continueAtMs };
  switch (result.status) {
    case "complete":
    case "waiting":
    case "skipped":
      return { state: "completed" };
    case "more":
      return { state: "pending", reason: "scan-continues", retryAtMs: continueAtMs };
    case "failed":
      return { state: "pending", reason: "backoff", retryAtMs: result.retryAtMs };
    default:
      throw new Error(
        `unknown seed restore pass status: ${JSON.stringify((result as { status: unknown }).status)}`,
      );
  }
}

/** A failure counts one more than a failure before it. A success resets the count. */
function observe(
  stage: string,
  outcome: WalletRecoveryStageOutcome,
  previous: WalletRecoveryStageObservation | null,
): WalletRecoveryStageObservation {
  switch (outcome.state) {
    case "completed":
      return { stage, state: "completed", coverage: "full" };
    case "pending":
      return { stage, state: "pending", reason: outcome.reason, retryAtMs: outcome.retryAtMs };
    case "failed":
      return {
        stage,
        state: "failed",
        consecutiveFailures: previous?.state === "failed" ? previous.consecutiveFailures + 1 : 1,
        retryAtMs: outcome.retryAtMs,
      };
    default:
      throw new Error(
        `unknown wallet recovery stage outcome: ${JSON.stringify((outcome as { state: unknown }).state)}`,
      );
  }
}

function notifyIfChanged(previous: WalletRecoveryPassSummary | null): void {
  if (getWalletRecoveryPassSummary() !== previous) notify();
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}
