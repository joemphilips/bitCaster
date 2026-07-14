#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { normalize } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  BitcasterEngineClient,
  EngineClientError,
  isKind89NostrEvent,
  validateMarketCreateEngineUrl,
} from '@bitcaster-market/client-sdk'
import { Command, CommanderError, Option } from 'commander'
import {
  callDaemon,
  daemonLogPath,
  DaemonNotReachableError,
  isCliSpawnedDaemonRunning,
  isNetworkFailure,
  restartDaemon,
  stopDaemon,
} from './rpc.ts'
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
  MarketCloseParams,
  MarketCreateParams,
  QueryMarketsParams,
  DaemonEmergencySeedRecoveryResult,
  WalletConsolidationResult,
} from '@bitcaster-market/daemon/protocol'

const execFileAsync = promisify(execFile)
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version?: string }
const dryRunRedactedKeys = new Set([
  'authorization',
  'nostrSecretKeyHex',
  'sig',
  'token',
  'walletSeedHex',
])

let globalEngineUrl: string | undefined
let globalMintUrl: string | undefined
let globalDryRun = false
let globalJson = false
let rootProgram: Command | undefined

const DIRECT_ENGINE_READ_TIMEOUT_MS = 5_000

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
      process.exitCode = commanderExitCode(err)
      return
    }
    if (err instanceof DaemonNotReachableError) {
      printDaemonNotReachable(err)
      return
    }
    if (err instanceof Error) {
      process.stderr.write(`${err.message}\n`)
      process.exitCode = 1
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

  registerMarketCommand(program)
  registerWalletCommand(program)
  registerOrderCommand(program)
  registerTradeCommand(program)
  registerDaemonCommand(program)
  registerConfigCommand(program)

  program
    .command('completion')
    .description('Shell completion (not yet implemented).')
    .addHelpText('after', '\nExample:\n  bitcaster-cli completion')
    .action(() => {
      process.stdout.write('Shell completion not yet implemented\n')
    })
}

function registerMarketCommand(program: Command): void {
  const market = program
    .command('market')
    .description('List markets and inspect market details.')
    .addHelpText('after', '\nExamples:\n  bitcaster-cli market list --search weather --limit 5\n  bitcaster-cli market show <condition-id>')
    .action(async () => {
      await queryMarkets({})
    })

  market
    .command('list')
    .description('Query markets with optional search, limit, and lifecycle filters.')
    .option('--search <query>', 'Search query')
    .option('--limit <n>', 'Maximum number of markets', parseIntegerOption('limit'))
    .option('--state <state>', 'Lifecycle state: Open, Closed, Resolved, or All', parseMarketState)
    .option('--sort <sort>', 'Sort dimension: Trending, Popular, or New', parseMarketSort)
    .option('--tag <tag...>', 'Category tag filter (repeatable)')
    .option('--creator <pubkey>', 'Creator Nostr pubkey filter')
    .option('--cursor <cursor>', 'Pagination cursor')
    .addHelpText('after', '\nExamples:\n  bitcaster-cli market list --state Open --sort Trending\n  bitcaster-cli --engine-url https://engine.example market list --tag sports')
    .action(async (options: MarketListOptions) => {
      await queryMarkets(options)
    })

  market
    .command('show <conditionId>')
    .description('Show one market by condition id.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli market show <condition-id>')
    .action(async (conditionId: string) => {
      await printDirectEngineResultOrDaemon(
        () => fetchMarketShowFromEngine(conditionId),
        () => callDaemon({ method: 'markets.show', params: { conditionId } }),
      )
    })

  market
    .command('create')
    .description('Create a market through the daemon using daemon-held Nostr auth.')
    .requiredOption('--condition-id <id>', 'Condition id')
    .requiredOption('--title <title>', 'Market title')
    .requiredOption('--description <description>', 'Market description')
    .requiredOption('--outcomes <a,b,c>', 'Comma-separated outcome names', parseOutcomeList)
    .option('--liquidity-sats <n>', 'Initial liquidity in sats', parseIntegerOption('liquidity sats'))
    .option('--tag <tag...>', 'Category tag (repeatable)')
    .option('--thumbnail <path>', 'Thumbnail file path on the daemon host')
    .option('--trust-engine-url', 'Trust the configured engine URL without prompting')
    .option('--dry-run', 'Validate and print the would-be market.create params without calling the daemon')
    .addHelpText('after', '\nExample:\n  bitcaster-cli --dry-run market create --condition-id cond --title "Question" --description "Details" --outcomes YES,NO')
    .action(async (options: MarketCreateOptions) => {
      await ensureTrustedAuthedEngineUrl(options.trustEngineUrl === true)
      const params: MarketCreateParams = {
        conditionId: options.conditionId,
        title: options.title,
        description: options.description,
        outcomes: options.outcomes,
      }
      if (options.liquiditySats !== undefined) params.liquiditySats = options.liquiditySats
      if (options.tag !== undefined && options.tag.length > 0) params.tags = options.tag
      if (options.thumbnail !== undefined) params.thumbnailPath = options.thumbnail
      if (isDryRun(options)) {
        printDryRun(params)
        return
      }
      await printDaemonResult(callDaemon({ method: 'market.create', params }))
    })

  market
    .command('close')
    .description('Close a market by submitting a signed kind-89 oracle attestation event.')
    .requiredOption('--condition-id <id>', 'Condition id')
    .requiredOption('--attestation <event-json|@file>', 'Inline JSON event or @file')
    .option('--trust-engine-url', 'Trust the configured engine URL without prompting')
    .option('--dry-run', 'Validate and print an unsigned close template without calling the daemon')
    .addHelpText('after', '\nExample:\n  bitcaster-cli --dry-run market close --condition-id cond --attestation @attestation.json')
    .action(async (options: MarketCloseOptions) => {
      await ensureTrustedAuthedEngineUrl(options.trustEngineUrl === true)
      const attestationEvent = await parseOracleAttestationOption(options.attestation)
      const params: MarketCloseParams = {
        conditionId: options.conditionId,
        attestationEvent,
      }
      if (isDryRun(options)) {
        printDryRun(marketCloseDryRunTemplate(params))
        return
      }
      await printDaemonResult(callDaemon({ method: 'market.close', params }))
    })
}

