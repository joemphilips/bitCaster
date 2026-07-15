import "fake-indexeddb/auto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem } from "@/types/portfolio";

const {
  mockResolveNsecIdentity,
  mockFetchActivityLog,
  mockPublishActivityLog,
  mockListWalletActivities,
  walletRuntime,
} = vi.hoisted(() => ({
  mockResolveNsecIdentity: vi.fn(),
  mockFetchActivityLog: vi.fn(),
  mockPublishActivityLog: vi.fn(),
  mockListWalletActivities: vi.fn(),
  walletRuntime: {
    walletId: "a".repeat(64),
    mnemonic: "wallet seed a",
  },
}));

const WALLET_ID = "a".repeat(64);
const OTHER_WALLET_ID = "b".repeat(64);

vi.mock("@/lib/identityOps", () => ({
  resolveNsecIdentity: (...args: unknown[]) => mockResolveNsecIdentity(...args),
}));

vi.mock("@/lib/nip78ActivityLog", () => ({
  fetchNip78ActivityLog: (...args: unknown[]) => mockFetchActivityLog(...args),
  publishNip78ActivityLog: (...args: unknown[]) =>
    mockPublishActivityLog(...args),
}));

vi.mock("../proof-db", () => ({
  currentGuiWalletId: () => walletRuntime.walletId,
}));

vi.mock("../wallet", () => ({
  useWalletStore: (selector: (state: { mnemonic: string }) => unknown) =>
    selector({ mnemonic: walletRuntime.mnemonic }),
}));

vi.mock("../wallet-activity-projection", () => ({
  listWalletActivities: (...args: unknown[]) =>
    mockListWalletActivities(...args),
}));

import { useActivityLogStore } from "../activity-log";
import { useActivityLogSync } from "../useActivityLogSync";
import { useSettingsStore } from "../settings";

function activity(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "activity-1",
    type: "deposit",
    amountSats: 1000,
    date: "2026-05-09T00:00:00.000Z",
    status: "completed",
    txId: null,
    lightningInvoice: null,
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockResolveNsecIdentity.mockReset();
  mockFetchActivityLog.mockReset();
  mockPublishActivityLog.mockReset();
  mockListWalletActivities.mockReset();
  walletRuntime.walletId = WALLET_ID;
  walletRuntime.mnemonic = "wallet seed a";
  mockResolveNsecIdentity.mockReturnValue({
    privateKeyHex: "private-key",
    publicKey: "public-key",
  });
  mockPublishActivityLog.mockResolvedValue(undefined);
  mockListWalletActivities.mockResolvedValue([]);
  useSettingsStore.setState({ nostrSignerMode: "none", nsecSecret: null });
  useActivityLogStore.setState({
    activeWalletId: null,
    items: [],
    itemsByWalletId: {},
  });
});

describe("useActivityLogSync", () => {
  it("does nothing until an nsec-backed Nostr identity is available", () => {
    renderHook(() => useActivityLogSync());

    expect(mockResolveNsecIdentity).not.toHaveBeenCalled();
    expect(mockFetchActivityLog).not.toHaveBeenCalled();
  });

  it("merges encrypted NIP-78 activity into the local store and republishes missing local entries", async () => {
    const local = activity({
      id: "local",
      date: "2026-05-09T02:00:00.000Z",
    });
    const remote = activity({
      id: "remote",
      date: "2026-05-09T01:00:00.000Z",
    });
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      nsecSecret: "nsec1test",
    });
    useActivityLogStore.setState({
      activeWalletId: WALLET_ID,
      items: [local],
      itemsByWalletId: { [WALLET_ID]: [local] },
    });
    mockFetchActivityLog.mockResolvedValue([remote]);

    renderHook(() => useActivityLogSync());

    await waitFor(() => {
      expect(useActivityLogStore.getState().items.map((i) => i.id)).toEqual([
        "local",
        "remote",
      ]);
    });
    await waitFor(
      () => {
        expect(mockPublishActivityLog).toHaveBeenCalledWith(
          "private-key",
          WALLET_ID,
          [local, remote],
        );
      },
      { timeout: 1500 },
    );
  });

  it("publishes local activity changes after the initial restore finishes", async () => {
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      nsecSecret: "nsec1test",
    });
    mockFetchActivityLog.mockResolvedValue([]);

    renderHook(() => useActivityLogSync());

    await waitFor(() => {
      expect(mockFetchActivityLog).toHaveBeenCalledWith(
        "public-key",
        "private-key",
        WALLET_ID,
      );
    });

    act(() => {
      useActivityLogStore.getState().addActivityForWallet(WALLET_ID, {
        type: "Buy",
        amountSats: 500,
        status: "completed",
        marketId: "m1",
        marketTitle: "Will BTC hit $150k?",
      });
    });

    await waitFor(
      () => {
        expect(mockPublishActivityLog).toHaveBeenCalledTimes(1);
      },
      { timeout: 1500 },
    );
    expect(mockPublishActivityLog.mock.calls[0][0]).toBe("private-key");
    expect(mockPublishActivityLog.mock.calls[0][1]).toBe(WALLET_ID);
    expect(mockPublishActivityLog.mock.calls[0][2]).toHaveLength(1);
    expect(mockPublishActivityLog.mock.calls[0][2][0]).toMatchObject({
      type: "Buy",
      amountSats: 500,
      marketId: "m1",
    });
  });

  it("never merges or publishes a delayed prior-wallet projection under the active wallet", async () => {
    const firstProjection = deferred<ActivityItem[]>();
    const secondProjection = deferred<ActivityItem[]>();
    const firstActivity = activity({ id: "wallet-a-activity" });
    const secondActivity = activity({ id: "wallet-b-activity" });
    mockListWalletActivities.mockImplementation((walletId: string) =>
      walletId === WALLET_ID
        ? firstProjection.promise
        : secondProjection.promise,
    );
    mockFetchActivityLog.mockResolvedValue([]);
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      nsecSecret: "nsec1test",
    });

    const { rerender } = renderHook(() => useActivityLogSync());
    await waitFor(() => {
      expect(mockListWalletActivities).toHaveBeenCalledWith(WALLET_ID);
    });
    await act(async () => {
      firstProjection.resolve([firstActivity]);
      await firstProjection.promise;
    });
    await waitFor(() => {
      expect(useActivityLogStore.getState().items).toEqual([firstActivity]);
    });

    walletRuntime.walletId = OTHER_WALLET_ID;
    walletRuntime.mnemonic = "wallet seed b";
    rerender();
    await waitFor(() => {
      expect(mockListWalletActivities).toHaveBeenCalledWith(OTHER_WALLET_ID);
    });

    expect(
      useActivityLogStore.getState().itemsByWalletId[OTHER_WALLET_ID],
    ).toBeUndefined();
    expect(useActivityLogStore.getState().items).toEqual([]);

    await act(async () => {
      secondProjection.resolve([secondActivity]);
      await secondProjection.promise;
    });
    await waitFor(() => {
      expect(useActivityLogStore.getState().items).toEqual([secondActivity]);
    });
    await waitFor(
      () => {
        const secondWalletPublishes = mockPublishActivityLog.mock.calls.filter(
          (call) => call[1] === OTHER_WALLET_ID,
        );
        expect(secondWalletPublishes.length).toBeGreaterThan(0);
        expect(
          secondWalletPublishes.every((call) =>
            (call[2] as ActivityItem[]).every(
              (item) => item.id !== firstActivity.id,
            ),
          ),
        ).toBe(true);
      },
      { timeout: 1_500 },
    );
  });
});
