---
title: 'Creating Markets'
description: 'Create a prediction market, report its result, and optionally fund its market maker.'
sidebar:
  order: 4
---

# Creating Markets

To create a market, define the question and list its possible outcomes.
In the current app, you also act as the oracle: you report the result when
the event is resolved.

You do not choose an opening probability or fund the market maker during
registration. The mint can charge a separate registration fee. The app asks
you to confirm that fee before proceeding. After creation, you can fund the market maker in a separate
step. That payment is non-refundable. Creating or funding a market does not
set its displayed price; a confirmed trade does.

Before registration payment, the browser checks the complete private oracle
record against the portable encoding limit. It also checks an unpaid creation
when you resume it. If the record is too large, creation stops before payment,
announcement publication, or mint registration. Shorten the announcement text
or reduce the relay list before trying again.

For a yes/no market, the wizard uses Yes and No automatically. It skips the
outcome-entry step. For a categorical market, enter the outcome names.
If a payment needs a wallet, choose Create wallet or Restore wallet.
Setup and cancellation preserve your draft. Setup does not submit the market
or pay its fee. Continue only after you review the next action.

Categorical outcomes start with visible colors: green, red, orange, then other
distinct colors. Select **Automatic** to choose a different unused color.
You can also select a color manually. The draft and Review keep your selection.
Creation stores the selected color.
The market views and Portfolio use the same outcome colors.
Colors do not change outcome identity or settlement.

API clients can set the optional `color` field to a six-digit hexadecimal
value with a leading `#`. Omit it for automatic assignment. See the
[Market Catalogue API](/technical/protocol/market-catalogue/) for the wire fields.

## Resume an incomplete creation

Mint registration can succeed before the engine accepts the market.
If the engine request fails, resume the saved creation instead of starting
another one. Use the original wallet, oracle key, mint, and engine.
Keep the local browser data or daemon profile until creation finishes.

The client retains the original announcement, market details, thumbnail,
and registration payment reference. Reloading does not require you to select
the thumbnail again. After mint registration is confirmed, resuming does not
charge another registration fee. If a response is lost, the client checks
the existing registration before it sends another request.
A paid mint registration alone does not mean that the market is ready.

CLI users can check and resume the same creation in the original daemon profile:

```bash
bitcaster-cli market creation-status create-001
bitcaster-cli market creation-resume create-001
```

Replace `create-001` with your creation identifier.
The status result includes `mintRegistered` and `engineRegistered`.
If registration is not paid yet, resuming can still require your fee approval.
The saved thumbnail is reused when you omit `--thumbnail`.
If you supply that option, the file must match the original thumbnail.

## Creator dashboard

The creator dashboard shows engine lifecycle state and confirmed trade volume.
When engine data is absent, it shows an unknown state and an unavailable amount.
After a failed refresh, it labels retained state and volume as last known.
A failed refresh does not make a known closed market active.
Restored local records and oracle records do not confirm engine lifecycle state.

## Your role as oracle

The creation flow uses your own Nostr private key to make a signed promise
to report the event's result. This promise is the oracle announcement.
Configure your oracle key before creating a market. The current wizard does
not let you select another oracle or an existing announcement.

Choose a question with a clear result that you can report. Traders must trust
your reporting: a valid signature does not prove that the result is true.
See [Resolution](/user-guide/core-concepts/resolution/) for your reporting
responsibilities and what happens after trading closes.

## Keep and restore your oracle backup

After creation finishes, the client attempts an encrypted oracle backup on
the original relays. Backup failure does not undo creation or charge another fee.
Keep the local oracle record until backup delivery is confirmed.

Open Settings, then Oracle backups. Use the original local Nostr key to
list backups or restore one version. The client fetches the selected event
again and checks its signature, encryption, and oracle binding before import.
The browser and native client use the same portable backup format.
Restore retains the original announcement, signing authority, mint, engine,
and relay destinations. It restores an oracle record, not a paid creation record.

Discovery depends on relay retention. A page or an empty result does not
prove that all backups were found. Try another relay or use the exact backup
event ID and source relay URL. Settings shows one remote page at a time.

Local status distinguishes incomplete import, pending preparation, initial
delivery, terminal replacement, deletion requests, and pending local updates.
Initial backup confirmation does not confirm the terminal replacement.
If import is incomplete, restore the same version again before signing.
Retry preparation with the original key. A saved exact backup retry can run
without a signer. Retry uses the original destinations.

Use one current oracle copy. An old restored copy can still sign another
outcome. After resolution delivery, the client attempts a replacement that
retains the exact signed result without fresh signing authority.
It also requests deletion of retained older versions.
A relay acknowledgment does not prove that the relay erased every old copy.