interface MarketListOptions {
  search?: string
  limit?: number
  state?: 'Open' | 'Closed' | 'Resolved' | 'All'
  sort?: string
  tag?: string[]
  creator?: string
  cursor?: string
}

interface MarketCreateOptions {
  conditionId: string
  title: string
  description: string
  outcomes: string[]
  liquiditySats?: number
  tag?: string[]
  thumbnail?: string
  trustEngineUrl?: boolean
  dryRun?: boolean
}

interface MarketCloseOptions {
  conditionId: string
  attestation: string
  trustEngineUrl?: boolean
  dryRun?: boolean
}

async function queryMarkets(options: MarketListOptions): Promise<void> {
  const params = marketListDaemonParams(options)
  await printDirectEngineResultOrDaemon(
    () => fetchMarketListFromEngine(options),
    () => callDaemon({ method: 'markets.query', params }),
  )
}

function marketListDaemonParams(options: MarketListOptions): QueryMarketsParams {
  const params: QueryMarketsParams = {}
  if (options.search !== undefined) params.search = options.search
  if (options.limit !== undefined) params.limit = options.limit
  if (options.state !== undefined) params.state = options.state
  if (options.cursor !== undefined) params.cursor = options.cursor
  if (options.creator !== undefined) params.creator = options.creator
  if (options.tag !== undefined && options.tag.length > 0) params.tag = options.tag[0]
  const sort = daemonMarketSort(options.sort)
  if (sort !== undefined) params.sort = sort
  return params
}

function daemonMarketSort(value: string | undefined): QueryMarketsParams['sort'] | undefined {
  if (value === undefined) return undefined
  if (isMarketSort(value)) return value
  throwUsage(`Invalid market sort: ${value}`)
}

function isMarketSort(value: string | undefined): value is NonNullable<QueryMarketsParams['sort']> {
  return value === 'Trending' || value === 'Popular' || value === 'New'
}

