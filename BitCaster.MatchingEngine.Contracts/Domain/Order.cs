namespace BitCaster.MatchingEngine.Contracts.Domain;

/// <summary>
/// A resting or incoming order on the matching engine's order book.
/// This is an internal domain type — not part of the REST API wire format.
/// </summary>
/// <param name="Id">Unique identifier assigned by the matching engine.</param>
/// <param name="MarketId">The market ID in the format "{conditionId}-{outcomeName}" (e.g. "deadbeef…abc-Alice").</param>
/// <param name="Side">Whether this is a buy or sell order.</param>
/// <param name="Type">Limit (rests on book) or market (immediate-or-cancel).</param>
/// <param name="Price">Probability price in [1,99]. Null for market orders.</param>
/// <param name="AmountSats">Total order size in satoshis. Must be positive.</param>
/// <param name="UserId">Opaque user identifier (e.g. Nostr pubkey hex).</param>
/// <param name="PlacedAt">Timestamp when the order was submitted.</param>
public record Order(
    Guid Id,
    string MarketId,
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

/// <summary>
/// Result of attempting to match an incoming order against the book.
/// Internal type — not part of the REST API.
/// </summary>
/// <param name="Fills">Zero or more fills produced by the match attempt.</param>
/// <param name="RemainingSats">Unfilled satoshi amount after all matches.</param>
public record MatchResult(List<Fill> Fills, Sats RemainingSats);
