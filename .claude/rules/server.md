---
paths:
  - "BitCaster.MatchingEngine.Contracts/**/*"
---

# Matching Engine Public Contracts

This repository supplies the public contract library.
The matching engine is an external service.
Read the project file for its supported target frameworks.
Do not add a dependency on a private implementation repository.

```bash
dotnet build BitCaster.MatchingEngine.Contracts
```

## Data Authority

A bitCaster market's data lives in two systems.
Use the same authority in detail and list pages.

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

Paths below are relative to `BitCaster.MatchingEngine.Contracts/`.

- `specs/openapi.yaml` — public HTTP contract and DTO generation source
- `specs/asyncapi.yaml` — public asynchronous contract
- `Generated/ApiContracts.g.cs` — generated C# DTOs
- `Domain/ValueTypes.cs` and `Domain/Order.cs` — shared value types
- `Hubs/` — typed hub client interfaces

After an OpenAPI change, build the contract project.
Then run `npm run generate:api` from `bitCaster-app/` to regenerate the app
and SDK types. Do not hand-edit generated DTOs.
