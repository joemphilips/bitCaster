---
title: Market Catalogue API
description: "Public fields returned by the /api/v1/markets/query market catalogue endpoint."
sidebar:
  order: 4
---

The `/api/v1/markets/query` endpoint returns the public market catalogue used by discovery pages and search flows. Each item is a `MarketCatalogueEntry` with the market identifier, outcomes, lifecycle state, creator-supplied display metadata, category tags, and trading summary metrics.

The catalogue exposes three lifetime/display metrics:

| Field | Type | Meaning |
| --- | --- | --- |
| `liquiditySats` | `int64` | Legacy field name. Total face amount of currently resting orders across the market's order books, denominated in the market collateral's base subunits: sats for sat markets, cents for USD markets. |
| `traderCount` | `int32` | Number of distinct traders that have settled a trade in this market. |
| `volumeLifetimeSats` | `int64` | Cumulative settled collateral face amount of all fills in the market's history. |

The response also includes `volume24hSats` and `volume30dSats` for rolling-volume views and sort dimensions. The `*Sats` suffix is retained for wire compatibility; for non-sat markets these fields use the market collateral's base subunits. Clients should use `volumeLifetimeSats`, `liquiditySats`, and `traderCount` when rendering the visible Volume, Liquidity, and Traders metrics for a market.

## Real-time lifecycle updates

A market's lifecycle state can change while a client is viewing it. A client subscribed to a market over the real-time feed receives a `MarketStatusChanged` push when the condition transitions state — for example from `open` to `closed` once an oracle attestation lands or the resolution deadline passes. The message carries the `conditionId`, the new `state` (`open` or `closed`), the `closedAt` timestamp once the market has closed, and the winning `finalOutcome` when one has been attested. The push reaches any client joined to one of the condition's per-outcome markets. The catalogue's `state` field remains the source of truth: a client that connects or reconnects after the transition reads the current state from `/api/v1/markets/query` rather than relying on having been connected when the change was pushed.
