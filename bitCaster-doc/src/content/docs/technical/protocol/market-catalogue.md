---
title: Market Catalogue API
description: 'Public fields returned by the /api/v1/markets/query market catalogue endpoint.'
sidebar:
  order: 4
---

The `/api/v1/markets/query` endpoint returns the public market catalogue used by discovery pages and search flows. Each item is a `MarketCatalogueEntry` with the market identifier, outcomes, lifecycle state, creator-supplied display metadata, category tags, and trading summary metrics.

The catalogue exposes lifetime/display metrics for market cards and discovery pages:

| Field                    | Type             | Meaning                                                                                                                                                                                                                                                                                    |
| ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ammBotBudgetSubunits`   | `int64`          | Total confirmed post-creation funding after receive fees, in msat. Clients display it as **Total funding**. New confirmed payments increase it. Trades do not reduce it. It is not current order-book liquidity, remaining bot inventory, a depositor position, or a withdrawable balance. |
| `fundingRevision`        | `string \| null` | Exact event order that produced `ammBotBudgetSubunits`. It is null before the first confirmed funding payment.                                                                                                                                                                             |
| `liquiditySubunits`      | `int64`          | Total face amount of currently resting orders across the market's order books, denominated in msat.                                                                                                                                                                                        |
| `traderCount`            | `int32`          | Number of distinct traders that have settled a trade in this market.                                                                                                                                                                                                                       |
| `volumeLifetimeSubunits` | `int64`          | Cumulative settled collateral face amount of all fills in the market's history, in collateral subunits.                                                                                                                                                                                    |

The response also includes `volume24hSubunits` and `volume30dSubunits` for rolling-volume views and sorting. Use `volumeLifetimeSubunits`, `ammBotBudgetSubunits`, and `traderCount` to show Volume, Total funding, and Traders. `liquiditySubunits` summarizes resting orders. Do not label it as Total funding.

## Outcome display metadata

`MarketCatalogueEntry.outcomes` is the outcome identity list. The optional
`outcomeDetails` array adds display metadata. Each entry has an exact `name`
and may have a `color`. Match details to outcomes by exact name. Do not rely on
array position. A legacy outcome can have a name and no color. Color does not
change outcome identity or settlement.

Market creation accepts an optional `color` on each `CreateMarketOutcome`.
Use a six-digit hexadecimal value with a leading `#`. The server accepts either
letter case and returns a present color in uppercase `#RRGGBB`. Omit the field
to request a server-assigned color. `CreateMarketResponse.outcomeDetails` and
the catalogue's `outcomeDetails` expose resolved colors. Older create
responses can omit `outcomeDetails`.

## Price and valuation

The `latestConfirmedTrades` array is the public market-price authority. It
contains the bounded latest confirmed execution for each primitive outcome and
is sorted by canonical primitive outcome ID. Missing outcomes are absent. An
empty array means that no confirmed trade exists, so the market has no public
price. Clients should show `No trades yet` or an em dash. Do not use a
registration value, funding value, uniform default, or bid/ask midpoint as the
market price. A midpoint is an order-entry reference only.

Price-history points expose `volumeSubunits` and `eventOrder`.
The opaque `eventOrder` value identifies canonical trade order. Compare it with
ordinal string ordering. A greater value means a newer event, even when two
timestamps are equal. Use it when merging history and confirmed live trades.
Do not use response arrival order to choose the latest trade.

Market metadata snapshots expose
`totalVolumeSubunits` and `totalLiquiditySubunits`.
The metadata field `totalLiquiditySubunits` is always zero. It does not report
bot funding, custody, or executable order-book depth.

Market creation does not accept a funding amount. Fund the market maker after
creation through the durable Cashu delivery API. Each funding payment requires
separate approval. You can fund the same market more than once. Funding does
not create a public market price. Use `latestConfirmedTrades` for that price.

## Real-time funding updates

A client that joins a market over the real-time feed receives a
`MarketFundingUpdated` message after a funding receipt commits. The message
contains `conditionId`, `ammBotBudgetSubunits`, and `fundingRevision`. It does
not report the active LMSR parameter or order-book depth.

The push is best effort. A replay can send the same revision again. The server
also sends the current committed funding observation when a client joins or
rejoins an outcome market. Clients must keep the newest revision. An older
catalogue response must not reduce a total learned from a newer live message.
The catalogue uses null for `fundingRevision` before the first payment.

## Real-time lifecycle updates

Portfolio clients can receive confirmed-trade and lifecycle messages through
`SetPortfolioValuationSubscriptions(conditionIds)`. This condition-only
subscription does not join an order book or return a snapshot. It replaces
the connection's set of at most 200 entries. Use an empty array to unsubscribe.
Resend the set after reconnecting. Read the Portfolio API to reconcile values;
notifications are best effort and can arrive before the updated values.

The catalogue's `deadline` can be omitted or null. This means that no deadline
is available. Do not substitute `createdAt` or treat the response as incomplete.
Use `state` as the lifecycle authority, including when no deadline is available.

A market's lifecycle state can change while a client is viewing it. A client subscribed to a market over the real-time feed receives a `MarketStatusChanged` push when the condition transitions state — for example from `open` to `closed` once an oracle attestation lands or the resolution deadline passes. The message carries the `conditionId`, the new `state` (`open` or `closed`), the `closedAt` timestamp once the market has closed, and the winning `finalOutcome` when one has been attested. The push reaches any client joined to one of the condition's per-outcome markets.

On market-detail pages, lifecycle push is a best-effort update while the client
is joined to that market's per-outcome group. Discovery pages should not join
every visible market only to receive lifecycle messages. The catalogue's
`state` field remains the source of truth. On connection, reconnection, startup,
or return from the background, read the current state from
`/api/v1/markets/query`. Do not rely on receiving every push. Use startup and
visibility reconciliation, not background polling, to recover missed updates.
