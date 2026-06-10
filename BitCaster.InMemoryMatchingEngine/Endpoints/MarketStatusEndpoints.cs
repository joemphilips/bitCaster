using BitCaster.InMemoryMatchingEngine.Hubs;
using BitCaster.MatchingEngine.Contracts;
using BitCaster.MatchingEngine.Contracts.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

/// <summary>
/// Dev/test stub for the MarketStatusChanged hub event. The real engine fires
/// this after a market is closed; the mock exposes a simple POST so the
/// frontend dev/test stack can exercise the live lifecycle-change handler.
/// Fans the broadcast out to every per-outcome market group of the condition,
/// matching the real engine's group keying (marketId = {conditionId}-{outcome}).
/// </summary>
public static class MarketStatusEndpoints
{
    public static void MapMarketStatusEndpoints(this WebApplication app)
    {
        app.MapPost("/api/v1/dev/markets/{conditionId}/status", async (
            string conditionId,
            DevMarketStatusRequest request,
            IHubContext<MarketHub, IMarketHubClient> hubContext) =>
        {
            var status = new BitCaster.MatchingEngine.Contracts.Hubs.MarketStatusChanged(
                conditionId,
                string.Equals(request.State, "open", StringComparison.OrdinalIgnoreCase)
                    ? "open"
                    : "closed",
                request.ClosedAt,
                request.FinalOutcome);

            var outcomes = request.Outcomes is { Count: > 0 }
                ? request.Outcomes
                : new List<string> { "YES", "NO" };

            foreach (var outcome in outcomes)
            {
                var marketId = $"{conditionId}-{outcome}";
                await hubContext.Clients.Group(marketId).MarketStatusChanged(status);
            }

            return Results.Ok(status);
        });
    }
}

/// <summary>Body shape for the mock dev market-status broadcast endpoint.</summary>
public sealed record DevMarketStatusRequest(
    string? State,
    DateTimeOffset? ClosedAt,
    string? FinalOutcome,
    List<string>? Outcomes);
