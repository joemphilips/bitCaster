#!/usr/bin/env node

import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  isLoopbackHttpUrl,
} from '@bitcaster-market/client-sdk'
import { assertDaemonProfileStorageComplete, profileDir } from './profile.ts'
import { createDaemonSecrets, createDaemonSecretsFromImport } from './secrets.ts'
import { bootstrapFreshDaemonProfile } from './profileBootstrap.ts'
import type { CtfRangeRecoveryLoop } from './ctfRangeRecoveryLoop.ts'
import { configureDataDir } from './dataDir.ts'
import { freezeNativeConfigAtStartup, readNativeConfig } from './nativeConfig.ts'

const MAX_SECRET_HEX_FILE_BYTES = 256
const SECRET_FILE_READ_CHUNK_BYTES = 128

const { command, args, dataDir } = parseInvocation(process.argv.slice(2))
configureDataDir(dataDir)

switch (command) {
  case 'init': {
    const initOptions = parseInitOptions(args)
    const config = readNativeConfig(true).config
    const importedSecrets = await resolveImportedSecrets(initOptions)
    const secrets =
      importedSecrets === null
        ? createDaemonSecrets()
        : createDaemonSecretsFromImport({
            walletSeedHex: importedSecrets.walletSeedHex,
            nostrSecretKeyHex: importedSecrets.nostrSecretKeyHex,
          })
    await bootstrapFreshDaemonProfile({
      directory: profileDir(),
      engineBaseUrl: config.daemon.engineUrl,
      mintUrl: config.daemon.mintUrl,
      walletSeedHex: secrets.walletSeedHex,
      nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      nostrPublicKeyHex: secrets.nostrPublicKeyHex,
      passphrase: process.env.BITCASTER_DAEMON_PASSPHRASE || undefined,
    })
    process.stdout.write('bitcaster-daemon profile initialized\n')
    break
  }
  case 'recover-seed': {
    const options = parseRecoverSeedOptions(args)
    const { runOfflineDaemonSeedRecovery } = await import('./emergencySeedRecovery.ts')
    const result = await runOfflineDaemonSeedRecovery(options)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    break
  }
  case 'run': {
    const nativeConfig = freezeNativeConfigAtStartup().config
    await assertDaemonProfileStorageComplete()
    const { acquireDaemonRunLock } = await import('./runLock.ts')
    const { startDaemonServer } = await import('./server.ts')
    const { CompositeTradeRuntimeConnection, DaemonTradeRuntime } =
      await import('./tradeRuntime.ts')
    const { SignalRTradeHubConnection } = await import('./tradeHubConnection.ts')
    const { SignalRMarketHubConnection } = await import('./marketHubConnection.ts')
    const { DaemonSwapExecutor } = await import('./swapExecutor.ts')
    const { createRealDaemonSwapOps } = await import('./swapProtocolAdapter.ts')
    const { readProfile } = await import('./profile.ts')
    const { readSecrets } = await import('./secrets.ts')
    const { recoverPreparedWalletSends } = await import('./walletOps.ts')
    const { recoverWalletProofConsolidations } = await import('./walletProofConsolidation.ts')
    const { recoverCompleteSetSplits } = await import('./completeSetConversion.ts')
    const { composeStartupCustodyRecovery, createCustodyReadinessTracker } =
      await import('./startupRecovery.ts')
    const { DaemonCtfRangeOrderCoordinator } = await import('./ctfRangeOrderCoordinator.ts')
    const { createCtfRangeRecoveryLoop } = await import('./ctfRangeRecoveryLoop.ts')
    const { resumeDaemonConditionRetirements, retireResolvedDaemonConditions } =
      await import('./managedConditionRetirement.ts')
    const { BitcasterEngineClient } = await import('@bitcaster-market/client-sdk/engineClient')
    const { signNip98 } = await import('./nostrAuth.ts')
    const { ensureState, recordSwapMessage, recordTradeCreated, recordTradeStateChanged } =
      await import('./state.ts')
    const runLock = await acquireDaemonRunLock()
    const profile = await readProfile()
    const secrets = await readSecrets()
    if (!profile || !secrets) {
      await runLock.release()
      throw new Error('daemon profile storage is incomplete')
    }
    const walletId = deriveDurableCustodyWalletId(Buffer.from(secrets.walletSeedHex, 'hex'))
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId,
    })
    const {
      claimCustodyScopeLease,
      renewCustodyScopeLease,
      releaseCustodyScopeLease,
      CUSTODY_SCOPE_RENEW_INTERVAL_MS,
    } = await import('./profileFencing.ts')
    let fence: Awaited<ReturnType<typeof claimCustodyScopeLease>>
    try {
      fence = await claimCustodyScopeLease(profileDir(), {
        scopeId,
        incarnationId: randomUUID(),
        observedAtMs: Date.now(),
      })
    } catch (error) {
      await runLock.release()
      throw error
    }
    let renewal: LeaseRenewal | undefined
    let rangeRecoveryLoop: CtfRangeRecoveryLoop | undefined
    let assetMonitoring: { start(): void; stop(): void } | undefined
    let assetMonitoringStarting = false
    let retirementRetryTimer: NodeJS.Timeout | undefined
    let leaseFailure: Error | undefined
    let shutdown: ((reason: string, exitCode?: number) => Promise<void>) | undefined
    const currentFence = () => {
      if (leaseFailure !== undefined) throw leaseFailure
      return fence
    }
    let resourcesReleased = false
    const releaseResources = async () => {
      if (resourcesReleased) return
      resourcesReleased = true
      renewal?.stop()
      rangeRecoveryLoop?.stop()
      assetMonitoring?.stop()
      if (retirementRetryTimer !== undefined) clearTimeout(retirementRetryTimer)
      try {
        await releaseCustodyScopeLease(profileDir(), fence, Date.now())
      } finally {
        await runLock.release()
      }
    }
    renewal = startLeaseRenewal({
      intervalMs: CUSTODY_SCOPE_RENEW_INTERVAL_MS,
      renew: async () => {
        fence = await renewCustodyScopeLease(profileDir(), currentFence(), Date.now())
      },
      onFailure: (error) => {
        leaseFailure = error
        process.stderr.write(`custody lease renewal failed: ${error.message}\n`)
        if (shutdown !== undefined) void shutdown('custody lease loss', 1)
      },
    })
    let executor: InstanceType<typeof DaemonSwapExecutor> | undefined
    let runtime: InstanceType<typeof DaemonTradeRuntime> | undefined
    const retirementEngine = new BitcasterEngineClient({
      baseUrl: profile.engineBaseUrl,
      authorization: ({ url, method, bodyText, payloadHash }) =>
        signNip98({ privateKeyHex: secrets.nostrSecretKeyHex }, url, method, bodyText, payloadHash),
    })
    const runAutomaticRetirementScan = async () => {
      const resumed = await resumeDaemonConditionRetirements({
        profile,
        secrets,
        fence: currentFence(),
        walletDependencies: { getCustodyFence: currentFence },
      })
      if (!nativeConfig.daemon.autoRetireResolvedConditionInventory) return resumed
      const discovered = await retireResolvedDaemonConditions({
        profile,
        secrets,
        fence: currentFence(),
        engine: retirementEngine,
        walletDependencies: { getCustodyFence: currentFence },
      })
      return mergeRetirementResults(resumed, discovered)
    }
    let wakeManagedConditionRetirements = async () => {
      await runAutomaticRetirementScan()
    }
    const tradeHub =
      profile && secrets
        ? new SignalRTradeHubConnection({
            engineBaseUrl: profile.engineBaseUrl,
            nostrSecretKeyHex: secrets.nostrSecretKeyHex,
            onTradeCreated: async (payload) => {
              const swap = await recordTradeCreated(payload)
              if (swap) {
                await runtime?.start(await ensureState())
              }
              await executor?.onTradeCreated(swap)
            },
            onSwapMessageReceived: async (tradeId, messageType, ciphertext) => {
              await executor?.onSwapMessage(
                await recordSwapMessage(tradeId, messageType, ciphertext),
              )
            },
            onTradeStateChanged: async (tradeId, newState) => {
              await executor?.onTradeStateChanged(await recordTradeStateChanged(tradeId, newState))
            },
            onPendingPubkeyRequired: async (tradeId, _orderId, _role, marketId, _deadline) => {
              const { signNip98 } = await import('./nostrAuth.ts')
              const { conditionIdFromMarketId } =
                await import('@bitcaster-market/client-sdk/tradeIgnition')
              const { generateOrderEphemeralKeypair } = await import('./ephemeralKey.ts')
              const { submitEphemeralPubkey: submitPubkey } =
                await import('@bitcaster-market/client-sdk/engineClient')
              const keypair = generateOrderEphemeralKeypair()
              type AuthorizationRequest = {
                url: string
                method: string
                bodyText?: string
                payloadHash?: string
              }
              await submitPubkey(
                profile.engineBaseUrl,
                tradeId,
                keypair.publicKeyHex,
                null,
                fetch,
                async ({ url, method, bodyText, payloadHash }: AuthorizationRequest) =>
                  signNip98(
                    { privateKeyHex: secrets.nostrSecretKeyHex },
                    url,
                    method,
                    bodyText,
                    payloadHash,
                  ),
                conditionIdFromMarketId(marketId),
              )
            },
            onRangeSettlementChanged: () => {
              rangeRecoveryLoop?.trigger()
            },
            onReconnected: () => {
              rangeRecoveryLoop?.trigger()
            },
            onError: (err: Error) => {
              process.stderr.write(`TradeHub event error: ${err.message}\n`)
            },
          })
        : undefined
    const marketHub =
      profile && secrets
        ? new SignalRMarketHubConnection({
            engineBaseUrl: profile.engineBaseUrl,
            nostrSecretKeyHex: secrets.nostrSecretKeyHex,
            onMarketStatusChanged: async (status) => {
              if (
                status.state !== 'closed' ||
                !nativeConfig.daemon.autoRetireResolvedConditionInventory
              ) {
                return
              }
              await wakeManagedConditionRetirements()
            },
            onReconnected: async () => {
              await wakeManagedConditionRetirements()
            },
            onError: (err: Error) => {
              process.stderr.write(`MarketHub event error: ${err.message}\n`)
            },
          })
        : undefined
    const runtimeConnection = tradeHub
      ? new CompositeTradeRuntimeConnection(tradeHub, marketHub)
      : undefined
    executor = tradeHub
      ? new DaemonSwapExecutor({
          connection: tradeHub,
          ops: createRealDaemonSwapOps(),
          walletOpsDeps: { getCustodyFence: currentFence },
        })
      : undefined
    runtime = runtimeConnection
      ? new DaemonTradeRuntime(runtimeConnection, {
          scheduleResumeActiveSwaps: (delayMs) => {
            setTimeout(() => {
              void (async () => {
                await executor?.resumeActiveSwaps(await ensureState())
              })().catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err)
                process.stderr.write(`Swap recovery sweep failed: ${message}\n`)
              })
            }, delayMs)
          },
        })
      : undefined
    try {
      const rangeOrderCoordinator = new DaemonCtfRangeOrderCoordinator(profileDir(), currentFence, {
        allowInsecureLoopbackHttp: isLoopbackHttpUrl(profile.mintUrl),
      })
      const rangeRecoveryClient = new BitcasterEngineClient({
        baseUrl: profile.engineBaseUrl,
        authorization: ({ url, method, bodyText, payloadHash }) =>
          signNip98(
            { privateKeyHex: secrets.nostrSecretKeyHex },
            url,
            method,
            bodyText,
            payloadHash,
          ),
      })
      const logRangeRecovery = (result: {
        readonly recovered: readonly string[]
        readonly pending: ReadonlyArray<{ readonly operationId: string; readonly error: string }>
      }) => {
        if (result.recovered.length > 0) {
          process.stderr.write(`Recovered range operations: ${result.recovered.join(', ')}\n`)
        }
        for (const pending of result.pending) {
          process.stderr.write(
            `Range operation ${pending.operationId} remains pending: ${pending.error}\n`,
          )
        }
      }
      const recoverRangeOrders = () =>
        rangeOrderCoordinator.recover(secrets.walletSeedHex, rangeRecoveryClient)
      const initialRangeRecovery = await recoverRangeOrders()
      logRangeRecovery(initialRangeRecovery)
      rangeRecoveryLoop = createCtfRangeRecoveryLoop({
        recover: recoverRangeOrders,
        onResult: (result) => {
          logRangeRecovery(result)
          void wakeManagedConditionRetirements().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            process.stderr.write(`Condition retirement wake failed: ${message}\n`)
          })
        },
        onError: (error: Error) => {
          process.stderr.write(`Range recovery sweep failed: ${error.message}\n`)
        },
      })
      rangeRecoveryLoop.accept(initialRangeRecovery)
      const consolidationRecovery = await recoverWalletProofConsolidations({
        secrets,
        mutation: () => ({ fence: currentFence(), observedAtMs: Date.now() }),
      })
      const walletRecovery = await recoverPreparedWalletSends(secrets, {
        getCustodyFence: currentFence,
      })
      const completeSetRecovery = await recoverCompleteSetSplits({
        secrets,
        deps: { getCustodyFence: currentFence },
      })
      const nonRetirementRecovery = composeStartupCustodyRecovery([
        consolidationRecovery,
        walletRecovery,
        completeSetRecovery,
      ])
      const retirementRecovery = await runAutomaticRetirementScan()
      const pendingRetirements = retirementRecovery
        .filter((entry) => entry.error !== null)
        .map((entry) => ({
          operationId: `condition-retirement:${entry.conditionId}`,
          error: entry.error!,
        }))
      const startupRecovery = composeStartupCustodyRecovery([
        nonRetirementRecovery,
        { recovered: [], pending: pendingRetirements },
      ])
      const pendingWalletOperations = startupRecovery.pending
      const readiness = createCustodyReadinessTracker({
        nonRetirementPending: nonRetirementRecovery.pending.length > 0,
        retirementPending: pendingRetirements.length > 0,
      })
      const startAssetMonitoringWhenReady = async () => {
        if (
          !nativeConfig.daemon.assetMonitoringEnabled ||
          !readiness.isReady() ||
          assetMonitoring ||
          assetMonitoringStarting
        )
          return
        assetMonitoringStarting = true
        try {
          const { createDaemonAssetMonitoring } = await import('./assetMonitoring.ts')
          assetMonitoring = createDaemonAssetMonitoring({
            directory: profileDir(),
            scopeId,
            walletId,
            engineBaseUrl: profile.engineBaseUrl,
            remote: retirementEngine,
          })
          assetMonitoring.start()
        } finally {
          assetMonitoringStarting = false
        }
      }
      if (!readiness.isReady()) {
        const pendingSample = pendingWalletOperations
          .slice(0, 64)
          .map(({ operationId }) => operationId)
        process.stderr.write(`Wallet recovery remains pending for ${pendingSample.join(', ')}\n`)
      }
      if (startupRecovery.recoveredCount > 0) {
        process.stderr.write(
          `Recovered ${startupRecovery.recoveredCount} wallet operations: ${startupRecovery.recovered.join(', ')}\n`,
        )
      }
      let runtimeStarted = false
      const startRuntimeWhenReady = async () => {
        if (!readiness.isReady() || runtimeStarted || !runtime) return
        runtimeStarted = true
        const state = await ensureState()
        if (nativeConfig.daemon.autoRetireResolvedConditionInventory && marketHub) {
          await trackManagedConditionMarkets(marketHub, state)
        }
        await runtime.start(state)
        await executor?.resumeActiveSwaps(state)
      }
      const markCustodyReady = () => {
        void startAssetMonitoringWhenReady().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`asset-monitoring startup failed: ${message}\n`)
        })
        void startRuntimeWhenReady().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`bitcaster-daemon trade runtime start failed: ${message}\n`)
        })
      }
      const scheduleRetirementRetry = () => {
        if (retirementRetryTimer !== undefined) return
        retirementRetryTimer = setTimeout(() => {
          retirementRetryTimer = undefined
          void wakeManagedConditionRetirements().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            process.stderr.write(`Condition retirement retry failed: ${message}\n`)
          })
        }, 30_000)
        retirementRetryTimer.unref()
      }
      wakeManagedConditionRetirements = async () => {
        const generation = readiness.beginAutomaticRetirementScan()
        try {
          const retirements = await runAutomaticRetirementScan()
          const pending = retirements.filter((entry) => entry.error !== null)
          if (!readiness.completeAutomaticRetirementScan(generation, pending.length > 0)) return
          if (pending.length > 0) {
            for (const entry of pending) {
              process.stderr.write(
                `Condition retirement ${entry.conditionId} remains pending: ${entry.error}\n`,
              )
            }
            scheduleRetirementRetry()
            return
          }
          if (retirementRetryTimer !== undefined) {
            clearTimeout(retirementRetryTimer)
            retirementRetryTimer = undefined
          }
          if (readiness.isReady()) markCustodyReady()
        } catch (error) {
          if (readiness.completeAutomaticRetirementScan(generation, true)) scheduleRetirementRetry()
          throw error
        }
      }
      if (pendingRetirements.length > 0) scheduleRetirementRetry()
      currentFence()
      const server = await startDaemonServer({
        tradeRuntime: runtime,
        startTradeRuntime: false,
        swapExecutor: executor,
        prepareSettlementCapability: (input, client) =>
          rangeOrderCoordinator.prepare(input, client),
        triggerSettlementRecovery: () => rangeRecoveryLoop?.trigger(),
        getCustodyFence: currentFence,
        isCustodyReady: () => readiness.isReady(),
        markCustodyReady,
        onManualCustodyRecoveryStatus: (status) => {
          readiness.updateManualRecovery(status)
          if (readiness.isReady()) markCustodyReady()
        },
        onOutcomeProofsReceived: async (conditionId, outcomeSetId) => {
          if (!nativeConfig.daemon.autoRetireResolvedConditionInventory || !marketHub) return
          try {
            await trackManagedConditionMarket(marketHub, conditionId, outcomeSetId)
            await wakeManagedConditionRetirements()
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            process.stderr.write(`Condition retirement rescan failed: ${message}\n`)
          }
        },
      })
      try {
        currentFence()
        shutdown = installShutdownHandlers(server, runtime, releaseResources)
      } catch (error) {
        await closeServer(server)
        throw error
      }
      void startRuntimeWhenReady().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(
          `bitcaster-daemon trade runtime start failed; RPC will remain available: ${message}\n`,
        )
      })
      if (readiness.isReady()) markCustodyReady()
    } catch (err) {
      await releaseResources().catch(() => undefined)
      throw err
    }
    break
  }
  default:
    process.stderr.write(`Unknown command: ${command}\n`)
    process.stderr.write(`Usage:
  bitcaster-daemon [--datadir <path>] init [--wallet-seed-hex-file <path>]
                         [--nostr-secret-key-hex-file <path>]
  bitcaster-daemon [--datadir <path>] recover-seed --wallet-seed-hex-file <path>
                         --recovery-id <id> --mint <url> --unit <sat|msat>
                         --keyset-id <id> --acknowledge-seed-disclosure
  bitcaster-daemon [--datadir <path>] run
`)
    process.exitCode = 1
}

