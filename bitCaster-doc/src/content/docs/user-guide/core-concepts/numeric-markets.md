---
title: Numeric Markets
description: How numeric outcome markets work in bitCaster
---

# Numeric Markets

Numeric markets let you bet on the future value of something — like the price of Bitcoin on a specific date. Unlike YES/NO markets where outcomes are simple categories, numeric markets have a range of possible values.

## How They Work

A numeric market defines a range `[lo_bound, hi_bound]`. When the oracle attests a value `V` within that range:

- **HI token holders** receive a proportional payout based on how close `V` is to `hi_bound`
- **LO token holders** receive the complementary payout

For example, with range `[0, 100000]` and attested value `V = 20000`:
- HI holders get 20% of the share face
- LO holders get 80% of the share face

## BTC-Only

Numeric markets on bitCaster use **Bitcoin (sats)** as the base asset. This is a deliberate design choice:

- Numeric markets need very fine price precision (up to 0.0001%)
- Achieving this precision with fiat currencies would require sub-cent ecash units, which add complexity and compatibility issues
- BTC's `msat` (millisatoshi) unit is natively supported by the Cashu protocol and provides enough granularity

### What This Means for You

- **Payout per share**: 1,000 sats (~$0.60 at $60k BTC price)
- **Price precision**: 0.0001% per tick
- **Minimum trade**: affordable for most users

## Creating a Numeric Market

When you create a numeric market:

1. Choose the outcome range (e.g., BTC price $0–$100,000)
2. Fund the market maker with sats
3. Traders can buy HI or LO tokens based on their price prediction

## Why Not Fiat Numeric Markets?

Fiat-denominated numeric markets would need either very large payouts per share (too expensive for small traders) or sub-cent ecash units (complex and error-prone). We may add fiat support in the future if there's enough demand, but for now BTC-only keeps things simple and accessible.
