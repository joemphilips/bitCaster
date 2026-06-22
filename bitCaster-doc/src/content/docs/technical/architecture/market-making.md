---
title: "AMM Liquidity for New Markets"
description: "How creator-funded LMSR AMM liquidity helps a new bitCaster market start trading."
sidebar:
  order: 3
---

# AMM Liquidity for New Markets

bitCaster is built around a central limit order book (CLOB): traders and market
makers place real bids and asks, and matching happens against that book. That is
the long-term shape we want, because active human market makers can compete on
spread, size, and judgement.

New markets have a cold-start problem. If the book is empty, early traders have
no counterparty; if there are no traders, human market makers have little reason
to watch the market yet. To bridge that gap, a market creator can fund an
automated market maker (AMM) after creating the market.

## What the AMM Does

The AMM uses the creator's non-refundable funding budget to post initial bid and
ask orders on the CLOB. It is not a separate pool that replaces the order book.
It is a bot that provides first liquidity so early users can trade and discover a
price.

For creators, this matters because it makes a newly-created market look alive
from the first visit. A funded market is more likely to receive early trading
interest than a completely empty book. The tradeoff is that the funding budget is
risk capital: it can be spent paying informed traders, and it is not a
withdrawable balance or LP share.

AMM liquidity is meant to bootstrap trading, not dominate the market forever. In
a healthy mature market, human and professional market makers should gradually
replace the initial AMM quotes with tighter, more informed liquidity.

## Why LMSR

bitCaster currently uses an LMSR (Logarithmic Market Scoring Rule) AMM strategy.
We chose LMSR for v1 because it gives a clear budget-based loss bound, works
well for prediction-market probabilities, and can be sampled into ordinary CLOB
limit orders.

That matters for creators: the budget they choose controls how much initial
liquidity they provide and how much capital they put at risk. Larger budgets can
quote deeper markets; smaller budgets create thinner quotes that move more
easily.

LMSR is not intended to be the only possible AMM forever. bitCaster may add other
market-making strategies later, especially if they serve different market types,
creator preferences, or professional liquidity workflows better.

## Funding Choices

After creating a market, the creator can choose **No liquidity**, a preset
funding tier, or a custom budget. Choosing **No liquidity** leaves the market
open for human orders, but bitCaster will not post automated starting quotes.

Binary-market presets use round amounts: **$15 / $150 / $300** for USD markets
and **1500 / 15000 / 30000 sats** for sat markets. Categorical markets scale the
paid tiers by `log2(outcome count)`.

Funded sat markets are displayed in sats. Funded USD markets are displayed in
dollars or cents backed by the market mint's USD ecash. Internally, collateral is
accounted in msat for sat markets and standard cents (`usd`) for USD markets. Other units may
be added later.

The funding deposit is committed to market-making for that market. It does not
create a creator withdrawal claim, residual claim, or profit-share claim.

For the human and professional market-maker trading model, see
[Trading Model & Human Market Makers](/technical/architecture/trading-model/).
