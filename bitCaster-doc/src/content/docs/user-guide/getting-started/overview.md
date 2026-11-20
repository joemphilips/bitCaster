---
title: 'bitCaster 101'
description: 'What bitCaster is, what you can do with it, and what to know before your first trade.'
sidebar:
  order: 1
---

:::caution[Limited beta]
bitCaster is in a limited beta. It uses real bitcoin and has limited capacity. Start small.
:::

## What is bitCaster?

bitCaster is a prediction market built on [Bitcoin](https://bitcoin.org/) and [Cashu](https://cashu.space/). You buy and sell shares in the outcomes of real-world events: elections, sports, the weather, anything. If you turn out to be right, your shares pay out. If not, they pay nothing.

There is no account to open and no personal information to hand over. Your shares are [ecash](/user-guide/core-concepts/ecash/) tokens that sit in your own wallet, in your browser, not on a server.

## What you can do

### Trade

Pick a market, pick an outcome, and choose how many shares to buy. You pay in bitcoin over Lightning. A market is either Yes/No or has up to eight named outcomes. You don't have to hold your shares until the end: you can sell them whenever someone is willing to buy.

### Create a market

Anyone can create a market on any question. You write the question, name the possible outcomes, and describe how the result will be decided. Nobody approves or rejects markets. See [Creating markets](/user-guide/core-concepts/creating-markets/).

### Be the oracle

The oracle is the referee who announces what actually happened. When you create a market, you are its oracle, and you sign the result once the event is over. A market's oracle is fixed at creation and can never be swapped out, so traders always know whose word they are relying on. See [Market resolution](/user-guide/core-concepts/resolution/).

## Prices and payouts

Every outcome has its own share. A winning share pays 1 sat, and a losing share pays nothing. That is why a price reads like a probability: a share at 30% costs 0.3 sats, and says the market gives that outcome roughly a 30% chance.

Say you buy 100 Yes shares at 30%. You pay 30 sats plus fees. If Yes wins, you collect 100 sats. If it loses, you collect nothing. And if the price climbs to 60% along the way, you can sell for about 60 sats without waiting for the result.

Before you confirm an order, the app shows its exact cost and fees. The order then fills completely at that price or better, or it does not happen at all.

## Your wallet, your responsibility[^1]

Your tokens are just signed data stored in your browser. That is what lets bitCaster work without knowing who you are. It also means nobody can reset a password for you.

When you create a wallet you get a 12-word recovery phrase. Write it down and keep it offline. With the phrase, you can restore your funds and positions in any browser. Without it, losing the browser means losing the funds. See [Back up your wallet](/user-guide/getting-started/wallet-backup/).

## What you still have to trust

bitCaster removes a lot of trust, but not all of it. The mint holds the bitcoin behind your tokens, so you rely on it to honor withdrawals. The oracle decides the result, and a valid signature shows who reported it, not that it is true. The matching engine can see the orders you place under your Nostr key, although the mint cannot tell who holds which token. Check a market's question and its oracle before you trade.

## Get started

Open [bitcaster.market](https://bitcaster.market/markets), create a wallet, write down the recovery phrase, and try a small trade. If you would rather use the command line or an AI agent, see [Trade through an AI agent](/user-guide/getting-started/ai-trading/).

[^1]: Ecash is not strictly self-custodial, because the mint holds the underlying bitcoin. See [Is Cashu custodial?](https://iscashucustodial.com/) and the [Bitcoin Design guide to ecash](https://bitcoin.design/guide/how-it-works/ecash/introduction/).
