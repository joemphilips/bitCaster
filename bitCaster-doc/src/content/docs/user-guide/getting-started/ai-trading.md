---
title: 'Trade through an AI agent'
description: 'Hand bitcaster-cli to an AI agent so that it can read markets, trade, and create markets for you.'
sidebar:
  order: 4
---

`bitcaster-cli` is bitCaster for the command line. It prints JSON, so an AI agent that can run shell commands can use it to read markets, check fees, place orders, and create markets on your behalf.

## Set it up

Download the CLI from the [latest release](https://github.com/joemphilips/bitCaster/releases/latest). There are builds for Linux and for macOS on Apple silicon, and you need Node.js 22.15 or later.

Then point your agent at [bitcaster-cli for AI agents](/technical/reference/cli-setup/). That page is written for the agent. It covers installation, configuration, every step of an order, and how to read the output.

## Tell it what you want

Say what to do and where the limits are. For example:

> Use bitcaster-cli. Find a market about the weather and show me its order book.
> Buy one Yes share with a price limit of 420. Show me the fees and wait for my
> approval before you submit the order.

## Keep your funds safe

The agent controls every sat in the CLI wallet, so treat that wallet like a prepaid card. Create a fresh wallet just for the agent, and fund it only with what the agent is allowed to spend. Never give it the recovery phrase of your main wallet.

Ask the agent to show you the fee preview before it submits anything. It can also put `--dry-run` in front of a command to check it without acting.
