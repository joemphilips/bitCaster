---
title: "bitCaster 101"
description: "What is bitCaster and what can you do with it?"
sidebar:
  order: 1
---

## What is bitCaster?

bitCaster is a prediction market platform built on [Bitcoin](https://bitcoin.org/) and [Cashu](https://cashu.space/). You buy and sell tokens that represent outcomes of real-world events — elections, sports, weather, anything. If your prediction is correct, your tokens are worth their full face value. If not, they expire worthless.

Everything is fully open-spec and open-source. No user information is stored on the server side. Your tokens are yours — stored locally in your browser, settled instantly over Lightning or Cashu.

## What you can do

### Trade anything, any way you wish

Browse existing markets or place limit orders at any price. Markets can be binary (Yes/No), categorical (multiple outcomes), or even two-dimensional. You trade using Bitcoin via Lightning — no bridging, no gas fees, no stablecoins needed.

### Create your own market

Anyone can propose a new market. Define the question, the possible outcomes, and the resolution criteria. There is no gatekeeper deciding which markets are allowed.

### Become an oracle

Oracles are the people (or organizations) who answer real-world questions: *"Did Team X win?"*, *"Was the temperature above 30°C?"*. Anyone can run an oracle and attest to event outcomes. The protocol ensures that oracles are accountable and their attestations are cryptographically verifiable.

### Become a token issuer

Run your own Cashu mint to issue prediction market tokens. The mint software is open-source, and the protocol specification is public. Multiple independent mints can coexist, each serving different communities or markets.

## How it works

Every market outcome has a corresponding token. The price of a token reflects the market's collective estimate of how likely that outcome is — a token trading at 70 sats means the market thinks there's roughly a 70% chance of that outcome.

When the event resolves, winning tokens are redeemable for their full value (100 sats each), and losing tokens become worthless. Settlement is automatic and cryptographic — no one needs to trust a central authority to pay out.

## Self-custody by default

Your tokens are **bearer instruments** — like digital cash. They live in your browser, not on a server. There is no account to create, no password to remember, and no personal information to hand over.

If you clear your browser data, your tokens are gone — just like losing a physical wallet. Back up your token data to keep it safe.

## Why Bitcoin & ecash?

| | bitCaster | Traditional platforms |
|---|---|---|
| **Settlement** | Instant via Lightning | Minutes to days |
| **Fees** | Near-zero | Gas fees / withdrawal fees |
| **Privacy** | Strong — ecash leaves no public trail | All trades visible on-chain or in a database |
| **Bridging** | None — native Bitcoin | Often requires stablecoins on specific chains |
| **Accounts** | None required | KYC / identity verification |

## Getting started

Ready to try it? Head to the [bitCaster app](https://bitcaster.io) to start trading.
