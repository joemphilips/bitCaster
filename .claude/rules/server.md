# BitCaster.Server (Matching Engine)

ASP.NET minimal API (`net10.0`) with SignalR. Two responsibilities only:

1. **CLOB matching engine** — in-memory order books with price-time priority, direct + complementary matching
2. **Real-time price feed** — SignalR hub broadcasting orderbook updates and trade executions

```bash
cd BitCaster.Server
dotnet build                  # compile
dotnet run                    # start server
```

## Key Files

- `Domain/OrderBook.cs` — in-memory order book per market (keyed by condition_id)
- `Domain/MatchingEngine.cs` — pure static matching logic (direct + complementary paths)
- `Hubs/MarketHub.cs` — SignalR hub at `/hubs/market` (join/leave market groups)
- `Endpoints/OrderEndpoints.cs` — `POST /api/v1/orders`, `DELETE /api/v1/orders/{id}`
- `Endpoints/BookEndpoints.cs` — `GET /api/v1/markets/{marketId}/orderbook`

Order books are ephemeral (in-memory). The mint is the source of truth for token state.
