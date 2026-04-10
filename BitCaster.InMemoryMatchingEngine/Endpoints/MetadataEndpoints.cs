using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class MetadataEndpoints
{
    public static void MapMetadataEndpoints(this WebApplication app)
    {
        app.MapGet("/api/v1/{marketId}/metadata", (string marketId) =>
        {
            return Results.Ok(new MarketMetadataSnapshot(
                marketId: marketId,
                totalVolumeSats: 0,
                totalTrades: 0,
                uniqueTraderCount: 0,
                totalLiquiditySats: 0));
        });
    }
}
