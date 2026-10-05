#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync, readFileSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { normalize } from 'node:path'
import { performance } from 'node:perf_hooks'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  BitcasterEngineClient,
  ASSET_MONITORING_ASSETS_MAX,
  decodeCtfRangeOrderFeeFacts,
  EngineClientError,
  isKind89NostrEvent,
  isLoopbackHttpUrl,
  parseSatsToMsat,
  normalizeMarketCreationInput,
  normalizeEndpointUrl,
  assertOracleExplanationText,
  ORACLE_EXPLANATION_UTF8_BYTES_MAX,
  readPublicMintMetadata,
  validateMarketCreateEngineUrl,
  MAX_MARKET_CREATION_MATURITY_EPOCH,
  type MarketCreationInput,
  type SupportedMarketCreationOutcomeType,
  type PriceHistoryTimeframe,
  type MarketSnapshotReadOptions,
  type PreviewFokOrderCapacityRequest,
  type PreviewFokOrderRequest,
  type OrderStatusResponse,
  type CtfRangeOrderFeeFacts,
  type AssetMonitoringTimeframe,
} from '@bitcaster-market/client-sdk'
import {
  isWalletPaymentQuote,
  type WalletPaymentQuote,
} from '@bitcaster-market/client-sdk/walletPaymentQuote'
import { Command, CommanderError, Option } from 'commander'
import { decodeOrderQuotePaymentBounds } from '@bitcaster-market/client-sdk/tradeTicket'
import { configureDataDir, dataDir } from '@bitcaster-market/daemon/dataDir'
import {
  callDaemon,
  daemonLogPath,
  DaemonNotReachableError,
  isNetworkFailure,
  restartDaemon,
  stopDaemon,
  watchDaemonToOutput,
} from './rpc.ts'
import { configFilePath, readConfig, updateConfig } from './config.ts'
import { registerSignerCommands } from './signerCommands.ts'
import { registerLikedMarketCommands } from './likedMarketCommands.ts'
import { readLocalNativeBookmarks } from '@bitcaster-market/daemon/nativeBookmarks'
import {
  DAEMON_ACTIVITY_PAGE_SIZE_MAX,
  DAEMON_MARKET_WATCH_CONDITIONS_MAX,
  validateDaemonWatchCommand,
  validateWalletActivityParams,
} from '@bitcaster-market/daemon/protocol'
import { applySavedSettings, registerSettingsCommands } from './settingsCommands.ts'
import type {
  DaemonCommand,
  DaemonResponse,
  MarketCloseParams,
  MarketCreateParams,
  MarketCreateNativeParams,
  MarketCreationResumeParams,
  MarketFundParams,
  OrderDraftParams,
  OrderFeeConsent,
  QueryMarketsParams,
  ScorePurchaseConsent,
  SubmitOrderParams,
  WalletConsolidationResult,
  WalletRemovePreview,
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

const DIRECT_ENGINE_READ_TIMEOUT_MS = 5_000
const DEFAULT_ORDER_WAIT_TIMEOUT_MS = 30_000
const MAX_ORDER_WAIT_TIMEOUT_MS = 300_000
const ORDER_WAIT_POLL_INTERVAL_MS = 500
const MAX_CASHU_TOKEN_FILE_BYTES = 4 * 1_024 * 1_024
const MAX_WALLET_SEED_FILE_BYTES = 256
const MAX_FEE_CONSENT_FILE_BYTES = 8 * 1_024
const MAX_WALLET_PAYMENT_CONSENT_FILE_BYTES = 16 * 1_024
const MAX_LIGHTNING_INVOICE_FILE_BYTES = 10_000
const TOKEN_FILE_READ_CHUNK_BYTES = 64 * 1_024
const NATIVE_REQUEST_ID_BYTES_MAX = 256
const NATIVE_REQUEST_CURSOR_BYTES_MAX = 4 * 1_024
const NATIVE_REQUEST_PAGE_SIZE_MAX = 256

await main()

async function main(): Promise<void> {
  const program = new Command()
  program
    .name('bitcaster-cli')
    .description('Command-line client for bitCaster markets.')
    .version(packageJson.version ?? '0.0.0', '-V, --version')
    .option('--datadir <path>', 'Use one directory for config, wallet state, and daemon files')
    .option('--dry-run', 'Validate and print the intended operation without executing it')
    .option('--json', 'Print JSON output (currently the default)')
    .addHelpText('after', '\nLong-running wallet operations are delegated to bitcaster-daemon.')
    .exitOverride()
    .configureOutput({
      writeOut: (str) => process.stdout.write(str),
      writeErr: (str) => process.stdout.write(str),
      outputError: (str, write) => write(str),
    })

  program.hook('preAction', (_thisCommand, actionCommand) => {
    const opts = program.opts<{
      datadir?: string
      dryRun?: boolean
      json?: boolean
    }>()
    configureDataDir(opts.datadir)
    const config = readConfig(commandAllowsMissingConfig(actionCommand))
    globalEngineUrl = config.engineUrl
    globalMintUrl = config.mintUrl
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

function commandAllowsMissingConfig(command: Command): boolean {
  const names: string[] = []
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    names.unshift(current.name())
  }
  const path = names.join(' ')
  return (
    path === 'completion' ||
    path === 'config path' ||
    path === 'config set' ||
    path === 'market comments' ||
    path === 'market history' ||
    path === 'market attestation' ||
    path === 'market creator' ||
    path === 'market funding' ||
    path === 'mint info' ||
    path === 'mint list' ||
    path === 'mint add' ||
    path === 'mint select' ||
    path === 'mint remove' ||
    path === 'relay list' ||
    path === 'relay add' ||
    path === 'relay remove' ||
    path === 'order preview' ||
    path === 'order capacity' ||
    path === 'daemon init' ||
    path === 'daemon config' ||
    path === 'daemon stop'
  )
}

function registerCommands(program: Command): void {
  program
    .command('health')
    .description('Check daemon RPC health.')
    .action(async () => {
      await printDaemonResult(callDaemon({ method: 'health' }))
    })

  registerLikedMarketCommands(registerMarketCommand(program), {
    isDryRun: () => globalDryRun,
    engineUrl: () => globalEngineUrl,
  })
  registerSettingsCommands(program, registerMintCommand(program))
  registerWalletCommand(program)
  registerScoreCommand(program)
  registerOrderCommand(program)
  registerDaemonCommand(program)
  registerConfigCommand(program)
  registerSignerCommands(program, { isDryRun: () => globalDryRun })

  program
    .command('completion')
    .description('Shell completion (not yet implemented).')
    .addHelpText('after', '\nExample:\n  bitcaster-cli completion')
    .action(() => {
      process.stdout.write('Shell completion not yet implemented\n')
    })
}

function registerMintCommand(program: Command): Command {
  const mint = program.command('mint').description('Inspect mint metadata and manage saved mints.')
  mint
    .command('info [url]')
    .description('Read public mint capabilities, keysets, fees, and keys.')
    .addHelpText(
      'after',
      '\nPass a mint URL to read it without config. Otherwise, the configured mint URL is used.\nExample:\n  bitcaster-cli mint info https://mint.example',
    )
    .action(async (url?: string) => {
      const configuredMintUrl = url ?? globalMintUrl
      if (configuredMintUrl === undefined) {
        throwUsage(
          'mint info requires a mint URL. Pass one or run bitcaster-cli config set --mint-url <url>.',
        )
      }
      const mintUrl = validatePublicMintUrl(configuredMintUrl)
      const metadata = await readPublicMintMetadata(mintUrl)
      process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`)
    })
  return mint
}

function validatePublicMintUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throwValidation(`Invalid mint URL: ${value}`)
  }
  if (url.protocol !== 'https:' && !isLoopbackHttpUrl(value)) {
    throwValidation('Public mint reads require an https or loopback http URL.')
  }
  return value.replace(/\/+$/, '')
}

function registerMarketCommand(program: Command): Command {
  const market = program
    .command('market')
    .description('List markets and inspect market details.')
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli market list --search weather --limit 5\n  bitcaster-cli market show <condition-id>\n  bitcaster-cli market funding <condition-id>\n  bitcaster-cli market funding-quote <condition-id> --amount-msat 8000\n  bitcaster-cli market fund begin <condition-id> --amount-msat 8000 --max-wallet-debit-msat 8002',
    )
    .action(async () => {
      await queryMarkets({})
    })

  market
    .command('watch [conditionIds...]')
    .description('Watch up to 200 explicit condition IDs or saved likes as bounded JSON lines.')
    .option('--liked', 'Capture saved likes at watch start; restart after bookmark edits')
    .option('--dry-run', 'Validate and print the watch request without daemon I/O')
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli market watch <condition-id> <condition-id>\n  bitcaster-cli market watch --liked\n\nSaved likes are captured at watch start. Restart the watch after bookmark edits. More than 200 likes are refused, never truncated.',
    )
    .action(async (conditionIds: string[], options: { liked?: boolean; dryRun?: boolean }) => {
      if (options.liked && conditionIds.length > 0)
        throwUsage('Specify --liked or explicit condition IDs, not both.')
      if (!options.liked && conditionIds.length === 0)
        throwUsage('Specify --liked or at least one explicit condition ID.')
      const command = validateDaemonWatchCommand({
        method: 'market.watch',
        params: options.liked ? { liked: true } : { conditionIds },
      })
      if (isDryRun(options)) {
        printDryRun(command)
        return
      }
      if (options.liked) {
        const saved = await readLocalNativeBookmarks()
        if (saved.length > DAEMON_MARKET_WATCH_CONDITIONS_MAX)
          throw new Error(
            'Liked market watch supports at most 200 saved condition IDs. The saved set is unchanged.',
          )
        if (saved.length > 0)
          validateDaemonWatchCommand({ method: 'market.watch', params: { conditionIds: saved } })
      }
      const controller = new AbortController()
      const cancel = () => controller.abort()
      process.once('SIGINT', cancel)
      process.once('SIGTERM', cancel)
      try {
        const result = await watchDaemonToOutput(command, output, {
          signal: controller.signal,
        })
        switch (result) {
          case 'complete':
            break
          case 'error':
            process.exitCode = 1
            break
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error
      } finally {
        process.removeListener('SIGINT', cancel)
        process.removeListener('SIGTERM', cancel)
      }
    })

  market
    .command('list')
    .description('Query markets with optional search, limit, and lifecycle filters.')
    .option('--search <query>', 'Search query')
    .option('--limit <n>', 'Maximum number of markets', parseIntegerOption('limit'))
    .option('--state <state>', 'Lifecycle state: Open, Closed, or All', parseMarketState)
    .option('--sort <sort>', 'Sort dimension: Trending, Popular, or New', parseMarketSort)
    .option('--tag <tag...>', 'Category tag filter (repeatable)')
    .option('--creator <pubkey>', 'Creator Nostr pubkey filter')
    .option('--cursor <cursor>', 'Pagination cursor')
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli market list --state Open --sort Trending\n  bitcaster-cli market list --tag sports',
    )
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
    .command('comments <conditionId>')
    .description('Read public comments for one market by condition id.')
    .option(
      '--minimum-event-order <eventOrder>',
      'Opaque source position required for the snapshot',
    )
    .option('--refresh', 'Capture the current source head before reading the snapshot')
    .addHelpText('after', '\nExample:\n  bitcaster-cli market comments <condition-id>')
    .action(async (conditionId: string, options: MarketSnapshotReadOptions) => {
      if (globalEngineUrl === undefined) {
        throwUsage(
          'market comments requires a configured engine URL. Run bitcaster-cli config set --engine-url <url>.',
        )
      }
      const comments = await directEngineClient().getMarketComments(conditionId, options)
      process.stdout.write(`${JSON.stringify(comments, null, 2)}\n`)
    })

  market
    .command('history <conditionId>')
    .description('Read public price history for one market.')
    .option(
      '--minimum-event-order <eventOrder>',
      'Opaque source position required for the snapshot',
    )
    .option('--refresh', 'Capture the current source head before reading the snapshot')
    .option(
      '--timeframe <timeframe>',
      'History window: 1h, 24h, 7d, 30d, or all',
      parsePriceHistoryTimeframe,
    )
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli market history <condition-id> --timeframe 30d',
    )
    .action(
      async (
        conditionId: string,
        options: MarketSnapshotReadOptions & { timeframe?: PriceHistoryTimeframe },
      ) => {
        await printPublicEngineResult(() =>
          directEngineClient().getMarketPriceHistory(
            conditionId,
            options.timeframe ?? '7d',
            options,
          ),
        )
      },
    )

  market
    .command('attestation <conditionId>')
    .description('Read the public engine attestation for one condition.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli market attestation <condition-id>')
    .action(async (conditionId: string) => {
      await printPublicEngineResult(() => directEngineClient().getConditionAttestation(conditionId))
    })

  market
    .command('creator <pubkey>')
    .description('Read the public market and volume rollup for one creator pubkey.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli market creator <pubkey-hex>')
    .action(async (pubkey: string) => {
      await printPublicEngineResult(() => directEngineClient().getCreatorMarkets(pubkey))
    })

  market
    .command('funding <conditionId>')
    .description('Read public confirmed funding total and revision for one market.')
    .addHelpText(
      'after',
      '\nThis public view does not report whether funding has activated in the matching strategy.',
    )
    .action(async (conditionId: string) => {
      await printPublicEngineResult(
        () => directEngineClient().getMarket(conditionId),
        (marketData) => marketFundingPublicView(marketData, conditionId),
      )
    })

  market
    .command('funding-head <conditionId>')
    .description('Read the local native funding sequence head for one market.')
    .action(async (conditionId: string) => {
      await printContextualFundingDaemonResult(
        callDaemon<{ transferId: string; revision: number } | null>({
          method: 'market.funding.head',
          params: { conditionId },
        }),
        (head) => ({ conditionId, head: head ?? null }),
      )
    })

  market
    .command('funding-quote <conditionId>')
    .description('Preview market funding costs without reserving proofs or sending funds.')
    .requiredOption(
      '--amount-msat <msat>',
      'Requested gross funding amount in msat',
      parseSafeIntegerOption('amount msat'),
    )
    .action(async (conditionId: string, options: MarketFundingQuoteOptions) => {
      const response = await callDaemon<MarketFundingQuote>({
        method: 'market.funding.quote',
        params: { conditionId, requestedAmountMsat: options.amountMsat },
      })
      if (!response.ok) {
        await printDaemonResult(Promise.resolve(response))
        return
      }
      if (!isMarketFundingQuote(response.result)) {
        printFundingFailure('daemon returned an invalid funding quote')
        return
      }
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            result: {
              conditionId,
              requestedAmountMsat: options.amountMsat,
              quote: response.result,
            },
          },
          null,
          2,
        )}\n`,
      )
    })

  const fund = market.command('fund').description('Make one explicit market funding payment.')
  fund
    .command('begin <conditionId>')
    .description('Begin a new funding payment with an explicit wallet-debit limit.')
    .requiredOption(
      '--amount-msat <msat>',
      'Requested gross funding amount in msat',
      parseSafeIntegerOption('amount msat'),
    )
    .requiredOption(
      '--max-wallet-debit-msat <msat>',
      'Maximum total wallet debit accepted for this new payment',
      parseSafeIntegerOption('max wallet debit msat'),
    )
    .addHelpText(
      'after',
      '\nIf the result is uncertain, use the reported attempt id with `market fund resume` before starting another payment.',
    )
    .action(async (conditionId: string, options: MarketFundingBeginOptions) => {
      await beginMarketFunding(conditionId, options)
    })

  fund
    .command('resume <conditionId> <transferId>')
    .description('Resume the exact persisted funding transfer without creating a new payment.')
    .action(async (conditionId: string, transferId: string) => {
      await resumeMarketFunding(conditionId, transferId)
    })

  market
    .command('create')
    .description('Create a market through the daemon using daemon-held Nostr auth.')
    .option('--condition-id <id>', 'Register an existing mint condition on the engine')
    .option('--creation-id <id>', 'Stable caller-retained ID for a complete native creation')
    .requiredOption('--title <title>', 'Market title')
    .requiredOption('--description <description>', 'Market description')
    .requiredOption('--outcomes <a,b,c>', 'Comma-separated outcome names', parseOutcomeList)
    .option('--tag <tag...>', 'Category tag (repeatable)')
    .option(
      '--outcome-type <type>',
      'Native oracle type: yesno or categorical',
      parseMarketCreationOutcomeType,
    )
    .option(
      '--outcome-color <name=#RRGGBB>',
      'Categorical outcome color (repeatable)',
      collectRepeatedOption,
    )
    .option(
      '--maturity-epoch <epoch>',
      'Native oracle maturity as Unix seconds',
      parseMarketMaturityEpoch,
    )
    .option('--event-id <id>', 'Native oracle event ID (defaults to --creation-id)')
    .option(
      '--relay <url>',
      'Nostr relay URL for native oracle publication (repeatable)',
      collectRepeatedOption,
    )
    .option(
      '--max-wallet-debit-msat <msat>',
      'Maximum wallet debit for a nonzero registration fee',
      parseSafeNonNegativeIntegerOption('max wallet debit msat'),
    )
    .option('--thumbnail <path>', 'Thumbnail file path on the daemon host')
    .option('--trust-engine-url', 'Trust the configured engine URL without prompting')
    .option(
      '--dry-run',
      'Validate and print the would-be market creation params without calling the daemon',
    )
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli market create --condition-id <condition-id> --title "Question" --description "Details" --outcomes YES,NO\n  bitcaster-cli --dry-run market create --creation-id create-001 --title "Question" --description "Details" --outcomes Yes,No --maturity-epoch 1893456000 --relay wss://relay.example',
    )
    .action(async (options: MarketCreateOptions) => {
      if (options.conditionId !== undefined && options.creationId !== undefined) {
        throwUsage('Specify either --condition-id or --creation-id, not both.')
      }
      if (options.creationId !== undefined) {
        const creationId = requireNonEmptyCliValue(options.creationId, 'creation id')
        if (options.relay === undefined || options.relay.length === 0) {
          throwUsage('Native market creation requires at least one --relay URL.')
        }
        if (options.maturityEpoch === undefined) {
          throwUsage('Native market creation requires --maturity-epoch.')
        }
        const market = nativeMarketCreationInput(options)
        const params: MarketCreateNativeParams = {
          creationId,
          eventId: requireNonEmptyCliValue(options.eventId ?? creationId, 'event id'),
          market,
          relayUrls: [...options.relay],
          ...(options.thumbnail === undefined ? {} : { thumbnailPath: options.thumbnail }),
          ...(options.maxWalletDebitMsat === undefined
            ? {}
            : { maxWalletDebitMsat: options.maxWalletDebitMsat }),
        }
        if (isDryRun(options)) {
          printDryRun(params)
          return
        }
        await ensureTrustedAuthedEngineUrl(options.trustEngineUrl === true)
        await printDaemonResult(callDaemon({ method: 'market.create-native', params }))
        return
      }
      if (options.conditionId === undefined) {
        throwUsage(
          'Specify either --condition-id for existing-condition creation or --creation-id for native creation.',
        )
      }
      if (
        options.outcomeType !== undefined ||
        options.outcomeColor !== undefined ||
        options.maturityEpoch !== undefined ||
        options.eventId !== undefined ||
        options.relay !== undefined ||
        options.maxWalletDebitMsat !== undefined
      ) {
        throwUsage('Native creation options require --creation-id.')
      }

      // Keep the existing condition-ID path and its trust/dry-run behavior unchanged.
      await ensureTrustedAuthedEngineUrl(options.trustEngineUrl === true)
      const params: MarketCreateParams = {
        conditionId: options.conditionId,
        title: options.title,
        description: options.description,
        outcomes: options.outcomes,
      }
      if (options.tag !== undefined && options.tag.length > 0) params.tags = options.tag
      if (options.thumbnail !== undefined) params.thumbnailPath = options.thumbnail
      if (isDryRun(options)) {
        printDryRun(params)
        return
      }
      await printDaemonResult(callDaemon({ method: 'market.create', params }))
    })

  market
    .command('creation-resume <creationId>')
    .description('Resume the exact native market creation saved in this daemon profile.')
    .option(
      '--max-wallet-debit-msat <msat>',
      'Maximum wallet debit for a nonzero registration fee',
      parseSafeNonNegativeIntegerOption('max wallet debit msat'),
    )
    .option(
      '--thumbnail <path>',
      'Use the original thumbnail file; omit to reuse the saved thumbnail',
    )
    .option('--dry-run', 'Print the would-be resume params without calling the daemon')
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli --dry-run market creation-resume create-001 --max-wallet-debit-msat 1000000',
    )
    .action(async (creationId: string, options: MarketCreationResumeOptions) => {
      const params: MarketCreationResumeParams = {
        creationId: requireNonEmptyCliValue(creationId, 'creation id'),
        ...(options.maxWalletDebitMsat === undefined
          ? {}
          : { maxWalletDebitMsat: options.maxWalletDebitMsat }),
        ...(options.thumbnail === undefined ? {} : { thumbnailPath: options.thumbnail }),
      }
      if (isDryRun(options)) {
        printDryRun(params)
        return
      }
      await printDaemonResult(callDaemon({ method: 'market.creation-resume', params }))
    })

  market
    .command('creation-status <creationId>')
    .description('Read public progress for a native market creation in this daemon profile.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli market creation-status create-001')
    .action(async (creationId: string) => {
      await printDaemonResult(
        callDaemon({
          method: 'market.creation-status',
          params: { creationId: requireNonEmptyCliValue(creationId, 'creation id') },
        }),
      )
    })

  market
    .command('creation-quote')
    .description('Preview native creation fee and preparation debit without reserving proofs.')
    .requiredOption('--outcomes <a,b,c>', 'Comma-separated market outcome names', parseOutcomeList)
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli market creation-quote --outcomes Alpha,Beta,Gamma',
    )
    .action(async (options: MarketCreationQuoteOptions) => {
      await printDaemonResult(
        callDaemon({ method: 'market.creation-quote', params: { outcomes: options.outcomes } }),
      )
    })

  market
    .command('resolution-status <conditionId>')
    .description('Show saved native oracle resolution and independent delivery progress.')
    .action(async (conditionId: string) => {
      await printDaemonResult(
        callDaemon({ method: 'market.resolution-status', params: { conditionId } }),
      )
    })

  market
    .command('close')
    .description('Close a market with a supplied attestation or a native oracle outcome.')
    .requiredOption('--condition-id <id>', 'Condition id')
    .option('--attestation <event-json|@file>', 'Inline JSON event or @file')
    .option('--outcome <label>', 'Sign an outcome for a market created by this native profile')
    .option('--explanation <text|@file>', 'Optional plain-text explanation for a native outcome')
    .option('--retry', 'Retry the exact saved native oracle publication without signing')
    .option('--trust-engine-url', 'Trust the configured engine URL without prompting')
    .option('--dry-run', 'Validate and print an unsigned close template without calling the daemon')
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli --dry-run market close --condition-id cond --attestation @attestation.json',
    )
    .action(async (options: MarketCloseOptions) => {
      if (
        [
          options.attestation !== undefined,
          options.outcome !== undefined,
          options.retry === true,
        ].filter(Boolean).length !== 1
      ) {
        throwUsage('Specify exactly one of --attestation, --outcome, or --retry.')
      }
      if (options.explanation !== undefined && options.outcome === undefined)
        throwUsage('--explanation requires --outcome.')
      await ensureTrustedAuthedEngineUrl(options.trustEngineUrl === true)
      if (options.retry === true) {
        const params = { conditionId: options.conditionId }
        if (isDryRun(options)) {
          printDryRun(params)
          return
        }
        await printDaemonResult(callDaemon({ method: 'market.attestation-retry', params }))
        return
      }
      if (options.outcome !== undefined) {
        if (options.outcome.trim().length === 0) throwValidation('Outcome must not be empty.')
        const params = {
          conditionId: options.conditionId,
          outcome: options.outcome,
          ...(options.explanation === undefined
            ? {}
            : { explanation: await readOracleExplanationOption(options.explanation) }),
        }
        if (isDryRun(options)) {
          printDryRun(params)
          return
        }
        await printDaemonResult(callDaemon({ method: 'market.attest', params }))
        return
      }
      if (options.attestation === undefined) throwUsage('An attestation is required.')
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
  return market
}

interface MarketListOptions {
  search?: string
  limit?: number
  state?: QueryMarketsParams['state']
  sort?: string
  tag?: string[]
  creator?: string
  cursor?: string
}

interface MarketCreateOptions {
  conditionId?: string
  creationId?: string
  title: string
  description: string
  outcomes: string[]
  tag?: string[]
  outcomeType?: SupportedMarketCreationOutcomeType
  outcomeColor?: string[]
  maturityEpoch?: number
  eventId?: string
  relay?: string[]
  maxWalletDebitMsat?: number
  thumbnail?: string
  trustEngineUrl?: boolean
  dryRun?: boolean
}

interface MarketCreationResumeOptions {
  maxWalletDebitMsat?: number
  thumbnail?: string
  dryRun?: boolean
}

interface MarketCreationQuoteOptions {
  outcomes: string[]
}

interface MarketCloseOptions {
  conditionId: string
  attestation?: string
  outcome?: string
  explanation?: string
  retry?: boolean
  trustEngineUrl?: boolean
  dryRun?: boolean
}

interface MarketFundingQuoteOptions {
  amountMsat: number
}

interface MarketFundingBeginOptions {
  amountMsat: number
  maxWalletDebitMsat: number
}

interface MarketFundingQuote {
  grossFundingMsat: number
  sendPreparationFeeMsat: number
  estimatedRecipientReceiveFeeMsat: number
  totalWalletDebitMsat: number
  netFundingMsat: number
}

interface MarketFundingHead {
  transferId: string
  revision: number
}

interface MarketFundingDeliveryResult {
  deliveryId: string
  transferId: string
  state: 'pending' | 'received' | 'credited'
}

function marketFundingPublicView(market: unknown, conditionId: string): unknown {
  if (market === null) return null
  if (
    !isPlainRecord(market) ||
    market.conditionId !== conditionId ||
    !Number.isSafeInteger(market.ammBotBudgetSubunits) ||
    (market.ammBotBudgetSubunits as number) < 0 ||
    !(market.fundingRevision === null || typeof market.fundingRevision === 'string')
  ) {
    process.exitCode = 1
    return { ok: false, error: 'public market funding data is invalid' }
  }
  return {
    conditionId,
    ammBotBudgetSubunits: market.ammBotBudgetSubunits,
    fundingRevision: market.fundingRevision,
  }
}

async function printContextualFundingDaemonResult<T>(
  responsePromise: Promise<DaemonResponse<T>>,
  toResult: (result: T | undefined) => unknown,
): Promise<void> {
  const response = await responsePromise
  if (!response.ok) {
    await printDaemonResult(Promise.resolve(response))
    return
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, result: toResult(response.result) }, null, 2)}\n`,
  )
}

async function beginMarketFunding(
  conditionId: string,
  options: MarketFundingBeginOptions,
): Promise<void> {
  const quoteResponse = await callDaemon<MarketFundingQuote>({
    method: 'market.funding.quote',
    params: { conditionId, requestedAmountMsat: options.amountMsat },
  })
  if (!quoteResponse.ok) {
    await printDaemonResult(Promise.resolve(quoteResponse))
    return
  }
  const quote = quoteResponse.result
  if (!isMarketFundingQuote(quote)) {
    printFundingFailure('daemon returned an invalid funding quote')
    return
  }
  if (quote.totalWalletDebitMsat > options.maxWalletDebitMsat) {
    printFundingFailure(
      'quoted wallet debit exceeds --max-wallet-debit-msat; no funding attempt was started',
      'market-funding-refused',
      {
        conditionId,
        requestedAmountMsat: options.amountMsat,
        maxWalletDebitMsat: options.maxWalletDebitMsat,
        quote,
      },
    )
    return
  }

  const headResponse = await callDaemon<MarketFundingHead | null>({
    method: 'market.funding.head',
    params: { conditionId },
  })
  if (!headResponse.ok) {
    await printDaemonResult(Promise.resolve(headResponse))
    return
  }
  if (!isMarketFundingHead(headResponse.result)) {
    printFundingFailure('daemon returned an invalid funding sequence head')
    return
  }

  const attempt: MarketFundParams['attempt'] = {
    kind: 'begin',
    expectedPreviousTransferId: headResponse.result?.transferId ?? null,
    newAttemptId: randomUUID(),
    requestedAmount: String(options.amountMsat),
  }
  const params: MarketFundParams = {
    conditionId,
    attempt,
    maxWalletDebitMsat: options.maxWalletDebitMsat,
  }

  let response: DaemonResponse<MarketFundingDeliveryResult>
  try {
    response = await callDaemon({ method: 'market.fund', params })
  } catch {
    printFundingUncertain(conditionId, attempt.newAttemptId, options, quote)
    return
  }
  if (!response.ok) {
    printMarketFundingBeginRefusal(response, conditionId, attempt.newAttemptId, options, quote)
    return
  }
  if (!isMarketFundingDeliveryResult(response.result)) {
    printFundingUncertain(conditionId, attempt.newAttemptId, options, quote)
    return
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        result: {
          conditionId,
          attemptId: attempt.newAttemptId,
          expectedPreviousTransferId: attempt.expectedPreviousTransferId,
          requestedAmountMsat: options.amountMsat,
          maxWalletDebitMsat: options.maxWalletDebitMsat,
          quote,
          delivery: response.result,
        },
      },
      null,
      2,
    )}\n`,
  )
}

