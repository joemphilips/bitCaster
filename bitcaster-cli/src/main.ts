#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Command, CommanderError } from 'commander'
import { callDaemon } from './rpc.ts'
import {
  configFilePath,
  readConfig,
  resolveEngineUrl,
  resolveMintUrl,
  writeConfig,
  type CliConfig,
} from './config.ts'
import type {
  DaemonCommand,
  DaemonResponse,
  WalletConsolidationResult,
} from '@bitcaster-market/daemon/protocol'

const execFileAsync = promisify(execFile)
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version?: string }

let globalEngineUrl: string | undefined
let globalMintUrl: string | undefined
let globalDryRun = false
let globalJson = false
let rootProgram: Command | undefined

await main()

async function main(): Promise<void> {
  const program = new Command()
  rootProgram = program
  program
    .name('bitcaster-cli')
    .description('Command-line client for bitCaster markets.')
    .version(packageJson.version ?? '0.0.0', '-V, --version')
    .option('--engine-url <url>', 'Override the matching engine URL for CLI-side reads')
    .option('--mint-url <url>', 'Override the mint URL for CLI-side operations')
    .option('--dry-run', 'Validate and print the intended operation without executing it')
    .option('--json', 'Print JSON output (currently the default)')
    .addHelpText(
      'after',
      `
Environment:
  BITCASTER_DAEMON_URL   Override daemon RPC base URL.
  BITCASTER_DAEMON_PORT  Override default daemon RPC port.

Long-running wallet and swap operations are delegated to bitcaster-daemon.`,
    )
    .exitOverride()
    .configureOutput({
      writeOut: (str) => process.stdout.write(str),
      writeErr: (str) => process.stdout.write(str),
      outputError: (str, write) => write(str),
    })

  program.hook('preAction', () => {
    const opts = program.opts<{
      engineUrl?: string
      mintUrl?: string
      dryRun?: boolean
      json?: boolean
    }>()
    globalEngineUrl = resolveEngineUrl(opts.engineUrl)
    globalMintUrl = resolveMintUrl(opts.mintUrl)
    globalDryRun = opts.dryRun === true
    globalJson = opts.json === true
    void globalEngineUrl
    void globalMintUrl
    void globalDryRun
    void globalJson
  })

  registerCommands(program)

  try {
    await program.parseAsync(process.argv)
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode
      return
    }
    throw err
  }
}

function registerCommands(program: Command): void {
  program
    .command('health')
    .description('Check daemon RPC health.')
    .action(async () => {
      await printDaemonResult(callDaemon({ method: 'health' }))
    })

  registerMarketCommand(program, 'market')
  registerMarketCommand(program, 'markets', true)
  registerWalletCommand(program)
  registerConsolidateCommand(program)
  registerOrderCommand(program)
  registerTradeCommand(program)
  registerDaemonCommand(program)
  registerConfigCommand(program)

  program
    .command('completion')
    .description('Shell completion (not yet implemented).')
    .action(() => {
      process.stdout.write('Shell completion not yet implemented\n')
    })
}

function registerMarketCommand(program: Command, name: 'market' | 'markets', hidden = false): void {
  const market = program
    .command(name, { hidden })
    .description('List markets and inspect market details.')
    .action(async () => {
      await queryMarkets({})
    })

  market
    .command('list')
    .description('Query markets with optional search, limit, and lifecycle filters.')
    .option('--search <query>', 'Search query')
    .option('--limit <n>', 'Maximum number of markets', parseIntegerOption('limit'))
    .option('--state <state>', 'Lifecycle state: Open, Closed, Resolved, or All', parseMarketState)
    .action(async (options: { search?: string; limit?: number; state?: 'Open' | 'Closed' | 'Resolved' | 'All' }) => {
      await queryMarkets(options)
    })

  market
    .command('show <conditionId>')
    .description('Show one market by condition id.')
    .action(async (conditionId: string) => {
      await printDaemonResult(
        callDaemon({ method: 'markets.show', params: { conditionId } }),
      )
    })
}

