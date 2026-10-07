---
title: 'Conditional Tokens'
description: 'What market positions represent, how payouts work, and what you must trust.'
sidebar:
  order: 1
---

# Conditional Tokens

A conditional token represents a position in a prediction market. It belongs
to a specific event and outcome. Unlike ordinary ecash, its payout depends on
the market result.

## Price and payout

The price is what you pay to buy a share. The payout is what a winning share
can receive after the result is verified. These are different amounts.

For an ordinary sat market, one winning share pays 1 sat before mint fees.
Buying 10 shares at 0.2 sats each costs 2 sats before fees. If those shares
win, their total payout is 10 sats before mint fees. If another outcome wins,
they do not receive that payout. You can lose the purchase amount and fees.

A displayed price is not a promise about the result. It does not guarantee
that a new order can trade at that price. Check the order preview and price
protection before you submit.

## Buying, selling, and claiming

You first obtain ordinary ecash from the supported mint. Buying a position
exchanges ordinary ecash for conditional tokens. Selling exchanges a position
for ordinary ecash if matching liquidity is available. You can submit a sell
order before the event result is known. A sale is not guaranteed.

The Sell form shows the shares available for the selected outcome. Shares
already in use by a pending transaction are not available. Percentage buttons
use this holding and round down to whole shares. The order still needs enough
liquidity and funds for fees.

Buying requires the selected trade cost and fees, not the full winning payout.
If the cost check fails, use Retry. If you need to add funds but no minimum
amount is shown, choose an amount. Then review the updated trade cost before
confirming the order.

After the mint accepts the oracle's signed result, winning tokens can be
redeemed for ordinary ecash from that mint. Redemption is not a Lightning
withdrawal. Fees and the mint's redemption period still apply.

Trading closure alone does not establish the result. A missing oracle result
does not guarantee a refund. Read [market resolution](/user-guide/core-concepts/resolution/)
for these conditions. Keep wallet records until a trade or redemption is
confirmed. Losing tokens do not become ordinary ecash. Resolution alone does
not authorize deleting your wallet records.

## Estimated position values

Portfolio uses confirmed trade prices to estimate position values. With two
outcomes, the latest trade on either outcome updates both estimates. The other
outcome uses 100% minus that price. For example, a latest Yes trade at 28%
gives a No estimate of 72%; a latest No trade at 72% gives a Yes estimate of 28%. With
three or more outcomes, a No position uses 100% minus its outcome's price. For example,
if B last traded at 28%, No B is estimated at 72% of its winning payout.
This estimate is not a guaranteed sale price. Use the Sell preview to check
what an order can receive.

A closed winning position shows its payout value, not profit. Portfolio does
not report a profit amount or percentage because it does not have the purchase
cost for that position.

A position without a usable price stays visible. Its value and the complete
portfolio total are unavailable, not zero. The app reports missing prices
separately from data that is still updating. Missing historical prices can
make the chart unavailable without hiding a valid current estimate.

The first page updates after trades and market closure. Updates can be delayed.
Positions loaded with **Load more** may not update automatically. Reload
Portfolio and load those pages again to update their values. The page shows
a note when loaded positions are outside its live-update coverage.

## What you must trust

The oracle signs the result. The mint verifies the signature and applies the
payout rules. A valid signature does not prove that the result is true. Check
the market question and oracle before buying a position.

The mint holds the Bitcoin reserves. You depend on it to honor redemption and
remain available. Holding your wallet keys does not remove that risk.
See [ecash](/user-guide/core-concepts/ecash/) for custody and privacy limits.

## Protocol details

bitCaster represents positions as Cashu proofs under the NUT-CTF protocol.
The Conditional Token Framework separates collateral from outcome-dependent
positions. You do not need to manage protocol identifiers to use the app.

Numeric markets have a different planned payout model. They are not available
in the current product. See [numeric markets](/user-guide/core-concepts/numeric-markets/)
for that planned model.

## Further reading

- [Atomic settlement](/user-guide/core-concepts/atomic-swap/) explains order confirmation and recovery.
- [Wallet backup](/user-guide/getting-started/wallet-backup/) explains how to protect recovery records.
- [Trading model](/technical/architecture/trading-model/) explains the public trading contracts.
