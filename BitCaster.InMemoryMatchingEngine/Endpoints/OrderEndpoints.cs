using BitCaster.MatchingEngine.Contracts.Domain;
using BitCaster.MatchingEngine.Contracts.Endpoints;
using BitCaster.InMemoryMatchingEngine.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace BitCaster.InMemoryMatchingEngine.Endpoints;

public static class OrderEndpoints
{
    public static void MapOrderEndpoints(this WebApplication app)
    {
        app.MapPost("/api/v1/orders", async (
            SubmitOrderRequest req,
            InMemoryOrderBookManager bookManager,
            IHubContext<MarketHub> hubContext) =>
        {
            if (req.Type == OrderType.Limit && req.Price is null)
                return Results.BadRequest("Limit orders require a price.");

            if (req.AmountSats <= Sats.Zero)
                return Results.BadRequest("AmountSats must be positive.");

            var order = new Order(
                Guid.NewGuid(),
                req.MarketId,
                req.OutcomeId,
                req.Side,
                req.Type,
                req.Price,
                req.AmountSats,
                req.UserId,
                DateTimeOffset.UtcNow);

            bookManager.AddOrder(order);

            await hubContext.Clients.Group(req.MarketId)
                .SendAsync("OrderBookUpdated", bookManager.GetSnapshot(req.MarketId));

            return Results.Ok(new SubmitOrderResponse(
                order.Id, "resting", order.AmountSats, new List<Fill>()));
        });

        app.MapDelete("/api/v1/orders/{id:guid}", async (
            Guid id,
            InMemoryOrderBookManager bookManager,
            IHubContext<MarketHub> hubContext) =>
        {
            var marketId = bookManager.GetMarketIdForOrder(id);
            if (marketId is null || !bookManager.CancelOrder(id))
                return Results.NotFound();

            await hubContext.Clients.Group(marketId)
                .SendAsync("OrderBookUpdated", bookManager.GetSnapshot(marketId));

            return Results.Ok();
        });
    }
}
