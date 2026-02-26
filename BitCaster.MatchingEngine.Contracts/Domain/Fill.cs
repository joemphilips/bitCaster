namespace BitCaster.MatchingEngine.Contracts.Domain;

/// <summary>
/// A single execution that occurs when an incoming order matches a resting order.
/// </summary>
/// <param name="Id">Unique fill identifier.</param>
/// <param name="TakerOrderId">The incoming (aggressor) order that triggered this fill.</param>
/// <param name="MakerOrderId">The resting order that was matched against.</param>
/// <param name="AmountSats">Number of satoshis exchanged in this fill.</param>
/// <param name="ExecutionPrice">The probability price at which this fill occurred.</param>
/// <param name="Path">Whether this was a direct or complementary match.</param>
/// <param name="FilledAt">Timestamp when this fill was executed.</param>
public record Fill(
    Guid Id,
    Guid TakerOrderId,
    Guid MakerOrderId,
    Sats AmountSats,
    Probability ExecutionPrice,
    MatchPath Path,
    DateTimeOffset FilledAt);

/// <summary>How two orders were matched together.</summary>
public enum MatchPath
{
    /// <summary>
    /// Standard counterparty match: a buy matched against a sell for the same outcome
    /// (e.g. Buy YES vs Sell YES).
    /// </summary>
    Direct,

    /// <summary>
    /// Complementary match: a buy on one outcome matched against a buy on the
    /// opposing outcome (e.g. Buy YES @ P matched with Buy NO @ Q where P + Q >= 100),
    /// forming a complete set that the mint can settle.
    /// </summary>
    Complementary
}

/// <summary>
/// Result of attempting to match an incoming order against the book.
/// </summary>
/// <param name="Fills">Zero or more fills produced by the match attempt.</param>
/// <param name="RemainingSats">Unfilled satoshi amount after all matches.</param>
public record MatchResult(List<Fill> Fills, Sats RemainingSats);
