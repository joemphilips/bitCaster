import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { MintPaymentLimits } from "@bitcaster/client-sdk/mintPaymentLimits";
import { useMintPaymentAmountLimit } from "../useMintPaymentAmountLimit";

const readBrowserMintPaymentLimits = vi.fn();
const forgetBrowserMintPaymentLimits = vi.fn();

vi.mock("@/lib/mintPaymentLimits", () => ({
  readBrowserMintPaymentLimits: (...args: unknown[]) => readBrowserMintPaymentLimits(...args),
  forgetBrowserMintPaymentLimits: (...args: unknown[]) => forgetBrowserMintPaymentLimits(...args),
}));

const MINT_A = "https://mint-a.example";
const MINT_B = "https://mint-b.example";
const PRODUCTION: MintPaymentLimits = { state: "enabled", minSat: 1, maxSat: 200_000 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle<T>(pending: { promise: Promise<T>; resolve: (value: T) => void }, value: T) {
  await act(async () => {
    pending.resolve(value);
    await pending.promise;
  });
}

type HookInput = Parameters<typeof useMintPaymentAmountLimit>[0];

function renderLimit(initial: HookInput) {
  return renderHook((input: HookInput) => useMintPaymentAmountLimit(input), {
    initialProps: initial,
  });
}

describe("useMintPaymentAmountLimit", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    readBrowserMintPaymentLimits.mockReset();
    forgetBrowserMintPaymentLimits.mockReset();
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("does not block while the limits load and shows an error only outside them", async () => {
    const pending = deferred<MintPaymentLimits | null>();
    readBrowserMintPaymentLimits.mockReturnValue(pending.promise);
    const { result, rerender } = renderLimit({
      mintUrl: MINT_A,
      direction: "deposit",
      unit: "msat",
      amountMsat: 300_000_000,
    });

    expect(readBrowserMintPaymentLimits).toHaveBeenCalledWith(MINT_A, {
      direction: "deposit",
      method: "bolt11",
      unit: "msat",
    });
    expect(result.current.error).toBeNull();
    expect(result.current.rejects(300_000_000)).toBe(false);

    await settle(pending, PRODUCTION);
    expect(result.current.error).toBe(
      "This mint accepts 1 to 200,000 sats for each deposit. Deposit in parts.",
    );
    expect(result.current.rejects(300_000_000)).toBe(true);
    expect(result.current.maxMsat).toBe(200_000_000);

    rerender({ mintUrl: MINT_A, direction: "deposit", unit: "msat", amountMsat: 200_000_000 });
    expect(result.current.error).toBeNull();
    rerender({ mintUrl: MINT_A, direction: "deposit", unit: "msat", amountMsat: 500 });
    expect(result.current.error).toBe("This mint accepts 1 to 200,000 sats for each deposit.");
    rerender({ mintUrl: MINT_A, direction: "deposit", unit: "msat", amountMsat: null });
    expect(result.current.error).toBeNull();
    rerender({ mintUrl: MINT_A, direction: "deposit", unit: "msat", amountMsat: 0 });
    expect(result.current.error).toBeNull();
  });

  it("does not block when the limits are unavailable", async () => {
    const pending = deferred<MintPaymentLimits | null>();
    readBrowserMintPaymentLimits.mockReturnValue(pending.promise);
    const { result } = renderLimit({
      mintUrl: MINT_A,
      direction: "deposit",
      unit: "msat",
      amountMsat: 300_000_000,
    });
    await settle(pending, null);
    expect(result.current.error).toBeNull();
    expect(result.current.maxMsat).toBeNull();
    expect(result.current.rejects(300_000_000)).toBe(false);
  });

  it("ignores a stale response from the previous mint after a mint switch", async () => {
    const forA = deferred<MintPaymentLimits | null>();
    const forB = deferred<MintPaymentLimits | null>();
    readBrowserMintPaymentLimits.mockImplementation((mintUrl: string) =>
      mintUrl === MINT_A ? forA.promise : forB.promise,
    );
    const { result, rerender } = renderLimit({
      mintUrl: MINT_A,
      direction: "deposit",
      unit: "msat",
      amountMsat: 150_000_000,
    });
    rerender({ mintUrl: MINT_B, direction: "deposit", unit: "msat", amountMsat: 150_000_000 });

    await settle(forA, { state: "enabled", minSat: 1, maxSat: 100_000 });
    expect(result.current.error).toBeNull();
    expect(result.current.maxMsat).toBeNull();

    await settle(forB, PRODUCTION);
    expect(result.current.error).toBeNull();
    expect(result.current.maxMsat).toBe(200_000_000);
  });

  it("does not show limits of the previous mint while the next mint loads", async () => {
    const forA = deferred<MintPaymentLimits | null>();
    const forB = deferred<MintPaymentLimits | null>();
    readBrowserMintPaymentLimits.mockImplementation((mintUrl: string) =>
      mintUrl === MINT_A ? forA.promise : forB.promise,
    );
    const { result, rerender } = renderLimit({
      mintUrl: MINT_A,
      direction: "deposit",
      unit: "msat",
      amountMsat: 150_000_000,
    });
    await settle(forA, { state: "enabled", minSat: 1, maxSat: 100_000 });
    expect(result.current.error).toBe(
      "This mint accepts 1 to 100,000 sats for each deposit. Deposit in parts.",
    );

    rerender({ mintUrl: MINT_B, direction: "deposit", unit: "msat", amountMsat: 150_000_000 });
    expect(result.current.error).toBeNull();
    await settle(forB, { state: "enabled", minSat: null, maxSat: 120_000 });
    expect(result.current.error).toBe(
      "This mint accepts up to 120,000 sats for each deposit. Deposit in parts.",
    );
  });

  it("reads the limits again after a mint refusal and explains the refused amount", async () => {
    const first = deferred<MintPaymentLimits | null>();
    const second = deferred<MintPaymentLimits | null>();
    readBrowserMintPaymentLimits
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = renderLimit({
      mintUrl: MINT_A,
      direction: "deposit",
      unit: "msat",
      amountMsat: 150_000_000,
    });
    await settle(first, PRODUCTION);
    expect(result.current.error).toBeNull();

    act(() => result.current.recordMintRefusal(150_000_000));
    expect(forgetBrowserMintPaymentLimits).toHaveBeenCalledWith(MINT_A);
    expect(readBrowserMintPaymentLimits).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe("This mint does not accept this deposit amount.");

    await settle(second, { state: "enabled", minSat: 1, maxSat: 100_000 });
    expect(result.current.error).toBe(
      "This mint accepts 1 to 100,000 sats for each deposit. Deposit in parts.",
    );

    rerender({ mintUrl: MINT_A, direction: "deposit", unit: "msat", amountMsat: 90_000_000 });
    expect(result.current.error).toBeNull();
  });

  it("keeps an unexplained refusal only for the refused amount", async () => {
    readBrowserMintPaymentLimits.mockResolvedValue(PRODUCTION);
    const { result, rerender } = renderLimit({
      mintUrl: MINT_A,
      direction: "withdrawal",
      unit: "msat",
      amountMsat: 50_000_000,
    });
    await act(async () => {
      result.current.recordMintRefusal(50_000_000);
    });
    expect(result.current.error).toBe("This mint does not accept this withdrawal amount.");
    expect(result.current.rejects(50_000_000)).toBe(true);
    rerender({ mintUrl: MINT_A, direction: "withdrawal", unit: "msat", amountMsat: 40_000_000 });
    expect(result.current.error).toBeNull();
  });

  it("states that the mint does not accept the payment method", async () => {
    readBrowserMintPaymentLimits.mockResolvedValue({ state: "disabled" });
    const { result } = renderLimit({
      mintUrl: MINT_A,
      direction: "withdrawal",
      unit: "msat",
      amountMsat: 1_000,
    });
    await act(async () => undefined);
    expect(result.current.error).toBe("This mint does not accept Lightning withdrawals.");
  });

  it("uses Japanese copy", async () => {
    await i18n.changeLanguage("ja");
    readBrowserMintPaymentLimits.mockResolvedValue(PRODUCTION);
    const { result, rerender } = renderLimit({
      mintUrl: MINT_A,
      direction: "deposit",
      unit: "msat",
      amountMsat: 300_000_000,
    });
    await act(async () => undefined);
    expect(result.current.error).toBe(
      "このミントへの1回の入金は1〜200,000 satsです。分けて入金してください。",
    );
    rerender({ mintUrl: MINT_A, direction: "withdrawal", unit: "msat", amountMsat: 300_000_000 });
    await act(async () => undefined);
    expect(result.current.error).toBe(
      "このミントからの1回の出金は1〜200,000 satsです。分けて出金してください。",
    );
  });

  it("reads no limits for a flow without a mint", () => {
    const { result } = renderLimit({
      mintUrl: null,
      direction: "deposit",
      unit: "msat",
      amountMsat: 300_000_000,
    });
    expect(readBrowserMintPaymentLimits).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });
});
