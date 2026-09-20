import { describe, expect, it } from "vitest";
import { Amount } from "@cashu/cashu-ts";
import { buildLocalFunds, buildPLChartData, computeStats } from "../usePortfolioState";
import type { ActivityItem, Fund, Position } from "@/types/portfolio";
import type { StoredProof } from "@/stores/proof-db";

const basePosition: Position = {
  id: "p",
  marketId: "m",
  marketTitle: "Market",
  marketImageUrl: "",
  baseAsset: "sat",
  divisibility: 1_000,
  side: "yes",
  shares: 1,
  avgBuyPrice: 0,
  currentPrice: 0,
  currentValueSats: 0,
  profitLossSats: 0,
  profitLossPercent: 0,
  status: "active",
  isWinner: false,
  isLoser: false,
  isPending: false,
  acquiredDate: new Date(0).toISOString(),
  mintUrl: "https://mint.example",
};

describe("computeStats", () => {
  it("sums sat product positions and funds", () => {
    const positions: Position[] = [
      { ...basePosition, id: "sat-position", baseAsset: "sat", currentValueSats: 1000 },
      { ...basePosition, id: "second-position", currentValueSats: 23 },
    ];
    const funds: Fund[] = [
      { id: "sat-fund", unit: "sats", amount: 500, mintUrl: "https://mint.example" },
      { id: "second-sat-fund", unit: "sats", amount: 77, mintUrl: "https://mint.example" },
    ];

    const stats = computeStats(positions, funds);

    expect(stats.positionsValueByUnit).toEqual([{ unit: "sat", amount: 1023 }]);
    expect(stats.totalValueByUnit).toEqual([{ unit: "sat", amount: 1600 }]);
    expect(stats.totalValueSats).toBe(1600);
  });

  it("keeps PL chart cumulative and stats total in sat-market subunits", () => {
    const activity: ActivityItem[] = [
      {
        id: "deposit-1",
        type: "deposit",
        amountSats: 10_000,
        baseAsset: "sat",
        date: new Date(0).toISOString(),
        status: "completed",
        txId: null,
        lightningInvoice: null,
      },
    ];
    const stats = computeStats(
      [],
      [{ id: "sat-fund", unit: "sats", amount: 10_000, mintUrl: "https://mint.example" }],
    );

    expect(buildPLChartData(activity).ALL).toEqual([
      { timestamp: new Date(0).toISOString(), cumulativePL: 10_000 },
    ]);
    expect(stats.totalValueSats).toBe(10_000);
  });

  it("excludes unvalued active positions from totals and biggest-win P/L", () => {
    const stats = computeStats(
      [
        {
          ...basePosition,
          id: "unvalued",
          currentValueSats: 9_000,
          profitLossSats: 8_000,
          valueKnown: false,
        },
        {
          ...basePosition,
          id: "valued",
          currentValueSats: 2_000,
          profitLossSats: 1_000,
        },
      ],
      [{ id: "sat-fund", unit: "sats", amount: 500, mintUrl: "https://mint.example" }],
    );

    expect(stats.positionsValueSats).toBe(2_000);
    expect(stats.totalValueSats).toBe(2_500);
    expect(stats.positionsValueByUnit).toEqual([{ unit: "sat", amount: 2_000 }]);
    expect(stats.totalValueByUnit).toEqual([{ unit: "sat", amount: 2_500 }]);
    expect(stats.positionsValueKnown).toBe(false);
    expect(stats.totalValueKnown).toBe(false);
    expect(stats.biggestWinSats).toBe(1_000);
  });

  it("keeps a closed-unattested position unvalued and excludes it from totals", () => {
    const stats = computeStats(
      [
        {
          ...basePosition,
          id: "closed-pending",
          status: "closed",
          currentValueSats: 10_000,
          profitLossSats: 10_000,
          valueKnown: false,
          isPending: true,
        },
        { ...basePosition, id: "valued-active", currentValueSats: 2_000 },
      ],
      [],
    );

    expect(stats.positionsValueSats).toBe(2_000);
    expect(stats.totalValueSats).toBe(2_000);
    expect(stats.positionsValueKnown).toBe(false);
    expect(stats.totalValueKnown).toBe(false);
    expect(stats.biggestWinSats).toBe(0);
  });
});

describe("buildLocalFunds", () => {
  it("groups canonical msat regular proofs and excludes pending or incompatible proofs", () => {
    const proof = (overrides: Partial<StoredProof> = {}): StoredProof => ({
      id: "keyset",
      amount: Amount.from(1_000),
      secret: "secret",
      C: "C",
      mintUrl: "https://mint.example",
      baseAsset: "sat",
      unit: "msat",
      ...overrides,
    });

    const funds = buildLocalFunds(
      [
        proof({ secret: "mint-one-a", amount: Amount.from(1_000) }),
        proof({ secret: "mint-one-b", amount: Amount.from(2_000) }),
        proof({
          secret: "mint-two",
          amount: Amount.from(4_000),
          mintUrl: "https://other-mint.example",
        }),
        proof({ secret: "sat-proof", amount: Amount.from(5_000), unit: "sat" }),
        proof({ secret: "reserved-proof", amount: Amount.from(7_000), reservedBy: "pending" }),
        proof({
          secret: "ctf-proof",
          amount: Amount.from(11_000),
          conditionId: "condition",
          outcomeCollection: "YES",
        }),
        proof({
          secret: "terminal-proof",
          amount: Amount.from(13_000),
          terminalOperationId: "terminal-operation",
        }),
      ],
      [
        { url: "https://mint.example", info: { name: "Example Mint" } },
        { url: "https://other-mint.example", info: { name: "Other Mint" } },
      ],
    );

    expect(funds).toEqual([
      {
        id: "https://mint.example:msat:sat",
        unit: "sats",
        amount: 3_000,
        mintUrl: "https://mint.example",
        mintName: "Example Mint",
      },
      {
        id: "https://other-mint.example:msat:sat",
        unit: "sats",
        amount: 4_000,
        mintUrl: "https://other-mint.example",
        mintName: "Other Mint",
      },
    ]);
  });

  it("preserves the unsupported-unit failure for malformed stored proofs", () => {
    const proof: StoredProof = {
      id: "keyset",
      amount: Amount.from(1_000),
      secret: "malformed",
      C: "C",
      mintUrl: "https://mint.example",
      baseAsset: "sat",
      unit: "unknown" as never,
    };

    expect(() => buildLocalFunds([proof], [])).toThrow(
      "Stored proof has unsupported unit 'unknown'",
    );
  });
});
