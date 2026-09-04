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

The public server accepts only public FOK orders. The GUI and CLI submit FOK
orders. Each public attempt uses one one-shot capability. FOK uses the book
state at admission. It commits the full requested quantity or cancels the
complete request. Public FAK, GTC, GTD, continuation, and residual
reauthorization are not available. Internal custody-backed LMSR quotes use GTC.
They are not public client orders.

## Order authorization

A wallet supplies one `PAY_TO_UNLOCK` capability when it submits a public FOK
order. The engine validates the capability during order admission. It makes no
mint network call during admission.

The capability covers an authorized range for that one attempt. Public FOK does
not rest on the book or leave a residual order. If the complete quantity cannot
fill, the engine cancels the complete request. This cancellation does not spend
the capability or trigger a refund.

## Fills and settlement groups

Each matched quantity creates one fill. `fillId` identifies that real fill.

The engine can group one or more fills into one atomic settlement group.
`groupId` identifies the settlement group. The mint receives one multi-party
conversion for the group. The current product supports complementary and mint
conversion. It does not expose merge conversion in this release.

Mint confirmation returns exact result entries. Clients retain their submitted
operations and confirmed results. They can recover those exact records after a
crash. An acknowledged FOK operation stores its operation facts and result.
These records survive a server restart. An intentional reuse of the same client
order ID with the same operation facts returns the stored result.
Changed facts return a conflict. If the result is uncertain, clients reconcile
with the durable engine and mint authority.

## Participation Score

Participation Score protects public order admission. A successful public
one-shot capability binding charges once under `settlement-capability-v1`. The
tariff is `1 + InputCount + ceil(ManifestCount/16) +
ceil(ArtifactByteCount/4096)`. Each authenticated invalid proof or DLEQ
validation attempt uses the same tariff. There is no separate order, fill, or
settlement-failure tariff. Source facts carry verified work facts and the rule
ID, not a derived debit. Fills, cancellation, settlement failure, refund, and
recovery do not debit Score. Internal custody-backed LMSR quotes are exempt
from this public charge.

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
