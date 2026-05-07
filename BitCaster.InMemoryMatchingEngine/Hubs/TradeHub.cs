using BitCaster.MatchingEngine.Contracts.Hubs;
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

    public TradeHub(InMemoryTradeRegistry trades) => _trades = trades;

    /// <summary>
    /// Join the SignalR group for <paramref name="tradeId"/> and replay
    /// <c>TradeCreated</c> to the caller. The mock has no auth aggregate —
    /// it returns the cached registry record verbatim, or a HubException
    /// indistinguishable from "not authorised" when the trade is unknown.
    /// </summary>
    public async Task JoinTrade(Guid tradeId)
    {
        var record = _trades.TryGet(tradeId)
            ?? throw new HubException("Not authorised to join this trade");

        await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(tradeId));
        await Clients.Caller.TradeCreated(
            tradeId,
            record.SellerPubkey,
            record.BuyerPubkey,
            record.SellerLocktime,
            record.BuyerLocktime);
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

        if (messageType == "settlement-complete")
        {
            await HandleSettlementComplete(tradeId, caller, group);
            return;
        }

        await Clients.OthersInGroup(group).SwapMessageReceived(tradeId, messageType, ciphertext);

        // Flip to Settling once the buyer has answered with their locked proofs
        // — both clients then run their claim branch in `useTradeSettlement`.
        if (messageType == "locked-proofs-buyer")
            await Clients.Group(group).TradeStateChanged(tradeId, "Settling");
    }

    private async Task HandleSettlementComplete(Guid tradeId, string caller, string group)
    {
        var trade = _trades.TryGet(tradeId);
        if (trade is null) return;
        var bothConfirmed = _trades.ConfirmAndMaybeFinalize(tradeId, caller);
        if (bothConfirmed)
            await Clients.Group(group).TradeStateChanged(tradeId, "Confirmed");
    }

    private string NipPubkeyOrAnonymous()
        => Nip98PubkeyExtractor.TryExtract(Context.GetHttpContext()?.Request!) ?? "anonymous";

    internal static string GroupName(Guid tradeId) => $"trade-{tradeId}";
}
