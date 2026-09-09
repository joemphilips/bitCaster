---
title: "Architecture"
description: "How the pieces of bitCaster fit together."
sidebar:
  order: 2
---

Your browser holds your wallet. Shared services match trades and issue tokens.
Independent oracles report event results. Services relay and verify those reports.
This page explains what you rely on when you use bitCaster.

![Architecture diagram showing Oracle, Nostr oracle network, Matching Engine, Cashu Mint, and bitCaster App](../../../../assets/architecture.svg)


Each user runs their own instance of the app in their browser. All users connect to the same shared infrastructure.

## Cashu Mint

The mint issues Cashu ecash tokens. It also issues market tokens whose payout
depends on the event result. After a verified result, winning tokens can be
redeemed for sats. Losing tokens have no payout.

The first release uses one mint operated by bitCaster. You rely on it to honor
redemptions. If it stops service, token operations can be delayed. Local wallet
keys and encrypted backups do not remove this dependency.

## bitCaster App

The app runs in your browser and stores your wallet locally. It communicates
with the mint for wallet operations and with the matching engine for market
data and trading. Some payments and trade settlements use the engine as part
of the flow. Not every token operation goes directly from your browser to the
mint.

An encrypted backup can help restore the wallet. The backup service cannot
read its contents, but it can observe limited account and activity metadata.
See [Encrypted wallet backup](/user-guide/getting-started/wallet-backup/).

## Matching Engine

The matching engine maintains a central limit order book (CLOB) for each market. It matches buy and sell orders and broadcasts real-time price updates. It also connects to the Nostr oracle network, watches the oracle announcements and attestations relevant to registered markets, verifies them, and coordinates market closure when an attestation arrives.

For everyday market pages, the app reads market state, deadlines, outcomes, and order-book data from the matching engine first. Treat that as a fast cache of the mint's condition data: it is what keeps list and detail pages responsive. When a user performs a critical action that can move funds, the app or protocol must still rely on mint-enforced checks or a fresh mint comparison before the action becomes final.

The matching engine is a shared service. An outage can prevent new trades.
The mint is also shared, so the system does not become independent of its
operators merely because your wallet is local.

## Oracle Network

Oracles can publish announcements and attestations to Nostr relays. Those relays act as an untrusted public network: they can transport, cache, or withhold events, but they cannot make an invalid announcement or attestation valid. bitCaster treats Nostr as a discovery and audit channel, not a trust anchor; signed DLC oracle data can also be submitted directly to the mint or matching engine and is verified before use.

## Oracle

An oracle is an entity from [Discreet Log Contracts (DLC)](https://www.dci.mit.edu/projects/discreet-log-contracts) that announces real-world events and later attests to their outcomes. Oracles may publish announcements and attestations as Nostr events, making them publicly discoverable and auditable. Any bitCaster App can read oracle announcements directly from the Nostr network — no special server is needed.

Importantly, oracles are completely independent of bitCaster — they don't need to know about the app or ecash at all. They simply attest to real-world facts using the DLC protocol.

## Open Source

The browser app, client tools, and protocol specifications are public in the
[bitCaster repository](https://github.com/joemphilips/bitCaster). The mint
software is also public. You can inspect how the client handles your wallet
and constructs requests.

The matching engine is closed source. Its
[API specification](https://github.com/joemphilips/bitCaster/tree/main/BitCaster.MatchingEngine.Contracts/specs)
is public. Public source code helps you inspect software. It does not
guarantee correct operation, service availability, or repayment by the mint.
