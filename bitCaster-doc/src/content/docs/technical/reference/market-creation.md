---
title: 'Market creation: limits, resume, and oracle backup'
description: 'Input limits, resolution-criteria Markdown, resuming an incomplete creation, oracle backups, and the market lifecycle.'
sidebar:
  order: 5
  label: 'Market creation'
---

## Oracle key and outcome names

The oracle signs with a Nostr private key (nsec) that the browser keeps.
Without one, the wizard asks you to register your nsec or create a new key.
If you connected a NIP-07 extension, the wizard shows only
**Register nsec directly**. It opens the private-key entry in the Nostr
settings. Register the nsec of the identity that your extension uses.

Before registration payment, the browser checks the complete private oracle
record against the portable encoding limit. It also checks an unpaid creation
when you resume it. If the record is too large, creation stops before payment,
announcement publication, or mint registration. Shorten the announcement text
or reduce the relay list before trying again.

For a yes/no market, the wizard uses Yes and No automatically. It skips the
outcome-entry step. For a categorical market, enter the outcome names.
Use 1–191 ASCII letters or digits per name, with no spaces or symbols.
Each name must differ from the others in more
than letter case: "Red" and "red" are the same outcome.
If a payment needs a wallet, choose Create wallet or Restore wallet.
Setup and cancellation preserve your draft. Setup does not submit the market
or pay its fee. Continue only after you review the next action.

API clients can set the optional `color` field to a six-digit hexadecimal
value with a leading `#`. Omit it for automatic assignment. See the
[Market Catalogue API](/technical/protocol/market-catalogue/) for the wire fields.

## Title and description limits

New markets accept titles up to **100 characters / 400 UTF-8 bytes** and
descriptions up to **1,024 characters / 1,024 UTF-8 bytes**. Both limits apply.
The form shows the current character and byte counts while you type.
If a field exceeds its limit, the form keeps your text, explains the limit,
and disables the next action until you shorten it. Titles are not silently truncated.

Characters are counted as Unicode code points. Japanese and Chinese text usually
uses three UTF-8 bytes per character; many emoji use four. An emoji made from
multiple code points can count as more than one character.

The title, description, and categories also share a **4,096-byte** limit on
their serialized mint metadata. JSON escaping contributes to this size.
If the combined data is too large, shorten the text or remove categories.
These checks run before fee confirmation, signing, and registration.
The client also checks that the eventual complete resolution record, including
its explanation and configured destinations, will fit within the backup limit
before signing or payment. If that combined record would be too large, shorten
the text or reduce the configured relay URLs. Existing saved creation attempts
keep their original data when resumed.

The end time must be in the future and no later than **7 February 2106,
06:28:15 UTC**. The form shows the upper bound in your local time when exceeded.

## Write the resolution criteria

The market description is the resolution criteria. Write it in Markdown.
New oracle announcements retain this same source text. Existing signed
announcements remain unchanged.
Character and byte limits apply to the full source, including Markdown syntax.
Preview keeps the source counts and validation errors visible.

The market page shows raw HTML as plain text. A link must use an `http`,
`https`, or `mailto` address. It opens in a new tab. The page shows other
links as plain text. The page does not load images. It shows an image as a
link with the alternative text of the image.

## Keep a draft image

The browser saves your selected JPG, PNG, or WebP image before payment.
The image must contain data and must not exceed 5 MiB.
Reloading in the same browser restores the image preview, even before wallet setup.
If the browser cannot save or restore the selected image, creation stops.
Select the image again or remove it before continuing.
You can replace or remove the image before creation preparation starts.
After preparation, retries use the original saved image.
Keep browser storage enabled. Clearing site data removes the local draft.

## Resume an incomplete creation

Before mint registration, the client publishes the saved announcement to the
saved relays. A relay that does not connect within a few seconds does not delay
the others. If no saved relay accepts the announcement, creation stops before
mint registration and shows an error. Resume the same creation later. Do not
start another payment. A saved creation keeps its original relay list.

Mint registration can succeed before the engine accepts the market.
If the engine request fails, resume the saved creation instead of starting
another one. Use the original wallet, oracle key, mint, and engine.
Keep the local browser data or daemon profile until creation finishes.

A saved creation belongs to the Nostr ID that started it. If you change your
Nostr ID, the browser shows the ID that owns the saved creation. Switch back to
that ID to resume it. This browser keeps the oracle data of that ID, so
another ID cannot create a market here. With the original ID, you can discard
the saved creation if no registration fee payment has started. Your draft
stays, and you can create the market again. A creation with a fee payment
cannot be discarded.

