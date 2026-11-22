---
title: 'Funding the Market Maker'
description: 'What the market-making bot does, and what you get (and do not get) when you fund it.'
sidebar:
  order: 5
---

A market is only useful if there is someone to trade with. bitCaster can run a market-making bot for each market. The bot posts buy and sell orders, so traders can get in and out from the first minute. It needs money to do that, and funding is how it gets it.

## It is a subsidy, not an investment

Funding is **non-refundable**. It gives you no shares, no fee income, and no right to withdraw. The bot is expected to spend its budget paying the traders who move the price toward the truth, and whatever is left when the market closes goes to the operator.

So fund a market because you want it to exist and to be liquid, not to make money from the funding. If you want money to trade with, deposit to your own wallet.

Withdrawing your funding and earning a share of the fees are planned for a later release.

## How to fund

Right after you create a market, the app offers to fund it, and you can skip that step. Later, anyone can fund any [open market](https://bitcaster.market/markets) from its **Liquidity** tab, as often as they like. Amounts are in sats.

## What funding changes

The bot starts with every outcome at equal odds. The more funding it has, the more shares it can offer near the current price, and the less a single trade moves that price.

Funding does not set the market's price. The price you see always comes from the latest trade, so a market that has been funded but never traded still shows no price.

## Further reading

- [Market maker funding](/technical/reference/market-funding/) has the precise rules.
- [AMM liquidity for new markets](/technical/architecture/market-making/) explains the bot's pricing model.
