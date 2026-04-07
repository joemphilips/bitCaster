using System.Collections.Concurrent;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class LiquidityEndpoints
{
    internal static readonly ConcurrentDictionary<string, LiquidityStateResponse> Pools = new();

    public static void MapLiquidityEndpoints(this WebApplication app)
    {
        app.MapGet("/api/v1/{marketId}/liquidity", (string marketId) =>
        {
            if (!Pools.TryGetValue(marketId, out var pool))
                return Results.NotFound();

            return Results.Ok(pool);
        });
    }
}