function parseRecoverSeedOptions(args: readonly string[]): {
  recoveryId: string
  mintUrl: string
  unit: 'sat' | 'msat'
  keysetId: string
  walletSeedHexFile: string
  disclosureAcknowledged: true
} {
  let recoveryId: string | undefined
  let mintUrl: string | undefined
  let unit: 'sat' | 'msat' | undefined
  let keysetId: string | undefined
  let walletSeedHexFile: string | undefined
  let disclosureAcknowledged = false
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option === '--acknowledge-seed-disclosure') {
      disclosureAcknowledged = true
      continue
    }
    const value = requiredArg(args[++index], option ?? 'recover-seed option')
    if (option === '--recovery-id') recoveryId = value
    else if (option === '--mint') mintUrl = value
    else if (option === '--unit' && (value === 'sat' || value === 'msat')) unit = value
    else if (option === '--keyset-id') keysetId = value
    else if (option === '--wallet-seed-hex-file') walletSeedHexFile = value
    else throw new Error(`Unknown recover-seed option: ${option}`)
  }
  if (!disclosureAcknowledged) {
    throw new Error('recover-seed requires --acknowledge-seed-disclosure')
  }
  if (unit === undefined) throw new Error('recover-seed unit must be sat or msat')
  return {
    recoveryId: requiredArg(recoveryId, '--recovery-id'),
    mintUrl: requiredArg(mintUrl, '--mint'),
    unit,
    keysetId: requiredArg(keysetId, '--keyset-id'),
    walletSeedHexFile: requiredArg(walletSeedHexFile, '--wallet-seed-hex-file'),
    disclosureAcknowledged: true,
  }
}

