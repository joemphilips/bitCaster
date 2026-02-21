using System.Collections.Concurrent;

namespace BitCaster.Server.Domain;

public class OrderBookManager
{
    private readonly ConcurrentDictionary<string, OrderBook> _books = new();

    public OrderBook GetOrCreate(string marketId) =>
        _books.GetOrAdd(marketId, _ => new OrderBook(marketId));

    public OrderBook? Get(string marketId) =>
        _books.TryGetValue(marketId, out var book) ? book : null;

    public IEnumerable<string> GetAllMarketIds() => _books.Keys;
}

public class OrderBook
{
    public string MarketId { get; }
    private readonly object _lock = new();

    // Per-outcome order sides. Key: outcomeId, Value: (Bids, Asks)
    private readonly Dictionary<string, (SortedSet<Order> Bids, SortedSet<Order> Asks)> _outcomes = new();
    private readonly Dictionary<Guid, Order> _ordersById = new();

    public OrderBook(string marketId) => MarketId = marketId;

    public (MatchResult Result, Order Order) Submit(Order order)
    {
        lock (_lock)
        {
            var (bids, asks) = GetOrCreateSides(order.OutcomeId);

            // Direct counterparty: if buying, match against asks; if selling, match against bids
            var directCounterparty = order.Side == OrderSide.Buy ? asks : bids;

            // Complementary counterparty: buy YES matches buy NO (and vice versa)
            SortedSet<Order>? complementaryCounterparty = null;
            if (order.Side == OrderSide.Buy)
            {
                var complementaryOutcome = GetComplementaryOutcomeId(order.OutcomeId);
                if (complementaryOutcome is not null)
                {
                    var (compBids, _) = GetOrCreateSides(complementaryOutcome);
                    complementaryCounterparty = compBids;
                }
            }

            var result = MatchingEngine.Match(order, directCounterparty, complementaryCounterparty);
            order.RemainingAmountSats = result.RemainingSats;

            // Rest remaining amount on the book (limit orders only)
            if (result.RemainingSats > 0 && order.Type == OrderType.Limit)
            {
                var restingSide = order.Side == OrderSide.Buy ? bids : asks;
                restingSide.Add(order);
                _ordersById[order.Id] = order;
            }

            return (result, order);
        }
    }

    public bool Cancel(Guid orderId)
    {
        lock (_lock)
        {
            if (!_ordersById.TryGetValue(orderId, out var order))
                return false;

            var (bids, asks) = GetOrCreateSides(order.OutcomeId);
            var side = order.Side == OrderSide.Buy ? bids : asks;
            side.Remove(order);
            _ordersById.Remove(orderId);
            return true;
        }
    }

    public OrderBookSnapshot GetSnapshot()
    {
        lock (_lock)
        {
            var outcomes = new Dictionary<string, OutcomeSnapshot>();
            foreach (var (outcomeId, (bids, asks)) in _outcomes)
            {
                outcomes[outcomeId] = new OutcomeSnapshot(
                    Bids: bids.Select(o => new LevelDto(o.Price!.Value, o.RemainingAmountSats)).ToArray(),
                    Asks: asks.Select(o => new LevelDto(o.Price!.Value, o.RemainingAmountSats)).ToArray(),
                    Spread: GetSpread(bids, asks));
            }
            return new OrderBookSnapshot(MarketId, outcomes);
        }
    }

    private (SortedSet<Order> Bids, SortedSet<Order> Asks) GetOrCreateSides(string outcomeId)
    {
        if (!_outcomes.TryGetValue(outcomeId, out var sides))
        {
            sides = (
                new SortedSet<Order>(new BidComparer()),
                new SortedSet<Order>(new AskComparer())
            );
            _outcomes[outcomeId] = sides;
        }
        return sides;
    }

    private static string? GetComplementaryOutcomeId(string outcomeId) =>
        outcomeId.ToUpperInvariant() switch
        {
            "YES" => "NO",
            "NO" => "YES",
            _ => null // categorical markets don't have simple complements
        };

    private static int? GetSpread(SortedSet<Order> bids, SortedSet<Order> asks) =>
        bids.Count > 0 && asks.Count > 0
            ? asks.Min!.Price!.Value - bids.Min!.Price!.Value
            : null;

    // Bids: highest price first, then earliest time
    private class BidComparer : IComparer<Order>
    {
        public int Compare(Order? x, Order? y)
        {
            if (x is null || y is null) return 0;
            var priceCompare = (y.Price ?? 0).CompareTo(x.Price ?? 0);
            if (priceCompare != 0) return priceCompare;
            var timeCompare = x.PlacedAt.CompareTo(y.PlacedAt);
            return timeCompare != 0 ? timeCompare : x.Id.CompareTo(y.Id);
        }
    }

    // Asks: lowest price first, then earliest time
    private class AskComparer : IComparer<Order>
    {
        public int Compare(Order? x, Order? y)
        {
            if (x is null || y is null) return 0;
            var priceCompare = (x.Price ?? 0).CompareTo(y.Price ?? 0);
            if (priceCompare != 0) return priceCompare;
            var timeCompare = x.PlacedAt.CompareTo(y.PlacedAt);
            return timeCompare != 0 ? timeCompare : x.Id.CompareTo(y.Id);
        }
    }
}

public record OrderBookSnapshot(string MarketId, Dictionary<string, OutcomeSnapshot> Outcomes);

public record OutcomeSnapshot(LevelDto[] Bids, LevelDto[] Asks, int? Spread);

public record LevelDto(int Price, long Amount);
