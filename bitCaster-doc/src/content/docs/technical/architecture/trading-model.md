---
title: "Trading Model & Human Market Makers"
description: "How bitCaster CLOB orders settle, how mint matching works, and what human market makers must keep online."
sidebar:
  order: 2
---

# Trading Model & Human Market Makers

bitCaster uses a central limit order book (CLOB). Limit orders rest on the book, market or crossing limit orders take liquidity, and settlement happens peer-to-peer with Cashu CTF atomic swaps.

Terminology matches Polymarket CTF Exchange V2: **Complementary** = Buy vs Sell for the same outcome set, **Mint** = Buy vs Buy for exactly complementary outcome sets (maker mints a complete CTF set as the splitter), **Merge** = Sell vs Sell that combines into a complete set (not yet supported in bitCaster).

Public trading books are primitive outcome books. A categorical market with outcomes `A`, `B`, and `C` exposes `A / Not A`, `B / Not B`, and `C / Not C` books; clients submit to `condition-A`, `condition-B`, or `condition-C` and choose the selected token or its one-vs-rest complement in the order body. Compound ids such as `B|C` remain internal settlement and mint keyset identifiers, not public market routes.

The market-detail trade ticket is share-based. Users enter a whole number of shares and the ticket shows a cost breakdown before submission: **Quote payment** for the matched order amount, **Est. settlement fee** for the estimated mint fee, and **Total** for the sum. The UI no longer shows separate payout or executable-share rows. If the wallet needs funds, the top-up action names the required unit: **Top up sats wallet**. Categorical markets use `D=10000`, so a price numerator `k` means `k / 10000`; one categorical-market share pays **10 sats** if it wins. Numeric markets use `D=1000000`. All market collateral is accounted in **msat**.

The market-detail order book combines price, cumulative depth, and visual thickness into one row per price level. Bar length represents cumulative liquidity available at that price or better, which makes the depth profile visible without a separate chart.

## Online Requirement

A resting limit order is an online commitment. The maker must keep a browser tab or bot process connected until the order is filled, cancelled, or expired. When a taker matches the order, the maker must be able to answer the TradeHub messages and lock proofs before the swap timeout.

Once the matching engine commits a match, the matched quantity is removed from the book. If the later wallet-level atomic swap times out or fails, that quantity is not automatically re-rested; makers should treat live orders as committed liquidity and cancel stale orders before they become unavailable.

Professional market makers should run a bot rather than rely on an occasional browser session. `bitcaster-cli` uses `bitcaster-daemon` as its long-running wallet and swap process so non-browser makers can participate without changing the wire protocol.

## Complementary Matching

Complementary matching is the usual buy-versus-sell flow for the same outcome set:

- Seller locks outcome proofs for the buyer.
- Buyer locks msat collateral proofs for the seller.
- Adaptor signatures make the two mint spends atomic.

The seller's token locktime must be longer than the buyer's collateral locktime by the configured safety delta. This gives the buyer time to extract the adaptor secret after the seller spends.

## Mint Matching

Mint matching pairs buy orders for exact complementary outcome sets. In a binary market, `YES` and `NO` are complementary. In a categorical market with outcomes `A`, `B`, `C`, the singleton `A` pairs with `B|C`; `B` pairs with `A|C`; and `A|B` pairs with `C`.

The maker first tries to settle from local outcome inventory:

1. If the exact complementary collection is available locally, for example `B|C`, the maker locks that collection into the normal seller atomic-swap branch.
2. If the exact collection is not available but all primitive complement legs are available, for example `B` plus `C`, the maker locks each primitive leg. The trade uses one seller opening containing all locked proof groups; it does not first convert `B` and `C` into `B|C`.
3. If local inventory is insufficient and the order has a CLI/daemon pre-flight split reservation, the maker uses the reserved lock side and releases the matched keep side.
4. Otherwise, the maker selects regular collateral in the market's subunit, asks the mint to split it into the needed complementary CTF collections, keeps their desired outcome set, and locks the taker's outcome set.
5. The taker pays through the normal buyer branch using the same market collateral subunit.

This is why mint settlement does not require the maker to already own the exact complementary token. The maker can settle from exact inventory, primitive complement inventory, a prepared reservation, or enough regular collateral to split at match time, including mint input fees.

## Pre-Flight Split and Local Reservation

For resting limit buys that can become mint maker orders, the CLI/daemon can optionally perform a pre-flight split. Before the order rests, the client splits regular collateral proofs into the needed CTF outcome collections, stores the resulting outcome proofs locally, and reserves the keep and lock sides for that order. The browser GUI does not pre-split; it checks whether the wallet has enough total collateral (`canBackOrder`) and submits the order directly, deferring the mint split to settlement time.

This keeps the live order honest: if the wallet cannot select enough regular collateral, the client should fail the submission instead of leaving a maker quote that cannot settle. When a mint taker later matches the order, the maker locks only the matched amount of the reserved side and releases only the matched amount of the kept side as an active position. Remaining reserved proofs stay attached to the unfilled order quantity.

Pre-flight is a CLI/daemon option, not a protocol requirement: at match time local exact inventory and local primitive complement inventory are preferred before reserved pre-flight proofs. The browser GUI accepts the settlement-failure risk in exchange for a simpler user experience — if collateral is spent elsewhere before a match, the settlement fails and the maker is penalized by the participation-score system.

