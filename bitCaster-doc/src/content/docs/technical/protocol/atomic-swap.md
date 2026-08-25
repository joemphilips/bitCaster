---
title: "NUT-CTF Range Settlement"
description: "The mint-coordinated settlement model for bitCaster conditional-token orders."
sidebar:
  order: 5
---

# NUT-CTF Range Settlement

bitCaster uses NUT-CTF range settlement. It does not use a bilateral HTLC,
peer ECDH, or adaptor-signature protocol.

The first-release server accepts public FAK and FOK orders. The GUI exposes
FAK. The CLI exposes FAK and FOK. Each public attempt uses one one-shot
capability. A partial FAK settles its committed fills and cancels the remainder.
A zero-fill FAK cancels. FOK commits the full requested quantity or cancels the
complete request from the admission snapshot. Public GTC, GTD, continuation,
and residual reauthorization are not available. Internal custody-backed LMSR
quotes use GTC. They are not public client orders.

## Order authorization

A wallet authorizes one public FAK or FOK attempt with one `PAY_TO_UNLOCK`
capability. Order admission checks that capability. Admission makes no mint
network call.

The authorization covers its permitted range for that attempt. Public
continuation is not available. Cancelling a resting order only retracts that
order. It does not spend or refund the capability.

## Matching and grouping

The engine creates a fill for each matched quantity. `fillId` identifies one
real fill.

The engine groups one or more fills for atomic settlement. `groupId` identifies
one atomic settlement group. A group is not a substitute for a fill, and a fill
is not a substitute for a group.

The engine can coalesce compatible fills until the bounded group deadline. It
freezes the group before it submits the conversion.

The engine submits one multi-party conversion to the mint for the group. The
current product supports complementary and mint conversion. The mint decides
the result of that conversion. The NUT defines merge conversion, but bitCaster
does not expose it in this release.

## Confirmation and recovery

On confirmation, the mint returns exact result entries for the group. Clients
persist the submitted operation and its result. This lets a client recover the
exact operation and result after a crash.

Submission can be absent or uncertain after a client or network failure. In
that case, the client reconciles with the durable engine and mint authority.
It must not infer success from a local request alone. A `PAY_TO_UNLOCK`
capability remains refundable after expiry as defined by the NUT.

An acknowledged FAK or FOK operation stores its operation facts and result.
These records survive a server restart. An intentional reuse of the same
client order ID with the same operation facts returns the stored result.
Changed facts return a conflict.

## Trust boundary

The wallet sends the exact `PAY_TO_UNLOCK` input proofs that authorize an
order. The engine therefore sees those proofs and their secrets. It also sees
the public blinded-output manifest. It does not receive the wallet seed, output
blinding factors, refund key, or other wallet proofs.

The engine can select only outputs that the wallet authorized. It cannot
unblind an output, redirect value outside the manifest, spend another wallet
proof, or extend the lock past its expiry. If the engine withholds settlement,
the authorized proofs remain unavailable until their refund path becomes
valid.

The mint performs the conversion and returns the confirmed result entries.
Wallets keep the material that controls proofs and blinding. Nostr
authentication identifies an authenticated request through the current adapter.
It is not a settlement key exchange and it is not the generic wallet identity.

## Scope

This product supports sat-denominated assets. It does not provide USD assets.
Cashu can provide other features, including HTLC or P2PK conditions, but
bitCaster does not use them for its current settlement model.
