import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { CtfRangeOrderLock } from "../ctfRangeOrderFunds";
import { fundsSentence } from "../orderFailureText";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

function lock(unlockAtMs: number): CtfRangeOrderLock {
  return {
    side: "Buy",
    lockedSubunits: 1_250_000,
    divisibility: 1_000,
    unlockAtMs,
    retry: {
      conditionId: "condition",
      orderRouteId: "condition-Yes",
      tokenSide: "Outcome",
      side: "Buy",
      amountSubunits: 2_000,
    },
  };
}

describe("funds sentence of a pending refund", () => {
  beforeEach(async () => {
    // Local times on one day, so the line shows the time alone in any time zone.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 19, 14, 0));
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The clock time has no seconds. A time that is too early would promise the
  // funds before the refund can start.
  it.each([
    ["one second after a minute", new Date(2026, 10, 19, 14, 4, 1)],
    ["the end of a minute", new Date(2026, 10, 19, 14, 4, 59, 999)],
    ["an exact minute", new Date(2026, 10, 19, 14, 5, 0)],
  ])("rounds a lock end at %s up to the next minute", (_case, unlockAt) => {
    expect(fundsSentence(t, "pending", { lock: lock(unlockAt.getTime()), locale: "en" })).toMatch(
      /^1,250 sats are locked until 2:05\sPM\. Then they return to this wallet, less preparation and refund fees\.$/u,
    );
  });
});
