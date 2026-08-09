---
title: 'Encrypted wallet backup'
description: 'How browser wallet recovery works and what the backup service can observe'
sidebar:
  order: 3
---

The web app keeps the live wallet database in your browser. It also uploads an
encrypted copy of recoverable wallet data so that ordinary browser storage
cleanup, quota eviction, or moving back to a previously used wallet does not
make its balance disappear from the interface. Encrypted backup is enabled by
default in the web app.

Only keys derived from the wallet's 12-word recovery phrase can decrypt a
vault. The backup service stores padded ciphertext and cannot read proofs,
balances, mints, markets, or positions. Restoring a backup does not give the
service authority to spend funds.

## What the service can observe

Encryption does not hide every kind of metadata. The matching-engine operator
can associate an authenticated account with its encrypted vaults and can
observe approximate stored size, object count, update timing, and network
metadata. This may reveal that a wallet is active or give a rough indication of
inventory size, even though the contents and exact balance remain encrypted.

If you do not trust the matching-engine operator with that anonymity metadata,
use the command-line wallet in complete-local mode with encrypted backup
disabled. That mode keeps its complete operational wallet state in its local
SQLite database. The command-line recovery tools also provide the emergency
NUT-13/NUT-09 seed-recovery path if the backup service is unavailable or has
lost its data. This command scans all regular keysets. It uses a counter-zero
discovery probe to select non-expired CTF keysets before it scans them fully.
Each keyset uses the standard 300-counter gap limit.

## Multiple wallets

One authenticated account can retain several independent encrypted vaults. A
vault belongs to one wallet seed, and funds never move between vaults. The web
app displays only the wallet for the recovery phrase currently open:

- entering a new recovery phrase starts a new, empty wallet;
- entering a previously used recovery phrase downloads and opens that wallet's
  latest encrypted backup again.

The service retains one current snapshot for each vault, not a history of old
wallet states. Old snapshots could contain proofs that have since been spent,
so they are not presented as recoverable wallet versions.

The initial 64 MiB encrypted-storage allowance is shared by all vaults under
the same authenticated account. An account may create at most 256 distinct
seed-derived vault identities over its lifetime. Reopening a previously used
seed does not consume another identity, but revoking or deleting a vault does
not return its identity slot. If a recovery phrase is permanently lost, its
encrypted vault cannot be identified or deleted in this release and continues
to use part of the storage allowance. Keep every phrase for a wallet you may
want to reopen.

## Keep your recovery phrase

Encrypted backup is a convenience and continuity feature, not a replacement
for your recovery phrase. Keep the 12 words offline and safe. The service may be
unavailable, refuse an upload when its storage allowance is full, or lose its
data. A failed upload leaves the affected proofs in local storage; the web app
must not discard them as backed up.

Seed recovery reconstructs deterministic regular proofs and selected CTF
proofs. It does not reconstruct transient operation records, range locators, or
refund locators from the seed. Keep the local durable store until every active
operation is terminal. Loss of those records can prevent seamless operation
continuation even when the underlying deterministic proofs can later be
recovered.
