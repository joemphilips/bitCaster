---
title: 'Wallet backup and recovery'
description: 'What the recovery phrase restores, what the encrypted wallet backup holds, and CLI emergency recovery.'
sidebar:
  order: 4
  label: 'Wallet recovery'
---

Keep your 12-word recovery phrase offline and safe. Keep the wallet's local
data while a trade, payment, or refund is unresolved. The wallet backup helps a
new browser find your funds and positions. It does not replace the phrase or
every local record.

:::note
The wallet backup is always on. It is an encrypted list of the keysets that
the wallet used: one keyset for each asset and market outcome. The matching
engine stores it. Only your recovery phrase can read it. It holds no ecash,
no amounts, and no spending keys. There is no setting that turns it off. The
backup needs no sign-in.
:::

## Seed reminder for deposits

Top-up and deposit screens show a non-blocking reminder until you view the
wallet's recovery phrase in Settings, then Cashu. The reminder appears again
each time you open one of these screens. Viewing the phrase acknowledges the
reminder for the current wallet. It does not prove that you made an external
backup. A different wallet starts with a new
reminder.

## Back up your Nostr key separately

Your Nostr private key (`nsec`) is separate from your wallet recovery phrase.
The phrase does not restore this key.

For an imported key, keep your original backup. Settings does not show backup
controls for imported keys.

If you use a NIP-07 external signer, back up the key in that signer.
bitCaster cannot display its private key.

## What you must keep

The matching engine can be unavailable or refuse a backup upload. Trading
continues, and the app tries the upload again later. Your ecash records, called
proofs, stay only in local storage: the backup holds no proofs. A failed upload
removes nothing from the browser.

CLI recovery from your phrase scans deterministic regular `msat` proofs by
default. This includes new ordinary refund outputs after the mint signs them,
within the selected scan range. It does not reconstruct the refund's operation
history. Older refunds can still require their saved local records.
Condition-specific recovery requires the supported discovery route described
below. The web app restores market positions in a new browser automatically
(see "Open your wallet in a new browser").
Keep the local wallet database until every active operation has a confirmed
final result. Seed recovery does not replace saved retry records for unfinished
operations.
Do not clear browser storage to resolve an uncertain payment or trade.

## Open your wallet in a new browser

When you restore a wallet with its recovery phrase in a browser that did not
create it, the app restores your funds and your market positions from the mint
at once. It does this automatically. It does not need a Nostr identity. It
reads the wallet backup and restores the keysets that the backup lists, the
regular keysets of the mint, and the markets that asset monitoring or your
activity log names. It never checks every market of the mint.

Each time the app opens a wallet, it checks the wallet. While the app checks
or recovers the wallet, one status row shows above the Positions, Funds, and
Activity tabs of Portfolio, and on the Sell tab. The row shows one of these
states:

- **Checking wallet…**: the app checks the wallet.
- **Recovering wallet…**: the app recovers funds or positions, or completes a
  wallet operation.
- **Waiting for the mint…**: the mint reports some funds as pending.
- **Recovery resumes at** and a time: the recovery waits until that time. The
  row shows the date too when the time is not today.

The row disappears when the check finishes. Portfolio shows **No funds** or
**No active positions** only after the check finishes. Until then, balances
that the app already knows stay visible. Funds that the app did not read from
the wallet in this browser show in gray. The balance in the header shows
**—** while the holdings are unknown.

After an error, the recovery waits and then tries again. If the recovery fails
again and again, the row shows **Wallet recovery failed.** and **Retry**. If
the app cannot read the wallet data in this browser, the row shows **Wallet
data could not be read.** and **Reload**. If the wallet does not open, the row
shows **The wallet is not open.**, **Reload**, and a link to **Replace Wallet**
in Cashu Settings. There you can enter the recovery phrase of the wallet.

A browser starts at most 4 such restores in 24 hours. When it reaches this
limit, the next restore waits until the oldest of the 4 is 24 hours old.
The status row shows **Recovery resumes at** and the time while it waits. A
restore that continues after an error, and **Retry**, do not count as a new
restore.

Let your trades finish before you move to a new browser. An order in progress
locks funds that only the old browser can complete or refund. After the order
finishes, the new browser restores its result.

