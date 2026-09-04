---
title: "Atomic Settlement"
description: "How bitCaster settles matched conditional-token orders through the mint."
sidebar:
  order: 2
---

# Atomic Settlement

bitCaster settles matched orders with the Cashu mint. It does not run a
bilateral swap between two peers.

The first-release server accepts only public FOK orders. The GUI and CLI submit
FOK orders. Each public attempt uses one one-shot capability. FOK uses the book
state at admission. It commits the full requested quantity or cancels the
complete request. Public FAK, GTC, GTD, continuation, and residual
reauthorization are not available. Internal custody-backed LMSR quotes use GTC.
They are not public client orders.

When you place a FOK order, your wallet authorizes it with a `PAY_TO_UNLOCK`
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
loses its connection, it can recover the exact operation and result later. An
acknowledged FOK operation stores its operation facts and result. These records
survive a server restart. An intentional reuse of the same client order ID with
the same operation facts returns the stored result. Changed facts return a
conflict.

## Cancellation

Public FOK does not rest on the book or leave a residual order. If the complete
quantity cannot fill, the engine cancels the complete request. This cancellation
does not spend the `PAY_TO_UNLOCK` capability or trigger a refund.

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
