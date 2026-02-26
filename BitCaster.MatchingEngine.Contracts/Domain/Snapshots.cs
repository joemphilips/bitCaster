namespace BitCaster.MatchingEngine.Contracts.Domain;

/// <summary>
/// Point-in-time snapshot of an entire market's order book, keyed by outcome.
/// Broadcast via SignalR after each order book mutation.
/// </summary>
/// <param name="MarketId">The condition_id of the market.</param>
/// <param name="Outcomes">Per-outcome depth data, keyed by outcome ID (e.g. "YES", "NO").</param>
public record OrderBookSnapshot(string MarketId, Dictionary<string, OutcomeSnapshot> Outcomes);

/// <summary>
/// Aggregated bid/ask depth for a single outcome within a market.
/// </summary>
/// <param name="Bids">Buy-side levels sorted by price descending (best bid first).</param>
/// <param name="Asks">Sell-side levels sorted by price ascending (best ask first).</param>
/// <param name="Spread">Difference between best ask and best bid prices. Null if either side is empty.</param>
public record OutcomeSnapshot(LevelDto[] Bids, LevelDto[] Asks, int? Spread);

/// <summary>
/// A single price level in the order book depth.
/// </summary>
/// <param name="Price">Probability price of this level.</param>
/// <param name="Amount">Total resting satoshi amount at this price level.</param>
public record LevelDto(Probability Price, Sats Amount);
