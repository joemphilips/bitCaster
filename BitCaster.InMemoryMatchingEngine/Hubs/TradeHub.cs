using BitCaster.MatchingEngine.Contracts.Hubs;
using BitCaster.InMemoryMatchingEngine.Endpoints;
using Microsoft.AspNetCore.SignalR;

namespace BitCaster.InMemoryMatchingEngine.Hubs;

/// <summary>
/// SignalR hub that relays atomic-swap protocol messages between trade
/// counterparties. Mounted at <c>/hubs/trade</c>.
///
/// <para>
/// MOCK ONLY — parses the NIP-98 token via
/// <see cref="Nip98PubkeyExtractor.TryExtract"/> to read the caller's pubkey
/// but does NOT verify the schnorr signature. Anyone can join any trade,
/// which is sufficient for two-browser-tab dev/E2E and unsafe outside the
/// mock project.
/// </para>
///
/// <para>
/// The hub exposes a tiny state machine: a trade is implicitly Matched on
/// creation (the hub broadcasts <c>TradeStateChanged → Settling</c> after the
/// final swap message lands so the frontend's settlement claim path runs),
/// and flips to <c>Confirmed</c> when both parties have sent
/// <c>settlement-complete</c>.
/// </para>
/// </summary>
public class TradeHub : Hub<ITradeHubClient>
{
    private readonly InMemoryTradeRegistry _trades;
    private readonly InMemoryOrderBookManager _orders;
    private readonly IHubContext<MarketHub, IMarketHubClient> _marketHub;
    private readonly IHubContext<MarketHub> _untypedMarketHub;

    public TradeHub(
        InMemoryTradeRegistry trades,
        InMemoryOrderBookManager orders,
        IHubContext<MarketHub, IMarketHubClient> marketHub,
        IHubContext<MarketHub> untypedMarketHub)
    {
        _trades = trades;
        _orders = orders;
        _marketHub = marketHub;
        _untypedMarketHub = untypedMarketHub;
    }

    /// <summary>
    /// Join the SignalR group for <paramref name="tradeId"/> and replay
    /// <c>TradeCreated</c> to the caller. The mock has no auth aggregate —
    /// it returns the cached registry record verbatim, or a HubException
    /// indistinguishable from "not authorised" when the trade is unknown.
    /// </summary>
    public async Task JoinTrade(Guid tradeId)
    {
        var caller = NipPubkeyOrAnonymous();
        var record = _trades.TryGet(tradeId)
            ?? throw new HubException("Not authorised to join this trade");

        await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(tradeId));
        await Clients.Caller.TradeCreated(
            tradeId,
            record.SellerPubkey,
            record.BuyerPubkey,
            record.SellerLocktime,
            record.BuyerLocktime,
            record.MarketId,
            record.FillAmountSubunits,
            record.OutcomeFaceAmountSubunits,
            record.QuotePaymentSubunits,
            record.SettlementKind,
            record.SellerKeepOutcomeSetId,
            record.SellerLockOutcomeSetId,
            record.BaseAsset,
            record.Divisibility,
            record.TokenSide);

