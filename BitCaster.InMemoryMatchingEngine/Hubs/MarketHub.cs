using BitCaster.MatchingEngine.Contracts.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace BitCaster.InMemoryMatchingEngine.Hubs;

public class MarketHub : Hub<IMarketHubClient>
{
    private readonly InMemoryOrderBookManager _bookManager;

    public MarketHub(InMemoryOrderBookManager bookManager) => _bookManager = bookManager;

    public async Task JoinMarket(string marketId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, marketId);
        await Clients.Caller.OrderBookUpdated(_bookManager.GetSnapshot(marketId));
    }

    public async Task LeaveMarket(string marketId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, marketId);
    }
}
