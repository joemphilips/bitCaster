namespace BitCaster.MatchingEngine.Contracts.Hubs;

/// <summary>
/// Strongly-typed SignalR client interface for market hub callbacks.
/// Kept in sync with specs/asyncapi.yaml.
/// </summary>
public interface IMarketHubClient
{
    Task OrderBookUpdated(OrderBookSnapshot snapshot);

    /// <summary>
    /// Pushed to every per-outcome market group of a condition when its
    /// lifecycle state changes (e.g. open -> closed on oracle/deadline close).
    /// </summary>
    Task MarketStatusChanged(MarketStatusChanged status);
}
