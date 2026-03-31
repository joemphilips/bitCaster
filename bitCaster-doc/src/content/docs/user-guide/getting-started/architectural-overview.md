---
title: "Architecture"
description: "How the pieces of bitCaster fit together."
sidebar:
  order: 2
---

bitCaster is composed of four independent services that communicate over open protocols.

![Architecture diagram showing Oracle, Cashu Mint, bitCaster App, and Matching Engine](../../../../assets/architecture.svg)


Each user runs their own instance of the app in their browser. All users connect to the same shared infrastructure.

## Cashu Mint

The mint is the core of the system.
It issues both regular ecash tokens and conditional ecash tokens locked to specific market outcomes.
When an event resolves, the mint settles automatically: winning tokens become redeemable for sats, and losing tokens expire.

The mint runs [CDK](https://github.com/cashubtc/cdk) (Cashu Development Kit) with the [NUT-CTF](https://github.com/joemphilips/nuts/blob/nuts_for_prediction_markets/CTF.md) extension for prediction markets.

## bitCaster App

The user-facing progressive web app (PWA). It runs entirely in your browser and holds your tokens locally. The app communicates directly with the mint for all token operations (minting, swapping, redeeming) and with the matching engine for order book access.

## Oracle

An oracle is an entity from [Discreet Log Contracts (DLC)](https://www.dci.mit.edu/projects/discreet-log-contracts) that announces real-world events and later attests to their outcomes. Oracles publish announcements and attestations as Nostr events, making them publicly verifiable. Any bitCaster App can read oracle announcements directly from the Nostr network — no special server is needed.

Importantly, oracles are completely independent of bitCaster — they don't need to know about the app or ecash at all. They simply attest to real-world facts using the DLC protocol.

## Matching Engine

The matching engine maintains a central limit order book (CLOB) for each market. It matches buy and sell orders and broadcasts real-time price updates. This is the only centralized component — it exists because order matching is inherently a coordination problem that benefits from a single sequencer.
