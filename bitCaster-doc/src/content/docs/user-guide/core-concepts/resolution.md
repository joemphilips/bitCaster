---
title: "Resolution"
description: "How bitCaster markets resolve using DLC oracles, and how winning tokens are redeemed."
sidebar:
  order: 2
---

# Resolution

When an event's outcome becomes known, the oracle publishes an **attestation** — a cryptographic signature over the result. This attestation lets the mint distinguish winning tokens from losing ones, and winning tokens become redeemable for their full face value.

## The Oracle Model

bitCaster reuses existing **DLC (Discreet Log Contract) infrastructure** for resolution. A DLC oracle doesn't need to know anything about bitCaster — it simply announces events and later publishes attestations, exactly as it would for any other DLC application.

- **No special integration required** — any standard DLC oracle can serve bitCaster markets.
- **Existing incentive structures carry over** — for example, if an oracle signs contradictory attestations (attesting to two different outcomes for the same event), this mathematically leaks the oracle's private key, destroying its ability to operate.
- **Transparent responsibility** — users always know exactly which oracle is responsible for each market's outcome. The oracle's public key and the event descriptor are visible before you place a bet.

## Why not dispute-based resolution?

Platforms like Polymarket rely on UMA's optimistic oracle, where outcomes can be disputed and ultimately decided by a token-holder vote. This approach has fundamental problems:

- **Dispute-and-voting doesn't solve the "Oracle Problem" — it obfuscates it.** Instead of a clearly identified party attesting to reality, you get a multi-layered governance process where responsibility is diffused.
- **Collusion risk** — if UMA token holders collude, they can steer outcomes. The cost of corruption is just the cost of acquiring enough voting power.
- **The real oracle is hidden one layer deeper.** Polymarket's markets live on Polygon, a proof-of-stake blockchain. If UMA token holders vote for an outcome that POL stakers disagree with, the stakers can fork the chain. This makes POL token holders the ultimate "oracle" — but users have no direct recourse against them and may not even realize this dependency exists.
- **Complicated incentive model** — participants must reason about dispute bonds, voting rounds, escalation periods, and token economics just to understand how a market resolves.

bitCaster's DLC approach takes the opposite stance: **make it clear who is responsible for the outcome.** The oracle is a named entity with a known public key. What an oracle loses when it lies varies case by case (reputation, leaked private key, contractual liability), but users always know who attested and what answer they gave.

## After Resolution

Once the oracle publishes its attestation, the mint processes the result:

- **Winning tokens** become redeemable for their full face value.
- **Losing tokens** expire worthless — they can no longer be swapped or redeemed.

This is similar to how other prediction markets handle post-resolution settlement, but bitCaster positions are not dollar-denominated — they are ecash tokens backed by Bitcoin.

## Redeeming Tokens

Redeeming converts your **conditional tokens** (CTF tokens locked to an outcome) back into **regular ecash tokens** that you can spend freely.

- Those ecash tokens can be either **stablecoin-denominated** or **BTC-denominated**, depending on the mint.
- **BTC-denominated tokens** can be further redeemed for actual bitcoin by withdrawing over Lightning.
- Redemption is instant — no waiting periods, no gas fees, no bridging.

## Further reading

- [DLC Oracle Nostr Announcements (Kind 88)](/technical/dlc-oracle/nostr-kind-88/) — how oracles announce events and publish attestations
- [NUT-CTF Core Specification](/technical/nut-ctf/core-ctf/) — the protocol for conditional tokens, minting, and settlement
