#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { callDaemon } from './rpc.ts'
import type { DaemonResponse } from '@bitcaster-market/daemon/protocol'

const [, , command = 'help', ...args] = process.argv
const execFileAsync = promisify(execFile)

switch (command) {
  case 'health':
    if (isHelpRequest(args)) {
      printHealthHelp()
      break
    }
    if (args.length > 0) throwUsage('Usage: bitcaster-cli health')
    await printDaemonResult(callDaemon({ method: 'health' }))
    break
  case 'markets':
    await handleMarkets(args)
    break
  case 'wallet':
    await handleWallet(args)
    break
  case 'order':
    await handleOrder(args)
    break
  case 'trade':
    await handleTrade(args)
    break
  case 'daemon':
    await handleDaemon(args)
    break
  case 'help':
  case '--help':
  case '-h':
    printHelp()
    break
  default:
    printHelp()
    if (command !== 'help') process.exitCode = 1
}

async function handleDaemon(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args
  if (isHelpRequest(args)) {
    printDaemonHelp()
    return
  }
  if (subcommand === 'status') {
    if (rest.length > 0) throwUsage('Usage: bitcaster-cli daemon status')
    await printDaemonResult(callDaemon({ method: 'daemon.status' }))
    return
  }
  if (subcommand === 'config') {
    const params: { engineUrl?: string; mintUrl?: string } = {}
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]
      if (arg === '--engine-url') {
        params.engineUrl = requiredArg(rest[++i], arg)
      } else if (arg === '--mint-url') {
        params.mintUrl = requiredArg(rest[++i], arg)
      } else {
        throwUsage(`Unknown daemon config option: ${arg}`)
      }
    }
    if (!params.engineUrl && !params.mintUrl) {
      throwUsage('Usage: bitcaster-cli daemon config [--engine-url <url>] [--mint-url <url>]')
    }
    await printDaemonResult(callDaemon({ method: 'daemon.config', params }))
    return
  }
  if (subcommand === 'init') {
    const passthrough: string[] = ['init']
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]
      if (
        arg === '--wallet-seed-hex' ||
        arg === '--wallet-seed-hex-file' ||
        arg === '--nostr-secret-key-hex' ||
        arg === '--nostr-secret-key-hex-file'
      ) {
        passthrough.push(arg, requiredArg(rest[++i], arg))
      } else if (arg === '--engine-url' || arg === '--mint-url') {
        passthrough.push(arg, requiredArg(rest[++i], arg))
      } else if (arg === '--force') {
        passthrough.push(arg)
      } else {
        throwUsage(`Unknown daemon init option: ${arg}`)
      }
    }
    await runDaemonCommand(passthrough)
    return
  }
  throwUsage(`Usage:
  bitcaster-cli daemon init [--wallet-seed-hex <hex>|--wallet-seed-hex-file <path>] [--nostr-secret-key-hex <hex>|--nostr-secret-key-hex-file <path>] [--force] [--engine-url <url>] [--mint-url <url>]
  bitcaster-cli daemon config [--engine-url <url>] [--mint-url <url>]
  bitcaster-cli daemon status`)
}

async function handleMarkets(args: string[]): Promise<void> {
  const [subcommand = 'list', ...rest] = args
  if (isHelpRequest(args)) {
    printMarketsHelp()
    return
  }
  if (subcommand === 'show') {
    const conditionId = requiredArg(rest[0], 'condition id')
    if (rest.length > 1) {
      throwUsage('Usage: bitcaster-cli markets show <condition-id>')
    }
    await printDaemonResult(
      callDaemon({ method: 'markets.show', params: { conditionId } }),
    )
    return
  }
  if (subcommand !== 'list') {
    throwUsage(`Usage:
  bitcaster-cli markets list [--search <query>] [--limit <n>] [--state <Open|Closed|Resolved|All>]
  bitcaster-cli markets show <condition-id>`)
  }
  const params: {
    search?: string
    limit?: number
    state?: 'Open' | 'Closed' | 'Resolved' | 'All'
  } = {}
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--search') {
      params.search = requiredArg(rest[++i], 'search query')
    } else if (arg === '--limit') {
      params.limit = parseIntegerArg(rest[++i], 'limit')
    } else if (arg === '--state') {
      params.state = parseMarketState(requiredArg(rest[++i], 'state'))
    } else {
      throwUsage(`Unknown markets option: ${arg}`)
    }
  }
  await printDaemonResult(callDaemon({ method: 'markets.query', params }))
}