async function queryMarkets(options: {
  search?: string
  limit?: number
  state?: 'Open' | 'Closed' | 'Resolved' | 'All'
}): Promise<void> {
  const params: {
    search?: string
    limit?: number
    state?: 'Open' | 'Closed' | 'Resolved' | 'All'
  } = {}
  if (options.search !== undefined) params.search = options.search
  if (options.limit !== undefined) params.limit = options.limit
  if (options.state !== undefined) params.state = options.state
  await printDaemonResult(callDaemon({ method: 'markets.query', params }))
}

function registerWalletCommand(program: Command): void {
  const wallet = program
    .command('wallet')
    .description('Manage wallet balance, Cashu tokens, and wallet operations.')

  wallet
    .command('balance')
    .description('Show available wallet balances.')
    .action(async () => {
      await printDaemonResult(callDaemon({ method: 'wallet.balance' }))
    })

  wallet
    .command('receive <token>')
    .description('Import a Cashu token into the wallet.')
    .option('--condition-id <id>', 'Condition id for outcome-token imports')
    .option('--outcome-set <id>', 'Outcome set id for outcome-token imports')
    .action(async (token: string, options: { conditionId?: string; outcomeSet?: string }) => {
      const params: {
        token: string
        conditionId?: string
        outcomeSetId?: string
      } = { token }
      if (options.conditionId !== undefined) params.conditionId = options.conditionId
      if (options.outcomeSet !== undefined) params.outcomeSetId = options.outcomeSet
      if (!!params.conditionId !== !!params.outcomeSetId) {
        throwUsage(
          'wallet receive outcome-token imports require both --condition-id and --outcome-set',
        )
      }
      await printDaemonResult(callDaemon({ method: 'wallet.receive', params }))
    })

  wallet
    .command('send <amountSats>')
    .description('Prepare an ecash send operation for the requested amount.')
    .option('--mint <url>', 'Mint URL')
    .option('--operation-id <id>', 'Operation id')
    .action(async (amountSats: string, options: { mint?: string; operationId?: string }) => {
      const params: { amountSats: number; mintUrl?: string; operationId?: string } = {
        amountSats: parseIntegerArg(amountSats, 'amount sats'),
      }
      if (options.mint !== undefined) params.mintUrl = options.mint
      if (options.operationId !== undefined) params.operationId = options.operationId
      await printDaemonResult(callDaemon({ method: 'wallet.send', params }))
    })

  wallet
    .command('split-complete-set <conditionId> <amountSats>')
    .description('Split regular ecash into a complete conditional outcome set.')
    .option('--mint <url>', 'Mint URL')
    .option('--operation-id <id>', 'Operation id')
    .action(async (conditionId: string, amountSats: string, options: { mint?: string; operationId?: string }) => {
      const params: {
        conditionId: string
        amountSats: number
        mintUrl?: string
        operationId?: string
      } = { conditionId, amountSats: parseIntegerArg(amountSats, 'amount sats') }
      if (options.mint !== undefined) params.mintUrl = options.mint
      if (options.operationId !== undefined) params.operationId = options.operationId
      await printDaemonResult(callDaemon({ method: 'wallet.splitCompleteSet', params }))
    })

  wallet
    .command('operations')
    .description('List prepared or recoverable wallet operations.')
    .option('--kind <kind>', 'Operation kind')
    .option('--state <state>', 'Operation state')
    .action(async (options: { kind?: string; state?: string }) => {
      const params: { kind?: string; state?: string } = {}
      if (options.kind !== undefined) params.kind = options.kind
      if (options.state !== undefined) params.state = options.state
      await printDaemonResult(callDaemon({ method: 'wallet.operations', params }))
    })

  wallet
    .command('recover')
    .description('Resume or recover incomplete wallet operations.')
    .action(async () => {
      await printDaemonResult(callDaemon({ method: 'wallet.recover' }))
    })
}

