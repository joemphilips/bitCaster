using System.Collections.Concurrent;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine;

/// <summary>
/// In-memory matching-engine stub. Implements just enough of the real engine's
/// behaviour to keep the frontend dev/E2E loop moving:
///
/// <list type="bullet">
/// <item>Per-market FIFO order book at each price level (price-time priority).</item>
/// <item>Direct match only — same outcome, opposite side. No complementary
/// matching across the conditional-token complement (taking only what the
/// frontend exercises).</item>
/// <item>GTC + FAK time-in-force — what <c>MarketDetailPage</c> actually
/// submits today. FOK / GTD treated as GTC; the OpenAPI gate keeps unknown
/// values out.</item>
/// </list>
///
/// <para>
/// The mock's only state is an in-memory <see cref="ConcurrentDictionary{TKey, TValue}"/>
/// per market — it has no Sekiban runtime and is never deployed; the
/// production engine continues to own real persistence.
/// </para>
///
/// <para>
/// Direct-match fills get a freshly-generated <c>tradeId</c> stamped onto the
/// emitted <see cref="Fill.AdditionalProperties"/>. The frontend reads the id
/// off this dictionary in <c>orderStatus.ts</c> to wake the atomic-swap
/// driver.
/// </para>
/// </summary>
public class InMemoryOrderBookManager
{
    private readonly ConcurrentDictionary<string, OrderBook> _books = new();

    public SubmitResult SubmitOrder(
        string marketId,
        string outcomeId,
        OrderSide side,
        int priceValue,
        long amountSats,
        string userId,
        TimeInForce? timeInForce,
        string? ephemeralPubkey)
    {
        var tif = timeInForce ?? TimeInForce.GTC;
        var book = _books.GetOrAdd(marketId, _ => new OrderBook(marketId));

        var orderId = Guid.NewGuid();
        var incoming = new RestingOrder(
            orderId, outcomeId, side, priceValue, amountSats,
            userId, ephemeralPubkey, DateTimeOffset.UtcNow);

        List<Fill> fills;
        long remaining;
        lock (book)
        {
            fills = MatchAgainstBook(book, incoming);
            remaining = incoming.RemainingSats;

            // FAK: never rest the unfilled remainder. GTC: rest if anything left.
            // (FOK isn't exercised by the mock — we treat it as GTC.)
            if (tif != TimeInForce.FAK && remaining > 0)
            {
                book.AddResting(incoming);
            }
            else if (fills.Count > 0)
            {
                // Fully-filled taker (or FAK with any fills) is not in
                // _resting and would otherwise be invisible to GET /orders/{id}.
                // Park it in _completed so the order-status poller can read
                // back the per-fill tradeIds and wake the swap-driver.
                var takerStatus = remaining == 0 ? "filled" : "cancelled";
                book.MarkTakerCompleted(incoming, takerStatus);
            }
        }

        var status = DeriveStatus(amountSats, remaining, tif, fills.Count > 0);
        return new SubmitResult(
            OrderId: orderId,
            Status: status,
            RemainingAmountSats: remaining,
            Fills: fills,
            EphemeralPubkey: ephemeralPubkey ?? string.Empty);
    }

    public bool CancelOrder(Guid orderId, out string? marketId)
    {
        marketId = null;
        foreach (var (id, book) in _books)
        {
            lock (book)
            {
                if (!book.Cancel(orderId)) continue;
                marketId = id;
                return true;
            }
        }
        return false;
    }

    public OrderStatusView? GetOrderStatus(Guid orderId)
    {
        foreach (var (id, book) in _books)
        {
            lock (book)
            {
                var view = book.LookupStatus(id, orderId);
                if (view is not null) return view;
            }
        }
        return null;
    }

    public OrderBookSnapshot GetSnapshot(string marketId)
    {
        if (!_books.TryGetValue(marketId, out var book))
            return new OrderBookSnapshot([], [], marketId, null);

        var parts = marketId.Split('-', 2);
        var outcomeId = parts.Length > 1 ? parts[1] : marketId;

        lock (book)
            return book.SnapshotForOutcome(marketId, outcomeId);
    }