async function resumeMarketFunding(conditionId: string, transferId: string): Promise<void> {
  try {
    const response = await callDaemon<MarketFundingDeliveryResult>({
      method: 'market.fund',
      params: { conditionId, attempt: { kind: 'resume', transferId } },
    })
    if (!response.ok) {
      printMarketFundingResumeRefusal(response, conditionId, transferId)
      return
    }
    if (!isMarketFundingDeliveryResult(response.result)) {
      printFundingUncertain(conditionId, transferId)
      return
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          result: { conditionId, transferId, delivery: response.result },
        },
        null,
        2,
      )}\n`,
    )
  } catch {
    printFundingUncertain(conditionId, transferId)
  }
}

function printMarketFundingBeginRefusal(
  response: DaemonResponse<unknown>,
  conditionId: string,
  attemptId: string,
  options: MarketFundingBeginOptions,
  quote: MarketFundingQuote,
): void {
  const transferId =
    isPlainRecord(response.result) && typeof response.result.attemptId === 'string'
      ? response.result.attemptId
      : attemptId
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: false,
        ...(response.code === undefined ? {} : { code: response.code }),
        error: response.error ?? 'market funding was not confirmed',
        result: {
          conditionId,
          attemptId,
          transferId,
          requestedAmountMsat: options.amountMsat,
          maxWalletDebitMsat: options.maxWalletDebitMsat,
          quote,
          resumeCommand: marketFundingResumeCommand(conditionId, transferId),
        },
      },
      null,
      2,
    )}\n`,
  )
  process.exitCode = 1
}