function registerConsolidateCommand(program: Command): void {
  program
    .command('consolidate [marketId]')
    .description('Consolidate pending CTF market positions through bitcaster-daemon.')
    .option('--all', 'Sweep every market id found in wallet balance')
    .option('--type <type>', 'Consolidation type: t1, t2, or t3', parseConsolidationType, 't3')
    .action(async (marketId: string | undefined, options: { all?: boolean; type: 't1' | 't2' | 't3' }) => {
      await handleConsolidate({ all: options.all === true, marketId: marketId ?? '', type: options.type })
    })
}

async function handleConsolidate(parsed: ConsolidateArgs): Promise<void> {
  if (parsed.all && parsed.marketId) {
    throwUsage('consolidate --all cannot be combined with a market id')
  }
  if (!parsed.all && !parsed.marketId) {
    throwUsage('Usage: bitcaster-cli consolidate <market-id> [--type t1|t2|t3]')
  }
  if (parsed.all) {
    const balance = await callDaemon<WalletBalanceResult>({ method: 'wallet.balance' })
    if (!balance.ok) {
      await printDaemonResult(Promise.resolve(balance))
      return
    }
    const marketIds = uniqueMarketIdsFromWalletBalance(balance.result)
    for (const marketId of marketIds) {
      await printConsolidationResponse(
        await callDaemon<WalletConsolidationResult>({
          method: 'wallet.consolidateMarket',
          params: { marketId, type: parsed.type },
        }),
        { sweep: true, marketId },
      )
    }
    return
  }
  await printConsolidationResponse(
    await callDaemon<WalletConsolidationResult>({
      method: 'wallet.consolidateMarket',
      params: { marketId: parsed.marketId, type: parsed.type },
    }),
    { sweep: false, marketId: parsed.marketId },
  )
}

function registerOrderCommand(program: Command): void {
  const order = program
    .command('order')
    .description('Submit, inspect, list, cancel orders, and read order books.')

  order
    .command('submit <marketId> <outcomeId> <side> <price> <amountSats> [timeInForce]')
    .description('Submit a buy or sell order to the matching engine.')
    .option('--token-side <side>', 'Token side: Outcome or Complement', parseTokenSide)
    .option('--no-preflight-split', 'Disable preflight complete-set split')
    .action(async (
      marketId: string,
      outcomeId: string,
      sideRaw: string,
      priceRaw: string,
      amountSatsRaw: string,
      timeInForceRaw: string | undefined,
      options: { tokenSide?: 'Outcome' | 'Complement'; preflightSplit: boolean },
    ) => {
      const params: {
        marketId: string
        outcomeId: string
        tokenSide: 'Outcome' | 'Complement'
        side: 'Buy' | 'Sell'
        price: number
        amountSats: number
        timeInForce: 'FAK' | 'FOK' | 'GTC'
        preflightSplit: boolean
      } = {
        marketId,
        outcomeId,
        tokenSide: options.tokenSide ?? 'Outcome',
        side: parseSide(sideRaw),
        price: parseIntegerArg(priceRaw, 'price'),
        amountSats: parseIntegerArg(amountSatsRaw, 'amount sats'),
        timeInForce: parseTimeInForce(timeInForceRaw ?? 'GTC'),
        preflightSplit: options.preflightSplit,
      }
      await printDaemonResult(callDaemon({ method: 'order.submit', params }))
    })

  order
    .command('status <marketId> <orderId>')
    .description('Show one order by market id and order id.')
    .action(async (marketId: string, orderId: string) => {
      await printDaemonResult(
        callDaemon({ method: 'order.status', params: { marketId, orderId } }),
      )
    })

  order
    .command('list')
    .description('List orders, optionally filtered by market or status.')
    .option('--market <market-id>', 'Market id')
    .option('--status <status>', 'Order status')
    .action(async (options: { market?: string; status?: string }) => {
      const params: { marketId?: string; status?: string } = {}
      if (options.market !== undefined) params.marketId = options.market
      if (options.status !== undefined) params.status = options.status
      await printDaemonResult(callDaemon({ method: 'order.list', params }))
    })

  order
    .command('cancel <marketId> <orderId>')
    .description('Cancel an open order.')
    .action(async (marketId: string, orderId: string) => {
      await printDaemonResult(
        callDaemon({ method: 'order.cancel', params: { marketId, orderId } }),
      )
    })

  order
    .command('book <marketId>')
    .description('Show the order book for one market.')
    .action(async (marketId: string) => {
      await printDaemonResult(callDaemon({ method: 'order.book', params: { marketId } }))
    })
}