The client retains the original announcement, market details, thumbnail,
and registration payment reference. Reloading does not require you to select
the thumbnail again. After mint registration is confirmed, resuming does not
charge another registration fee. If a response is lost, the client checks
the existing registration before it sends another request.
A paid mint registration alone does not mean that the market is ready.

If the registered image presence differs from the saved creation, the client
refuses to report completion. Keep the saved creation and its local data.
Do not pay again or create a replacement market. Automatic image repair is
not available. Retrying keeps the original image and payment reference.

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

## Keep and restore your oracle backup

After creation finishes, the client sends an encrypted oracle backup to
the original relays. Backup failure does not undo creation or charge another fee.
Delivery runs automatically. The market row shows a message only when you must act:

- No relay has saved the current backup yet. Keep this browser's data.
- The backup or the saved outcome needs the oracle's local key. Add the oracle's nsec in Settings.

Keep this browser's data until the result shows Published and no message appears.

Changing your Nostr identity does not erase retained oracle data.
If a different key owns that data, private oracle preparation and recovery
refuse the key change. Keep the data and return to its original key.
Saved public artifacts remain available for exact delivery retry without a signer.

Use the original local Nostr key. When that identity becomes ready, the browser
resumes pending backup delivery and searches configured relays for missing
oracle records. It also retries when relay settings change or connectivity
returns. Discovery uses bounded pages. Recovery never selects or publishes
an outcome automatically.

Open Creator to see restored oracle records in the normal market list.
Use the row's Close market action to choose an outcome. Confirm the choice
before publication. A saved outcome is delivered automatically.
See [Resolution](/technical/reference/resolution/).
The client fetches each selected backup event again and checks its signature,
encryption, and oracle binding before import.
The browser and native client use the same portable backup format.
Restore retains the original announcement, signing authority, mint, engine,
and relay destinations. It restores an oracle record, not a paid creation record.
NIP-07 extension signing does not support this private recovery path. It needs
the matching local Nostr key.

Discovery depends on relay retention. A page or an empty result does not
prove that all backups were found. Configure another relay for automatic recovery,
or use the CLI commands below with the exact backup event ID and source relay URL.
Manual discovery and exact restore are CLI operations. Creator has no manual
recovery panel. CLI exact restore also works without configured discovery relays.

The market row shows incomplete restoration. It shows backup delivery only when you must act, as described above.
CLI status distinguishes preparation, initial delivery, terminal replacement,
deletion requests, and pending local updates.
Initial backup confirmation does not confirm the terminal replacement.
If import is incomplete, restore the same version again before signing.
Backup preparation needs the original key. A retry of a saved exact backup
runs without a signer. It uses the original destinations.

Use one current oracle copy. An old restored copy can still sign another
outcome. Never sign different outcomes for the same announcement from different
devices or backup copies. Two different outcome signatures using the same nonce
can reveal the oracle private key. A missing public result does not prove that
another copy has never signed. Manual signing after restoration remains available;
the resolution dialog warns about this risk.
After resolution delivery, the client attempts a replacement that
retains the exact signed result without fresh signing authority.
The browser starts it after verified engine evidence or a relay acknowledgment.
The CLI starts it after a relay acknowledgment.
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
See [Resolution](/technical/reference/resolution/) for restored oracle signing
and engine-down publication.

## Amounts and prices

For a yes/no or categorical market, one winning share pays one sat before
redemption fees. Its purchase price is a separate amount. Prices use steps
of 0.1 percentage points, such as 53.3%. These settings are fixed; you do
not select them when you create the market.

The mint must confirm the market's currency before registration can finish.
If registration reports that this check is not ready, try again after the
mint has registered the event.

## Market Lifecycle

A market closes when an oracle attestation is accepted or its announced deadline
arrives, whichever comes first. A market can have no deadline. In that case,
no deadline-based close is scheduled. An accepted attestation can still close
the market.

After a market closes, trading ends. No new orders or bot funding are accepted.
Closure at the deadline does not identify winning tokens or guarantee a refund.
Winning tokens can be redeemed for ecash only after the mint accepts a result.
The redemption period is a mint policy shared across its markets. See
[Resolution](/technical/reference/resolution/) for missing-result and
redemption rules.
