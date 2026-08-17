---
title: "AMM Liquidity for New Markets"
description: "How post-creation LMSR AMM liquidity helps a new bitCaster market start trading."
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
automated market maker (AMM) after creating the market. Registration itself is
ordinary `Open` registration. It contains no opening probability or funding
payment and does not set a public price.

## What the AMM Does

The AMM uses non-refundable post-creation funding to post bid and ask orders on
the CLOB. It is not a separate pool that replaces the order book. It is a bot
that provides liquidity so early users can trade and discover a price.

For creators, this matters because it makes a newly-created market more ready for
early trading. A funded market is more likely to receive early trading interest
than a completely empty book. The tradeoff is that the funding is risk capital:
it can be spent paying informed traders, and it is not a withdrawable balance or
LP share. The funding depositor receives no probability-bearing position or
special payout.

AMM liquidity is meant to bootstrap trading, not dominate the market forever. In
a healthy mature market, human and professional market makers should gradually
replace the initial AMM quotes with tighter, more informed liquidity.

## Why LMSR

bitCaster currently uses an LMSR (Logarithmic Market Scoring Rule) AMM strategy.
We chose LMSR for v1 because it gives a clear budget-based loss bound, works
well for prediction-market probabilities, and can be sampled into ordinary CLOB
limit orders.

The first accepted payment starts the bot from a uniform neutral activation
state. That payment controls the initial capacity and the capital at risk.
Additional accepted payments can add capacity without repricing the bot. Larger
total capacity can quote deeper markets; smaller capacity creates thinner quotes
that move more easily.

LMSR is not intended to be the only possible AMM forever. bitCaster may add other
market-making strategies later, especially if they serve different market types,
creator preferences, or professional liquidity workflows better.

## Funding Choices

After creating a market, the creator can choose **No liquidity**, a preset
funding tier, or a custom budget. The creator can submit additional funding
payments later. Any user can also fund the bot from the market detail
`LIQUIDITY` tab. Choosing **No liquidity** leaves the market open for human
orders, but bitCaster will not post automated quotes until an accepted payment
activates the bot.

Binary-market presets use round amounts: **10,000 / 100,000 / 500,000 sats**.
Categorical markets scale the paid tiers by `log2(outcome count)`.

The creation wizard previews the selected budget as estimated starting depth: the
approximate number of price levels the bot can post per side and the approximate
shares at each level. This helps creators compare thin and deep budgets before
paying the non-refundable funding payment. The preview is before mint fees, so
actual quoted depth may be lower.

Funded markets are displayed in sats. Internally and on public `*Subunits` wire
fields, collateral is accounted in msat. The explicit base-asset and collateral-unit
fields remain part of the protocol, but the current product admits only `sat` and
`msat`, respectively.

The funding deposit is committed to market-making for that market. It does not
create a depositor withdrawal claim, residual claim, probability-bearing
position, or profit-share claim. Market cards and detail pages display accepted
bot funding as **Bot Budget**. Additional accepted payments can increase this
total. Bot Budget is not live order-book liquidity or remaining bot inventory.

Funding does not establish a public market price. The latest confirmed trade is
the public price authority. Before the first confirmed trade, the market has no
price and clients show **No trades yet** or an em dash. A bid/ask midpoint is a
separate order-entry reference only.

For the human and professional market-maker trading model, see
[Trading Model & Human Market Makers](/technical/architecture/trading-model/).