function registerWalletCommand(program: Command): void {
  const wallet = program
    .command('wallet')
    .description('Manage wallet balance, Cashu tokens, and wallet operations.')
    .addHelpText('after', '\nExamples:\n  bitcaster-cli wallet balance\n  bitcaster-cli wallet send 25 --mint <url>')

  wallet
    .command('balance')
    .description('Show available wallet balances.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli wallet balance')
    .action(async () => {
      await printDaemonResult(callDaemon({ method: 'wallet.balance' }))
    })

  wallet
    .command('receive <token>')
    .description('Import a Cashu token into the wallet.')
    .option('--condition-id <id>', 'Condition id for outcome-token imports')
    .option('--outcome-set <id>', 'Outcome set id for outcome-token imports')
    .addHelpText('after', '\nExamples:\n  bitcaster-cli wallet receive <cashu-token>\n  bitcaster-cli wallet receive <token> --condition-id cond --outcome-set YES')
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
    .option('--dry-run', 'Validate and print the would-be wallet.send params without calling the daemon')
    .addHelpText('after', '\nExample:\n  bitcaster-cli --dry-run wallet send 25 --mint https://mint.example')
    .action(async (amountSats: string, options: { mint?: string; operationId?: string; dryRun?: boolean }) => {
      const params: { amountSats: number; mintUrl?: string; operationId?: string } = {
        amountSats: parseIntegerArg(amountSats, 'amount sats'),
      }
      if (options.mint !== undefined) params.mintUrl = options.mint
      if (options.operationId !== undefined) params.operationId = options.operationId
      if (isDryRun(options)) {
        printDryRun(params)
        return
      }
      await printDaemonResult(callDaemon({ method: 'wallet.send', params }))
    })

  registerWalletSplitCommand(wallet, 'split')
  registerConsolidateCommand(wallet, 'consolidate')

  wallet
    .command('operations')
    .description('List prepared or recoverable wallet operations.')
    .option('--kind <kind>', 'Operation kind')
    .option('--state <state>', 'Operation state')
    .addHelpText('after', '\nExample:\n  bitcaster-cli wallet operations --kind wallet-send --state prepared')
    .action(async (options: { kind?: string; state?: string }) => {
      const params: { kind?: string; state?: string } = {}
      if (options.kind !== undefined) params.kind = options.kind
      if (options.state !== undefined) params.state = options.state
      await printDaemonResult(callDaemon({ method: 'wallet.operations', params }))
    })

  wallet
    .command('recover')
    .description('Resume or recover incomplete wallet operations.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli wallet recover')
    .action(async () => {
      await printDaemonResult(callDaemon({ method: 'wallet.recover' }))
    })

  wallet
    .command('seed-recover')
    .description('Emergency NUT-13/NUT-09 recovery using the daemon wallet seed.')
    .option('--unit <unit>', 'Mint unit', 'sat')
    .option(
      '--acknowledge-history-disclosure',
      'Acknowledge that recovery reveals deterministic wallet history to the mint',
    )
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli wallet seed-recover --acknowledge-history-disclosure',
    )
    .action(async (options: {
      unit: string
      acknowledgeHistoryDisclosure?: boolean
    }) => {
      if (options.acknowledgeHistoryDisclosure !== true) {
        throwUsage(
          'wallet seed-recover requires --acknowledge-history-disclosure',
        )
      }
      await printDaemonResult(runEmergencySeedRecovery(options.unit))
    })
}

async function runEmergencySeedRecovery(
  unit: string,
): Promise<DaemonResponse<DaemonEmergencySeedRecoveryResult>> {
  while (true) {
    const response = await callDaemon<DaemonEmergencySeedRecoveryResult>({
      method: 'wallet.seed-recover',
      params: {
        acknowledgeHistoryDisclosure: true,
        unit,
      },
    })
    if (!response.ok) return response
    const result = response.result
    if (result === undefined) {
      throwValidation('seed recovery returned no result')
    }
    if (result.state !== 'active') return response
    if (result.batchesProcessed < 1) {
      throwValidation('seed recovery made no durable progress')
    }
  }
}

