---
title: "Atomic Swaps"
description: "How bitCaster uses atomic swaps to settle trades between peers without trusting a custodian."
sidebar:
  order: 1
---

# How Token Exchange Works

Trading on bitCaster involves two broad steps:

1. You submit an order and the matching engine finds a match.
2. Based on the result, an atomic swap is executed if needed.

Complementary matches do not require an atomic swap.

## Complementary vs non-complementary matches

- **Complementary match** — a YES buyer is matched directly with a NO buyer. The mint can settle this on its own because the two positions perfectly offset. No swap is needed; the mint simply issues conditional tokens to each side.
- **Non-complementary match** — for example, someone selling YES tokens they already hold to another participant who wants to buy them with sats. Here the two parties need to exchange tokens directly, and neither should have to trust the other to go first.

## Why atomic swaps matter

An atomic swap guarantees that **either both sides of the trade complete, or neither does**. This is critical for trustless peer-to-peer trading:

- You never send your tokens hoping the other party will send theirs.
- If anything goes wrong (the other party disappears, a network issue occurs), your tokens are automatically returned to you after a short timeout.
- The matching engine relays encrypted messages between the two parties but **never holds custody** of any funds.[^1]

## How it works (simplified)

1. The matching engine pairs two orders and shares each party's public key with the other.
2. Both parties establish an encrypted channel using those keys.
3. Each party locks their tokens so only the counterparty can spend them, with a time-limited refund path.
4. A cryptographic link (adaptor signature) ties both locks together — claiming one side automatically reveals the secret needed to claim the other.
5. The first party claims, which reveals the secret. The second party uses that secret to claim their side.

The entire process happens in seconds and requires no on-chain transactions — just ecash swaps through the mint.

## Further reading

For the full cryptographic protocol, see the [technical specification](/technical/protocol/atomic-swap/).

[^1]: There is an exception to this: when a market creator supplies initial liquidity, they may deposit assets with the matching engine to bootstrap early trading activity.
