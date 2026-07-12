#!/usr/bin/env node

import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  assertDaemonProfileStorageComplete,
  bootstrapDaemonProfile,
  profileFromPublicKey,
} from './profile.ts'
import { createRpcToken, readRpcToken } from './rpcAuth.ts'
import {
  assertStoredSecretsHaveNoEphemeralKeysForIdentityReplacement,
  createDaemonSecrets,
  createDaemonSecretsFromImport,
  encodeDaemonSecretsForStorage,
  readSecrets,
} from './secrets.ts'
import {
  assertStoredDaemonStateIsEmptyForIdentityReplacement,
  emptyDaemonState,
  encodeDaemonStateForStorage,
} from './state.ts'
import type { DaemonDurableTradeRecoveryRunner } from './durableTradeRecovery.ts'

const [, , command = 'run', ...args] = process.argv

switch (command) {
  case 'init': {
    const { acquireDaemonRunLock } = await import('./runLock.ts')
    const initLock = await acquireDaemonRunLock()
    try {
      const initOptions = parseInitOptions(args)
      const importedSecrets = await resolveImportedSecrets(initOptions)
      let secrets
      if (importedSecrets) {
        if ((await readSecrets()) && !initOptions.force) {
          throw new Error('daemon secrets already exist; pass --force to replace them')
        }
        secrets = createDaemonSecretsFromImport({
          walletSeedHex: importedSecrets.walletSeedHex,
          nostrSecretKeyHex: importedSecrets.nostrSecretKeyHex,
        })
      } else {
        secrets = (await readSecrets()) ?? createDaemonSecrets()
      }
      await bootstrapDaemonProfile({
        profile: profileFromPublicKey(secrets.nostrPublicKeyHex, {
          engineBaseUrl: initOptions.engineUrl,
          mintUrl: initOptions.mintUrl,
        }),
        secretsPayload: encodeDaemonSecretsForStorage(secrets),
        statePayload: encodeDaemonStateForStorage(emptyDaemonState()),
        rpcToken: createRpcToken(),
        replaceExisting: Boolean(importedSecrets && initOptions.force),
        assertReplacementSafe: (database) => {
          assertStoredDaemonStateIsEmptyForIdentityReplacement(database)
          assertStoredSecretsHaveNoEphemeralKeysForIdentityReplacement(database)
        },
      })
      process.stdout.write('bitcaster-daemon profile initialized\n')
    } finally {
      await initLock.release()
    }
    break
  }
  case 'run': {
    await assertDaemonProfileStorageComplete()
    const { acquireDaemonRunLock } = await import('./runLock.ts')
    const {
      startDaemonServer,
      submitPendingEphemeralPubkeys,
      createAuthenticatedBitcasterEngineClient,
    } = await import('./server.ts')
    const { CompositeTradeRuntimeConnection, DaemonTradeRuntime } = await import('./tradeRuntime.ts')
    const { SignalRTradeHubConnection } = await import('./tradeHubConnection.ts')
    const { SignalRMarketHubConnection } = await import('./marketHubConnection.ts')
    const { DaemonSwapExecutor } = await import('./swapExecutor.ts')
    const { createDaemonDurableTradeRecoveryRunner } = await import('./durableTradeRecovery.ts')
    const { DaemonTakerFillRecovery } = await import('./takerFillRecovery.ts')
    const { createRealDaemonSwapOps } = await import('./swapProtocolAdapter.ts')
    const { readProfile } = await import('./profile.ts')
    const { readSecrets } = await import('./secrets.ts')
    const { recoverPreparedWalletSends } = await import('./walletOps.ts')
    const { conditionIdFromMarketId } = await import('@bitcaster-market/client-sdk/tradeIgnition')
    const {
      ensureState,
      recordSwapMessage,
      recordTradeCreated,
      recordTradeStateChanged,
    } = await import('./state.ts')
    const runLock = await acquireDaemonRunLock()
    let listenerInstalled = false
    try {
      const [profile, secrets, rpcToken] = await Promise.all([
        readProfile(),
        readSecrets(),
        readRpcToken(),
      ])
      // Decode every local custody authority before opening an RPC endpoint.
      // A malformed row is a startup failure, never a background recovery log.
      await ensureState()
      if (!profile || !secrets || !rpcToken) {
        throw new Error('daemon profile storage is incomplete')
      }
    let executor: InstanceType<typeof DaemonSwapExecutor> | undefined
    let runtime: InstanceType<typeof DaemonTradeRuntime> | undefined
    let runDurableRecovery: (() => Promise<void>) | undefined
    let durableRecoveryRunner: ReturnType<typeof createDaemonDurableTradeRecoveryRunner> | undefined
    let runDurableTradeEvent: DaemonDurableTradeRecoveryRunner['runTradeEvent'] | undefined
    const recoveryEngineClient =
      profile && secrets
        ? createAuthenticatedBitcasterEngineClient({
            baseUrl: profile.engineBaseUrl,
            nostrSecretKeyHex: secrets.nostrSecretKeyHex,
          })
        : undefined
    const takerFillRecovery = recoveryEngineClient
      ? new DaemonTakerFillRecovery({
          submitOrder: (marketId, request) =>
            recoveryEngineClient.submitOrder(marketId, request),
          newClientOrderId: () => randomUUID(),
          onResubmitted: async ({ marketId, orderId, response }) => {
            await submitPendingEphemeralPubkeys({
              client: recoveryEngineClient,
              marketId,
              conditionId: conditionIdFromMarketId(marketId),
              orderId,
              pendingPubkeySubmissions: response.pendingPubkeySubmissions,
            })
            await runtime?.start(await ensureState())
          },
        })
      : undefined
    const tradeHub =
      profile && secrets
        ? new SignalRTradeHubConnection({
            engineBaseUrl: profile.engineBaseUrl,
            nostrSecretKeyHex: secrets.nostrSecretKeyHex,
            onTradeCreated: async (payload) => {
              if (!runDurableTradeEvent) {
                throw new Error('durable recovery coordinator is not available')
              }
              await runDurableTradeEvent(payload.tradeId, () => recordTradeCreated(payload), async (swap) => {
                if (swap) {
                  await runtime?.start(await ensureState())
                }
                await executor?.onTradeCreated(swap)
              })
            },
            onSwapMessageReceived: async (
              tradeId,
              messageType,
              ciphertext,
            ) => {
              if (!runDurableTradeEvent) {
                throw new Error('durable recovery coordinator is not available')
              }
              await runDurableTradeEvent(
                tradeId,
                () => recordSwapMessage(tradeId, messageType, ciphertext),
                async (swap) => {
                  await executor?.onSwapMessage(swap)
                },
              )
            },
            onTradeStateChanged: async (tradeId, newState, failureReason) => {
              if (!runDurableTradeEvent) {
                throw new Error('durable recovery coordinator is not available')
              }
              await runDurableTradeEvent(tradeId, () => recordTradeStateChanged(
                tradeId,
                newState,
                failureReason,
              ), async (swap) => {
                await executor?.onTradeStateChanged(swap)
                await takerFillRecovery?.recoverTrade(tradeId)
              })
            },
            onPendingPubkeyRequired: async (tradeId, orderId, _role, marketId, _deadline) => {
              const { signNip98 } = await import('./nostrAuth.ts')
              const { conditionIdFromMarketId } = await import('@bitcaster-market/client-sdk/tradeIgnition')
              const { submitEphemeralPubkey: submitPubkey } = await import('@bitcaster-market/client-sdk/engineClient')
              const { submitPersistedPendingPubkey } = await import('./pendingPubkey.ts')
              type AuthorizationRequest = {
                url: string
                method: string
                bodyText?: string
                payloadHash?: string
              }
              await submitPersistedPendingPubkey({
                tradeId,
                orderId,
                marketId,
                submit: async (publicKeyHex) => {
                  await submitPubkey(
                    profile.engineBaseUrl,
                    tradeId,
                    publicKeyHex,
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
              })
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
          scheduleRecovery: (tradeId) => {
            void durableRecoveryRunner?.recoverTrade(tradeId).catch(() => undefined)
          },
        })
      : undefined
    runtime = runtimeConnection
      ? new DaemonTradeRuntime(runtimeConnection, {
          scheduleResumeActiveSwaps: (delayMs) => {
            setTimeout(() => {
              void (async () => {
                await runDurableRecovery?.()
              })().catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err)
                process.stderr.write(`Swap recovery sweep failed: ${message}\n`)
              })
            }, delayMs)
          },
        })
      : undefined
    durableRecoveryRunner = executor && tradeHub
      ? createDaemonDurableTradeRecoveryRunner({ executor, connection: tradeHub })
      : undefined
    runDurableTradeEvent = durableRecoveryRunner
      ? (tradeId, persist, action) => durableRecoveryRunner.runTradeEvent(tradeId, persist, action)
      : undefined
    runDurableRecovery = durableRecoveryRunner
      ? async () => {
        const recovery = await durableRecoveryRunner.recover()
        for (const session of recovery.durableRecovery.sessions) {
          if (session.kind === 'failed-closed') {
            process.stderr.write(
              `Durable trade recovery failed closed for ${session.tradeId}: ${session.reason}\n`,
            )
          }
        }
      }
      : undefined
    durableRecoveryRunner?.armBootstrap()
    const server = await startDaemonServer({
      tradeRuntime: runtime,
      swapExecutor: executor,
      durableTradeRecovery: durableRecoveryRunner,
    })
    installShutdownHandlers(server, runtime, runLock.release)
    listenerInstalled = true
    void recoverPreparedWalletSends(secrets)
        .then((result) => {
          if (result.recovered.length > 0) {
            process.stderr.write(
              `Recovered wallet operations: ${result.recovered.join(', ')}\n`,
            )
          }
          for (const pending of result.pending) {
            process.stderr.write(
              `Wallet operation ${pending.operationId} remains pending: ${pending.error}\n`,
            )
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`Wallet recovery sweep failed: ${message}\n`)
        })
    if (durableRecoveryRunner) {
      void (async () => {
        const recovery = await durableRecoveryRunner.finishBootstrap()
        for (const session of recovery.durableRecovery.sessions) {
          if (session.kind === 'failed-closed') {
            process.stderr.write(
              `Durable trade recovery failed closed for ${session.tradeId}: ${session.reason}\n`,
            )
          }
        }
      })().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Swap recovery sweep failed: ${message}\n`)
      })
    }
    if (takerFillRecovery) {
      void takerFillRecovery.resumePending(await ensureState()).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Taker fill recovery sweep failed: ${message}\n`)
      })
    }
    } catch (error) {
      if (!listenerInstalled) await runLock.release()
      throw error
    }
    break
  }
  default:
    process.stderr.write(`Unknown command: ${command}\n`)
    process.stderr.write(`Usage:
  bitcaster-daemon init [--wallet-seed-hex <hex>|--wallet-seed-hex-file <path>]
                         [--nostr-secret-key-hex <hex>|--nostr-secret-key-hex-file <path>]
                         [--force]
                         [--engine-url <url>] [--mint-url <url>]
  bitcaster-daemon run
`)
    process.exitCode = 1
}

