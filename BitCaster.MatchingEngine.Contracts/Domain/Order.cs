namespace BitCaster.MatchingEngine.Contracts.Domain;

/// <summary>
/// A resting or incoming order on the matching engine's order book.
/// </summary>
/// <param name="Id">Unique identifier assigned by the matching engine.</param>
/// <param name="MarketId">The condition_id of the market this order targets.</param>
/// <param name="OutcomeId">The outcome within the market (e.g. "YES", "NO").</param>
/// <param name="Side">Whether this is a buy or sell order.</param>
/// <param name="Type">Limit (rests on book) or market (immediate-or-cancel).</param>
/// <param name="Price">Probability price in [1,99]. Null for market orders.</param>
/// <param name="AmountSats">Total order size in satoshis. Must be positive.</param>
/// <param name="UserId">Opaque user identifier (e.g. Nostr pubkey hex).</param>
/// <param name="PlacedAt">Timestamp when the order was submitted.</param>
public record Order(
    Guid Id,
    string MarketId,
    string OutcomeId,
    OrderSide Side,
    OrderType Type,
    Probability? Price,
    Sats AmountSats,
    string UserId,
    DateTimeOffset PlacedAt)
{
    /// <summary>
    /// Unfilled portion of the order. Starts equal to <see cref="AmountSats"/>
    /// and decreases as fills occur. Zero means fully filled.
    /// </summary>
    public Sats RemainingAmountSats { get; set; } = AmountSats;
}

/// <summary>Direction of an order relative to the outcome token.</summary>
public enum OrderSide
{
    /// <summary>Buying outcome tokens (long the outcome).</summary>
    Buy,
    /// <summary>Selling outcome tokens (short the outcome).</summary>
    Sell
}

/// <summary>Execution semantics of an order.</summary>
public enum OrderType
{
    /// <summary>Rests on the book at the specified price until filled or cancelled.</summary>
    Limit,
    /// <summary>Executes immediately at best available price; unfilled remainder is cancelled.</summary>
    Market
}
