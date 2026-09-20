---
title: "bitCaster 101"
description: "What is bitCaster and what can you do with it?"
sidebar:
  order: 1
---

## What is bitCaster?

bitCaster is in development. There is no production deployment.
Do not use real funds with development or test instances.

bitCaster lets you buy and sell shares in the possible outcomes of an event.
For example, a market can ask whether Alpha, Beta, or Gamma will win an election.
In an ordinary market, each share in the winning outcome pays 1 sat.
Shares in losing outcomes pay nothing. Before the result is known, trade
prices can rise or fall. A correct prediction does not guarantee that you can
sell at a profit before the market resolves.

The browser serves casual participants and market creators. Professional and
automated traders can use the CLI, daemon, and SDK. Every client uses the same
order book and settlement protocol.

The browser app and protocol specifications are public. The matching engine
is closed source. Your wallet stores Cashu ecash tokens in your browser.
The web app can store an encrypted recovery copy that the server cannot
decrypt. See [Encrypted wallet backup](/user-guide/getting-started/wallet-backup/)
for its limits.

For an overview of Cashu itself, see the [Bitcoin Design guide on ecash](https://bitcoin.design/guide/how-it-works/ecash/introduction/).

## What you can do

### Buy and sell market shares

Choose a market, an outcome, and how many shares to buy or sell. Review the
price and fees before you confirm. Price protection sets a maximum buy price
or a minimum sell price. You can change this limit. Your order fills in full
within the limit or does not fill. It does not stay on the order book for later.
Markets can have two outcomes, such as Yes and No, or up to eight named
outcomes. You can fund your wallet through a Lightning invoice or with an
existing Cashu token from the supported mint. The app shows amounts in sats.
Small amounts can have decimal places. Compact balance and market summaries
show these digits in smaller text. The amount stays exact.

Check the selected outcome before confirming. In the example above, Alpha
means that Alpha wins. Not Alpha means that Beta or Gamma wins.

### Create your own market

Define the question, the possible outcomes, and how the result will be decided.
Market creation does not require a funding payment or an opening probability.
It does not set a market price.

You can fund the market-making bot after creation. You can add funding more
than once. This funding is a non-refundable subsidy, not an investment that
gives you shares, fees, or a right to withdraw. Keep it separate from funding
your own trading wallet. If there is no available liquidity, the trade form
directs you to the Liquidity tab.

### Become an oracle

In prediction markets, the value of a token depends on what actually happens in the real world. An oracle is the referee that determines that real-world outcome — which can sometimes be ambiguous.
Anyone can become an oracle. The oracle is designated when a market is created and cannot be changed afterward.
A valid oracle signature identifies who signed the result. It does not prove that the result is true. bitCaster does not provide an oracle trust score. See [Resolution](../../core-concepts/resolution/) for details.

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

Enter a whole number of shares. Review the quote payment, itemized fees, and
total payment or net proceeds before you submit. For example, buying 50 shares at 30.0%
costs 15 sats before settlement fees. Those shares pay 50 sats if they win.
The displayed percentage is a trade price, not a guarantee about the event.

When the event resolves, winning tokens can be redeemed. Losing tokens have
no payout. You rely on the oracle to report the result correctly and on the
mint to honor redemptions. If the mint stops service, trading or redemption
can be delayed. Holding your wallet keys does not remove this mint risk.

Cashu protects token ownership from the mint at the protocol level. It does
not make all app activity anonymous. The matching engine can associate your
authenticated activity with your account. Encrypted backup protects wallet
contents; it does not hide all account or activity metadata.

## Your assets, your responsibility[^1]

Your tokens are just signed data. The live wallet database is in your browser's
local storage. The default web app also keeps an encrypted recovery copy whose
contents the server cannot read.

This minimizes the wallet information held by the server. The encrypted-backup
service can still observe limited account, size, and activity metadata. It
cannot decrypt or spend your funds.

Like any other cryptocurrency wallet, you are responsible for managing your own
keys. Back up your 12-word mnemonic and keep it safe.

Before your first wallet action, choose Create wallet or Restore wallet.
A new wallet is generated locally in your browser. To restore a wallet, enter
a valid 12-word recovery phrase. Setup does not submit a payment automatically.
Recovery-phrase and backup controls are available only when a wallet exists.

Your Nostr signing key is a separate secret. Back up both the wallet recovery
phrase and any Nostr secret key shown in the app. If you already use a Nostr
account, connect it instead of generating a new one.

## Find a market

Use search, tags, and filters on the market list. The controls stay available
while results load, when loading fails, and when no markets match. Use
**Clear all** to remove the search text, selected tags, and filters.

Tag counts and advanced filters apply to the loaded results, not the whole
catalogue. Load more results when you need to look further.

## Market detail pages

The market chart shows recorded trades for each primitive outcome. If only one
outcome has traded, only that line is shown; bitCaster does not invent prices
for outcomes that have not traded. Before any confirmed trade, the market
shows **No trades yet** or an em dash.

If the service cannot read confirmed-trade prices, market details are
temporarily unavailable. Try again later. This error does not mean that the
market is missing or has no trades.

The order book shows asks (sell orders) above the spread and bids (buy orders)
below it, with the best prices closest to the spread. Each row combines price,
cumulative depth, and visual thickness. Longer bars mean more cumulative
liquidity available at that price or better, normalized across both sides so
you can compare bid and ask depth at a glance. Market cards and detail pages
show **Total funding** after receive fees for funded markets. New confirmed
payments increase it. Trades do not reduce it. It is not current order-book
liquidity.

Trade comments are optional and public inside bitCaster. A comment is shown only after the attached order produces a settled trade, so the comment feed is limited to verified traders for that market. P20 comments are not published to public Nostr relays.

## Getting started

Before you fund a wallet, read
[Encrypted wallet backup](/user-guide/getting-started/wallet-backup/).
Keep your recovery phrase safe. Then review the market's question, oracle,
and resolution rules before your first trade. Optional market creation and
bot funding can wait until you understand the trading flow.

[^1]: Note that ecash tokens are not strictly self-custodial. See https://iscashucustodial.com/ or https://bitcoin.design/guide/how-it-works/ecash/introduction/, https://stacker.news/items/793450 for details.
