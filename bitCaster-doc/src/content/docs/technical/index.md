---
title: Technical Reference
sidebar:
  order: 0
---

This section describes the public technical behavior of bitCaster.

## Custom clients and automation

Use the CLI as an application interface for a custom GUI or TUI, scripts,
and trading AI agents. Commands provide JSON results for programs to consume.
For example, `bitcaster-cli order book <market-id>` reads the public order book.
Set the engine URL with `bitcaster-cli config set --engine-url <url>`.
Use `bitcaster-cli market comments <condition-id>` to read public comments as JSON.
This read does not need a wallet.

Use `bitcaster-cli market history <condition-id> --timeframe 7d` to read price history.
Both commands accept `--minimum-event-order <event-order>` and `--refresh`.
Pass the source position unchanged. It is opaque.
Use `--refresh` to capture the current source head for the read.
The JSON result retains `snapshotEventOrder`.
The history result also retains the server time `asOf`.
These reads do not require a wallet, signer, or daemon.

```bash
bitcaster-cli market comments <condition-id> --minimum-event-order <event-order>
bitcaster-cli market history <condition-id> --timeframe 7d --refresh
```

Use `bitcaster-cli --help` and each command's `--help` to check current support.
CLI coverage does not yet include every web-app operation.
Full application capability parity is the design goal.
It does not require the CLI to reproduce browser rendering or browser storage.
CLI clients use the same public authorization and settlement rules.

### Select and import a native wallet profile

Use `--datadir` to select a native wallet profile for each command.
Import into a fresh directory, not over an existing wallet:

```bash
bitcaster-cli --datadir ./wallet-new daemon init --wallet-seed-hex-file ./wallet-seed.hex --nostr-secret-key-hex-file ./nostr-secret-key.hex
bitcaster-cli --datadir ./wallet-new signer show
bitcaster-cli --datadir ./wallet-old signer show
```

The seed file contains 64 bytes as 128 lowercase hex characters.
The signer file contains 32 bytes as 64 lowercase hex characters.
Use bounded, owner-only regular files. Do not use symbolic links or command-line secrets.
Private-file commands require POSIX owner and permission checks.
Keep the old profile and its unfinished operations.
Selecting a directory does not move funds or replace another profile.
`daemon init` imports keys. It does not recover funds from the mint.

To recover deterministic proofs, stop the selected profile's daemon first:

```bash
bitcaster-cli --datadir ./wallet-new wallet recover-seed --wallet-seed-hex-file ./wallet-seed.hex --recovery-id recovery-001 --mint https://mint.example --unit msat --acknowledge-seed-disclosure
```

Use the profile's configured mint and the same recovery ID for later invocations.
The acknowledgment permits disclosure of deterministic proof candidates to the mint.
Recovery can refuse active or unfinished wallet work. It is not an in-place replacement.
A completed scan does not guarantee that every lost token was recovered.

### Manage the Nostr signer and read its profile

The login signer is separate from the wallet seed and payment receive identity.
Use public status to get its current revision:

```bash
bitcaster-cli signer show
bitcaster-cli signer import --key-file ./nostr-key.txt --expected-revision <revision>
bitcaster-cli signer export --output-file ./new-nostr-backup.txt
bitcaster-cli signer profile
```

Import accepts private hex, `nsec`, or `ncryptsec` from an owner-only regular file.
For `ncryptsec`, use a separate `--key-passphrase-file` for its decryption password.
Do not put private keys or passwords in command arguments.
Export writes private `nsec` to a new owner-only file. It never overwrites a file.
Normal output contains public status, not the private key.
Stop the daemon before import, generation, connect, or disconnect.
These changes require the revision from `signer show` and can refuse unfinished work.
They do not replace the wallet seed.

`signer show` works offline. Each `signer profile` call refreshes public metadata
from the selected signer's configured relays. It has no stored profile cache.
There is no separate `signer refresh` command.
Connect a disconnected signer and configure a relay before reading a profile.
No profile found is a valid result. A profile name is not proof of identity.
`--dry-run` prints the intended signer action without changing the signer or exporting a key.
Import dry-run still reads and validates the private input files.

### Save mint and relay settings

