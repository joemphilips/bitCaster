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
| `liquiditySubunits` | `int64` | Total face amount of currently resting orders across the market's order books, denominated in the market collateral subunit: msat for sat-display markets, cents (`usd`) for USD markets. |
| `traderCount` | `int32` | Number of distinct traders that have settled a trade in this market. |
| `volumeLifetimeSubunits` | `int64` | Cumulative settled collateral face amount of all fills in the market's history, in collateral subunits. |

The response also includes `volume24hSubunits` and `volume30dSubunits` for rolling-volume views and sort dimensions. Clients should use `volumeLifetimeSubunits`, `liquiditySubunits`, and `traderCount` when rendering the visible Volume, Liquidity, and Traders metrics for a market.

Other public market summaries use the same naming rule: price-history points expose `volumeSubunits`, market metadata snapshots expose `totalVolumeSubunits` and `totalLiquiditySubunits`, and liquidity snapshots expose `restingOrderLiquiditySubunits`, `completeSetLiquiditySubunits`, and `totalLiquiditySubunits`. The deprecated `liquiditySats` create-market metadata field is still accepted for compatibility, but market-maker funding is collected after creation and create requests should send `0`.

## Real-time lifecycle updates

A market's lifecycle state can change while a client is viewing it. A client subscribed to a market over the real-time feed receives a `MarketStatusChanged` push when the condition transitions state — for example from `open` to `closed` once an oracle attestation lands or the resolution deadline passes. The message carries the `conditionId`, the new `state` (`open` or `closed`), the `closedAt` timestamp once the market has closed, and the winning `finalOutcome` when one has been attested. The push reaches any client joined to one of the condition's per-outcome markets.

The live push is a best-effort detail-page enhancement while the client is joined to that market's per-outcome group. Discovery/list pages should not join every visible market just to receive lifecycle pushes. The catalogue's `state` field remains the source of truth: a client that connects, reconnects, boots, or returns from the background after the transition reads the current state from `/api/v1/markets/query` rather than relying on having been connected when the change was pushed. Clients should use boot/visibility reconciliation as the correctness fallback, not background polling.
