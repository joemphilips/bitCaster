using BitCaster.Server.Domain;
using BitCaster.Server.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace BitCaster.Server.Endpoints;

public static class OrderEndpoints
{
    public record SubmitOrderRequest(
        string MarketId,
        string OutcomeId,
        OrderSide Side,
        OrderType Type,
        int? Price,
        long AmountSats,
        string UserId);

    public record SubmitOrderResponse(
        Guid OrderId,
        string Status,
        long RemainingAmountSats,
        List<Fill> Fills);

    public static void MapOrderEndpoints(this WebApplication app)
    {
        app.MapPost("/api/v1/orders", async (
            SubmitOrderRequest req,
            OrderBookManager bookManager,
            IHubContext<MarketHub> hubContext) =>
        {
            if (req.Type == OrderType.Limit && (req.Price is null or < 1 or > 99))
                return Results.BadRequest("Limit orders require a price between 1 and 99.");

            if (req.AmountSats <= 0)
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

            var book = bookManager.GetOrCreate(req.MarketId);
            var (result, placed) = book.Submit(order);

            var status = placed.RemainingAmountSats == 0
                ? "filled"
                : result.Fills.Count > 0 ? "partially_filled" : "resting";

            if (placed.Type == OrderType.Market && placed.RemainingAmountSats > 0)
                status = result.Fills.Count > 0 ? "partially_filled" : "cancelled";

            // Broadcast orderbook update
            await hubContext.Clients.Group(req.MarketId)
                .SendAsync("OrderBookUpdated", book.GetSnapshot());

            // Broadcast individual fills as trades
            foreach (var fill in result.Fills)
            {
                await hubContext.Clients.Group(req.MarketId)
                    .SendAsync("TradeExecuted", new
                    {
                        fill.ExecutionPrice,
                        fill.AmountSats,
                        Side = order.Side.ToString(),
                        Timestamp = fill.FilledAt
                    });
            }

            return Results.Ok(new SubmitOrderResponse(
                placed.Id, status, placed.RemainingAmountSats, result.Fills));
        });

        app.MapDelete("/api/v1/orders/{id:guid}", async (
            Guid id,
            OrderBookManager bookManager,
            IHubContext<MarketHub> hubContext) =>
        {
            // Search all books for this order
            foreach (var marketId in GetAllMarketIds(bookManager))
            {
                var book = bookManager.Get(marketId);
                if (book is not null && book.Cancel(id))
                {
                    await hubContext.Clients.Group(marketId)
                        .SendAsync("OrderBookUpdated", book.GetSnapshot());
                    return Results.Ok();
                }
            }
            return Results.NotFound();
        });
    }

    // Helper to iterate market IDs — accesses the internal dictionary via reflection-free approach
    // We track cancelled order's market externally or iterate. For simplicity, we expose market IDs.
    private static IEnumerable<string> GetAllMarketIds(OrderBookManager bookManager)
    {
        // OrderBookManager uses ConcurrentDictionary — we access it via the public API
        // Since we can't enumerate without exposing it, we'll need to add a method
        return bookManager.GetAllMarketIds();
    }
}