function parseInvocation(argv: string[]): {
  command: string
  args: string[]
  dataDir?: string
} {
  const args = [...argv]
  let dataDir: string | undefined
  if (args[0]?.startsWith('--datadir=')) {
    dataDir = requiredArg(args[0].slice('--datadir='.length), '--datadir')
    args.splice(0, 1)
  } else if (args[0] === '--datadir') {
    dataDir = requiredArg(args[1], '--datadir')
    args.splice(0, 2)
  }
  return {
    command: args.shift() ?? 'run',
    args,
    ...(dataDir === undefined ? {} : { dataDir }),
  }
}

function mergeRetirementResults(
  ...groups: ReadonlyArray<ReadonlyArray<{ conditionId: string; error: string | null }>>
): Array<{ conditionId: string; error: string | null }> {
  const results = new Map<string, string | null>()
  for (const group of groups) {
    for (const entry of group) {
      results.set(entry.conditionId, entry.error)
    }
  }
  return [...results]
    .map(([conditionId, error]) => ({ conditionId, error }))
    .sort((left, right) => left.conditionId.localeCompare(right.conditionId))
}

async function trackManagedConditionMarkets(
  hub: { trackMarket(marketId: string): Promise<void> },
  state: {
    readonly wallet: {
      readonly proofs: ReadonlyArray<{
        readonly asset:
          | { readonly kind: 'sats' }
          | {
              readonly kind: 'Outcome'
              readonly conditionId: string
              readonly outcomeSetId: string
            }
      }>
    }
  },
): Promise<void> {
  const marketIds = new Set<string>()
  for (const proof of state.wallet.proofs) {
    if (proof.asset.kind !== 'Outcome') continue
    for (const outcome of proof.asset.outcomeSetId.split('|')) {
      if (outcome.length > 0) marketIds.add(`${proof.asset.conditionId}-${outcome}`)
    }
  }
  for (const marketId of [...marketIds].sort()) await hub.trackMarket(marketId)
}

