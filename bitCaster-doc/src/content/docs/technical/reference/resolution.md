---
title: 'Reporting results and claiming payouts'
description: 'Market closure, reporting a result from the browser or CLI, restored oracles, missing results, and claims.'
sidebar:
  order: 7
  label: 'Results and claims'
---

## When trading ends

The market closes for new orders and funding when it accepts a valid oracle
result. It can also close at the announced deadline without a result.
Deadline closure alone does not identify winning tokens.

A verified result can arrive after the deadline closes trading.
It identifies the outcome without reopening trading or changing the first closure time.
A closed market with no verified result remains unresolved. The app shows it
as **Awaiting resolution**, not as **Resolved**.

The oracle can publish its attestation through Nostr. A creator can also
submit the signed attestation directly to the matching engine. Direct
submission still requires signature verification. Nostr relays carry
messages; they do not decide which result is valid.

After the mint accepts the result, winning tokens can be redeemed for their
face value, subject to mint fees and the redemption period. Losing tokens do
not receive the winning payout. In an ordinary YES/NO market, only tokens
for the attested outcome win.

Do not assume that winning tokens can be redeemed indefinitely. The redemption
period is a mint policy shared across its markets. Check the applicable expiry
before you trade and before you claim.

## Report a result as the browser oracle

Once the choice is saved, the outcome and original explanation draft cannot change.
The browser retains the exact signed kind-89 result before delivery.
Keep browser storage enabled.

If delivery is incomplete, the browser retries it automatically. It retries when
the app starts, when the connection returns, when you return to the tab, and when
the signer or the relay settings change. There is no retry button.
After a failed attempt, returning to the tab retries at most once in 10 minutes.
A retry sends the same saved signed events. It never signs a different outcome
and never creates another announcement. Delivery of a saved signed result does not
require the oracle signing key.
If signing stopped before the result was signed, the browser signs the saved outcome
and its original explanation draft once. It does this at the next retry while the
original oracle's local key (nsec) is selected. It signs only when the matching engine is available and has no
result for the market. If the result was signed but its explanation was not, a retry
does not create a signed explanation. The original explanation draft stays saved.

After the engine confirms the result, the browser continues to send it to the relays
in the background. The relay copy is optional. Published does not confirm mint redemption.
After the choice is saved, an explanation failure does not block resolution delivery.
Its verified text can appear on the closed market page. It is not a paid trade comment.

A deadline-closed market with no verified result still permits the creator's
resolution action. Its row shows **Awaiting resolution**. A closed trading status
alone does not identify winning tokens or guarantee a payout. A later verified
result does not reopen trading.

## Report a result as the native oracle

Use the daemon profile that created or restored the oracle announcement.
Select one registered outcome. You can include a short plain-text explanation:

```bash
bitcaster-cli market close --condition-id <condition-id> --outcome Yes --explanation "The announced event has finished." --trust-engine-url
bitcaster-cli market resolution-status <condition-id>
bitcaster-cli market close --condition-id <condition-id> --retry --trust-engine-url
```

Replace `Yes` with the exact outcome label. Use `--trust-engine-url` only for an
engine URL you trust. `--explanation @explanation.txt` reads a UTF-8 file.
The explanation limit is 4096 UTF-8 bytes. The explanation does not change
the signed result, payout, or paid-trade comment ranking.
It is a separate signed kind-1111 event. Its root is the original kind-88
announcement. Its parent is the exact kind-89 attestation.

The client saves the chosen outcome and signed events before delivery.
Keep the original daemon profile. Retry the saved result instead of selecting
another outcome. `--retry` takes no outcome or explanation.
It reuses saved signed events. If explanation preparation failed, it can finish
the original saved draft. If signing stopped before the result was signed, it signs
the saved outcome once with the profile's oracle key. It never signs another outcome.
A restart does not require another market creation or registration fee.

`resolution-status` reports the chosen outcome and both public event IDs.
`attestationPrepared` and `explanationPrepared` report saved signed events.
`relayPublished` and `explanationRelayPublished` report relay acknowledgements.
`engineSynchronized` reports verified matching-engine evidence for the exact result.
`explanationDraftSaved` reports only whether the original draft exists.
Relay delivery and engine synchronization are independent.
Inspect the returned `record` and `failures` even when the command succeeds.
`Closed` confirms engine evidence. It does not confirm both relay deliveries or mint redemption.
An explanation failure does not invalidate a valid resolution.

