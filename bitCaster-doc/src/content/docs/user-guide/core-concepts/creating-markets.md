---
title: 'Creating Markets'
description: 'Create a prediction market, report its result, and optionally fund its market maker.'
sidebar:
  order: 4
---

# Creating Markets

To create a market, define the question and list its possible outcomes.
In the current app, you also act as the oracle: you report the result when
the event is resolved.

You do not choose an opening probability or fund the market maker during
registration. The mint can charge a separate registration fee. The app asks
you to confirm that fee before proceeding. After creation, you can fund the market maker in a separate
step. That payment is non-refundable. Creating or funding a market does not
set its displayed price; a confirmed trade does.

For a yes/no market, the wizard uses Yes and No automatically. It skips the
outcome-entry step. For a categorical market, enter the outcome names.
If a payment needs a wallet, choose Create wallet or Restore wallet.
Setup and cancellation preserve your draft. Setup does not submit the market
or pay its fee. Continue only after you review the next action.

## Your role as oracle

The creation flow uses your own Nostr private key to make a signed promise
to report the event's result. This promise is the oracle announcement.
Configure your oracle key before creating a market. The current wizard does
not let you select another oracle or an existing announcement.

Choose a question with a clear result that you can report. Traders must trust
your reporting: a valid signature does not prove that the result is true.
See [Resolution](/user-guide/core-concepts/resolution/) for your reporting
responsibilities and what happens after trading closes.

## Amounts and prices

The app shows amounts in sats, the small units of Bitcoin. USD, JPY, and
other funding currencies are not available.

For a yes/no or categorical market, one winning share pays one sat before
redemption fees. Its purchase price is a separate amount. Prices use steps
of 0.1 percentage points, such as 53.3%. These settings are fixed; you do
not select them when you create the market.

Numeric market creation and trading are not available.

The mint must confirm the market's currency before registration can finish.
If registration reports that this check is not ready, try again after the
mint has registered the event.

## Fund your market

After market creation succeeds, bitCaster shows an optional **Fund the market maker** step. This is a separate post-creation flow. Funding gives the market's automated market maker capacity to post bids and asks on the order book. You can submit more than one accepted funding payment after creation.

This payment is a non-refundable subsidy for this market's bot. It does not
fund your trading wallet. It gives you no market shares, fee income, or right
to withdraw. Capital assigned to this market cannot fund a different market.

Enter the amount in sats. The first accepted payment
starts the bot without a creator-selected probability. Later payments add
capital and can change its quotes even before another trade occurs. They do
not rewrite past trades. If an earlier bot trade is still settling, the new
funding waits before changing the quotes. The bot pauses new fills during
that interval.

Skip this step to finish creation without funding the bot. If no
liquidity is available for the selected outcome, the `BUY` and `SELL` tabs
show a message and a link to `LIQUIDITY`. You can fund the bot there later.

Funding does not set the public market price. Only a confirmed trade sets a
public price. Before the first confirmed trade, the market has no price and
the app shows **No trades yet** or an em dash. A bid/ask midpoint is an
order-entry reference only.

Disclosure shown before confirming funding:

> This deposit is non-refundable. If the market resolves, the budget is expected to be spent paying traders who informed the price. Any residual at close becomes operator income.

## Market Lifecycle

A market closes when an oracle attestation is accepted or its announced deadline
arrives, whichever comes first. A market can have no deadline. In that case,
no deadline-based close is scheduled. An accepted attestation can still close
the market.

After a market closes, trading ends. No new orders or bot funding are accepted.
Closure at the deadline does not identify winning tokens or guarantee a refund.
Winning tokens can be redeemed for ecash only after the mint accepts a result.
The redemption period is a mint policy shared across its markets. See
[Resolution](/user-guide/core-concepts/resolution/) for missing-result and
redemption rules.

## Further reading

- [AMM Liquidity for New Markets](/technical/architecture/market-making/) — why post-creation LMSR AMM liquidity helps new markets start trading
- [Resolution](/user-guide/core-concepts/resolution/) — how oracles attest to outcomes and how winning tokens are redeemed
- [Conditional tokens](/user-guide/core-concepts/conditional-tokens/) — buying, selling, and redeeming market shares
