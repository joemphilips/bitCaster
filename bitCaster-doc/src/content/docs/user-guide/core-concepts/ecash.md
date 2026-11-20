---
title: 'Ecash'
description: 'What ecash is, why bitCaster chose Cashu, and why a prediction market does not need a blockchain.'
sidebar:
  order: 0
---

Everything you hold on bitCaster, your balance and your positions alike, is an **ecash token**. This page explains what that means and why it suits a prediction market better than a blockchain does.

## What is ecash?

Ecash is digital cash built on blind signatures, an idea David Chaum published in the 1980s.

A **mint** issues tokens the way a bank issues banknotes, and signs each one to prove that it is genuine. The signature is blind: the mint signs without seeing what it signs. Later it can check that a token is real, but it cannot tell who received it. And like a banknote, a token belongs to whoever holds it. No account, login, or identity is attached.

On bitCaster, you deposit bitcoin over Lightning and receive ecash. When you buy shares, that ecash is exchanged for [conditional tokens](/user-guide/core-concepts/conditional-tokens/) tied to an outcome. If you win, they turn back into ordinary ecash, which you can withdraw over Lightning whenever you like.

## Why Cashu?

bitCaster uses [Cashu](https://cashu.space/), an ecash protocol for Bitcoin. Its specification is open, in a set of documents called [NUTs](https://github.com/cashubtc/nuts), so anyone can build a wallet or a mint. The cryptography is simple enough to audit and to extend, which is how bitCaster adds conditional tokens. It works with Lightning out of the box, with no bridges or wrapped coins. And several independent teams maintain wallets, mints, and libraries.

## Why not a blockchain?

People often ask why bitCaster does not run on a blockchain, the way Polymarket runs on Polygon.

The answer is that an exchange is centralized already. Somebody has to run the order book and match the trades. Moving that activity on-chain does not remove the operator. It only adds costs.

Privacy gets worse, because every trade on a public chain is visible to everyone, forever. With ecash, not even the mint knows who holds which token. Speed and cost get worse, because on-chain settlement means gas fees and block times, and both spike exactly when a market gets busy. And getting started gets harder, because you need the right coin on the right chain, plus a gas token, before your first trade. Here you deposit sats and trade.

Blockchains are good at public verifiability and at resisting censorship. A prediction market does not need every trade to be public, and a matching engine can always refuse an order anyway. What traders actually want is privacy, speed, and low fees, and that is what ecash delivers.

## What ecash does not do

Ecash is not magic. The mint holds the bitcoin behind your tokens, so you trust it to honor withdrawals. Privacy applies to the mint: the matching engine can still see the orders you place under your Nostr key. And because tokens are bearer cash, losing your [recovery phrase](/user-guide/getting-started/wallet-backup/) means losing your funds.

## Further reading

- [Conditional tokens](/user-guide/core-concepts/conditional-tokens/) shows how a market position is built on top of ecash.
- [How trades settle](/user-guide/core-concepts/atomic-swap/) explains how tokens change hands safely.
- The [Bitcoin Design guide to ecash](https://bitcoin.design/guide/how-it-works/ecash/introduction/) is a good outside introduction.
- [Deposits, withdrawals, and mint fees](/technical/reference/payments/) has the precise rules.