async function handleWallet(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args
  if (isHelpRequest(args)) {
    printWalletHelp()
    return
  }
  if (subcommand === 'balance') {
    await printDaemonResult(callDaemon({ method: 'wallet.balance' }))
    return
  }
  if (subcommand === 'receive') {
    const token = requiredArg(rest[0], 'cashu token')
    const params: {
      token: string
      conditionId?: string
      outcomeSetId?: string
    } = { token }
    for (let i = 1; i < rest.length; i += 1) {
      const arg = rest[i]
      if (arg === '--condition-id') {
        params.conditionId = requiredArg(rest[++i], 'condition id')
      } else if (arg === '--outcome-set') {
        params.outcomeSetId = requiredArg(rest[++i], 'outcome set id')
      } else {
        throwUsage(`Unknown wallet receive option: ${arg}`)
      }
    }
    if (!!params.conditionId !== !!params.outcomeSetId) {
      throwUsage(
        'wallet receive outcome-token imports require both --condition-id and --outcome-set',
      )
    }
    await printDaemonResult(callDaemon({ method: 'wallet.receive', params }))
    return
  }
  if (subcommand === 'send') {
    const amountSats = parseIntegerArg(rest[0], 'amount sats')
    const params: { amountSats: number; mintUrl?: string; operationId?: string } = { amountSats }
    for (let i = 1; i < rest.length; i += 1) {
      const arg = rest[i]
      if (arg === '--mint') {
        params.mintUrl = requiredArg(rest[++i], 'mint URL')
      } else if (arg === '--operation-id') {
        params.operationId = requiredArg(rest[++i], 'operation id')
      } else {
        throwUsage(`Unknown wallet send option: ${arg}`)
      }
    }
    await printDaemonResult(callDaemon({ method: 'wallet.send', params }))
    return
  }
  if (subcommand === 'split-complete-set') {
    const conditionId = requiredArg(rest[0], 'condition id')
    const amountSats = parseIntegerArg(rest[1], 'amount sats')
    const params: {
      conditionId: string
      amountSats: number
      mintUrl?: string
      operationId?: string
    } = { conditionId, amountSats }
    for (let i = 2; i < rest.length; i += 1) {
      const arg = rest[i]
      if (arg === '--mint') {
        params.mintUrl = requiredArg(rest[++i], 'mint URL')
      } else if (arg === '--operation-id') {
        params.operationId = requiredArg(rest[++i], 'operation id')
      } else {
        throwUsage(`Unknown wallet split-complete-set option: ${arg}`)
      }
    }
    await printDaemonResult(callDaemon({ method: 'wallet.splitCompleteSet', params }))
    return
  }
  if (subcommand === 'operations') {
    const params: { kind?: string; state?: string } = {}
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]
      if (arg === '--kind') {
        params.kind = requiredArg(rest[++i], 'operation kind')
      } else if (arg === '--state') {
        params.state = requiredArg(rest[++i], 'operation state')
      } else {
        throwUsage(`Unknown wallet operations option: ${arg}`)
      }
    }
    await printDaemonResult(callDaemon({ method: 'wallet.operations', params }))
    return
  }
  if (subcommand === 'recover') {
    if (rest.length > 0) throwUsage('Usage: bitcaster-cli wallet recover')
    await printDaemonResult(callDaemon({ method: 'wallet.recover' }))
    return
  }
  throwUsage(`Usage:
  bitcaster-cli wallet balance
  bitcaster-cli wallet receive <cashu-token> [--condition-id <id> --outcome-set <id>]
  bitcaster-cli wallet send <amount-sats> [--mint <url>] [--operation-id <id>]
  bitcaster-cli wallet split-complete-set <condition-id> <amount-sats> [--mint <url>] [--operation-id <id>]
  bitcaster-cli wallet operations [--kind <kind>] [--state <state>]
  bitcaster-cli wallet recover`)
}

