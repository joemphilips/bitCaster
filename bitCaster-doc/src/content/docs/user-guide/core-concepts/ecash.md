---
title: "Ecash"
description: "What ecash is, why bitCaster chose Cashu, and why a blockchain is unnecessary for prediction markets."
sidebar:
  order: 0
---

# Ecash

What bitCaster positions actually are is simply **ecash tokens**. This page explains what that means, why it matters, and why it's a better fit for prediction markets than a blockchain.

## What is ecash?

Ecash is a form of digital money based on **Chaumian blind signatures**, invented by David Chaum in the 1980s. The core idea is simple:

- A **mint** issues digital tokens, similar to how a bank issues banknotes. The mint signs each token to prove it's genuine.
- **Blind signatures** mean the mint signs tokens *without seeing what it's signing*. It can later verify that a token is real, but it cannot link that token back to who originally received it.
- Ecash is a **bearer instrument** — whoever holds the token owns it, just like physical cash. There is no account, no login, no identity attached to a token.
- **Privacy is built into the protocol**, not bolted on after the fact. The mint itself cannot track who is spending what.

In bitCaster, the mint issues ecash tokens denominated in bitcoin (sats). When you deposit over Lightning, you receive ecash. When you place a bet, you exchange that ecash for **conditional tokens** locked to a specific outcome. If you win, those conditional tokens become redeemable for regular ecash, which you can withdraw back to Lightning at any time.

## Why Cashu?

bitCaster uses [**Cashu**](https://cashu.space/) as its ecash protocol for the following reasons:

- **Open specification** — Cashu is defined by a set of public specs called [NUTs](https://github.com/cashubtc/nuts) (Notation, Usage, and Terminology). Anyone can implement a mint or wallet, and the protocol evolves through community review.
- **Simple protocol** — the cryptographic protocol (blind signatures over secp256k1) is straightforward to understand, audit, and extend. bitCaster's conditional token extension (NUT-CTF) builds directly on this foundation.
- **Native Bitcoin/Lightning integration** — Cashu mints hold reserves in bitcoin and accept deposits/withdrawals over Lightning. No bridging, wrapped tokens, or separate chain management needed.
- **Community-driven development** — multiple independent teams build Cashu wallets, mints, and libraries, reducing single points of failure in the ecosystem.

## Why not a blockchain?

A common question: why not run the exchange on a blockchain, like Polymarket does on Polygon?

The key insight is that **a prediction market exchange is already centralized**. Someone has to run the order book and match trades. Putting that activity on-chain doesn't remove the centralization — it just adds overhead:

- **Privacy degrades.** On a public blockchain, every trade is visible to everyone. Polymarket participants' positions, timing, and trading patterns are all on-chain for anyone to analyze. Ecash gives you the opposite — the mint itself doesn't even know who holds which tokens, let alone outside observers.
- **Scalability suffers.** On-chain settlement means gas fees, block confirmation times, and throughput limits. During high-activity events, these costs spike. Ecash settlement is instant and costs next to nothing.
- **Friction increases.** Polymarket requires USDC on Polygon, which means bridging assets from other chains, managing gas tokens, and dealing with blockchain-specific UX (wallet approvals, transaction signing, failed transactions). With ecash over Lightning, you deposit sats and start trading.

Blockchains excel at **censorship resistance** and **public verifiability** — properties that matter for decentralized finance. But a prediction market exchange doesn't need public verifiability of every trade, and censorship resistance at the matching layer is impossible anyway (the matching engine can always refuse orders). What users actually want is **privacy**, **speed**, and **low fees** — exactly what ecash provides.

## Further reading

- [Atomic Swaps](/user-guide/core-concepts/atomic-swap/) — how trades settle without trusting a custodian
- [Resolution](/user-guide/core-concepts/resolution/) — how markets resolve and winning tokens are redeemed
- [Conditional Token Framework](/user-guide/core-concepts/conditional-tokens/) — bitCaster's three-layer asset model and how prediction-market positions are encoded as ecash
- [Bitcoin Design — Ecash Introduction](https://bitcoin.design/guide/how-it-works/ecash/introduction/) — an external primer on ecash trust models