function printMarketFundingResumeRefusal(
  response: DaemonResponse<unknown>,
  conditionId: string,
  transferId: string,
): void {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: false,
        ...(response.code === undefined ? {} : { code: response.code }),
        error: response.error ?? 'market funding resume was not confirmed',
        result: {
          conditionId,
          transferId,
          resumeCommand: marketFundingResumeCommand(conditionId, transferId),
        },
      },
      null,
      2,
    )}\n`,
  )
  process.exitCode = 1
}

function printFundingUncertain(
  conditionId: string,
  transferId: string,
  options?: MarketFundingBeginOptions,
  quote?: MarketFundingQuote,
): void {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: false,
        code: 'market-funding-unconfirmed',
        error:
          'funding result is uncertain; resume this exact transfer before starting another payment',
        result: {
          conditionId,
          attemptId: transferId,
          transferId,
          ...(options === undefined
            ? {}
            : {
                requestedAmountMsat: options.amountMsat,
                maxWalletDebitMsat: options.maxWalletDebitMsat,
              }),
          ...(quote === undefined ? {} : { quote }),
          resumeCommand: marketFundingResumeCommand(conditionId, transferId),
        },
      },
      null,
      2,
    )}\n`,
  )
  process.exitCode = 1
}

function printFundingFailure(
  error: string,
  code = 'market-funding-invalid-response',
  result?: unknown,
): void {
  process.stdout.write(
    `${JSON.stringify({ ok: false, code, error, ...(result === undefined ? {} : { result }) }, null, 2)}\n`,
  )
  process.exitCode = 1
}

function marketFundingResumeCommand(conditionId: string, transferId: string): string {
  return `bitcaster-cli market fund resume ${conditionId} ${transferId}`
}

function isMarketFundingQuote(value: unknown): value is MarketFundingQuote {
  if (!isPlainRecord(value)) return false
  return (
    Number.isSafeInteger(value.grossFundingMsat) &&
    (value.grossFundingMsat as number) > 0 &&
    Number.isSafeInteger(value.sendPreparationFeeMsat) &&
    (value.sendPreparationFeeMsat as number) >= 0 &&
    Number.isSafeInteger(value.estimatedRecipientReceiveFeeMsat) &&
    (value.estimatedRecipientReceiveFeeMsat as number) >= 0 &&
    Number.isSafeInteger(value.totalWalletDebitMsat) &&
    (value.totalWalletDebitMsat as number) > 0 &&
    Number.isSafeInteger(value.netFundingMsat) &&
    (value.netFundingMsat as number) >= 0
  )
}

function isScorePurchaseConsent(value: unknown): value is ScorePurchaseConsent {
  if (!isPlainRecord(value) || !isPlainRecord(value.request) || !isPlainRecord(value.cost)) {
    return false
  }
  const request = value.request
  const cost = value.cost
  if (
    typeof request.deliveryId !== 'string' ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(request.deliveryId) ||
    !Number.isSafeInteger(request.scorePoints) ||
    (request.scorePoints as number) <= 0 ||
    !Number.isSafeInteger(request.amountMsat) ||
    (request.amountMsat as number) <= 0 ||
    !Number.isSafeInteger(request.purchasedTotalEpoch) ||
    (request.purchasedTotalEpoch as number) < 0 ||
    typeof request.engineBaseUrl !== 'string' ||
    request.engineBaseUrl.length === 0 ||
    typeof request.accountSubject !== 'string' ||
    request.accountSubject.length === 0 ||
    typeof request.mintUrl !== 'string' ||
    request.mintUrl.length === 0 ||
    typeof request.walletId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(request.walletId) ||
    !Number.isSafeInteger(cost.amountMsat) ||
    !Number.isSafeInteger(cost.sendPreparationFeeMsat) ||
    (cost.sendPreparationFeeMsat as number) < 0 ||
    !Number.isSafeInteger(cost.totalWalletDebitMsat) ||
    (cost.totalWalletDebitMsat as number) <= 0
  ) {
    return false
  }
  const amountMsat = (request.scorePoints as number) * 1_000
  const totalWalletDebitMsat =
    (request.amountMsat as number) + (cost.sendPreparationFeeMsat as number)
  return (
    Number.isSafeInteger(amountMsat) &&
    amountMsat === request.amountMsat &&
    cost.amountMsat === request.amountMsat &&
    Number.isSafeInteger(totalWalletDebitMsat) &&
    totalWalletDebitMsat === cost.totalWalletDebitMsat
  )
}

function isMarketFundingHead(value: unknown): value is MarketFundingHead | null {
  if (value === null) return true
  return (
    isPlainRecord(value) &&
    typeof value.transferId === 'string' &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) > 0
  )
}

