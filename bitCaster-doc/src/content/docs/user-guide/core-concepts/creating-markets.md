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

Every bitCaster market is tied to at least one **oracle announcement** — a signed declaration that an oracle will attest to a specific future event. These announcements follow the standard DLC oracle format and are published as Nostr events (Kind 88).

If the event you want to bet on already has an oracle announcement — say, a well-known DLC oracle that publishes Bitcoin price attestations daily — you can simply select it and move on.

In practice, though, most interesting markets are about novel events that no existing oracle has announced yet. "Will Company X ship feature Y by Q3?" or "Will it rain in Tokyo on July 1st?" — these are questions that usually no one has committed to attesting. In that case, the market creator becomes the oracle as well. You configure your own oracle keys and publish the announcement yourself, committing to attest the outcome when the event resolves.

Prediction markets always involve trusting an oracle. The fundamental choice of whom to trust remains with each trader.

## Initial Liquidity

A market with no orders is a market no one can trade. To solve this cold-start problem, the creator deposits an initial amount of sats as liquidity. These sats are split into outcome tokens (e.g., YES and NO) and handed to a **Constant Product Market Maker (CPMM)** — an automated algorithm that places limit orders across a range of prices on the order book.

The result is that from the moment a market goes live, there are orders to trade against. A trader who thinks YES is underpriced can buy immediately; one who thinks NO is underpriced can do the same. The CPMM adjusts its prices as trades fill, moving them in the direction the market is leaning.

The CPMM is simple and battle-tested — Gnosis and early Polymarket both used the same approach — but it is not particularly capital-efficient. It spreads liquidity uniformly across all price levels, which means much of the capital sits at prices no one realistically trades at. This is fine for bootstrapping, but for a mature market you want tighter spreads and deeper liquidity at the prices that matter.

That's where manual market makers come in. As a market attracts attention, professional or experienced traders can place their own limit orders with better pricing than the CPMM provides. They can concentrate liquidity around the prices where trading actually happens, offering traders better deals. As this happens, the creator can withdraw some or all of their CPMM liquidity — the market now sustains itself through organic participation.

## Further reading

- [Market Making & Initial Liquidity](/technical/architecture/market-making/) — the technical details of CPMM mechanics, reserve formulas, and known limitations
- [Resolution](/user-guide/core-concepts/resolution/) — how oracles attest to outcomes and how winning tokens are redeemed
- [Conditional Token Framework](/user-guide/core-concepts/conditional-tokens/) — bitCaster's three-layer asset model and how conditional tokens are minted
