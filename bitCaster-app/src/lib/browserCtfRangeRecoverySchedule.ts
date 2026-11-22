import {
  CTF_RANGE_RECOVERY_REFUSAL_LIMIT,
  countCtfRangeRecoveryRefusal,
  decodeCtfRangeRefusedRequest,
  resumeCtfRangeRecoveryRefusalCount,
  type CtfRangeRecoveryRefusalCount,
  type CtfRangeRefusedRequest,
} from "@bitcaster/client-sdk/ctfRangeRecoveryRefusal";

/**
 * Per-operation retry schedule for range-order recovery.
 *
 * Recovery sends NUT-07 checks, exact replays, and NUT-09 restores to the
 * mint. Each operation waits a capped exponential delay with jitter after a
 * failed pass. A run of identical non-final refusals of one request stops the
 * automatic replay until the user asks for a retry (the SDK refusal count).
 * The schedule is a load control, not funds authority: losing it only allows
 * an earlier retry.
 *
 * Tabs of one wallet share the schedule through `localStorage`. Their passes
 * already serialize under the wallet profile Web Lock, so a shared schedule
 * keeps two tabs from doubling the mint load.
 */

export const BROWSER_CTF_RANGE_RECOVERY_BACKOFF_BASE_MS = 15_000;
export const BROWSER_CTF_RANGE_RECOVERY_BACKOFF_MAX_MS = 15 * 60_000;
/** Identical non-final refusals of one request before automatic replay stops. */
export const BROWSER_CTF_RANGE_RECOVERY_REFUSAL_LIMIT = CTF_RANGE_RECOVERY_REFUSAL_LIMIT;

const RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;
const SCOPE_OPERATION_LIMIT = 128;
// v2 counts refusals for each refused request. A v1 schedule of release 4 is
// read once and converted: its refusals name no request, and its halts stay.
const STORAGE_KEY_PREFIX = "bitcaster:ctf-range-recovery-schedule:v2:";
const V1_STORAGE_KEY_PREFIX = "bitcaster:ctf-range-recovery-schedule:v1:";

type StoredScheduleVersion = 1 | 2;

export interface BrowserCtfRangeRecoveryMintError {
  readonly code: number;
  readonly detail: string;
}

export type BrowserCtfRangeRecoveryScheduleState =
  | { readonly kind: "due" }
  | { readonly kind: "waiting"; readonly nextAttemptAtMs: number }
  /** A halt without a mint error comes from other evidence, such as a replaced refund plan. */
  | { readonly kind: "halted"; readonly mintError: BrowserCtfRangeRecoveryMintError | null };

export interface BrowserCtfRangeRecoveryFailure {
  /** A mint refusal outside the final set, or null for any other failure. */
  readonly mintError: BrowserCtfRangeRecoveryMintError | null;
  /** The request that the mint refused. Refusals count for each request and each code. */
  readonly refusedRequest?: CtfRangeRefusedRequest | null;
  /** Automatic replay cannot settle the operation. It halts at once, without a mint error. */
  readonly halt?: boolean;
  readonly retryAfterMs: number | null;
  /** A protocol time when the next pass can make progress, such as authorization expiry. */
  readonly notAfterMs?: number | null;
}

export type BrowserCtfRangeRecoveryScheduleStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

interface ScheduleEntry {
  attempt: number;
  nextAttemptAtMs: number;
  refusal: CtfRangeRecoveryRefusalCount | null;
  halted: boolean;
}

export class BrowserCtfRangeRecoverySchedule {
  readonly #storage: BrowserCtfRangeRecoveryScheduleStorage;
  readonly #random: () => number;

  constructor(
    input: {
      readonly storage?: BrowserCtfRangeRecoveryScheduleStorage | null;
      readonly random?: () => number;
    } = {},
  ) {
    this.#storage = input.storage ?? memoryStorage();
    this.#random = input.random ?? Math.random;
  }

  state(scopeId: string, operationId: string, nowMs: number): BrowserCtfRangeRecoveryScheduleState {
    const entry = this.#read(scopeId)[operationId];
    if (entry === undefined) return { kind: "due" };
    if (entry.halted) {
      return {
        kind: "halted",
        mintError:
          entry.refusal === null
            ? null
            : { code: entry.refusal.code, detail: entry.refusal.detail },
      };
    }
    return entry.nextAttemptAtMs > nowMs
      ? { kind: "waiting", nextAttemptAtMs: entry.nextAttemptAtMs }
      : { kind: "due" };
  }

