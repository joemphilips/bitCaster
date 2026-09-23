---
title: "Market Resolution"
description: "Who determines the outcome, when winnings can be claimed, and what can delay a claim."
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

### Using the CLI

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
