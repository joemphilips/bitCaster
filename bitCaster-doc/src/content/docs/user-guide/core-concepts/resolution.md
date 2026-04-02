---
title: "Market Resolution"
description: "How bitCaster markets resolve using DLC oracles, and how winning tokens are redeemed."
sidebar:
  order: 2
---

# Resolution

When an event's outcome becomes known, the oracle publishes an **attestation** — an announcement of the result. This attestation lets the mint distinguish winning tokens from losing ones, and winning tokens become redeemable for their full face value.

This entire process is what we call market resolution.

## The Oracle Model

bitCaster reuses existing [DLC (Discreet Log Contract)](https://www.dci.mit.edu/projects/discreet-log-contracts) infrastructure for resolution. A DLC oracle doesn't need to know anything about bitCaster — it simply announces events and later publishes attestations, exactly as it would for any other DLC application.

- **No special integration required** — any standard DLC oracle can serve bitCaster markets.
- **Existing incentive structures carry over** — for example, if an oracle signs contradictory attestations (attesting to two different outcomes for the same event), this mathematically leaks the oracle's private key, destroying its ability to operate.
- **Transparent responsibility** — users always know exactly which oracle is responsible for each market's outcome. The oracle's public key and the event descriptor are visible before you place a trade.

## Our Approach to the Oracle Problem

In the context of prediction markets, the [oracle problem](https://chain.link/education-hub/oracle-problem) refers to the difficulty of determining what counts as the "correct answer."

bitCaster takes a different approach from existing blockchain-based DEXs.

Platforms like Polymarket rely on [UMA's optimistic oracle](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work), where outcomes can be disputed and ultimately decided by a token-holder vote. This approach has fundamental problems:

- **Dispute-and-voting doesn't solve the "Oracle Problem" — it obfuscates it.** Instead of a clearly identified party attesting to reality, you get a multi-layered governance process where responsibility is diffused.
- **Collusion risk** — if UMA token holders collude, they can steer outcomes. The cost of corruption is just the cost of acquiring enough voting power.
- **The real oracle is hidden one layer deeper.** Polymarket's markets live on Polygon, a proof-of-stake blockchain. If UMA token holders vote for an outcome that POL stakers disagree with, the stakers can fork the chain. This makes POL token holders the ultimate "oracle" — but users have no direct recourse against them and may not even realize this dependency exists.
- **Complicated incentive model** — participants must reason about dispute bonds, voting rounds, escalation periods, and token economics just to understand how a market resolves.

bitCaster's DLC approach takes the opposite stance: make it clear who is responsible for the outcome. The oracle is a named entity with a known public key. What an oracle loses when it lies varies case by case (reputation, leaked private key, contractual liability), but users always know who attested and what answer they gave.

## After Resolution

Once the oracle publishes its attestation, the mint processes the result.

For example, in a market with YES/NO outcomes:

- Winning tokens become redeemable for their full face value.
- Losing tokens become worthless — they can no longer be swapped or redeemed.

## Redeeming Tokens

Redeeming converts your conditional tokens (CTF tokens locked to an outcome) back into regular ecash tokens that you can spend freely.

- Those ecash tokens can be either stablecoin-denominated or BTC-denominated, depending on the mint.
- BTC-denominated tokens can be further redeemed for actual bitcoin by withdrawing over Lightning.

## Further reading

- [DLC Oracle Nostr Announcements (Kind 88)](/technical/dlc-oracle/nostr-kind-88/) — how oracles announce events and publish attestations
- [NUT-CTF Core Specification](/technical/nut-ctf/core-ctf/) — the protocol for conditional tokens, minting, and settlement
