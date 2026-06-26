---
title: "Atomic Swaps"
description: "How bitCaster uses atomic swaps to settle trades between peers without trusting a custodian."
sidebar:
  order: 2
---

# How Token Exchange Works

Trading on bitCaster involves two broad steps:

1. You submit an order and the matching engine finds a match.
2. The matched parties settle with an atomic swap through the mint.

This is true for both complementary and mint matches. A mint match
may first require one side to split regular collateral proofs into a complete
set of outcome tokens, but the matched trade still settles through the same
trustless atomic swap protocol.

Terminology matches Polymarket CTF Exchange V2: **Complementary** = Buy vs Sell, **Mint** = Buy vs Buy (maker splits a complete set), **Merge** = Sell vs Sell (combine into a complete set; not yet supported in bitCaster).

For categorical markets, the public trading UI presents primitive books such as `A / Not A`; compound outcome collections such as `B|C` are wallet and settlement details used after a match is made.

## Mint vs complementary matches

- **Mint match** — a YES buyer is matched with a NO buyer, or in a categorical market a buyer of one outcome set is matched with a buyer of the exact complementary set. The maker creates or selects the complete outcome-token set, keeps the side they wanted, and atomically swaps the other side to the taker for regular collateral.
- **Complementary match** — for example, someone selling YES tokens they already hold to another participant who wants to buy them with regular collateral. The seller already has the outcome tokens, so no pre-trade split is needed, but the exchange still uses the same atomic-swap safety rule.

For limit buys that may rest on the book, bitCaster enables **Pre-flight split** by default. The wallet asks the mint to split the needed regular collateral proofs into the complete outcome set before the order becomes live, then reserves those proofs locally for that order. If the split cannot finish quickly, the order should not remain live. Advanced CLI users can opt out with `--no-preflight-split`, but then settlement depends on regular collateral still being available when a later match arrives.

Matching is final for the order book: once a match is accepted, the matched quantity no longer rests on the book. A later swap failure returns or unlocks wallet proofs according to the atomic-swap rules, but it does not put that order quantity back into the public book automatically.

## Why atomic swaps matter

An atomic swap guarantees that **either both sides of the trade complete, or neither does**. This is critical for trustless peer-to-peer trading:

- You never send your tokens hoping the other party will send theirs.
- If anything goes wrong (the other party disappears, a network issue occurs), your tokens are automatically returned to you after a short timeout.
- The matching engine relays encrypted messages between the two parties but **never holds custody** of any funds.

## How it works (simplified)

1. The matching engine pairs two orders and shares each party's public key with the other.
2. Both parties establish an encrypted channel using those keys.
3. Each party locks their tokens so only the counterparty can spend them, with a time-limited refund path.
4. A cryptographic link (adaptor signature) ties both locks together — claiming one side automatically reveals the secret needed to claim the other.
5. The first party claims, which reveals the secret. The second party uses that secret to claim their side.

The entire process happens in seconds and requires no on-chain transactions — just ecash swaps through the mint.

## Further reading

For the full cryptographic protocol, see the [technical specification](/technical/protocol/atomic-swap/).
