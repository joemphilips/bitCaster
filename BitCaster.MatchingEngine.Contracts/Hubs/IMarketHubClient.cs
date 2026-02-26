namespace BitCaster.MatchingEngine.Contracts.Hubs;

/// <summary>
/// Strongly-typed SignalR client interface for market hub callbacks.
/// Kept in sync with specs/asyncapi.yaml.
/// </summary>
public interface IMarketHubClient
{
    Task OrderBookUpdated(OrderBookSnapshot snapshot);
}
