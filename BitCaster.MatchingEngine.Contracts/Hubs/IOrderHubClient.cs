namespace BitCaster.MatchingEngine.Contracts.Hubs;

/// <summary>
/// Strongly-typed SignalR client interface for order hub callbacks.
/// </summary>
public interface IOrderHubClient
{
    /// <summary>
    /// Owner-filtered order lifecycle update. This callback never contains
    /// settlement capability artifacts or bearer proof material.
    /// </summary>
    Task OrderLifecycleChanged(OrderLifecycleChangedDelta delta);

    /// <summary>
    /// Owner-filtered settlement-group lifecycle update for one affected order.
    /// </summary>
    Task SettlementGroupStateChanged(SettlementGroupStateChangedDelta delta);
}

public sealed record OrderLifecycleChangedDelta(
    Guid OrderId,
    string MarketId,
    OrderLifecycleStatus Status,
    long RemainingAmountSubunits,
    BaseAsset BaseAsset,
    string CollateralUnit,
    int Divisibility,
    SettlementGroupSummary? ActiveSettlementGroup);

public sealed record SettlementGroupStateChangedDelta(
    Guid OrderId,
    string MarketId,
    SettlementGroupSummary SettlementGroup);