    /// <summary>
    /// Direct-match the incoming order against same-outcome opposite-side
    /// resting orders. Mutates <paramref name="incoming"/>.RemainingSats and
    /// the matched resting orders in place; the caller still holds the book
    /// lock. Generates a fresh <c>tradeId</c> per fill so the frontend's
    /// atomic-swap driver can pair counterparties.
    /// </summary>
    private static List<Fill> MatchAgainstBook(OrderBook book, RestingOrder incoming)
    {
        var fills = new List<Fill>();
        foreach (var maker in book.MatchableAgainst(incoming))
        {
            if (incoming.RemainingSats <= 0) break;
            var fillAmount = Math.Min(incoming.RemainingSats, maker.RemainingSats);
            if (fillAmount <= 0) continue;

            incoming.RemainingSats -= fillAmount;
            maker.RemainingSats -= fillAmount;
            var fill = BuildFill(incoming, maker, fillAmount);
            fills.Add(fill);
            book.RecordFill(incoming.Id, maker.Id, fill);
        }
        book.RemoveCompleted();
        return fills;
    }

    private static Fill BuildFill(RestingOrder taker, RestingOrder maker, long amount)
    {
        var fill = new Fill(
            amountSats: amount,
            executionPrice: maker.Price,
            filledAt: DateTimeOffset.UtcNow,
            id: Guid.NewGuid(),
            makerEphemeralPubkey: maker.EphemeralPubkey!,
            makerOrderId: maker.Id,
            path: MatchPath.Direct,
            takerOrderId: taker.Id);
        // Frontend reads tradeId off the Fill's open extension data — see
        // bitCaster-app/src/lib/orderStatus.ts. The contract Fill class has no
        // typed tradeId field; the AdditionalProperties dictionary is the
        // forward-compatible escape hatch and serializes inline thanks to
        // [JsonExtensionData] on the generated property.
        fill.AdditionalProperties["tradeId"] = Guid.NewGuid().ToString();
        return fill;
    }

    private static string DeriveStatus(long requested, long remaining, TimeInForce tif, bool anyFills)
    {
        if (remaining == 0) return "filled";
        if (anyFills && tif == TimeInForce.FAK) return "partially_filled";
        if (anyFills) return "partially_filled";
        return tif == TimeInForce.FAK ? "cancelled" : "resting";
    }
}

/// <summary>
/// Per-market mutable state: live resting orders plus a completed-order index
/// so <c>GET /orders/{id}</c> works after the order is fully filled or
/// cancelled. Always accessed under the manager's lock.
/// </summary>
internal sealed class OrderBook
{
    public OrderBook(string marketId) => MarketId = marketId;

    public string MarketId { get; }

    private readonly List<RestingOrder> _resting = [];
    private readonly Dictionary<Guid, CompletedOrder> _completed = [];
    /// <summary>
    /// Fills indexed by both the maker and taker orderId so a later
    /// <c>GET /orders/{id}</c> can surface the per-fill <c>tradeId</c>.
    /// The frontend's <c>usePendingTradesPoller</c> reads the tradeId off
    /// this collection to wake the atomic-swap driver — without this index
    /// the recovery path (close + reopen) has no way to discover that a
    /// match has occurred.
    /// </summary>
    private readonly Dictionary<Guid, List<Fill>> _fillsByOrderId = [];

    public void AddResting(RestingOrder order) => _resting.Add(order);

    /// <summary>
    /// Record a fill against both sides of the match. Called from the
    /// matching loop while the book lock is held.
    /// </summary>
    public void RecordFill(Guid takerOrderId, Guid makerOrderId, Fill fill)
    {
        if (!_fillsByOrderId.TryGetValue(takerOrderId, out var takerFills))
            _fillsByOrderId[takerOrderId] = takerFills = [];
        takerFills.Add(fill);
        if (!_fillsByOrderId.TryGetValue(makerOrderId, out var makerFills))
            _fillsByOrderId[makerOrderId] = makerFills = [];
        makerFills.Add(fill);
    }

    public IReadOnlyList<Fill> GetFills(Guid orderId)
        => _fillsByOrderId.TryGetValue(orderId, out var fills)
            ? fills
            : (IReadOnlyList<Fill>)Array.Empty<Fill>();

    public IEnumerable<RestingOrder> MatchableAgainst(RestingOrder incoming)
    {
        // Crossing rule: incoming Buy crosses resting Sells priced ≤ incoming;
        // incoming Sell crosses resting Buys priced ≥ incoming. Same outcome.
        // FIFO at each price level — sort by (price, then placed time).
        bool Crosses(RestingOrder maker) =>
            maker.OutcomeId == incoming.OutcomeId
            && maker.Side != incoming.Side
            && (incoming.Side == OrderSide.Buy
                ? maker.Price <= incoming.Price
                : maker.Price >= incoming.Price);

        return _resting
            .Where(Crosses)
            .OrderBy(o => incoming.Side == OrderSide.Buy ? o.Price : -o.Price)
            .ThenBy(o => o.PlacedAt);
    }

