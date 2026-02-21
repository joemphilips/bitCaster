using BitCaster.Server.Domain;
using Microsoft.AspNetCore.SignalR;

namespace BitCaster.Server.Hubs;

public class MarketHub : Hub
{
    private readonly OrderBookManager _bookManager;

    public MarketHub(OrderBookManager bookManager) => _bookManager = bookManager;

    public async Task JoinMarket(string marketId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, marketId);

        var book = _bookManager.Get(marketId);
        if (book is not null)
        {
            await Clients.Caller.SendAsync("OrderBookUpdated", book.GetSnapshot());
        }
    }

    public async Task LeaveMarket(string marketId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, marketId);
    }
}
