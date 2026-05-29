---
title: "CPMM Bot & Initial Liquidity"
description: "Design rationale for CPMM-based initial liquidity on bitCaster's CLOB, including caveats for HI/LO numeric markets."
sidebar:
  order: 3
---

# CPMM Bot & Initial Liquidity

This page covers the automated CPMM bot used to bootstrap a new market. For the human/professional market-maker trading model, online requirements, mint matching, and fee policy, see [Trading Model & Human Market Makers](/technical/architecture/trading-model/).

## The Cold-Start Problem

New prediction markets start with empty order books. No one wants to trade in a market with no liquidity, and no market maker wants to provide liquidity in a market with no traders. bitCaster solves this by allowing market creators to deposit initial liquidity that is automatically managed by a **Constant Product Market Maker (CPMM)** — a virtual market maker that places limit orders on the existing CLOB.

## Why CPMM

Several AMM designs exist for prediction markets:

| Design | Pros | Cons |
|--------|------|------|
| **CPMM (x·y=k)** | Simple math, dynamic liquidity, proven (Gnosis FPMM) | Capital-inefficient at extremes, unbounded LP loss |
| **LMSR** | Bounded worst-case loss, strong academic backing | Requires log/exp approximations, no dynamic crowdfunding |
| **pm-AMM** | Concentrates liquidity at mid-range, constant LVR | Complex, newer/less proven |

bitCaster uses CPMM for V1 because:

