---
title: 'Trade through the AI'
description: 'Give bitcaster-cli to an AI agent so that it can read markets, trade, and create markets for you.'
sidebar:
  order: 4
---

An AI agent that can run shell commands can use `bitcaster-cli` for you. It can read markets, check
fees, submit orders, and create markets. The CLI prints JSON, so the agent can read each result. The
agent spends the funds in the CLI wallet. Read [Keep your funds safe](#keep-your-funds-safe) before
you add funds.

## What the agent can do

The CLI is an application interface for scripts and trading AI agents. Its design goal is to expose
every web-app operation. Command coverage is not complete yet. Tell the agent to run
`bitcaster-cli --help` and `bitcaster-cli <command> --help` to find the available commands and
options. The command groups include `market`, `order`, `wallet`, `score`, `mint`, `relay`, `signer`,
`config`, and `daemon`.

The CLI sends long-running wallet work to `bitcaster-daemon`. The daemon is a local process that
holds the wallet and its saved operations. The CLI starts the daemon when a command needs it. Keep
the daemon running while an order, a payment, or a market creation is in progress.

## Set up the CLI

Download the CLI from the [latest release](https://github.com/joemphilips/bitCaster/releases/latest).
There is an archive for Linux on x64 and an archive for macOS on Apple silicon. You need Node.js
22.15 or later. There is no Windows archive, because order submission does not work on Windows yet.

On Linux, download the archive and the checksum file. Check the archive, then extract it:

```bash
curl -fLO https://github.com/joemphilips/bitCaster/releases/latest/download/bitcaster-cli-linux-x64.tar.gz &&
  curl -fLO https://github.com/joemphilips/bitCaster/releases/latest/download/SHA256SUMS &&
  grep ' bitcaster-cli-linux-x64.tar.gz$' SHA256SUMS | sha256sum -c - &&
  tar -xzf bitcaster-cli-linux-x64.tar.gz &&
  export PATH="$PWD/bitcaster-cli-linux-x64/bin:$PATH" &&
  bitcaster-cli --help
```

The commands stop at the first failed step. If the checksum check fails, download both files
again. A new release can appear between the two downloads.

On macOS, use `bitcaster-cli-darwin-arm64` instead of `bitcaster-cli-linux-x64`, and
`shasum -a 256 -c -` instead of `sha256sum -c -`. The archive contains the CLI, the daemon, and the
oracle helper that market creation uses. To keep `bitcaster-cli` available in a new shell, add the
`bin` directory to `PATH` in your shell profile.

Optionally, check that the release workflow on the main branch of this repository built the
archive. This step needs the GitHub CLI:

```bash
gh attestation verify bitcaster-cli-linux-x64.tar.gz --repo joemphilips/bitCaster \
  --cert-identity https://github.com/joemphilips/bitCaster/.github/workflows/release-cli.yml@refs/heads/main \
  --deny-self-hosted-runners
```

`bitcaster-cli --version` prints the version and the source commit of the release, for example
`0.1.0+0123456789ab`.

You can also build the CLI from a clone of the public repository. You need Git and Node.js 22.15 or
later. The build needs only the `cashu-ts` submodule.

```bash
git clone https://github.com/joemphilips/bitCaster.git
cd bitCaster
git submodule update --init cashu-ts
npm ci
npm link --workspace bitcaster-cli
bitcaster-cli --help
```

`npm ci` installs the dependencies and builds the CLI. `npm link` puts `bitcaster-cli` in the global
bin directory of npm. This build does not include the oracle helper, so it cannot create markets. Use
a release archive to create markets.

The CLI defaults to a local development engine and mint. Set the bitCaster engine URL and mint
URL. Then create the wallet profile:

```bash
bitcaster-cli config set --engine-url https://api.bitcaster.market --mint-url https://mint.bitcaster.cash
bitcaster-cli daemon init
bitcaster-cli wallet invoice create --amount-msat 25000
```

`daemon init` creates a new wallet seed and Nostr key in `~/.bitcaster`. To keep the agent's wallet
apart from other CLI wallets, add `--datadir <path>` to every command. Pay the Lightning invoice
from another wallet. Then check it with `bitcaster-cli wallet invoice show <quote-record-id>` and
`bitcaster-cli wallet balance`. Amounts use msat: 1,000 msat is 1 sat.

## Example session

Tell the agent what to do and what limits to obey. For example:

> Use bitcaster-cli. Find a market about the weather and show me its order book.
> Buy one Yes share with a price limit of 420. Show me the fees and wait for my
> approval before you submit the order.

The agent can then run these commands:

```bash
bitcaster-cli market list --search weather --limit 5
bitcaster-cli order book <condition-id>-Yes
bitcaster-cli order fee-preview --market <condition-id>-Yes --outcome Yes \
  --side Buy --price 420 --amount-msat 1000 > fees.json
bitcaster-cli order submit --market <condition-id>-Yes --outcome Yes \
  --side Buy --price 420 --amount-msat 1000 --fee-consent-file fees.json
bitcaster-cli order wait <condition-id>-Yes <order-id>
bitcaster-cli wallet positions
```

A market id has the form `<condition-id>-<outcome>`. In an ordinary market, `--amount-msat 1000` is
one share. `--price` sets a limit. Omit it to use the Auto limit of the server. Save the
`fee-preview` output unchanged, and use the same order values in `order submit`. Public orders are
fill-or-kill: the order fills completely or not at all. `order wait` stops at its timeout. It does
not cancel the order.

To create a market, check the fee first. Then approve that wallet debit:

```bash
bitcaster-cli market creation-quote --outcomes Yes,No
bitcaster-cli market create --creation-id <id> \
  --title "<question>" --description "<how it resolves>" \
  --outcomes Yes,No --maturity-epoch <unix-time> \
  --relay <relay-url> --max-wallet-debit-msat <msat>
```

Keep the creation id. Use it with `market creation-status` and `market creation-resume`. The first
market creation on a new engine URL asks you to confirm the URL. Without a terminal prompt, the CLI
refuses. Run that first creation yourself, or add `--trust-engine-url` after you check the URL.

## Read the JSON output

JSON is the default output, and `--json` selects it explicitly. Daemon results have the form
`{ "ok": true, "result": ... }`. A failed result has `"ok": false` and an `error` text, and the exit
code is 1. A usage error exits with code 2. A validation error exits with code 3. Warnings and
progress messages go to standard error. `market watch` and `wallet watch` print one JSON object on
each line. A few setup commands, such as `daemon init`, print plain text.

## If the mint refuses an order

Before the daemon submits an order, it prepares the order funds at the mint. Some mint refusals
prove that the preparation did not complete and cannot complete later. After such a refusal, the
daemon checks the reserved funds again and ends the order attempt. Then `order submit` fails with
the code `order-attempt-released` and the mint code in `mintError`. The `error` text is, for
example, "The mint refused the order (mint code 11008). No order was submitted. The reserved funds
are available again." If another operation spent part of the funds, the daemon releases only the
remaining funds. You can submit a new order.

After other failures, the funds stay reserved, and the daemon checks the result again. The interval
increases after each failed check, up to 15 minutes. `order recovery` shows the order operations
that the daemon still recovers, and the order attempts that a mint refusal ended. If the mint refuses
the same check five times, the daemon stops the automatic checks. The entry then shows
`"halted": true`, the mint code, and a `retryCommand`, for example
`bitcaster-cli order retry <operation-id>`. Run that command to send the check one more time. A
daemon restart also starts the automatic checks again. `order retry` supports `--dry-run`. While
an earlier sell in a market still prepares its funds, `order submit` refuses a new sell in that
market with the code `order-sell-preparation-pending` and reserves no funds.

## Keep your funds safe

The agent controls all funds in the CLI wallet. It can spend them on trades, fees, and Participation
Score. Score is non-refundable. Add only the amount that the agent may trade.

The agent can read the files in the CLI data directory, and they hold the wallet. Use a new wallet
for the agent. Do not import the recovery phrase of your main wallet, and do not give the phrase to
the agent. Anyone with the phrase can spend that wallet's funds.

Tell the agent to show you `order fee-preview` and `market creation-quote` results before it
submits. Put `--dry-run` before a command to check the command without acting. The `--help` of each
command states its dry-run mode, and every command has a mode. A supported command prints
`{"dryRun": true, "method", "params"}` and changes nothing. `params` does not contain secret values.
`order submit`, `market create`, and `wallet invoice create` are supported. A read-only command runs
normally. It does not change funds, orders, markets, keys, or settings. A refused command stops with
exit code 2 before it acts. `daemon init`, `daemon stop`, and `daemon restart` refuse `--dry-run`.

With `--dry-run`, the CLI does not start the daemon. A command that needs the daemon then works only
when the daemon already runs. Put `--dry-run` before any `--`, and give it no value. Otherwise, the
CLI stops with exit code 2. A dry run does not prove that the operation can succeed. Keep the data
directory until every operation has a final result.
