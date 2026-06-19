namespace BitCaster.MatchingEngine.Contracts.Hubs;

/// <summary>
/// Strongly-typed SignalR client interface for trade hub callbacks.
/// All cryptographic operations happen client-side; the engine relays opaque ciphertexts.
/// </summary>
public interface ITradeHubClient
{
    /// <summary>Relayed to the counterparty when a swap message arrives.</summary>
    Task SwapMessageReceived(Guid tradeId, string messageType, string ciphertext);

    /// <summary>Broadcast to both parties when the trade state transitions.</summary>
    Task TradeStateChanged(Guid tradeId, string newState);

    /// <summary>
    /// Sent to both parties immediately after a trade is created from a fill.
    /// Carries counterparty pubkeys, the engine-computed asymmetric locktimes,
    /// the market id, the legacy matched fill amount, and explicit settlement
    /// amounts when the engine supports TradeCreatedV2 semantics.
    /// </summary>
    Task TradeCreated(Guid tradeId, string sellerPubkey, string buyerPubkey,
        DateTimeOffset sellerLocktime, DateTimeOffset buyerLocktime,
        string marketId, long fillAmountSats,
        long? outcomeFaceAmountSats = null,
        long? quotePaymentSats = null,
        string? settlementKind = null,
        string? sellerKeepOutcomeSetId = null,
        string? sellerLockOutcomeSetId = null,
        string? baseAsset = null,
        int? divisibility = null,
        long? quotePaymentSubunits = null,
        long? outcomeFaceAmountSubunits = null);
}
