---
title: "Funding Bot Liquidity"
description: "What bot funding pays for, its risks, and how to add it."
sidebar:
  order: 5
---

# Funding Bot Liquidity

The market-making bot posts buy and sell orders so that people can trade.
Funding gives the bot money to support those orders. Creating a market does
not fund the bot. Any user can add funding, including after market creation.

## Before you pay

Bot funding is **non-refundable**. It is a subsidy, not an investment that
gives you shares, fees, profits, or a right to withdraw. You have no right to
the money left when the market closes. Fund your own trading wallet instead
if you want money available for your trades.

Your payment stays allocated to the selected condition. The bot can use it
across that condition's outcomes, but not for another condition. For example,
Alpha, Beta, and Gamma can share one budget when they are outcomes of the
same event.

Review the amount and any fees before you confirm. The app shows amounts in
sats. Before it prepares a payment, the app checks that the amount remains at
or above the required minimum after applicable receive fees. Mint fees can
reduce the amount available to the bot. A completed payment does not
guarantee immediate liquidity or a fill for your next order. The bot also
depends on the supported mint being available.

## Add funding

After market creation, enter the amount in sats.
You can skip funding. Closing this screen does not undo
the market.

For an existing market, open its `LIQUIDITY` tab. Follow the payment steps
with funds from the supported mint. Wait for the app to confirm completion.
You can make more funding payments later. You do not need to be the creator.

If a payment is still pending, check or resume that payment in the app.
After a reload, resume the same payment. A received payment is not yet
credited to the market. Wait for the app to confirm credit before you make
another explicit funding payment. Do not make a second payment only because
the first one is taking time. A second payment is a separate, non-refundable
subsidy.

If recovery is incomplete or unavailable, that is different from insufficient
balance. Funds that are already ready in this wallet can be used without
waiting for remote recovery.

## What changes after funding

The bot uses an LMSR pricing strategy. Its first funding starts it from an
equal starting position across outcomes. You do not select an opening
probability when you fund it.

Later funding can increase the size of the bot's orders and change its buy
and sell prices, even without a trade. If an earlier bot trade is still
settling, new funding waits before it changes the strategy. New bot trades
pause during that wait.

Funding does not change the public market price. That price comes only from
the latest confirmed trade. Before the first trade, the app shows
**No trades yet** or an em dash. The prices of orders available now can differ
from the last trade price.

**Total funding** shows all confirmed funding after receive fees. Each new
payment adds to this total. Trading does not reduce it. It is not the money
left in the bot or the amount you can trade now. Use the current trade preview
to check whether your whole order can fill.

## Choose a budget

A larger budget can support more shares near the current prices. It also
commits more of your money without a refund. A smaller budget supports less
trading, and trades can move the bot's prices more quickly. Estimates of
order-book depth are not a promise of available liquidity.

If an order is too large to fill, try a smaller amount. Consider a subsidy
only when the preview says that more funding may help. Funding does not fix
every refusal, such as a price limit or an unavailable market.
It does not buy your shares. Review a new trade preview after funding.
Funding and trading are separate actions.

When no orders are available, the `BUY` and `SELL` tabs direct you to
`LIQUIDITY`. The trade form returns when executable orders are available.
