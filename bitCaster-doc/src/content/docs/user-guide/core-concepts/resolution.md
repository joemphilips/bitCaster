---
title: "Market Resolution"
description: "How bitCaster markets resolve using DLC oracles, and how winning tokens are redeemed."
sidebar:
  order: 3
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

bitCaster's DLC approach takes the opposite stance: make it clear who is responsible for the outcome. The oracle is a named entity with a known public key. This is the same trust model used by DLCs.

In bitCaster, the market creator usually acts as the DLC oracle using their [Nostr](https://nostr.com/) private key. This means that **if the oracle lies or returns an incorrect answer, accountability attaches to that Nostr identity**. Reputation information accumulates on the Nostr network, making it easier to audit who made which attestations over time.

Publishing through Nostr is useful for public auditability, but it is not required for bitCaster to close a market. The creator can also submit the signed oracle attestation directly to the matching engine. The engine verifies the DLC oracle signature against the market's registered oracle key and then closes the market for trading. Relays are therefore transport, not trust anchors.

## After Resolution

Once the oracle attestation is published or submitted directly, the mint processes the result and the market itself closes. From that moment on, no new orders or deposits are accepted.

For example, in a market with YES/NO outcomes:

- Winning tokens become redeemable for their full face value.
- Losing tokens become worthless — they can no longer be swapped or redeemed.

There is also a second path that closes a market. If the oracle's announced deadline passes without an attestation arriving, the market closes by deadline. The redemption window for winning tokens is set per-mint, not per-market — every market a given mint hosts shares the same window length, which the mint commits to in its vesting period.

## Redeeming Tokens

Redeeming converts your conditional tokens (CTF tokens locked to an outcome) back into regular ecash tokens that you can spend freely.

- Those ecash tokens can be either stablecoin-denominated or BTC-denominated, depending on the mint.
- BTC-denominated tokens can be further redeemed for actual bitcoin by withdrawing over Lightning.

### Native daemon retirement

The native daemon keeps resolved condition proofs until you authorize retirement. Run `bitcaster-cli wallet retire-condition <condition-id>` to preview the action and mint fee. Add `--acknowledge` to redeem winning proofs. The daemon retains losing or uneconomic proofs as visible audit records.

You can set `daemon.autoRetireResolvedConditionInventory` to `true` in `~/.bitcaster/config.json`. This setting authorizes the same durable retirement flow when the daemon receives a verified oracle attestation. The default is `false`. A restart is required after a configuration change.

## Further reading

- [DLC Oracle Nostr Announcements (Kind 88)](/technical/dlc-oracle/nostr-kind-88/) — how oracles announce events and publish attestations
- [Conditional Token Framework](/user-guide/core-concepts/conditional-tokens/) — bitCaster's three-layer asset model and how conditional tokens settle back to ecash