async function trackManagedConditionMarket(
  hub: { trackMarket(marketId: string): Promise<void> },
  conditionId: string,
  outcomeSetId: string,
): Promise<void> {
  for (const outcome of outcomeSetId
    .split('|')
    .filter((value) => value.length > 0)
    .sort()) {
    await hub.trackMarket(`${conditionId}-${outcome}`)
  }
}

function parseInitOptions(args: string[]): {
  walletSeedHexFile?: string
  nostrSecretKeyHexFile?: string
} {
  const options: {
    walletSeedHexFile?: string
    nostrSecretKeyHexFile?: string
  } = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--wallet-seed-hex-file') {
      options.walletSeedHexFile = requiredArg(args[++i], '--wallet-seed-hex-file')
    } else if (arg === '--nostr-secret-key-hex-file') {
      options.nostrSecretKeyHexFile = requiredArg(args[++i], '--nostr-secret-key-hex-file')
    } else {
      throw new Error(`Unknown init option: ${arg}`)
    }
  }
  return options
}

async function resolveImportedSecrets(options: {
  walletSeedHexFile?: string
  nostrSecretKeyHexFile?: string
}): Promise<{ walletSeedHex: string; nostrSecretKeyHex: string } | null> {
  const walletSeedHex = options.walletSeedHexFile
    ? await readSecretHexFile(options.walletSeedHexFile, '--wallet-seed-hex-file')
    : undefined
  const nostrSecretKeyHex = options.nostrSecretKeyHexFile
    ? await readSecretHexFile(options.nostrSecretKeyHexFile, '--nostr-secret-key-hex-file')
    : undefined
  if (!walletSeedHex && !nostrSecretKeyHex) return null
  if (!walletSeedHex || !nostrSecretKeyHex) {
    throw new Error(
      '--wallet-seed-hex-file and --nostr-secret-key-hex-file must be supplied together',
    )
  }
  return { walletSeedHex, nostrSecretKeyHex }
}