function registerTradeCommand(program: Command): void {
  const trade = program
    .command('trade')
    .description('Recover, list, and watch atomic swap trades.')

  trade
    .command('recover')
    .description('Resume or repair incomplete atomic swap trades.')
    .action(async () => {
      await printDaemonResult(callDaemon({ method: 'trade.recover' }))
    })

  trade
    .command('list')
    .description('List trades, optionally filtered by market, order, or protocol step.')
    .option('--market <market-id>', 'Market id')
    .option('--order <order-id>', 'Order id')
    .option('--step <step>', 'Protocol step')
    .action(async (options: { market?: string; order?: string; step?: string }) => {
      const params: { marketId?: string; orderId?: string; step?: string } = {}
      if (options.market !== undefined) params.marketId = options.market
      if (options.order !== undefined) params.orderId = options.order
      if (options.step !== undefined) params.step = options.step
      await printDaemonResult(callDaemon({ method: 'trade.list', params }))
    })

  trade
    .command('watch <tradeId>')
    .description('Show one trade, or wait until it reaches a terminal state.')
    .option('--wait', 'Poll until the trade reaches a terminal state')
    .option('--interval-ms <n>', 'Polling interval in milliseconds', parseIntegerOption('interval ms'), 1_000)
    .option('--timeout-ms <n>', 'Timeout in milliseconds; 0 disables timeout', parseNonNegativeIntegerOption('timeout ms'), 0)
    .action(async (tradeId: string, options: TradeWatchOptions) => {
      if (!options.wait && (options.intervalMs !== 1_000 || options.timeoutMs !== 0)) {
        throwUsage('trade watch polling options require --wait')
      }
      if (options.wait) {
        await watchTradeUntilTerminal(tradeId, options)
        return
      }
      await printDaemonResult(callDaemon({ method: 'trade.watch', params: { tradeId } }))
    })
}

