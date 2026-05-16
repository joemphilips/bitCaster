---
title: "Trading Model & Human Market Makers"
description: "How bitCaster CLOB orders settle, how complementary matching works, and what human market makers must keep online."
sidebar:
  order: 2
---

# Trading Model & Human Market Makers

bitCaster uses a central limit order book (CLOB). Limit orders rest on the book, market or crossing limit orders take liquidity, and settlement happens peer-to-peer with Cashu CTF atomic swaps.

## Online Requirement

A resting limit order is an online commitment. The maker must keep a browser tab or bot process connected until the order is filled, cancelled, or expired. When a taker matches the order, the maker must be able to answer the TradeHub messages and lock proofs before the swap timeout.

Professional market makers should run a bot rather than rely on an occasional browser session. A future `bitCaster-cli` should use the same swap protocol library as the browser and wallet-service so non-browser makers can participate without changing the wire protocol.

## Direct Matching

Direct matching is the usual buy-versus-sell flow for the same outcome set:

- Seller locks outcome proofs for the buyer.
- Buyer locks sats for the seller.
- Adaptor signatures make the two mint spends atomic.

The seller's token locktime must be longer than the buyer's sat locktime by the configured safety delta. This gives the buyer time to extract the adaptor secret after the seller spends.

## Complementary Matching

Complementary matching pairs buy orders for exact complementary outcome sets. In a binary market, `YES` complements `NO`. In a categorical market with outcomes `A`, `B`, `C`, the singleton `A` complements `B|C`; `B` complements `A|C`; and `A|B` complements `C`.

The maker acts as the splitter:

1. The maker selects regular sats collateral.
2. The maker asks the mint to split that collateral into the complete CTF outcome set.
3. The maker keeps their desired outcome set.
4. The maker locks the taker's complementary outcome set into the normal seller atomic-swap branch.
5. The taker pays sats through the normal buyer branch.

This is why complementary settlement does not require the maker to already own the taker's outcome token. The maker only needs enough regular collateral to create the complete set, including mint input fees.

## Fees and Maker Surplus

First-release fee policy is fee-first with maker surplus:

- The mint may charge a constant swap/input fee.
- The taker must fund the quoted payment plus the mint fees needed for their side.
- If a taker crosses a better resting maker price, the maker can retain the price improvement as surplus.
- The matching engine does not take a separate in-swap fee in v1 because inserting itself into the Cashu atomic swap would complicate the non-custodial protocol.

Example: if a maker rests `Buy YES 50 / 100` and a taker submits `Buy NO 49 / 100`, the exact surplus/fee treatment depends on the execution-price rule, but the maker can be credited with the price improvement after mint fees are paid.

## Operational Guidance

Human makers should keep only the collateral they are willing to commit to live orders in the wallet, cancel orders before going offline, and expect the browser to fail settlement if the tab is closed mid-trade. Bot makers should monitor stale orders, swap failures, inventory, and mint fee changes.