function isMarketFundingDeliveryResult(value: unknown): value is MarketFundingDeliveryResult {
  if (!isPlainRecord(value)) return false
  return (
    typeof value.deliveryId === 'string' &&
    typeof value.transferId === 'string' &&
    (value.state === 'pending' || value.state === 'received' || value.state === 'credited')
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  if (options.tag !== undefined && options.tag.length > 0) params.tag = options.tag
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
    .description('Read wallet balances and positions, and manage Cashu tokens and operations.')
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli wallet balance\n  bitcaster-cli wallet positions\n' +
        '  bitcaster-cli wallet portfolio --timeframe 1W --page-size 100\n' +
        '  bitcaster-cli wallet assets --page-size 100\n' +
        '  bitcaster-cli wallet assets --cursor <nextCursor> --page-size 100\n' +
        '  bitcaster-cli wallet send 25 --mint <url>',
    )

  registerWalletRequestCommand(wallet)
  registerWalletActivityCommand(wallet)

  wallet
    .command('watch')
    .description(
      'Watch local holdings and optional display-only portfolio estimates as JSON lines.',
    )
    .allowExcessArguments(false)
    .action(async () => {
      const command = validateDaemonWatchCommand({ method: 'wallet.watch' })
      if (globalDryRun) {
        printDryRun(command)
        return
      }
      const controller = new AbortController()
      const cancel = () => controller.abort()
      process.once('SIGINT', cancel)
      process.once('SIGTERM', cancel)
      try {
        const result = await watchDaemonToOutput(command, output, {
          signal: controller.signal,
        })
        switch (result) {
          case 'complete':
            break
          case 'error':
            process.exitCode = 1
            break
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error
      } finally {
        process.removeListener('SIGINT', cancel)
        process.removeListener('SIGTERM', cancel)
      }
    })

  wallet
    .command('balance')
    .description('Show available wallet balances.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli wallet balance')
    .action(async () => {
      await printDaemonResult(callDaemon({ method: 'wallet.balance' }))
    })

  wallet
    .command('positions')
    .description('Show local conditional-token holdings grouped by exact outcome set.')
    .allowExcessArguments(false)
    .action(async () => {
      await printDaemonResult(callDaemon({ method: 'wallet.positions' }))
    })

  wallet
    .command('portfolio')
    .description('Show local wallet holdings and optional display-only portfolio estimates.')
    .option('--timeframe <timeframe>', 'History timeframe: 1D, 1W, 1M, or ALL')
    .option('--page-size <count>', `Asset page size, from 1 to ${ASSET_MONITORING_ASSETS_MAX}`)
    .allowExcessArguments(false)
    .action(async (options: { timeframe?: string; pageSize?: string }) => {
      const params: {
        timeframe?: AssetMonitoringTimeframe
        pageSize?: number
      } = {}
      const timeframe = parsePortfolioTimeframe(options.timeframe)
      if (timeframe !== undefined) params.timeframe = timeframe
      const pageSize = parseAssetMonitoringPageSize(options.pageSize)
      if (pageSize !== undefined) params.pageSize = pageSize
      await printDaemonResult(
        callDaemon({
          method: 'wallet.portfolio',
          ...(Object.keys(params).length ? { params } : {}),
        }),
      )
    })

  wallet
    .command('assets')
    .description('Show one page of display-only asset estimates; pass nextCursor to continue.')
    .option('--cursor <cursor>', 'Opaque nextCursor returned by a previous wallet assets page')
    .option('--page-size <count>', `Asset page size, from 1 to ${ASSET_MONITORING_ASSETS_MAX}`)
    .allowExcessArguments(false)
    .action(async (options: { cursor?: string; pageSize?: string }) => {
      const params: { cursor?: string; pageSize?: number } = {}
      if (options.cursor !== undefined) params.cursor = options.cursor
      const pageSize = parseAssetMonitoringPageSize(options.pageSize)
      if (pageSize !== undefined) params.pageSize = pageSize
      await printDaemonResult(
        callDaemon({
          method: 'wallet.assets',
          ...(Object.keys(params).length ? { params } : {}),
        }),
      )
    })

  const invoice = wallet
    .command('invoice')
    .description('Create and manage durable native BOLT11 invoices.')
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli wallet invoice create --amount-msat 25000\n' +
        '  bitcaster-cli wallet invoice show <quote-record-id>\n' +
        '  bitcaster-cli wallet invoice replace <quote-record-id> --amount-msat 30000',
    )

  invoice
    .command('create')
    .description('Create and save a native Lightning invoice for the exact msat amount.')
    .requiredOption('--amount-msat <amountMsat>', 'Invoice amount in millisatoshis')
    .option('--dry-run', 'Validate and print the wallet.invoice.create request')
    .allowExcessArguments(false)
    .action(async (options: { amountMsat: string; dryRun?: boolean }) => {
      const params = { amountMsat: parseSafeIntegerOption('amount msat')(options.amountMsat) }
      if (isDryRun(options)) {
        printDryRun(params)
        return
      }
      await printDaemonResult(callDaemon({ method: 'wallet.invoice.create', params }))
    })

  invoice
    .command('show <quoteRecordId>')
    .description('Show one saved invoice without exposing proofs or wallet secrets.')
    .allowExcessArguments(false)
    .action(async (quoteRecordId: string) => {
      await printDaemonResult(
        callDaemon({ method: 'wallet.invoice.show', params: { quoteRecordId } }),
      )
    })

  invoice
    .command('hide <quoteRecordId>')
    .description('Hide an invoice from presentation without disabling recovery.')
    .option('--dry-run', 'Validate and print the wallet.invoice.hide request')
    .allowExcessArguments(false)
    .action(async (quoteRecordId: string, options: { dryRun?: boolean }) => {
      const params = { quoteRecordId }
      if (isDryRun(options)) {
        printDryRun(params)
        return
      }
      await printDaemonResult(callDaemon({ method: 'wallet.invoice.hide', params }))
    })

  invoice
    .command('replace <quoteRecordId>')
    .description('Hide the previous invoice before creating its replacement.')
    .requiredOption('--amount-msat <amountMsat>', 'Replacement invoice amount in millisatoshis')
    .option('--dry-run', 'Validate and print the wallet.invoice.replace request')
    .allowExcessArguments(false)
    .action(async (quoteRecordId: string, options: { amountMsat: string; dryRun?: boolean }) => {
      const params = {
        quoteRecordId,
        amountMsat: parseSafeIntegerOption('amount msat')(options.amountMsat),
      }
      if (isDryRun(options)) {
        printDryRun(params)
        return
      }
      await printDaemonResult(callDaemon({ method: 'wallet.invoice.replace', params }))
    })

  const pay = wallet
    .command('pay')
    .description('Pay a BOLT11 invoice from the configured msat wallet.')
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli wallet pay quote --invoice-file invoice.txt > payment-quote.json\n' +
        '  bitcaster-cli wallet pay execute --fee-consent-file payment-quote.json\n' +
        '  bitcaster-cli wallet pay status wallet-melt:<operation-id>',
    )

  pay
    .command('quote')
    .description('Quote the exact wallet debit for a BOLT11 invoice file.')
    .requiredOption('--invoice-file <path>', 'Private file containing the BOLT11 invoice')
    .option('--dry-run', 'Validate the invoice file without sending its contents')
    .allowExcessArguments(false)
    .action(async (options: { invoiceFile: string; dryRun?: boolean }) => {
      const invoice = await readLightningInvoiceFile(
        requiredArg(options.invoiceFile, 'invoice-file'),
      )
      if (isDryRun(options)) {
        printDryRun({ method: 'wallet.pay.quote', invoiceFile: options.invoiceFile })
        return
      }
      const response = await callDaemon<WalletPaymentQuote>({
        method: 'wallet.pay.quote',
        params: { invoice },
      })
      if (response.ok && !isWalletPaymentQuote(response.result)) {
        await printDaemonResult(
          Promise.resolve({ ok: false, error: 'daemon returned an invalid wallet payment quote' }),
        )
        return
      }
      await printDaemonResult(Promise.resolve(response))
    })

  pay
    .command('execute')
    .description('Pay the exact saved quote and approve its quoted total wallet debit.')
    .requiredOption(
      '--fee-consent-file <path>',
      'Successful wallet pay quote JSON envelope; required before payment',
    )
    .option('--dry-run', 'Show the operation id and approved debit without sending the invoice')
    .allowExcessArguments(false)
    .action(async (options: { feeConsentFile: string; dryRun?: boolean }) => {
      const consent = await readWalletPaymentQuoteFile(
        requiredArg(options.feeConsentFile, 'fee-consent-file'),
      )
      if (isDryRun(options)) {
        printDryRun({
          method: 'wallet.pay.execute',
          operationId: consent.operationId,
          approvedMaxDebitMsat: consent.totalWalletDebitMsat,
        })
        return
      }
      await printDaemonResult(callDaemon({ method: 'wallet.pay.execute', params: { consent } }))
    })

  pay
    .command('status <operationId>')
    .description('Read the local status of one saved wallet payment operation.')
    .allowExcessArguments(false)
    .action(async (operationId: string) => {
      await printDaemonResult(callDaemon({ method: 'wallet.pay.status', params: { operationId } }))
    })

  wallet
    .command('receive')
    .description('Import a Cashu token into the wallet.')
    .option('--token-file <path>', 'Owner-only file containing the Cashu token')
    .option('--condition-id <id>', 'Condition id for outcome-token imports')
    .option('--outcome-set <id>', 'Outcome set id for outcome-token imports')
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli wallet receive --token-file ./token.cashu\n  bitcaster-cli wallet receive --token-file ./outcome.cashu --condition-id cond --outcome-set YES',
    )
    .allowExcessArguments(false)
    .action(async (options: { tokenFile?: string; conditionId?: string; outcomeSet?: string }) => {
      if (options.tokenFile === undefined) {
        throwUsage('wallet receive requires --token-file')
      }
      const importedToken = await readPrivateTokenFile(options.tokenFile)
      const params: {
        token: string
        conditionId?: string
        outcomeSetId?: string
      } = { token: importedToken }
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
    .command('recover-seed')
    .description('Recover deterministic regular and selected CTF proofs from the wallet seed.')
    .requiredOption(
      '--wallet-seed-hex-file <path>',
      'Owner-only file containing the 64-byte wallet seed as lowercase hex',
    )
    .requiredOption(
      '--recovery-id <id>',
      'Stable recovery job id. Reuse it for later invocations until recovery completes',
    )
    .requiredOption('--mint <url>', 'Canonical mint origin')
    .requiredOption('--unit <unit>', 'Product mint unit: msat')
    .option(
      '--acknowledge-seed-disclosure',
      'Acknowledge that recovery discloses deterministic proof candidates to the mint',
    )
    .option('--dry-run', 'Validate and print the one-shot recovery request')
    .allowExcessArguments(false)
    .action(
      async (options: {
        walletSeedHexFile: string
        recoveryId: string
        mint: string
        unit: string
        acknowledgeSeedDisclosure?: boolean
        dryRun?: boolean
      }) => {
        if (options.acknowledgeSeedDisclosure !== true) {
          throwUsage('wallet recover-seed requires --acknowledge-seed-disclosure')
        }
        if (options.unit !== 'msat') {
          throwUsage('wallet recover-seed unit must be msat')
        }
        if (isDryRun(options)) {
          printDryRun({
            recoveryId: options.recoveryId,
            mintUrl: options.mint,
            unit: options.unit,
            walletSeedHex: await readPrivateWalletSeedFile(options.walletSeedHexFile),
            disclosureAcknowledged: true,
          })
          return
        }
        await runDaemonCommand([
          'recover-seed',
          '--wallet-seed-hex-file',
          options.walletSeedHexFile,
          '--recovery-id',
          options.recoveryId,
          '--mint',
          options.mint,
          '--unit',
          options.unit,
          '--acknowledge-seed-disclosure',
        ])
      },
    )

  wallet
    .command('send <amountSats>')
    .description('Prepare an ecash send operation for the requested amount.')
    .option('--mint <url>', 'Mint URL')
    .option('--operation-id <id>', 'Operation id')
    .option(
      '--dry-run',
      'Validate and print the would-be wallet.send params without calling the daemon',
    )
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli --dry-run wallet send 25 --mint https://mint.example',
    )
    .action(
      async (
        amountSats: string,
        options: { mint?: string; operationId?: string; dryRun?: boolean },
      ) => {
        const params: { amountMsat: number; mintUrl?: string; operationId?: string } = {
          amountMsat: parseSatsToMsat(amountSats),
        }
        if (options.mint !== undefined) params.mintUrl = options.mint
        if (options.operationId !== undefined) params.operationId = options.operationId
        if (isDryRun(options)) {
          printDryRun(params)
          return
        }
        await printDaemonResult(callDaemon({ method: 'wallet.send', params }))
      },
    )

  wallet
    .command('reclaim <transferId>')
    .description('Reclaim one exact outgoing bearer transfer after a fresh proof-state check.')
    .option('--dry-run', 'Validate and print the wallet.reclaim request without calling the daemon')
    .addHelpText('after', '\nExample:\n  bitcaster-cli wallet reclaim <transfer-id>')
    .action(async (transferId: string, options: { dryRun?: boolean }) => {
      const params = { transferId }
      if (isDryRun(options)) {
        printDryRun(params)
        return
      }
      await printDaemonResult(callDaemon({ method: 'wallet.reclaim', params }))
    })

  registerWalletSplitCommand(wallet, 'split')
  wallet
    .command('consolidate-proofs')
    .description('Consolidate available Cashu proofs through durable bounded mint operations.')
    .option('--dry-run', 'Validate and print the proof-consolidation request')
    .addHelpText('after', '\nExample:\n  bitcaster-cli wallet consolidate-proofs')
    .action(async (options: { dryRun?: boolean }) => {
      if (isDryRun(options)) {
        printDryRun({})
        return
      }
      await printDaemonResult(callDaemon({ method: 'wallet.consolidateProofs' }))
    })
  registerConsolidateCommand(wallet, 'consolidate')

  wallet
    .command('retire-condition <conditionId>')
    .description('Redeem winning condition proofs and retain losing proofs for audit.')
    .option(
      '--acknowledge',
      'Acknowledge the current condition, action, and estimated mint fee, then execute.',
    )
    .option('--dry-run', 'Print the retirement request without calling the daemon')
    .addHelpText(
      'after',
      '\nRun without --acknowledge to preview the current action and fee.\n' +
        'Example:\n  bitcaster-cli wallet retire-condition <condition-id>',
    )
    .action(async (conditionId: string, options: { acknowledge?: boolean; dryRun?: boolean }) => {
      const params = { conditionId, acknowledge: options.acknowledge === true }
      if (isDryRun(options)) {
        printDryRun(params)
        return
      }
      await printDaemonResult(callDaemon({ method: 'wallet.retireCondition', params }))
    })

  wallet
    .command('claim <conditionId> <outcomeCollection>')
    .description(
      'Claim one exact outcome collection. Return operation IDs and oracle verification status.',
    )
    .option('--dry-run', 'Print the wallet.claimPosition request without calling the daemon')
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli wallet claim <condition-id> Alpha\n  bitcaster-cli wallet operations --kind ctf-redeem',
    )
    .action(
      async (conditionId: string, outcomeCollection: string, options: { dryRun?: boolean }) => {
        if (
          !/^[0-9a-f]{64}$/i.test(conditionId) ||
          outcomeCollection.length === 0 ||
          outcomeCollection.length > 16384 ||
          outcomeCollection
            .split('|')
            .some((outcome) => outcome.length === 0 || outcome.trim() !== outcome) ||
          new Set(outcomeCollection.split('|')).size !== outcomeCollection.split('|').length
        ) {
          throwUsage('wallet claim requires a condition id and an exact outcome collection')
        }
        const params = { conditionId: conditionId.toLowerCase(), outcomeCollection }
        if (isDryRun(options)) {
          printDryRun({ method: 'wallet.claimPosition', params })
          return
        }
        await printDaemonResult(callDaemon({ method: 'wallet.claimPosition', params }))
      },
    )

  wallet
    .command('remove-preview <conditionId> <outcomeCollection>')
    .description('Preview one exact verified losing batch. Keep the JSON for acknowledgement.')
    .option('--dry-run', 'Print the wallet.removePreview request')
    .allowExcessArguments(false)
    .action(
      async (conditionId: string, outcomeCollection: string, options: { dryRun?: boolean }) => {
        if (
          !/^[0-9a-f]{64}$/i.test(conditionId) ||
          !outcomeCollection ||
          outcomeCollection.length > 16384 ||
          outcomeCollection.split('|').some((part) => !part || part.trim() !== part) ||
          new Set(outcomeCollection.split('|')).size !== outcomeCollection.split('|').length
        )
          throwUsage('wallet remove-preview requires an exact condition and outcome collection')
        const params = { conditionId: conditionId.toLowerCase(), outcomeCollection }
        if (isDryRun(options)) {
          printDryRun({ method: 'wallet.removePreview', params })
          return
        }
        await printDaemonResult(callDaemon({ method: 'wallet.removePreview', params }))
      },
    )

  wallet
    .command('remove')
    .description(
      'Retire only the acknowledged preview batch. Keep raw proofs and operation history.',
    )
    .requiredOption(
      '--preview-file <path>',
      'File containing a successful remove-preview JSON result',
    )
    .requiredOption(
      '--acknowledge-loss',
      'Explicitly acknowledge retirement of this exact losing batch',
    )
    .option('--dry-run', 'Validate and print the wallet.removePosition request')
    .allowExcessArguments(false)
    .action(
      async (options: { previewFile: string; acknowledgeLoss: boolean; dryRun?: boolean }) => {
        const preview = await readRemovalPreviewFile(options.previewFile)
        const params = { preview, acknowledge: true as const }
        if (options.acknowledgeLoss !== true)
          throwUsage('wallet remove requires --acknowledge-loss')
        if (isDryRun(options)) {
          printDryRun({ method: 'wallet.removePosition', params })
          return
        }
        await printDaemonResult(callDaemon({ method: 'wallet.removePosition', params }))
      },
    )

  wallet
    .command('operations')
    .description('List prepared or recoverable wallet operations.')
    .option('--kind <kind>', 'Operation kind')
    .option('--state <state>', 'Operation state')
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli wallet operations --kind wallet-send --state prepared',
    )
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
}

