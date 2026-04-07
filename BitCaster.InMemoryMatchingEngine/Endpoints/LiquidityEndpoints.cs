using System.Collections.Concurrent;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class LiquidityEndpoints
{
    private static readonly ConcurrentDictionary<string, RegisterLiquidityResponse> Pools = new();

    public static void MapLiquidityEndpoints(this WebApplication app)
    {
        app.MapPost("/api/v1/{marketId}/liquidity", (string marketId, RegisterLiquidityRequest req) =>
        {
            if (Pools.ContainsKey(marketId))
                return Results.Conflict($"CPMM pool already exists for market {marketId}");

            var prob = req.InitialProbability ?? 50;
            var reserveA = req.LiquiditySats * prob / 100;
            var reserveB = req.LiquiditySats - reserveA;

            var response = new RegisterLiquidityResponse(
                marketId: marketId,
                reserveA: reserveA,
                reserveB: reserveB,
                impliedProbability: prob,
                ordersPlaced: []);

            Pools[marketId] = response;
            return Results.Ok(response);
        });

        app.MapGet("/api/v1/{marketId}/liquidity", (string marketId) =>
        {
            if (!Pools.TryGetValue(marketId, out var pool))
                return Results.NotFound();

            return Results.Ok(new LiquidityStateResponse(
                marketId: marketId,
                reserveA: pool.ReserveA,
                reserveB: pool.ReserveB,
                impliedProbability: pool.ImpliedProbability,
                totalLiquiditySats: pool.ReserveA + pool.ReserveB,
                activeOrders: 0));
        });

        app.MapDelete("/api/v1/{marketId}/liquidity", (string marketId, string providerId) =>
        {
            if (!Pools.TryRemove(marketId, out _))
                return Results.NotFound();

            return Results.Ok(new WithdrawLiquidityResponse(
                cancelledOrders: 0,
                remainingReserveA: 0,
                remainingReserveB: 0));
        });
    }
}
