---
title: "Ecash"
description: "What Cashu ecash is and how bitCaster uses sat-denominated conditional tokens."
sidebar:
  order: 0
---

# Ecash

bitCaster positions use Cashu ecash. The current product asset is sat.

## What is ecash?

Ecash uses Chaumian blind signatures. A mint issues signed bearer tokens.
Whoever controls a token can spend it. The mint verifies a token, but blind
signatures help prevent it from linking issuance to later spending.

In bitCaster, a wallet uses ordinary sat ecash and conditional tokens for
market positions. The mint converts these positions during settlement. A
confirmed conversion returns exact result entries to the wallet.

The wallet keeps its seed, output blinding factors, refund keys, and general
proof inventory. For an order, it sends the engine only the exact
`PAY_TO_UNLOCK` proofs that authorize that order. The engine sees those proof
secrets, but it cannot redirect their value or extend their expiry.

## Funding and withdrawal

The first release supports one mint operated by bitCaster. You can fund a sat
wallet through the mint's BOLT11 Lightning payment method or by importing a sat
Cashu token from that mint. The trading flow manages conditional market proofs.
You can withdraw ordinary sat ecash through the mint's BOLT11 Lightning flow.

## Trust model

Ecash is a bearer system. You must protect wallet data and recovery material.
The mint holds the Bitcoin reserves behind its issued tokens. You therefore
trust the mint operator to honor its ecash obligations.

The mint verifies bearer tokens instead of a persistent user identity. A user
can swap a token before redemption and break the link to an earlier request.
The mint therefore cannot selectively freeze ecash by user identity. It can
halt service globally, so users must still assess the mint and its observable
operation before they participate.

The matching engine temporarily holds the bounded capability for an order. It
cannot spend other wallet proofs. If it withholds settlement, the authorized
proofs remain unavailable until their refund becomes valid.

## Why Cashu?

Cashu provides private bearer tokens with Bitcoin and Lightning support. It
also provides the NUT framework that bitCaster uses for conditional tokens and
`PAY_TO_UNLOCK` authorization.

## Further reading

- [Atomic settlement](/user-guide/core-concepts/atomic-swap/) explains the
  mint conversion flow.
- [Conditional Token Framework](/user-guide/core-concepts/conditional-tokens/)
  explains conditional market positions.
- [Bitcoin Design — Ecash Introduction](https://bitcoin.design/guide/how-it-works/ecash/introduction/)
  gives an external introduction to ecash trust models.