function registerWalletSplitCommand(wallet: Command, name: string, hidden = false): void {
  wallet
    .command(`${name} <conditionId> <amountSats>`, { hidden })
    .description('Split regular ecash into a complete conditional outcome set.')
    .option('--mint <url>', 'Mint URL')
    .option('--operation-id <id>', 'Operation id')
    .option('--dry-run', 'Validate and print the would-be wallet.split params without calling the daemon')
    .addHelpText('after', '\nExample:\n  bitcaster-cli --dry-run wallet split <condition-id> 100 --mint https://mint.example')
    .action(async (conditionId: string, amountSats: string, options: { mint?: string; operationId?: string; dryRun?: boolean }) => {
      const params: {
        conditionId: string
        amountSats: number
        mintUrl?: string
        operationId?: string
      } = { conditionId, amountSats: parseIntegerArg(amountSats, 'amount sats') }
      if (options.mint !== undefined) params.mintUrl = options.mint
      if (options.operationId !== undefined) params.operationId = options.operationId
      if (isDryRun(options)) {
        printDryRun(params)
        return
      }
      await printDaemonResult(callDaemon({ method: 'wallet.splitCompleteSet', params }))
    })
}

function registerConsolidateCommand(parent: Command, name: string, hidden = false): void {
  parent
    .command(`${name} [marketId]`, { hidden })
    .description('Consolidate pending CTF market positions through bitcaster-daemon.')
    .option('--all', 'Sweep every market id found in wallet balance')
    .addOption(new Option(
      '--strategy <type>',
      'Consolidation strategy:\n' +
      '                       merge    - Merge singletons + collateral into the missing complement set\n' +
      '                       sweep    - Extract collateral from overlapping complement collections\n' +
      '                       reclaim  - Extract collateral from all mixed positions (default)',
    ).argParser(parseConsolidationStrategy).default('t3', 'reclaim'))
    .option('--dry-run', 'Validate and print the would-be consolidation params without calling the daemon')
    .addHelpText('after', '\nExamples:\n  bitcaster-cli wallet consolidate <market-id> --strategy merge\n  bitcaster-cli --dry-run wallet consolidate --all --strategy reclaim')
    .action(async (marketId: string | undefined, options: { all?: boolean; strategy: 't1' | 't2' | 't3'; dryRun?: boolean }) => {
      await handleConsolidate({
        all: options.all === true,
        marketId: marketId ?? '',
        type: options.strategy,
        dryRun: isDryRun(options),
      })
    })
}

