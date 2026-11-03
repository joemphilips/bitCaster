/**
 * Coverage for `waitForMintQuotePaid` — the bounded mint-quote poller that
 * replaces the P8 forever-spinner.
 *
 * Each branch of the discriminated `MintQuoteWaitResult` is exercised:
 *   - PAID via the polling path
 *   - ISSUED → terminal ERROR (don't loop on already-minted quotes)
 *   - bolt11 expiry → terminal EXPIRED
 *   - repeated transient poll errors → propagate via onTransientError, not terminal
 *   - unsubscribe stops further polls
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MintQuoteResponse, PartialMintQuoteResponse } from "@cashu/cashu-ts";

// Mock the wallet store so the cashu.ts `getWallet()` short-circuits into our
// mock wallet instead of constructing a real `CashuWallet` (which would try to
// hit the network in jsdom). cashu.ts:48-52 — when the store carries a
// mnemonic it delegates to `store.getWallet(mintUrl)`.
const mockCheckMintQuote = vi.fn<(id: string) => Promise<PartialMintQuoteResponse>>();
const mockMintQuoteUpdates =
  vi.fn<
    (
      ids: string[],
      update: (q: PartialMintQuoteResponse) => void,
      err: (e: Error) => void,
    ) => Promise<() => void>
  >();

const fakeWallet = {
  checkMintQuote: (id: string) => mockCheckMintQuote(id),
  on: {
    mintQuoteUpdates: (
      ids: string[],
      update: (q: PartialMintQuoteResponse) => void,
      e: (err: Error) => void,
    ) => mockMintQuoteUpdates(ids, update, e),
  },
};

vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => ({
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      mints: [],
      getWallet: async () => fakeWallet,
    }),
  },
}));

import {
  waitForMintQuotePaid as waitForProductMintQuotePaid,
  type MintQuoteWaitResult,
} from "../cashu";

const NOW_SEC = 1_700_000_000;
const POLL_MS = 50;

function waitForMintQuotePaid(
  quote: MintQuoteResponse,
  onResult: (result: MintQuoteWaitResult) => void,
  options: Parameters<typeof waitForProductMintQuotePaid>[2],
) {
  return waitForProductMintQuotePaid(quote, onResult, options, undefined, "sat");
}

function makeQuote(overrides: Partial<MintQuoteResponse> = {}): MintQuoteResponse {
  return {
    quote: "q-test-1",
    request: "lnbc-test",
    amount: 1000,
    unit: "sat",
    state: "UNPAID",
    expiry: NOW_SEC + 3600, // 1h in the future by default
    ...overrides,
  } as unknown as MintQuoteResponse;
}

function partialQuote(state: "UNPAID" | "PAID" | "ISSUED"): PartialMintQuoteResponse {
  return {
    quote: "q-test-1",
    request: "lnbc-test",
    amount: 1000,
    unit: "sat",
    state,
    expiry: NOW_SEC + 3600,
  } as unknown as PartialMintQuoteResponse;
}

describe("waitForMintQuotePaid", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    mockCheckMintQuote.mockReset();
    mockMintQuoteUpdates.mockReset();
    // Default: WS subscribe pends forever — polling carries the suite.
    mockMintQuoteUpdates.mockReturnValue(new Promise(() => {}));
  });
  afterEach(() => vi.useRealTimers());

  it('fires PAID when the poll observes state="PAID"', async () => {
    mockCheckMintQuote.mockResolvedValueOnce(partialQuote("PAID"));
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>();

    await waitForMintQuotePaid(makeQuote(), onResult, { pollIntervalMs: POLL_MS });
    await vi.advanceTimersByTimeAsync(POLL_MS + 5);

    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult.mock.calls[0][0].status).toBe("PAID");
  });

  it("fires terminal ERROR when ISSUED arrives without us having minted", async () => {
    mockCheckMintQuote.mockResolvedValueOnce(partialQuote("ISSUED"));
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>();

    await waitForMintQuotePaid(makeQuote(), onResult, { pollIntervalMs: POLL_MS });
    await vi.advanceTimersByTimeAsync(POLL_MS + 5);

    expect(onResult).toHaveBeenCalledOnce();
    const result = onResult.mock.calls[0][0];
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.error.message).toMatch(/already issued/i);
    }
  });

  it("fires EXPIRED at the bolt11 expiry boundary instead of polling forever", async () => {
    // Quote expires in 5 seconds.
    mockCheckMintQuote.mockResolvedValue(partialQuote("UNPAID"));
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>();

    await waitForMintQuotePaid(makeQuote({ expiry: NOW_SEC + 5 }), onResult, {
      pollIntervalMs: POLL_MS,
    });

    // Advance past expiry — poll keeps returning UNPAID; expiry timer fires.
    await vi.advanceTimersByTimeAsync(5_500);

    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult.mock.calls[0][0].status).toBe("EXPIRED");
  });

  it("fires EXPIRED immediately when the quote is already past expiry at call time", async () => {
    mockCheckMintQuote.mockResolvedValue(partialQuote("UNPAID"));
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>();

    await waitForMintQuotePaid(
      makeQuote({ expiry: NOW_SEC - 10 }), // already expired
      onResult,
      { pollIntervalMs: POLL_MS },
    );
    await vi.advanceTimersByTimeAsync(5);

    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult.mock.calls[0][0].status).toBe("EXPIRED");
  });

  it("reports repeated transient poll errors via onTransientError without firing terminal", async () => {
    mockCheckMintQuote.mockRejectedValue(new Error("mint network blip"));
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>();
    const onTransientError = vi.fn<(e: Error) => void>();

    await waitForMintQuotePaid(makeQuote(), onResult, {
      pollIntervalMs: POLL_MS,
      onTransientError,
    });
    await vi.advanceTimersByTimeAsync(POLL_MS * 3 + 5);

    expect(onResult).not.toHaveBeenCalled();
    expect(onTransientError.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onTransientError.mock.calls[0][0].message).toMatch(/network blip/i);
  });

  it("unsubscribe stops further polling and prevents the result callback", async () => {
    mockCheckMintQuote.mockImplementation(async () => partialQuote("PAID"));
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>();

    const unsub = await waitForMintQuotePaid(makeQuote(), onResult, {
      pollIntervalMs: POLL_MS,
    });
    unsub();
    await vi.advanceTimersByTimeAsync(POLL_MS * 5 + 5);

    expect(onResult).not.toHaveBeenCalled();
  });

  it("checks the quote at once and then at each poll interval", async () => {
    const checkedAtMs: number[] = [];
    mockCheckMintQuote.mockImplementation(async () => {
      checkedAtMs.push(Date.now() - NOW_SEC * 1000);
      return partialQuote("UNPAID");
    });

    const unsub = await waitForMintQuotePaid(makeQuote(), vi.fn(), { pollIntervalMs: POLL_MS });
    await vi.advanceTimersByTimeAsync(0);
    expect(checkedAtMs).toEqual([0]);
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    unsub();

    expect(checkedAtMs).toEqual([0, POLL_MS, POLL_MS * 2]);
  });

  it("reads the current poll interval before it schedules each later check", async () => {
    const checkedAtMs: number[] = [];
    mockCheckMintQuote.mockImplementation(async () => {
      checkedAtMs.push(Date.now() - NOW_SEC * 1000);
      return partialQuote("UNPAID");
    });
    let intervalMs = POLL_MS;

    const unsub = await waitForMintQuotePaid(makeQuote(), vi.fn(), {
      pollIntervalMs: () => intervalMs,
    });
    // The checks at 0 and 50 ms both schedule their next check 50 ms later.
    await vi.advanceTimersByTimeAsync(POLL_MS + POLL_MS / 2);
    intervalMs = POLL_MS * 4;
    await vi.advanceTimersByTimeAsync(POLL_MS * 8);
    unsub();

    expect(checkedAtMs).toEqual([0, POLL_MS, POLL_MS * 2, POLL_MS * 6]);
  });

  it("pauses checks while an acknowledged NUT-17 subscription watches the quote", async () => {
    const nut17 = acknowledgingSubscription();
    const checkedAtMs = recordChecks("UNPAID");

    await waitForMintQuotePaid(makeQuote(), vi.fn(), {
      pollIntervalMs: POLL_MS,
      pollWhileSubscribed: () => false,
    });
    await vi.advanceTimersByTimeAsync(0);
    nut17.update(partialQuote("UNPAID"));
    await vi.advanceTimersByTimeAsync(POLL_MS * 20);

    expect(checkedAtMs).toEqual([0]);
  });

  it("checks again after a WebSocket error and stops when a new subscription is acknowledged", async () => {
    const first = acknowledgingSubscription();
    const checkedAtMs = recordChecks("UNPAID");

    await waitForMintQuotePaid(makeQuote(), vi.fn(), {
      pollIntervalMs: POLL_MS,
      pollWhileSubscribed: () => false,
    });
    await vi.advanceTimersByTimeAsync(0);
    first.update(partialQuote("UNPAID"));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const second = acknowledgingSubscription();
    first.error(new Error("WebSocket closed (code 1006)"));
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(checkedAtMs).toEqual([0, POLL_MS * 2, POLL_MS * 3]);
    expect(mockMintQuoteUpdates).toHaveBeenCalledTimes(2);

    second.update(partialQuote("UNPAID"));
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(checkedAtMs).toEqual([0, POLL_MS * 2, POLL_MS * 3]);
  });

  it("restarts paused checks when the caller wakes them", async () => {
    const nut17 = acknowledgingSubscription();
    const checkedAtMs = recordChecks("UNPAID");
    let visible = false;
    let wake!: () => void;

    await waitForMintQuotePaid(makeQuote(), vi.fn(), {
      pollIntervalMs: POLL_MS,
      pollWhileSubscribed: () => visible,
      bindPollingControls: ({ resume }) => {
        wake = resume;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    nut17.update(partialQuote("UNPAID"));
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    visible = true;
    wake();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);

    expect(checkedAtMs).toEqual([0, POLL_MS * 5, POLL_MS * 6]);
  });

  it("checks now on request while an acknowledged subscription pauses checks", async () => {
    const nut17 = acknowledgingSubscription();
    const checkedAtMs = recordChecks("UNPAID");
    let checkNow!: () => void;

    await waitForMintQuotePaid(makeQuote(), vi.fn(), {
      pollIntervalMs: POLL_MS,
      pollWhileSubscribed: () => false,
      bindPollingControls: (controls) => {
        checkNow = controls.checkNow;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    nut17.update(partialQuote("UNPAID"));
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    // A half-open socket can keep an acknowledged subscription silent.
    checkNow();
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);

    expect(checkedAtMs).toEqual([0, POLL_MS * 4]);
  });

  it("subscribes again when no notification arrives within 10 s, also after a clean close", async () => {
    // A clean close before the acknowledgement gives the subscription no callback.
    const silent = vi.fn();
    mockMintQuoteUpdates.mockImplementationOnce(async () => silent);
    const second = acknowledgingSubscription();
    const checkedAtMs = recordChecks("UNPAID");

    await waitForMintQuotePaid(makeQuote(), vi.fn(), {
      pollIntervalMs: 1_000,
      pollWhileSubscribed: () => false,
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(mockMintQuoteUpdates).toHaveBeenCalledOnce();
    expect(silent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(silent).toHaveBeenCalledOnce();
    expect(mockMintQuoteUpdates).toHaveBeenCalledTimes(2);

    second.update(partialQuote("UNPAID"));
    const checksAtAcknowledgement = checkedAtMs.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checkedAtMs).toHaveLength(checksAtAcknowledgement);
  });

  it("checks once at expiry and reports a payment made in the last seconds", async () => {
    const nut17 = acknowledgingSubscription();
    const checkedAtMs = recordChecks("UNPAID");
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>();

    await waitForMintQuotePaid(makeQuote({ expiry: NOW_SEC + 5 }), onResult, {
      pollIntervalMs: POLL_MS,
      pollWhileSubscribed: () => false,
    });
    await vi.advanceTimersByTimeAsync(0);
    nut17.update(partialQuote("UNPAID"));
    mockCheckMintQuote.mockImplementation(async () => {
      checkedAtMs.push(Date.now() - NOW_SEC * 1000);
      return partialQuote("PAID");
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(checkedAtMs).toEqual([0, 5_000]);
    expect(onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "PAID" }));
  });

  it("cancels its NUT-17 subscription and timers after a terminal result", async () => {
    const nut17 = acknowledgingSubscription();
    mockCheckMintQuote.mockResolvedValue(partialQuote("UNPAID"));
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>();

    await waitForMintQuotePaid(makeQuote({ expiry: NOW_SEC + 5 }), onResult, {
      pollIntervalMs: POLL_MS,
    });
    await vi.advanceTimersByTimeAsync(0);
    nut17.update(partialQuote("PAID"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(nut17.cancel).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "PAID" }));
    expect(mockCheckMintQuote).toHaveBeenCalledOnce();
  });

  it("ignores UNPAID and continues polling until PAID", async () => {
    mockCheckMintQuote
      .mockResolvedValueOnce(partialQuote("UNPAID"))
      .mockResolvedValueOnce(partialQuote("UNPAID"))
      .mockResolvedValueOnce(partialQuote("PAID"));
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>();

    await waitForMintQuotePaid(makeQuote(), onResult, { pollIntervalMs: POLL_MS });
    await vi.advanceTimersByTimeAsync(POLL_MS * 4 + 5);

    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult.mock.calls[0][0].status).toBe("PAID");
  });
});

function recordChecks(state: "UNPAID" | "PAID"): number[] {
  const checkedAtMs: number[] = [];
  mockCheckMintQuote.mockImplementation(async () => {
    checkedAtMs.push(Date.now() - NOW_SEC * 1000);
    return partialQuote(state);
  });
  return checkedAtMs;
}

/** The next NUT-17 subscription. Its first update is the mint's acknowledgement. */
function acknowledgingSubscription() {
  const cancel = vi.fn();
  let update!: (q: PartialMintQuoteResponse) => void;
  let error!: (e: Error) => void;
  mockMintQuoteUpdates.mockImplementationOnce(async (_ids, onUpdate, onError) => {
    update = onUpdate;
    error = onError;
    return cancel;
  });
  return {
    cancel,
    update: (q: PartialMintQuoteResponse) => update(q),
    error: (e: Error) => error(e),
  };
}