1. **Simplicity** — elementary arithmetic, no log/exp
2. **Dynamic liquidity** — creators can add or withdraw liquidity at any time
3. **Proven** — [Gnosis FPMM](https://github.com/gnosis/conditional-tokens-market-makers) powers Omen and was the precursor to Polymarket's early AMM phase
4. **Polymarket precedent** — [started with AMM, migrated to CLOB](https://phemex.com/news/article/polymarket-shifts-from-amm-to-clob-to-enhance-liquidity-in-prediction-markets-28317) in late 2022. AMM is good for cold-start; CLOB is better for mature markets. bitCaster's design gets the benefits of both.

## How It Works

### CPMM as Virtual Market Maker on CLOB

The CPMM does **not** replace the CLOB. Instead, it acts as a virtual participant that places GTC (Good Till Cancelled) limit orders on the existing order book at prices derived from the x·y=k formula.

```
Reserves: (x, y) where x = outcome A tokens, y = outcome B tokens
Invariant: x · y = k
Implied price of A: p_A = y / (x + y)
```

The continuous CPMM curve is discretized into a ladder of ~20 limit orders (10 bids, 10 asks) around the current midpoint. When orders are filled by real traders, the CPMM recalculates its reserves and replaces all orders based on the new state.

From a trader's perspective, CPMM orders are indistinguishable from orders placed by human market makers. The matching engine's CLOB logic is unchanged — CPMM orders participate in both complementary and mint matching like any other GTC limit order.

### Market Creation Flow

1. Creator fills the market creation wizard (oracle, outcomes, liquidity amount)
2. Frontend registers the condition and partition with CDK mintd
3. Frontend registers the market with the matching engine
4. Creator funds the CPMM bot through the deposit flow (Lightning invoice or Cashu token)
5. The deposit is verified, the complete CTF outcome-token inventory is minted, and the bot account is credited
6. Matching engine creates or updates the CPMM pool and places initial limit orders

As real traders arrive and professional market makers join, the CPMM's share of the book decreases naturally. The creator can withdraw CPMM liquidity at any time.

## YES/NO Binary Markets

For binary markets, the CPMM is straightforward:

- **Reserves**: `(x_YES, x_NO)`
- **Price of YES** = `x_NO / (x_YES + x_NO)` — this directly represents the market's implied **probability** of the YES outcome
- **Price of NO** = `x_YES / (x_YES + x_NO)` = 1 - Price of YES
- **Conservation**: 1 YES + 1 NO = 1 sat of collateral

Example: a creator deposits 10,000 sats with 50/50 initial probability. The CPMM starts with reserves (10000, 10000), k = 100,000,000. The midpoint price is 50, and limit orders are placed from ~40 to ~60.

## HI/LO Numeric Markets

[NUT-CTF-numeric](/technical/nut-ctf/numeric-outcomes/) defines numeric conditions with exactly two outcome collections — **HI** and **LO** — representing the high and low ends of a range `[lo_bound, hi_bound]`. Both token holders receive proportional redemption based on where the attested value falls in the range.

The CPMM works identically for HI/LO markets — it's still two tokens with 1 HI + 1 LO = 1 sat of collateral. However, there are important caveats:

### Caveat 1: Price Semantics Differ

In a YES/NO market, the price directly represents a **probability** (e.g., 60 = 60% chance of YES).

In a HI/LO market, the price represents the **expected normalized payout ratio**:

```
HI price = E[(clamped_V - lo_bound) / (hi_bound - lo_bound)]
```

For example, in a BTC price market with range [$50,000, $100,000]:
- HI price of 40 means the market expects BTC at approximately $70,000
- This is the expected value, not a probability of a discrete outcome

The UI must clearly communicate this distinction to traders.

### Caveat 2: Information Compression

A 2-token scalar market compresses the entire probability distribution into a single number (the expected normalized value). This means:

- A trader who thinks "BTC will be exactly $70,000" and a trader who thinks "50% chance of $40,000, 50% chance of $100,000" both value HI tokens the same way (both imply HI price ≈ 40)
- The market cannot express beliefs about **variance**, **skew**, or **multimodality**
- This is an inherent limitation of 2-outcome scalar markets, not specific to the CPMM

For richer distributional information, market creators could set up multiple threshold markets (e.g., "BTC > $60k", "BTC > $70k", "BTC > $80k") instead of a single HI/LO market.

### Caveat 3: LP Loss Profile (Actually Better Than Binary)

In binary markets, at resolution one token → 0 and the other → 1. LPs face catastrophic "endgame bleed" as informed traders drain the valuable token from the pool.

In scalar markets, **both HI and LO retain value** at settlement (proportional payout) unless the attested value hits a range boundary. The LP's loss is proportional to how far the actual value is from the CPMM's implied expectation. This makes scalar markets more LP-friendly than binary markets.

### Caveat 4: Range Selection Matters

Poorly chosen bounds waste LP capital:

- **Range too wide** (e.g., [0, 1,000,000] for BTC price): most of the CPMM's capital is deployed at unrealistic price levels, providing liquidity no one needs
- **Range too narrow** (e.g., [69,000, 71,000]): if the actual value is outside the range, one token goes to 0 (same as binary endgame bleed)
- **Best practice**: set bounds to cover approximately the 5th–95th percentile of expected outcomes

## Known Limitations

### Capital Inefficiency at Extremes

The CPMM deploys capital uniformly across all price levels. When the market price is near 0% or 100%, most capital sits idle at unrealistic levels. This is acceptable for bootstrapping since professional market makers will provide better pricing at extremes.

### Adverse Selection

Informed traders systematically trade against the CPMM when it misprices outcomes, extracting value from the liquidity pool. This is the fundamental cost of providing automated liquidity. Mint fees and any maker surplus from price improvement may partially offset this cost, but v1 does not insert the matching engine into the Cashu atomic swap to collect a separate in-swap fee.

### Endgame Bleed

As a market approaches resolution and the outcome becomes more certain, the CPMM's mispriced orders get picked off by informed traders. This is more severe for binary markets than for scalar markets (see Caveat 3 above). Future versions may taper CPMM liquidity as expiry approaches.

## Future Directions

- **pm-AMM**: [Paradigm's prediction market AMM](https://www.paradigm.xyz/2024/11/pm-amm) concentrates liquidity around mid-range prices and maintains constant expected LVR over time
- **LMSR**: may be more appropriate for markets with many outcomes (categorical markets)
- **Dynamic liquidity tapering**: reduce CPMM depth as market expiry approaches to limit endgame bleed
- **Multiple threshold markets**: for numeric outcomes, offer a set of binary threshold markets (e.g., "BTC > $60k", "BTC > $70k") as an alternative to HI/LO for better distributional information
