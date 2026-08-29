---
title: "Funding Bot Liquidity"
description: "How to fund LMSR AMM liquidity after creating a market."
sidebar:
  order: 5
---

# Funding Bot Liquidity

When a market is created, the order book starts empty. To give early traders a counterparty, bitCaster can run an automated market maker (AMM) that posts initial bid and ask orders to the book.

Funding is optional. After the market is created, the wizard shows a funding screen where you can choose **No liquidity**, **Minimal**, **Standard**, **Deep**, or a custom budget. Binary-market presets use round amounts: **10,000 / 100,000 / 500,000 sats**. Categorical markets scale those paid tiers by `log2(outcome count)`.

Any user can also open the `LIQUIDITY` tab on the market detail page and
submit a later funding payment. Funding is not restricted to the market
creator.

The wizard previews the selected budget as estimated starting depth: roughly how many price levels the bot can post per side and roughly how many shares appear at each level. The preview is before mint fees, so actual quoted depth can be lower.

## What You Fund

The deposit becomes AMM capacity for that market. The AMM currently uses an
LMSR strategy. The first accepted payment starts the bot from a uniform neutral
state. The deposit does not contain an opening probability and it does not set
the public market price.

Market cards and detail pages show the accepted bot funding as **Bot Budget**.
Additional accepted payments can increase this total. It is not live
order-book liquidity or remaining inventory.

Each deposit is **non-refundable**. It is committed to market-making until the
market resolves. Later payments add capacity without repricing the bot. A
depositor receives no probability-bearing position, withdrawal claim, residual
claim, or creator profit-share claim.

Markets are shown to users in sats. Internally and on public market-summary
`*Subunits` wire fields, collateral is accounted in **msat**.

## Funding Flow

1. Create the market. Registration does not include funding or an opening probability.
2. Choose a funding tier or choose No liquidity.
3. If funding, submit a Cashu payment issued by the configured mint.
4. Check the deposit status until the payment is accepted. The first accepted payment activates the bot. You can repeat this flow to add capacity later.

## If You Close the Wizard

Closing the wizard does not undo the market. The market remains created and can
still accept human orders. If you selected No liquidity, or if funding has not
completed yet, the automated maker will not quote until an accepted funding
payment activates it.

If the selected executable book has no bids or asks, the `BUY` and `SELL` tabs
show only a no-liquidity message and an action that opens `LIQUIDITY`. Funding
does not claim that liquidity exists. The normal order form appears only after
the executable book becomes non-empty.

## Trade-Offs

Smaller budgets create thinner quotes and can move more quickly when informed
traders trade against the maker. Larger budgets create deeper quotes, but they
also put more non-refundable capital at risk. The bot starts from a uniform
neutral state; no creator probability sets its opening quotes.

AMM liquidity is mainly for bootstrapping. In the long run, active human and
professional market makers should provide tighter, more informed liquidity
than the automated quotes.

Funding does not set a public market price. Only a confirmed trade sets that
price. Before the first confirmed trade, the market has no price and clients
should show **No trades yet** or an em dash. A bid/ask midpoint is an
order-entry reference only.