function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Initialize, configure, and inspect the local daemon.')

  daemon
    .command('status')
    .description('Show daemon health and runtime status.')
    .action(async () => {
      await printDaemonResult(callDaemon({ method: 'daemon.status' }))
    })

  daemon
    .command('config')
    .description('Update daemon engine and mint endpoint configuration.')
    .option('--engine-url <url>', 'Engine URL')
    .option('--mint-url <url>', 'Mint URL')
    .action(async (options: { engineUrl?: string; mintUrl?: string }) => {
      const params = daemonConfigParams(options)
      await printDaemonResult(callDaemon({ method: 'daemon.config', params }))
    })

  daemon
    .command('init')
    .description('Initialize daemon profile, wallet seed, Nostr key, and endpoints.')
    .option('--wallet-seed-hex <hex>', 'Wallet seed hex')
    .option('--wallet-seed-hex-file <path>', 'File containing wallet seed hex')
    .option('--nostr-secret-key-hex <hex>', 'Nostr secret key hex')
    .option('--nostr-secret-key-hex-file <path>', 'File containing Nostr secret key hex')
    .option('--engine-url <url>', 'Engine URL')
    .option('--mint-url <url>', 'Mint URL')
    .option('--force', 'Overwrite existing daemon profile')
    .action(async (options: {
      walletSeedHex?: string
      walletSeedHexFile?: string
      nostrSecretKeyHex?: string
      nostrSecretKeyHexFile?: string
      engineUrl?: string
      mintUrl?: string
      force?: boolean
    }) => {
      const passthrough = ['init']
      pushOption(passthrough, '--wallet-seed-hex', options.walletSeedHex)
      pushOption(passthrough, '--wallet-seed-hex-file', options.walletSeedHexFile)
      pushOption(passthrough, '--nostr-secret-key-hex', options.nostrSecretKeyHex)
      pushOption(passthrough, '--nostr-secret-key-hex-file', options.nostrSecretKeyHexFile)
      const rootOptions = rootProgram?.opts<{ engineUrl?: string; mintUrl?: string }>() ?? {}
      pushOption(passthrough, '--engine-url', options.engineUrl ?? rootOptions.engineUrl)
      pushOption(passthrough, '--mint-url', options.mintUrl ?? rootOptions.mintUrl)
      if (options.force === true) passthrough.push('--force')
      await runDaemonCommand(passthrough)
      process.stdout.write(`Config: ${configFilePath()}\n`)
    })
}

function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Inspect and update CLI configuration.')
    .addHelpText(
      'after',
      `
Examples:
  bitcaster-cli config set --engine-url <url>
  bitcaster-cli config set --mint-url <url>`,
    )

  config
    .command('get [key]')
    .description('Print one config value, or all config as JSON.')
    .action((key?: string) => {
      printConfigValue(key)
    })

  config
    .command('set')
    .description('Set CLI config values and write through to the daemon when reachable.')
    .option('--engine-url <url>', 'Engine URL')
    .option('--mint-url <url>', 'Mint URL')
    .action(async (options: { engineUrl?: string; mintUrl?: string }) => {
      await setCliConfig(options)
    })

  config
    .command('path')
    .description('Print the CLI config file path.')
    .action(() => {
      process.stdout.write(`${configFilePath()}\n`)
    })

  config
    .command('list')
    .description('List all config values as JSON.')
    .action(() => {
      process.stdout.write(`${JSON.stringify(readConfig(), null, 2)}\n`)
    })
}

function daemonConfigParams(options: { engineUrl?: string; mintUrl?: string }): { engineUrl?: string; mintUrl?: string } {
  const rootOptions = rootProgram?.opts<{ engineUrl?: string; mintUrl?: string }>() ?? {}
  const params: { engineUrl?: string; mintUrl?: string } = {}
  const engineUrl = options.engineUrl ?? rootOptions.engineUrl
  const mintUrl = options.mintUrl ?? rootOptions.mintUrl
  if (engineUrl !== undefined) params.engineUrl = engineUrl
  if (mintUrl !== undefined) params.mintUrl = mintUrl
  if (!params.engineUrl && !params.mintUrl) {
    throwUsage('Usage: bitcaster-cli daemon config [--engine-url <url>] [--mint-url <url>]')
  }
  return params
}

