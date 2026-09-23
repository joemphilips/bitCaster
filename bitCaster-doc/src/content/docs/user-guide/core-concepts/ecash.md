---
title: "Ecash"
description: "What Cashu ecash is and how bitCaster uses sat-denominated conditional tokens."
sidebar:
  order: 0
---

# Ecash

bitCaster uses Cashu ecash for wallet balances and market positions. The app
shows Bitcoin amounts in sats. One sat is one hundred millionth of a bitcoin.

## What is ecash?

Ecash is digital cash issued by a service called a mint. Your wallet holds
signed records called proofs. For ordinary ecash, control of those proofs
gives control of the value. Keep wallet data and recovery material private.

Your wallet holds ordinary ecash for payments and conditional tokens for
market positions. A trade exchanges these assets through the mint. A submitted
order is not a completed trade. Wait for confirmation before treating its
result as spendable.

For an order, the wallet sends the matching engine only the proofs prepared
for that order. These use a spending restriction called `PAY_TO_UNLOCK`.
The engine sees those proof secrets, but the restriction prevents it from
redirecting their value or extending their expiry. The wallet keeps its
recovery phrase, refund keys, and other proofs private.

## Funding and withdrawal

The first release supports one mint operated by bitCaster. You can add funds
to your wallet by paying a Lightning invoice or importing a Cashu token from
that mint. You can withdraw ordinary ecash by paying a Lightning invoice
through the mint. Check the amount and estimated fees before confirmation.

Adding funds to your wallet is not the same as funding a market's bot.
[Bot funding](/user-guide/core-concepts/funding-bot-liquidity/) is a separate,
non-refundable subsidy. It does not add to your spendable wallet balance.

## Trust model

Ecash is a bearer system. You must protect wallet data and recovery material.
The mint holds the Bitcoin reserves behind its issued tokens. You therefore
trust the mint operator to honor its ecash obligations.

Cashu uses blind signatures to help prevent the mint from linking token
issuance to later spending. This does not hide all payment, timing, or network
metadata. It also does not guarantee that the mint will serve a request.
If the mint stops operating, trading and withdrawals can become unavailable.

The matching engine can associate authenticated activity with your engine
identity. Privacy against the mint is not anonymity against the engine.

The matching engine cannot spend other wallet proofs. If an order does not
settle, its funds can remain unavailable until refund conditions are met.
Keep the local wallet records needed for recovery. See
[wallet backup](/user-guide/getting-started/wallet-backup/) before clearing
browser data or changing devices.

## Why Cashu?

Cashu provides private bearer tokens with Bitcoin and Lightning support. It
also provides the NUT framework that bitCaster uses for conditional tokens and
`PAY_TO_UNLOCK` authorization.

## Further reading

- [Atomic settlement](/user-guide/core-concepts/atomic-swap/) explains the
  mint conversion flow.
- [Conditional Token Framework](/user-guide/core-concepts/conditional-tokens/)
  explains conditional market positions.
- [Bitcoin Design — Ecash Introduction](https://bitcoin.design/guide/how-it-works/ecash/introduction/)
  gives an external introduction to ecash trust models.
