import { installCreatorDocumentLocks, seedCreatorMarkets } from "@/test/creatorDocumentLocks";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreatorMarketsStore } from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";

const { mockFetchCreatorMarkets, mockResolveCreatorPubkey } = vi.hoisted(() => ({
  mockFetchCreatorMarkets: vi.fn(),
  mockResolveCreatorPubkey: vi.fn(),
}));

vi.mock("@/lib/markets", async () => {
  const actual = await vi.importActual<typeof import("@/lib/markets")>("@/lib/markets");
  return {
    ...actual,
    fetchCreatorMarkets: (...args: unknown[]) => mockFetchCreatorMarkets(...args),
  };
});

vi.mock("@/lib/identityOps", () => ({
  resolveCreatorPubkey: (...args: unknown[]) => mockResolveCreatorPubkey(...args),
}));

import { useCreatorDashboardState } from "../useCreatorDashboardState";

const FAKE_PUBKEY = "a".repeat(64);
const CONDITION_A = "c".repeat(64);
const CONDITION_B = "d".repeat(64);

beforeEach(async () => {
  installCreatorDocumentLocks();
  mockFetchCreatorMarkets.mockReset();
  mockResolveCreatorPubkey.mockReset();
  await seedCreatorMarkets({ markets: [] });
  useSettingsStore.setState({
    nostrSignerMode: "none",
    nsecSecret: null,
    nostrProfile: null,
  });
  mockResolveCreatorPubkey.mockImplementation((input: { nostrSignerMode: string }) =>
    input.nostrSignerMode === "none" ? null : FAKE_PUBKEY,
  );
});