```bash
bitcaster-cli mint list
bitcaster-cli mint add https://mint.example
bitcaster-cli mint select https://mint.example
bitcaster-cli mint remove https://other-mint.example
bitcaster-cli relay list
bitcaster-cli relay add wss://relay.example
bitcaster-cli relay remove wss://relay.example
```

Mint add also selects the mint. Add and select check support for the msat unit.
Removing the last saved mint is refused.
Saving a mint URL does not establish support for trading on that mint.
First-release trading uses the supported bitCaster mint.
These commands change saved settings, not stored funds or recovery destinations.
They restart a daemon started by the CLI when it is running.
Otherwise, restart the daemon yourself to apply the saved settings.
Use `--expected-revision` from the settings result to refuse a stale edit.
`--dry-run` validates and prints the edit without saving it or restarting the daemon.

An explicit relay list of `[]` is an offline opt-out from Nostr relay traffic.
It does not select fallback public relays. It does not disable mint or engine traffic.
Public profile refresh and relay receipt delivery need configured relays.

### Keep liked markets

```bash
bitcaster-cli market liked
bitcaster-cli market liked --local
bitcaster-cli market like <condition-id>
bitcaster-cli market unlike <condition-id>
```

Use condition IDs, not outcome-route IDs.
`liked` keeps the complete saved ID list even when market metadata is unavailable.
`--local` reads saved IDs without relay or engine requests.
Without it, the command can sync bookmarks and fetch market metadata.
Like and unlike keep the local edit if relay publication fails.
Repeating the same edit does not toggle the bookmark back.
`--dry-run` prints the intended action without editing or making network requests.
Liked markets can be public on configured Nostr relays.
Bookmarks and preferences are not a backup of wallet proofs or unfinished payments.

### Read holdings and portfolio estimates

Use the configured native wallet to read local holdings and optional value estimates:

```bash
bitcaster-cli wallet positions
bitcaster-cli wallet portfolio --timeframe 1W --page-size 100
bitcaster-cli wallet assets --cursor <nextCursor> --page-size 100
```

`wallet positions` reads the wallet's conditional-token holdings.
`wallet portfolio` returns `localHoldings` and a separate `monitoring` result.
Monitoring can be `available`, `disabled`, or `unavailable`.
Disabled or unavailable monitoring does not mean that your local balance is zero.
Available estimates do not authorize spending or guarantee sale proceeds.

The portfolio response contains the first asset page.
Pass its `nextCursor` to `wallet assets` for later pages.
Keep the cursor unchanged. Stop when `nextCursor` is `null`.
Fields ending in `Sats` use sats. Fields ending in `Msat` use msat.
Convert units before combining amounts. 1,000 msat is 1 sat.

### Watch live market and wallet values

Start the configured daemon, then run one of these commands:

```bash
bitcaster-cli market watch <condition-id> <another-condition-id>
bitcaster-cli market watch --liked
bitcaster-cli wallet watch
```

`market watch` accepts up to 200 distinct condition IDs, not outcome-route IDs.
It returns `market.snapshot` events with the market and its outcome order books.
`--liked` captures local saved likes when the watch starts.
It does not change the watched set after a bookmark edit. Restart the watch to apply edits.
Do not combine `--liked` with explicit IDs. More than 200 saved likes are refused, not truncated.
An empty saved set reports `market.liked.selection` with `state: "empty"` and ends.
An observed open-to-closed transition reports `market.closed`.
This is an observed transition, not a complete closure log or proof of redemption.
Market watching needs a connected signer. Local wallet watching remains available
with a disconnected signer when asset monitoring is disabled.
`wallet watch` returns `wallet.snapshot` events for the selected wallet.
Each wallet snapshot keeps local holdings separate from optional portfolio estimates.
When monitoring is disabled, the wallet watch sends no portfolio or price-subscription requests.
When monitoring is unavailable, it still reports local holding changes.
Valuation subscriptions have a 200-condition limit. An overflow makes estimates
unavailable; it does not remove holdings or report a partial portfolio as current.

