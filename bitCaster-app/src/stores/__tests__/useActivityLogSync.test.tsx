import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem } from "@/types/portfolio";

const { mockResolveNsecIdentity, mockFetchActivityLog, mockPublishActivityLog } =
  vi.hoisted(() => ({
    mockResolveNsecIdentity: vi.fn(),
    mockFetchActivityLog: vi.fn(),
    mockPublishActivityLog: vi.fn(),
  }));

vi.mock("@/lib/identityOps", () => ({
  resolveNsecIdentity: (...args: unknown[]) => mockResolveNsecIdentity(...args),
}));

vi.mock("@/lib/nip78ActivityLog", () => ({
  fetchNip78ActivityLog: (...args: unknown[]) => mockFetchActivityLog(...args),
  publishNip78ActivityLog: (...args: unknown[]) =>
    mockPublishActivityLog(...args),
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

beforeEach(() => {
  mockResolveNsecIdentity.mockReset();
  mockFetchActivityLog.mockReset();
  mockPublishActivityLog.mockReset();
  mockResolveNsecIdentity.mockReturnValue({
    privateKeyHex: "private-key",
    publicKey: "public-key",
  });
  mockPublishActivityLog.mockResolvedValue(undefined);
  useSettingsStore.setState({ nostrSignerMode: "none", nsecSecret: null });
  useActivityLogStore.setState({ items: [] });
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
    useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "nsec1test" });
    useActivityLogStore.setState({ items: [local] });
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
        expect(mockPublishActivityLog).toHaveBeenCalledWith("private-key", [
          local,
          remote,
        ]);
      },
      { timeout: 1500 },
    );
  });

  it("publishes local activity changes after the initial restore finishes", async () => {
    useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "nsec1test" });
    mockFetchActivityLog.mockResolvedValue([]);

    renderHook(() => useActivityLogSync());

    await waitFor(() => {
      expect(mockFetchActivityLog).toHaveBeenCalledWith(
        "public-key",
        "private-key",
      );
    });

    act(() => {
      useActivityLogStore.getState().addActivity({
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
    expect(mockPublishActivityLog.mock.calls[0][1]).toHaveLength(1);
    expect(mockPublishActivityLog.mock.calls[0][1][0]).toMatchObject({
      type: "Buy",
      amountSats: 500,
      marketId: "m1",
    });
  });
});
