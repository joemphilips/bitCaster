using Microsoft.AspNetCore.SignalR;

namespace BitCaster.InMemoryMatchingEngine.Hubs;

public class MarketHub : Hub
{
    private readonly InMemoryOrderBookManager _bookManager;

    public MarketHub(InMemoryOrderBookManager bookManager) => _bookManager = bookManager;

    public async Task JoinMarket(string marketId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, marketId);
        await Clients.Caller.SendAsync("OrderBookUpdated", _bookManager.GetSnapshot(marketId));
    }

    public async Task LeaveMarket(string marketId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, marketId);
    }
}
