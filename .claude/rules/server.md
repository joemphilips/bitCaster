---
paths:
  - "BitCaster.MatchingEngine.Contracts/**/*"
  - "BitCaster.InMemoryMatchingEngine/**/*"
---

# Matching Engine — Contracts + InMemoryMatchingEngine

The matching engine is split into three parts:

1. **BitCaster.MatchingEngine.Contracts** — shared class library (`Microsoft.NET.Sdk`, net10.0): DTOs, enums, request/response records. Used by the in-memory stub and the real server.
2. **BitCaster.InMemoryMatchingEngine** — ASP.NET minimal API (`Microsoft.NET.Sdk.Web`, net10.0). Stores orders in-memory, **no matching** — every submitted order returns `"resting"` and never produces fills. Used for frontend dev / E2E. (Could change in the future.)
3. **Real CLOB engine** — private repo one level above (`bitCaster-matching-engine`); references Contracts via submodule. Price-time priority, direct + complementary matching.

```bash
dotnet build BitCaster.MatchingEngine.Contracts
dotnet build BitCaster.InMemoryMatchingEngine
dotnet run --project BitCaster.InMemoryMatchingEngine   # port 5000
```

## Source-of-truth split (ADR-009 + Amendment 2026-05-04)

A bitCaster market's data lives in two systems. The detail and list pages MUST honour the same split — drift between them was the root cause of the P7 §`/markets/{id}` regression.

| Field | Authority | Reachable via |
|---|---|---|
| Market existence | mintd | `GET /v1/conditions` |
| Outcome metadata (announcement, attested outcome, deadline) | mintd | `GET /v1/conditions` |
| Lifecycle (`state: open|closed`) | engine | `GET /api/v1/markets/query?ids=<conditionId>` |
| Volume / liquidity / last-traded price | engine | `GET /api/v1/markets/query` (catalogue) + `/api/v1/{marketId}/metadata` (per-outcome detail) |
| Thumbnail (`imageUrl`) | engine | `GET /api/v1/markets/query` returns `thumbnailUrl`; `GET /api/v1/{conditionId}/thumbnail` serves the bytes |

Frontend rule of thumb: never derive lifecycle from mintd's `attestation.status`. Mintd's attestation is reduced to outcome metadata, normalised once at ingress via `lib/mintdIngress.ts`. See `.claude/skills/bitcaster-coding-guideline/SKILL.md` for the cross-language enum discipline that enforces this.

## Market ID & Order Book

The order book is **per outcome**, not per condition — each outcome of an N-way condition gets its own independent binary book.

- `marketId = "{conditionId}-{outcomeName}"` (e.g. `deadbeef…abc-Alice`)
- Outcomes `[Alice, Bob, Carol, David]` → 4 markets; each trades the outcome token against its complement (`"Not Alice"` = `Bob|Carol|David`).
- Compound tokens (e.g. `Alice|Bob`) are **not tradeable** — a `marketId` containing `|` is invalid.
- `Buy` = buy the named outcome token; `Sell` = sell it (= buy complement).
- Because the outcome is encoded in `marketId`, `SubmitOrderRequest` has **no** `outcomeId`, and `OrderBookSnapshot` is flat (bids/asks/spread — no per-outcome dictionary).

## Key Files

**Contracts**
- `Domain/Order.cs` — `Order`, `OrderSide`, `OrderType`
- `Domain/Fill.cs` — `Fill`, `MatchPath`, `MatchResult`
- `Domain/Snapshots.cs` — `OrderBookSnapshot`, `LevelDto`
- `Endpoints/OrderContracts.cs` — `SubmitOrderRequest`, `SubmitOrderResponse`

**InMemoryMatchingEngine**
- `InMemoryOrderBookManager.cs` — in-memory storage (no matching)
- `Hubs/MarketHub.cs` — SignalR hub at `/hubs/market` (join/leave market groups)
- `Endpoints/OrderEndpoints.cs` — `POST /api/v1/orders`, `DELETE /api/v1/orders/{id}`
- `Endpoints/BookEndpoints.cs` — `GET /api/v1/markets/{marketId}/orderbook`
