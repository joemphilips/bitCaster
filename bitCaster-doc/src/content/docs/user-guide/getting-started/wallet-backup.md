---
title: 'Encrypted wallet backup'
description: 'What to keep safe, what wallet backup can restore, and what remains private'
sidebar:
  order: 3
---

Keep your 12-word recovery phrase offline and safe. Keep the wallet's local
data while a trade, payment, or refund is unresolved. Encrypted backup helps
you recover wallet assets. It does not replace the phrase or every local record.

## What you must keep

The backup service can be unavailable, refuse an upload, or lose its data.
A failed upload leaves the affected ecash records, called proofs, in local
storage. The web app must not discard them as backed up.

Recovery from your phrase can reconstruct deterministic regular proofs and
selected conditional-token proofs. It does not reconstruct every pending
operation or refund record. In particular, it does not restore transient
operation records, range locators, or refund locators. Keep the local wallet
database until every active operation has a confirmed final result.
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

Its secondary purpose is to help the web app identify an exact missing asset.
The app can then make one bounded recovery attempt.

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

One authenticated account can retain several independent wallet ids. Each
wallet id belongs to one wallet seed. Funds never move between wallet ids. The
web app displays only the wallet for the recovery phrase currently open:

- entering a new recovery phrase starts a new, empty wallet;
- entering a previously used recovery phrase downloads and opens that wallet's
  latest encrypted backup again.

The service retains one current head and the current per-asset bundles for each
wallet id. It does not provide old wallet states as recoverable versions. Old
versions could contain proofs that have since been spent.

The initial 64 MiB encrypted-storage allowance is shared by all wallet ids under
the same authenticated account. An account may create at most 256 distinct
seed-derived wallet ids over its lifetime. Reopening a previously used seed
does not consume another slot. Revoking or deleting a wallet id does not return
its slot. If a recovery phrase is permanently lost, its encrypted data cannot
be identified or deleted in this release. It continues to use part of the
storage allowance. Keep every phrase for a wallet you may want to reopen.

## CLI privacy and emergency recovery

The command-line wallet can use complete-local privacy mode. This mode can
omit both encrypted backup and asset monitoring. It keeps complete wallet
state in its local durable store.

The CLI also keeps broad emergency NUT-09/NUT-13 recovery. Use it when the
backup service is unavailable or when you need seed recovery. It scans regular
keysets. It uses counter-zero discovery to select non-expired CTF keysets, and
then scans the selected keysets fully. Each keyset uses the standard
300-counter gap limit.
