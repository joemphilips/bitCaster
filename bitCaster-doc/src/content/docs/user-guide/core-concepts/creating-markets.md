---
title: 'Creating Markets'
description: 'How anyone can create a prediction market, and what you take on when you do.'
sidebar:
  order: 4
---

On most prediction markets, the operator decides which markets exist. On bitCaster anyone can create a market, on any topic, at any time.

Try it on the [creator page](https://bitcaster.market/creator).

## What you provide

Start with a question and its possible outcomes. A Yes/No market needs nothing more. Otherwise, name up to eight outcomes.

Then write the resolution criteria, the rules for deciding the result. Be precise here. "Will it rain in Tokyo on July 1st?" sounds clear until you ask how much rain counts, and measured where. Traders are betting on your wording, so name the source you will use.

Finally, set an end time for trading. You can also add an image.

## You are the oracle

When you create a market, you promise to report its result. That promise is signed with your Nostr private key and published, and the market is tied to it for good.

Three things follow. The key has to be stored in the browser, because a signing extension cannot sign results. You need to [back it up](/technical/reference/wallet-recovery/#back-up-your-nostr-key-separately), because without it you cannot report the result. And you must never sign two different results for the same market, because doing so exposes your private key.

Traders will judge the market by your name. See [Market resolution](/user-guide/core-concepts/resolution/).

## What it costs

The mint can charge a registration fee, and the app shows it before you pay. You do not choose an opening price and you do not have to put up any liquidity.

## Getting trading started

A new market has an empty order book, so nobody can trade yet. You can fix that by [funding the market maker](/user-guide/core-concepts/funding-bot-liquidity/), a bot that posts buy and sell orders. It is optional, anyone can do it, and it is not refundable.

Refunds, and a share of the fee income for funders, are planned for a later release.

## After the event

Trading stops when you report the result or when the end time passes. Report the result from **Your Markets** on the [creator page](https://bitcaster.market/creator). Winners can then cash out.

## Further reading

[Market creation: limits, resume, and oracle backup](/technical/reference/market-creation/) covers the input limits, how to resume an interrupted creation, and how to restore an oracle on another device.
