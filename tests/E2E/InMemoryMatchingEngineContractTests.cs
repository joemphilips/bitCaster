using BitCaster.InMemoryMatchingEngine;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.E2ETest;

public sealed class InMemoryMatchingEngineContractTests
{
    private const long SatShareFaceSubunits = 1_000_000;

    [Fact]
    public void PriceHistory_SeedsInitialPointsWithMarketDivisibilityAndTimeframeAnchor()
    {
        var store = new InMemoryPriceHistoryStore();
        var conditionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var createdAt = DateTimeOffset.Parse("2026-06-18T00:00:00Z");
        var now = createdAt.AddDays(2);

        store.SeedInitialPriceHistory(
            conditionId,
            [
                ("Alpha", 80),
                ("Beta", 10),
                ("Gamma", 10),
            ],
            divisibility: 1000,
            timestamp: createdAt);

        var response = store.Get(conditionId, "1h", now);

        Assert.Equal(MarketPriceHistoryResponseTimeframe._1h, response.Timeframe);
        var alpha = Assert.Single(response.Outcomes, outcome => outcome.OutcomeId == "Alpha");
        var point = Assert.Single(alpha.Data);
        Assert.Equal(800, point.Price);
        Assert.Equal(MarketPriceHistoryPointSource.Initial, point.Source);
        Assert.Equal(now.AddHours(-1), point.Timestamp);
        Assert.Equal(0, point.VolumeSubunits);
        Assert.Equal(0, point.VolumeSubunits);
    }

    [Fact]
    public void PriceHistory_CapsFillPointsIncludingInitialSeed()
    {
        var store = new InMemoryPriceHistoryStore();
        var conditionId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        var marketId = $"{conditionId}-Alpha";
        var createdAt = DateTimeOffset.Parse("2026-06-18T00:00:00Z");

        store.SeedInitialPriceHistory(
            conditionId,
            [("Alpha", 50)],
            divisibility: 100,
            timestamp: createdAt);

        for (var i = 0; i < InMemoryPriceHistoryStore.MaxPointsPerOutcomeResponse + 5; i++)
        {
            store.RecordFill(marketId, FillAt(createdAt.AddMinutes(i + 1), price: 40 + i % 10));
        }

        var response = store.Get(conditionId, "all", createdAt.AddDays(1));
        var alpha = Assert.Single(response.Outcomes);

        Assert.Equal(InMemoryPriceHistoryStore.MaxPointsPerOutcomeResponse, alpha.Data.Count);
        Assert.Equal(MarketPriceHistoryPointSource.Initial, alpha.Data[0].Source);
        Assert.Equal(createdAt, alpha.Data[0].Timestamp);
        Assert.Equal(MarketPriceHistoryPointSource.Fill, alpha.Data[1].Source);
        Assert.Equal(createdAt.AddMinutes(7), alpha.Data[1].Timestamp);
    }

    [Fact]
    public void OrderBookSnapshot_ReturnsTopFivePerSideWithDepthLimit()
    {
        var books = new InMemoryOrderBookManager();
        const string marketId = "deadbeef-YES";

        for (var i = 0; i < 8; i++)
        {
            books.SubmitOrder(
                marketId,
                "YES",
                OrderSide.Buy,
                priceValue: 10 + i,
                amountSubunits: SatShareFaceSubunits,
                userId: $"buyer-{i}",
                timeInForce: TimeInForce.GTC,
                ephemeralPubkey: null);
            books.SubmitOrder(
                marketId,
                "YES",
                OrderSide.Sell,
                priceValue: 80 + i,
                amountSubunits: SatShareFaceSubunits,
                userId: $"seller-{i}",
                timeInForce: TimeInForce.GTC,
                ephemeralPubkey: null);
        }

        var snapshot = books.GetSnapshot(marketId);

        Assert.Equal(InMemoryOrderBookManager.DefaultSnapshotDepthLimit, snapshot.DepthLimit);
        Assert.Equal(5, snapshot.Bids.Count);
        Assert.Equal(5, snapshot.Asks.Count);
        Assert.Equal([17, 16, 15, 14, 13], snapshot.Bids.Select(level => level.Price).ToArray());
        Assert.Equal([80, 81, 82, 83, 84], snapshot.Asks.Select(level => level.Price).ToArray());
    }

    private static Fill FillAt(DateTimeOffset timestamp, int price) =>
        new(
            amountSubunits: 100,
            baseAsset: BaseAsset.Sat,
            divisibility: 100,
            executionPrice: price,
            filledAt: timestamp,
            id: Guid.NewGuid(),
            makerEphemeralPubkey: "02" + new string('a', 64),
            makerOrderId: Guid.NewGuid(),
            path: MatchPath.Complementary,
            quotePaymentSubunits: 40,
            outcomeFaceAmountSubunits: 100,
            status: FillStatus.Filled,
            takerOrderId: Guid.NewGuid(),
            tokenSide: TokenSide.Outcome,
            tradeId: Guid.NewGuid());
}
