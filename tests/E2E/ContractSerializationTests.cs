using System.Text.Json;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.E2ETest;

public sealed class ContractSerializationTests
{
    private static readonly Guid FillId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid TakerOrderId = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid MakerOrderId = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid TradeId = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly DateTimeOffset FilledAt = DateTimeOffset.Parse("2026-06-19T00:00:00+00:00");

    [Fact]
    public void Fill_RoundTripsCanonicalSettlementFields()
    {
        var fill = SampleFill();

        var json = JsonSerializer.Serialize(fill);
        var document = JsonDocument.Parse(json);

        AssertJsonPropertyEquals("usd", document, "baseAsset");
        AssertJsonPropertyEquals(1000, document, "divisibility");
        AssertJsonPropertyEquals(500L, document, "quotePaymentSubunits");
        AssertJsonPropertyEquals(1000L, document, "outcomeFaceAmountSubunits");
        Assert.True(document.RootElement.TryGetProperty("tokenSide", out var tokenSideProp), "tokenSide must be present in serialized Fill");
        Assert.Equal("Outcome", tokenSideProp.GetString());

        var roundTripped = JsonSerializer.Deserialize<Fill>(json);
        Assert.NotNull(roundTripped);
        Assert.Equal(BaseAsset.Usd, roundTripped.BaseAsset);
        Assert.Equal(1000, roundTripped.Divisibility);
        Assert.Equal(500L, roundTripped.QuotePaymentSubunits);
        Assert.Equal(1000L, roundTripped.OutcomeFaceAmountSubunits);
    }

    [Fact]
    public void Fill_DeserializesLegacySat100Payload()
    {
        const string legacyJson = """
        {
          "id": "11111111-1111-1111-1111-111111111111",
          "takerOrderId": "22222222-2222-2222-2222-222222222222",
          "makerOrderId": "33333333-3333-3333-3333-333333333333",
          "amountSats": 100,
          "executionPrice": 50,
          "path": "Complementary",
          "status": "Filled",
          "filledAt": "2026-06-19T00:00:00+00:00"
        }
        """;

        var fill = JsonSerializer.Deserialize<Fill>(legacyJson);
        Assert.NotNull(fill);
        Assert.Null(fill.QuotePaymentSubunits);
        Assert.Null(fill.OutcomeFaceAmountSubunits);
    }

    private static Fill SampleFill() =>
        new(
            amountSats: 1000,
            baseAsset: BaseAsset.Usd,
            divisibility: 1000,
            executionPrice: 500,
            filledAt: FilledAt,
            id: FillId,
            makerEphemeralPubkey: "02" + new string('a', 64),
            makerOrderId: MakerOrderId,
            outcomeFaceAmountSubunits: 1000,
            path: MatchPath.Complementary,
            quotePaymentSubunits: 500,
            status: FillStatus.Filled,
            takerOrderId: TakerOrderId,
            tokenSide: TokenSide.Outcome,
            tradeId: TradeId);

    private static void AssertJsonPropertyEquals(string expected, JsonDocument document, string propertyName)
    {
        Assert.True(document.RootElement.TryGetProperty(propertyName, out var property), $"{propertyName} must be present");
        Assert.Equal(expected, property.GetString());
    }

    private static void AssertJsonPropertyEquals(long expected, JsonDocument document, string propertyName)
    {
        Assert.True(document.RootElement.TryGetProperty(propertyName, out var property), $"{propertyName} must be present");
        Assert.Equal(expected, property.GetInt64());
    }
}