If this device has frozen a terminal backup retry, another source version
can be refused. The message says that the version was not imported.
The local record and exact retry stay available. Completing deletion does
not guarantee that this device can admit that source version later.
A fresh store with the matching key can restore the valid version.

### CLI backup commands

Use the original oracle key in the local daemon profile. Commands return
safe metadata and delivery progress. They do not return private signing data.

```bash
bitcaster-cli market oracle-backup-list --relay <relay-url>
bitcaster-cli market oracle-backup-list --relay <relay-url> --cursor '<cursor-json>'
bitcaster-cli market oracle-backup-restore --event-id <backup-event-id> --relay <relay-url>
bitcaster-cli market oracle-backup-status <condition-id>
bitcaster-cli market oracle-backup-status --limit 32
bitcaster-cli market oracle-backup-status --cursor <last-condition-id> --limit 32
bitcaster-cli market oracle-backup-retry <condition-id>
bitcaster-cli market announcement-republish <condition-id>
```

Omit `--relay` to scan configured relays. Pass the returned discovery cursor
unchanged with the same relay selection. It describes relay-dependent discovery.
Local status pages return `statuses` and a condition-ID `cursor`.
The default page size is 32. The maximum is 128.
Do not combine local page options with a selected condition ID.
`announcement-republish` sends the exact saved announcement to its original
relays. It does not require a signer or create another announcement.
See [Resolution](/user-guide/core-concepts/resolution/) for restored oracle signing
and engine-down publication.

## Amounts and prices

The app shows amounts in sats, the small units of Bitcoin. USD, JPY, and
other funding currencies are not available.

For a yes/no or categorical market, one winning share pays one sat before
redemption fees. Its purchase price is a separate amount. Prices use steps
of 0.1 percentage points, such as 53.3%. These settings are fixed; you do
not select them when you create the market.

Numeric market creation and trading are not available.

The mint must confirm the market's currency before registration can finish.
If registration reports that this check is not ready, try again after the
mint has registered the event.

## Fund your market

After market creation succeeds, bitCaster shows an optional **Fund the market maker** step. This is a separate post-creation flow. Funding gives the market's automated market maker capacity to post bids and asks on the order book. You can submit more than one accepted funding payment after creation.

When a payment made in this creation step is credited, a success screen shows
a five-second countdown. The app then opens the market. A pending payment or
a restored old credit does not start this countdown. Funding from the market
detail page does not navigate away.

This payment is a non-refundable subsidy for this market's bot. It does not
fund your trading wallet. It gives you no market shares, fee income, or right
to withdraw. Capital assigned to this market cannot fund a different market.

Enter the amount in sats. The first accepted payment
starts the bot without a creator-selected probability. Later payments add
capital and can change its quotes even before another trade occurs. They do
not rewrite past trades. If an earlier bot trade is still settling, the new
funding waits before changing the quotes. The bot pauses new fills during
that interval.

Skip this step to finish creation without funding the bot. If no
liquidity is available for the selected outcome, the `BUY` and `SELL` tabs
show a message and a link to `LIQUIDITY`. You can fund the bot there later.

Funding does not set the public market price. Only a confirmed trade sets a
public price. Before the first confirmed trade, the market has no price and
the app shows **No trades yet** or an em dash. A bid/ask midpoint is an
order-entry reference only.

Disclosure shown before confirming funding:

> This deposit is non-refundable. If the market resolves, the budget is expected to be spent paying traders who informed the price. Any residual at close becomes operator income.

## Market Lifecycle

A market closes when an oracle attestation is accepted or its announced deadline
arrives, whichever comes first. A market can have no deadline. In that case,
no deadline-based close is scheduled. An accepted attestation can still close
the market.

After a market closes, trading ends. No new orders or bot funding are accepted.
Closure at the deadline does not identify winning tokens or guarantee a refund.
Winning tokens can be redeemed for ecash only after the mint accepts a result.
The redemption period is a mint policy shared across its markets. See
[Resolution](/user-guide/core-concepts/resolution/) for missing-result and
redemption rules.

## Further reading

- [AMM Liquidity for New Markets](/technical/architecture/market-making/) — why post-creation LMSR AMM liquidity helps new markets start trading
- [Resolution](/user-guide/core-concepts/resolution/) — how oracles attest to outcomes and how winning tokens are redeemed
- [Conditional tokens](/user-guide/core-concepts/conditional-tokens/) — buying, selling, and redeeming market shares