async function handleOrder(args: string[]): Promise<void> {
  const [subcommand] = args
  if (isHelpRequest(args)) {
    printOrderHelp()
    return
  }
  if (subcommand === 'submit') {
    const marketId = requiredArg(args[1], 'market id')
    const outcomeId = requiredArg(args[2], 'outcome id')
    const side = parseSide(requiredArg(args[3], 'side'))
    const price = parseIntegerArg(args[4], 'price')
    const amountSats = parseIntegerArg(args[5], 'amount sats')
    const timeInForce = parseTimeInForce(args[6] ?? 'GTC')
    const params = {
      marketId,
      outcomeId,
      side,
      price,
      amountSats,
      timeInForce,
      preflightSplit: true,
    }
    for (let i = 7; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '--no-preflight-split') {
        params.preflightSplit = false
      } else {
        throwUsage(`Unknown order submit option: ${arg}`)
      }
    }
    await printDaemonResult(
      callDaemon({
        method: 'order.submit',
        params,
      }),
    )
    return
  }
  if (subcommand === 'status') {
    const marketId = requiredArg(args[1], 'market id')
    const orderId = requiredArg(args[2], 'order id')
    await printDaemonResult(
      callDaemon({ method: 'order.status', params: { marketId, orderId } }),
    )
    return
  }
  if (subcommand === 'list') {
    const params: { marketId?: string; status?: string } = {}
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '--market') {
        params.marketId = requiredArg(args[++i], 'market id')
      } else if (arg === '--status') {
        params.status = requiredArg(args[++i], 'status')
      } else {
        throwUsage(`Unknown order list option: ${arg}`)
      }
    }
    await printDaemonResult(callDaemon({ method: 'order.list', params }))
    return
  }
  if (subcommand === 'cancel') {
    const marketId = requiredArg(args[1], 'market id')
    const orderId = requiredArg(args[2], 'order id')
    await printDaemonResult(
      callDaemon({ method: 'order.cancel', params: { marketId, orderId } }),
    )
    return
  }
  if (subcommand === 'book') {
    const marketId = requiredArg(args[1], 'market id')
    await printDaemonResult(
      callDaemon({ method: 'order.book', params: { marketId } }),
    )
    return
  }
  throwUsage(`Usage:
  bitcaster-cli order submit <market-id> <outcome-id> <Buy|Sell> <price> <amount-sats> [GTC|FAK|FOK] [--no-preflight-split]
  bitcaster-cli order status <market-id> <order-id>
  bitcaster-cli order list [--market <market-id>] [--status <status>]
  bitcaster-cli order cancel <market-id> <order-id>
  bitcaster-cli order book <market-id>`)
}

async function handleTrade(args: string[]): Promise<void> {
  const [subcommand] = args
  if (isHelpRequest(args)) {
    printTradeHelp()
    return
  }
  if (subcommand === 'recover') {
    if (args.length > 1) throwUsage('Usage: bitcaster-cli trade recover')
    await printDaemonResult(callDaemon({ method: 'trade.recover' }))
    return
  }
  if (subcommand === 'list') {
    const params: { marketId?: string; orderId?: string; step?: string } = {}
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '--market') {
        params.marketId = requiredArg(args[++i], 'market id')
      } else if (arg === '--order') {
        params.orderId = requiredArg(args[++i], 'order id')
      } else if (arg === '--step') {
        params.step = requiredArg(args[++i], 'step')
      } else {
        throwUsage(`Unknown trade list option: ${arg}`)
      }
    }
    await printDaemonResult(callDaemon({ method: 'trade.list', params }))
    return
  }
  if (subcommand === 'watch') {
    const tradeId = requiredArg(args[1], 'trade id')
    const options = parseTradeWatchOptions(args.slice(2))
    if (options.wait) {
      await watchTradeUntilTerminal(tradeId, options)
      return
    }
    await printDaemonResult(callDaemon({ method: 'trade.watch', params: { tradeId } }))
    return
  }
  throwUsage(`Usage:
  bitcaster-cli trade recover
  bitcaster-cli trade list [--market <market-id>] [--order <order-id>] [--step <step>]
  bitcaster-cli trade watch <trade-id> [--wait] [--interval-ms <n>] [--timeout-ms <n>]`)
}