The supplied-event form, `market close --condition-id <condition-id> --attestation @attestation.json`,
remains available. It does not create a native explanation.

## Resolve a restored oracle or publish while the engine is unavailable

Creator lists restored oracle records separately from markets created on
this device. An unresolved restored record can select a registered outcome
and publish it with the original authority and destinations.
Review and confirm the action in the resolution dialog. Opening or cancelling
the dialog does not publish an outcome. Automatic recovery does not publish it.
The first saved outcome on this device cannot change.
Use only one current oracle copy. Never sign a different outcome for the same
announcement on another device or from an older backup. Two different outcome
signatures using the same nonce can reveal the oracle private key. Manual signing
from a restored record remains available, with a warning in the dialog.
Before a first signature in the browser or an ordinary CLI close, the client reads
that market's original engine again. An existing result, including the same outcome,
or a failed read stops signing before a new choice is saved. This also applies to
retrying an unsigned saved choice; an exact signed retry remains available.
A missing public result cannot establish that no other copy has signed.
See [oracle backups](/technical/reference/market-creation/#keep-and-restore-your-oracle-backup)
for restore and incomplete-import recovery.

A restored record with a saved result uses the same automatic retry.
It sends the identical saved kind-89 event without fresh signing.
A terminal restore needs no signing key for this delivery.
After verified engine evidence or a relay acknowledgment, the browser attempts
the terminal backup. The CLI attempts it after a relay acknowledgment.
Backup failure does not undo successful result delivery.

The browser shows Published only after the matching engine confirms the result. To publish a result
while the engine is unavailable, use the CLI. It can sign or retry through the
original relays without contacting the engine:

```bash
bitcaster-cli market close --condition-id <condition-id> --outcome Yes --relay-only
bitcaster-cli market close --condition-id <condition-id> --retry --republish --relay-only
```

`--relay-only` performs no engine request or engine availability check.
For a first signature, you are responsible for confirming that no other copy has
already used this announcement's nonce. This offline mode cannot consult the
engine for that result and still refuses a conflicting outcome already saved locally.
It applies only to `--outcome` or `--retry`.
`--republish` requires `--retry`. It sends the exact saved attestation even
if a relay previously acknowledged it. It does not change saved progress
or choose another outcome. An exact retry does not require a signing key.
Fresh signing still requires the matching key and unresolved authority.

When the engine returns, run the ordinary saved retry without `--relay-only`.
Synchronization uses the original stored engine URL and the same signed event.
A restart or changed current configuration does not change that destination.
Relay delivery alone does not confirm engine synchronization or mint redemption.

## If the oracle does not publish a result

The first release has no predetermined refund rule for a missing attestation.
The mint operator can choose a refund outcome under its disclosed policy.
A missed deadline does not guarantee an immediate refund or a particular
refund amount. Read that policy before committing funds.

## Claiming winnings

Redemption exchanges winning conditional tokens for regular ecash from the
same mint. This is not a Bitcoin withdrawal. The wallet shows the payout in
sats. To withdraw bitcoin, use the mint's supported BOLT11
Lightning withdrawal flow.

Keep your wallet records until the redemption result is known. If a request
loses its connection, check the existing operation rather than assuming that
the tokens were not spent. See [settlement and recovery](/technical/reference/orders/).

### Using the browser

Cash out checks evidence from the intended oracle when that evidence is available.
The client can reuse verified evidence for the same reported outcome.
A changed outcome needs new verification or the unverified warning below.
If the evidence is missing, unavailable, or invalid, the app shows this warning:
“The mint reports this outcome, but we have not verified evidence from the intended oracle.”
You can still claim. The wallet must verify each received proof before it records
the payout. A mint refusal alone does not prove that a holding lost.
The same warning applies when Remove checks a position through Cash out.
The message stays visible until you close it.

A restored refusal record can lack verified losing evidence. The wallet keeps
these conditional tokens and shows their retained amount. You cannot claim,
sell, or remove tokens in this retained, unverified state.

Open Portfolio and select Cash out for a winning position. A claim can finish
in parts. Each completed payout stays in your wallet if another part fails.

If the claim is pending, keep the wallet data and select Cash out again. The pending
status remains visible after a reload. Retrying recovers the unfinished part;
it does not credit a completed payout again. A lost connection does not mean
that the mint rejected the payment.

To remove a losing token, select Remove and confirm. The wallet checks
that the tokens cannot receive a payout before it deletes them. If the result
is uncertain, it keeps the tokens. If the mint returns a payout instead, the
wallet keeps that payment and stops removal.

Removal finishes in this browser. The wallet backup holds no tokens, so
removal does not wait for it. Removal does not erase copies that you exported
or kept in another browser. A seed restore in another
browser can bring back a removed losing token. It has no value, and you can
remove it again.

### Using the CLI

`wallet claim <condition-id> <outcome-collection>` returns an `oracleEvidence`
status for each leg in its JSON output. The status is `verified` or `unverified`.
An unverified status includes a reason and the same warning as the browser.
A refused leg stays pending when verified evidence does not prove that its exact
collection lost. Keep the wallet data and use the existing recovery operation.

The command continues only when the mint can redeem the claim: the daemon has
verified oracle evidence, or the mint has recorded the result. In each other
case, the command stops with the code `position-claim-result-unavailable` and
saves no operation. This occurs when the mint does not answer, when no verified
result exists yet, when the mint does not redeem the condition by an oracle
result, or when the mint reports another outcome without verified evidence.
Run the command again later.

By default, the native daemon redeems and cleans up the inventory of a resolved
condition automatically after it verifies the oracle attestation. Winning proofs
are redeemed. Losing proofs and proofs that cost too much to redeem remain
visible as audit records. The daemon does not silently delete them. The daemon
does this work only while it runs.

The daemon does not need the engine to learn the result. It reads the
condition record at the mint first. If the mint has no verified result, the
daemon reads the oracle attestation from the configured Nostr relays. If this
profile created the market, the daemon also reads the relays that it published
to. The daemon verifies each signature against the oracle announcement that the
mint registered. It ignores an attestation that does not verify. Then it redeems
with that attestation, and the mint records the result.

When the daemon starts, it checks each held condition again. Before the event
maturity in the announcement, the daemon reads only the mint, and it checks the
condition again at that time. After the maturity, the daemon reads the mint and
the relays until it finds the result. A market close that the engine reports
makes this check start earlier. If the daemon cannot check a condition, for
example because the mint does not answer, it also reads the condition again
later. These checks do not stop other commands. The daemon tries again after 30
seconds. After each try, it waits twice as long, up to 5 minutes. While a
started automatic cleanup remains unfinished, commands that use funds stop with
the code `custody-recovery-pending`. The daemon tries again on the same
schedule.

To keep resolved-condition proofs until you authorize the action, run
`bitcaster-cli config set --auto-retire-resolved-condition-inventory false`.
This sets `daemon.autoRetireResolvedConditionInventory` in
`~/.bitcaster/config.json`. The default is `true`. The command restarts a
daemon that the CLI started. Restart another daemon yourself.

Preview the action and estimated mint fee with:

```sh
bitcaster-cli wallet retire-condition <condition-id>
```

Add `--acknowledge` to authorize the action. The command applies the same rules
to winning and losing proofs as the automatic cleanup. It reads the result in
the same way, so it also works while the engine is down. `wallet claim` reads
the result in the same way. When the daemon cannot read a verified result, the
command stops with the code `condition-retirement-result-unavailable` and saves
nothing.

A cleanup redeems as `wallet claim` does. The custody record of the daemon
holds the payout as regular funds, so `wallet send` and orders can spend it. A
cleanup can send more than one redeem request to the mint. Each request that
pays out adds one `payout_claimed` entry to the wallet Activity. See
[Funds that a command cannot spend](/technical/reference/cli-setup/#funds-that-a-command-cannot-spend)
for the custody record.

A cleanup starts only when the custody record holds each available position of
the condition. Otherwise `wallet retire-condition` stops with the code
`condition-retirement-custody-incomplete` and saves nothing, also without
`--acknowledge`. The automatic cleanup does not start either. It counts the
condition as a check that failed, so it does not stop other commands, and it
tries again on the same schedule.
