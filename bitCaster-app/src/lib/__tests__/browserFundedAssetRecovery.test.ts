// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk";
import { recoverBrowserFundedAsset } from "../browserFundedAssetRecovery";

const mocks = vi.hoisted(() => ({
  engineAssets: vi.fn(),
  driver: { recoverTargetedAsset: vi.fn() },
  activeDriver: vi.fn(),
  wallet: vi.fn(),
}));

vi.mock("@/stores/wallet", () => ({ getWalletForMnemonicUnit: mocks.wallet }));
vi.mock("../encryptedWalletBackupDriver", () => ({
  activeBrowserEncryptedWalletBackupV2RuntimeDriver: mocks.activeDriver,
}));
vi.mock("../markets", () => ({
  createAuthenticatedBrowserEngineClient: () => ({ getAssetMonitoringAssets: mocks.engineAssets }),
}));
const asset = createEncryptedWalletBackupV2AssetIdentity({
  mintUrl: "https://mint.example",
  unit: "msat",
  asset: { kind: "ordinary" },
});
const SCOPE_ID = `custody:wallet:${"11".repeat(32)}`;

describe("recoverBrowserFundedAsset", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("returns a ready local action plan without recovery I/O", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "ready" as const });
    mocks.engineAssets.mockRejectedValue(new Error("monitoring unavailable"));

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "ready",
      plan: { kind: "ready" },
    });

    expect(mocks.engineAssets).not.toHaveBeenCalled();
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.driver.recoverTargetedAsset).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("rejects a sat product asset before loading the local plan", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "ready" as const });
    const satInput = { ...input(loadPlan), asset: { ...asset, unit: "sat" as const } };

    await expect(recoverBrowserFundedAsset(satInput)).resolves.toEqual({
      kind: "persistent-error",
    });

    expect(loadPlan).not.toHaveBeenCalled();
    expect(mocks.wallet).not.toHaveBeenCalled();
    expectDiagnostic("local-plan");
  });

  it("fails closed when canonical candidate selection fails", async () => {
    const loadPlan = vi.fn().mockRejectedValue(new Error("local plan failed"));

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "persistent-error",
    });

    expect(loadPlan).toHaveBeenCalledOnce();
    expect(mocks.driver.recoverTargetedAsset).not.toHaveBeenCalled();
    expect(mocks.engineAssets).not.toHaveBeenCalled();
    expect(mocks.wallet).not.toHaveBeenCalled();
    expectDiagnostic("local-plan");
  });

  it("labels profile failures before local-plan I/O", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "ready" as const });

    await expect(
      recoverBrowserFundedAsset(input(loadPlan, { isCurrentProfile: () => false })),
    ).resolves.toEqual({ kind: "persistent-error" });

    expect(loadPlan).not.toHaveBeenCalled();
    expectDiagnostic("profile-or-lock");
  });

  it("labels an absent recovery driver after local insufficiency", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.activeDriver.mockReturnValue(null);

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "persistent-error",
    });

    expect(mocks.driver.recoverTargetedAsset).not.toHaveBeenCalled();
    expectDiagnostic("driver-absent");
  });

  it("invokes backup recovery before one bounded exact monitoring read", async () => {
    const order: string[] = [];
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.activeDriver.mockReturnValue(mocks.driver);
    mocks.wallet.mockResolvedValue({ mint: { mintUrl: "https://mint.example" } });
    mocks.engineAssets.mockImplementation(async () => {
      order.push("monitoring");
      return {
        assets: [
          {
            asset: {
              canonicalMintUrl: "https://mint.example",
              kind: "collateral",
              cashuUnit: "msat",
              displayBaseAsset: "sat",
            },
            availableSubunits: 10,
          },
        ],
      };
    });
    mocks.driver.recoverTargetedAsset.mockImplementation(
      async ({ readExactMonitoringRecovery }) => {
        order.push("driver");
        await readExactMonitoringRecovery();
        return { kind: "restored-mint" };
      },
    );

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "recovered",
    });

    expect(loadPlan).toHaveBeenCalledOnce();
    expect(mocks.engineAssets).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 200 }),
      expect.any(AbortSignal),
    );
    expect(mocks.engineAssets).toHaveBeenCalledOnce();
    expect(order).toEqual(["driver", "monitoring"]);
    expect(mocks.driver.recoverTargetedAsset).toHaveBeenCalledWith(
      expect.objectContaining({ asset, requiredAmount: 10n }),
    );
  });

  it("follows the monitoring cursor when the exact fact is on the second page", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.activeDriver.mockReturnValue(mocks.driver);
    mocks.engineAssets
      .mockResolvedValueOnce({ assets: [], nextCursor: "cursor-1" })
      .mockResolvedValueOnce({ assets: [monitoringFact(10)], nextCursor: null });
    mocks.driver.recoverTargetedAsset.mockImplementation(
      async ({ readExactMonitoringRecovery }) => {
        await readExactMonitoringRecovery();
        return { kind: "restored-mint" };
      },
    );

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "recovered",
    });

    expect(mocks.engineAssets).toHaveBeenNthCalledWith(
      1,
      {
        walletId: expect.any(String),
        pageSize: 200,
      },
      expect.any(AbortSignal),
    );
    expect(mocks.engineAssets).toHaveBeenNthCalledWith(
      2,
      {
        walletId: expect.any(String),
        pageSize: 200,
        cursor: "cursor-1",
      },
      expect.any(AbortSignal),
    );
  });

  it("times out the bounded monitoring read without treating it as absence", async () => {
    vi.useFakeTimers();
    try {
      const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
      mocks.activeDriver.mockReturnValue(mocks.driver);
      let observedSignal: AbortSignal | undefined;
      mocks.engineAssets.mockImplementation(
        async (_query: unknown, signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            observedSignal = signal;
            signal.addEventListener("abort", () => reject(new Error("monitoring timed out")), {
              once: true,
            });
          }),
      );
      mocks.driver.recoverTargetedAsset.mockImplementation(
        async ({ readExactMonitoringRecovery }) => {
          await readExactMonitoringRecovery();
          return { kind: "unavailable" };
        },
      );

      const recovery = recoverBrowserFundedAsset(input(loadPlan));
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.engineAssets).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(recovery).resolves.toEqual({ kind: "persistent-error" });
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedSignal?.aborted).toBe(true);
      expectDiagnostic("driver-outcome");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not read engine monitoring or load a mint when backup restoration succeeds", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.activeDriver.mockReturnValue(mocks.driver);
    mocks.driver.recoverTargetedAsset.mockResolvedValue({ kind: "restored-backup" });

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "recovered",
    });

    expect(mocks.engineAssets).not.toHaveBeenCalled();
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.driver.recoverTargetedAsset).toHaveBeenCalledOnce();
  });

  it("does not load the mint when the exact monitoring fact is absent", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.activeDriver.mockReturnValue(mocks.driver);
    mocks.engineAssets.mockResolvedValue({ assets: [] });
    mocks.driver.recoverTargetedAsset.mockImplementation(
      async ({ readExactMonitoringRecovery }) => {
        await readExactMonitoringRecovery();
        return { kind: "unavailable" };
      },
    );

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "unavailable",
    });

    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.driver.recoverTargetedAsset).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "incomplete",
      page: { assets: [monitoringFact(10)], nextCursor: null, incomplete: true },
    },
    { label: "stale", page: { assets: [monitoringFact(10)], nextCursor: null, stale: true } },
    { label: "building", page: { assets: [monitoringFact(10)], nextCursor: null, building: true } },
  ])("does not infer absence from a $label monitoring page", async ({ page }) => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.activeDriver.mockReturnValue(mocks.driver);
    mocks.engineAssets.mockResolvedValue(page);
    mocks.driver.recoverTargetedAsset.mockImplementation(
      async ({ readExactMonitoringRecovery }) => {
        await readExactMonitoringRecovery();
        return { kind: "unavailable" };
      },
    );

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "persistent-error",
    });
    expect(mocks.wallet).not.toHaveBeenCalled();
    expectDiagnostic("driver-outcome");
  });

  it("fails closed when monitoring pagination repeats a cursor", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.activeDriver.mockReturnValue(mocks.driver);
    mocks.engineAssets
      .mockResolvedValueOnce({ assets: [], nextCursor: "cursor-1" })
      .mockResolvedValueOnce({ assets: [], nextCursor: "cursor-1" });
    mocks.driver.recoverTargetedAsset.mockImplementation(
      async ({ readExactMonitoringRecovery }) => {
        await readExactMonitoringRecovery();
        return { kind: "unavailable" };
      },
    );

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "persistent-error",
    });

    expect(mocks.engineAssets).toHaveBeenCalledTimes(2);
    expectDiagnostic("driver-outcome");
  });

  it("fails closed when monitoring is unavailable", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.activeDriver.mockReturnValue(mocks.driver);
    mocks.engineAssets.mockRejectedValue(new Error("monitoring unavailable"));
    mocks.driver.recoverTargetedAsset.mockImplementation(
      async ({ readExactMonitoringRecovery }) => {
        await readExactMonitoringRecovery();
        return { kind: "unavailable" };
      },
    );

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "persistent-error",
    });
    expectDiagnostic("driver-outcome");
  });

  it("returns ordinary insufficiency when the exact monitoring fact is below the action amount", async () => {
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.activeDriver.mockReturnValue(mocks.driver);
    mocks.engineAssets.mockResolvedValue({ assets: [monitoringFact(9)] });
    mocks.driver.recoverTargetedAsset.mockImplementation(
      async ({ readExactMonitoringRecovery }) => {
        await readExactMonitoringRecovery();
        return { kind: "unavailable" };
      },
    );

    await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
      kind: "unavailable",
    });

    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.driver.recoverTargetedAsset).toHaveBeenCalledOnce();
  });

  it.each([
    [{ kind: "unavailable" }],
    [{ kind: "already-attempted", completedOutcome: "unavailable" }],
  ] as const)(
    "preserves a sufficient monitored recovery %o as a durable error",
    async (outcome) => {
      const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
      mocks.activeDriver.mockReturnValue(mocks.driver);
      mocks.wallet.mockResolvedValue({ mint: { mintUrl: "https://mint.example" } });
      mocks.engineAssets.mockResolvedValue({ assets: [monitoringFact(10)] });
      mocks.driver.recoverTargetedAsset.mockImplementation(
        async ({ readExactMonitoringRecovery }) => {
          await readExactMonitoringRecovery();
          return outcome;
        },
      );

      await expect(recoverBrowserFundedAsset(input(loadPlan))).resolves.toEqual({
        kind: "persistent-error",
      });
      expectDiagnostic("driver-outcome");
    },
  );

  it("fails closed when the profile changes after monitoring I/O", async () => {
    let current = true;
    const loadPlan = vi.fn().mockResolvedValue({ kind: "insufficient" as const });
    mocks.activeDriver.mockReturnValue(mocks.driver);
    mocks.engineAssets.mockImplementation(async () => {
      current = false;
      return { assets: [monitoringFact(10)] };
    });
    mocks.driver.recoverTargetedAsset.mockImplementation(
      async ({ readExactMonitoringRecovery }) => {
        await readExactMonitoringRecovery();
        return { kind: "restored-mint" };
      },
    );

    await expect(
      recoverBrowserFundedAsset(input(loadPlan, { isCurrentProfile: () => current })),
    ).resolves.toEqual({ kind: "persistent-error" });

    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.driver.recoverTargetedAsset).toHaveBeenCalledOnce();
    expectDiagnostic("driver-outcome");
  });
});

function monitoringFact(availableSubunits: number) {
  return {
    asset: {
      canonicalMintUrl: "https://mint.example",
      kind: "collateral" as const,
      cashuUnit: "msat" as const,
      displayBaseAsset: "sat" as const,
    },
    availableSubunits,
  };
}

function input(
  loadPlan: () => Promise<{ readonly kind: "ready" | "insufficient" }>,
  overrides: { readonly isCurrentProfile?: () => boolean } = {},
) {
  return {
    scopeId: SCOPE_ID,
    seed: new Uint8Array(64).fill(7),
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    asset,
    requiredAmount: 10n,
    loadPlan,
    isCurrentProfile: overrides.isCurrentProfile ?? (() => true),
  };
}

function expectDiagnostic(code: string): void {
  expect(console.warn).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledWith(`funded-recovery-code=${code}`);
}
