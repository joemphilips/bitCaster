using System.Collections.Concurrent;

namespace BitCaster.InMemoryMatchingEngine;

/// <summary>
/// Per-trade bookkeeping for the mock's <c>TradeHub</c>. Tracks counterparty
/// pubkeys + locktimes so a late-joining client can be replayed
/// <c>TradeCreated</c> on <c>JoinTrade</c>, and counts <c>settlement-complete</c>
/// confirmations so the hub can flip the trade to <c>Confirmed</c> after both
/// sides report they have swapped at the mint.
///
/// <para>
/// Mock-only: this is a byte relay for frontend dev/E2E and does not verify
/// identities.
/// </para>
/// </summary>
public class InMemoryTradeRegistry
{
    private readonly ConcurrentDictionary<Guid, TradeRecord> _trades = new();
    private readonly ConcurrentDictionary<Guid, List<SwapMessageRecord>> _messages = new();

    public sealed record TradeRecord(
        Guid TradeId,
        string SellerPubkey,
        string BuyerPubkey,
        DateTimeOffset SellerLocktime,
        DateTimeOffset BuyerLocktime,
        string MarketId,
        long FillAmountSubunits,
        long? OutcomeFaceAmountSubunits,
        long? QuotePaymentSubunits,
        string? SettlementKind,
        string? SellerKeepOutcomeSetId,
        string? SellerLockOutcomeSetId,
        string? BaseAsset,
        int? Divisibility,
        string? TokenSide,
        HashSet<string> ConfirmedBy,
        bool Confirmed);

    public sealed record SwapMessageRecord(
        string SenderPubkey,
        string MessageType,
        string Ciphertext);

    /// <summary>
    /// Register a freshly-matched trade. Sets asymmetric locktimes that match
    /// the protocol invariant <c>T_YES &gt; T_sat + Δ</c> — the seller's
    /// (Alice's) YES-proof locktime is LONGER than the buyer's (Bob's) sat
    /// locktime, so that Bob has time to extract <c>t</c> from Alice's mint
    /// spend before his own refund window opens. See
    /// bitCaster/bitCaster-doc/src/content/docs/technical/protocol/atomic-swap.md
    /// §"Locktime Constraints". The 1h gap is arbitrary in the mock, but the
    /// ordering must match the public protocol shape.
    /// </summary>
    public TradeRecord Register(
        Guid tradeId,
        string sellerPubkey,
        string buyerPubkey,
        string marketId,
        long fillAmountSubunits,
        long? outcomeFaceAmountSubunits = null,
        long? quotePaymentSubunits = null,
        string? settlementKind = null,
        string? sellerKeepOutcomeSetId = null,
        string? sellerLockOutcomeSetId = null,
        string? baseAsset = null,
        int? divisibility = null,
        string? tokenSide = null)
    {
        var now = DateTimeOffset.UtcNow;
        var record = new TradeRecord(
            tradeId, sellerPubkey, buyerPubkey,
            SellerLocktime: now.AddHours(2),
            BuyerLocktime: now.AddHours(1),
            MarketId: marketId,
            FillAmountSubunits: fillAmountSubunits,
            OutcomeFaceAmountSubunits: outcomeFaceAmountSubunits,
            QuotePaymentSubunits: quotePaymentSubunits,
            SettlementKind: settlementKind,
            SellerKeepOutcomeSetId: sellerKeepOutcomeSetId,
            SellerLockOutcomeSetId: sellerLockOutcomeSetId,
            BaseAsset: baseAsset,
            Divisibility: divisibility,
            TokenSide: tokenSide,
            ConfirmedBy: [],
            Confirmed: false);
        return _trades.GetOrAdd(tradeId, record);
    }

    public TradeRecord? TryGet(Guid tradeId)
        => _trades.TryGetValue(tradeId, out var r) ? r : null;

    public void RecordSwapMessage(Guid tradeId, string senderPubkey, string messageType, string ciphertext)
    {
        if (!_trades.ContainsKey(tradeId)) return;
        var messages = _messages.GetOrAdd(tradeId, _ => []);
        lock (messages)
        {
            messages.Add(new SwapMessageRecord(senderPubkey, messageType, ciphertext));
        }
    }

    public IReadOnlyList<SwapMessageRecord> GetSwapMessages(Guid tradeId)
    {
        if (!_messages.TryGetValue(tradeId, out var messages)) return [];
        lock (messages)
        {
            return messages.ToArray();
        }
    }

    /// <summary>
    /// Record a <c>settlement-complete</c> confirmation from one caller.
    /// Returns true when two distinct mock-auth callers have confirmed so the
    /// hub knows whether to broadcast <c>TradeStateChanged → Confirmed</c>.
    /// The mock authenticates hub callers by NIP-98 identity while trades are
    /// keyed by ephemeral order pubkeys, so it cannot compare directly to
    /// <see cref="TradeRecord.SellerPubkey"/> / <see cref="TradeRecord.BuyerPubkey"/>.
    /// Production performs owner authorization against engine state.
    /// </summary>
    public bool ConfirmAndMaybeFinalize(Guid tradeId, string fromPubkey)
    {
        if (!_trades.TryGetValue(tradeId, out var existing)) return false;
        lock (existing.ConfirmedBy)
        {
            if (existing.Confirmed) return false;
            existing.ConfirmedBy.Add(fromPubkey);
            if (existing.ConfirmedBy.Count < 2) return false;

            _trades[tradeId] = existing with { Confirmed = true };
            return true;
        }
    }
}