function registerWalletActivityCommand(wallet: Command): void {
  wallet
    .command('activity')
    .description('Read one local Activity page for the selected wallet as JSON.')
    .option('--wallet-id <walletId>', 'Require the selected canonical wallet ID')
    .option('--cursor <cursor>', 'Continue with the previous nextCursor')
    .option(
      '--page-size <count>',
      `Rows per page, 1..${DAEMON_ACTIVITY_PAGE_SIZE_MAX} (default: 25)`,
    )
    .allowExcessArguments(false)
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli wallet activity --page-size 25\n' +
        '  bitcaster-cli wallet activity --cursor <nextCursor>\n' +
        '\nOutput: { ok, result: { items, nextCursor, hasMore } }.\n' +
        'Each item has id, walletId, type, amountSubunits (msats), baseAsset, date, and status.\n' +
        'Optional identifiers can be unavailable. The read uses retained local display rows.\n' +
        'Activity is display data. It is not a spendable balance or a complete lifetime audit.',
    )
    .action(async (options: { walletId?: string; cursor?: string; pageSize?: string }) => {
      let params: ReturnType<typeof validateWalletActivityParams>
      try {
        params = validateWalletActivityParams({
          ...(options.walletId === undefined ? {} : { walletId: options.walletId }),
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          ...(options.pageSize === undefined
            ? {}
            : { pageSize: /^\d+$/.test(options.pageSize) ? Number(options.pageSize) : NaN }),
        })
      } catch {
        throwUsage('Invalid Wallet Activity options')
      }
      const command: DaemonCommand = {
        method: 'wallet.activity',
        ...(Object.keys(params).length === 0 ? {} : { params }),
      }
      if (globalDryRun) {
        printDryRun(command)
        return
      }
      await printDaemonResult(callDaemon(command))
    })
}

function registerWalletRequestCommand(wallet: Command): void {
  const request = wallet
    .command('request')
    .description('Receive Cashu through amountless msat requests bound to the configured mint.')
    .addHelpText(
      'after',
      '\nThe selected daemon profile owns the wallet, mint, and receive identity.\n' +
        'This command receives payments. It does not pay a scanned request.\n' +
        'Create returns encoded for sharing. Status reports durable receipt progress.\n' +
        '\nExamples:\n  bitcaster-cli wallet request create\n' +
        '  bitcaster-cli wallet request status <request-id>\n' +
        '  bitcaster-cli wallet request list --page-size 32\n' +
        '  bitcaster-cli wallet request recover <request-id>\n' +
        '  bitcaster-cli wallet request watch <request-id>',
    )
  registerWalletRequestCreate(request)
  registerWalletRequestStatusAndRecovery(request)
  registerWalletRequestList(request)
  registerWalletRequestWatch(request)
}

function registerWalletRequestCreate(request: Command): void {
  request
    .command('create')
    .description('Save an amountless msat request before returning its encoded sharing value.')
    .option('--request-id <requestId>', 'Use a request identity of 1..256 UTF-8 bytes')
    .option('--dry-run', 'Validate and print the request without creating or receiving payments')
    .allowExcessArguments(false)
    .action(async (options: { requestId?: string; dryRun?: boolean }) => {
      const command: DaemonCommand = {
        method: 'wallet.request.create',
        ...(options.requestId === undefined
          ? {}
          : { params: { requestId: parseNativeRequestId(options.requestId) } }),
      }
      await executeWalletRequestCommand(command, options)
    })
}

function registerWalletRequestStatusAndRecovery(request: Command): void {
  const commands = [
    {
      operation: 'status',
      description: 'Read one saved request: awaiting, pending, or credited with exact amountMsat.',
    },
    {
      operation: 'recover',
      description:
        'Recover one saved request through existing custody recovery, without creating a new request.',
    },
  ] as const
  for (const { operation, description } of commands) {
    request
      .command(`${operation} <requestId>`)
      .description(description)
      .option('--dry-run', 'Validate and print the request without daemon I/O')
      .allowExcessArguments(false)
      .action(async (requestId: string, options: { dryRun?: boolean }) => {
        await executeWalletRequestCommand(
          {
            method: `wallet.request.${operation}`,
            params: { requestId: parseNativeRequestId(requestId) },
          },
          options,
        )
      })
  }
}

async function executeWalletRequestCommand(
  command: Extract<DaemonCommand, { method: `wallet.request.${string}` }>,
  options: { dryRun?: boolean },
): Promise<void> {
  if (isDryRun(options)) {
    printDryRun(command)
    return
  }
  await printDaemonResult(callDaemon(command))
}

function registerWalletRequestList(request: Command): void {
  request
    .command('list')
    .description(
      'List one bounded page of saved requests; receipt acceptance does not mean credit.',
    )
    .option(
      '--cursor <cursor>',
      'Opaque nextCursor from the previous page (at most 4096 UTF-8 bytes)',
    )
    .option('--page-size <pageSize>', 'Requests per page, 1..256 (daemon default: 32)')
    .option('--dry-run', 'Validate and print the list query without daemon I/O')
    .allowExcessArguments(false)
    .action(async (options: { cursor?: string; pageSize?: string; dryRun?: boolean }) => {
      const params = {
        ...(options.cursor === undefined
          ? {}
          : { cursor: parseNativeRequestCursor(options.cursor) }),
        ...(options.pageSize === undefined
          ? {}
          : { pageSize: parseNativeRequestPageSize(options.pageSize) }),
      }
      await executeWalletRequestCommand(
        { method: 'wallet.request.list', ...(Object.keys(params).length ? { params } : {}) },
        options,
      )
    })
}

function registerWalletRequestWatch(request: Command): void {
  request
    .command('watch <requestId>')
    .description(
      'Watch durable receipt progress as bounded JSON lines until credited or cancelled.',
    )
    .addHelpText(
      'after',
      '\nStopping this watch does not cancel the saved request or daemon receiver.',
    )
    .option('--dry-run', 'Validate and print the watch request without daemon I/O')
    .allowExcessArguments(false)
    .action(async (requestId: string, options: { dryRun?: boolean }) => {
      const command = {
        method: 'wallet.request.watch' as const,
        params: { requestId: parseNativeRequestId(requestId) },
      }
      if (isDryRun(options)) {
        printDryRun(command)
        return
      }
      const controller = new AbortController()
      const cancel = () => controller.abort()
      process.once('SIGINT', cancel)
      process.once('SIGTERM', cancel)
      try {
        const result = await watchDaemonToOutput(command, output, { signal: controller.signal })
        switch (result) {
          case 'complete':
            break
          case 'error':
            process.exitCode = 1
            break
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error
      } finally {
        process.removeListener('SIGINT', cancel)
        process.removeListener('SIGTERM', cancel)
      }
    })
}

function parseNativeRequestId(value: string): string {
  if (value.length > 0 && Buffer.byteLength(value) <= NATIVE_REQUEST_ID_BYTES_MAX) return value
  throwUsage('Request ID must contain 1..256 UTF-8 bytes.')
}

function parseNativeRequestCursor(value: string): string {
  if (Buffer.byteLength(value) <= NATIVE_REQUEST_CURSOR_BYTES_MAX) return value
  throwUsage('Request cursor must contain at most 4096 UTF-8 bytes.')
}

function parseNativeRequestPageSize(value: string): number {
  const pageSize = Number(value)
  if (Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= NATIVE_REQUEST_PAGE_SIZE_MAX)
    return pageSize
  throwUsage('Request page size must be a safe integer in 1..256.')
}

function registerScoreCommand(program: Command): void {
  const score = program
    .command('score')
    .description('Inspect and purchase non-refundable Participation Score.')
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli score show\n  bitcaster-cli score quote 25 > score-quote.json\n  bitcaster-cli score buy --fee-consent-file score-quote.json\n  bitcaster-cli score status --fee-consent-file score-quote.json',
    )

  score
    .command('show')
    .description('Show the authenticated Participation Score balance and totals.')
    .action(async () => {
      await printDaemonResult(callDaemon({ method: 'score.show' }))
    })

  score
    .command('quote <scorePoints>')
    .description('Preview the exact wallet debit for one Score purchase.')
    .option('--dry-run', 'Print the would-be score.quote request')
    .addHelpText(
      'after',
      '\nThe quote output is the approval file. Score is non-refundable. Save it unchanged before `score buy`.',
    )
    .action(async (scorePointsText: string, options: { dryRun?: boolean }) => {
      const scorePoints = parseSafeIntegerOption('score points')(scorePointsText)
      const params = { deliveryId: randomUUID(), scorePoints }
      if (isDryRun(options)) {
        printDryRun(params)
        return
      }
      const response = await callDaemon<ScorePurchaseConsent>({ method: 'score.quote', params })
      if (!response.ok) {
        await printDaemonResult(Promise.resolve(response))
        return
      }
      if (!isScorePurchaseConsent(response.result)) {
        await printDaemonResult(
          Promise.resolve({ ok: false, error: 'daemon returned an invalid Score purchase quote' }),
        )
        return
      }
      await printDaemonResult(Promise.resolve(response))
    })

  score
    .command('buy')
    .description('Pay for the exact Score purchase in a saved quote file.')
    .requiredOption(
      '--fee-consent-file <path>',
      'Successful score quote JSON envelope; required before payment',
    )
    .option('--dry-run', 'Print the would-be score.buy request without calling the daemon')
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli score buy --fee-consent-file score-quote.json',
    )
    .action(async (options: { feeConsentFile: string; dryRun?: boolean }) => {
      const consent = await readScorePurchaseConsentFile(
        requiredArg(options.feeConsentFile, 'fee-consent-file'),
      )
      if (isDryRun(options)) {
        printDryRun({ consent })
        return
      }
      await printDaemonResult(callDaemon({ method: 'score.buy', params: { consent } }))
    })

  score
    .command('status')
    .description('Read the recipient status for one saved Score purchase quote.')
    .requiredOption(
      '--fee-consent-file <path>',
      'Successful score quote JSON envelope with the original purchase identity',
    )
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli score status --fee-consent-file score-quote.json',
    )
    .action(async (options: { feeConsentFile: string }) => {
      const consent = await readScorePurchaseConsentFile(
        requiredArg(options.feeConsentFile, 'fee-consent-file'),
      )
      await printDaemonResult(callDaemon({ method: 'score.status', params: { consent } }))
    })
}

function registerWalletSplitCommand(wallet: Command, name: string, hidden = false): void {
  wallet
    .command(`${name} <conditionId> <amountSats>`, { hidden })
    .description('Split regular ecash into a complete conditional outcome set.')
    .option('--mint <url>', 'Mint URL')
    .option('--operation-id <id>', 'Operation id')
    .option(
      '--dry-run',
      'Validate and print the would-be wallet.split params without calling the daemon',
    )
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli --dry-run wallet split <condition-id> 100 --mint https://mint.example',
    )
    .action(
      async (
        conditionId: string,
        amountSats: string,
        options: { mint?: string; operationId?: string; dryRun?: boolean },
      ) => {
        const amountMsat = parsePositiveSatsToMsat(amountSats)
        const params: {
          conditionId: string
          amountMsat: number
          mintUrl?: string
          operationId?: string
        } = { conditionId, amountMsat }
        if (options.mint !== undefined) params.mintUrl = options.mint
        if (options.operationId !== undefined) params.operationId = options.operationId
        if (isDryRun(options)) {
          printDryRun(params)
          return
        }
        await printDaemonResult(callDaemon({ method: 'wallet.splitCompleteSet', params }))
      },
    )
}

function registerConsolidateCommand(parent: Command, name: string, hidden = false): void {
  parent
    .command(`${name} [marketId]`, { hidden })
    .description('Consolidate pending CTF market positions through bitcaster-daemon.')
    .option('--all', 'Sweep every market id found in wallet balance')
    .addOption(
      new Option(
        '--strategy <type>',
        'Consolidation strategy:\n' +
          '                       merge    - Merge singletons + collateral into the missing complement set\n' +
          '                       sweep    - Extract collateral from overlapping complement collections\n' +
          '                       reclaim  - Extract collateral from all mixed positions (default)',
      )
        .argParser(parseConsolidationStrategy)
        .default('t3', 'reclaim'),
    )
    .option(
      '--dry-run',
      'Validate and print the would-be consolidation params without calling the daemon',
    )
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli wallet consolidate <market-id> --strategy merge\n  bitcaster-cli --dry-run wallet consolidate --all --strategy reclaim',
    )
    .action(
      async (
        marketId: string | undefined,
        options: { all?: boolean; strategy: 't1' | 't2' | 't3'; dryRun?: boolean },
      ) => {
        await handleConsolidate({
          all: options.all === true,
          marketId: marketId ?? '',
          type: options.strategy,
          dryRun: isDryRun(options),
        })
      },
    )
}

