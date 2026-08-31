---
title: "bitCaster 101"
description: "What is bitCaster and what can you do with it?"
sidebar:
  order: 1
---

## What is bitCaster?

bitCaster is a prediction market platform built on [Bitcoin](https://bitcoin.org/) and [Cashu](https://cashu.space/). You buy and sell tokens that represent outcomes of real-world events — elections, sports, weather, anything. If your prediction is correct, the price of your tokens rises; if not, it falls.

The browser serves casual participants and market creators. Professional and
automated traders can use the CLI, daemon, and SDK. Every client uses the same
CLOB and settlement protocol.

At its core, it is fully open-spec and open-source. Your live wallet and tokens
stay local to your browser. The web app can store an encrypted recovery copy
that the server cannot decrypt; see [Encrypted wallet backup](./wallet-backup/)
for its privacy boundary.

For an overview of Cashu itself, see the [Bitcoin Design guide on ecash](https://bitcoin.design/guide/how-it-works/ecash/introduction/).

## What you can do

### Trade anything, any way you wish

Browse existing markets or place limit orders at any price. Markets can be binary
(Yes/No) or categorical (multiple outcomes). The product
uses sat ecash for ordinary wallet funding and msat conditional ecash for market
positions. You can top up through a Lightning invoice or by pasting an existing
sat Cashu token.

Categorical markets show primitive outcome books such as `A / Not A`, `B / Not B`, and `C / Not C`. Under the hood, settlement can still lock complementary multi-outcome legs such as `B|C`, but users trade through the primitive book labels. The first release supports markets with up to 8 outcomes.

### Create your own market

Anyone can freely create a new market. Define the question, the possible
outcomes, and the resolution criteria. Registration opens the market in the
ordinary `Open` state. The create flow does not ask for an opening probability
or a funding payment, and it does not set a market price. Optional bot funding
is a separate post-creation flow and can be repeated.
There is no gatekeeper deciding which markets are allowed.

### Become an oracle

In prediction markets, the value of a token depends on what actually happens in the real world. An oracle is the referee that determines that real-world outcome — which can sometimes be ambiguous.
Anyone can become an oracle. The oracle is designated when a market is created and cannot be changed afterward.
bitCaster's protocol is designed to make oracle fraud as difficult as possible. See [Resolution](../../core-concepts/resolution/) for details.

When a market's oracle key is a Nostr public key, you should audit the oracle yourself before trading. Copy the market's oracle `npub` from the market detail page and check that identity's history and credibility in your preferred Nostr client.

### Use the supported mint

The first release supports one Cashu mint operated by bitCaster. The app does
not support selecting or using another mint. The mint software and protocol
specification remain public.

## How it works

Every market outcome has a corresponding token. A public market price comes
from the latest confirmed trade. Before the first confirmed trade, the market
has no price, so the app shows **No trades yet** or an em dash. Prices from
confirmed trades are shown as probabilities with one decimal place, such as
**53.3%**. A bid/ask midpoint is an order-entry reference only.

The trade ticket asks for whole shares and shows the cost before you submit. The breakdown separates **Quote payment**, **Est. settlement fee**, and **Total**, so you can see the order payment apart from the estimated mint fee. One categorical-market share pays **1 sat** if it wins. Internally, categorical markets use msat collateral subunits with `D=1000`, so the smallest price move is `0.1%`. For example, 50 shares at 30.0% quote 15 sats before any estimated settlement fee, and pay 50 sats if they win.

When the event resolves, winning tokens are redeemable for their full share value, and losing tokens become worthless. Throughout this process, nobody — not even the token issuer — can know who holds which tokens or how many. The mint cannot selectively freeze an identified user's ecash. It can stop service for everyone, so users must still assess the mint before they participate.

## Your assets, your responsibility[^1]

Your tokens are just signed data. The live wallet database is in your browser's
local storage. The default web app also keeps an encrypted recovery copy whose
contents the server cannot read.

This minimizes the wallet information held by the server. The encrypted-backup
service can still observe limited account, size, and activity metadata. It
cannot decrypt or spend your funds.

Like any other cryptocurrency wallet, you are responsible for managing your own
keys. Back up your 12-word mnemonic and keep it safe.

When you first open the portfolio page or try to trade, bitCaster asks you to set up a wallet. You can create a new wallet (auto-generated locally in your browser) or import an existing wallet using your 12-word recovery phrase. A Nostr signing key is also created or connected at this point. These are separate secrets. Back up both the wallet recovery phrase and the Nostr secret key shown in the app. If you already use a Nostr account, connect it instead of generating a new one.

## Market detail pages

The market chart shows recorded trades for each primitive outcome. If only one
outcome has traded, only that line is shown; bitCaster does not invent prices
for outcomes that have not traded. Before any confirmed trade, the market
shows **No trades yet** or an em dash.

The order book shows asks (sell orders) above the spread and bids (buy orders)
below it, with the best prices closest to the spread. Each row combines price,
cumulative depth, and visual thickness. Longer bars mean more cumulative
liquidity available at that price or better, normalized across both sides so
you can compare bid and ask depth at a glance. Market cards and detail pages
show **Bot Budget** for post-creation funded AMM markets; additional accepted
funding can increase it. It is not a live order-book liquidity number.

Trade comments are optional and public inside bitCaster. A comment is shown only after the attached order produces a settled trade, so the comment feed is limited to verified traders for that market. P20 comments are not published to public Nostr relays.

## Getting started

Ready to try it? Head to the [bitCaster app](https://frontend-bitcaster-staging.azurewebsites.net/) to start trading.

[^1]: Note that ecash tokens are not strictly self-custodial. See https://iscashucustodial.com/ or https://bitcoin.design/guide/how-it-works/ecash/introduction/, https://stacker.news/items/793450 for details.