Use one browser at a time. When the app finds outputs that another browser
signed with this wallet, it shows **This wallet was used in another browser.
Use one browser at a time.**

The restore tells the mint which outputs belong to this recovery phrase. The
mint can link these outputs and can learn which markets the wallet traded. The
mint does not receive your Nostr identity or your matching-engine account.

When the restore is done, Portfolio shows the line **Missing funds? Use
`bitcaster wallet recover-seed --gap-limit 3000`.** The restore of one keyset
stops after 300 unused outputs in a row, for example after many orders that did
not fill. The CLI command with a larger `--gap-limit` finds funds after such a
run. Close the line when you do not need it.

Without a wallet backup, for example when the old browser never wrote one, the
restore cannot find the markets that only the backup lists. The same applies
while the matching engine is unavailable. Then Portfolio also shows **Some
positions may be missing. Use `bitcaster wallet recover-seed --all-conditions`.**
This line stays while the restore is partial. Portfolio does not show
**No funds** or **No active positions** as final. After an
unavailable matching engine, **Retry** reads the backup again, and so does the
next opening of the wallet.

One restore checks at most 150,000 outputs at the mint. When a restore reaches
this limit, it stops and shows the same partial result. **Retry** continues
where it stopped.

A browser that already held its wallet before this version of the app does
not run this restore. It keeps its records and writes the wallet backup of the
keysets that it uses.

### Check for use in another browser

Before each buy or sell, the app asks the mint whether another browser already
signed an output that the order plans to use. If it did, the app skips past
those outputs, plans the order again, and checks it again. Only then does it
submit the order. If the mint does not answer the check, the app submits no
order and asks you to try again. The check sends the outputs of the order to
the mint. It also sends the outputs at the positions that the locked order
funds use. These outputs are not signed yet.

The app does not check the mint on a schedule. It checks all the keysets that
it uses only after evidence of use in another browser: the mint refuses an
order because another browser used the same outputs or funds, or the check
before an order finds outputs that another browser signed. Then the browser
checks each keyset (the mint keys of one asset) that it uses for outputs that
another browser signed after its own last output. When the app finds such
outputs, it adds the funds and positions to this browser.

When the browser checks the keysets that it uses, it sends to the mint the next
100 outputs of each keyset. These outputs are not signed yet. The mint can link
them to this recovery phrase when another browser uses them later. The wallet
backup holds no output positions, so this keyset check stays.

When the check before an order finds outputs of another browser, or the mint
refuses outputs that another browser already used, the app shows **This wallet
was used in another browser. Use one browser at a time.** After such a mint
refusal, the app also reads the wallet backup again.

If the app cannot add the outputs that it found, it shows
**Positions could not be restored from the mint.** with **Retry**. The funds
stay at the mint. Funds that the mint reports as pending wait until the other
browser finishes. An order that needs them shows **Some funds of this wallet are
still pending at the mint. No order was submitted. Try again later.**

Two browsers that trade with one wallet at the same time can still use the
same output. The mint then refuses the settlement that holds the order. When
bitCaster can show that an output of your order was already used by another
operation of your wallet, it removes your order from that settlement. The
other orders can still settle. Your order fails, and the **Trade failed**
panel shows the reason until you dismiss it. A Participation Score penalty of
100 Score is charged once for that settlement. Your funds are not lost. As
for another failed order, the panel shows the locked funds and the time when
the lock ends. Then they return to this wallet, less preparation and refund
fees.
The wallet recovers them automatically while the app is open. Your order can
also fail when another output in the same settlement was already used. Then
no penalty is charged for your order.

## What the web app stores

The web app has two independent wallet features. It enables both by default.

- The wallet backup lists the keysets that the wallet used. It is always on.
- Display-only asset monitoring shows your portfolio. You can turn it off.

The live wallet database remains in your browser. The backup helps when the
browser removes stored data or you open the wallet in a new browser.

## Wallet backup

Only keys derived from your 12-word recovery phrase can read or change the
backup. The app writes it when the wallet first uses a new keyset, for example
in a new market. A trade in a market that the backup already lists writes
nothing, and a failed order writes nothing. A trade never waits for the backup.
When the matching engine is unavailable, the app tries again later.

