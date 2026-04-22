---
title: "Conditional Token Framework"
description: "How bitCaster layers Bitcoin, Lightning, Cashu native tokens, and Cashu-encoded conditional tokens — and the CTF lineage from Gnosis and Polymarket."
sidebar:
  order: 1
---

# Conditional Token Framework

A **Conditional Token** is a cryptographic asset that represents a *position* in a prediction market. It behaves like any other digital token — you can hold it, transfer it, trade it — but it is only redeemable for its face value when a specific outcome becomes true. If the opposite outcome resolves, the token becomes worthless. This is the primitive that makes a decentralised prediction market possible: every market is really just a set of outcome-conditional tokens that settle against an oracle's attestation.

## Origin: from Gnosis to Polymarket to Cashu

The **Conditional Token Framework (CTF)** was originally designed by [Gnosis](https://gnosis.io/) on Ethereum. It introduced a clean separation between *collateral* (the asset you stake) and *positions* (tokens redeemable conditional on an outcome), allowing arbitrary combinations of outcomes to be represented as composable ERC-1155 tokens.

[Polymarket](https://polymarket.com/) then adopted the same framework for its prediction markets on Polygon, and it remains the de-facto standard for on-chain prediction markets today.

bitCaster re-encodes the same idea in a radically different substrate: instead of ERC-1155 tokens on a public blockchain, a bitCaster position is a **Cashu ecash token** issued under a specialised extension of the Cashu mint protocol called **NUT-CTF**. The mental model is identical — a token redeemable only when a specific outcome is attested — but it achieves higher speed and stronger anonymity.

## Four layers of cryptographic assets

bitCaster's asset model can be understood as a four-layer stack. Each layer wraps the one below it, adding expressivity while trading off different properties of the base asset.

<a href="/ctf-layers.png" target="_blank" rel="noopener noreferrer" aria-label="Open full-size diagram in a new tab">
  <img src="/ctf-layers.png" alt="Four layers of cryptographic assets in bitCaster — Bitcoin, Lightning, Cashu native tokens, Cashu-CTF" style="max-width: 100%; height: auto; cursor: zoom-in;" />
</a>

- **Layer 1 — Bitcoin.** Base money. Trustless and censorship-resistant, but with low liquidity for active trading: on-chain confirmations are slow, fees are non-trivial, and throughput is limited. Suitable for settlement, not for high-frequency order flow.
- **Layer 2 — Lightning Network.** A trustless scaling layer over Bitcoin. Lightning solves L1's fee and confirmation-latency problems *without* introducing a new trusted party — payments are secured by the underlying Bitcoin timelocks. In exchange, it requires participants to be online and to manage channel liquidity, which makes it unsuitable as a long-term store or a passive holding.
- **Layer 3 — Cashu native tokens.** Ecash wrapping a reserve asset held by a [Cashu mint](/user-guide/core-concepts/ecash/) — typically BTC (via Lightning), but possibly stablecoins or WBTC depending on the mint. Custodial with respect to the mint operator, but instant, private, and fee-less. Users move value between L2 and L3 by minting and melting ecash over Lightning.
- **Layer 4 — Cashu conditional tokens.** A *position* in a prediction market — what the Ethereum ecosystem would call a "security token". Each L4 token is locked to a specific outcome of a specific event and is spendable only once a DLC oracle attests that outcome. Users move value between L3 and L4 by buying or selling on the market; at resolution, winning L4 tokens settle back to L3 ecash at face value, and losing tokens expire.

## Why four layers?

Each layer exists because the one below it is the wrong fit for the job above. Bitcoin is perfect for settlement but too heavy for a trading session; Lightning is fast and trustless but requires online nodes and channel management, so it isn't a comfortable place to *hold* value between trades; Cashu native tokens are perfect for fast private balances but cannot express outcome-conditional claims; Cashu-CTF tokens are perfect for encoding positions but have no meaning once a market has resolved — at that point they need to collapse back to L3. The stack lets users move value up when they want to trade and down when they want to hold, without ever leaving the Bitcoin trust model at the base.

## Further reading

- [Ecash](/user-guide/core-concepts/ecash/) — why bitCaster uses Cashu as the Layer 3 substrate
- [Market Resolution](/user-guide/core-concepts/resolution/) — how L4 tokens settle back to L3 when the oracle attests
- [NUT-CTF Core Specification](/technical/nut-ctf/core-ctf/) — the technical protocol for minting, holding, and redeeming Layer 4 tokens
- [Gnosis Conditional Tokens](https://docs.gnosis.io/conditionaltokens/) — the original on-chain CTF specification