  recordFailure(
    scopeId: string,
    operationId: string,
    nowMs: number,
    failure: BrowserCtfRangeRecoveryFailure,
  ): { halted: boolean } {
    const entries = this.#read(scopeId);
    const previous = entries[operationId];
    const attempt = (previous?.attempt ?? 0) + 1;
    const delay = Math.min(
      BROWSER_CTF_RANGE_RECOVERY_BACKOFF_MAX_MS,
      BROWSER_CTF_RANGE_RECOVERY_BACKOFF_BASE_MS * 2 ** Math.min(attempt - 1, 32),
    );
    const jitter = Math.min(1, Math.max(0, this.#random()));
    let wait = Math.floor(delay * (0.5 + 0.5 * jitter));
    if (failure.retryAfterMs !== null) {
      wait = Math.max(wait, Math.min(RETRY_AFTER_MAX_MS, Math.ceil(failure.retryAfterMs)));
    }
    let nextAttemptAtMs = nowMs + wait;
    const notAfterMs = failure.notAfterMs ?? null;
    if (notAfterMs !== null && notAfterMs > nowMs) {
      nextAttemptAtMs = Math.min(nextAttemptAtMs, notAfterMs);
    }
    // A failure without a mint refusal keeps the count of the last refusal.
    let refusal = previous?.refusal ?? null;
    let halted = false;
    if (failure.halt === true) {
      // The halt is not a mint refusal, so the alert shows no mint code.
      refusal = null;
      halted = true;
    } else if (failure.mintError !== null) {
      const counted = countCtfRangeRecoveryRefusal(refusal, {
        request: failure.refusedRequest ?? null,
        code: failure.mintError.code,
        detail: failure.mintError.detail,
      });
      refusal = counted.refusal;
      halted = counted.halted;
    }
    entries[operationId] = { attempt, nextAttemptAtMs, refusal, halted };
    this.#write(scopeId, entries);
    return { halted };
  }

  /** The operation advanced. Its next failure starts a new backoff. */
  recordProgress(scopeId: string, operationId: string): void {
    const entries = this.#read(scopeId);
    if (!(operationId in entries)) return;
    delete entries[operationId];
    this.#write(scopeId, entries);
  }

  /**
   * Allow one manual retry of a halted operation. The same refusal halts it
   * again at once, so a repeated manual retry sends one request each time.
   */
  resume(scopeId: string, operationId: string): void {
    const entries = this.#read(scopeId);
    const entry = entries[operationId];
    if (entry === undefined) return;
    entries[operationId] = {
      ...entry,
      nextAttemptAtMs: 0,
      halted: false,
      refusal: entry.refusal === null ? null : resumeCtfRangeRecoveryRefusalCount(entry.refusal),
    };
    this.#write(scopeId, entries);
  }

  #read(scopeId: string): Record<string, ScheduleEntry> {
    let raw: string | null;
    let version: StoredScheduleVersion = 2;
    try {
      raw = this.#storage.getItem(storageKey(scopeId));
      if (raw === null) {
        raw = this.#storage.getItem(v1StorageKey(scopeId));
        version = 1;
      }
    } catch {
      return {};
    }
    if (raw === null) return {};
    try {
      return decodeEntries(JSON.parse(raw), version);
    } catch {
      // The schedule is only a load control. A corrupt copy restarts it.
      return {};
    }
  }

  #write(scopeId: string, entries: Record<string, ScheduleEntry>): void {
    const bounded = Object.entries(entries)
      .sort(([, left], [, right]) => right.nextAttemptAtMs - left.nextAttemptAtMs)
      .slice(0, SCOPE_OPERATION_LIMIT);
    try {
      if (bounded.length === 0) this.#storage.removeItem(storageKey(scopeId));
      else
        this.#storage.setItem(
          storageKey(scopeId),
          JSON.stringify({ entries: Object.fromEntries(bounded) }),
        );
      // The v2 copy now holds every converted v1 entry.
      this.#storage.removeItem(v1StorageKey(scopeId));
    } catch {
      // A full or blocked storage keeps the previous schedule.
    }
  }
}

let sharedSchedule: BrowserCtfRangeRecoverySchedule | undefined;

/** The schedule that every browser tab of this origin shares. */
export function sharedBrowserCtfRangeRecoverySchedule(): BrowserCtfRangeRecoverySchedule {
  sharedSchedule ??= new BrowserCtfRangeRecoverySchedule({
    storage: typeof localStorage === "undefined" ? null : localStorage,
  });
  return sharedSchedule;
}

function storageKey(scopeId: string): string {
  return `${STORAGE_KEY_PREFIX}${scopeId}`;
}

function v1StorageKey(scopeId: string): string {
  return `${V1_STORAGE_KEY_PREFIX}${scopeId}`;
}

function memoryStorage(): BrowserCtfRangeRecoveryScheduleStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function decodeEntries(
  value: unknown,
  version: StoredScheduleVersion,
): Record<string, ScheduleEntry> {
  if (typeof value !== "object" || value === null) throw new Error("schedule is invalid");
  const entries = (value as { entries?: unknown }).entries;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    throw new Error("schedule entries are invalid");
  }
  const decoded: Record<string, ScheduleEntry> = {};
  for (const [operationId, entry] of Object.entries(entries)) {
    decoded[operationId] = decodeEntry(entry, version);
  }
  return decoded;
}

function decodeEntry(value: unknown, version: StoredScheduleVersion): ScheduleEntry {
  const entry = value as Partial<ScheduleEntry> | null;
  if (
    entry === null ||
    typeof entry !== "object" ||
    !Number.isSafeInteger(entry.attempt) ||
    !Number.isSafeInteger(entry.nextAttemptAtMs) ||
    typeof entry.halted !== "boolean"
  ) {
    throw new Error("schedule entry is invalid");
  }
  const refusal = entry.refusal;
  if (
    refusal !== null &&
    (typeof refusal !== "object" ||
      !Number.isSafeInteger(refusal?.code) ||
      typeof refusal?.detail !== "string" ||
      !Number.isSafeInteger(refusal?.count) ||
      (version === 1 && Object.hasOwn(refusal, "request")))
  ) {
    throw new Error("schedule refusal is invalid");
  }
  return {
    attempt: entry.attempt!,
    nextAttemptAtMs: entry.nextAttemptAtMs!,
    refusal:
      refusal === undefined || refusal === null
        ? null
        : {
            // A v1 refusal names no request.
            request: version === 1 ? null : decodeCtfRangeRefusedRequest(refusal.request),
            code: refusal.code,
            detail: refusal.detail,
            count: refusal.count,
          },
    halted: entry.halted,
  };
}
