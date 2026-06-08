using System.Collections.Concurrent;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine;

/// <summary>
/// In-memory matching-engine stub. Implements just enough catalogue/order
/// behavior to keep the frontend dev/E2E loop moving:
///
/// <list type="bullet">
/// <item>Per-market FIFO order book at each price level (price-time priority).</item>
/// <item>Complementary same-outcome opposite-side matching (Buy vs Sell) plus
/// YES/NO and finite categorical mint matching (Buy vs Buy splitter) for
/// CLI/daemon settlement E2E.</item>
/// <item>GTC, FAK, and FOK time-in-force semantics for the browser/CLI
/// development stack. GTD is treated as GTC; the OpenAPI gate keeps unknown
/// values out.</item>
/// </list>
///
/// <para>
/// The mock's only state is an in-memory <see cref="ConcurrentDictionary{TKey, TValue}"/>
/// per market. It is dev/E2E scaffolding, not production persistence.
/// </para>
///
/// <para>
/// Complementary-match fills get a freshly-generated <c>tradeId</c> stamped onto
/// the emitted <see cref="Fill.AdditionalProperties"/>. The frontend reads the id
/// off this dictionary in <c>orderStatus.ts</c> to wake the atomic-swap
/// driver.
/// </para>
/// </summary>
public class InMemoryOrderBookManager
{
    private readonly ConcurrentDictionary<string, OrderBook> _books = new();
    private readonly ConcurrentDictionary<Guid, string> _orderMarketIndex = new();
    private readonly object _matchingGate = new();

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
        lock (_matchingGate)
        {
            lock (book)
            {
                if (tif == TimeInForce.FOK && FillableSats(marketId, book, incoming) < incoming.AmountSats)
                {
                    fills = [];
                    remaining = incoming.RemainingSats;
                    book.MarkTakerCompleted(incoming, "cancelled");
                }
                else
                {
                    fills = MatchAgainstBook(book, incoming);
                    if (incoming.RemainingSats > 0)
                        fills.AddRange(MatchAgainstMintBooks(marketId, book, incoming));
                    remaining = incoming.RemainingSats;

                    // FAK/FOK never rest the unfilled remainder. GTC/GTD rest if anything remains.
                    if (tif is not (TimeInForce.FAK or TimeInForce.FOK) && remaining > 0)
                    {
                        book.AddResting(incoming);
                    }
                    else if (fills.Count > 0 || tif is TimeInForce.FAK or TimeInForce.FOK)
                    {
                        // Fully-filled takers and killed takers do not enter
                        // _resting and would otherwise be invisible to GET /orders/{id}.
                        // Park them in _completed so the order-status poller can read
                        // back per-fill tradeIds and wake the swap driver.
                        var takerStatus = remaining == 0 ? "filled" : "cancelled";
                        book.MarkTakerCompleted(incoming, takerStatus);
                    }
                }
            }
        }
        _orderMarketIndex[orderId] = marketId;

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
        if (!_orderMarketIndex.TryGetValue(orderId, out var indexedMarketId) ||
            !_books.TryGetValue(indexedMarketId, out var book))
        {
            return false;
        }

