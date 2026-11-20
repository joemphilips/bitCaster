---
title: 'How Trades Settle'
description: 'What happens between pressing Buy and holding your shares, and why you never have to trust the other side.'
sidebar:
  order: 2
---

A trade on bitCaster has two steps. First the matching engine finds someone to trade with. Then the mint exchanges the tokens. The second step is **atomic**: either everyone receives what they agreed to, or nothing moves at all.

## Why you don't have to trust anyone to go first

In an ordinary swap, somebody has to send first and hope the other side follows. Here nobody does.

When you place an order, your wallet locks exactly the tokens that order needs, and hands only those to the matching engine. The lock says what the tokens may be exchanged for. The engine can complete the trade you agreed to, and nothing else. It cannot send your tokens elsewhere, and it cannot touch the rest of your wallet.

When a match is found, the mint swaps both sides in a single operation. If the trade never happens, the lock expires and your wallet takes the tokens back.

All of this is ecash moving through the mint. There is no blockchain transaction, no gas, and no waiting for a block.

## All or nothing

Orders are fill-or-kill. Before you confirm, the app shows the cost and the fees. Your order then fills in full at that price or better, or it is cancelled. It never fills halfway and it never sits on the book waiting.

## Fees

The mint charges a small fee whenever tokens are exchanged. Orders that use the order book also cost a few sats of **Participation Score**, a prepaid anti-spam fee that is not refundable. The app lists every fee before you confirm.

## If a trade seems stuck

A dropped connection does not mean that the trade failed. The mint may have finished it before the reply reached you. Your wallet remembers the order and checks its result by itself, and if the trade did not happen, it reclaims the locked tokens once the lock expires.

So don't place the same order again just to retry, and don't clear your browser data. Keep the wallet as it is and let it finish.

## Further reading

- [Orders: preparation, settlement, and recovery](/technical/reference/orders/) has the precise rules.
- [NUT-CTF range settlement](/technical/protocol/atomic-swap/) describes the protocol.
