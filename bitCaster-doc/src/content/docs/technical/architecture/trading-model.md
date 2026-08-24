---
title: "Trading Model"
description: "How CLOB orders, authorization, settlement groups, and admission protection work."
sidebar:
  order: 2
---

# Trading Model

bitCaster uses a central limit order book (CLOB). A limit order can rest on the
book. A crossing order takes available liquidity. All product assets are sats.

Public market books use primitive outcome routes. A categorical market exposes
`A / Not A`, `B / Not B`, and similar books. Clients use the market identifier
`{conditionId}-{outcomeName}` and select the required token side.

## First-release public scope

The public server accepts FAK and FOK. The GUI exposes FAK. The CLI exposes FAK
and FOK. Each public attempt uses one one-shot capability. A partial FAK
settles the committed fills and cancels the remainder. A zero-fill FAK
cancels. FOK commits the full requested quantity or cancels the complete
request from the admission snapshot. Public GTC, GTD, continuation, and
residual reauthorization are not available. Internal LMSR bot GTC is a private
operator function, not a public client feature.

## Order authorization

A wallet supplies one `PAY_TO_UNLOCK` capability when it submits a public FAK or
FOK order. The engine validates the capability during order admission. It
makes no mint network call during admission.

The capability covers an authorized range for that one attempt. Public
continuation is not available. Cancellation retracts only a resting order. It
does not spend a capability and it does not trigger a capability refund.

## Fills and settlement groups

Each matched quantity creates one fill. `fillId` identifies that real fill.

The engine can group one or more fills into one atomic settlement group.
`groupId` identifies the settlement group. The mint receives one multi-party
conversion for the group. The current product supports complementary and mint
conversion. It does not expose merge conversion in this release.

Mint confirmation returns exact result entries. Clients retain their submitted
operations and confirmed results. They can recover those exact records after a
crash. If the result is uncertain, clients reconcile with the durable engine
and mint authority.

## Participation Score

Participation Score protects public order admission. A versioned projector
derives any charge from verified source facts at durable acceptance. It does not
charge per fill and it does not apply a settlement-failure penalty. Internal
engine bot orders do not receive Score charges.

## Trust boundary

The engine receives the exact `PAY_TO_UNLOCK` proofs that authorize an order.
It sees their secrets and the public blinded-output manifest. It does not
receive the wallet seed, output blinding factors, refund key, or other wallet
proofs.

The engine can use only the authorized selection before expiry. It cannot
redirect value outside the manifest or extend the lock. If it withholds
settlement, the authorized proofs remain unavailable until refund becomes
valid.

The mint performs the conversion. Wallets control their proof material. A
`PAY_TO_UNLOCK` capability can refund after expiry under the NUT rules.

## Comparison with on-chain CTF exchanges

The names complementary, mint, and merge also appear in on-chain CTF systems.
The implementation differs. bitCaster currently exposes complementary and mint
conversion only. It uses one mint conversion for an atomic settlement group. It
does not use a peer-to-peer settlement exchange or an on-chain operator
transaction.
