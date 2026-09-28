import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem } from "@/types/portfolio";
import { fetchNip78ActivityLog, publishNip78ActivityLog } from "../nip78ActivityLog";
import { fetchPrivateNip78Content, publishPrivateNip78 } from "../nip78Private";

vi.mock("../nip78Private", () => ({
  fetchPrivateNip78Content: vi.fn(),
  publishPrivateNip78: vi.fn(),
}));

const fetchMock = vi.mocked(fetchPrivateNip78Content);
const publishMock = vi.mocked(publishPrivateNip78);

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "activity-1",
    walletId: "a".repeat(64),
    type: "deposit",
    amountSubunits: 1000,
    baseAsset: "sat",
    date: "2026-05-09T00:00:00.000Z",
    status: "completed",
    txId: null,
    lightningInvoice: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("publishNip78ActivityLog", () => {
  it("publishes portfolio activity through encrypted private NIP-78 helper", async () => {
    await publishNip78ActivityLog("priv", [item()]);

    expect(publishMock).toHaveBeenCalledWith(
      "priv",
      "bitcaster:activity-log",
      JSON.stringify({ items: [item()] }),
    );
  });
});

describe("fetchNip78ActivityLog", () => {
  it("returns only valid activity entries from decrypted content", async () => {
    fetchMock.mockResolvedValue(
      JSON.stringify({
        items: [item({ id: "valid" }), { id: "invalid", type: "unknown" }],
      }),
    );

    await expect(fetchNip78ActivityLog("pub", "priv")).resolves.toEqual([item({ id: "valid" })]);
  });

  it("decodes legacy records without guessing their wallet", async () => {
    fetchMock.mockResolvedValue(
      JSON.stringify({
        items: [
          {
            id: "legacy",
            type: "deposit",
            amountSats: 1_000,
            baseAsset: "sat",
            date: "2026-05-09T00:00:00.000Z",
            status: "completed",
            txId: null,
            lightningInvoice: null,
          },
        ],
      }),
    );

    await expect(fetchNip78ActivityLog("pub", "priv")).resolves.toEqual([
      {
        id: "legacy",
        type: "deposit",
        amountSubunits: 1_000,
        baseAsset: "sat",
        date: "2026-05-09T00:00:00.000Z",
        status: "completed",
        txId: null,
        lightningInvoice: null,
      },
    ]);
  });

  it("preserves exact confirmed trade details in encrypted activity", async () => {
    const trade = item({
      id: `trade:${"a".repeat(64)}:22222222-2222-4222-8222-222222222222`,
      type: "Sell",
      amountSubunits: 1_237,
      marketId: "condition-YES",
      tradeDetails: {
        fillId: "22222222-2222-4222-8222-222222222222",
        outcomeId: "YES",
        tokenSide: "Complement",
        faceAmountSubunits: 2_500,
        divisibility: 1_000,
      },
    });
    fetchMock.mockResolvedValue(JSON.stringify({ items: [trade] }));

    await expect(fetchNip78ActivityLog("pub", "priv")).resolves.toEqual([trade]);
  });

  it("returns null for missing or malformed content", async () => {
    fetchMock.mockResolvedValueOnce(null);
    await expect(fetchNip78ActivityLog("pub", "priv")).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce("{");
    await expect(fetchNip78ActivityLog("pub", "priv")).resolves.toBeNull();
  });
});
