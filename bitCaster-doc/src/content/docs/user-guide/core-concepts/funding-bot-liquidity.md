---
title: "Funding Bot Liquidity"
description: "How a market creator can fund initial LMSR AMM liquidity after creating a market."
sidebar:
  order: 5
---

# Funding Bot Liquidity

When a market is created, the order book starts empty. To give early traders a counterparty, bitCaster can run an automated market maker (AMM) that posts initial bid and ask orders to the book.

Funding is optional. After the market is created, the wizard shows a funding screen where you can choose **No liquidity**, **Minimal**, **Standard**, **Deep**, or a custom budget. Binary-market presets use round amounts: **$100 / $1,000 / $5,000** for USD markets and **10,000 / 100,000 / 500,000 sats** for sat markets. Categorical markets scale those paid tiers by `log2(outcome count)`.

The wizard previews the selected budget as estimated starting depth: roughly how many price levels the bot can post per side and roughly how many shares appear at each level. The preview is before mint fees, so actual quoted depth can be lower.

## What You Fund

The deposit becomes the AMM budget for that market. The AMM currently uses an LMSR strategy, which turns the creator's budget and initial outcome probabilities into starting quotes on the CLOB.

Market cards and detail pages show this committed amount as **Bot Budget**. It is a static funding number for the automated maker, not a live liquidity or remaining-inventory indicator.

The deposit is **non-refundable**. It is committed to market-making until the market resolves. The maker's loss is bounded by the funded budget; there is no withdrawal, residual claim, or creator profit-share claim.

Sat markets are shown to users in sats. USD markets are shown in dollars or cents. Internally and on public market-summary `*Subunits` wire fields, sat-market collateral is accounted in **msat**, and USD-market collateral is accounted in standard **usd** cents. Protocol fields that still explicitly use `amountSats`, such as participation-score ecash payment fields, keep their contract-specific meaning.

## Funding Flow

1. Create the market.
2. Choose a funding tier or choose No liquidity.
3. If funding, pay the Lightning invoice shown by the wizard.
4. The wallet service credits the deposit and starts quoting after the market-maker budget is ready.

Only the first market-maker funding deposit is used as the Bot Budget in v1. Later wallet top-ups are credited as plain trading collateral; they do not increase the market's Bot Budget.

## If You Close the Wizard

Closing the wizard does not undo the market. The market remains created and can still accept human orders. If you selected No liquidity, or if funding has not completed yet, the automated maker will not quote until the funding flow is completed.

## Trade-Offs

Smaller budgets create thinner quotes and can move more quickly when informed traders trade against the maker. Larger budgets create deeper quotes, but they also put more non-refundable capital at risk. Creator probabilities matter because they set where the first LMSR quotes appear.

AMM liquidity is mainly for bootstrapping. In the long run, active human and professional market makers should provide tighter, more informed liquidity than the initial automated quotes.
