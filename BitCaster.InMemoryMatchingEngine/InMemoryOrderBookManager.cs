using System.Collections.Concurrent;
using BitCaster.MatchingEngine.Contracts;
using MockOrderSide = BitCaster.MatchingEngine.Contracts.OrderSide;
using MockFill = BitCaster.MatchingEngine.Contracts.Fill;
using MockMatchPath = BitCaster.MatchingEngine.Contracts.MatchPath;
using MockTimeInForce = BitCaster.MatchingEngine.Contracts.TimeInForce;
using DomainOrder = BitCaster.MatchingEngine.Domain.Contracts.Domain.Order;
using DomainOrderSide = BitCaster.MatchingEngine.Domain.Contracts.Domain.OrderSide;
using DomainTif = BitCaster.MatchingEngine.Domain.Contracts.Domain.TimeInForce;
using DomainSats = BitCaster.MatchingEngine.Domain.Contracts.Domain.Sats;
using DomainProbability = BitCaster.MatchingEngine.Domain.Contracts.Domain.Probability;
using DomainMatchPath = BitCaster.MatchingEngine.Domain.Contracts.Domain.MatchPath;
using DomainFill = BitCaster.MatchingEngine.Domain.Contracts.Domain.Fill;
using BitCaster.MatchingEngine.Domain.Aggregates.OrderBook;
using BitCaster.MatchingEngine.Domain.Aggregates.OrderBook.Commands;
using BitCaster.MatchingEngine.Domain.Aggregates.OrderBook.Events;
using BitCaster.MatchingEngine.Domain.Aggregates.OrderBook.Payloads;

namespace BitCaster.InMemoryMatchingEngine;

/// <summary>
/// In-memory matching-engine shim that delegates to the real
/// <see cref="MatchingEngineLogic"/> + <see cref="OrderBookProjector"/> from the
/// private engine's Domain assembly. This gives the mock identical matching
/// semantics to the real engine without re-implementing any logic.
///
/// The mock is allowed in-process <see cref="ConcurrentDictionary{TKey, TValue}"/>
/// state because it is a test double — the Sekiban-persistence rule applies to the
/// real engine only. Each market's state is a single immutable
/// <see cref="OrderBookPayload"/> updated under a per-manager lock so concurrent
/// requests from the frontend E2E suite see a consistent book.
/// </summary>
public class InMemoryOrderBookManager
{
    private readonly ConcurrentDictionary<string, OrderBookPayload> _books = new();
    private readonly object _lock = new();

    public SubmitResult SubmitOrder(
        string marketId,
        string outcomeId,
        MockOrderSide side,
        int priceValue,
        long amountSats,
        string userId,
        MockTimeInForce? timeInForce,
        string? ephemeralPubkey)
    {
        var tif = ToDomainTif(timeInForce);
        var price = new DomainProbability(priceValue);
        var amount = new DomainSats(amountSats);
        var placedAt = DateTimeOffset.UtcNow;
        var orderId = Guid.NewGuid();

        OrderSubmitted submitted;
        lock (_lock)
        {
            var book = _books.TryGetValue(marketId, out var existing)
                ? existing
                : OrderBookPayload.Empty(marketId);

            // Lazy GTD expiry sweep — mirrors SubmitOrderCommand.HandleSubmit.
            book = SubmitOrderCommand.SweepExpiredGtdOrders(book, placedAt);

            var incoming = new DomainOrder(
                orderId,
                marketId,
                outcomeId,
                ToDomainSide(side),
                price,
                amount,
                amount,
                userId,
                placedAt,
                tif);

            var (direct, complementary) = SubmitOrderCommand.BuildMatchingSets(
                book, outcomeId, incoming.Side);

            var matchResult = MatchingEngineLogic.Match(incoming, direct, complementary);
            var fills = matchResult.Fills;
            var remaining = matchResult.RemainingSats;

            // FOK: reject entirely if not fully filled.
            if (tif == DomainTif.FOK && remaining > DomainSats.Zero)
            {
                fills = [];
                remaining = amount;
            }

            submitted = new OrderSubmitted(
                orderId, outcomeId, ToDomainSide(side),
                price, amount, userId, placedAt,
                fills, remaining, tif, ExpiresAt: null, ephemeralPubkey);

            book = OrderBookProjector.ApplyOrderSubmitted(book, submitted);
            _books[marketId] = book;
        }

        var status = DeriveStatus(submitted);
        return new SubmitResult(
            OrderId: submitted.OrderId,
            Status: status,
            RemainingAmountSats: submitted.RemainingSats.Value,
            Fills: submitted.Fills.Select(ToContractFill).ToList(),
            EphemeralPubkey: ephemeralPubkey ?? string.Empty);
    }

    public bool CancelOrder(Guid orderId, out string? marketId)
    {
        marketId = null;
        lock (_lock)
        {
            foreach (var (id, payload) in _books)
            {
                if (!payload.OrdersById.ContainsKey(orderId)) continue;

                var updated = OrderBookProjector.ApplyOrderCancelled(payload, new OrderCancelled(orderId));
                _books[id] = updated;
                marketId = id;
                return true;
            }
            return false;
        }
    }

    public string? GetMarketIdForOrder(Guid orderId)
    {
        lock (_lock)
        {
            foreach (var (id, payload) in _books)
            {
                if (payload.OrdersById.ContainsKey(orderId) || payload.CompletedOrders.ContainsKey(orderId))
                    return id;
            }
            return null;
        }
    }

