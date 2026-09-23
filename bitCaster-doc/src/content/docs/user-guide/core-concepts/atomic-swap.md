---
title: "Atomic Settlement"
description: "What happens after you submit a trade, and how to handle a delay."
sidebar:
  order: 2
---

# Atomic Settlement

Submitting an order is not the same as completing a trade. The matching engine
finds matching orders. The Cashu mint then exchanges the authorized funds and
shares. The mint completes each settlement group as one operation. It does not
complete only one side of that exchange. This is what **atomic settlement** means.

## Before you confirm

Review the quantity, price protection, and fees. Price protection limits the
prices at which your order can trade. It does not remove wallet preparation or
refund fees. Preparation can cost a fee even if no trade completes.

Both the web app and CLI use fill-or-kill (FOK) orders in this release. When the
engine accepts the order, the available matching orders must cover its full
quantity within its price protection. Otherwise, it cancels the whole order.
It does not fill only part of your request or leave the rest waiting for a buyer
or seller. A matching decision still needs settlement confirmation.

Cancellation because the full quantity cannot match does not itself spend the
trade authorization or start a refund. If your wallet already prepared locked
funds, they can remain unavailable until the refund conditions are met.

## If a trade is delayed

A lost connection does not prove that a trade failed. The mint may have
completed the exchange before your wallet received its reply. Do not create a
new order just to retry a trade whose result is still unknown.

Keep the same wallet and its local data. The wallet stores the submitted
operation and checks the existing result during recovery. A saved result
survives a server restart. Recovery of that same operation must not create
another trade.

Do not clear browser storage or delete the wallet's local records while an
operation is unresolved. Your recovery phrase does not reconstruct every
pending operation or refund record. See [wallet backup and recovery](/user-guide/getting-started/wallet-backup/).

If settlement does not complete, the authorized funds can become refundable
after the authorization expires. A timeout alone does not make them available
to spend. The wallet must check the existing settlement and refund conditions.

The web app keeps wallet alerts until you dismiss them. Use **Next** to read
more alerts without dismissing an unresolved alert. Use **First alerts** to
return to the start. Dismissing an alert does not stop recovery or delete funds.

The **Active trade progress** list shows operations that the wallet still needs
to finish. It survives a reload while the wallet data remains available.
Use **Refresh status** to check again. An unavailable status is not a failed
trade. A confirmed settlement can still need wallet recovery. Refund eligibility
does not mean a refund is complete. An operation leaves this active list when
the wallet finishes its work. The list is not your completed-trade history.

Wallet preparation is separate from order acceptance. The progress list shows
which stage is confirmed. A prepared payment does not prove that the engine
accepted an order. A rejected order can still need funds recovery. An accepted
order is not a completed trade until settlement is confirmed.

## What the engine can see

Your wallet sends the ecash records, called proofs, that authorize this order.
The engine sees those proofs and their secrets. It does not receive your
recovery phrase, the private material needed to unlock the received outputs,
your refund key, or your other wallet proofs.

The engine can select only the outputs your wallet authorized. It cannot
redirect that value or extend the authorization. It can delay settlement,
which can keep the authorized funds unavailable until a refund becomes valid.

## Further reading

See the [technical settlement protocol](/technical/protocol/atomic-swap/) for
authorization rules, fill and group identifiers, conversion types, and client
retry requirements.