async function readSecretHexFile(path: string, option: string): Promise<string> {
  if (process.platform === 'win32') {
    throw new Error(
      `${option} is not supported on Windows until ACL and reparse-point validation is available`,
    )
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error(`${option} must name a regular file`)
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(`${option} must not be accessible by group or other users`)
    }
    if (metadata.size > MAX_SECRET_HEX_FILE_BYTES) {
      throw new Error(`${option} exceeds ${MAX_SECRET_HEX_FILE_BYTES} bytes`)
    }
    const value = (await readBoundedSecretFile(file, option)).toString('utf8').trim()
    if (!value) throw new Error(`${option} was empty`)
    return value
  } finally {
    await file.close()
  }
}

async function readBoundedSecretFile(
  file: Awaited<ReturnType<typeof open>>,
  option: string,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= MAX_SECRET_HEX_FILE_BYTES) {
    const remaining = MAX_SECRET_HEX_FILE_BYTES + 1 - total
    const buffer = Buffer.allocUnsafe(Math.min(SECRET_FILE_READ_CHUNK_BYTES, remaining))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, total)
    if (bytesRead === 0) break
    chunks.push(buffer.subarray(0, bytesRead))
    total += bytesRead
  }
  if (total > MAX_SECRET_HEX_FILE_BYTES) {
    throw new Error(`${option} exceeds ${MAX_SECRET_HEX_FILE_BYTES} bytes`)
  }
  return Buffer.concat(chunks, total)
}

function requiredArg(value: string | undefined, option: string): string {
  if (value) return value
  throw new Error(`Missing value for ${option}`)
}

function installShutdownHandlers(
  server: Server,
  runtime: { stop(): Promise<void> } | undefined,
  releaseRunLock: () => Promise<void>,
): (reason: string, exitCode?: number) => Promise<void> {
  let shuttingDown = false
  const shutdown = async (reason: string, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write(`bitcaster-daemon received ${reason}, shutting down\n`)
    try {
      await closeServer(server)
      await runtime?.stop()
      await releaseRunLock()
      process.exit(exitCode)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`bitcaster-daemon shutdown failed: ${message}\n`)
      process.exit(1)
    }
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  return shutdown
}

interface LeaseRenewal {
  stop(): void
}

function startLeaseRenewal(input: {
  readonly intervalMs: number
  readonly renew: () => Promise<void>
  readonly onFailure: (error: Error) => void
}): LeaseRenewal {
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => void tick(), input.intervalMs)
    timer.unref()
  }
  const tick = async () => {
    try {
      await input.renew()
      schedule()
    } catch (error) {
      input.onFailure(error instanceof Error ? error : new Error(String(error)))
    }
  }
  schedule()
  return {
    stop: () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
