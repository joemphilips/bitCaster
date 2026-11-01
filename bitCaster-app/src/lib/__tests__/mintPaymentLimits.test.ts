import { beforeEach, describe, expect, it, vi } from "vitest";

const readPublicMintInfo = vi.fn();

vi.mock("@bitcaster/client-sdk/mintMetadata", () => ({
  readPublicMintInfo: (...args: unknown[]) => readPublicMintInfo(...args),
}));

const DEPOSIT = { direction: "deposit", method: "bolt11", unit: "msat" } as const;
const WITHDRAWAL = { direction: "withdrawal", method: "bolt11", unit: "msat" } as const;

function info(maxDepositMsat: number) {
  return {
    nuts: {
      "4": {
        methods: [{ method: "bolt11", unit: "msat", min_amount: 1000, max_amount: maxDepositMsat }],
        disabled: false,
      },
      "5": {
        methods: [{ method: "bolt11", unit: "msat", min_amount: 1000, max_amount: null }],
        disabled: false,
      },
    },
  };
}

async function freshModule() {
  vi.resetModules();
  return import("../mintPaymentLimits");
}

describe("browser mint payment limits", () => {
  beforeEach(() => {
    readPublicMintInfo.mockReset();
  });

  it("reads one mint info per normalized mint URL for both directions", async () => {
    const limits = await freshModule();
    readPublicMintInfo.mockResolvedValue(info(200_000_000));

    await expect(
      limits.readBrowserMintPaymentLimits("https://mint.example/", DEPOSIT),
    ).resolves.toEqual({ state: "enabled", minSat: 1, maxSat: 200_000 });
    await expect(
      limits.readBrowserMintPaymentLimits("https://mint.example", WITHDRAWAL),
    ).resolves.toEqual({ state: "enabled", minSat: 1, maxSat: null });

    expect(readPublicMintInfo).toHaveBeenCalledTimes(1);
    expect(readPublicMintInfo).toHaveBeenCalledWith("https://mint.example");
  });

  it("reads the mint again after the cached info is five minutes old", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));
      const limits = await freshModule();
      readPublicMintInfo
        .mockResolvedValueOnce(info(200_000_000))
        .mockResolvedValueOnce(info(500_000_000));

      await expect(
        limits.readBrowserMintPaymentLimits("https://mint.example", DEPOSIT),
      ).resolves.toMatchObject({ maxSat: 200_000 });
      vi.setSystemTime(new Date("2026-11-02T00:04:59Z"));
      await expect(
        limits.readBrowserMintPaymentLimits("https://mint.example", DEPOSIT),
      ).resolves.toMatchObject({ maxSat: 200_000 });
      expect(readPublicMintInfo).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-11-02T00:05:00Z"));
      await expect(
        limits.readBrowserMintPaymentLimits("https://mint.example", DEPOSIT),
      ).resolves.toMatchObject({ maxSat: 500_000 });
      expect(readPublicMintInfo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the mint again after the cached limits are forgotten", async () => {
    const limits = await freshModule();
    readPublicMintInfo
      .mockResolvedValueOnce(info(200_000_000))
      .mockResolvedValueOnce(info(100_000_000));

    await expect(
      limits.readBrowserMintPaymentLimits("https://mint.example", DEPOSIT),
    ).resolves.toMatchObject({ maxSat: 200_000 });
    limits.forgetBrowserMintPaymentLimits("https://mint.example/");
    await expect(
      limits.readBrowserMintPaymentLimits("https://mint.example", DEPOSIT),
    ).resolves.toMatchObject({ maxSat: 100_000 });
    expect(readPublicMintInfo).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable limits and retries a failed read", async () => {
    const limits = await freshModule();
    readPublicMintInfo
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ nuts: { "4": { methods: [], disabled: "no" } } })
      .mockResolvedValueOnce(info(200_000_000));

    await expect(
      limits.readBrowserMintPaymentLimits("https://mint.example", DEPOSIT),
    ).resolves.toBeNull();
    await expect(
      limits.readBrowserMintPaymentLimits("https://mint.example", DEPOSIT),
    ).resolves.toBeNull();
    limits.forgetBrowserMintPaymentLimits("https://mint.example");
    await expect(
      limits.readBrowserMintPaymentLimits("https://mint.example", DEPOSIT),
    ).resolves.toMatchObject({ maxSat: 200_000 });
    expect(readPublicMintInfo).toHaveBeenCalledTimes(3);
  });
});
