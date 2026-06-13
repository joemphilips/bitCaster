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

Every market is denominated in a **base asset** that controls how collateral, stakes, and quote payments are measured. Two values are currently supported:

- **sat** — amounts in satoshis; deposits are regular ecash over Lightning.
- **usd** — amounts in US cents (BTC-backed); deposits are priced as BTC Lightning invoices at quote time and credited as USD cents. The BTC/USD exchange rate is locked at quote time.

JPY and other units are not yet available.

For non-sat markets, bitCaster verifies with the mint that the underlying condition's collateral matches the chosen base asset. If the mint cannot yet confirm the unit, market registration returns a retryable error; try again once the mint has registered the condition.

## Price Denominator

Every market has a **price denominator** (D). It controls two things at once:

- **Minimum stake per share.** Buying one whole share costs exactly D base-asset sub-units (for example, in a sat market D=100 means 1 share costs 100 sats; in a USD market D=100 means 1 share costs $1.00).
- **Price granularity.** Prices are quoted as integers from 1 to D−1, so the smallest price move is 1/D. D=100 gives 1%-steps; D=1,000 gives 0.1%-steps; D=10,000 gives 0.01%-steps.

Choose a lower D when you want low barriers to participation and are comfortable with coarser price resolution. Choose a higher D when fine-grained prices matter and participants can meet the larger minimum stake. The tradeoff cannot be changed after a market is registered.

Supported values: 100, 1,000, 10,000.

## Fund your market

After market creation succeeds, bitCaster shows an optional **Fund the market maker** step. Funding requests a deposit for the market's automated market-maker. The deposit is sent with the market creator's Nostr public key and a `fundAmm` flag so the service can treat it as bot quoting budget instead of a withdrawable user balance. The creator key on a funding deposit must match the Nostr identity that signs the request itself — a deposit naming a different creator key is rejected, so funding attribution always belongs to the signed-in key.

Market-maker funding follows the market's base asset. Sat markets fund the bot in sats; USD markets fund it in US cents backed by the mint's BTC-collateralized USD ecash. JPY and other units are not available yet.

The funding step offers No liquidity, Minimal, Standard, Deep, and Custom budgets. Binary markets show 0, 10,000, 100,000, and 1,000,000 base sub-units for the preset tiers. Categorical markets multiply the paid tiers by `log2(outcome count)`.

No liquidity, Minimal funding, and custom budgets below 10,000 base sub-units show a **WARNING** badge: **Very thin liquidity**. Choosing **No liquidity** leaves the market available without bot-provided quotes, so human makers must provide liquidity.

Disclosure shown before confirming funding:

> This deposit is non-refundable. If the market resolves, the budget is expected to be spent paying traders who informed the price. Any residual at close becomes operator income.

## Market Lifecycle

A market stays open until either of two events arrives. The first is the oracle's announced deadline — the time the oracle has committed to attesting an outcome. The second is the attestation itself, which can arrive earlier if the event resolves before the deadline. Whichever comes first closes the market.

After a market closes, no new orders or deposits are accepted. From that point on, trading is over — what remains is the redemption phase, where winners exchange their conditional tokens for ecash. The redemption window is set per-mint, not per-market — the same window length applies to every market a given mint hosts.

## Further reading

- [Market Making & Creator Funding](/technical/architecture/market-making/) — the technical details of LMSR bot funding, pricing state, and close-out
- [Resolution](/user-guide/core-concepts/resolution/) — how oracles attest to outcomes and how winning tokens are redeemed
- [Conditional Token Framework](/user-guide/core-concepts/conditional-tokens/) — bitCaster's three-layer asset model and how conditional tokens are minted