async function handleConsolidate(parsed: ConsolidateArgs): Promise<void> {
  if (parsed.all && parsed.marketId) {
    throwUsage('wallet consolidate --all cannot be combined with a market id')
  }
  if (!parsed.all && !parsed.marketId) {
    throwUsage('Usage: bitcaster-cli wallet consolidate <market-id> [--strategy merge|sweep|reclaim]')
  }
  if (parsed.dryRun) {
    printDryRun(parsed.all
      ? { all: true, type: parsed.type }
      : { marketId: parsed.marketId, type: parsed.type })
    return
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
    .addHelpText('after', '\nExamples:\n  bitcaster-cli order submit --market cond-YES --outcome YES --side Buy --price 42 --amount 100\n  bitcaster-cli order book <market-id>')

  order
    .command('submit')
    .description('Submit a buy or sell order to the matching engine.')
    .option('--market <id>', 'Market id')
    .option('--outcome <id>', 'Outcome id')
    .option('--side <side>', 'Order side: buy or sell', parseSide)
    .option('--price <n>', 'Limit price', parseIntegerOption('price'))
    .option('--amount <sats>', 'Amount in sats', parseIntegerOption('amount sats'))
    .option('--tif <tif>', 'Time in force: GTC, FAK, or FOK', parseTimeInForce, 'GTC')
    .option('--token-side <side>', 'Token side: Outcome or Complement', parseTokenSide)
    .option('--no-preflight-split', 'Disable preflight complete-set split')
    .option('--dry-run', 'Validate and print the would-be order.submit params without calling the daemon')
    .addHelpText('after', '\nExample:\n  bitcaster-cli --dry-run order submit --market cond-YES --outcome YES --side Buy --price 42 --amount 100 --tif FAK')
    .action(async (options: OrderSubmitOptions, command: Command) => {
      const params = orderSubmitParams(options, command.args)
      if (isDryRun(options)) {
        printDryRun(params)
        return
      }
      await printDaemonResult(callDaemon({ method: 'order.submit', params }))
    })

  order
    .command('status <marketId> <orderId>')
    .description('Show one order by market id and order id.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli order status <market-id> <order-id>')
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
    .addHelpText('after', '\nExample:\n  bitcaster-cli order list --market <market-id> --status resting')
    .action(async (options: { market?: string; status?: string }) => {
      const params: { marketId?: string; status?: string } = {}
      if (options.market !== undefined) params.marketId = options.market
      if (options.status !== undefined) params.status = options.status
      await printDaemonResult(callDaemon({ method: 'order.list', params }))
    })

  order
    .command('cancel <marketId> <orderId>')
    .description('Cancel an open order.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli order cancel <market-id> <order-id>')
    .action(async (marketId: string, orderId: string) => {
      await printDaemonResult(
        callDaemon({ method: 'order.cancel', params: { marketId, orderId } }),
      )
    })

  order
    .command('book <marketId>')
    .description('Show the order book for one market.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli --engine-url https://engine.example order book <market-id>')
    .action(async (marketId: string) => {
      await printDirectEngineResultOrDaemon(
        () => fetchOrderBookFromEngine(marketId),
        () => callDaemon({ method: 'order.book', params: { marketId } }),
      )
    })
}

interface OrderSubmitOptions {
  market?: string
  outcome?: string
  side?: 'Buy' | 'Sell'
  price?: number
  amount?: number
  tif: 'FAK' | 'FOK' | 'GTC'
  tokenSide?: 'Outcome' | 'Complement'
  preflightSplit: boolean
  dryRun?: boolean
}

interface OrderSubmitParams {
  marketId: string
  outcomeId: string
  tokenSide: 'Outcome' | 'Complement'
  side: 'Buy' | 'Sell'
  price: number
  amountSats: number
  timeInForce: 'FAK' | 'FOK' | 'GTC'
  preflightSplit: boolean
}

function orderSubmitParams(options: OrderSubmitOptions, positionals: string[]): OrderSubmitParams {
  if (positionals.length > 0) {
    throwUsage(`Unexpected order submit argument: ${positionals[0]}`)
  }

  return {
    marketId: requiredArg(options.market, 'market'),
    outcomeId: requiredArg(options.outcome, 'outcome'),
    tokenSide: options.tokenSide ?? 'Outcome',
    side: requiredParsedOption(options.side, 'side'),
    price: requiredParsedOption(options.price, 'price'),
    amountSats: requiredParsedOption(options.amount, 'amount sats'),
    timeInForce: options.tif,
    preflightSplit: options.preflightSplit,
  }
}

function requiredParsedOption<T>(value: T | undefined, name: string): T {
  if (value !== undefined) return value
  throwUsage(`Missing ${name}`)
}

function registerTradeCommand(program: Command): void {
  const trade = program
    .command('trade')
    .description('Recover, list, and watch atomic swap trades.')
    .addHelpText('after', '\nExamples:\n  bitcaster-cli trade list --market <market-id>\n  bitcaster-cli trade watch <trade-id> --wait')

  trade
    .command('recover')
    .description('Resume or repair incomplete atomic swap trades.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli trade recover')
    .action(async () => {
      await printDaemonResult(callDaemon({ method: 'trade.recover' }))
    })

  trade
    .command('list')
    .description('List trades, optionally filtered by market, order, or protocol step.')
    .option('--market <market-id>', 'Market id')
    .option('--order <order-id>', 'Order id')
    .option('--step <step>', 'Protocol step')
    .addHelpText('after', '\nExample:\n  bitcaster-cli trade list --market <market-id> --order <order-id>')
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
    .addHelpText('after', '\nExamples:\n  bitcaster-cli trade watch <trade-id>\n  bitcaster-cli trade watch <trade-id> --wait --timeout-ms 60000')
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
    .addHelpText('after', '\nExamples:\n  bitcaster-cli daemon init\n  bitcaster-cli daemon status')

  daemon
    .command('status')
    .description('Show daemon health and runtime status.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli daemon status')
    .action(async () => {
      await printDaemonResult(callDaemon({ method: 'daemon.status' }))
    })

  daemon
    .command('config')
    .description('Update daemon engine and mint endpoint configuration.')
    .option('--engine-url <url>', 'Engine URL')
    .option('--mint-url <url>', 'Mint URL')
    .addHelpText('after', '\nExample:\n  bitcaster-cli daemon config --engine-url <url> --mint-url <url>')
    .action(async (options: { engineUrl?: string; mintUrl?: string }) => {
      const params = daemonConfigParams(options)
      const response = await callDaemon({ method: 'daemon.config', params })
      await printDaemonResult(Promise.resolve(response))
      await handleRestartRequired(response)
    })

  daemon
    .command('stop')
    .description('Stop the CLI-spawned daemon if it is running.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli daemon stop')
    .action(async () => {
      const result = await stopDaemon()
      process.stdout.write(`${result.message}\n`)
    })

  daemon
    .command('restart')
    .description('Restart the CLI-spawned daemon and wait for health.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli daemon restart')
    .action(async () => {
      await restartDaemon()
      process.stdout.write('daemon restarted\n')
    })

  daemon
    .command('logs')
    .description('Print recent daemon log lines.')
    .option('--lines <n>', 'Number of log lines to print', parseNonNegativeIntegerOption('lines'), 50)
    .addHelpText('after', '\nExample:\n  bitcaster-cli daemon logs --lines 100')
    .action(async (options: { lines: number }) => {
      await printDaemonLogs(options.lines)
    })

  daemon
    .command('init')
    .description('Initialize daemon profile, wallet seed, Nostr key, and endpoints.')
    .option('--wallet-seed-hex-file <path>', 'File containing wallet seed hex')
    .option('--nostr-secret-key-hex-file <path>', 'File containing Nostr secret key hex')
    .option('--engine-url <url>', 'Engine URL')
    .option('--mint-url <url>', 'Mint URL')
    .option('--force', 'Overwrite existing daemon profile')
    .addHelpText('after', '\nExample:\n  bitcaster-cli daemon init --engine-url <url> --mint-url <url>')
    .action(async (options: {
      walletSeedHexFile?: string
      nostrSecretKeyHexFile?: string
      engineUrl?: string
      mintUrl?: string
      force?: boolean
    }) => {
      const passthrough = ['init']
      pushOption(passthrough, '--wallet-seed-hex-file', options.walletSeedHexFile)
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
    .addHelpText('after', '\nExample:\n  bitcaster-cli config get engineUrl')
    .action((key?: string) => {
      printConfigValue(key)
    })

  config
    .command('set')
    .description('Set CLI config values and write through to the daemon when reachable.')
    .option('--engine-url <url>', 'Engine URL')
    .option('--mint-url <url>', 'Mint URL')
    .addHelpText('after', '\nExample:\n  bitcaster-cli config set --engine-url <url>')
    .action(async (options: { engineUrl?: string; mintUrl?: string }) => {
      await setCliConfig(options)
    })

  config
    .command('path')
    .description('Print the CLI config file path.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli config path')
    .action(() => {
      process.stdout.write(`${configFilePath()}\n`)
    })

  config
    .command('list')
    .description('List all config values as JSON.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli config list')
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
    const response = await callDaemonWithoutAutostart({ method: 'daemon.config', params })
    await printDaemonResult(Promise.resolve(response))
    await handleRestartRequired(response)
  } catch {
    process.stderr.write(
      `daemon not reachable; config.json updated. Run 'bitcaster daemon init' to initialize the daemon. Config written to ${configFilePath()}.\n`,
    )
    process.stdout.write(
      `${JSON.stringify({ ok: true, result: { config, daemonUpdated: false } }, null, 2)}\n`,
    )
  }
}

async function handleRestartRequired(response: unknown): Promise<void> {
  if (!daemonRestartRequired(response)) return
  if (await isCliSpawnedDaemonRunning()) {
    await restartDaemon()
    process.stderr.write('daemon config updated; daemon restarted\n')
    return
  }
  process.stderr.write('daemon config updated; restart bitcaster-daemon to apply changes\n')
}

function daemonRestartRequired(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  const daemonResponse = response as { ok?: unknown; result?: unknown }
  if (daemonResponse.ok !== true || !daemonResponse.result || typeof daemonResponse.result !== 'object') {
    return false
  }
  return (daemonResponse.result as { restartRequired?: unknown }).restartRequired === true
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
  dryRun: boolean
}

interface WalletBalanceResult {
  outcomePositions?: Array<{
    conditionId?: string
    outcomeSetId?: string
  }>
}

function parseConsolidationStrategy(value: string): 't1' | 't2' | 't3' {
  const lower = value.toLowerCase()
  switch (lower) {
    case 'merge':
      return 't1'
    case 'sweep':
      return 't2'
    case 'reclaim':
      return 't3'
  }
  throwUsage(`Invalid consolidation strategy: ${value}`)
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
  return step === 'confirmed' || step === 'refunded' || step === 'Failed'
}

async function printDirectEngineResultOrDaemon<T>(
  engineCall: () => Promise<unknown>,
  daemonCall: () => Promise<T>,
): Promise<void> {
  if (globalEngineUrl === undefined) {
    await printDaemonResult(daemonCall())
    return
  }
  try {
    const result = await engineCall()
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (err) {
    if (isEngineHttpError(err)) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: engineHttpErrorMessage(err) }, null, 2)}\n`)
      process.exitCode = 1
      return
    }
    if (!isNetworkFailure(err) && !isTimeoutFailure(err)) throw err
    process.stderr.write(`Warning: engine read failed at ${globalEngineUrl}: ${errorMessage(err)}; falling back to daemon\n`)
    await printDaemonResult(daemonCall())
  }
}

async function fetchMarketListFromEngine(params: {
  search?: string
  limit?: number
  state?: 'Open' | 'Closed' | 'Resolved' | 'All'
  sort?: string
  tag?: string[]
  creator?: string
  cursor?: string
}): Promise<unknown> {
  return directEngineClient().queryMarkets({
    search: params.search,
    pageSize: params.limit,
    state: params.state,
    sort: daemonMarketSort(params.sort),
    tag: params.tag?.[0],
    creatorPubkey: params.creator,
    cursor: params.cursor,
  })
}

async function fetchMarketShowFromEngine(conditionId: string): Promise<unknown> {
  return (await directEngineClient().getMarket(conditionId)) ?? { ok: true, result: null }
}

async function fetchOrderBookFromEngine(marketId: string): Promise<unknown> {
  return directEngineClient().getOrderBook(marketId)
}

function directEngineClient(): BitcasterEngineClient {
  if (globalEngineUrl === undefined) throw new Error('engine URL is not configured')
  return new BitcasterEngineClient({
    baseUrl: globalEngineUrl,
    fetchImpl: (input, init) => fetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(DIRECT_ENGINE_READ_TIMEOUT_MS),
    }),
  })
}

function isEngineHttpError(value: unknown): value is EngineClientError {
  return value instanceof EngineClientError || (
    value instanceof Error && value.name === 'EngineClientError'
  )
}

function engineHttpErrorMessage(error: EngineClientError): string {
  return `engine returned HTTP ${error.status}${error.detail.length > 0 ? `: ${error.detail}` : ''}`
}

function isTimeoutFailure(value: unknown): boolean {
  return value instanceof Error && (value.name === 'TimeoutError' || value.name === 'AbortError')
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

async function printDaemonResult<T>(promise: Promise<T>): Promise<void> {
  const result = await promise
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (isDaemonFailure(result)) {
    process.exitCode = 1
  }
}

function printDaemonNotReachable(error: DaemonNotReachableError): void {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, hint: error.hint })}\n`)
  process.exitCode = 1
}