    public void RemoveCompleted()
    {
        for (var i = _resting.Count - 1; i >= 0; i--)
        {
            var o = _resting[i];
            if (o.RemainingSats > 0) continue;
            _completed[o.Id] = new CompletedOrder(o, "filled");
            _resting.RemoveAt(i);
        }
    }

    /// <summary>
    /// Park a fully-filled (or FAK-cancelled) taker order in the
    /// completed index so <see cref="LookupStatus"/> can return its
    /// fills. The taker never enters <c>_resting</c>, so
    /// <see cref="RemoveCompleted"/> alone does not cover it.
    /// </summary>
    public void MarkTakerCompleted(RestingOrder taker, string status)
        => _completed[taker.Id] = new CompletedOrder(taker, status);

    public bool Cancel(Guid orderId)
    {
        for (var i = 0; i < _resting.Count; i++)
        {
            if (_resting[i].Id != orderId) continue;
            _completed[orderId] = new CompletedOrder(_resting[i], "cancelled");
            _resting.RemoveAt(i);
            return true;
        }
        return false;
    }

    public OrderStatusView? LookupStatus(string marketId, Guid orderId)
    {
        var fills = GetFills(orderId).ToList();
        foreach (var o in _resting)
        {
            if (o.Id != orderId) continue;
            var filled = o.AmountSats - o.RemainingSats;
            var status = filled == 0 ? "resting" : "partially_filled";
            return new OrderStatusView(orderId, marketId, status, o.RemainingSats, filled, fills);
        }
        if (_completed.TryGetValue(orderId, out var c))
        {
            var filled = c.Order.AmountSats - c.Order.RemainingSats;
            return new OrderStatusView(orderId, marketId, c.Status, c.Order.RemainingSats, filled, fills);
        }
        return null;
    }

    public OrderBookSnapshot SnapshotForOutcome(string marketId, string outcomeId)
    {
        var live = _resting.Where(o => o.OutcomeId == outcomeId).ToList();
        var bids = AggregateLevels(live.Where(o => o.Side == OrderSide.Buy), descending: true);
        var asks = AggregateLevels(live.Where(o => o.Side == OrderSide.Sell), descending: false);
        int? spread = bids.Count > 0 && asks.Count > 0 ? asks[0].Price - bids[0].Price : null;
        return new OrderBookSnapshot(asks, bids, marketId, spread);
    }

    private static List<LevelDto> AggregateLevels(IEnumerable<RestingOrder> orders, bool descending)
    {
        var grouped = orders
            .GroupBy(o => o.Price)
            .Select(g => new LevelDto(g.Sum(o => o.RemainingSats), g.Key));
        return (descending ? grouped.OrderByDescending(l => l.Price) : grouped.OrderBy(l => l.Price))
            .ToList();
    }
}

internal sealed class RestingOrder
{
    public RestingOrder(
        Guid id, string outcomeId, OrderSide side, int price, long amountSats,
        string userId, string? ephemeralPubkey, DateTimeOffset placedAt)
    {
        Id = id;
        OutcomeId = outcomeId;
        Side = side;
        Price = price;
        AmountSats = amountSats;
        RemainingSats = amountSats;
        UserId = userId;
        EphemeralPubkey = ephemeralPubkey;
        PlacedAt = placedAt;
    }

    public Guid Id { get; }
    public string OutcomeId { get; }
    public OrderSide Side { get; }
    public int Price { get; }
    public long AmountSats { get; }
    public long RemainingSats { get; set; }
    public string UserId { get; }
    public string? EphemeralPubkey { get; }
    public DateTimeOffset PlacedAt { get; }
}

internal sealed record CompletedOrder(RestingOrder Order, string Status);

public record SubmitResult(
    Guid OrderId,
    string Status,
    long RemainingAmountSats,
    List<Fill> Fills,
    string EphemeralPubkey);

public record OrderStatusView(
    Guid OrderId,
    string MarketId,
    string Status,
    long RemainingAmountSats,
    long FilledAmountSats,
    List<Fill> Fills);
