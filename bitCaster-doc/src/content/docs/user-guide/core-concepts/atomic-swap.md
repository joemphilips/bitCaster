---
title: "Atomic Settlement"
description: "How bitCaster settles matched conditional-token orders through the mint."
sidebar:
  order: 2
---

# Atomic Settlement

bitCaster settles matched orders with the Cashu mint. It does not run a
bilateral swap between two peers.

The first-release server accepts public FAK and FOK orders. The GUI exposes
FAK. The CLI exposes FAK and FOK. Each public attempt uses one one-shot
capability. A partial FAK settles its committed fills and cancels the remainder.
A zero-fill FAK cancels. FOK commits the full requested quantity or cancels the
complete request from the admission snapshot. Public GTC, GTD, continuation,
and residual reauthorization are not available. Internal LMSR bot GTC is not a
public client feature.

When you place a FAK or FOK order, your wallet authorizes it with a `PAY_TO_UNLOCK`
capability. The matching engine checks this authorization when it admits the
order. It does not call the mint at this stage.

When orders match, the engine creates one or more fills. Each `fillId`
identifies one real fill. The engine can put one or more fills into an atomic
settlement group. Each `groupId` identifies that group. Do not use a `groupId`
as a fill identifier.

The engine submits one multi-party conversion for each settlement group. The
mint completes the group as one operation. A group can use one of these
conversion types:

- **Complementary conversion.** It exchanges compatible conditional-token and
  collateral positions.
- **Mint conversion.** It creates a complete conditional-token set as part of
  the conversion.

The NUT also defines merge conversion. bitCaster does not expose it in this
release.

When the mint confirms a group, it returns exact result entries. Your wallet
stores the submitted operation and the confirmed result. If the wallet stops or
loses its connection, it can recover the exact operation and result later.

## Cancellation

Cancellation only retracts an order that still rests on the book. It does not
spend a `PAY_TO_UNLOCK` capability. It does not refund a capability.

After a partial public FAK, the remainder is cancelled. The public client does
not reauthorize a residual order.

## What the engine can see

Your wallet sends the exact `PAY_TO_UNLOCK` proofs that authorize the order.
The engine sees those proofs and their secrets. It does not receive your wallet
seed, output blinding factors, refund key, or other wallet proofs.

The engine can use only the output choices that your wallet authorized. It
cannot redirect the value or extend the authorization. If the engine does not
settle, those authorized proofs remain unavailable until their refund becomes
valid.

If submission is absent or uncertain, the wallet reconciles with the durable
engine and mint authority. A `PAY_TO_UNLOCK` capability can still refund after
its expiry under the NUT rules.

## Further reading

See the [technical settlement protocol](/technical/protocol/atomic-swap/) for
the lifecycle and trust boundary.