async function printDaemonLogs(lines: number): Promise<void> {
  const path = daemonLogPath()
  if (!existsSync(path)) {
    process.stdout.write(`no daemon log file found at ${path}\n`)
    return
  }
  const text = await readFile(path, 'utf8')
  const allLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const selected = lines === 0 ? [] : allLines.slice(-lines)
  if (selected.length > 0) process.stdout.write(`${selected.join('\n')}\n`)
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
  if (value === 'Buy') return 'Buy'
  if (value === 'Sell') return 'Sell'
  throwUsage(`Invalid side: ${value}`)
}

function parseTokenSide(value: string): 'Outcome' | 'Complement' {
  if (value === 'Outcome') return 'Outcome'
  if (value === 'Complement') return 'Complement'
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

function parseMarketSort(value: string): string {
  if (isMarketSort(value)) {
    return value
  }
  throwUsage(`Invalid market sort: ${value}`)
}

function parseOutcomeList(value: string): string[] {
  const outcomes = value
    .split(',')
    .map((outcome) => outcome.trim())
    .filter((outcome) => outcome.length > 0)
  if (outcomes.length < 2) {
    throwUsage('market create requires at least two comma-separated outcomes')
  }
  return outcomes
}

async function ensureTrustedAuthedEngineUrl(trustEngineUrl: boolean): Promise<void> {
  if (globalEngineUrl === undefined) return
  validateAuthedEngineUrl(globalEngineUrl)

  const config = readConfig()
  const normalizedEngineUrl = normalizeTrustedEngineUrl(globalEngineUrl)
  if (config.trustedEngineUrls.includes(normalizedEngineUrl)) return
  if (!trustEngineUrl) {
    const confirmed = await confirmEngineUrlTrust(globalEngineUrl)
    if (!confirmed) {
      throwValidation(`Engine URL was not trusted: ${globalEngineUrl}`)
    }
  }
  writeConfig({
    ...config,
    trustedEngineUrls: Array.from(new Set([...config.trustedEngineUrls, normalizedEngineUrl])),
  })
}

function normalizeTrustedEngineUrl(value: string): string {
  return new URL(value).toString()
}

function validateAuthedEngineUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throwValidation(`Invalid engine URL: ${value}`)
  }
  const validation = validateMarketCreateEngineUrl(
    url.toString(),
    process.env.BITCASTER_ALLOW_INSECURE_ENGINE === '1',
  )
  if (validation.ok) return
  throwValidation(
    `Refusing insecure engine URL for market create: ${value}. Use https://, or set BITCASTER_ALLOW_INSECURE_ENGINE=1 for localhost only.`,
  )
}

