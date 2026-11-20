---
title: 'Deposits, withdrawals, and mint fees'
description: 'Lightning deposits and withdrawals, mint limits, invoice tracking, Cashu payment requests, and input fees.'
sidebar:
  order: 3
  label: 'Payments and fees'
---

## Funding and withdrawal

The first release supports one mint operated by bitCaster. You can add funds
to your wallet by paying a Lightning invoice or importing a Cashu token from
that mint. You can withdraw ordinary ecash by paying a Lightning invoice
through the mint. Check the amount and estimated fees before confirmation.

A mint can limit the amount of each Lightning deposit and each Lightning
withdrawal. If an amount is outside the limit, the app shows the limit next to
the amount or the invoice and does not continue. Deposit or withdraw a larger
amount in parts. When the required top-up is above the limit, the app
suggests the limit. After that deposit, continue and deposit the
remaining amount. The CLI refuses the same amounts with the error code
`amount-outside-mint-limits`.

A paid Lightning deposit completes even after you close the deposit screen.
You do not need to reload the page. While the app is open, it watches the
unpaid invoices of the open wallet. The mint's NUT-17 payment notice is the
first signal. The app also asks the mint for the invoice state when it starts
to watch the invoice, every 2 seconds while the invoice is on screen, and once
when the invoice expires. It also asks when the browser goes back online or
when you return to the page. For an invoice that is not on screen, it asks at
regular intervals only while the notice connection to the mint is down. If you
pay while the app is closed, the app checks the invoice the next time you open
it. A completed deposit adds to your balance and appears once in Activity.

The app keeps an expired invoice for 24 hours after its expiry. This covers a
payment that the mint accepted shortly before the expiry. During this time,
the app checks the invoice each time the app starts or the browser goes back
online. If the mint reports a payment, the deposit completes. After the 24
hours, the app checks the mint one more time. It closes the invoice only if
the mint still reports it as unpaid.

When you import a conditional token, the wallet asks the mint to replace it
with tokens for the same market position. Mint fees can reduce the amount
received. Pasting the token alone does not complete receipt. Keep browser
data while receipt is pending so the wallet can recover an uncertain result.

To send ecash, copy or save the displayed token before you acknowledge the
handoff. The token screen does not close automatically. Acknowledging the
handoff does not prove that the recipient redeemed the token. It does not
clear the wallet's pending-send recovery record. Treat the token as cash:
share it only with the intended recipient.

Adding funds to your wallet is not the same as funding a market's bot.
[Bot funding](/technical/reference/market-funding/) is a separate,
non-refundable subsidy. It does not add to your spendable wallet balance.

## Receive a Cashu payment request in the CLI

Start the configured daemon, then create a request:

```bash
bitcaster-cli wallet request create
```

Share the returned `encoded` value with the sender.
The request has no fixed amount. It accepts msat tokens from the configured mint.
The receive address belongs to the wallet seed, not the Nostr login key.
The CLI receives these requests; it does not pay a scanned request.

Use the returned `requestId` to check progress:

```bash
bitcaster-cli wallet request status <request-id>
bitcaster-cli wallet request watch <request-id>
```

`awaiting` means that no receipt is saved.
`pending` means that receipt processing is incomplete.
Only `credited` confirms that the wallet applied the receipt.
The result's `amountMsat` field uses msat, not sats.
A saved receipt or a delivered Nostr message alone is not a completed payment.

Press Ctrl+C to stop watching. This does not cancel the saved request or the
daemon's receiver. Keep the daemon running to receive payments.
A restart resumes saved requests after wallet recovery permits new operations.

To list saved requests or retry an incomplete receipt, use:

```bash
bitcaster-cli wallet request list --page-size 32
bitcaster-cli wallet request list --cursor <nextCursor> --page-size 32
bitcaster-cli wallet request recover <request-id>
```

Pass `nextCursor` unchanged. Stop when it is `null`.
`recover` reuses the saved receipt and wallet recovery records.
It does not create another request or guarantee that the mint is available.
Keep the native wallet profile while an operation is pending.

## Mint fees

The mint charges an input fee when it consumes proofs. The fee depends on
the number of proofs and the rate attached to each proof's keyset. Ordinary
ecash and conditional tokens can both have input fees. Existing proofs keep
their original rate when the mint changes the rate for new keysets.
Check the wallet's estimate before you confirm. Separate preparation steps
can each incur a fee, even if a later order does not complete.