interface TradeWatchOptions {
  wait: boolean
  intervalMs: number
  timeoutMs: number
}

function parseTradeWatchOptions(args: string[]): TradeWatchOptions {
  const options: TradeWatchOptions = {
    wait: false,
    intervalMs: 1_000,
    timeoutMs: 0,
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--wait') {
      options.wait = true
    } else if (arg === '--interval-ms') {
      options.intervalMs = parseIntegerArg(args[++i], 'interval ms')
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = parseNonNegativeIntegerArg(args[++i], 'timeout ms')
    } else {
      throwUsage(`Unknown trade watch option: ${arg}`)
    }
  }
  if (!options.wait && (options.intervalMs !== 1_000 || options.timeoutMs !== 0)) {
    throwUsage('trade watch polling options require --wait')
  }
  return options
}

async function watchTradeUntilTerminal(
  tradeId: string,
  options: TradeWatchOptions,
): Promise<void> {
  const startedAt = Date.now()
  let lastSnapshot = ''
  while (true) {
    const response = await callDaemon({ method: 'trade.watch', params: { tradeId } })
    const snapshot = JSON.stringify(response)
    if (snapshot !== lastSnapshot) {
      process.stdout.write(`${snapshot}\n`)
      lastSnapshot = snapshot
    }
    if (isDaemonFailure(response)) {
      process.exitCode = 1
      return
    }
    if (isTerminalTradeResult(response)) return
    if (options.timeoutMs > 0 && Date.now() - startedAt >= options.timeoutMs) {
      process.stderr.write(`Timed out waiting for trade ${tradeId}\n`)
      process.exitCode = 1
      return
    }
    await sleep(options.intervalMs)
  }
}

function isTerminalTradeResult(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  const result = (response as { result?: unknown }).result
  if (!result || typeof result !== 'object') return false
  const step = (result as { step?: unknown }).step
  return step === 'confirmed' || step === 'refunded' || step === 'failed'
}

async function printDaemonResult<T>(promise: Promise<T>): Promise<void> {
  const result = await promise
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (isDaemonFailure(result)) {
    process.exitCode = 1
  }
}

function isDaemonFailure(value: unknown): value is DaemonResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    (value as { ok?: unknown }).ok === false
  )
}

function requiredArg(value: string | undefined, name: string): string {
  if (value) return value
  throwUsage(`Missing ${name}`)
}

function parseIntegerArg(value: string | undefined, name: string): number {
  const raw = requiredArg(value, name)
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed > 0) return parsed
  throwUsage(`Invalid ${name}: ${raw}`)
}

function parseNonNegativeIntegerArg(value: string | undefined, name: string): number {
  const raw = requiredArg(value, name)
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed >= 0) return parsed
  throwUsage(`Invalid ${name}: ${raw}`)
}

function parseSide(value: string): 'Buy' | 'Sell' {
  if (value === 'Buy' || value === 'buy') return 'Buy'
  if (value === 'Sell' || value === 'sell') return 'Sell'
  throwUsage(`Invalid side: ${value}`)
}

function parseTimeInForce(value: string): 'FAK' | 'FOK' | 'GTC' {
  const upper = value.toUpperCase()
  if (upper === 'FAK' || upper === 'FOK' || upper === 'GTC') return upper
  throwUsage(`Invalid time in force: ${value}`)
}

function parseMarketState(value: string): 'Open' | 'Closed' | 'Resolved' | 'All' {
  if (
    value === 'Open' ||
    value === 'Closed' ||
    value === 'Resolved' ||
    value === 'All'
  ) {
    return value
  }
  throwUsage(`Invalid market state: ${value}`)
}