function parseInitOptions(args: string[]): {
  walletSeedHex?: string
  nostrSecretKeyHex?: string
  walletSeedHexFile?: string
  nostrSecretKeyHexFile?: string
  engineUrl?: string
  mintUrl?: string
  force: boolean
} {
  const options: {
    walletSeedHex?: string
    nostrSecretKeyHex?: string
    walletSeedHexFile?: string
    nostrSecretKeyHexFile?: string
    engineUrl?: string
    mintUrl?: string
    force: boolean
  } = { force: false }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--wallet-seed-hex') {
      options.walletSeedHex = requiredArg(args[++i], '--wallet-seed-hex')
    } else if (arg === '--wallet-seed-hex-file') {
      options.walletSeedHexFile = requiredArg(args[++i], '--wallet-seed-hex-file')
    } else if (arg === '--nostr-secret-key-hex') {
      options.nostrSecretKeyHex = requiredArg(args[++i], '--nostr-secret-key-hex')
    } else if (arg === '--nostr-secret-key-hex-file') {
      options.nostrSecretKeyHexFile = requiredArg(
        args[++i],
        '--nostr-secret-key-hex-file',
      )
    } else if (arg === '--engine-url') {
      options.engineUrl = requiredArg(args[++i], '--engine-url')
    } else if (arg === '--mint-url') {
      options.mintUrl = requiredArg(args[++i], '--mint-url')
    } else if (arg === '--force') {
      options.force = true
    } else {
      throw new Error(`Unknown init option: ${arg}`)
    }
  }
  return options
}