Each output line is one JSON object. Events have `type: "event"`, an `event`
name, and `data`. Some events also include an opaque `sourceRevision`.
Connection events use `market.connection` or `wallet.connection` and report
`connected` or `reconnecting`. They describe the connection, not settlement completion.
Use a new snapshot after a reconnect. Do not continue to treat an old price as current.
Updates can be combined into one snapshot. The stream is not a complete trade log.

Press Ctrl+C to stop watching. This does not cancel orders or wallet operations.
A `type: "error"` line ends the command with exit code 1.
A `type: "complete"` line marks the end of a stream, not a completed payment.
Watch output excludes proof secrets, but it can contain private wallet metadata.
Protect saved output as you protect other wallet records.

### Receive payment requests

Use `wallet request create` to save an amountless msat request for the configured mint.
Share the returned `encoded` value. The receive identity belongs to the wallet seed,
not the login signer. Request commands remain available with a disconnected signer.
Keep configured relays and the daemon available for relay delivery.
Read `wallet request status <request-id>` or `wallet request watch <request-id>`.
Only `credited` confirms wallet credit. `pending` does not.
Use `wallet request recover <request-id>` for the same incomplete receipt.
Stopping the watch does not cancel the request or receiver.
See [Ecash](/user-guide/core-concepts/ecash/) for the receive workflow.

### Order estimates without a wallet

Use the public market ID from the catalogue in these commands:

```bash
bitcaster-cli order capacity --market <market-id> --side Buy
bitcaster-cli order preview --market <market-id> --side Buy --amount-msat 1000
```

`--amount-msat` is the order's face value, not a payment budget.
Add `--token-side Complement` for the selected outcome's No position.
Use `--side Sell` for a sale estimate.
Add `--price` for an explicit limit in the market's price units.
Without `--price`, the server supplies the Auto limit.
The CLI captures that limit before it requests the exact order estimate.
It does not widen the limit if the order book changes.

Preview output contains `request` and `preview`.
The request uses the public field `faceAmountSubunits`, measured in msat.
If Auto has no available limit, `preview` is `null`.
The `capacity` field preserves the server's availability response.
Capacity output is the public capacity response.
These estimates do not reserve liquidity or include wallet preparation fees.
They do not prove that the wallet has enough funds or shares.

### Approve fees and submit an order

The public book estimate does not inspect your wallet. Use `order fee-preview`
to include wallet preparation and optional proof-consolidation fees.
This command needs a configured native wallet. It does not spend funds.

```bash
bitcaster-cli order fee-preview --market <market-id> --outcome <outcome-id> --side Buy --price 420 --amount-msat 1000 > fees.json
```

Check that `ok` is `true`. Inspect `result.request` and `result.feeFacts`.
The request retains the accepted trade-value bound separately from fees.
Buy uses `maxQuotePaymentSubunits`; Sell uses `minQuotePaymentSubunits`.
The opposite bound is `null`. Amounts use msat.
To set an explicit bound, use `--max-quote-payment-msat` for Buy or
`--min-quote-payment-msat` for Sell in both fee preview and submission.
Use a non-negative safe integer. Do not pass the opposite side's flag.
Each fee names its asset. Do not add fees in different assets as if they were
all regular cash. Save the successful JSON output unchanged.
To approve that request and those fees, pass the file with the same order:

```bash
bitcaster-cli order submit --market <market-id> --outcome <outcome-id> --side Buy --price 420 --amount-msat 1000 --fee-consent-file fees.json
```

The price and amount are examples, not recommended trading values.
The wallet refuses a changed request or fee plan. It does not approve higher
fees for you. If refused, inspect a new preview before approving it.
An explicit `--price` remains your limit. Without it, Auto resolves a limit
for the preview. A later change can require a new approval.
The preview is not a liquidity reservation. Submission can still be refused.
The per-fill price limit does not protect the quoted total by itself.
The accepted total bound permits an equal or better total. A worse total refuses
the complete FOK order. Fees remain separate from this bound.

Add `--comment` and `--market-url` together to attach a signed trade comment.
Use the exact web market URL, without a query or fragment.
The comment is attached to the order. It is not a separate comment publication.
`--dry-run` prints the request without contacting the daemon or spending funds.
It does not prove that the order can execute or that the wallet can prepare it.

