---
title: "LMSR Bot & Creator Funding"
description: "How bitCaster bootstraps market liquidity with a creator-funded, bounded-loss LMSR bot on top of the CLOB."
sidebar:
  order: 3
---

# LMSR Bot & Creator Funding

This page covers bitCaster's automated market-making bot. For the human and professional market-maker trading model, online requirements, mint matching, and fee policy, see [Trading Model & Human Market Makers](/technical/architecture/trading-model/).

## The Cold-Start Problem

New prediction markets start with empty order books. Traders avoid empty markets, and market makers avoid markets with no traders. bitCaster lets the market creator fund a bot that posts initial bids and asks on the existing CLOB.

Creator funding is attribution-only. It is not a withdrawable balance, LP share, P&L claim, or right to residual inventory. The deposit is non-refundable; after resolution, any residual collateral from the bot account is booked as operator income.

## Why LMSR

bitCaster uses a Logarithmic Market Scoring Rule (LMSR) strategy for the funded bot.

| Design | Why it loses for v1 |
|--------|---------------------|
| CPMM/FPMM | Simple, but creator loss is path-dependent and liquidity economics degrade near terminal outcomes. |
| External liquidity rewards | Native to a CLOB, but requires professional makers before launch. |
| Inventory-only quoting without a cost function | Easy to implement, but cannot provide a defensible creator loss bound. |
| LMSR | Gives a hard budget-derived loss bound, supports categorical atom pricing, and can be sampled into CLOB limit orders. |

The creator budget determines the LMSR liquidity parameter. Creators choose a budget tier, not `b` directly.

## Funding Flow

1. The creator registers the market and reaches the post-create funding screen.
2. The creator chooses No liquidity, Minimal, Standard, Deep, or a Custom budget.
3. If funded, the deposit is sent with `fundAmm=true`, the creator pubkey, the market unit, and the creator's outcome probability distribution.
4. The wallet service earmarks the first funding deposit as the market-maker budget. First funding wins; later funding deposits are credited as plain collateral because v1 has no top-up path.
5. The funded collateral is split into complete-set conditional-token inventory.
6. The bot quotes from the LMSR curve only after the complete-set split succeeds.

Sat markets use sats. USD markets use US cents. Field names in some APIs still say `Sats` for backward compatibility; in this context they mean base-asset subunits.

## Pricing State

LMSR prices are computed from:

- creator seed q, derived from the creator's registered probabilities;
- terminal q, reconstructed from settled bot trades;
- pending q, reconstructed from in-flight locked swaps.

Seed q is pricing-only. It is not booked as filled inventory, settlement exposure, or terminal ledger state.

For probabilities `p_i`, the seeded loss bound sizes:

```
b = effective_budget / -ln(min(p_i))
```

Creator probabilities below the accepted floor are rejected instead of clamped.

## CLOB Quoting

The bot samples the continuous LMSR curve into a ladder of CLOB limit orders. When fills move q across a level boundary, the bot cancels and reposts its ladder. Categorical markets use one LMSR over atomic outcomes; collection prices are sums of their member atoms.

The bot never goes short. Funding first creates complete-set inventory, and later proceeds can be re-split into more complete sets. In-flight NUT-11 locks are counted as unavailable inventory until they settle, refund, or fail.

## Close-Out

After the oracle attests an outcome, the bot stops quoting, waits for or force-abandons stale pending swaps according to the operator policy, redeems all outcome inventory at the mint, and books residual collateral as operator income. The market creator has no withdrawal or residual claim.