## Fees and Maker Surplus

First-release fee policy is fee-first with maker surplus:

- The mint may charge a constant swap/input fee.
- The taker must fund the quoted payment plus the mint fees needed for their side.
- If a taker crosses a better resting maker price, the maker can retain the price improvement as surplus.
- The matching engine does not take a separate in-swap fee in v1 because inserting itself into the Cashu atomic swap would complicate the non-custodial protocol.

Example: if a maker rests `Buy YES 50 / 100` and a taker submits `Buy NO 49 / 100`, the exact surplus/fee treatment depends on the execution-price rule, but the maker can be credited with the price improvement after mint fees are paid.

## Operational Guidance

Human makers should keep only the collateral they are willing to commit to live orders in the wallet, cancel orders before going offline, and expect the browser to fail settlement if the tab is closed mid-trade. Bot and daemon makers should monitor stale orders, swap failures, reserved inventory, and mint fee changes.

## Comparison to Polymarket CTF Exchange V2

bitCaster's match-type taxonomy mirrors Polymarket CTF Exchange V2 — Complementary for Buy vs Sell, Mint for Buy vs Buy, Merge for Sell vs Sell — but the settlement model is fundamentally different. Polymarket V2 settles on Ethereum through a batched on-chain operator transaction. bitCaster settles peer-to-peer with Cashu atomic swaps. The taxonomy carries over from on-chain to off-chain, but several behaviors do not.

### No batching, by design

Polymarket V2 batches matches into a single on-chain transaction because each transaction has a fixed base gas cost; batching amortizes that cost across many fills. bitCaster has no shared cost to amortize. Each atomic swap is a peer-to-peer interaction with the mint, paying only the mint's per-proof input fee. Batching multiple matches into one settlement event would not lower per-fill fees.

The advantages that follow are concrete. The protocol is simpler — no batch-construction step on the operator side, no batch-revert semantics, no per-batch nonce. A match either fires the atomic swap or fails. Latency is lower because the matching engine fires fills as the book crosses, where Polymarket's operator typically delays for economic reasons even though the protocol does not require waiting.

### Mint: maker-side splitter

In Polymarket V2 Mint, the exchange contract takes USDC from both buyers and calls `ConditionalTokens.splitPosition` atomically with the trade. Gas for the split is socialized through the transaction.

In bitCaster Mint, the maker supplies the complementary CTF side. They may already hold the exact complement, hold all primitive complement legs, use an order-local pre-flight reservation, or split regular collateral proofs from their own wallet at match time. Two consequences follow. First, if the maker has to split and the taker fails to complete, the maker can be stuck with unwanted complement inventory until they find another counterparty or pay another mint fee to merge back. Polymarket's atomic on-chain trade has no equivalent stuck-inventory failure mode. Second, the mint input fee falls on the maker — Polymarket's `splitPosition` gas is socialized through the on-chain transaction, but bitCaster's per-proof fee is paid by whoever submits the split. This is a real economic asymmetry: bitCaster makers carry the cost of supplying complete-set inventory.

The CLI/daemon pre-flight split policy partially mitigates this by letting makers split before the order rests, holding both sides of the complete set as reserved inventory. This trades held capital for settlement certainty: no mint-unavailable race at fill time, but the maker is committing collateral to a quote that may not fill.

### Atomicity model

Polymarket atomicity comes from Ethereum. The exchange transaction commits both legs of the match or commits neither. There is no in-between state.

bitCaster atomicity comes from Schnorr adaptor signatures over NUT-11 P2PK spending conditions, with locktime and refund pubkey on the locked proofs. The two parties' mint spends become atomic through the adaptor relationship, not through a shared transaction. The cost is that a party going offline mid-swap during the locktime window leaves a partial-lock-held state. The locked proofs are recoverable after locktime via the refund key, but until then they are economically frozen. Polymarket has no equivalent failure mode.

### Merge: deferred by design, not infeasible

Polymarket V2 Merge (Sell vs Sell) is a natural extension of the on-chain split primitive — `ConditionalTokens.mergePositions` is the inverse of `splitPosition`, and gas is socialized through one transaction.

bitCaster does not currently support Merge. Off-chain Sell vs Sell is doable as a sequence of atomic-swap legs, but each leg pays its own mint input fee, so the maker-as-merger pattern is less obviously net-positive than the maker-as-splitter pattern is for Mint. Whether the demand justifies the per-leg cost is an open question; the absence of Merge is a deferral pending real trading data, not a protocol limitation.

### Pre-flight split has no Polymarket analogue

In Polymarket V2 the mint happens atomically with the trade, so there is no maker-held inventory model to pre-populate. In the off-chain model the maker holds inventory locally, and the CLI/daemon's pre-split option substitutes wallet-side capital commitment for at-match-time mint availability. Pre-flight split is therefore a bitCaster-specific reliability optimization for the CLI/daemon, addressing a failure mode that does not exist on-chain. The browser GUI defers all splitting to match time.

### Summary

The match-type taxonomy is portable from Polymarket V2. The settlement model is not. bitCaster gains protocol simplicity and immediate fire-on-cross matching; it accepts maker-side inventory risk for Mint, a partial-lock recovery surface from off-chain atomicity, and a deferred Merge implementation.
