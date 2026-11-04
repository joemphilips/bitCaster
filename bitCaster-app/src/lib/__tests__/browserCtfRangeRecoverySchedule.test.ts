import { describe, expect, it } from "vitest";
import {
  BROWSER_CTF_RANGE_RECOVERY_BACKOFF_MAX_MS,
  BROWSER_CTF_RANGE_RECOVERY_REFUSAL_LIMIT,
  BrowserCtfRangeRecoverySchedule,
} from "../browserCtfRangeRecoverySchedule";

const SCOPE = "custody:wallet:scope";
const OPERATION = "range-operation";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function transient() {
  return { mintError: null, retryAfterMs: null };
}

describe("browser CTF range recovery schedule", () => {
  it("doubles the delay from 15 seconds up to 15 minutes", () => {
    const schedule = new BrowserCtfRangeRecoverySchedule({ random: () => 1 });
    let now = 1_000;
    const delays: number[] = [];
    for (let attempt = 0; attempt < 9; attempt++) {
      expect(schedule.state(SCOPE, OPERATION, now)).toEqual({ kind: "due" });
      schedule.recordFailure(SCOPE, OPERATION, now, transient());
      const state = schedule.state(SCOPE, OPERATION, now);
      if (state.kind !== "waiting") throw new Error("expected a scheduled retry");
      delays.push(state.nextAttemptAtMs - now);
      now = state.nextAttemptAtMs;
    }
    expect(delays).toEqual([
      15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000,
    ]);
    expect(Math.max(...delays)).toBe(BROWSER_CTF_RANGE_RECOVERY_BACKOFF_MAX_MS);
  });

  it("keeps jitter between half and all of the delay", () => {
    const low = new BrowserCtfRangeRecoverySchedule({ random: () => 0 });
    const high = new BrowserCtfRangeRecoverySchedule({ random: () => 0.999 });
    low.recordFailure(SCOPE, OPERATION, 0, transient());
    high.recordFailure(SCOPE, OPERATION, 0, transient());
    expect(low.state(SCOPE, OPERATION, 0)).toEqual({ kind: "waiting", nextAttemptAtMs: 7_500 });
    const state = high.state(SCOPE, OPERATION, 0);
    expect(state.kind).toBe("waiting");
    if (state.kind !== "waiting") return;
    expect(state.nextAttemptAtMs).toBeGreaterThan(14_900);
    expect(state.nextAttemptAtMs).toBeLessThan(15_000);
  });

  it("honors Retry-After and an earlier protocol deadline", () => {
    const schedule = new BrowserCtfRangeRecoverySchedule({ random: () => 1 });
    schedule.recordFailure(SCOPE, OPERATION, 0, { mintError: null, retryAfterMs: 120_000 });
    expect(schedule.state(SCOPE, OPERATION, 0)).toEqual({
      kind: "waiting",
      nextAttemptAtMs: 120_000,
    });
    const deadline = new BrowserCtfRangeRecoverySchedule({ random: () => 1 });
    deadline.recordFailure(SCOPE, OPERATION, 0, {
      mintError: null,
      retryAfterMs: null,
      notAfterMs: 5_000,
    });
    expect(deadline.state(SCOPE, OPERATION, 0)).toEqual({
      kind: "waiting",
      nextAttemptAtMs: 5_000,
    });
  });

  it("halts after identical non-final refusals and resumes for one manual retry", () => {
    const schedule = new BrowserCtfRangeRecoverySchedule({ random: () => 1 });
    const refusal = { mintError: { code: 11002, detail: "Token pending" }, retryAfterMs: null };
    for (let count = 1; count < BROWSER_CTF_RANGE_RECOVERY_REFUSAL_LIMIT; count++) {
      expect(schedule.recordFailure(SCOPE, OPERATION, 0, refusal)).toEqual({ halted: false });
    }
    expect(schedule.recordFailure(SCOPE, OPERATION, 0, refusal)).toEqual({ halted: true });
    expect(schedule.state(SCOPE, OPERATION, Number.MAX_SAFE_INTEGER)).toEqual({
      kind: "halted",
      mintError: refusal.mintError,
    });

    schedule.resume(SCOPE, OPERATION);
    expect(schedule.state(SCOPE, OPERATION, 0)).toEqual({ kind: "due" });
    expect(schedule.recordFailure(SCOPE, OPERATION, 0, refusal)).toEqual({ halted: true });
  });

  it("counts only consecutive identical refusal codes", () => {
    const schedule = new BrowserCtfRangeRecoverySchedule({ random: () => 1 });
    const pending = { mintError: { code: 11002, detail: "Token pending" }, retryAfterMs: null };
    const unknown = { mintError: { code: 50000, detail: "Database error" }, retryAfterMs: null };
    for (let count = 1; count < BROWSER_CTF_RANGE_RECOVERY_REFUSAL_LIMIT; count++) {
      schedule.recordFailure(SCOPE, OPERATION, 0, pending);
    }
    // A transport failure does not change the refusal count.
    schedule.recordFailure(SCOPE, OPERATION, 0, transient());
    expect(schedule.recordFailure(SCOPE, OPERATION, 0, unknown)).toEqual({ halted: false });
    expect(schedule.recordFailure(SCOPE, OPERATION, 0, pending)).toEqual({ halted: false });
  });

  it("resets the backoff when the operation makes progress", () => {
    const schedule = new BrowserCtfRangeRecoverySchedule({ random: () => 1 });
    for (let attempt = 0; attempt < 4; attempt++) {
      schedule.recordFailure(SCOPE, OPERATION, 0, transient());
    }
    schedule.recordProgress(SCOPE, OPERATION);
    expect(schedule.state(SCOPE, OPERATION, 0)).toEqual({ kind: "due" });
    schedule.recordFailure(SCOPE, OPERATION, 0, transient());
    expect(schedule.state(SCOPE, OPERATION, 0)).toEqual({
      kind: "waiting",
      nextAttemptAtMs: 15_000,
    });
  });

  it("shares state through storage and ignores a corrupt stored value", () => {
    const storage = memoryStorage();
    const first = new BrowserCtfRangeRecoverySchedule({ storage, random: () => 1 });
    const second = new BrowserCtfRangeRecoverySchedule({ storage, random: () => 1 });
    first.recordFailure(SCOPE, OPERATION, 0, transient());
    expect(second.state(SCOPE, OPERATION, 0)).toEqual({
      kind: "waiting",
      nextAttemptAtMs: 15_000,
    });
    for (const key of storage.values.keys()) storage.values.set(key, "{not json");
    expect(second.state(SCOPE, OPERATION, 0)).toEqual({ kind: "due" });
    expect(new BrowserCtfRangeRecoverySchedule({ storage }).state("other", OPERATION, 0)).toEqual({
      kind: "due",
    });
  });

  it("bounds the stored operations of one wallet scope", () => {
    const storage = memoryStorage();
    const schedule = new BrowserCtfRangeRecoverySchedule({ storage, random: () => 1 });
    for (let index = 0; index < 300; index++) {
      schedule.recordFailure(SCOPE, `operation-${index}`, index, transient());
    }
    const stored = JSON.parse([...storage.values.values()][0]!) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(stored.entries).length).toBeLessThanOrEqual(128);
    expect(schedule.state(SCOPE, "operation-299", 299).kind).toBe("waiting");
  });
});
