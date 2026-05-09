import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem } from "@/types/portfolio";

const { mockDeriveNostrKeyPair, mockFetchActivityLog, mockPublishActivityLog } =
  vi.hoisted(() => ({
    mockDeriveNostrKeyPair: vi.fn(),
    mockFetchActivityLog: vi.fn(),
    mockPublishActivityLog: vi.fn(),
  }));

vi.mock("@/lib/nip17", () => ({
  deriveNostrKeyPair: (...args: unknown[]) => mockDeriveNostrKeyPair(...args),
}));

vi.mock("@/lib/nip78ActivityLog", () => ({
  fetchNip78ActivityLog: (...args: unknown[]) => mockFetchActivityLog(...args),
  publishNip78ActivityLog: (...args: unknown[]) =>
    mockPublishActivityLog(...args),
}));

import { useActivityLogStore } from "../activity-log";
import { useActivityLogSync } from "../useActivityLogSync";
import { useWalletStore } from "../wallet";

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
  mockDeriveNostrKeyPair.mockReset();
  mockFetchActivityLog.mockReset();
  mockPublishActivityLog.mockReset();
  mockDeriveNostrKeyPair.mockReturnValue({
    privateKeyHex: "private-key",
    publicKey: "public-key",
  });
  mockPublishActivityLog.mockResolvedValue(undefined);
  useWalletStore.setState({ mnemonic: "", setupComplete: false });
  useActivityLogStore.setState({ items: [] });
});

describe("useActivityLogSync", () => {
  it("does nothing until a wallet mnemonic is available", () => {
    renderHook(() => useActivityLogSync());

    expect(mockDeriveNostrKeyPair).not.toHaveBeenCalled();
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
    useWalletStore.setState({ mnemonic: "abandon ".repeat(11) + "about" });
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
    useWalletStore.setState({ mnemonic: "abandon ".repeat(11) + "about" });
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
        type: "buy",
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
      type: "buy",
      amountSats: 500,
      marketId: "m1",
    });
  });
});