async function handleConsolidate(parsed: ConsolidateArgs): Promise<void> {
  if (parsed.all && parsed.marketId) {
    throwUsage('wallet consolidate --all cannot be combined with a market id')
  }
  if (!parsed.all && !parsed.marketId) {
    throwUsage(
      'Usage: bitcaster-cli wallet consolidate <market-id> [--strategy merge|sweep|reclaim]',
    )
  }
  if (parsed.dryRun) {
    printDryRun(
      parsed.all
        ? { all: true, type: parsed.type }
        : { marketId: parsed.marketId, type: parsed.type },
    )
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
    .description(
      'Preview, submit, inspect, wait for, list, and cancel orders and read order books.',
    )
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli order preview --market cond-YES --side Buy --price 420 --amount-msat 1000\n  bitcaster-cli order capacity --market cond-YES --side Buy\n  bitcaster-cli order fee-preview --market cond-YES --outcome YES --side Buy --price 420 --amount-msat 1000\n  bitcaster-cli order submit --market cond-YES --outcome YES --side Buy --price 420 --amount-msat 1000 --fee-consent-file fees.json\n  bitcaster-cli order wait <market-id> <order-id> --timeout-ms 30000\n  bitcaster-cli order book <market-id>',
    )

  order
    .command('preview')
    .description('Preview a public FOK book estimate; wallet preparation fees are not included.')
    .option('--market <id>', 'Primitive outcome market id')
    .option('--side <side>', 'Order side: Buy or Sell', parseSide)
    .option('--token-side <side>', 'Token side: Outcome or Complement', parseTokenSide)
    .option(
      '--price <n>',
      'Custom selected-token limit; omit to use the server Auto limit',
      parseSafeIntegerOption('price'),
    )
    .option(
      '--amount-msat <msat>',
      'Order face amount in msat (sent as faceAmountSubunits)',
      parseSafeIntegerOption('amount msat'),
    )
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli order preview --market cond-YES --side Buy --amount-msat 1000\n  bitcaster-cli order preview --market cond-YES --side Buy --price 420 --amount-msat 1000',
    )
    .action(async (options: OrderPreviewOptions, command: Command) => {
      const input = orderPreviewInput(options, command.args)
      const client = directEngineClient()
      if (input.price !== undefined) {
        const request: PreviewFokOrderRequest = { ...input, price: input.price }
        await printPublicEngineResult(
          () => client.previewFokOrder(request),
          (preview) => ({
            request,
            preview,
          }),
        )
        return
      }

      await printPublicEngineResult(
        () =>
          client.previewFokOrderCapacity({
            marketId: input.marketId,
            side: input.side,
            tokenSide: input.tokenSide,
          }),
        async (capacity) => {
          if (capacity.status !== 'ready' || capacity.effectiveLimitPrice === null) {
            return { request: input, capacity, preview: null }
          }
          const request: PreviewFokOrderRequest = {
            marketId: input.marketId,
            side: input.side,
            tokenSide: input.tokenSide,
            price: capacity.effectiveLimitPrice,
            faceAmountSubunits: input.faceAmountSubunits,
          }
          return { request, preview: await client.previewFokOrder(request) }
        },
      )
    })

  order
    .command('capacity')
    .description('Observe public FOK capacity; this is not a reservation or wallet balance.')
    .option('--market <id>', 'Primitive outcome market id')
    .option('--side <side>', 'Order side: Buy or Sell', parseSide)
    .option('--token-side <side>', 'Token side: Outcome or Complement', parseTokenSide)
    .option(
      '--price <n>',
      'Custom selected-token limit; omit to use the server Auto limit',
      parseSafeIntegerOption('price'),
    )
    .addHelpText(
      'after',
      '\nExamples:\n  bitcaster-cli order capacity --market cond-YES --side Buy\n  bitcaster-cli order capacity --market cond-YES --side Buy --token-side Complement --price 420',
    )
    .action(async (options: OrderCapacityOptions, command: Command) => {
      const request = orderCapacityRequest(options, command.args)
      await printPublicEngineResult(() => directEngineClient().previewFokOrderCapacity(request))
    })

  order
    .command('fee-preview')
    .description('Preview the exact fee facts for a public FOK order draft.')
    .option('--market <id>', 'Market id')
    .option('--outcome <id>', 'Outcome id')
    .option('--side <side>', 'Order side: Buy or Sell', parseSide)
    .option(
      '--max-quote-payment-msat <msat>',
      'Accepted Buy maximum trade payment in msat',
      parseNonNegativeIntegerOption('max quote payment msat'),
    )
    .option(
      '--min-quote-payment-msat <msat>',
      'Accepted Sell minimum trade payment in msat',
      parseNonNegativeIntegerOption('min quote payment msat'),
    )
    .option(
      '--price <n>',
      'Limit price; omit to use the server Auto limit',
      parseSafeIntegerOption('price'),
    )
    .option(
      '--amount-msat <msat>',
      'Order face amount in msat',
      parseSafeIntegerOption('amount msat'),
    )
    .option(
      '--min-fill-msat <msat>',
      'Minimum fill in msat (default: one whole share, 1000 msat)',
      parseSafeIntegerOption('minimum fill msat'),
    )
    .option('--token-side <side>', 'Token side: Outcome or Complement', parseTokenSide)
    .option('--consolidate-proofs', 'Allow bounded proof consolidation before this order')
    .addHelpText(
      'after',
      '\nThe output is the successful daemon envelope. Save it unchanged for `order submit --fee-consent-file`. Auto limits are resolved by the daemon.',
    )
    .action(async (options: OrderDraftOptions, command: Command) => {
      const params = orderDraftParams(options, command.args)
      await printDaemonResult(callDaemon({ method: 'order.fee-preview', params }))
    })

  order
    .command('submit')
    .description('Submit a buy or sell order to the matching engine.')
    .option('--market <id>', 'Market id')
    .option('--outcome <id>', 'Outcome id')
    .option('--side <side>', 'Order side: buy or sell', parseSide)
    .option(
      '--max-quote-payment-msat <msat>',
      'Accepted Buy maximum trade payment in msat',
      parseNonNegativeIntegerOption('max quote payment msat'),
    )
    .option(
      '--min-quote-payment-msat <msat>',
      'Accepted Sell minimum trade payment in msat',
      parseNonNegativeIntegerOption('min quote payment msat'),
    )
    .option(
      '--price <n>',
      'Limit price; omit to use the server Auto limit',
      parseSafeIntegerOption('price'),
    )
    .option(
      '--amount-msat <msat>',
      'Order face amount in msat',
      parseSafeIntegerOption('amount msat'),
    )
    .option(
      '--min-fill-msat <msat>',
      'Minimum fill in msat (default: one whole share, 1000 msat)',
      parseSafeIntegerOption('minimum fill msat'),
    )
    .option(
      '--consolidate-proofs',
      'Allow bounded proof consolidation before this order (default: off)',
    )
    .option('--token-side <side>', 'Token side: Outcome or Complement', parseTokenSide)
    .option(
      '--fee-consent-file <path>',
      'Successful order fee-preview JSON envelope; required to submit',
    )
    .option('--comment <content>', 'Optional order comment content')
    .option('--market-url <url>', 'Market URL to include with the optional order comment')
    .option(
      '--dry-run',
      'Validate and print the would-be order.submit params without calling the daemon',
    )
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli order submit --market cond-YES --outcome YES --side Buy --price 420 --amount-msat 1000 --fee-consent-file fees.json\n  bitcaster-cli --dry-run order submit --market cond-YES --outcome YES --side Buy --amount-msat 1000',
    )
    .action(async (options: OrderSubmitOptions, command: Command) => {
      const draft = orderDraftParams(options, command.args)
      if (isDryRun(options)) {
        printDryRun(draft)
        return
      }
      const consentPath = requiredArg(options.feeConsentFile, 'fee-consent-file')
      const feeConsent = await readOrderFeeConsentFile(consentPath)
      const comment = orderSubmitComment(options)
      const params: SubmitOrderParams = {
        ...draft,
        feeConsent,
        ...(comment === undefined ? {} : { comment }),
      }
      await printDaemonResult(callDaemon({ method: 'order.submit', params }))
    })

  order
    .command('status <marketId> <orderId>')
    .description('Show one order by market id and order id.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli order status <market-id> <order-id>')
    .action(async (marketId: string, orderId: string) => {
      await printDaemonResult(callDaemon({ method: 'order.status', params: { marketId, orderId } }))
    })

  order
    .command('wait <marketId> <orderId>')
    .description(
      'Wait for terminal engine order status. This does not cancel the order or confirm wallet recovery.',
    )
    .option(
      '--timeout-ms <milliseconds>',
      `Maximum wait in milliseconds (default: ${DEFAULT_ORDER_WAIT_TIMEOUT_MS}; max: ${MAX_ORDER_WAIT_TIMEOUT_MS})`,
      parseOrderWaitTimeout,
      DEFAULT_ORDER_WAIT_TIMEOUT_MS,
    )
    .addHelpText(
      'after',
      '\nThe timeout bounds status polling only. It does not cancel the order, undo preparation, or make funds usable.',
    )
    .action(async (marketId: string, orderId: string, options: OrderWaitOptions) => {
      await waitForOrderStatus(marketId, orderId, options.timeoutMs)
    })

  order
    .command('list')
    .description('List orders, optionally filtered by market or status.')
    .option('--market <market-id>', 'Market id')
    .option('--status <status>', 'Order status')
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli order list --market <market-id> --status resting',
    )
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
      await printDaemonResult(callDaemon({ method: 'order.cancel', params: { marketId, orderId } }))
    })

  order
    .command('book <marketId>')
    .description('Show the order book for one market.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli order book <market-id>')
    .action(async (marketId: string) => {
      await printDirectEngineResultOrDaemon(
        () => fetchOrderBookFromEngine(marketId),
        () => callDaemon({ method: 'order.book', params: { marketId } }),
      )
    })
}

interface OrderReadOptions {
  market?: string
  side?: 'Buy' | 'Sell'
  tokenSide?: 'Outcome' | 'Complement'
  price?: number
}

interface OrderPreviewOptions extends OrderReadOptions {
  amountMsat?: number
}

type OrderCapacityOptions = OrderReadOptions

type OrderPreviewInput = Omit<PreviewFokOrderRequest, 'price'> & { price?: number }

function orderPreviewInput(options: OrderPreviewOptions, positionals: string[]): OrderPreviewInput {
  if (positionals.length > 0) {
    throwUsage(`Unexpected order preview argument: ${positionals[0]}`)
  }
  const input = {
    marketId: requiredArg(options.market, 'market'),
    side: requiredParsedOption(options.side, 'side'),
    tokenSide: options.tokenSide ?? 'Outcome',
    faceAmountSubunits: requiredParsedOption(options.amountMsat, 'amount msat'),
  }
  return options.price === undefined ? input : { ...input, price: options.price }
}

function orderCapacityRequest(
  options: OrderCapacityOptions,
  positionals: string[],
): PreviewFokOrderCapacityRequest {
  if (positionals.length > 0) {
    throwUsage(`Unexpected order capacity argument: ${positionals[0]}`)
  }
  return {
    marketId: requiredArg(options.market, 'market'),
    side: requiredParsedOption(options.side, 'side'),
    tokenSide: options.tokenSide ?? 'Outcome',
    ...(options.price === undefined ? {} : { price: options.price }),
  }
}

interface OrderWaitOptions {
  timeoutMs?: number
}

interface OrderStatusCommandResult {
  engine: OrderStatusResponse | null
  local: unknown
}

type OrderWaitState = 'terminal' | 'timed_out'

function isOrderStatusCommandResult(value: unknown): value is OrderStatusCommandResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'engine' in value &&
    (value.engine === null || (typeof value.engine === 'object' && value.engine !== null)) &&
    'local' in value
  )
}

function isTerminalOrderStatus(status: OrderStatusResponse | null): boolean {
  if (status === null || status.activeSettlementGroup !== null) return false
  switch (status.status) {
    case 'filled':
    case 'cancelled':
    case 'expired':
    case 'evicted_capacity':
    case 'rejected_capacity':
    case 'failed':
      return true
    case 'resting':
    case 'matched':
    case 'partially_filled':
      return false
    default:
      return assertNeverOrderStatus(status.status)
  }
}

function assertNeverOrderStatus(status: never): never {
  throw new Error(`Unknown order status: ${String(status)}`)
}

async function waitForOrderStatus(
  marketId: string,
  orderId: string,
  timeoutMs = DEFAULT_ORDER_WAIT_TIMEOUT_MS,
): Promise<void> {
  const startedAt = performance.now()
  const deadline = startedAt + timeoutMs
  const signal = AbortSignal.timeout(timeoutMs)
  let pollCount = 0
  let latest: OrderStatusCommandResult | null = null

  while (!signal.aborted) {
    const remainingMs = deadline - performance.now()
    if (remainingMs <= 0) break
    pollCount += 1

    let response: DaemonResponse<OrderStatusCommandResult>
    try {
      response = await callDaemon(
        { method: 'order.status', params: { marketId, orderId } },
        { signal },
      )
    } catch (error) {
      if (signal.aborted || performance.now() >= deadline) break
      throw error
    }

    if (signal.aborted || performance.now() >= deadline) break
    if (!response.ok) {
      await printDaemonResult(Promise.resolve(response))
      return
    }
    if (!isOrderStatusCommandResult(response.result)) {
      throw new Error('order.status response did not include engine and local status')
    }
    latest = response.result
    if (isTerminalOrderStatus(latest.engine)) {
      printOrderWaitResult('terminal', marketId, orderId, timeoutMs, pollCount, latest)
      return
    }

    const remainingAfterPollMs = deadline - performance.now()
    if (remainingAfterPollMs <= 0) break
    try {
      await sleepWithSignal(Math.min(ORDER_WAIT_POLL_INTERVAL_MS, remainingAfterPollMs), signal)
    } catch (error) {
      if (signal.aborted || performance.now() >= deadline) break
      throw error
    }
  }

  printOrderWaitResult('timed_out', marketId, orderId, timeoutMs, pollCount, latest)
}

