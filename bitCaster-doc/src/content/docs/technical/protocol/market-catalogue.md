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
| `liquiditySats` | `int64` | Total face amount in sats of currently resting orders across the market's order books. |
| `traderCount` | `int32` | Number of distinct traders that have settled a trade in this market. |
| `volumeLifetimeSats` | `int64` | Cumulative settled collateral face amount of all fills in the market's history. |

The response also includes `volume24hSats` and `volume30dSats` for rolling-volume views and sort dimensions. Clients should use `volumeLifetimeSats`, `liquiditySats`, and `traderCount` when rendering the visible Volume, Liquidity, and Traders metrics for a market.
