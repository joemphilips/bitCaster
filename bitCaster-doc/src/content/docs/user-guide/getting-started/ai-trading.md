---
title: 'Trade through an AI agent'
description: 'Hand bitcaster-cli to an AI agent so that it can read markets, trade, and create markets for you.'
sidebar:
  order: 4
---

bitCaster is normally used from the browser. If you want your own AI agent to operate it, `bitcaster-cli` is the tool for the job. It can do everything the browser can.

## Set it up

Download the CLI from the [latest release](https://github.com/joemphilips/bitCaster/releases/latest). There are builds for Linux and macOS.

Then point your agent at [bitcaster-cli for AI agents](/technical/reference/cli-setup/). That page is written for the agent. It covers installation, configuration, every step of an order, and how to read the output.

## Tell it what you want

Say what to do and where the limits are. For example:

> Use bitcaster-cli. Find a market about the weather and show me its order book.
> Buy one Yes share with a price limit of 420. Show me the fees and wait for my
> approval before you submit the order.