function printOrderWaitResult(
  status: OrderWaitState,
  marketId: string,
  orderId: string,
  timeoutMs: number,
  pollCount: number,
  latest: OrderStatusCommandResult | null,
): void {
  const timedOut = status === 'timed_out'
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: !timedOut,
        ...(timedOut
          ? { error: 'order wait timed out before terminal engine status was observed' }
          : {}),
        result: {
          marketId,
          orderId,
          wait: { status, timeoutMs, pollCount },
          engine: latest?.engine ?? null,
          local: latest?.local ?? null,
        },
      },
      null,
      2,
    )}\n`,
  )
  if (timedOut) process.exitCode = 1
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('order wait aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

interface OrderDraftOptions {
  market?: string
  outcome?: string
  side?: 'Buy' | 'Sell'
  price?: number
  maxQuotePaymentMsat?: number
  minQuotePaymentMsat?: number
  amountMsat?: number
  minFillMsat?: number
  consolidateProofs?: boolean
  expiresAt?: string
  tokenSide?: 'Outcome' | 'Complement'
}

interface OrderSubmitOptions extends OrderDraftOptions {
  feeConsentFile?: string
  comment?: string
  marketUrl?: string
  dryRun?: boolean
}

function orderDraftParams(options: OrderDraftOptions, positionals: string[]): OrderDraftParams {
  if (positionals.length > 0) {
    throwUsage(`Unexpected order submit argument: ${positionals[0]}`)
  }

  const minimumFillAmountSubunits = options.minFillMsat
  if (options.maxQuotePaymentMsat !== undefined || options.minQuotePaymentMsat !== undefined) {
    decodeOrderQuotePaymentBounds(requiredParsedOption(options.side, 'side'), {
      maxQuotePaymentSubunits: options.maxQuotePaymentMsat,
      minQuotePaymentSubunits: options.minQuotePaymentMsat,
    })
  }
  if (options.expiresAt !== undefined) {
    throwUsage('expires-at is not available for public FOK orders')
  }
  return {
    marketId: requiredArg(options.market, 'market'),
    outcomeId: requiredArg(options.outcome, 'outcome'),
    tokenSide: options.tokenSide ?? 'Outcome',
    side: requiredParsedOption(options.side, 'side'),
    ...(options.price === undefined ? {} : { price: options.price }),
    ...(options.maxQuotePaymentMsat === undefined
      ? {}
      : { maxQuotePaymentSubunits: options.maxQuotePaymentMsat }),
    ...(options.minQuotePaymentMsat === undefined
      ? {}
      : { minQuotePaymentSubunits: options.minQuotePaymentMsat }),
    amountSubunits: requiredParsedOption(options.amountMsat, 'amount msat'),
    ...(minimumFillAmountSubunits === undefined ? {} : { minimumFillAmountSubunits }),
    consolidateProofs: options.consolidateProofs === true,
    timeInForce: 'FOK',
    expiresAt: options.expiresAt ?? null,
  }
}

function orderSubmitComment(
  options: OrderSubmitOptions,
): { content: string; marketUrl: string } | undefined {
  if (options.comment === undefined && options.marketUrl === undefined) return undefined
  if (options.comment === undefined || options.marketUrl === undefined) {
    throwUsage('--comment and --market-url must be used together')
  }
  return { content: options.comment, marketUrl: options.marketUrl }
}

function requiredParsedOption<T>(value: T | undefined, name: string): T {
  if (value !== undefined) return value
  throwUsage(`Missing ${name}`)
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
    .addHelpText(
      'after',
      '\nExample:\n  bitcaster-cli daemon config --engine-url <url> --mint-url <url>',
    )
    .action(async (options: { engineUrl?: string; mintUrl?: string }) => {
      await setCliConfig(options)
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
    .option(
      '--lines <n>',
      'Number of log lines to print',
      parseNonNegativeIntegerOption('lines'),
      50,
    )
    .addHelpText('after', '\nExample:\n  bitcaster-cli daemon logs --lines 100')
    .action(async (options: { lines: number }) => {
      await printDaemonLogs(options.lines)
    })

  daemon
    .command('init')
    .description('Initialize daemon profile, wallet seed, Nostr key, and endpoints.')
    .option('--wallet-seed-hex-file <path>', 'File containing wallet seed hex')
    .option('--nostr-secret-key-hex-file <path>', 'File containing Nostr secret key hex')
    .addHelpText('after', '\nExample:\n  bitcaster-cli daemon init')
    .action(async (options: { walletSeedHexFile?: string; nostrSecretKeyHexFile?: string }) => {
      const passthrough = ['init']
      pushOption(passthrough, '--wallet-seed-hex-file', options.walletSeedHexFile)
      pushOption(passthrough, '--nostr-secret-key-hex-file', options.nostrSecretKeyHexFile)
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
  bitcaster-cli config set --mint-url <url>
  bitcaster-cli config set --asset-monitoring disabled`,
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
    .option('--asset-monitoring <enabled|disabled>', 'Asset monitoring. Disabled is privacy mode.')
    .addHelpText('after', '\nExample:\n  bitcaster-cli config set --engine-url <url>')
    .action(async (options: { engineUrl?: string; mintUrl?: string; assetMonitoring?: string }) => {
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

function daemonConfigParams(options: {
  engineUrl?: string
  mintUrl?: string
  assetMonitoring?: string
}): {
  engineUrl?: string
  mintUrl?: string
} {
  const params: { engineUrl?: string; mintUrl?: string } = {}
  const engineUrl = options.engineUrl
  const mintUrl = options.mintUrl
  if (engineUrl !== undefined) params.engineUrl = engineUrl
  if (mintUrl !== undefined) params.mintUrl = mintUrl
  if (!params.engineUrl && !params.mintUrl && options.assetMonitoring === undefined) {
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
  if (key !== 'engineUrl' && key !== 'mintUrl' && key !== 'assetMonitoringEnabled') {
    throwUsage(`Unknown config key: ${key}`)
  }
  const value = config[key]
  process.stdout.write(value === undefined ? 'null\n' : `${JSON.stringify(value)}\n`)
}

async function setCliConfig(options: {
  engineUrl?: string
  mintUrl?: string
  assetMonitoring?: string
}): Promise<void> {
  const params = daemonConfigParams(options)
  const assetMonitoringEnabled = parseAssetMonitoringOption(options.assetMonitoring)
  const config = updateConfig((current) => ({
    ...current,
    ...(params.engineUrl === undefined ? {} : { engineUrl: params.engineUrl }),
    ...(params.mintUrl === undefined ? {} : { mintUrl: params.mintUrl }),
    ...(assetMonitoringEnabled === undefined ? {} : { assetMonitoringEnabled }),
  }))
  await applySavedSettings()
  process.stdout.write(`${JSON.stringify({ ok: true, result: { config } }, null, 2)}\n`)
}

function parseAssetMonitoringOption(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'enabled') return true
  if (value === 'disabled') return false
  throwUsage('asset monitoring must be enabled or disabled')
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
    process.stderr.write(
      `Warning: skipped ${options.marketId}: ${response.error ?? 'no net collateral gain'}\n`,
    )
    return
  }
  if (options.sweep && response.code === 'market-not-pending') {
    process.stderr.write(
      `Warning: skipped ${options.marketId}: ${response.error ?? 'market is not pending'}\n`,
    )
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
      printEngineHttpFailure(err)
      return
    }
    if (!isNetworkFailure(err) && !isTimeoutFailure(err)) throw err
    process.stderr.write(
      `Warning: engine read failed at ${globalEngineUrl}: ${errorMessage(err)}; falling back to daemon\n`,
    )
    await printDaemonResult(daemonCall())
  }
}

async function printPublicEngineResult<T>(
  engineCall: () => Promise<T>,
  toOutput: (result: T) => unknown | Promise<unknown> = (result) => result,
): Promise<void> {
  try {
    const result = await engineCall()
    process.stdout.write(`${JSON.stringify(await toOutput(result), null, 2)}\n`)
  } catch (err) {
    if (!isEngineHttpError(err)) throw err
    printEngineHttpFailure(err)
  }
}

