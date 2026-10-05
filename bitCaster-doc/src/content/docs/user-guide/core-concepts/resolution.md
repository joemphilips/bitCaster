---
title: 'Market Resolution'
description: 'Who determines the outcome, when winnings can be claimed, and what can delay a claim.'
sidebar:
  order: 3
---

# Market Resolution

A market closing does not always mean that its winning outcome is known.
Check both its trading status and the oracle's result before you claim winnings.

An **oracle** is the party that signs the event result. Its signed result is
called an **attestation**. The mint verifies this signature to determine which
conditional tokens receive the winning payout. This is market resolution.

## Before you trade

Check the question, possible outcomes, oracle identity, and deadline. Check
the mint's redemption period and policy for a missing result. The oracle is
fixed when the market is created.

A valid signature identifies who signed the result. It does not prove that
the result is true or that the question was clear. Choose an oracle whose
evidence and judgment you trust. bitCaster does not replace that judgment
with a platform trust score.

## When trading ends

The market closes for new orders and funding when it accepts a valid oracle
result. It can also close at the announced deadline without a result.
Deadline closure alone does not identify winning tokens.

A verified result can arrive after the deadline closes trading.
It identifies the outcome without reopening trading or changing the first closure time.
A closed market with no verified result remains unresolved.

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

Open Your Markets in the creator page. For a self-oracle market, select the
registered outcome and choose Close market. The Resolve this market dialog
shows the chosen outcome. You can add an optional public plain-text explanation.
The explanation limit is 4096 UTF-8 bytes. Do not include private information.
Select Confirm and deliver saved resolution to save the choice and start delivery.

Once the choice is saved, the outcome and original explanation draft cannot change.
The browser retains the exact signed kind-89 result before delivery.
Keep browser storage enabled. If delivery is incomplete, choose Retry saved resolution
and confirm the dialog. Retry delivers the saved result without signing another
kind-89 event or creating another announcement.
Retry sends only the saved signed events. If no signed explanation was saved,
retry does not create one. The original explanation draft stays saved.
Delivery of the exact saved result does not require the oracle signing key.

Check engine, relay, and optional explanation progress separately.
Engine confirmed means that the exact result has verified engine evidence.
Relay confirmed means that the relay acknowledged the result.
Neither confirmation guarantees the other or confirms mint redemption.
An explanation failure does not block resolution delivery.
Its verified text can appear on the closed market page. It is not a paid trade comment.

A deadline-closed market with no verified result still permits the creator's
resolution action. A closed trading status alone does not identify winning tokens
or guarantee a payout. A later verified result does not reopen trading.

## Report a result as the native oracle

Use the daemon profile that created the oracle announcement.
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
the original saved draft. A restart does not require another market creation or
registration fee.

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
the tokens were not spent. See [settlement and recovery](/user-guide/core-concepts/atomic-swap/).

### Using the browser

Claim checks evidence from the intended oracle when that evidence is available.
If the evidence is missing, unavailable, or invalid, the app shows this warning:
“The mint reports this outcome, but we have not verified evidence from the intended oracle.”
You can still claim. The wallet must verify each received proof before it records
the payout. A mint refusal alone does not prove that a holding lost.
The same warning applies when Remove checks a position through Claim.
The message stays visible until you close it.

A restored refusal record can lack verified losing evidence. The wallet keeps
these conditional tokens and shows their retained amount. You cannot claim,
sell, or remove tokens in this retained, unverified state.

Open Portfolio and select Claim for a winning position. A claim can finish
in parts. Each completed payout stays in your wallet if another part fails.

If the claim is pending, keep the wallet data and retry Claim. The pending
status remains visible after a reload. Retrying recovers the unfinished part;
it does not credit a completed payout again. A lost connection does not mean
that the mint rejected the payment.

To remove a losing position, select Remove and confirm. The wallet checks
that the tokens cannot receive a payout before it deletes them. If the result
is uncertain, it keeps the tokens. If the mint returns a payout instead, the
wallet keeps that payment and stops removal.

Removal can take time when encrypted backup is enabled. The position stays
visible while removal is pending. Keep your wallet data until it finishes.
Removal does not erase copies that you exported or kept in another browser.

If removal fails, keep the removal reference shown in the message. It identifies
the failed step and the attempt. Include that reference when you report the
problem. Do not share your recovery phrase, private key, or ecash tokens.

### Using the CLI

`wallet claim <condition-id> <outcome-collection>` returns an `oracleEvidence`
status for each leg in its JSON output. The status is `verified` or `unverified`.
An unverified status includes a reason and the same warning as the browser.
A refused leg stays pending when verified evidence does not prove that its exact
collection lost. Keep the wallet data and use the existing recovery operation.

The native daemon retains resolved-condition proofs until you authorize
redemption and inventory cleanup. Preview the action and estimated mint fee with:

```sh
bitcaster-cli wallet retire-condition <condition-id>
```

Add `--acknowledge` to authorize the action. Winning proofs are redeemed.
Losing proofs and proofs that cost too much to redeem remain visible as audit
records. The command does not silently delete them.

To authorize this flow automatically after a verified oracle attestation, set
`daemon.autoRetireResolvedConditionInventory` to `true` in
`~/.bitcaster/config.json`. The default is `false`. Restart the daemon after
changing the setting.

## Further reading

Read about [conditional tokens](/user-guide/core-concepts/conditional-tokens/)
for the assets you hold.
