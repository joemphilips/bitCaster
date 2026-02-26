using System.Collections.Concurrent;
using BitCaster.MatchingEngine.Contracts;
using BitCaster.MatchingEngine.Contracts.Domain;

namespace BitCaster.InMemoryMatchingEngine;

public class InMemoryOrderBookManager
{
    private readonly ConcurrentDictionary<string, List<Order>> _orders = new();
    private readonly object _lock = new();

    public void AddOrder(Order order)
    {
        lock (_lock)
        {
            var list = _orders.GetOrAdd(order.MarketId, _ => new List<Order>());
            list.Add(order);
        }
    }

    public bool CancelOrder(Guid id)
    {
        lock (_lock)
        {
            foreach (var (_, orders) in _orders)
            {
                var order = orders.Find(o => o.Id == id);
                if (order is not null)
                {
                    orders.Remove(order);
                    return true;
                }
            }
            return false;
        }
    }

    public string? GetMarketIdForOrder(Guid id)
    {
        lock (_lock)
        {
            foreach (var (marketId, orders) in _orders)
            {
                if (orders.Any(o => o.Id == id))
                    return marketId;
            }
            return null;
        }
    }

    public OrderBookSnapshot GetSnapshot(string marketId)
    {
        lock (_lock)
        {
            if (!_orders.TryGetValue(marketId, out var orders))
                return new OrderBookSnapshot(marketId, new());

            var outcomes = new Dictionary<string, OutcomeSnapshot>();
            var grouped = orders.GroupBy(o => o.OutcomeId);

            foreach (var group in grouped)
            {
                var bids = group
                    .Where(o => o.Side == OrderSide.Buy && o.Type == OrderType.Limit)
                    .OrderByDescending(o => o.Price)
                    .ThenBy(o => o.PlacedAt)
                    .Select(o => new LevelDto(
                        amount: o.RemainingAmountSats.Value,
                        price: o.Price!.Value.Value))
                    .ToList();

                var asks = group
                    .Where(o => o.Side == OrderSide.Sell && o.Type == OrderType.Limit)
                    .OrderBy(o => o.Price)
                    .ThenBy(o => o.PlacedAt)
                    .Select(o => new LevelDto(
                        amount: o.RemainingAmountSats.Value,
                        price: o.Price!.Value.Value))
                    .ToList();

                var spread = bids.Count > 0 && asks.Count > 0
                    ? asks[0].Price - bids[0].Price
                    : (int?)null;

                outcomes[group.Key] = new OutcomeSnapshot(
                    asks: asks, bids: bids, spread: spread);
            }

            return new OrderBookSnapshot(marketId, outcomes);
        }
    }

    public IEnumerable<string> GetAllMarketIds() => _orders.Keys;
}