function printEngineHttpFailure(error: EngineClientError): void {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: engineHttpErrorMessage(error) }, null, 2)}\n`,
  )
  process.exitCode = 1
}

async function fetchMarketListFromEngine(params: {
  search?: string
  limit?: number
  state?: QueryMarketsParams['state']
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
    tag: params.tag,
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
    fetchImpl: (input, init) =>
      fetch(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(DIRECT_ENGINE_READ_TIMEOUT_MS),
      }),
  })
}

function isEngineHttpError(value: unknown): value is EngineClientError {
  return (
    value instanceof EngineClientError ||
    (value instanceof Error && value.name === 'EngineClientError')
  )
}

function engineHttpErrorMessage(error: EngineClientError): string {
  return `engine returned HTTP ${error.status}${error.detail.length > 0 ? `: ${error.detail}` : ''}`
}

function isTimeoutFailure(value: unknown): boolean {
  return value instanceof Error && (value.name === 'TimeoutError' || value.name === 'AbortError')
}

async function readRemovalPreviewFile(path: string): Promise<WalletRemovePreview> {
  if (process.platform === 'win32')
    throw new Error('--preview-file requires supported owner-only file validation')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const metadata = await file.stat()
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > MAX_CASHU_TOKEN_FILE_BYTES
    )
      throw new Error('invalid preview file')
    const envelope: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedFile(file)),
    )
    if (
      !isPlainRecord(envelope) ||
      envelope.ok !== true ||
      !isPlainRecord(envelope.result) ||
      envelope.result.version !== 1 ||
      !Array.isArray(envelope.result.targets) ||
      envelope.result.targets.length < 1 ||
      envelope.result.targets.length > 256 ||
      typeof envelope.result.batchDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(envelope.result.batchDigest)
    ) {
      throw new Error('invalid preview')
    }
    return envelope.result as unknown as WalletRemovePreview
  } catch {
    throw new Error(
      '--preview-file must contain a successful exact removal preview in an owner-only bounded regular file',
    )
  } finally {
    await file.close()
  }
}

async function readPrivateTokenFile(path: string): Promise<string> {
  if (process.platform === 'win32') {
    throw new Error(
      '--token-file is not supported on Windows until ACL and reparse-point validation is available',
    )
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error('--token-file must name a regular file')
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error('--token-file must not be accessible by group or other users')
    }
    if (metadata.size > MAX_CASHU_TOKEN_FILE_BYTES) {
      throw new Error(`--token-file exceeds ${MAX_CASHU_TOKEN_FILE_BYTES} bytes`)
    }
    const token = (await readBoundedFile(file)).toString('utf8').trim()
    if (!token) throw new Error('--token-file was empty')
    return token
  } finally {
    await file.close()
  }
}

async function readOrderFeeConsentFile(path: string): Promise<OrderFeeConsent> {
  if (process.platform === 'win32') {
    throw new Error(
      '--fee-consent-file is not supported on Windows until reparse-point validation is available',
    )
  }

  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    throw new Error('--fee-consent-file must be a readable regular file, not a symbolic link')
  }

  try {
    let bytes: Buffer
    try {
      const metadata = await file.stat()
      if (!metadata.isFile()) {
        throw new Error('--fee-consent-file must name a regular file')
      }
      if (metadata.size > MAX_FEE_CONSENT_FILE_BYTES) {
        throw new Error(`--fee-consent-file exceeds ${MAX_FEE_CONSENT_FILE_BYTES} bytes`)
      }
      bytes = await readBoundedFeeConsentFile(file)
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith('--fee-consent-file must name') ||
          error.message.startsWith('--fee-consent-file exceeds'))
      ) {
        throw error
      }
      throw new Error('--fee-consent-file could not be read safely')
    }

    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const envelope: unknown = JSON.parse(text)
      if (
        !isPlainRecord(envelope) ||
        envelope.ok !== true ||
        !isPlainRecord(envelope.result) ||
        !isPlainRecord(envelope.result.request)
      ) {
        throw new Error('invalid order fee-preview envelope')
      }
      const feeFacts: CtfRangeOrderFeeFacts = decodeCtfRangeOrderFeeFacts(envelope.result.feeFacts)
      return {
        request: envelope.result.request as unknown as OrderFeeConsent['request'],
        feeFacts,
      }
    } catch {
      throw new Error(
        '--fee-consent-file must contain a successful order fee-preview JSON envelope',
      )
    }
  } finally {
    await file.close().catch(() => undefined)
  }
}

async function readLightningInvoiceFile(path: string): Promise<string> {
  if (process.platform === 'win32') {
    throw new Error(
      '--invoice-file is not supported on Windows until reparse-point validation is available',
    )
  }
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    throw new Error('--invoice-file must be a readable private regular file')
  }
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error('--invoice-file must be a regular file')
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error('--invoice-file must not be accessible by group or other users')
    }
    const bytes = await readBoundedLightningInvoiceFile(file)
    let invoice: string
    try {
      invoice = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
    } catch {
      throw new Error('--invoice-file must contain a valid BOLT11 invoice')
    }
    if (
      invoice.length === 0 ||
      invoice.length > MAX_LIGHTNING_INVOICE_FILE_BYTES ||
      /\s/.test(invoice)
    ) {
      throw new Error('--invoice-file must contain a valid BOLT11 invoice')
    }
    return invoice
  } finally {
    await file.close().catch(() => undefined)
  }
}

async function readWalletPaymentQuoteFile(path: string): Promise<WalletPaymentQuote> {
  if (process.platform === 'win32') {
    throw new Error(
      '--fee-consent-file is not supported on Windows until reparse-point validation is available',
    )
  }
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    throw new Error('--fee-consent-file must be a readable regular file, not a symbolic link')
  }
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error('--fee-consent-file must name a regular file')
    if (metadata.size > MAX_WALLET_PAYMENT_CONSENT_FILE_BYTES) {
      throw new Error(`--fee-consent-file exceeds ${MAX_WALLET_PAYMENT_CONSENT_FILE_BYTES} bytes`)
    }
    const bytes = await readBoundedWalletPaymentConsentFile(file)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const envelope: unknown = JSON.parse(text)
    if (
      !isPlainRecord(envelope) ||
      envelope.ok !== true ||
      !isWalletPaymentQuote(envelope.result)
    ) {
      throw new Error('invalid wallet payment quote envelope')
    }
    return envelope.result
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('--fee-consent-file must name') ||
        error.message.startsWith('--fee-consent-file exceeds'))
    ) {
      throw error
    }
    throw new Error('--fee-consent-file must contain a successful wallet pay quote JSON envelope')
  } finally {
    await file.close().catch(() => undefined)
  }
}

async function readScorePurchaseConsentFile(path: string): Promise<ScorePurchaseConsent> {
  if (process.platform === 'win32') {
    throw new Error(
      '--fee-consent-file is not supported on Windows until reparse-point validation is available',
    )
  }

  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    throw new Error('--fee-consent-file must be a readable regular file, not a symbolic link')
  }
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error('--fee-consent-file must name a regular file')
    if (metadata.size > MAX_FEE_CONSENT_FILE_BYTES) {
      throw new Error(`--fee-consent-file exceeds ${MAX_FEE_CONSENT_FILE_BYTES} bytes`)
    }
    const bytes = await readBoundedFeeConsentFile(file)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const envelope: unknown = JSON.parse(text)
    if (
      !isPlainRecord(envelope) ||
      envelope.ok !== true ||
      !isScorePurchaseConsent(envelope.result)
    ) {
      throw new Error('invalid Score purchase quote envelope')
    }
    return envelope.result
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('--fee-consent-file must name') ||
        error.message.startsWith('--fee-consent-file exceeds'))
    ) {
      throw error
    }
    throw new Error('--fee-consent-file must contain a successful score quote JSON envelope')
  } finally {
    await file.close().catch(() => undefined)
  }
}

async function readBoundedFeeConsentFile(file: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_FEE_CONSENT_FILE_BYTES + 1)
  let total = 0
  while (total < buffer.length) {
    const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
    if (bytesRead === 0) break
    total += bytesRead
  }
  if (total > MAX_FEE_CONSENT_FILE_BYTES) {
    throw new Error(`--fee-consent-file exceeds ${MAX_FEE_CONSENT_FILE_BYTES} bytes`)
  }
  return buffer.subarray(0, total)
}

async function readBoundedWalletPaymentConsentFile(
  file: Awaited<ReturnType<typeof open>>,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_WALLET_PAYMENT_CONSENT_FILE_BYTES + 1)
  let total = 0
  while (total < buffer.length) {
    const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
    if (bytesRead === 0) break
    total += bytesRead
  }
  if (total > MAX_WALLET_PAYMENT_CONSENT_FILE_BYTES) {
    throw new Error(`--fee-consent-file exceeds ${MAX_WALLET_PAYMENT_CONSENT_FILE_BYTES} bytes`)
  }
  return buffer.subarray(0, total)
}

async function readBoundedLightningInvoiceFile(
  file: Awaited<ReturnType<typeof open>>,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_LIGHTNING_INVOICE_FILE_BYTES + 1)
  let total = 0
  while (total < buffer.length) {
    const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
    if (bytesRead === 0) break
    total += bytesRead
  }
  if (total > MAX_LIGHTNING_INVOICE_FILE_BYTES) {
    throw new Error(`--invoice-file exceeds ${MAX_LIGHTNING_INVOICE_FILE_BYTES} bytes`)
  }
  return buffer.subarray(0, total)
}

async function readPrivateWalletSeedFile(path: string): Promise<string> {
  if (process.platform === 'win32') {
    throw new Error(
      '--wallet-seed-hex-file is not supported on Windows until ACL and reparse-point validation is available',
    )
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) {
      throw new Error('--wallet-seed-hex-file must name a regular file')
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error('--wallet-seed-hex-file must not be accessible by group or other users')
    }
    if (metadata.size > MAX_WALLET_SEED_FILE_BYTES) {
      throw new Error(`--wallet-seed-hex-file exceeds ${MAX_WALLET_SEED_FILE_BYTES} bytes`)
    }
    const seed = (await file.readFile('utf8')).trim()
    if (!/^[0-9a-f]{128}$/.test(seed)) {
      throw new Error('--wallet-seed-hex-file must contain exactly 128 lowercase hex characters')
    }
    return seed
  } finally {
    await file.close()
  }
}

async function readBoundedFile(file: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= MAX_CASHU_TOKEN_FILE_BYTES) {
    const remaining = MAX_CASHU_TOKEN_FILE_BYTES + 1 - total
    const buffer = Buffer.allocUnsafe(Math.min(TOKEN_FILE_READ_CHUNK_BYTES, remaining))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, total)
    if (bytesRead === 0) break
    chunks.push(buffer.subarray(0, bytesRead))
    total += bytesRead
  }
  if (total > MAX_CASHU_TOKEN_FILE_BYTES) {
    throw new Error(`--token-file exceeds ${MAX_CASHU_TOKEN_FILE_BYTES} bytes`)
  }
  return Buffer.concat(chunks, total)
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

function parseSafeIntegerOption(name: string): (value: string) => number {
  return (value: string) => {
    const raw = requiredArg(value, name)
    const parsed = Number(raw)
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
    throwUsage(`Invalid ${name}: ${raw}`)
  }
}

function parsePortfolioTimeframe(value: string | undefined): AssetMonitoringTimeframe | undefined {
  if (value === undefined) return undefined
  switch (value) {
    case '1D':
    case '1W':
    case '1M':
    case 'ALL':
      return value
    default:
      throwUsage(`Invalid portfolio timeframe: ${value}`)
  }
}

function parseAssetMonitoringPageSize(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const pageSize = parseSafeIntegerOption('page size')(value)
  if (pageSize > ASSET_MONITORING_ASSETS_MAX) {
    throwUsage(`Invalid page size: ${value} (must be 1..${ASSET_MONITORING_ASSETS_MAX})`)
  }
  return pageSize
}

function parseOrderWaitTimeout(value: string): number {
  const parsed = Number(value)
  if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_ORDER_WAIT_TIMEOUT_MS) {
    return parsed
  }
  throwUsage(`Invalid timeout ms: ${value} (must be 1..${MAX_ORDER_WAIT_TIMEOUT_MS})`)
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

function parsePositiveSatsToMsat(value: string | undefined): number {
  const raw = requiredArg(value, 'amount sats')
  try {
    const parsed = parseSatsToMsat(raw)
    if (parsed > 0) return parsed
  } catch {
    // Convert parser failures into the CLI's standard usage error below.
  }
  throwUsage(`Invalid amount sats: ${raw}`)
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

function parseMarketState(value: string): NonNullable<QueryMarketsParams['state']> {
  if (value === 'Open' || value === 'Closed' || value === 'All') return value
  throwUsage(`Invalid market state: ${value}`)
}

function parsePriceHistoryTimeframe(value: string): PriceHistoryTimeframe {
  switch (value) {
    case '1h':
    case '24h':
    case '7d':
    case '30d':
    case 'all':
      return value
    default:
      throwUsage(`Invalid market history timeframe: ${value}`)
  }
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

function parseMarketCreationOutcomeType(value: string): SupportedMarketCreationOutcomeType {
  if (value === 'yesno' || value === 'categorical') return value
  throwUsage(`Invalid market outcome type: ${value}`)
}

function parseMarketMaturityEpoch(value: string): number {
  const raw = requiredArg(value, 'maturity epoch')
  const parsed = Number(raw)
  if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_MARKET_CREATION_MATURITY_EPOCH) {
    return parsed
  }
  throwUsage(`Invalid maturity epoch: ${raw} (must be a positive U32)`)
}

function parseSafeNonNegativeIntegerOption(name: string): (value: string) => number {
  return (value: string) => {
    const raw = requiredArg(value, name)
    const parsed = Number(raw)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
    throwUsage(`Invalid ${name}: ${raw}`)
  }
}

function collectRepeatedOption(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

function requireNonEmptyCliValue(value: string, name: string): string {
  if (value.trim().length === 0) throwUsage(`${name} must not be empty.`)
  return value
}

function nativeMarketCreationInput(options: MarketCreateOptions): MarketCreationInput {
  const outcomeType =
    options.outcomeType ??
    (options.outcomes.length === 2 && options.outcomes[0] === 'Yes' && options.outcomes[1] === 'No'
      ? 'yesno'
      : 'categorical')
  const colors = new Map<string, string>()
  for (const entry of options.outcomeColor ?? []) {
    const separator = entry.indexOf('=')
    const name = separator < 0 ? '' : entry.slice(0, separator)
    const color = separator < 0 ? '' : entry.slice(separator + 1)
    if (name.length === 0 || !/^#[0-9A-Fa-f]{6}$/.test(color)) {
      throwUsage(`Invalid outcome color: ${entry} (expected name=#RRGGBB)`)
    }
    if (!options.outcomes.includes(name)) {
      throwUsage(`Outcome color does not match an outcome: ${name}`)
    }
    if (colors.has(name)) throwUsage(`Outcome color was supplied more than once: ${name}`)
    colors.set(name, color)
  }
  if (outcomeType === 'yesno' && colors.size > 0) {
    throwUsage('Outcome colors are supported only for categorical markets.')
  }
  if (options.maturityEpoch === undefined) {
    throwUsage('Native market creation requires --maturity-epoch.')
  }

  const normalized = normalizeMarketCreationInput({
    title: options.title,
    description: options.description,
    outcomeType,
    outcomeDetails: options.outcomes.map((name) => ({
      name,
      ...(colors.has(name) ? { color: colors.get(name)! } : {}),
    })),
    maturityEpoch: options.maturityEpoch,
    categoryTags: options.tag ?? [],
    baseAsset: 'sat',
  })
  return {
    title: normalized.metadata.title,
    description: normalized.metadata.description,
    outcomeType: normalized.metadata.outcomeType,
    outcomeDetails: normalized.metadata.outcomes,
    maturityEpoch: normalized.maturityEpoch,
    categoryTags: normalized.metadata.categoryTags,
    baseAsset: normalized.metadata.baseAsset,
  }
}

async function ensureTrustedAuthedEngineUrl(trustEngineUrl: boolean): Promise<void> {
  if (globalEngineUrl === undefined) return
  validateAuthedEngineUrl(globalEngineUrl)

  const config = readConfig()
  const normalizedEngineUrl = normalizeEndpointUrl(globalEngineUrl, 'trusted engine URL')
  if (config.trustedEngineUrls.includes(normalizedEngineUrl)) return
  if (!trustEngineUrl) {
    const confirmed = await confirmEngineUrlTrust(globalEngineUrl)
    if (!confirmed) {
      throwValidation(`Engine URL was not trusted: ${globalEngineUrl}`)
    }
  }
  updateConfig((current) => ({
    ...current,
    trustedEngineUrls: Array.from(new Set([...current.trustedEngineUrls, normalizedEngineUrl])),
  }))
}

function validateAuthedEngineUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throwValidation(`Invalid engine URL: ${value}`)
  }
  const validation = validateMarketCreateEngineUrl(url.toString(), true)
  if (validation.ok) return
  throwValidation(
    `Refusing insecure engine URL for market create: ${value}. Use https:// or a loopback URL.`,
  )
}

async function confirmEngineUrlTrust(engineUrl: string): Promise<boolean> {
  process.stderr.write(`About to use engine URL for authenticated market create: ${engineUrl}\n`)
  if (!process.stdin.isTTY) {
    throwValidation(
      'Refusing to trust a new engine URL without --trust-engine-url in non-interactive mode',
    )
  }
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question('Trust this engine URL? Type yes to continue: ')
    return answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

async function parseOracleAttestationOption(
  value: string,
): Promise<MarketCloseParams['attestationEvent']> {
  const fromFile = value.startsWith('@')
  const raw = fromFile ? await readAttestationFile(value.slice(1)) : value
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    if (fromFile) {
      throwValidation(
        `Oracle attestation file is not valid JSON (first 80 chars: ${firstChars(raw, 80)})`,
      )
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

async function readOracleExplanationOption(value: string): Promise<string> {
  let content = value
  if (value.startsWith('@')) {
    const path = value.slice(1)
    if (!path || pathContainsParentTraversal(path))
      throwValidation('Explanation @file path is invalid.')
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(path, 'r')
      const bytes = Buffer.alloc(ORACLE_EXPLANATION_UTF8_BYTES_MAX + 1)
      const info = await file.stat()
      if (!info.isFile() || info.size > ORACLE_EXPLANATION_UTF8_BYTES_MAX) throw new Error()
      let count = 0
      while (count < bytes.length) {
        const { bytesRead } = await file.read(bytes, count, bytes.length - count, null)
        if (bytesRead === 0) break
        count += bytesRead
      }
      if (count > ORACLE_EXPLANATION_UTF8_BYTES_MAX) throw new Error()
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, count),
      )
    } catch {
      throwValidation('Explanation file is invalid or exceeds 4096 UTF-8 bytes.')
    } finally {
      await file?.close()
    }
  }
  try {
    assertOracleExplanationText(content)
  } catch {
    throwValidation('Explanation must be non-empty and at most 4096 UTF-8 bytes.')
  }
  return content
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
    ['--experimental-strip-types', daemonMain, `--datadir=${dataDir()}`, ...args],
    { env: process.env },
  )
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
}
