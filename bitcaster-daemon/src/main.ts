#!/usr/bin/env node

import type { Server } from 'node:http'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { profileFromPublicKey, writeProfile } from './profile.ts'
import { ensureRpcToken } from './rpcAuth.ts'
import {
  createDaemonSecretsFromImport,
  ensureSecrets,
  readSecrets,
  writeSecrets,
} from './secrets.ts'
import { ensureState, readState } from './state.ts'

const [, , command = 'run', ...args] = process.argv

switch (command) {
  case 'init': {
    const initOptions = parseInitOptions(args)
    const importedSecrets = await resolveImportedSecrets(initOptions)
    if (importedSecrets) {
      if ((await readSecrets()) && !initOptions.force) {
        throw new Error('daemon secrets already exist; pass --force to replace them')
      }
      if (initOptions.force && !(await daemonStateIsEmpty())) {
        throw new Error(
          'daemon state is not empty; refusing to replace wallet/Nostr keys',
        )
      }
      await writeSecrets(
        createDaemonSecretsFromImport({
          walletSeedHex: importedSecrets.walletSeedHex,
          nostrSecretKeyHex: importedSecrets.nostrSecretKeyHex,
        }),
      )
    }
    const secrets = await ensureSecrets()
    await writeProfile(
      profileFromPublicKey(secrets.nostrPublicKeyHex, {
        engineBaseUrl: initOptions.engineUrl,
        mintUrl: initOptions.mintUrl,
      }),
    )
    await ensureRpcToken()
    await ensureState()
    process.stdout.write('bitcaster-daemon profile initialized\n')
    break
  }
  case 'run': {
    const { acquireDaemonRunLock } = await import('./runLock.ts')
    const { startDaemonServer } = await import('./server.ts')
    const { CompositeTradeRuntimeConnection, DaemonTradeRuntime } = await import('./tradeRuntime.ts')
    const { SignalRTradeHubConnection } = await import('./tradeHubConnection.ts')
    const { SignalRMarketHubConnection } = await import('./marketHubConnection.ts')
    const { DaemonSwapExecutor } = await import('./swapExecutor.ts')
    const { createRealDaemonSwapOps } = await import('./swapProtocolAdapter.ts')
    const { readProfile } = await import('./profile.ts')
    const { readSecrets } = await import('./secrets.ts')
    const { recoverPreparedWalletSends } = await import('./walletOps.ts')
    const {
      ensureState,
      recordSwapMessage,
      recordTradeCreated,
      recordTradeStateChanged,
    } = await import('./state.ts')
    const runLock = await acquireDaemonRunLock()
    const profile = await readProfile()
    const secrets = await readSecrets()
    let executor: InstanceType<typeof DaemonSwapExecutor> | undefined
    let runtime: InstanceType<typeof DaemonTradeRuntime> | undefined
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
            onSwapMessageReceived: async (
              tradeId,
              messageType,
              ciphertext,
            ) => {
              await executor?.onSwapMessage(
                await recordSwapMessage(tradeId, messageType, ciphertext),
              )
            },
            onTradeStateChanged: async (tradeId, newState) => {
              await executor?.onTradeStateChanged(
                await recordTradeStateChanged(tradeId, newState),
              )
            },
            onPendingPubkeyRequired: async (tradeId, _orderId, _role, marketId, _deadline) => {
              const { signNip98 } = await import('./nostrAuth.ts')
              const { conditionIdFromMarketId } = await import('@bitcaster-market/client-sdk/tradeIgnition')
              const { generateOrderEphemeralKeypair } = await import('./ephemeralKey.ts')
              const { submitEphemeralPubkey: submitPubkey } = await import('@bitcaster-market/client-sdk/engineClient')
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
      const server = await startDaemonServer({
        tradeRuntime: runtime,
        swapExecutor: executor,
      })
      installShutdownHandlers(server, runtime, runLock.release)
    } catch (err) {
      await runLock.release()
      throw err
    }
    if (secrets) {
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
    }
    if (executor) {
      void executor.resumeActiveSwaps(await ensureState()).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Swap recovery sweep failed: ${message}\n`)
      })
    }
    break
  }
  default:
    process.stderr.write(`Unknown command: ${command}\n`)
    process.stderr.write(`Usage:
  bitcaster-daemon init [--wallet-seed-hex-file <path>]
                         [--nostr-secret-key-hex-file <path>]
                         [--force]
                         [--engine-url <url>] [--mint-url <url>]
  bitcaster-daemon run
`)
    process.exitCode = 1
}

function parseInitOptions(args: string[]): {
  walletSeedHexFile?: string
  nostrSecretKeyHexFile?: string
  engineUrl?: string
  mintUrl?: string
  force: boolean
} {
  const options: {
    walletSeedHexFile?: string
    nostrSecretKeyHexFile?: string
    engineUrl?: string
    mintUrl?: string
    force: boolean
  } = { force: false }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--wallet-seed-hex-file') {
      options.walletSeedHexFile = requiredArg(args[++i], '--wallet-seed-hex-file')
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
  walletSeedHexFile?: string
  nostrSecretKeyHexFile?: string
}): Promise<{ walletSeedHex: string; nostrSecretKeyHex: string } | null> {
  const walletSeedHex =
    options.walletSeedHexFile
      ? await readSecretHexFile(options.walletSeedHexFile, '--wallet-seed-hex-file')
      : undefined
  const nostrSecretKeyHex =
    options.nostrSecretKeyHexFile
      ? await readSecretHexFile(
          options.nostrSecretKeyHexFile,
          '--nostr-secret-key-hex-file',
        )
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
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const file = await open(path, constants.O_RDONLY | noFollow)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error(`${option} must name a regular file`)
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new Error(`${option} must not be accessible by group or other users`)
    }
    const value = (await file.readFile('utf8')).trim()
    if (!value) throw new Error(`${option} was empty`)
    return value
  } finally {
    await file.close()
  }
}

function requiredArg(value: string | undefined, option: string): string {
  if (value) return value
  throw new Error(`Missing value for ${option}`)
}

async function daemonStateIsEmpty(): Promise<boolean> {
  const state = await readState()
  if (!state) return true
  return (
    state.wallet.proofs.length === 0 &&
    Object.keys(state.wallet.keysetCounters).length === 0 &&
    Object.keys(state.proofOperations).length === 0 &&
    Object.keys(state.orders).length === 0 &&
    Object.keys(state.swaps).length === 0
  )
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
