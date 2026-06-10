---
title: "Creating Markets"
description: "How anyone can create a prediction market on bitCaster, from choosing an oracle to providing initial liquidity."
sidebar:
  order: 4
---

# Creating Markets

On most prediction market platforms, only the operator decides which markets exist. bitCaster works differently — anyone can create a market on any topic, at any time. All you need is an oracle who will attest to the event's outcome and enough sats to seed initial liquidity.

Creating a market means defining what the event is, who will attest to its outcome (the oracle), and putting up the capital that lets traders start trading immediately.

## Choosing an Oracle

Every bitCaster market is tied to at least one **oracle announcement** — a signed declaration that an oracle will attest to a specific future event. These announcements follow the standard DLC oracle format. Publishing them as Nostr events (Kind 88) is useful for public discovery and auditability, but bitCaster can also register the signed announcement directly with the mint and matching engine when relays are unavailable.

If the event you want to bet on already has an oracle announcement — say, a well-known DLC oracle that publishes Bitcoin price attestations daily — you can simply select it and move on.

In practice, though, most interesting markets are about novel events that no existing oracle has announced yet. "Will Company X ship feature Y by Q3?" or "Will it rain in Tokyo on July 1st?" — these are questions that usually no one has committed to attesting. In that case, the market creator becomes the oracle as well. You configure your own oracle keys and create the announcement yourself, committing to attest the outcome when the event resolves.

Prediction markets always involve trusting an oracle. The fundamental choice of whom to trust remains with each trader.

## Price Denominator

Every market has a **price denominator** (D). It controls two things at once:

- **Minimum stake per share.** Buying one whole share costs exactly D base units (for example, D=100 means 1 share costs 100 sats; D=1000 means 1 share costs 1,000 sats).
- **Price granularity.** Prices are quoted as integers from 1 to D−1, so the smallest price move is 1/D. D=100 gives 1%-steps; D=1,000 gives 0.1%-steps; D=10,000 gives 0.01%-steps.

Choose a lower D when you want low barriers to participation and are comfortable with coarser price resolution. Choose a higher D when fine-grained prices matter and participants can meet the larger minimum stake. The tradeoff cannot be changed after a market is registered.

Supported values: 100, 1,000, 10,000.

## Initial Liquidity

A market with no orders is a market no one can trade. To solve this cold-start problem, the creator deposits an initial amount of sats as liquidity. These sats are split into outcome tokens (e.g., YES and NO) and handed to a **Constant Product Market Maker (CPMM)** — an automated algorithm that places limit orders across a range of prices on the order book.

The result is that from the moment a market goes live, there are orders to trade against. A trader who thinks YES is underpriced can buy immediately; one who thinks NO is underpriced can do the same. The CPMM adjusts its prices as trades fill, moving them in the direction the market is leaning.

The CPMM is simple and battle-tested — Gnosis and early Polymarket both used the same approach — but it is not particularly capital-efficient. It spreads liquidity uniformly across all price levels, which means much of the capital sits at prices no one realistically trades at. This is fine for bootstrapping, but for a mature market you want tighter spreads and deeper liquidity at the prices that matter.

That's where manual market makers come in. As a market attracts attention, professional or experienced traders can place their own limit orders with better pricing than the CPMM provides. They can concentrate liquidity around the prices where trading actually happens, offering traders better deals. As this happens, the creator can withdraw some or all of their CPMM liquidity — the market now sustains itself through organic participation.

## Market Lifecycle

A market stays open until either of two events arrives. The first is the oracle's announced deadline — the time the oracle has committed to attesting an outcome. The second is the attestation itself, which can arrive earlier if the event resolves before the deadline. Whichever comes first closes the market.

After a market closes, no new orders or deposits are accepted. From that point on, trading is over — what remains is the redemption phase, where winners exchange their conditional tokens for ecash. The redemption window is set per-mint, not per-market — the same window length applies to every market a given mint hosts.

## Further reading

- [Market Making & Initial Liquidity](/technical/architecture/market-making/) — the technical details of CPMM mechanics, reserve formulas, and known limitations
- [Resolution](/user-guide/core-concepts/resolution/) — how oracles attest to outcomes and how winning tokens are redeemed
- [Conditional Token Framework](/user-guide/core-concepts/conditional-tokens/) — bitCaster's three-layer asset model and how conditional tokens are minted
