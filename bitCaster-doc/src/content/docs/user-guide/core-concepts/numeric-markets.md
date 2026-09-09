---
title: Numeric Markets
description: The planned numeric outcome model, which is not available for trading
---

# Numeric Markets

Numeric market creation and trading are not available in the current product.
The page below describes the planned numeric outcome model for protocol readers.
Do not submit `numeric` market creation requests or expect numeric trade prices
until the product publishes a supported numeric trade representation.

The planned numeric model uses a measured result, such as the Bitcoin price
on a specified date. A categorical market uses named outcomes instead.

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

### Planned Share Face

The planned share face is 1,000 sats. This is not a fixed payout for each HI
or LO share. The result determines each payout fraction. In the example above,
one HI share pays 200 sats and one LO share pays 800 sats, before mint fees.
These payout amounts are not purchase prices.

The planned price unit is 0.0001% of the share face. This does not mean that
trading at every such price will be available. Numeric trading is not supported
in the current release.

## Creating a Numeric Market Later

When numeric markets become available in a later release:

1. Choose the outcome range (e.g., BTC price $0–$100,000)
2. Register the market without an opening probability or pre-create funding
3. Fund the market maker through the separate post-creation flow
4. Traders can buy HI or LO tokens based on their price prediction

## Why Not Fiat Numeric Markets?

Fiat-denominated numeric markets would need either very large payouts per share
or sub-cent ecash units. The product does not support fiat collateral. Sat-only
collateral keeps the product boundary simple and explicit.