async function resolveImportedSecrets(options: {
  walletSeedHex?: string
  nostrSecretKeyHex?: string
  walletSeedHexFile?: string
  nostrSecretKeyHexFile?: string
}): Promise<{ walletSeedHex: string; nostrSecretKeyHex: string } | null> {
  if (options.walletSeedHex && options.walletSeedHexFile) {
    throw new Error(
      '--wallet-seed-hex and --wallet-seed-hex-file are mutually exclusive',
    )
  }
  if (options.nostrSecretKeyHex && options.nostrSecretKeyHexFile) {
    throw new Error(
      '--nostr-secret-key-hex and --nostr-secret-key-hex-file are mutually exclusive',
    )
  }
  const walletSeedHex =
    options.walletSeedHex ??
    (options.walletSeedHexFile
      ? await readSecretHexFile(options.walletSeedHexFile, '--wallet-seed-hex-file')
      : undefined)
  const nostrSecretKeyHex =
    options.nostrSecretKeyHex ??
    (options.nostrSecretKeyHexFile
      ? await readSecretHexFile(
          options.nostrSecretKeyHexFile,
          '--nostr-secret-key-hex-file',
        )
      : undefined)
  if (!walletSeedHex && !nostrSecretKeyHex) return null
  if (!walletSeedHex || !nostrSecretKeyHex) {
    throw new Error(
      '--wallet-seed-hex/--wallet-seed-hex-file and --nostr-secret-key-hex/--nostr-secret-key-hex-file must be supplied together',
    )
  }
  return { walletSeedHex, nostrSecretKeyHex }
}

async function readSecretHexFile(path: string, option: string): Promise<string> {
  const value = (await readFile(path, 'utf8')).trim()
  if (!value) throw new Error(`${option} was empty`)
  return value
}

function requiredArg(value: string | undefined, option: string): string {
  if (value) return value
  throw new Error(`Missing value for ${option}`)
}

function installShutdownHandlers(
  server: Server,
  runtime: { stop(): Promise<void> } | undefined,
  releaseRunLock: () => Promise<void>,
): void {
  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write(`bitcaster-daemon received ${signal}, shutting down\n`)
    try {
      await closeServer(server)
      await runtime?.stop()
      await releaseRunLock()
      process.exit(0)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`bitcaster-daemon shutdown failed: ${message}\n`)
      process.exit(1)
    }
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
