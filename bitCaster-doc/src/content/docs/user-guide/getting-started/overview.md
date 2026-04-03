---
title: "bitCaster 101"
description: "What is bitCaster and what can you do with it?"
sidebar:
  order: 1
---

## What is bitCaster?

bitCaster is a prediction market platform built on [Bitcoin](https://bitcoin.org/) and [Cashu](https://cashu.space/). You buy and sell tokens that represent outcomes of real-world events — elections, sports, weather, anything. If your prediction is correct, the price of your tokens rises; if not, it falls.

At its core, it is fully open-spec and open-source. No user information is stored on the server side. Your tokens are yours — stored locally in your browser, settled instantly over Lightning or Cashu.

For an overview of Cashu itself, see the [Bitcoin Design guide on ecash](https://bitcoin.design/guide/how-it-works/ecash/introduction/).

## What you can do

### Trade anything, any way you wish

Browse existing markets or place limit orders at any price. Markets can be binary (Yes/No), categorical (multiple outcomes), or even two-dimensional. You trade using Bitcoin via Lightning.

### Create your own market

Anyone can freely create a new market. Define the question, the possible outcomes, and the resolution criteria.
There is no gatekeeper deciding which markets are allowed.

### Become an oracle

In prediction markets, the value of a token depends on what actually happens in the real world. An oracle is the referee that determines that real-world outcome — which can sometimes be ambiguous.
Anyone can become an oracle. The oracle is designated when a market is created and cannot be changed afterward.
bitCaster's protocol is designed to make oracle fraud as difficult as possible. See [Resolution](../../core-concepts/resolution/) for details.

### Become a token issuer

Any user can run their own Cashu mint to issue prediction market tokens. The mint software is open-source, and the protocol specification is public. Multiple independent mints can coexist, each serving different communities or markets.

## How it works

Every market outcome has a corresponding token. The price of a token reflects the market's collective estimate of how likely that outcome is. For example, a token trading at 70 sats means the market thinks there's roughly a 70% chance of that outcome.

When the event resolves, winning tokens are redeemable for their full value (100 sats each), and losing tokens become worthless. Throughout this process, nobody — not even the token issuer — can know who holds which tokens or how many.

## Your assets, your responsibility[^1]

Your tokens are just signed data. They live in your browser's local storage, not on a server.

This means the server holds as little user information as possible. There is no account to create, no password to remember, and no personal information to hand over.

This completely eliminates risks such as personal information leaks or having only specific individuals' assets frozen.

In return, like any other cryptocurrency wallet, you are responsible for managing your own keys. Back up your 12-word mnemonic and keep it safe.

## Getting started

Ready to try it? Head to the [bitCaster app](https://frontend-bitcaster-staging.azurewebsites.net/) to start trading.

[^1]: Note that ecash tokens are not strictly self-custodial. See https://iscashucustodial.com/ or https://bitcoin.design/guide/how-it-works/ecash/introduction/, https://stacker.news/items/793450 for details.
