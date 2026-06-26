---
title: "Creating Markets"
description: "How anyone can create a prediction market on bitCaster, from choosing an oracle to providing initial liquidity."
sidebar:
  order: 4
---

# Creating Markets

On most prediction market platforms, only the operator decides which markets exist. bitCaster works differently — anyone can create a market on any topic, at any time. All you need is an oracle who will attest to the event's outcome and capital to seed initial liquidity.

Creating a market means defining what the event is, who will attest to its outcome (the oracle), and putting up the capital that lets traders start trading immediately.

## Choosing an Oracle

Every bitCaster market is tied to at least one **oracle announcement** — a signed declaration that an oracle will attest to a specific future event. These announcements follow the standard DLC oracle format. Publishing them as Nostr events (Kind 88) is useful for public discovery and auditability, but bitCaster can also register the signed announcement directly with the mint and matching engine when relays are unavailable.

If the event you want to bet on already has an oracle announcement — say, a well-known DLC oracle that publishes Bitcoin price attestations daily — you can simply select it and move on.

In practice, though, most interesting markets are about novel events that no existing oracle has announced yet. "Will Company X ship feature Y by Q3?" or "Will it rain in Tokyo on July 1st?" — these are questions that usually no one has committed to attesting. In that case, the market creator becomes the oracle as well. You configure your own oracle keys and create the announcement yourself, committing to attest the outcome when the event resolves.

Prediction markets always involve trusting an oracle. The fundamental choice of whom to trust remains with each trader.

## Base Asset

Every market is denominated in a display **base asset** that controls how users enter funding, stake, and quote amounts. Wire amounts and proof sums use the market's collateral subunit. Two display values are currently supported:

- **sat** — users enter amounts in satoshis; collateral proofs and public API subunit fields use msat.
- **usd** — users enter dollar or cent amounts; deposits are priced as BTC Lightning invoices at quote time and credited as USD cents. The BTC/USD exchange rate is locked at quote time, and collateral proofs/API subunit fields use cents (`usd`).

JPY and other units are not yet available.

For non-sat-display markets, bitCaster verifies with the mint that the underlying condition's collateral matches the chosen base asset. If the mint cannot yet confirm the unit, market registration returns a retryable error; try again once the mint has registered the condition. In NUT-CTF, `sat` is a display asset, not a collateral proof unit; sat-display markets register and sum proof amounts in msat.

## Price Denominator

Every market has a **price denominator** (D). Current user-facing markets use `D=10000`, which gives `0.01%` price precision and lets the app display prices with two decimal places, such as **53.27%**.

- **Price granularity.** Prices are quoted as integers from 1 to D−1, so the smallest price move is 1/D.
- **Share face value.** D controls price precision; the share face value is fixed by the market unit. One sat-market share pays **10 sats** if it wins. One USD-market share pays **$10.00** if it wins.
- **Settlement precision.** Sat-market collateral is accounted in **msat** with D=10000 (10-sat shares). USD-market collateral is accounted in standard **usd** cents with D=1000 ($10 shares).

The denominator and share face value cannot be changed after a market is registered.

## Fund your market

After market creation succeeds, bitCaster shows an optional **Fund the market maker** step. Funding gives the market's automated market maker an initial budget so it can post starting bids and asks on the order book. This helps a new market avoid an empty-book cold start.

The funding deposit is sent with the creator's Nostr public key and a `fundAmm` flag so the service treats it as AMM quoting budget, not as a withdrawable user balance. The creator key on the deposit must match the Nostr identity that signs the request.

Market-maker funding follows the market's display base asset. Sat markets show funding in sats; USD markets show funding in dollars backed by the mint's BTC-collateralized USD ecash. Internally and on public `*Subunits` wire fields, collateral is tracked as msat for sat-display markets and cents (`usd`) for USD markets. JPY and other units are not available yet.

The funding step offers No liquidity, Minimal, Standard, Deep, and Custom budgets. Binary markets show round preset tiers of **$15 / $150 / $300** for USD markets and **1500 / 15000 / 30000 sats** for sat markets. Categorical markets multiply the paid tiers by `log2(outcome count)`.

Choosing **No liquidity** leaves the market available without bot-provided quotes, so human makers must provide liquidity. Very small custom budgets may show a thin-liquidity warning.

AMM funding is meant to start trading, not replace human market makers forever. As a market matures, human and professional makers should ideally replace the initial AMM quotes with tighter, more informed liquidity.

Disclosure shown before confirming funding:

> This deposit is non-refundable. If the market resolves, the budget is expected to be spent paying traders who informed the price. Any residual at close becomes operator income.

## Market Lifecycle

A market stays open until either of two events arrives. The first is the oracle's announced deadline — the time the oracle has committed to attesting an outcome. The second is the attestation itself, which can arrive earlier if the event resolves before the deadline. Whichever comes first closes the market.

After a market closes, no new orders or deposits are accepted. From that point on, trading is over — what remains is the redemption phase, where winners exchange their conditional tokens for ecash. The redemption window is set per-mint, not per-market — the same window length applies to every market a given mint hosts.

## Further reading

- [AMM Liquidity for New Markets](/technical/architecture/market-making/) — why creator-funded LMSR AMM liquidity helps new markets start trading
- [Resolution](/user-guide/core-concepts/resolution/) — how oracles attest to outcomes and how winning tokens are redeemed
- [Conditional Token Framework](/user-guide/core-concepts/conditional-tokens/) — bitCaster's three-layer asset model and how conditional tokens are minted
