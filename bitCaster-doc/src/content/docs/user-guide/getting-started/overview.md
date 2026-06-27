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

Categorical markets show primitive outcome books such as `A / Not A`, `B / Not B`, and `C / Not C`. Under the hood, settlement can still lock complementary multi-outcome legs such as `B|C`, but users trade through the primitive book labels. The first release supports markets with up to 8 outcomes.

### Create your own market

Anyone can freely create a new market. Define the question, the possible outcomes, and the resolution criteria.
There is no gatekeeper deciding which markets are allowed.

### Become an oracle

In prediction markets, the value of a token depends on what actually happens in the real world. An oracle is the referee that determines that real-world outcome — which can sometimes be ambiguous.
Anyone can become an oracle. The oracle is designated when a market is created and cannot be changed afterward.
bitCaster's protocol is designed to make oracle fraud as difficult as possible. See [Resolution](../../core-concepts/resolution/) for details.

When a market's oracle key is a Nostr public key, you should audit the oracle yourself before trading. Copy the market's oracle `npub` from the market detail page and check that identity's history and credibility in your preferred Nostr client.

### Become a token issuer

Any user can run their own Cashu mint to issue prediction market tokens. The mint software is open-source, and the protocol specification is public. Multiple independent mints can coexist, each serving different communities or markets.

## How it works

Every market outcome has a corresponding token. The price of a token reflects the market's collective estimate of how likely that outcome is. Prices are shown as probabilities with two decimal places, such as **53.27%**.

The trade ticket asks for whole shares and shows the total cost before you submit. It no longer asks you to calculate payout rows or executable-share estimates. One sat-market share pays **10 sats** if it wins. One USD-market share pays **$10.00** if it wins. Internally, sat-display markets use msat collateral subunits with `D=10000`, so the smallest price move is `0.01%`. For example, 50 shares at 30.00% cost 150 sats in a sat market and pay 500 sats if they win.

When the event resolves, winning tokens are redeemable for their full share value, and losing tokens become worthless. Throughout this process, nobody — not even the token issuer — can know who holds which tokens or how many.

## Your assets, your responsibility[^1]

Your tokens are just signed data. They live in your browser's local storage, not on a server.

This means the server holds as little user information as possible. There is no account to create, no password to remember, and no personal information to hand over.

**This completely eliminates risks such as personal information leaks or having only specific individuals' assets frozen.**

In return, like any other cryptocurrency wallet, you are responsible for managing your own keys. Back up your 12-word mnemonic and keep it safe.

When you first open the portfolio page or try to trade, bitCaster asks you to set up a wallet. You can create a new wallet (auto-generated locally in your browser) or import an existing wallet using your 12-word recovery phrase. A Nostr signing key is also created or connected at this point. These are separate secrets. Back up both the wallet recovery phrase and the Nostr secret key shown in the app. If you already use a Nostr account, connect it instead of generating a new one.

## Market detail pages

The market chart shows recorded trades for each primitive outcome. If only one outcome has traded, only that line is shown; bitCaster does not invent prices for outcomes that have not traded.

The order book shows asks (sell orders) above the spread and bids (buy orders) below it, with the best prices closest to the spread. Each row combines price, cumulative depth, and visual thickness. Longer bars mean more cumulative liquidity available at that price or better, normalized across both sides so you can compare bid and ask depth at a glance.

Trade comments are optional and public inside bitCaster. A comment is shown only after the attached order produces a settled trade, so the comment feed is limited to verified traders for that market. P20 comments are not published to public Nostr relays.

## Getting started

Ready to try it? Head to the [bitCaster app](https://frontend-bitcaster-staging.azurewebsites.net/) to start trading.

[^1]: Note that ecash tokens are not strictly self-custodial. See https://iscashucustodial.com/ or https://bitcoin.design/guide/how-it-works/ecash/introduction/, https://stacker.news/items/793450 for details.
