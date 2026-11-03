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

The CLI is not on npm. Build it from a clone of the public repository. You need Git and Node.js 22
or later. The build needs only the `cashu-ts` submodule.

```bash
git clone https://github.com/joemphilips/bitCaster.git
cd bitCaster
git submodule update --init cashu-ts
npm ci
npm link --workspace bitcaster-cli
bitcaster-cli --help
```

`npm ci` installs the dependencies and builds the CLI. `npm link` puts `bitcaster-cli` in the global
bin directory of npm. Order submission does not work on Windows yet.

The CLI defaults to a local development engine and mint. Set the engine URL and mint URL of the
service that you use. Then create the wallet profile:

```bash
bitcaster-cli config set --engine-url <engine-url> --mint-url <mint-url>
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

## Keep your funds safe

The agent controls all funds in the CLI wallet. It can spend them on trades, fees, and Participation
Score. Score is non-refundable. Add only the amount that the agent may trade.

The agent can read the files in the CLI data directory, and they hold the wallet. Use a new wallet
for the agent. Do not import the recovery phrase of your main wallet, and do not give the phrase to
the agent. Anyone with the phrase can spend that wallet's funds.

Tell the agent to show you `order fee-preview` and `market creation-quote` results before it
submits. Use `--dry-run` to validate a command and print the request without sending it.
`order submit`, `market create`, and `wallet invoice create` support it. Not every command supports
it. A command without this support ignores `--dry-run` and runs normally. Rely on `--dry-run` only
when the `--help` of that command lists it. Keep the data directory until every operation has a
final result.
