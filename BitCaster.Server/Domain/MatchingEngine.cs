namespace BitCaster.Server.Domain;

public static class MatchingEngine
{
    /// <summary>
    /// Try to match an incoming order against resting orders.
    /// Direct: Buy YES vs Sell YES (or Buy NO vs Sell NO).
    /// Complementary: Buy YES @ P vs Buy NO @ >= (100-P), forming a complete set.
    /// </summary>
    public static MatchResult Match(
        Order incoming,
        SortedSet<Order> directCounterparty,
        SortedSet<Order>? complementaryCounterparty)
    {
        var fills = new List<Fill>();
        var remaining = incoming.RemainingAmountSats;

        // 1. Direct matching
        remaining = MatchAgainst(incoming, directCounterparty, fills, remaining, MatchPath.Direct);

        // 2. Complementary matching (only for limit buy orders with a price)
        if (remaining > 0 && complementaryCounterparty is not null && incoming.Price.HasValue)
        {
            remaining = MatchAgainst(incoming, complementaryCounterparty, fills, remaining, MatchPath.Complementary);
        }

        return new MatchResult(fills, remaining);
    }

    private static long MatchAgainst(
        Order incoming,
        SortedSet<Order> resting,
        List<Fill> fills,
        long remaining,
        MatchPath path)
    {
        var toRemove = new List<Order>();

        foreach (var maker in resting)
        {
            if (remaining <= 0) break;

            if (!PricesMatch(incoming, maker, path)) break;

            var fillAmount = Math.Min(remaining, maker.RemainingAmountSats);
            var executionPrice = path == MatchPath.Direct
                ? maker.Price!.Value
                : 100 - maker.Price!.Value;

            fills.Add(new Fill(
                Guid.NewGuid(),
                incoming.Id,
                maker.Id,
                fillAmount,
                executionPrice,
                path,
                DateTimeOffset.UtcNow));

            remaining -= fillAmount;
            maker.RemainingAmountSats -= fillAmount;

            if (maker.RemainingAmountSats == 0)
                toRemove.Add(maker);
        }

        foreach (var order in toRemove)
            resting.Remove(order);

        return remaining;
    }

    private static bool PricesMatch(Order incoming, Order maker, MatchPath path)
    {
        if (incoming.Type == OrderType.Market) return true;
        if (!incoming.Price.HasValue || !maker.Price.HasValue) return false;

        return path switch
        {
            // Direct: incoming buy price >= maker ask price, or incoming sell price <= maker bid price
            MatchPath.Direct => incoming.Side == OrderSide.Buy
                ? incoming.Price.Value >= maker.Price.Value
                : incoming.Price.Value <= maker.Price.Value,
            // Complementary: incoming buy YES @ P matches buy NO @ Q where P + Q >= 100
            MatchPath.Complementary => incoming.Price.Value + maker.Price.Value >= 100,
            _ => false
        };
    }
}
