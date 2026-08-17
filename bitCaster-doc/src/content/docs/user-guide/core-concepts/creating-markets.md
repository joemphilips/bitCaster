---
title: "Creating Markets"
description: "How anyone can create a prediction market on bitCaster and choose its oracle."
sidebar:
  order: 4
---

# Creating Markets

On most prediction market platforms, only the operator decides which markets exist. bitCaster works differently — anyone can create a market on any topic, at any time. You need an oracle who will attest to the event's outcome and the market metadata.

Creating a market means defining what the event is, who will attest to its outcome (the oracle), and listing the possible outcomes. Market registration is an ordinary `Open` registration. It does not ask for an opening probability or a funding payment, and it does not set a market price.

## Choosing an Oracle

Every bitCaster market is tied to at least one **oracle announcement** — a signed declaration that an oracle will attest to a specific future event. These announcements follow the standard DLC oracle format. Publishing them as Nostr events (Kind 88) is useful for public discovery and auditability, but bitCaster can also register the signed announcement directly with the mint and matching engine when relays are unavailable.

If the event you want to bet on already has an oracle announcement — say, a well-known DLC oracle that publishes Bitcoin price attestations daily — you can simply select it and move on.

In practice, though, most interesting markets are about novel events that no existing oracle has announced yet. "Will Company X ship feature Y by Q3?" or "Will it rain in Tokyo on July 1st?" — these are questions that usually no one has committed to attesting. In that case, the market creator becomes the oracle as well. You configure your own oracle keys and create the announcement yourself, committing to attest the outcome when the event resolves.

Prediction markets always involve trusting an oracle. The fundamental choice of whom to trust remains with each trader.

## Base Asset

Every market is denominated in a display **base asset** that controls how users enter funding, stake, and quote amounts. Wire amounts and proof sums use the market's collateral subunit. The current product supports one value:

- **sat** — users enter amounts in satoshis; collateral proofs and public API subunit fields use msat.

USD, JPY, and other product collateral units are not available.

bitCaster verifies with the mint that the underlying condition uses `msat`
collateral. If the mint cannot yet confirm the unit, market registration returns
a retryable error; try again once the mint has registered the condition. In
NUT-CTF, `sat` is a display asset, not a collateral proof unit; markets register
and sum proof amounts in msat.

## Price Denominator

Every market has a **price denominator** (D). Current yes/no and categorical
markets use `D=10000`, which gives `0.01%` price precision and lets the app
display prices with two decimal places, such as **53.27%**. Numeric market
creation and trading are currently unavailable. The `D=1000000` numeric
denominator is reserved for a future numeric trade representation.

- **Price granularity.** Prices are quoted as integers from 1 to D−1, so the smallest price move is 1/D.
- **Share face value.** D controls price precision. One categorical-market share pays **10 sats** if it wins.
- **Settlement precision.** All market collateral is accounted in **msat**.

The denominator and share face value cannot be changed after a market is registered.

## Fund your market

After market creation succeeds, bitCaster shows an optional **Fund the market maker** step. This is a separate post-creation flow. Funding gives the market's automated market maker capacity to post bids and asks on the order book. You can submit more than one accepted funding payment after creation.

The funding deposit uses `fundAmm` so the service treats it as AMM quoting budget, not as a withdrawable user balance. The funding depositor receives no probability-bearing position or special payout.

Market-maker funding is shown in sats. Internally and on public `*Subunits`
wire fields, collateral is tracked in msat. USD, JPY, and other product
collateral units are not available.

The funding step offers No liquidity, Minimal, Standard, Deep, and Custom budgets. Binary markets show round preset tiers of **10,000 / 100,000 / 500,000 sats**. Categorical markets multiply the paid tiers by `log2(outcome count)`. The first accepted payment starts the bot from a uniform technical state. Later payments add capacity without changing that starting state or the bot's fixed risk parameter.

The wizard also previews the estimated starting depth for the selected budget, showing roughly how many price levels the bot can post on each side and how many shares appear at each level. The preview is an estimate before mint fees, so actual quoted depth can be lower.

Choosing **No liquidity** leaves the market available without bot-provided quotes, so human makers must provide liquidity. If the selected executable book has no bids or asks, the `BUY` and `SELL` tabs show only a no-liquidity message and an action that opens `LIQUIDITY`. The `LIQUIDITY` tab uses this post-creation funding flow. Very small custom budgets may show a thin-liquidity warning.

Funding does not set the public market price. Only a confirmed trade sets a
public price. Before the first confirmed trade, the market has no price and
the app shows **No trades yet** or an em dash. A bid/ask midpoint is an
order-entry reference only.

AMM funding is meant to start trading, not replace human market makers forever. As a market matures, human and professional makers should ideally replace the initial AMM quotes with tighter, more informed liquidity.

Disclosure shown before confirming funding:

> This deposit is non-refundable. If the market resolves, the budget is expected to be spent paying traders who informed the price. Any residual at close becomes operator income.

## Market Lifecycle

A market stays open until either of two events arrives. The first is the oracle's announced deadline — the time the oracle has committed to attesting an outcome. The second is the attestation itself, which can arrive earlier if the event resolves before the deadline. Whichever comes first closes the market.

After a market closes, no new orders or deposits are accepted. From that point on, trading is over — what remains is the redemption phase, where winners exchange their conditional tokens for ecash. The redemption window is set per-mint, not per-market — the same window length applies to every market a given mint hosts.

## Further reading

- [AMM Liquidity for New Markets](/technical/architecture/market-making/) — why post-creation LMSR AMM liquidity helps new markets start trading
- [Resolution](/user-guide/core-concepts/resolution/) — how oracles attest to outcomes and how winning tokens are redeemed
- [Conditional Token Framework](/user-guide/core-concepts/conditional-tokens/) — bitCaster's three-layer asset model and how conditional tokens are minted