function printConfigValue(key?: string): void {
  const config = readConfig()
  if (key === undefined) {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`)
    return
  }
  if (key !== 'engineUrl' && key !== 'mintUrl') {
    throwUsage(`Unknown config key: ${key}`)
  }
  const value = config[key]
  process.stdout.write(value === undefined ? 'null\n' : `${JSON.stringify(value)}\n`)
}

async function setCliConfig(options: { engineUrl?: string; mintUrl?: string }): Promise<void> {
  const params = daemonConfigParams(options)
  const config: CliConfig = readConfig()
  if (params.engineUrl !== undefined) config.engineUrl = params.engineUrl
  if (params.mintUrl !== undefined) config.mintUrl = params.mintUrl
  writeConfig(config)

  try {
    await printDaemonResult(callDaemonWithoutAutostart({ method: 'daemon.config', params }))
  } catch {
    process.stderr.write(
      `daemon not reachable; config.json updated. Run 'bitcaster daemon init' to initialize the daemon. Config written to ${configFilePath()}.\n`,
    )
    process.stdout.write(
      `${JSON.stringify({ ok: true, result: { config, daemonUpdated: false } }, null, 2)}\n`,
    )
  }
}

async function callDaemonWithoutAutostart<T = unknown>(
  command: DaemonCommand,
): Promise<DaemonResponse<T>> {
  const previous = process.env.BITCASTER_CLI_AUTOSTART_DAEMON
  process.env.BITCASTER_CLI_AUTOSTART_DAEMON = '0'
  try {
    return await callDaemon<T>(command)
  } finally {
    if (previous === undefined) delete process.env.BITCASTER_CLI_AUTOSTART_DAEMON
    else process.env.BITCASTER_CLI_AUTOSTART_DAEMON = previous
  }
}

interface ConsolidateArgs {
  all: boolean
  marketId: string
  type: 't1' | 't2' | 't3'
}

interface WalletBalanceResult {
  outcomePositions?: Array<{
    conditionId?: string
    outcomeSetId?: string
  }>
}

function parseConsolidationType(value: string): 't1' | 't2' | 't3' {
  const lower = value.toLowerCase()
  if (lower === 't1' || lower === 't2' || lower === 't3') return lower
  throwUsage(`Invalid consolidation type: ${value}`)
}

async function printConsolidationResponse(
  response: DaemonResponse<WalletConsolidationResult>,
  options: { sweep: boolean; marketId: string },
): Promise<void> {
  if (response.ok) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`)
    if (response.result?.status === 'skipped') {
      process.stderr.write(
        `Warning: skipped ${options.marketId}: ${response.result.reason ?? 'no matching consolidation'}\n`,
      )
    }
    return
  }
  if (response.code === 'ctf-consolidation-no-gain') {
    process.stderr.write(`Warning: skipped ${options.marketId}: ${response.error ?? 'no net collateral gain'}\n`)
    return
  }
  if (options.sweep && response.code === 'market-not-pending') {
    process.stderr.write(`Warning: skipped ${options.marketId}: ${response.error ?? 'market is not pending'}\n`)
    return
  }
  process.stderr.write(`${response.error ?? 'consolidation failed'}\n`)
  process.exitCode = 1
}

function uniqueMarketIdsFromWalletBalance(balance: WalletBalanceResult | undefined): string[] {
  const marketIds = new Set<string>()
  for (const position of balance?.outcomePositions ?? []) {
    if (!position.conditionId || !position.outcomeSetId) continue
    marketIds.add(`${position.conditionId}-${position.outcomeSetId}`)
  }
  return [...marketIds].sort()
}

interface TradeWatchOptions {
  wait: boolean
  intervalMs: number
  timeoutMs: number
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

function parseIntegerOption(name: string): (value: string) => number {
  return (value: string) => parseIntegerArg(value, name)
}

function parseNonNegativeIntegerOption(name: string): (value: string) => number {
  return (value: string) => parseNonNegativeIntegerArg(value, name)
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

function requiredArg(value: string | undefined, name: string): string {
  if (value) return value
  throwUsage(`Missing ${name}`)
}

function parseSide(value: string): 'Buy' | 'Sell' {
  if (value === 'Buy' || value === 'buy') return 'Buy'
  if (value === 'Sell' || value === 'sell') return 'Sell'
  throwUsage(`Invalid side: ${value}`)
}

function parseTokenSide(value: string): 'Outcome' | 'Complement' {
  if (value === 'Outcome' || value === 'outcome') return 'Outcome'
  if (value === 'Complement' || value === 'complement') return 'Complement'
  throwUsage(`Invalid token side: ${value}`)
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

function pushOption(args: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) args.push(flag, value)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