If submission reports an uncertain result, retain the returned identifiers.
Check status or recovery before starting another order.
A failed order does not imply that earlier wallet preparation was undone.

### Fund a market

Read the confirmed funding total without a wallet:

```bash
bitcaster-cli market funding <condition-id>
```

`ammBotBudgetSubunits` is the confirmed funding amount in msat.
It is not the bot's remaining cash or the size of an executable trade.
`fundingRevision` is an opaque string or `null`. Do not parse it as a number.
This response does not confirm that new orders from the bot are available.

Use the configured native wallet to preview and make a funding payment:

```bash
bitcaster-cli market funding-quote <condition-id> --amount-msat 8000
bitcaster-cli market fund begin <condition-id> --amount-msat 8000 --max-wallet-debit-msat 8002
```

These amounts are examples in msat: 8,000 msat is 8 sats.
The quote does not reserve funds or send a payment.
`grossFundingMsat` is the amount sent before the recipient's receive fee.
`totalWalletDebitMsat` includes the wallet's preparation fee.
`netFundingMsat` subtracts the estimated recipient receive fee from gross funding.
Choose the maximum wallet debit after checking the quote.
The wallet checks that limit again before it prepares a new payment.
Each `begin` command requests a new payment. Funding is a subsidy, not a deposit
that gives you a right to withdraw the bot's funds.

Check `result.delivery.state`, not only `ok`.
`pending` and `received` do not confirm a funding credit. `credited` does.
If the result is pending or uncertain, resume the same transfer:

```bash
bitcaster-cli market fund resume <condition-id> <transfer-id>
```

Use the returned transfer ID or the attempt ID from an uncertain result.
An uncertain result also includes `resumeCommand`.
Do not start another payment to retry the first payment.
`market funding-head <condition-id>` returns the current local transfer in
`result.head`, or `null` when the wallet has no funding transfer for that market.
This local record is not the public funding total.

### Wait for an order result

```bash
bitcaster-cli order wait <market-id> <order-id> --timeout-ms 30000
```

The default wait is 30 seconds. The maximum is five minutes.
The result includes the latest engine and local order states.
`wait.status: "terminal"` means that the engine order has ended and has no
active settlement group. Check the engine status to distinguish a fill from
a refusal or failure. This result does not confirm wallet recovery.
`wait.status: "timed_out"` returns a nonzero exit code.
A timeout stops observation. It does not cancel the order or undo preparation.
Use the same order ID to check again.

### Claim a resolved position

Use the configured native wallet to redeem one selected position after resolution:

```bash
bitcaster-cli wallet claim <condition-id> Alpha
bitcaster-cli wallet operations --kind ctf-redeem
```

Use the exact `outcomeCollection` from the stored position.
`Alpha` is an example label. Preserve the label's exact case.
Quote a collection that contains `|`, such as `'Beta|Gamma'`.
The command selects only that condition and outcome collection.
It does not redeem sibling positions or retire the whole condition.

Check each entry in `result.legs`, not only `ok`.
Each entry contains `operationId`, `keysetId`, `state`, and `payoutAmountSubunits`.
The states are `completed`, `losing`, and `pending`.
For a completed leg, `payoutAmountSubunits` is the net regular-cash payout in msat.
Mint fees reduce the payout. A fee can make a claim uneconomic and cause refusal.
The position's face value is not a guaranteed payout.
A `losing` result retains the holding and its proof history.
This claim command does not remove a losing holding.

For a pending result or a lost response, repeat the same claim command.
You can also use `bitcaster-cli wallet recover` to resume prepared claims.
Recovery uses the stored operation instead of preparing a second redemption.
Use the returned operation IDs to check `wallet operations --kind ctf-redeem`.
This status output excludes proof bodies, secrets, and attestation witnesses.

### Remove a verified losing holding

First use `wallet claim` for the exact condition and outcome collection.
Remove needs the stored, verified losing mint result for each selected proof.
A text error, an uncertain result, or an uneconomic claim does not permit removal.
Use the exact collection and label case described above.

Create a private preview file, then inspect the complete JSON output:

```bash
preview_file=$(mktemp)
bitcaster-cli wallet remove-preview <condition-id> Alpha > "$preview_file"
```