        lock (book)
        {
            if (!book.Cancel(orderId)) return false;
            marketId = indexedMarketId;
            return true;
        }
    }

    public OrderStatusView? GetOrderStatus(Guid orderId)
    {
        if (!_orderMarketIndex.TryGetValue(orderId, out var marketId) ||
            !_books.TryGetValue(marketId, out var book))
        {
            return null;
        }

        lock (book)
            return book.LookupStatus(marketId, orderId);
    }

    public OrderBookSnapshot GetSnapshot(string marketId)
    {
        var outcomeId = MarketParts.TryParse(marketId)?.OutcomeSetId ?? marketId;
        var directSnapshot = SnapshotForInternalBook(marketId, outcomeId);
        var complementAsks = ComplementAskLevels(marketId);
        if (complementAsks.Count == 0)
            return directSnapshot;

        var asks = MergeLevels(directSnapshot.Asks.Concat(complementAsks), descending: false);
        int? spread = directSnapshot.Bids.Count > 0 && asks.Count > 0
            ? asks[0].Price - directSnapshot.Bids[0].Price
            : null;
        return new OrderBookSnapshot(asks, directSnapshot.Bids, marketId, spread);
    }

    private OrderBookSnapshot SnapshotForInternalBook(string marketId, string outcomeId)
    {
        if (!_books.TryGetValue(marketId, out var book))
            return new OrderBookSnapshot([], [], marketId, null);

        lock (book)
            return book.SnapshotForOutcome(marketId, outcomeId);
    }

    private List<LevelDto> ComplementAskLevels(string publicMarketId)
    {
        var publicParts = MarketParts.TryParse(publicMarketId);
        if (publicParts is null) return [];

        var complementBook = _books
            .Where(entry =>
            {
                var parts = MarketParts.TryParse(entry.Key);
                return parts is not null
                       && parts.ConditionId == publicParts.ConditionId
                       && !string.Equals(parts.OutcomeSetId, publicParts.OutcomeSetId, StringComparison.Ordinal)
                       && OutcomeSetComplement.AreComplements(parts.OutcomeSetId, publicParts.OutcomeSetId);
            })
            .OrderBy(entry => entry.Key, StringComparer.Ordinal)
            .Select(entry => (entry.Key, entry.Value))
            .FirstOrDefault();

        if (complementBook.Value is null) return [];

        var complementOutcomeId = MarketParts.TryParse(complementBook.Key)?.OutcomeSetId;
        if (string.IsNullOrWhiteSpace(complementOutcomeId)) return [];

        lock (complementBook.Value)
        {
            return complementBook.Value.BuyDepthForOutcome(complementOutcomeId)
                .Select(level => new LevelDto(level.Amount, 100 - level.Price))
                .ToList();
        }
    }

    private static List<LevelDto> MergeLevels(IEnumerable<LevelDto> levels, bool descending)
    {
        var grouped = levels
            .GroupBy(level => level.Price)
            .Select(group => new LevelDto(group.Sum(level => level.Amount), group.Key));
        return (descending ? grouped.OrderByDescending(level => level.Price) : grouped.OrderBy(level => level.Price))
            .ToList();
    }

    /// <summary>
    /// Complementary-match the incoming order against same-outcome
    /// opposite-side resting orders (Polymarket CTF V2 Complementary path:
    /// Buy vs Sell). Mutates <paramref name="incoming"/>.RemainingSats and the
    /// matched resting orders in place; the caller still holds the book lock.
    /// Generates a fresh <c>tradeId</c> per fill so the frontend's atomic-swap
    /// driver can pair counterparties.
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
            var fill = BuildFill(book.MarketId, incoming, maker, fillAmount);
            fills.Add(fill);
            book.RecordFill(incoming.Id, maker.Id, fill);
        }
        book.RemoveCompleted();
        return fills;
    }

    private long FillableSats(string marketId, OrderBook currentBook, RestingOrder incoming)
    {
        var fillable = FillableAgainstBook(currentBook, incoming, incoming.AmountSats);
        if (fillable >= incoming.AmountSats || incoming.Side != OrderSide.Buy) return fillable;

        var parsed = MarketParts.TryParse(marketId);
        if (parsed is null) return fillable;
        foreach (var candidate in MintBooks(parsed))
        {
            if (fillable >= incoming.AmountSats) break;
            lock (candidate.Book)
            {
                foreach (var maker in candidate.Book.MintBuyMakers(incoming, candidate.OutcomeSetId))
                {
                    fillable += Math.Min(maker.RemainingSats, incoming.AmountSats - fillable);
                    if (fillable >= incoming.AmountSats) break;
                }
            }
        }

        return fillable;
    }

    private static long FillableAgainstBook(OrderBook book, RestingOrder incoming, long requestedSats)
    {
        var fillable = 0L;
        foreach (var maker in book.MatchableAgainst(incoming))
        {
            fillable += Math.Min(maker.RemainingSats, requestedSats - fillable);
            if (fillable >= requestedSats) break;
        }

        return fillable;
    }

    private List<Fill> MatchAgainstMintBooks(string marketId, OrderBook currentBook, RestingOrder incoming)
    {
        if (incoming.Side != OrderSide.Buy) return [];
        var parsed = MarketParts.TryParse(marketId);
        if (parsed is null) return [];
        var fills = new List<Fill>();
        foreach (var candidate in MintBooks(parsed))
        {
            if (incoming.RemainingSats <= 0) break;
            lock (candidate.Book)
            {
                foreach (var maker in candidate.Book.MintBuyMakers(incoming, candidate.OutcomeSetId))
                {
                    if (incoming.RemainingSats <= 0) break;
                    var fillAmount = Math.Min(incoming.RemainingSats, maker.RemainingSats);
                    if (fillAmount <= 0) continue;

                    incoming.RemainingSats -= fillAmount;
                    maker.RemainingSats -= fillAmount;
                    var fill = BuildMintFill(
                        incoming,
                        maker,
                        fillAmount,
                        marketId,
                        sellerKeepOutcomeSetId: candidate.OutcomeSetId,
                        sellerLockOutcomeSetId: parsed.OutcomeSetId);
                    fills.Add(fill);
                    currentBook.RecordFillForOrder(incoming.Id, fill);
                    candidate.Book.RecordFillForOrder(maker.Id, fill);
                }
                candidate.Book.RemoveCompleted();
            }
        }
        return fills;
    }

    private IEnumerable<(string OutcomeSetId, OrderBook Book)> MintBooks(MarketParts incoming)
    {
        return _books
            .Select(entry => (Parts: MarketParts.TryParse(entry.Key), entry.Value))
            .Where(entry =>
                entry.Parts is not null
                && entry.Parts.ConditionId == incoming.ConditionId
                && entry.Parts.OutcomeSetId != incoming.OutcomeSetId
                && OutcomeSetComplement.AreComplements(incoming.OutcomeSetId, entry.Parts.OutcomeSetId))
            .OrderBy(entry => entry.Parts!.OutcomeSetId, StringComparer.Ordinal)
            .Select(entry => (entry.Parts!.OutcomeSetId, entry.Value));
    }

    private static Fill BuildFill(string marketId, RestingOrder taker, RestingOrder maker, long amount)
    {
        var tradeId = Guid.NewGuid();
        var quotePaymentSats = amount * maker.Price / 100;
        var fill = new Fill(
            amountSats: amount,
            executionPrice: maker.Price,
            filledAt: DateTimeOffset.UtcNow,
            id: Guid.NewGuid(),
            makerEphemeralPubkey: maker.EphemeralPubkey!,
            makerOrderId: maker.Id,
            path: MatchPath.Complementary,
            status: FillStatus.Filled,
            takerOrderId: taker.Id,
            tradeId: tradeId);
        fill.AdditionalProperties["settlementMarketId"] = marketId;
        fill.AdditionalProperties["settlementKind"] = "DirectSwap";
        fill.AdditionalProperties["outcomeFaceAmountSats"] = amount;
        fill.AdditionalProperties["quotePaymentSats"] = quotePaymentSats;
        return fill;
    }

    private static Fill BuildMintFill(
        RestingOrder taker,
        RestingOrder maker,
        long amount,
        string settlementMarketId,
        string sellerKeepOutcomeSetId,
        string sellerLockOutcomeSetId)
    {
        var tradeId = Guid.NewGuid();
        var quotePaymentSats = amount * taker.Price / 100;
        var fill = new Fill(
            amountSats: amount,
            executionPrice: taker.Price,
            filledAt: DateTimeOffset.UtcNow,
            id: Guid.NewGuid(),
            makerEphemeralPubkey: maker.EphemeralPubkey!,
            makerOrderId: maker.Id,
            path: MatchPath.Mint,
            status: FillStatus.Filled,
            takerOrderId: taker.Id,
            tradeId: tradeId);
        fill.AdditionalProperties["settlementMarketId"] = settlementMarketId;
        fill.AdditionalProperties["settlementKind"] = "Mint";
        fill.AdditionalProperties["outcomeFaceAmountSats"] = amount;
        fill.AdditionalProperties["quotePaymentSats"] = quotePaymentSats;
        fill.AdditionalProperties["sellerKeepOutcomeSetId"] = sellerKeepOutcomeSetId;
        fill.AdditionalProperties["sellerLockOutcomeSetId"] = sellerLockOutcomeSetId;
        return fill;
    }

    private static string DeriveStatus(long requested, long remaining, TimeInForce tif, bool anyFills)
    {
        if (remaining == 0) return "filled";
        if (anyFills) return "partially_filled";
        return tif is TimeInForce.FAK or TimeInForce.FOK ? "cancelled" : "resting";
    }
}

