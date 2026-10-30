---
title: 'Encrypted wallet backup'
description: 'What to keep safe, what wallet backup can restore, and what remains private'
sidebar:
  order: 3
---

Keep your 12-word recovery phrase offline and safe. Keep the wallet's local
data while a trade, payment, or refund is unresolved. Encrypted backup helps
you recover wallet assets. It does not replace the phrase or every local record.

## Seed reminder for deposits

Top-up and deposit screens show a non-blocking reminder until you view the
wallet's recovery phrase in Settings, then Cashu. The reminder appears again
each time you open one of these screens. Viewing the phrase acknowledges the
reminder for the current wallet. It does not confirm the encrypted backup or
prove that you made an external backup. A different wallet starts with a new
reminder.

## Back up your Nostr key separately

Your Nostr private key (`nsec`) is separate from your wallet recovery phrase.
The phrase does not restore this key.

For a key created by the app, open Settings, then Nostr, then **View nsec**.
You can back up the key even if your relay profile does not load.
Confirm the warning before you view the key. Use **Copy nsec** only in private.
The app blurs the key after 15 seconds and hides it after 60 seconds.
Keep the copy safe. Do not share it with support or other users.

For an imported key, keep your original backup. Settings does not show backup
controls for imported keys.

If you use a NIP-07 external signer, back up the key in that signer.
bitCaster cannot display its private key.

## What you must keep

The backup service can be unavailable, refuse an upload, or lose its data.
A failed upload leaves the affected ecash records, called proofs, in local
storage. The web app must not discard them as backed up.

CLI recovery from your phrase scans deterministic regular `msat` proofs by
default. This includes new ordinary refund outputs after the mint signs them,
within the selected scan range. It does not reconstruct the refund's operation
history. Older refunds can still require their saved local records.
Condition-specific recovery requires the supported discovery route described
below. The web app uses encrypted backup recovery.
Keep the local wallet database until every active operation has a confirmed
final result. Seed recovery does not replace saved retry records for unfinished
operations.
Do not clear browser storage to resolve an uncertain payment or trade.

## What the web app stores

The web app has two independent wallet features. It enables both by default.

- Encrypted proof backup stores an encrypted copy of recoverable proofs.
- Display-only asset monitoring helps the app identify an exact asset that may
  be missing from the local wallet.

The live wallet database remains in your browser. These features help if the
browser removes stored data or you reopen a previously used wallet.

## Encrypted proof backup

Only keys derived from your 12-word recovery phrase can decrypt the backup.
The backup service can associate an authenticated account with a wallet id. It
receives an opaque asset locator, a declared amount, approximate stored size,
object count, update timing, and network metadata. It does not receive raw mint
URLs, condition or market ids, trade ids, proof bodies, proof secrets, or
spending keys. It cannot spend your funds or read the encrypted proof contents.

Encryption protects spending authority. It does not make wallet activity
anonymous from the matching engine. Asset monitoring separately lets the
matching engine associate an authenticated user and wallet id with approved
asset, amount, condition, and activity metadata. The matching engine and backup
service can correlate the shared wallet id.

The mint receives neither your matching-engine identity nor asset-monitoring
data. The mint only receives the Cashu requests that are required for wallet
operations.

## Display-only asset monitoring

Asset monitoring does not store proofs for you and does not give the matching
engine authority to spend. It is display-only. Its primary purpose is a
best-effort display of your current and historical portfolio in base units. It
uses user-approved asset, amount, condition, and activity metadata.

The history chart shows changes in estimated portfolio value. These changes
can include cash flows. They do not measure profit or investment return.

Its secondary purpose is to help the web app identify an exact missing asset.
The app can then make one bounded recovery attempt.

The portfolio's Funds tab groups regular funds by mint and asset. It shows
money in sats. Different mints remain separate. The portfolio refreshes after
the service accepts a wallet update. An updating or unavailable value does
not mean that funds are lost. Positions without a known price remain visible.
Use the wallet's payment or trade flow to check which funds it can spend.

During portfolio updates or an unfinished claim, the app can keep the last
successful value estimate on screen. It marks that estimate as out of date.
The estimate is not an amount available to spend. The app keeps it only in
memory. Reloading the page, changing the wallet, or changing the signed-in
account clears it. An unavailable initial value does not become a saved
estimate. Claim progress comes from the wallet's current operation, not from
the saved estimate.

## Web app restore order

When the web app needs proofs for one asset, it uses this order:

1. It uses proofs in local browser storage.
2. If the validated backup inventory contains the asset, it restores that
   asset's current encrypted bundle.
3. It makes one bounded targeted recovery attempt only when monitoring
   identifies an exact missing asset.

The web app does not make a broad automatic keyset scan when monitoring does
not identify an exact missing asset. If the backup service is unavailable, the
web app shows a persistent error. Unavailability does not prove that an asset
is absent and does not authorize automatic mint recovery. Broad recovery
remains available through the CLI.

If a trade needs Engine Score and locally available funds are insufficient,
the app checks wallet recovery. If recovery is unavailable, it offers Retry
or Add funds. This message does not mean that other wallet funds are lost.
Retry checks recovery again within the existing recovery limits.
Keep browser data while a trade or payment remains unresolved.

Wallet recovery supports monetary tokens with unit `msat` only. The web app
shows their value in sats: 1,000 msat equals 1 sat. Recovery does not convert
tokens with unit `sat`.

Counter-zero discovery is only a selection step. It selects non-expired CTF
keysets before a full recovery. It is not full recovery by itself.