function throwUsage(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function isHelpRequest(args: string[]): boolean {
  return args.length === 1 && (args[0] === '--help' || args[0] === '-h' || args[0] === 'help')
}

async function runDaemonCommand(args: string[]): Promise<void> {
  const daemonMain = fileURLToPath(import.meta.resolve('@bitcaster-market/daemon'))
  const result = await execFileAsync(
    process.execPath,
    ['--experimental-strip-types', daemonMain, ...args],
    { env: process.env },
  )
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
}

function printHelp(): void {
  process.stdout.write(`bitcaster-cli

Usage:
  bitcaster-cli <command> [arguments]

Commands:
  daemon   Initialize, configure, and inspect the local daemon.
  health   Check daemon RPC health.
  markets  List markets and inspect market details.
  wallet   Manage wallet balance, Cashu tokens, and wallet operations.
  order    Submit, inspect, list, cancel orders, and read order books.
  trade    Recover, list, and watch atomic swap trades.

Run 'bitcaster-cli <command> --help' for command usage.

Long-running wallet and swap operations are delegated to bitcaster-daemon.
`)
}

function printHealthHelp(): void {
  process.stdout.write(`bitcaster-cli health

Check daemon RPC health.

Usage:
  bitcaster-cli health
`)
}

function printDaemonHelp(): void {
  process.stdout.write(`bitcaster-cli daemon

Initialize, configure, and inspect the local daemon.

Usage:
  bitcaster-cli daemon init [--wallet-seed-hex <hex>|--wallet-seed-hex-file <path>] [--nostr-secret-key-hex <hex>|--nostr-secret-key-hex-file <path>] [--force] [--engine-url <url>] [--mint-url <url>]
  bitcaster-cli daemon config [--engine-url <url>] [--mint-url <url>]
  bitcaster-cli daemon status

Subcommands:
  init    Initialize daemon profile, wallet seed, Nostr key, and endpoints.
  config  Update daemon engine and mint endpoint configuration.
  status  Show daemon health and runtime status.
`)
}

function printMarketsHelp(): void {
  process.stdout.write(`bitcaster-cli markets

List markets and inspect market details.

Usage:
  bitcaster-cli markets list [--search <query>] [--limit <n>] [--state <Open|Closed|Resolved|All>]
  bitcaster-cli markets show <condition-id>

Subcommands:
  list  Query markets with optional search, limit, and lifecycle filters.
  show  Show one market by condition id.
`)
}

function printWalletHelp(): void {
  process.stdout.write(`bitcaster-cli wallet

Manage wallet balance, Cashu tokens, and wallet operations.

Usage:
  bitcaster-cli wallet balance
  bitcaster-cli wallet receive <cashu-token> [--condition-id <id> --outcome-set <id>]
  bitcaster-cli wallet send <amount-sats> [--mint <url>] [--operation-id <id>]
  bitcaster-cli wallet split-complete-set <condition-id> <amount-sats> [--mint <url>] [--operation-id <id>]
  bitcaster-cli wallet operations [--kind <kind>] [--state <state>]
  bitcaster-cli wallet recover

Subcommands:
  balance             Show available wallet balances.
  receive             Import a Cashu token into the wallet.
  send                Prepare an ecash send operation for the requested amount.
  split-complete-set  Split regular ecash into a complete conditional outcome set.
  operations          List prepared or recoverable wallet operations.
  recover             Resume or recover incomplete wallet operations.
`)
}

function printOrderHelp(): void {
  process.stdout.write(`bitcaster-cli order

Submit, inspect, list, cancel orders, and read order books.

Usage:
  bitcaster-cli order submit <market-id> <outcome-id> <Buy|Sell> <price> <amount-sats> [GTC|FAK|FOK] [--no-preflight-split]
  bitcaster-cli order status <market-id> <order-id>
  bitcaster-cli order list [--market <market-id>] [--status <status>]
  bitcaster-cli order cancel <market-id> <order-id>
  bitcaster-cli order book <market-id>

Subcommands:
  submit  Submit a buy or sell order to the matching engine.
  status  Show one order by market id and order id.
  list    List orders, optionally filtered by market or status.
  cancel  Cancel an open order.
  book    Show the order book for one market.
`)
}

function printTradeHelp(): void {
  process.stdout.write(`bitcaster-cli trade

Recover, list, and watch atomic swap trades.

Usage:
  bitcaster-cli trade recover
  bitcaster-cli trade list [--market <market-id>] [--order <order-id>] [--step <step>]
  bitcaster-cli trade watch <trade-id> [--wait] [--interval-ms <n>] [--timeout-ms <n>]

Subcommands:
  recover  Resume or repair incomplete atomic swap trades.
  list     List trades, optionally filtered by market, order, or protocol step.
  watch    Show one trade, or wait until it reaches a terminal state.
`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
