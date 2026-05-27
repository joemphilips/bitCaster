namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class PriceHistoryEndpoints
{
    private static readonly HashSet<string> ValidTimeframes = new(
        ["1h", "24h", "7d", "30d", "all"],
        StringComparer.OrdinalIgnoreCase);

    public static void MapPriceHistoryEndpoints(this WebApplication app)
    {
        app.MapGet("/api/v1/markets/{conditionId}/price-history", (
            string conditionId,
            string? timeframe,
            InMemoryPriceHistoryStore store) =>
        {
            var requested = string.IsNullOrWhiteSpace(timeframe)
                ? "7d"
                : timeframe.Trim().ToLowerInvariant();
            if (!ValidTimeframes.Contains(requested))
                return Results.BadRequest("timeframe must be one of 1h, 24h, 7d, 30d, or all.");

            return Results.Ok(store.Get(conditionId, requested, DateTimeOffset.UtcNow));
        });
    }
}