async function confirmEngineUrlTrust(engineUrl: string): Promise<boolean> {
  process.stderr.write(`About to use engine URL for authenticated market create: ${engineUrl}\n`)
  if (!process.stdin.isTTY) {
    throwValidation('Refusing to trust a new engine URL without --trust-engine-url in non-interactive mode')
  }
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question('Trust this engine URL? Type yes to continue: ')
    return answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

async function parseOracleAttestationOption(value: string): Promise<MarketCloseParams['attestationEvent']> {
  const fromFile = value.startsWith('@')
  const raw = fromFile ? await readAttestationFile(value.slice(1)) : value
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    if (fromFile) {
      throwValidation(`Oracle attestation file is not valid JSON (first 80 chars: ${firstChars(raw, 80)})`)
    }
    throwValidation('Oracle attestation must be valid JSON')
  }
  if (!isKind89NostrEvent(parsed)) {
    throwValidation('Oracle attestation must be a kind-89 Nostr event')
  }
  return parsed
}

async function readAttestationFile(path: string): Promise<string> {
  if (!path) throwValidation('Missing attestation file path after @')
  if (pathContainsParentTraversal(path)) {
    throwValidation('Attestation @file path must not contain .. segments')
  }
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    throwValidation(`Unable to read attestation file: ${errorMessage(err)}`)
  }
}

