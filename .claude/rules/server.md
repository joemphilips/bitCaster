---
paths:
  - "BitCaster.MatchingEngine.Contracts/**/*"
  - "BitCaster.InMemoryMatchingEngine/**/*"
---

# BitCaster.MatchingEngine.Contracts + InMemoryMatchingEngine

The matching engine is split into three parts:

1. **BitCaster.MatchingEngine.Contracts** — shared class library (`Microsoft.NET.Sdk`, net10.0) with DTOs, enums, and request/response records used by both the in-memory and real server
2. **BitCaster.InMemoryMatchingEngine** — ASP.NET minimal API (`Microsoft.NET.Sdk.Web`, net10.0) that stores orders in-memory but performs **no matching**. Used for frontend development and E2E testing.
3. **Private repo** (`~/working/src/cashu/bitCaster-matching-engine`) — real CLOB matching engine with price-time priority, direct + complementary matching. References Contracts via submodule.

```bash
cd BitCaster.MatchingEngine.Contracts
dotnet build                  # compile contracts

cd BitCaster.InMemoryMatchingEngine
dotnet build                  # compile in-memory server
dotnet run                    # start on port 5000
```

## BitCaster.MatchingEngine.Contracts Key Files

- `Domain/Order.cs` — `Order` record, `OrderSide` enum, `OrderType` enum
- `Domain/Fill.cs` — `Fill` record, `MatchPath` enum, `MatchResult` record
- `Domain/Snapshots.cs` — `OrderBookSnapshot`, `LevelDto`
- `Endpoints/OrderContracts.cs` — `SubmitOrderRequest`, `SubmitOrderResponse`

## BitCaster.InMemoryMatchingEngine Key Files

- `InMemoryOrderBookManager.cs` — in-memory order storage (no matching logic)
- `Hubs/MarketHub.cs` — SignalR hub at `/hubs/market` (join/leave market groups)
- `Endpoints/OrderEndpoints.cs` — `POST /api/v1/orders`, `DELETE /api/v1/orders/{id}`
- `Endpoints/BookEndpoints.cs` — `GET /api/v1/markets/{marketId}/orderbook`

The in-memory server always returns `"resting"` status for submitted orders and never produces fills. But we might need to change this in a future.

## Market ID & Order Book

The order book is **per outcome**, not per condition. Each outcome of a condition gets its own independent binary order book.

- `marketId = "{conditionId}-{outcomeName}"` (e.g. `"deadbeef…abc-Alice"`)
- A condition with N outcomes → N independent binary order books
- Example: outcomes `["Alice", "Bob", "Carol", "David"]` → 4 markets: `{cid}-Alice`, `{cid}-Bob`, `{cid}-Carol`, `{cid}-David`
- Each market trades exactly 2 token types: the **outcome token** and its **complement** (e.g. "Alice" and "Not Alice", where "Not Alice" represents "Bob|Carol|David")
- Compound tokens (e.g. "Alice|Bob") are **not tradeable** — a `marketId` containing `|` is invalid
- `Buy` = buy the named outcome token; `Sell` = sell the named outcome token (equivalently, buy the complement)

Because the outcome is encoded in `marketId`, `SubmitOrderRequest` does **not** have an `outcomeId` field, and `OrderBookSnapshot` is flat (bids/asks/spread directly, no per-outcome dictionary).

