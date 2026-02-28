using BitCaster.MatchingEngine.Contracts;
using BitCaster.MatchingEngine.Contracts.Domain;
using BitCaster.MatchingEngine.Contracts.Hubs;
using BitCaster.InMemoryMatchingEngine.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class OrderEndpoints
{
    public static void MapOrderEndpoints(this WebApplication app)
    {
        app.MapPost("/api/v1/{marketId}/orders", async (
            string marketId,
            SubmitOrderRequest req,
            InMemoryOrderBookManager bookManager,
            IHubContext<MarketHub, IMarketHubClient> hubContext) =>
        {
            if (req.Type == OrderType.Limit && req.Price is null)
                return Results.BadRequest("Limit orders require a price.");

            if (req.AmountSats <= 0)
                return Results.BadRequest("AmountSats must be positive.");

            if (marketId.Contains('|'))
                return Results.BadRequest("Compound marketId (containing '|') is invalid.");

            var order = new Order(
                Guid.NewGuid(),
                marketId,
                req.Side,
                req.Type,
                req.Price is not null ? new Probability(req.Price.Value) : null,
                new Sats(req.AmountSats),
                req.UserId,
                DateTimeOffset.UtcNow);

            bookManager.AddOrder(order);

            await hubContext.Clients.Group(marketId)
                .OrderBookUpdated(bookManager.GetSnapshot(marketId));

            return Results.Ok(new SubmitOrderResponse(
                new List<Fill>(), order.Id, order.AmountSats.Value, "resting"));
        });

        app.MapDelete("/api/v1/orders/{id:guid}", async (
            Guid id,
            InMemoryOrderBookManager bookManager,
            IHubContext<MarketHub, IMarketHubClient> hubContext) =>
        {
            var marketId = bookManager.GetMarketIdForOrder(id);
            if (marketId is null || !bookManager.CancelOrder(id))
                return Results.NotFound();

            await hubContext.Clients.Group(marketId)
                .OrderBookUpdated(bookManager.GetSnapshot(marketId));

            return Results.Ok();
        });
    }
}