## Multiple wallets

Use the ID that first enabled backup for a recovery phrase. This release does
not transfer that binding to another ID and has no backup-owner selector.
The recovery phrase and backup realm derive the encryption keys. Your Nostr
secret key is not the encryption key.

If the app reports a different ID, sign in with the original ID. The app keeps
your local funds and unfinished work. It does not create an empty replacement
backup. A revoked or deleted backup does not release the original ID binding.
CLI seed recovery remains available for supported regular-msat funds within
the scanned range. It does not restore the complete wallet operation history.

One authenticated account can retain several independent wallet ids. Each
wallet id belongs to one wallet seed. Funds never move between wallet ids. The
web app displays only the wallet for the recovery phrase currently open:

- entering a new recovery phrase starts a new, empty wallet;
- entering a previously used recovery phrase downloads and opens that wallet's
  latest encrypted backup again.

The service retains one current head and the current per-asset bundles for each
wallet id. It does not provide old wallet states as recoverable versions. Old
versions could contain proofs that have since been spent.

Browsers that use the same recovery phrase belong to the same wallet. The
latest authenticated backup can tell another browser that an exact conditional
proof belongs to a losing outcome, even if that browser missed intermediate
backup updates. The browser keeps that proof complete and visible, but does not
select it for spending. Synchronization does not silently delete the proof or
overwrite an unfinished local wallet operation.

The initial 64 MiB encrypted-storage allowance is shared by all wallet ids under
the same authenticated account. An account may create at most 256 distinct
seed-derived wallet ids over its lifetime. Reopening a previously used seed
does not consume another slot. Revoking or deleting a wallet id does not return
its slot. If a recovery phrase is permanently lost, its encrypted data cannot
be identified or deleted in this release. It continues to use part of the
storage allowance. Keep every phrase for a wallet you may want to reopen.

## Use the same wallet in another browser

The app shows **Preparing wallet backup** while it checks your backup.
The deposit and top-up screens show this message where you enter an amount.
Wait for the check to finish before you create an invoice or add ecash.
You do not need to keep clicking the action button.
If another tab uses the wallet, close that tab when you no longer need it.

If backup stops, select **Retry wallet backup** in the same screen.
Retry keeps your amount, local funds, and unfinished work.
It does not create or submit an invoice.
After backup is ready, select the action button to continue.
If the message asks you to sign in, sign in or reload the page if you are already signed in.
This check does not require sign-in when backup is disabled. When backup is enabled, sign in before the app checks or creates its backup.
Retry does not guarantee that backup or recovery can finish.

A fresh browser restores and checks the wallet's current encrypted backup
before it enables wallet actions or uploads new backup data. You can read the
app while recovery runs. If recovery cannot finish, wallet actions stay paused.

Use one browser at a time for wallet actions. Another open browser can still
run background work. When another browser changes the wallet backup, this
browser can stop new wallet actions and automatic backup uploads.

The app keeps local proofs and unresolved operations. It does not
automatically merge different browser states. Reload starts recovery. It does
not delete local data or guarantee that wallet actions can resume.

The recovery message explains what remains unresolved. Use its retry action
to check recovery again. Keep browser storage while recovery is incomplete.
The app resumes new wallet actions only after it has checked the current
backup and resolved the local state that blocks recovery.

An unpaid invoice can still block recovery if the wallet has already prepared
its ecash outputs. This can happen even if you no longer intend to pay the
invoice. The app keeps the invoice and its prepared outputs. It does not
replace them automatically. Reloading or retrying does not guarantee that this
browser can resume wallet actions.

## CLI privacy and emergency recovery

CLI profile inspection can stop before a command is sent. If you see
`daemon profile identity changed during inspection`, let current wallet work
finish. Then run the command again. The CLI does not repair the profile or
replay the refused command.

Each inventory check can repeat once if normal SQLite WAL or SHM cleanup
removes a listed file. This happens before dispatch and keeps the original
profile identity. A replaced profile,
invalid permissions, or an invalid schema still causes refusal. This does not
retry a command or repair the profile.

The command-line wallet can use complete-local privacy mode. This mode can
omit both encrypted backup and asset monitoring. It keeps complete wallet
state in its local durable store.

Use `wallet recover-seed` for emergency NUT-09/NUT-13 recovery when the backup
service is unavailable. The command scans regular `msat` keysets only. It does
not list conditional keysets. The default `--gap-limit` is 300. Set a larger
gap to scan farther after the last verified signature. Each request has at most
300 counters, and each invocation processes at most four batches.

Supply either `--wallet-seed-hex-file` or `--recovery-phrase-file`. The phrase
file must contain a valid English BIP-39 phrase and must be readable only by
the owner. Recovery derives the standard seed with an empty BIP-39 passphrase.
Keep the file private and remove it when recovery is complete.

A recovery job binds its scope and gap limit. Retry with the same values. Use a
new recovery ID for a deeper scan. The result reports scanned ranges and local
counter bindings not covered by this scan. A completed scan does not prove
that the wallet has no other funds. A gap can hide later outputs.

Use `--condition-id <64-lowercase-hex-id>` to recover one condition. The mint
must advertise `nuts.CTF.condition_keyset_filter: true`. Recovery includes
inactive historical keysets for that condition. If the capability is absent
or false, recovery refuses. It never falls back to listing all conditions.
Without this option, recovery scans regular `msat` keysets only. Stop the old
client before seed recovery. Seed recovery does not restore live authorizations.