    /// <summary>
    /// Look up the owning user id for an order id. Used by the mock's
    /// CPMM-fill detection to identify bootstrap orders (whose UserId is the
    /// <c>cpmm:{marketId}</c> sentinel). Returns the userId from either the
    /// resting book or the completed-orders map — which covers the case where
    /// a maker order was fully consumed by the same fill we're inspecting.
    /// </summary>
    public string? GetOrderOwner(Guid orderId)
    {
        lock (_lock)
        {
            foreach (var (_, payload) in _books)
            {
                if (payload.OrdersById.TryGetValue(orderId, out var resting))
                    return resting.UserId;
                if (payload.CompletedOrders.TryGetValue(orderId, out var completed))
                    return completed.UserId;
            }
            return null;
        }
    }

    public OrderStatusView? GetOrderStatus(Guid orderId)
    {
        lock (_lock)
        {
            foreach (var (id, payload) in _books)
            {
                if (payload.OrdersById.TryGetValue(orderId, out var resting))
                {
                    var filled = resting.AmountSats.Value - resting.RemainingAmountSats.Value;
                    var status = filled == 0 ? "resting" : "partially_filled";
                    return new OrderStatusView(
                        orderId, id, status,
                        resting.RemainingAmountSats.Value, filled,
                        new List<MockFill>());
                }

                if (payload.CompletedOrders.TryGetValue(orderId, out var completed))
                {
                    var filled = completed.AmountSats.Value - completed.RemainingAmountSats.Value;
                    return new OrderStatusView(
                        orderId, id, completed.Status,
                        completed.RemainingAmountSats.Value, filled,
                        // The Sekiban projector does not retain the fills list on the
                        // completed-order record, matching the real engine's shape.
                        new List<MockFill>());
                }
            }
            return null;
        }
    }

    public OrderBookSnapshot GetSnapshot(string marketId)
    {
        lock (_lock)
        {
            if (!_books.TryGetValue(marketId, out var book))
                return new OrderBookSnapshot(new List<LevelDto>(), new List<LevelDto>(), marketId, null);

            // The mock's wire format uses the NSwag-generated LevelDto/OrderBookSnapshot,
            // which has flat (bids, asks) per market (outcome implied by marketId). Mirror
            // GetOrderBookSnapshotQuery's price aggregation but emit mock-shaped DTOs.
            var parts = marketId.Split('-', 2);
            var outcomeId = parts.Length > 1 ? parts[1] : marketId;
            if (!book.Sides.TryGetValue(outcomeId, out var sides))
                return new OrderBookSnapshot(new List<LevelDto>(), new List<LevelDto>(), marketId, null);

            var bids = sides.BidIds
                .Select(id => book.OrdersById.GetValueOrDefault(id))
                .Where(o => o is not null)
                .GroupBy(o => o!.Price.Value)
                .Select(g => new LevelDto(g.Sum(o => o!.RemainingAmountSats.Value), g.Key))
                .OrderByDescending(l => l.Price)
                .ToList();

            var asks = sides.AskIds
                .Select(id => book.OrdersById.GetValueOrDefault(id))
                .Where(o => o is not null)
                .GroupBy(o => o!.Price.Value)
                .Select(g => new LevelDto(g.Sum(o => o!.RemainingAmountSats.Value), g.Key))
                .OrderBy(l => l.Price)
                .ToList();

            int? spread = bids.Count > 0 && asks.Count > 0 ? asks[0].Price - bids[0].Price : null;
            return new OrderBookSnapshot(asks, bids, marketId, spread);
        }
    }

    private static DomainOrderSide ToDomainSide(MockOrderSide side)
        => side == MockOrderSide.Buy ? DomainOrderSide.Buy : DomainOrderSide.Sell;

    private static DomainTif ToDomainTif(MockTimeInForce? tif) => tif switch
    {
        MockTimeInForce.FOK => DomainTif.FOK,
        MockTimeInForce.FAK => DomainTif.FAK,
        _ => DomainTif.GTC,
    };

    private static string DeriveStatus(OrderSubmitted submitted)
    {
        if (submitted.RemainingSats == DomainSats.Zero) return "filled";
        return submitted.TimeInForce switch
        {
            DomainTif.GTC or DomainTif.GTD => submitted.Fills.Count > 0 ? "partially_filled" : "resting",
            _ => submitted.Fills.Count > 0 ? "partially_filled" : "cancelled",
        };
    }

    private static MockFill ToContractFill(DomainFill f) =>
        // Mock's Fill ctor: (amountSats, executionPrice, filledAt, id, makerOrderId, path, takerOrderId)
        new(
            amountSats: f.AmountSats.Value,
            executionPrice: f.ExecutionPrice.Value,
            filledAt: f.FilledAt,
            id: f.Id,
            makerOrderId: f.MakerOrderId,
            path: f.Path == DomainMatchPath.Direct ? MatchPath.Direct : MatchPath.Complementary,
            takerOrderId: f.TakerOrderId);
}

public record SubmitResult(
    Guid OrderId,
    string Status,
    long RemainingAmountSats,
    List<MockFill> Fills,
    string EphemeralPubkey);

public record OrderStatusView(
    Guid OrderId,
    string MarketId,
    string Status,
    long RemainingAmountSats,
    long FilledAmountSats,
    List<MockFill> Fills);
