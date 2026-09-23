---
title: "Conditional Tokens"
description: "What market positions represent, how payouts work, and what you must trust."
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

After the mint accepts the oracle's signed result, winning tokens can be
redeemed for ordinary ecash from that mint. Redemption is not a Lightning
withdrawal. Fees and the mint's redemption period still apply.

Trading closure alone does not establish the result. A missing oracle result
does not guarantee a refund. Read [market resolution](/user-guide/core-concepts/resolution/)
for these conditions. Keep wallet records until a trade or redemption is
confirmed. Losing tokens do not become ordinary ecash. Resolution alone does
not authorize deleting your wallet records.

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
