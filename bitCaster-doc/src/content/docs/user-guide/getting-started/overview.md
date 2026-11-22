---
title: 'bitCaster 101'
description: 'What bitCaster is, what you can do with it, and what to know before your first trade.'
sidebar:
  order: 1
---

:::caution[Beta]
bitCaster is in beta. It uses real bitcoin, so start small.
:::

## What is bitCaster?

bitCaster is a prediction market built on [Bitcoin](https://bitcoin.org/) and [Cashu](https://cashu.space/). You buy and sell shares in the outcomes of real-world events: elections, sports, the weather, anything. If you turn out to be right, your shares pay out. If not, they pay nothing.

Your shares are [ecash](/user-guide/core-concepts/ecash/) tokens. They sit in your own wallet, in your browser or the CLI, not on a server.

## What you can do

### Trade on a prediction market

You bring in bitcoin over Lightning and use it to take a position in a market. A position is an ecash token that can be exchanged for 1 sat, but only if a particular event happens. Buying and selling these tokens, at any price between 0 and 1,000 msats (1 sat), is what bitCaster is for.

### Create a prediction market

Anyone can create a market on anything.

In essence, you write the question, name the possible outcomes, and describe how the result will be decided. See [Creating markets](/user-guide/core-concepts/creating-markets/).

### Be the oracle

The oracle is the referee who announces what actually happened. **Whoever creates a market is its oracle.**

The risk that an oracle lies is an old one, known as the **oracle problem**, and nobody has solved it completely. On bitCaster the oracle is the market's creator and can never be changed afterwards. The oracle's key is tied to that person's identity on the web, so what keeps them honest is plain reputation.

That is why you should check for yourself, before you trade, whether a market's oracle deserves your trust.

We are considering an appeal process that could overturn an oracle's decision.

See [Market resolution](/user-guide/core-concepts/resolution/).

## Your wallet, your responsibility

Your tokens are just signed data stored in your browser. That lets you send and swap them freely, even outside bitCaster, and it keeps the risk of a data leak to a minimum. It also means nobody can reset a password for you.

When you create a wallet you get a 12-word recovery phrase. Write it down and keep it offline. With the phrase, you can restore your funds and positions in any browser. Without it, losing the browser means losing the funds. See [Back up your wallet](/user-guide/getting-started/wallet-backup/).

## What you still have to trust

bitCaster removes a lot of trust, but not all of it.

- The mint: it holds the bitcoin behind your tokens, so you rely on it to honor withdrawals.
- The oracle: it decides the result. A valid signature shows who reported the result, not that it is true, and as described above, an oracle can lie.

As long as those two hold up, you will not lose your funds. bitCaster itself is only a matching engine, a convenient way to find someone to trade with.

## Identity

For now, bitCaster uses your [Nostr](https://en.wikipedia.org/wiki/Nostr) account as your identity. We are considering other ways to sign in.

## Get started

Open [bitcaster.market](https://bitcaster.market/markets), create a wallet, write down the recovery phrase, and try a small trade. If you would rather use the command line or an AI agent, see [Trade through an AI agent](/user-guide/getting-started/ai-trading/).