Check that `ok` is `true`. Inspect `result.conditionId`, `result.outcomeCollection`,
`result.mintUrl`, and `result.targets`. Keep the complete output unchanged,
including the outer `ok` and `result` fields. The file contains no proof secrets,
but it contains private wallet metadata. Keep it private.
`--preview-file` requires a bounded regular file with no group or other access.
It refuses symbolic links. This file check is not supported on Windows.

To acknowledge the loss and retire only this exact batch:

```bash
bitcaster-cli wallet remove --preview-file "$preview_file" --acknowledge-loss
```

The preview binds the wallet profile, mint, position, and exact proofs.
A batch contains at most 256 proofs. Byte limits can make it smaller.
The wallet refuses pending or reserved proofs and changed or uncertain targets.
It refuses the complete batch before changing any target.
It does not select replacement proofs from a changed holding.

Check `result.state`, `result.retiredProofCount`, and `result.moreProofsRemain`.
`state: "completed"` confirms removal of the acknowledged batch.
Other proofs remain visible. If `moreProofsRemain` is `true`, create a fresh
preview and acknowledge it separately for each later batch.
Removal excludes retired proofs from active positions and proof selection.
The wallet keeps raw proof bodies and operation history locally.
Reimport does not restore a retired proof to active use.
Removal does not require a backup or a network request.
Monitoring is optional and asynchronous. Privacy mode sends no monitoring request.
Both commands accept `--dry-run` to print their daemon request without execution.
For `remove`, this option still validates the preview file.

## Public contracts

`GET /api/v1/markets/{conditionId}/comments` returns each comment with a
required `trade` field. The field is `null` when the exact confirmed fill
coordinate is unavailable. Otherwise, it contains `fillId`, `outcomeId`,
`executedAt`, `price`, and `priceDenominator`. The coordinate uses the
primitive outcome price and time from public trade history. The comment's
signed `createdAt` stays separate.

`trade.faceAmountSubunits` gives the size of that linked confirmed fill.
It is not the complete order size or the user's payment. A `null` value means
that the size is unknown. The endpoint retains up to 500 comments.
It is not a complete comment archive.
An oracle resolution explanation is separate from paid trade comments.
It does not supply a confirmed fill coordinate. See
[market resolution](/user-guide/core-concepts/resolution/).

### Refresh comments and price history

The comments endpoint and
`GET /api/v1/markets/{conditionId}/price-history` accept `minimumEventOrder`
and `refresh=true`. Pass an event position unchanged in `minimumEventOrder`.
Use `refresh=true` after a reconnect. The server captures the current source
position once. It waits for that position before returning the snapshot.
It does not wait for all future events.

Both responses include `snapshotEventOrder`. It is the applied source position
proven for that snapshot. The field is nullable. A `null` value supplies no
position for a later `minimumEventOrder` request. Use `refresh=true` instead.
Treat event positions as opaque values. Do not parse or compare them on the client.
If the read cannot prove the required position within its deadline, it returns
`503`. Keep the previous display and show that its refresh is unavailable.
Do not treat this response as an empty list or zero prices.

Price history also includes `asOf`, the server's evaluation time.
Use that time for the selected history window. Replace the complete selected
timeframe after a refresh. Do not merge old samples into the new response.
An outcome without a confirmed price remains unpriced.
For a selected date, use the last retained confirmed price at or before that date.
Do not create a price before the first confirmed trade.
A missing sample for another outcome does not create a new price or remove an
existing categorical price step.

The SignalR message `MarketCommentsChanged { conditionId, eventOrder }`
means that the public comment source changed. `ConfirmedTradeRecorded`
also supplies a source position in `latestConfirmedTrade.eventOrder`.
Neither message guarantees that a snapshot is ready. Use its position in the
next bounded read. Delivery is best effort. Refresh after a reconnect even
when the last trade price did not change.

`GET /api/v1/markets/{conditionId}/registration` returns public registration
facts for one condition. Use it to check a market-creation result when the
create response may have been lost. A `404` means no registration exists;
other errors must not be treated as absence. See
[Market Catalogue API](/technical/protocol/market-catalogue/) for the fields
and client checks.

