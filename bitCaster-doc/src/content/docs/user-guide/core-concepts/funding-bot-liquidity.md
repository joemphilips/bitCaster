---
title: "Funding Bot Liquidity"
description: "How a market creator can fund the LMSR market maker after creating a market."
sidebar:
  order: 5
---

# Funding Bot Liquidity

When a market is created, the order book starts empty. To give early traders a counterparty, bitCaster can run an automated LMSR market maker that posts sampled bid and ask orders to the book.

Funding is optional. After the market is created, the wizard shows a funding screen where you can choose **No liquidity**, **Minimal**, **Standard**, **Deep**, or a custom budget.

## What You Fund

The deposit becomes the market maker's budget for that market. It is split into complete-set conditional-token inventory and used to quote from an LMSR curve. The creator chooses the funding budget and the initial outcome probabilities; the system derives the curve depth from those values.

The deposit is **non-refundable**. It is committed to market-making until the market resolves. After resolution, any residual inventory or remaining collateral becomes operator income. The maker's loss is bounded by the funded budget; there is no withdrawal or creator profit-share claim.

Sat markets use sats. USD markets use US cents. Some API fields still use legacy names such as `amountSats`; in funding contexts those names mean base-asset subunits.

## Funding Flow

1. Create the market.
2. Choose a funding tier or choose No liquidity.
3. If funding, pay the Lightning invoice shown by the wizard.
4. The wallet service credits the deposit, creates complete-set inventory, and starts quoting once the split succeeds.

Only the first funding deposit is used as the market-maker budget in v1. Later deposits are credited as plain collateral because there is no top-up path yet.

## If You Close the Wizard

Closing the wizard does not undo the market. The market remains created and can still accept human orders. If you selected No liquidity, or if funding has not completed yet, the automated maker will not quote until the funding flow is completed.

## Trade-Offs

Smaller budgets create thinner quotes and can move more quickly when informed traders trade against the maker. Larger budgets create deeper quotes, but they also put more non-refundable capital at risk. Creator probabilities matter: they set the maker's initial LMSR prices and therefore where the first quotes appear.