function pathContainsParentTraversal(path: string): boolean {
  const normalized = normalize(path)
  const candidates = [path, normalized]
  return candidates.some((candidate) =>
    candidate.split(/[\\/]/).some((segment) => segment === '..'),
  )
}

function isDryRun(options: { dryRun?: boolean }): boolean {
  return options.dryRun === true || globalDryRun
}

function printDryRun(value: unknown): void {
  process.stdout.write(`${JSON.stringify(redactDryRun(value), null, 2)}\n`)
}

function redactDryRun(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDryRun)
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (dryRunForbiddenKey(key)) continue
    result[key] = redactDryRun(child)
  }
  return result
}

function dryRunForbiddenKey(key: string): boolean {
  return dryRunRedactedKeys.has(key)
}

function marketCloseDryRunTemplate(params: MarketCloseParams): unknown {
  const event = params.attestationEvent as unknown as Record<string, unknown>
  return {
    conditionId: params.conditionId,
    attestationTemplate: {
      kind: event.kind,
      createdAt: event.createdAt,
      tags: event.tags,
      contentHash: sha256Hex(typeof event.content === 'string' ? event.content : ''),
    },
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function firstChars(value: string, max: number): string {
  return value.slice(0, max).replace(/[\r\n\t]+/g, ' ')
}

function commanderExitCode(error: CommanderError): number {
  if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
    return 0
  }
  return error.code.startsWith('commander.') ? 2 : error.exitCode
}

function throwValidation(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(3)
}

function throwUsage(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(2)
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