For outcome identity and optional outcome display metadata in market creation
and catalogue responses, see [Market Catalogue API](/technical/protocol/market-catalogue/).

See [Public FOK preview](/technical/architecture/trading-model/#public-fok-preview)
for read-only trade estimates, executable capacity, and separate fee calculation.

The first-release server accepts only public FOK orders. The GUI and CLI submit
FOK orders. Each public attempt uses one one-shot capability. FOK uses the book
state at admission. It commits the full requested quantity or cancels the
complete request. Public FAK, GTC, GTD, continuation, and residual
reauthorization are not available.

## Settlement groups

Orders use `PAY_TO_UNLOCK` capabilities. Order admission makes no mint network
call. The engine groups one or more fills into an atomic settlement group and
submits one multi-party mint conversion for that group.

`fillId` identifies one real fill. `groupId` identifies one atomic settlement
group. A confirmed group returns exact mint result entries. Clients persist and
recover their submitted operations and confirmed results. An acknowledged FOK
operation stores its operation facts and result. These records survive a server
restart. An intentional reuse of the same client order ID with the same
operation facts returns the stored result. Changed facts return a conflict.

The engine receives only the exact input proofs and public output manifest that
the wallet authorizes for an order. It does not receive the wallet seed, output
blinding factors, refund key, or general proof inventory. See
[NUT-CTF Range Settlement](/technical/protocol/atomic-swap/) for the protocol
details.

## Portfolio monitoring API

The authenticated `GET /api/v1/portfolio` endpoint returns display-only data
for the first portfolio render. The response includes the selected wallet summary,
the first asset page, and the selected value history. It does not prove custody
or authorize spending.

Each authenticated account and `walletId` pair has an independent monitoring
interval. Clients with the same Nostr key and different wallet seeds can report
and read their own portfolios. One wallet's reports do not deactivate the other
wallet. This does not permit concurrent spending from clients with the same
wallet seed.

Submit complete holdings snapshots to `POST /api/v1/asset-monitoring/reports`.
The first report must set `startsNewInterval: true`. A later new interval affects
only that account-wallet pair. An exact retry of the latest report does not
start another interval. A pair without an accepted report has an empty, stale
summary with no `asOf` value. It does not inherit another wallet's holdings.

Report conflicts return `409` with a `ProblemDetails.code` value.
`asset-monitoring-baseline-required` means that the pair needs its first report.
The client may retry with `startsNewInterval: true` only when it has no pending
submitted order. `asset-monitoring-report-conflict` means that the report
conflicts with the latest accepted report. Do not automatically start a new
interval for this code or an unknown conflict code.

Each monitored asset uses `cashuUnit: "msat"` and `displayBaseAsset: "sat"`.
Amounts stay in msat on the wire. Convert them to sats only for display.
An unsupported unit makes the complete wallet report invalid. Do not omit that
holding and submit a partial replacement report.

Use the returned asset cursor with `GET /api/v1/asset-monitoring/assets` to
read later pages. Do not call the portfolio endpoint for continuation pages.
Private responses use `Cache-Control: no-store`. The API returns `400` for an
invalid query, `429` when the history-read limit is full, and `503` when the
monitoring reader is unavailable. Cursors belong to the selected account,
wallet, and interval. Starting a new interval for one wallet does not invalidate
another wallet's cursors.

After a confirmed settlement, an owner-filtered
`SettlementGroupStateChanged` update can refresh the active portfolio. This
best-effort display update does not prove custody or authorize spending.

For price and closure updates, invoke `SetPortfolioValuationSubscriptions`
on the market hub with the desired condition IDs. This replaces the set for
that connection. It accepts at most 200 entries, including duplicates.
Use exact condition IDs from the API. An empty array removes the subscriptions.
Send the set again after reconnecting.

These subscriptions receive `ConfirmedTradeRecorded` and
`MarketStatusChanged`, without order-book snapshots or depth updates.
Refresh the Portfolio response after subscribing, reconnecting, or receiving
a relevant notification. Coalesce refreshes and respect `429` responses.
A notification does not guarantee that the next Portfolio read includes it.