describe("useCreatorDashboardState", () => {
  it("returns an empty state when no Nostr identity is configured", () => {
    mockFetchCreatorMarkets.mockResolvedValue({ pubkey: FAKE_PUBKEY, markets: [] });

    const { result } = renderHook(() => useCreatorDashboardState());

    expect(result.current.pubkey).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.markets).toEqual([]);
    expect(result.current.stats.activeMarketsCount).toBe(0);
    expect(mockFetchCreatorMarkets).not.toHaveBeenCalled();
  });

  it("merges backend volume data with local store markets", async () => {
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      nsecSecret: "11".repeat(32),
      nostrProfile: null,
    });
    await seedCreatorMarkets({
      markets: [
        {
          conditionId: CONDITION_A,
          title: "Market A",
          thumbnailUrl: null,
          createdAt: "2026-04-10T00:00:00.000Z",
          creatorFeePercent: 0.02,
          baseAsset: "sat",
          divisibility: 1_000,
        },
        {
          conditionId: CONDITION_B,
          title: "Market B",
          thumbnailUrl: "/api/v1/foo/thumbnail",
          createdAt: "2026-04-09T00:00:00.000Z",
          creatorFeePercent: 0.03,
          baseAsset: "sat",
          divisibility: 1_000,
        },
      ],
    });

    mockFetchCreatorMarkets.mockResolvedValue({
      pubkey: FAKE_PUBKEY,
      // Only market A has backend volume — market B should default to 0.
      markets: [
        {
          conditionId: CONDITION_A,
          totalVolumeSubunits: 50_000,
          createdAt: "2026-04-10T00:00:00.000Z",
          state: "open",
        },
      ],
    });

    const { result } = renderHook(() => useCreatorDashboardState());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.pubkey).toBe(FAKE_PUBKEY);
    expect(result.current.markets).toHaveLength(2);
    const [a, b] = result.current.markets;
    expect(a.id).toBe(CONDITION_A);
    expect(a.volume).toBe(50_000);
    expect(a.status).toBe("active");
    expect(a.creatorFeePercent).toBe(0.02);
    expect(b.id).toBe(CONDITION_B);
    expect(b.volume).toBe(0);

    expect(b.status).toBe("unknown");
    expect(b.engineDataStatus).toBe("unavailable");
    expect(result.current.stats.activeMarketsCount).toBe(1);
    expect(result.current.stats.totalVolumeSubunits).toBe(50_000);
    expect(result.current.stats.totalFeesEarnedSats).toBe(0);
  });

  it("maps engine closed state to a resolved creator-market row", async () => {
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      nsecSecret: "11".repeat(32),
      nostrProfile: null,
    });
    await seedCreatorMarkets({
      markets: [
        {
          conditionId: CONDITION_A,
          title: "Market A",
          thumbnailUrl: null,
          createdAt: "2026-04-10T00:00:00.000Z",
          creatorFeePercent: 0,
          baseAsset: "sat",
          divisibility: 1_000,
          oracle: {
            type: "self",
            eventId: "event-1",
            outcomes: ["Yes", "No"],
            attestedOutcome: "Yes",
            attestationHex: "abc123",
            attestedAt: "2026-05-09T00:00:00.000Z",
          },
        },
      ],
    });

    mockFetchCreatorMarkets.mockResolvedValue({
      pubkey: FAKE_PUBKEY,
      markets: [
        {
          conditionId: CONDITION_A,
          totalVolumeSubunits: 75_000,
          createdAt: "2026-04-10T00:00:00.000Z",
          state: "closed",
        },
      ],
    });

    const { result } = renderHook(() => useCreatorDashboardState());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.markets[0].status).toBe("resolved");
    expect(result.current.stats.activeMarketsCount).toBe(0);
    expect(result.current.stats.resolvedMarketsCount).toBe(1);
  });

  it("falls back to zero volume on backend error and surfaces the error", async () => {
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      nsecSecret: "11".repeat(32),
      nostrProfile: null,
    });
    await seedCreatorMarkets({
      markets: [
        {
          conditionId: CONDITION_A,
          title: "Market A",
          thumbnailUrl: null,
          createdAt: "2026-04-10T00:00:00.000Z",
          creatorFeePercent: 0.02,
          baseAsset: "sat",
          divisibility: 1_000,
        },
      ],
    });

    mockFetchCreatorMarkets.mockRejectedValue(new Error("engine unreachable"));

    const { result } = renderHook(() => useCreatorDashboardState());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe("engine unreachable");
    expect(result.current.markets).toHaveLength(1);
    expect(result.current.markets[0].volume).toBe(0);
    expect(result.current.markets[0].status).toBe("unknown");
    expect(result.current.markets[0].engineDataStatus).toBe("unavailable");
    expect(result.current.engineDataStatus).toBe("unavailable");
    expect(result.current.stats.totalVolumeSubunits).toBe(0);
  });

  it("fetches creator markets under the resolved signer pubkey", async () => {
    const signerPubkey = "e".repeat(64);
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      nsecSecret: "11".repeat(32),
      nostrProfile: {
        pubkey: signerPubkey,
        displayName: "",
        avatar: "",
        nip05: "",
        nip05verified: false,
        bio: "",
      },
    });
    mockResolveCreatorPubkey.mockReturnValue(signerPubkey);
    mockFetchCreatorMarkets.mockResolvedValue({ pubkey: signerPubkey, markets: [] });

    const { result } = renderHook(() => useCreatorDashboardState());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockResolveCreatorPubkey).toHaveBeenCalledWith({
      nostrSignerMode: "nsec",
      nsecSecret: "11".repeat(32),
      nostrProfilePubkey: signerPubkey,
    });
    expect(mockFetchCreatorMarkets).toHaveBeenCalledWith(signerPubkey);
    expect(result.current.pubkey).toBe(signerPubkey);
  });

  it.each(["failure", "omitted", "stale-open"] as const)(
    "keeps the same creator's known closure and volume through a %s refresh and relay restore",
    async (refreshResult) => {
      useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "11".repeat(32) });
      const local = {
        conditionId: CONDITION_A,
        title: "Closed market",
        thumbnailUrl: null,
        createdAt: "2026-04-10T00:00:00.000Z",
        creatorFeePercent: 0,
        baseAsset: "sat" as const,
        divisibility: 1_000 as const,
      };
      await seedCreatorMarkets({ markets: [local] });
      const closed = {
        conditionId: CONDITION_A,
        totalVolumeSubunits: 75_000,
        createdAt: local.createdAt,
        state: "closed" as const,
      };
      mockFetchCreatorMarkets.mockResolvedValueOnce({ pubkey: FAKE_PUBKEY, markets: [closed] });
      const { result } = renderHook(() => useCreatorDashboardState());
      await waitFor(() => expect(result.current.markets[0].status).toBe("resolved"));
      expect(result.current.markets[0].engineDataStatus).toBe("current");
      if (refreshResult === "failure")
        mockFetchCreatorMarkets.mockRejectedValueOnce(new Error("offline"));
      else
        mockFetchCreatorMarkets.mockResolvedValueOnce({
          pubkey: FAKE_PUBKEY,
          markets:
            refreshResult === "omitted"
              ? []
              : [{ ...closed, state: "open", totalVolumeSubunits: 1_000 }],
        });
      await act(async () => {
        await useCreatorMarketsStore
          .getState()
          .replace([{ ...local, title: "Relay-restored closed market" }]);
        result.current.refresh();
      });
      await waitFor(() => expect(mockFetchCreatorMarkets).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.markets[0]).toMatchObject({
        status: "resolved",
        volume: 75_000,
        engineDataStatus: "stale",
        title: "Relay-restored closed market",
      });
      expect(result.current.stats).toMatchObject({
        activeMarketsCount: 0,
        resolvedMarketsCount: 1,
        totalVolumeSubunits: 75_000,
      });
      expect(result.current.engineDataStatus).toBe("stale");
      expect(result.current.error).toBe(refreshResult === "failure" ? "offline" : null);
    },
  );

  it.each(["failure", "omitted"] as const)(
    "keeps the aggregate unavailable when a %s refresh mixes known and never-enriched rows",
    async (refreshResult) => {
      useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "11".repeat(32) });
      const local = {
        conditionId: CONDITION_A,
        title: "Closed market",
        thumbnailUrl: null,
        createdAt: "2026-04-10T00:00:00.000Z",
        creatorFeePercent: 0,
        baseAsset: "sat" as const,
        divisibility: 1_000 as const,
      };
      await seedCreatorMarkets({ markets: [local, { ...local, conditionId: CONDITION_B }] });
      const closed = {
        conditionId: CONDITION_A,
        totalVolumeSubunits: 75_000,
        createdAt: local.createdAt,
        state: "closed" as const,
      };
      mockFetchCreatorMarkets.mockResolvedValueOnce({ pubkey: FAKE_PUBKEY, markets: [closed] });
      const { result } = renderHook(() => useCreatorDashboardState());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.engineDataStatus).toBe("unavailable");
      if (refreshResult === "failure")
        mockFetchCreatorMarkets.mockRejectedValueOnce(new Error("offline"));
      else mockFetchCreatorMarkets.mockResolvedValueOnce({ pubkey: FAKE_PUBKEY, markets: [] });
      act(() => result.current.refresh());
      await waitFor(() => expect(mockFetchCreatorMarkets).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.markets[0]).toMatchObject({
        status: "resolved",
        volume: 75_000,
        engineDataStatus: "stale",
      });
      expect(result.current.markets[1]).toMatchObject({
        status: "unknown",
        volume: 0,
        engineDataStatus: "unavailable",
      });
      expect(result.current.stats.totalVolumeSubunits).toBe(75_000);
      expect(result.current.engineDataStatus).toBe("unavailable");

      mockFetchCreatorMarkets.mockResolvedValueOnce({
        pubkey: FAKE_PUBKEY,
        markets: [
          closed,
          { ...closed, conditionId: CONDITION_B, state: "open", totalVolumeSubunits: 5_000 },
        ],
      });
      act(() => result.current.refresh());
      await waitFor(() => expect(mockFetchCreatorMarkets).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.engineDataStatus).toBe("current");
      expect(result.current.stats.totalVolumeSubunits).toBe(80_000);
    },
  );

  it("clears old-creator closure and ignores a late old-creator response", async () => {
    useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "11".repeat(32) });
    await seedCreatorMarkets({
      markets: [
        {
          conditionId: CONDITION_A,
          title: "Scoped market",
          thumbnailUrl: null,
          createdAt: "2026-04-10T00:00:00.000Z",
          creatorFeePercent: 0,
          baseAsset: "sat",
          divisibility: 1_000,
        },
      ],
    });
    const closed = {
      conditionId: CONDITION_A,
      totalVolumeSubunits: 75_000,
      createdAt: "2026-04-10T00:00:00.000Z",
      state: "closed",
    };
    mockFetchCreatorMarkets.mockResolvedValueOnce({ pubkey: FAKE_PUBKEY, markets: [closed] });
    const { result } = renderHook(() => useCreatorDashboardState());
    await waitFor(() => expect(result.current.markets[0].status).toBe("resolved"));
    let finishOld!: (response: unknown) => void;
    mockFetchCreatorMarkets.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    act(() => result.current.refresh());
    await waitFor(() => expect(mockFetchCreatorMarkets).toHaveBeenCalledTimes(2));
    const nextPubkey = "b".repeat(64);
    mockResolveCreatorPubkey.mockReturnValue(nextPubkey);
    mockFetchCreatorMarkets.mockResolvedValueOnce({ pubkey: nextPubkey, markets: [] });
    act(() => useSettingsStore.setState({ nsecSecret: "22".repeat(32) }));
    await waitFor(() => expect(mockFetchCreatorMarkets).toHaveBeenCalledWith(nextPubkey));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => finishOld({ pubkey: FAKE_PUBKEY, markets: [closed] }));
    expect(result.current.markets[0]).toMatchObject({
      status: "unknown",
      volume: 0,
      engineDataStatus: "unavailable",
    });
    expect(result.current.stats.resolvedMarketsCount).toBe(0);
    mockResolveCreatorPubkey.mockReturnValue(null);
    act(() => useSettingsStore.setState({ nostrSignerMode: "none" }));
    expect(result.current.pubkey).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("does not treat a local attestation as engine lifecycle or volume", async () => {
    useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "11".repeat(32) });
    await seedCreatorMarkets({
      markets: [
        {
          conditionId: CONDITION_A,
          title: "Relay market",
          thumbnailUrl: null,
          createdAt: "2026-04-10T00:00:00.000Z",
          creatorFeePercent: 0,
          baseAsset: "sat",
          divisibility: 1_000,
          oracle: {
            type: "self",
            eventId: "oracle",
            outcomes: ["Yes", "No"],
            attestedOutcome: "Yes",
            attestationHex: "signed",
          },
        },
      ],
    });
    mockFetchCreatorMarkets.mockResolvedValue({ pubkey: FAKE_PUBKEY, markets: [] });
    const { result } = renderHook(() => useCreatorDashboardState());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.markets[0]).toMatchObject({
      status: "unknown",
      engineDataStatus: "unavailable",
    });
    expect(result.current.stats).toMatchObject({
      activeMarketsCount: 0,
      resolvedMarketsCount: 0,
      totalVolumeSubunits: 0,
    });
  });
});
