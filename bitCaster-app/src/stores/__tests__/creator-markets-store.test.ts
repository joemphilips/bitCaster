import { beforeEach, describe, expect, it } from "vitest";
import {
  creatorMarketsEqual,
  useCreatorMarketsStore,
  type StoredCreatorMarket,
} from "../creatorMarkets";

function makeMarket(overrides: Partial<StoredCreatorMarket> = {}): StoredCreatorMarket {
  return {
    conditionId: "a".repeat(64),
    title: "Will BTC cross $150k by EOY?",
    thumbnailUrl: null,
    createdAt: "2026-04-10T00:00:00.000Z",
    creatorFeePercent: 0.02,
    ...overrides,
  };
}

beforeEach(() => {
  useCreatorMarketsStore.setState({ markets: [] });
});

describe("useCreatorMarketsStore", () => {
  it("addCreatedMarket prepends a new market", () => {
    const first = makeMarket({ conditionId: "a".repeat(64) });
    const second = makeMarket({ conditionId: "b".repeat(64), title: "Election" });

    useCreatorMarketsStore.getState().addCreatedMarket(first);
    useCreatorMarketsStore.getState().addCreatedMarket(second);

    const markets = useCreatorMarketsStore.getState().markets;
    expect(markets.map((m) => m.conditionId)).toEqual(["b".repeat(64), "a".repeat(64)]);
  });

  it("addCreatedMarket replaces an existing entry with the same conditionId", () => {
    const original = makeMarket({ title: "Original title", creatorFeePercent: 0.01 });
    const updated = makeMarket({ title: "Updated title", creatorFeePercent: 0.05 });

    useCreatorMarketsStore.getState().addCreatedMarket(original);
    useCreatorMarketsStore.getState().addCreatedMarket(updated);

    const markets = useCreatorMarketsStore.getState().markets;
    expect(markets).toHaveLength(1);
    expect(markets[0].title).toBe("Updated title");
    expect(markets[0].creatorFeePercent).toBe(0.05);
  });

  it("markOracleAttested records the published creator oracle attestation", () => {
    const market = makeMarket({
      oracle: {
        type: "self",
        eventId: "event-1",
        outcomes: ["Yes", "No"],
      },
    });
    useCreatorMarketsStore.setState({ markets: [market] });

    useCreatorMarketsStore.getState().markOracleAttested(market.conditionId, {
      outcome: "Yes",
      attestationHex: "abc123",
      attestedAt: "2026-05-07T00:00:00.000Z",
    });

    expect(useCreatorMarketsStore.getState().markets[0].oracle).toMatchObject({
      attestationHex: "abc123",
      attestedOutcome: "Yes",
      attestedAt: "2026-05-07T00:00:00.000Z",
    });
  });

  it("removeCreatedMarket drops the matching entry", () => {
    const a = makeMarket({ conditionId: "a".repeat(64) });
    const b = makeMarket({ conditionId: "b".repeat(64) });
    useCreatorMarketsStore.setState({ markets: [a, b] });

    useCreatorMarketsStore.getState().removeCreatedMarket("a".repeat(64));

    expect(useCreatorMarketsStore.getState().markets).toEqual([b]);
  });

  it("replace is a no-op when the incoming set equals the current set", () => {
    const initial = [makeMarket({ conditionId: "a".repeat(64) })];
    useCreatorMarketsStore.setState({ markets: initial });
    const reference = useCreatorMarketsStore.getState().markets;

    useCreatorMarketsStore.getState().replace([makeMarket({ conditionId: "a".repeat(64) })]);

    // No-op means the reference stays identical (important for the debounced
    // NIP-78 sync hook that bails out when nothing changed).
    expect(useCreatorMarketsStore.getState().markets).toBe(reference);
  });

  it("replace overwrites the set when entries differ", () => {
    useCreatorMarketsStore.setState({
      markets: [makeMarket({ conditionId: "a".repeat(64) })],
    });

    const next = [
      makeMarket({ conditionId: "a".repeat(64), title: "Renamed" }),
      makeMarket({ conditionId: "b".repeat(64) }),
    ];
    useCreatorMarketsStore.getState().replace(next);

    expect(useCreatorMarketsStore.getState().markets).toHaveLength(2);
    expect(useCreatorMarketsStore.getState().markets[0].title).toBe("Renamed");
  });

  it("clear empties the store", () => {
    useCreatorMarketsStore.setState({ markets: [makeMarket()] });
    useCreatorMarketsStore.getState().clear();
    expect(useCreatorMarketsStore.getState().markets).toEqual([]);
  });

  it("preserves the announcement recovery material across a simulated fresh profile (P22 B1b)", () => {
    // Market created on the original profile, carrying the committed-nonce
    // recovery material (announcement TLV hex).
    const created = makeMarket({
      oracle: {
        type: "self",
        eventId: "will_btc_hit_150k_abcd",
        outcomes: ["Yes", "No"],
        announcementHex: "fdd824ab0102",
      },
    });
    useCreatorMarketsStore.getState().addCreatedMarket(created);

    // Fresh browser profile: localStorage is empty until NIP-78 sync restores.
    useCreatorMarketsStore.getState().clear();
    expect(useCreatorMarketsStore.getState().markets).toEqual([]);

    // useCreatorSync fetches the NIP-78 mirror and replaces the local set.
    // The recovery material must survive the round-trip so the creator can
    // re-derive the committed nonce and resolve the market.
    useCreatorMarketsStore.getState().replace([created]);

    const restored = useCreatorMarketsStore.getState().markets[0];
    expect(restored.oracle?.announcementHex).toBe("fdd824ab0102");
  });
});

describe("creatorMarketsEqual", () => {
  it("returns true for identical sets regardless of order", () => {
    const a = makeMarket({ conditionId: "a".repeat(64) });
    const b = makeMarket({ conditionId: "b".repeat(64) });
    expect(creatorMarketsEqual([a, b], [b, a])).toBe(true);
  });

  it("returns false when a field differs", () => {
    const a = makeMarket({ title: "Old" });
    const b = makeMarket({ title: "New" });
    expect(creatorMarketsEqual([a], [b])).toBe(false);
  });

  it("returns false when oracle metadata differs", () => {
    const a = makeMarket({
      oracle: {
        type: "self",
        eventId: "event-1",
        outcomes: ["Yes", "No"],
      },
    });
    const b = makeMarket({
      oracle: {
        type: "self",
        eventId: "event-1",
        outcomes: ["Yes", "No"],
        attestedOutcome: "Yes",
      },
    });
    expect(creatorMarketsEqual([a], [b])).toBe(false);
  });

  it("returns false when the announcement recovery material differs", () => {
    const a = makeMarket({
      oracle: {
        type: "self",
        eventId: "event-1",
        outcomes: ["Yes", "No"],
        announcementHex: "aa",
      },
    });
    const b = makeMarket({
      oracle: {
        type: "self",
        eventId: "event-1",
        outcomes: ["Yes", "No"],
        announcementHex: "bb",
      },
    });
    expect(creatorMarketsEqual([a], [b])).toBe(false);
  });

  it("returns false when lengths differ", () => {
    expect(creatorMarketsEqual([makeMarket()], [])).toBe(false);
  });
});