/// <summary>
/// Per-market mutable state: live resting orders plus a completed-order index
/// so <c>GET /orders/{id}</c> works after the order is fully filled or
/// cancelled. Always accessed under the manager's lock.
/// </summary>
internal sealed class OrderBook
{
    private const int RetainedOrderIndexLimit = 1000;

    public OrderBook(string marketId) => MarketId = marketId;

    public string MarketId { get; }

    private readonly List<RestingOrder> _resting = [];
    private readonly Dictionary<Guid, CompletedOrder> _completed = [];
    private readonly Queue<Guid> _completedOrderRetention = [];
    /// <summary>
    /// Fills indexed by both the maker and taker orderId so a later
    /// <c>GET /orders/{id}</c> can surface the per-fill <c>tradeId</c>.
    /// The frontend's <c>usePendingTradesPoller</c> reads the tradeId off
    /// this collection to wake the atomic-swap driver — without this index
    /// the recovery path (close + reopen) has no way to discover that a
    /// match has occurred.
    /// </summary>
    private readonly Dictionary<Guid, List<Fill>> _fillsByOrderId = [];
    private readonly Queue<Guid> _fillOrderRetention = [];

    public void AddResting(RestingOrder order) => _resting.Add(order);

    /// <summary>
    /// Record a fill against both sides of the match. Called from the
    /// matching loop while the book lock is held.
    /// </summary>
    public void RecordFill(Guid takerOrderId, Guid makerOrderId, Fill fill)
    {
        GetOrCreateFills(takerOrderId).Add(fill);
        GetOrCreateFills(makerOrderId).Add(fill);
    }