At each read and each write, the matching engine sees a request key that
belongs to your recovery phrase, the time, and network metadata such as your IP
address. So it can see when you open the wallet. It also sees the approximate
size of the backup. It does not see mint URLs, markets, outputs, amounts, or
spending keys. The backup cannot spend your funds. Encryption protects your
funds. It does not make wallet activity anonymous from the matching engine.

If the app cannot read the backup, or the backup is full, the app shows a
persistent message and does not change the backup. Trading continues. If the
backup uses a newer format, update the app.

To delete the backup, use the CLI command `wallet backup delete`. It needs the
recovery phrase. A browser that still holds the phrase writes the backup again
at its next upload.

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

The portfolio's Funds tab reads regular funds from the wallet in this browser,
not from asset monitoring. It groups them by mint and asset and shows money in
sats. Different mints remain separate. Funds that an unfinished trade or
payment reserves do not appear. The tab updates as soon as a deposit, trade,
or payment changes the wallet. If the app cannot read the local wallet yet,
the tab can show the funds that asset monitoring reports. These amounts show
in gray.

## Web app restore order

When the web app needs proofs for one asset, it uses the proofs in local
browser storage. The wallet backup holds no proofs.

The web app never checks every market of the mint. Broad recovery is
available only through the CLI command
`bitcaster wallet recover-seed --all-conditions`.

Wallet recovery supports monetary tokens with unit `msat` only. The web app
shows their value in sats: 1,000 msat equals 1 sat. Recovery does not convert
tokens with unit `sat`.

Counter-zero discovery is only a selection step. It selects non-expired CTF
keysets before a full recovery. It is not full recovery by itself.

## Multiple wallets

Each recovery phrase has its own wallet and its own backup. The backup belongs
to the phrase, not to a Nostr ID. Funds never move between wallets. The web app
shows only the wallet of the phrase that is open:

- entering a new recovery phrase starts a new, empty wallet;
- entering a previously used recovery phrase opens that wallet and restores
  it from the mint.

Keep every phrase for a wallet that you may want to open again.

## Use the same wallet in another browser

Use one browser at a time for wallet actions. Another open browser can still
run background work. The backup does not keep the outputs of two browsers in
step. The app checks each order with the mint before it submits the order, so
a move to another browser does not lose funds.

**Replace Wallet** in Cashu Settings reads the backup again first. It uploads
the keysets that the backup does not list yet. It replaces the wallet only when
the matching engine confirms a backup that lists every keyset of the wallet, or
when the matching engine refuses to store a larger backup. In that case, the
app shows that the backup of the current wallet is incomplete before it replaces
the wallet. Select **Replace Anyway** to continue, or close the dialog to keep
the current wallet. To restore that wallet fully later, use
`bitcaster wallet recover-seed --all-conditions`. While the matching engine is
unavailable, the app keeps the current wallet. Try again later.

**Replace Wallet** also checks the outputs that this browser signed. When one
keyset has a run of 300 or more unused outputs before a later output, a restore
in another browser can miss the later funds. The app then shows the CLI command
`bitcaster wallet recover-seed --gap-limit <n>` with a gap that passes the run.
Select **Replace Anyway** to continue.

When this browser reads the wallet backup and finds a keyset that another
browser listed and that this browser never used, it restores that keyset.

Removing a resolved losing position is local to this browser. A later restore
of the wallet in another browser can show the position again. It has no value,
and you can remove it again.

## Replace a wallet or add a CLI profile

To use another wallet, open the wallet section in Settings and import its
recovery phrase. This replaces the active wallet; it does not add a second
named profile. First, back up the current recovery phrase in Seed Backup.
Replacement waits until no order, refund, send, deposit, or withdrawal is
unfinished. It also waits until the matching engine confirms the wallet
backup. To use the old wallet again, restore it from its recovery phrase.
Local records that the mint cannot restore, such as completed order history,
do not come back. Your Nostr account does not change. Activity stays
associated with the wallet that performed it.