        foreach (var message in _trades.GetSwapMessages(tradeId))
        {
            if (message.SenderPubkey == caller) continue;
            await Clients.Caller.SwapMessageReceived(
                tradeId,
                message.MessageType,
                message.Ciphertext);
        }
    }

    /// <summary>
    /// Join the per-order notification group used by the production engine to
    /// wake resting makers when a later taker creates a trade. Also replay any
    /// already-created trade ids from order status so reconnect/recovery tests
    /// exercise the same contract as the real engine.
    /// </summary>
    public async Task JoinOrder(string marketId, Guid orderId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, OrderGroupName(orderId));

        var status = _orders.GetOrderStatus(orderId);
        if (status is null || !string.Equals(status.MarketId, marketId, StringComparison.Ordinal))
            return;

        foreach (var tradeId in status.Fills
                     .Select(fill => fill.TradeId)
                     .Where(tradeId => tradeId.HasValue)
                     .Select(tradeId => tradeId!.Value)
                     .Distinct())
        {
            var record = _trades.TryGet(tradeId);
            if (record is null) continue;

            await Clients.Caller.TradeCreated(
                tradeId,
                record.SellerPubkey,
                record.BuyerPubkey,
                record.SellerLocktime,
                record.BuyerLocktime,
                record.MarketId,
                record.FillAmountSubunits,
                record.OutcomeFaceAmountSubunits,
                record.QuotePaymentSubunits,
                record.SettlementKind,
                record.SellerKeepOutcomeSetId,
                record.SellerLockOutcomeSetId,
                record.BaseAsset,
                record.Divisibility,
                record.TokenSide);
        }
    }

    /// <summary>
    /// Relay an opaque ciphertext to the counterparty. <c>settlement-complete</c>
    /// is treated as a control signal: the hub records the confirmation and,
    /// once both parties have signalled, broadcasts
    /// <c>TradeStateChanged → Confirmed</c>. Other message types are forwarded
    /// to <c>Clients.OthersInGroup</c> verbatim and trigger a one-shot
    /// <c>TradeStateChanged → Settling</c> the first time the buyer side
    /// (<c>locked-proofs-buyer</c>) lands so the settlement claim runs on
    /// both clients.
    /// </summary>
    public async Task SendSwapMessage(Guid tradeId, string messageType, string ciphertext)
    {
        var caller = NipPubkeyOrAnonymous();
        var group = GroupName(tradeId);

        if (messageType == TradeMessageTypes.SettlementComplete)
        {
            await HandleSettlementComplete(tradeId, caller, group);
            return;
        }

        await Clients.OthersInGroup(group).SwapMessageReceived(tradeId, messageType, ciphertext);
        _trades.RecordSwapMessage(tradeId, caller, messageType, ciphertext);

        // Flip to Settling once the buyer has answered with their locked proofs
        // — both clients then run their claim branch in `useTradeSettlement`.
        if (messageType == TradeMessageTypes.LockedProofsBuyer)
            await Clients.Group(group).TradeStateChanged(tradeId, "Settling");
    }

    private async Task HandleSettlementComplete(Guid tradeId, string caller, string group)
    {
        var trade = _trades.TryGet(tradeId);
        if (trade is null) return;
        var bothConfirmed = _trades.ConfirmAndMaybeFinalize(tradeId, caller);
        if (bothConfirmed)
        {
            await Clients.Group(group).TradeStateChanged(tradeId, "Confirmed");
            var affectedMarketIds = AffectedPublicMarketIds(trade);
            foreach (var marketId in affectedMarketIds)
            {
                await _marketHub.Clients.Group(marketId)
                    .OrderBookUpdated(_orders.GetSnapshot(marketId));
            }

            foreach (var marketId in affectedMarketIds)
            {
                await _untypedMarketHub.Clients.Group(marketId).SendAsync("TradeExecuted", new
                {
                    TradeId = trade.TradeId,
                    MarketId = marketId,
                    ExecutionPrice = ExecutionPriceFor(trade),
                    AmountSubunits = trade.FillAmountSubunits,
                    FaceAmountSubunits = trade.FillAmountSubunits,
                    Side = string.Empty,
                    MatchedAt = DateTimeOffset.UtcNow,
                    Timestamp = DateTimeOffset.UtcNow
                });
            }
        }
    }

    internal static IReadOnlyList<string> AffectedPublicMarketIds(InMemoryTradeRegistry.TradeRecord trade)
    {
        var marketIds = new HashSet<string>(StringComparer.Ordinal) { trade.MarketId };
        var parts = MarketParts.TryParse(trade.MarketId);
        if (parts is null) return marketIds.Order(StringComparer.Ordinal).ToArray();

        var outcomes = MarketEndpoints.TryGetRegisteredOutcomes(parts.ConditionId) ?? [];
        AddPublicMarketIds(marketIds, parts.ConditionId, trade.SellerKeepOutcomeSetId, outcomes);
        AddPublicMarketIds(marketIds, parts.ConditionId, trade.SellerLockOutcomeSetId, outcomes);
        return marketIds.Order(StringComparer.Ordinal).ToArray();
    }

    private static void AddPublicMarketIds(
        HashSet<string> marketIds,
        string conditionId,
        string? outcomeSetId,
        IReadOnlyList<string> outcomes)
    {
        if (string.IsNullOrWhiteSpace(outcomeSetId) || outcomes.Count == 0) return;

        var normalizedUniverse = outcomes.Order(StringComparer.Ordinal).ToArray();
        var selected = outcomeSetId
            .Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Order(StringComparer.Ordinal)
            .ToHashSet(StringComparer.Ordinal);
        if (selected.Count == 1)
            marketIds.Add($"{conditionId}-{selected.Single()}");

        var complement = normalizedUniverse.Where(outcome => !selected.Contains(outcome)).ToArray();
        if (complement.Length == 1)
            marketIds.Add($"{conditionId}-{complement[0]}");
    }

    private static int ExecutionPriceFor(InMemoryTradeRegistry.TradeRecord trade)
    {
        if (trade.QuotePaymentSubunits is > 0 &&
            trade.OutcomeFaceAmountSubunits is > 0 &&
            trade.Divisibility is > 0)
        {
            return (int)Math.Round(
                (decimal)trade.QuotePaymentSubunits.Value * trade.Divisibility.Value /
                trade.OutcomeFaceAmountSubunits.Value,
                MidpointRounding.AwayFromZero);
        }

        return 0;
    }

    private string NipPubkeyOrAnonymous()
        => Nip98PubkeyExtractor.TryExtract(Context.GetHttpContext()?.Request!)
           ?? $"connection:{Context.ConnectionId}";

    internal static string GroupName(Guid tradeId) => $"trade-{tradeId}";

    internal static string OrderGroupName(Guid orderId) => $"order-{orderId}";
}