    public void RecordFillForOrder(Guid orderId, Fill fill)
        => GetOrCreateFills(orderId).Add(fill);

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

    public IEnumerable<RestingOrder> MintBuyMakers(
        RestingOrder incoming,
        string outcomeSetId)
    {
        return _resting
            .Where(o =>
                o.Side == OrderSide.Buy &&
                o.OutcomeId == outcomeSetId &&
                o.RemainingSats > 0 &&
                o.Price + incoming.Price >= 100)
            .OrderByDescending(o => o.Price)
            .ThenBy(o => o.PlacedAt);
    }

    public void RemoveCompleted()
    {
        for (var i = _resting.Count - 1; i >= 0; i--)
        {
            var o = _resting[i];
            if (o.RemainingSats > 0) continue;
            RememberCompleted(o.Id, new CompletedOrder(o, "filled"));
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
        => RememberCompleted(taker.Id, new CompletedOrder(taker, status));

    public bool Cancel(Guid orderId)
    {
        for (var i = 0; i < _resting.Count; i++)
        {
            if (_resting[i].Id != orderId) continue;
            RememberCompleted(orderId, new CompletedOrder(_resting[i], "cancelled"));
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

    public List<LevelDto> BuyDepthForOutcome(string outcomeId) =>
        AggregateLevels(
            _resting.Where(o => o.OutcomeId == outcomeId && o.Side == OrderSide.Buy),
            descending: true);

    private static List<LevelDto> AggregateLevels(IEnumerable<RestingOrder> orders, bool descending)
    {
        var grouped = orders
            .GroupBy(o => o.Price)
            .Select(g => new LevelDto(g.Sum(o => o.RemainingSats), g.Key));
        return (descending ? grouped.OrderByDescending(l => l.Price) : grouped.OrderBy(l => l.Price))
            .ToList();
    }

    private List<Fill> GetOrCreateFills(Guid orderId)
    {
        if (_fillsByOrderId.TryGetValue(orderId, out var fills))
            return fills;

        fills = [];
        _fillsByOrderId[orderId] = fills;
        _fillOrderRetention.Enqueue(orderId);
        while (_fillsByOrderId.Count > RetainedOrderIndexLimit &&
               _fillOrderRetention.TryDequeue(out var oldest))
        {
            _fillsByOrderId.Remove(oldest);
        }
        return fills;
    }

    private void RememberCompleted(Guid orderId, CompletedOrder completed)
    {
        var isNew = !_completed.ContainsKey(orderId);
        _completed[orderId] = completed;
        if (!isNew) return;

        _completedOrderRetention.Enqueue(orderId);
        while (_completed.Count > RetainedOrderIndexLimit &&
               _completedOrderRetention.TryDequeue(out var oldest))
        {
            _completed.Remove(oldest);
            _fillsByOrderId.Remove(oldest);
        }
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

internal sealed record MarketParts(string ConditionId, string OutcomeSetId)
{
    public static MarketParts? TryParse(string marketId)
    {
        var index = marketId.LastIndexOf('-');
        if (index <= 0 || index == marketId.Length - 1) return null;
        return new MarketParts(marketId[..index], marketId[(index + 1)..]);
    }
}

internal static class OutcomeSetComplement
{
    public static bool AreComplements(string leftOutcomeSetId, string rightOutcomeSetId)
    {
        if (IsBinaryComplement(leftOutcomeSetId, rightOutcomeSetId)) return true;

        var left = ParseOutcomeSet(leftOutcomeSetId);
        var right = ParseOutcomeSet(rightOutcomeSetId);
        if (left.Count == 0 || right.Count == 0) return false;
        if (left.Count == 1 && right.Count == 1) return false;
        return !left.Overlaps(right);
    }

    private static bool IsBinaryComplement(string leftOutcomeSetId, string rightOutcomeSetId)
    {
        var left = leftOutcomeSetId.ToUpperInvariant();
        var right = rightOutcomeSetId.ToUpperInvariant();
        return (left, right) switch
        {
            ("YES", "NO") => true,
            ("NO", "YES") => true,
            _ => false
        };
    }

    private static HashSet<string> ParseOutcomeSet(string outcomeSetId) =>
        outcomeSetId
            .Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToHashSet(StringComparer.Ordinal);
}

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