The native CLI uses separate wallet profiles instead of replacing one in place.
Select a profile with `--datadir`. Import seed and signer files only into a fresh
profile. Keep the old profile while it has funds or unfinished work.
Initialization imports keys; it does not recover funds.
`wallet recover-seed` requires explicit acknowledgment of seed-candidate disclosure
to the mint. See [CLI wallet and signer commands](/technical/#select-and-import-a-native-wallet-profile).

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

The command-line wallet keeps complete wallet state in its local durable store.

### Wallet backup of the CLI

The daemon of the CLI writes the same wallet backup as the web app. A new
browser with the recovery phrase then restores the markets that only the CLI
used. The backup is on by default. Asset-monitoring privacy mode does not
change it. To turn the backup off, set its environment to `disabled`. With a disconnected signer, the daemon does not write the backup.
The next start with a connected signer writes the keysets that the backup does
not list.

- When the daemon starts, it reads the backup once and writes the keysets that
  the backup does not list.
- After a deposit, trade, or other wallet change, the daemon writes the backup
  only when the wallet has a keyset that the backup does not list. A trade in a
  listed market writes nothing.
- A market keyset appears in the backup after the wallet receives its first
  output in that keyset. An order that fails before any output writes
  nothing.
- When the matching engine is unavailable, the daemon tries again later. A
  trade never waits for the backup. The daemon does not read the backup on a
  schedule.

The backup of the CLI and the backup of a browser with the same recovery phrase
are one backup. Each writer adds its keysets to the current backup, so no
writer removes the keysets of another writer.

`wallet backup status` shows the environment and the state of the daemon
writer as JSON:

- `current`: the matching engine stores a backup that lists every keyset of
  the wallet.
- `pending`: a write waits. `reason` names the failure, or `write-interval`
  for the short wait between two writes. While the daemon waits to try again
  after a failure, `reason` keeps naming that failure.
- `blocked`: the daemon stops writing. `over-cap` means that the backup is
  full. `undecodable` or `unsupported-version` means that the daemon cannot
  read the stored backup. Trading continues.
- `starting`: the first write after the start has not finished.
- `disabled`: the environment of the backup is `disabled`. The daemon does not
  write the backup. This status has no `realm`.

With a disconnected signer, the command returns the error code
`recovery-index-unavailable`.

Set the environment of the backup with
`config set --recovery-index-realm <realm>`: `bitcaster-production` by
default, `bitcaster-staging`, `bitcaster-local` for a local development
engine, or `disabled`. With `disabled`, the daemon does not start the writer
and sends no backup request. The command restarts a daemon that the CLI
started. Restart another daemon yourself. For one command, use
`BITCASTER_RECOVERY_INDEX_REALM` or the global `--recovery-index-realm`
option. See [CLI settings](/technical/#cli-settings). When the environment does not match the matching engine, the
engine refuses the backup. Then `wallet backup status` shows `pending` with
`unauthenticated`.

At each read and each write, the matching engine sees the request key of your
recovery phrase, the time, and network metadata such as the IP address of the
computer that runs the daemon. The daemon sends these requests from the same
computer as its signed order requests, a few seconds after them. So the
matching engine can link the request key to your account of the CLI. This
applies also when asset monitoring is off, although the CLI then sends no
wallet ID. The request key is the same for the CLI and for a browser with the
same phrase. So the matching engine can also link your account of the CLI to
the account and the network address of that browser. To stop these requests,
set the environment of the backup to `disabled`. The backup holds no ecash, no
amounts, and no spending keys.

`wallet backup delete` deletes the wallet backup at the matching engine. Supply
`--wallet-seed-hex-file` or `--recovery-phrase-file`. `--realm` selects the
environment. Without it, the command uses the configured environment. When the
configured environment is `disabled`, the command needs `--realm`. Before the
request, the command asks you to trust a new engine URL. Add
`--trust-engine-url` to trust it without the question. A daemon
or a browser that still holds the phrase writes the backup again at its next
start or its next new keyset.

### Emergency recovery

Use `wallet recover-seed` for emergency NUT-09/NUT-13 recovery when a browser
restore is incomplete. Without an option, the command scans regular `msat`
keysets only. Add `--all-conditions` to restore market positions too: the
command checks the first 128 counters of each market in the public catalogue,
and it recovers each market where the mint signed an output of this seed. The
default `--gap-limit` is 300. Set a larger
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
