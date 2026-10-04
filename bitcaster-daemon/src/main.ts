#!/usr/bin/env node

import type { Server } from 'node:http'
import { createOrderTimelineStderrSink } from './orderTimeline.ts'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  isLoopbackHttpUrl,
} from '@bitcaster-market/client-sdk'
import { assertDaemonProfileStorageComplete, profileDir } from './profile.ts'
import {
  createDaemonSecrets,
  createDaemonSecretsFromImport,
  readSelectedDaemonSigner,
  hasUnfinishedDaemonAccountWork,
} from './secrets.ts'
import { bootstrapFreshDaemonProfile } from './profileBootstrap.ts'
import type { CtfRangeRecoveryLoop } from './ctfRangeRecoveryLoop.ts'
import type { NonRetirementCustodyRecoveryLoop } from './startupRecovery.ts'
import type { NativeWalletPaymentApproval } from './nativeWalletPaymentOps.ts'
import type { NativePaymentRequestService } from './nativePaymentRequestService.ts'
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
      nativeOracleNonceSeedHex: secrets.nativeOracleNonceSeedHex,
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
    const observeOrderTimeline = createOrderTimelineStderrSink(process.stderr)
    const nativeConfig = freezeNativeConfigAtStartup().config
    await assertDaemonProfileStorageComplete()
    const { acquireDaemonRunLock } = await import('./runLock.ts')
    const { startDaemonServer } = await import('./server.ts')
    const { SignalROrderLifecycleConnection } = await import('./orderHubConnection.ts')
    const { SignalRMarketHubConnection } = await import('./marketHubConnection.ts')
    const { createMarketWatch } = await import('./marketWatch.ts')
    const { createLikedMarketWatch } = await import('./likedMarketWatch.ts')
    const { createWalletWatch } = await import('./walletWatch.ts')
    const { subscribeToDaemonWalletHoldingsCommits } = await import('./stateSqlite.ts')
    const { readProfile } = await import('./profile.ts')
    const { readSecrets } = await import('./secrets.ts')
    const {
      recoverPreparedWalletSends,
      recoverDurableWalletReceives,
      recoverDurableWalletProofImports,
      recoverDurableOutgoingCashuTransfers,
    } = await import('./walletOps.ts')
    const { createNativeLightningOps } = await import('./nativeLightningOps.ts')
    const { NativeWalletPaymentOps } = await import('./nativeWalletPaymentOps.ts')
    const { createNativeWalletPaymentRecoveryPager } =
      await import('./nativeWalletPaymentRecovery.ts')
    const { recoverWalletProofConsolidations } = await import('./walletProofConsolidation.ts')
    const { recoverCompleteSetSplits } = await import('./completeSetConversion.ts')
    const { recoverDaemonPositionClaims } = await import('./nativePositionClaim.ts')
    const {
      composeStartupCustodyRecovery,
      createCustodyReadinessTracker,
      createNonRetirementCustodyRecoveryLoop,
      outgoingCashuRecoveryStatus,
    } = await import('./startupRecovery.ts')
    const { DaemonCtfRangeOrderCoordinator } = await import('./ctfRangeOrderCoordinator.ts')
    const { createCtfRangeRecoveryLoop } = await import('./ctfRangeRecoveryLoop.ts')
    const { resumeDaemonConditionRetirements, retireResolvedDaemonConditions } =
      await import('./managedConditionRetirement.ts')
    const { BitcasterEngineClient } = await import('@bitcaster-market/client-sdk/engineClient')
    const { signNip98 } = await import('./nostrAuth.ts')
    const { ensureState, listLocalOrders } = await import('./state.ts')
    const { readDaemonWalletBalance } = await import('./walletBalance.ts')
    const runLock = await acquireDaemonRunLock()
    const profile = await readProfile()
    const secrets = await readSecrets()
    const signerEnabled = (await readSelectedDaemonSigner()).enabled
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
    let nonRetirementRecoveryLoop: NonRetirementCustodyRecoveryLoop | undefined
    let assetMonitoring: { start(): void; stop(): void } | undefined
    let assetMonitoringStarting = false
    let nativePaymentRequests: NativePaymentRequestService | undefined
    const liveViewLifetime = new AbortController()
    let retirementRetryTimer: NodeJS.Timeout | undefined
    let leaseFailure: Error | undefined
    let shutdown: ((reason: string, exitCode?: number) => Promise<void>) | undefined
    const currentFence = () => {
      if (leaseFailure !== undefined) throw leaseFailure
      return fence
    }
    const nativeLightningOps = createNativeLightningOps({
      directory: profileDir(),
      mintUrl: profile.mintUrl,
      walletSeedHex: secrets.walletSeedHex,
      getCustodyFence: currentFence,
    })
    const nativeWalletPaymentService = new NativeWalletPaymentOps({
      profile,
      secrets,
      getFence: currentFence,
      deps: { getCustodyFence: currentFence },
    })
    const paymentRecovery = createNativeWalletPaymentRecoveryPager((input) =>
      nativeWalletPaymentService.recoverActivePage(input),
    )
    const nativeWalletPaymentOps = {
      quote: (input: { readonly invoice: string }) => nativeWalletPaymentService.quote(input),
      pay: async (input: NativeWalletPaymentApproval) => {
        try {
          return await nativeWalletPaymentService.pay(input)
        } finally {
          paymentRecovery.restart()
        }
      },
      status: (input: { readonly operationId: string }) => nativeWalletPaymentService.status(input),
      recoverPage: paymentRecovery.recoverPage,
    }
    let resourcesReleased = false
    const releaseResources = async () => {
      if (resourcesReleased) return
      resourcesReleased = true
      liveViewLifetime.abort()
      renewal?.stop()
      rangeRecoveryLoop?.stop()
      nonRetirementRecoveryLoop?.stop()
      assetMonitoring?.stop()
      await nativePaymentRequests?.stop().catch(() => {
        process.stderr.write('native payment request shutdown failed\n')
      })
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
    const retirementEngine = new BitcasterEngineClient({
      baseUrl: profile.engineBaseUrl,
      authorization: signerEnabled
        ? ({ url, method, bodyText, payloadHash }) =>
            signNip98(
              { privateKeyHex: secrets.nostrSecretKeyHex },
              url,
              method,
              bodyText,
              payloadHash,
            )
        : undefined,
    })
    const runAutomaticRetirementScan = async () => {
      const resumed = await resumeDaemonConditionRetirements({
        profile,
        secrets,
        fence: currentFence(),
        walletDependencies: { getCustodyFence: currentFence },
      })
      if (!signerEnabled || !nativeConfig.daemon.autoRetireResolvedConditionInventory)
        return resumed
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
    const orderHub = new SignalROrderLifecycleConnection({
      observeOrderTimeline,
      engineBaseUrl: profile.engineBaseUrl,
      nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      onOrderLifecycleChanged: () => {
        rangeRecoveryLoop?.trigger()
      },
      onSettlementGroupStateChanged: () => {
        rangeRecoveryLoop?.trigger()
      },
      onReconnected: () => {
        rangeRecoveryLoop?.trigger()
      },
      onError: (err: Error) => {
        process.stderr.write(`Order lifecycle event error: ${err.message}\n`)
      },
    })
    let marketWatch: ReturnType<typeof createMarketWatch> | undefined
    let walletWatch: ReturnType<typeof createWalletWatch> | undefined
    const marketHub = new SignalRMarketHubConnection({
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
        marketWatch?.reconnected()
        walletWatch?.reconnected()
        await wakeManagedConditionRetirements()
      },
      onMarketInvalidated: async (conditionId) => {
        marketWatch?.invalidate(conditionId)
        walletWatch?.invalidate(conditionId)
      },
      onDisconnected: () => {
        marketWatch?.disconnected()
        walletWatch?.disconnected()
      },
      onError: (err: Error) => {
        process.stderr.write(`MarketHub event error: ${err.message}\n`)
      },
    })
    marketWatch = createMarketWatch({ hub: marketHub, engine: retirementEngine })
    const likedMarketWatch = createLikedMarketWatch({
      marketWatch,
      assertCanWatch: () => {
        if (!signerEnabled) throw new Error('Application signer is disconnected.')
      },
    })
    walletWatch = createWalletWatch({
      hub: marketHub,
      readLocal: async (signal) => {
        signal.throwIfAborted()
        const localHoldings = await readDaemonWalletBalance(profileDir())
        signal.throwIfAborted()
        return {
          localHoldings,
          monitoringEnabled: signerEnabled && nativeConfig.daemon.assetMonitoringEnabled,
        }
      },
      readPortfolio: (signal) => retirementEngine.getPortfolio({ walletId, pageSize: 200 }, signal),
      subscribeToLocalChanges: (callback) =>
        subscribeToDaemonWalletHoldingsCommits(profileDir(), callback),
    })
    try {
      const rangeOrderCoordinator = new DaemonCtfRangeOrderCoordinator(profileDir(), currentFence, {
        observeOrderTimeline,
        allowInsecureLoopbackHttp: isLoopbackHttpUrl(profile.mintUrl),
      })
      const rangeRecoveryClient = new BitcasterEngineClient({
        baseUrl: profile.engineBaseUrl,
        authorization: signerEnabled
          ? ({ url, method, bodyText, payloadHash }) =>
              signNip98(
                { privateKeyHex: secrets.nostrSecretKeyHex },
                url,
                method,
                bodyText,
                payloadHash,
              )
          : undefined,
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
      const recoverRangeOrders = async (): Promise<
        import('./ctfRangeOrderCoordinator.ts').DaemonCtfRangeRecoveryResult
      > =>
        signerEnabled
          ? rangeOrderCoordinator.recover(secrets.walletSeedHex, rangeRecoveryClient)
          : {
              recovered: [],
              pending: (await hasUnfinishedDaemonAccountWork())
                ? [
                    {
                      operationId: 'application-account-recovery',
                      error: 'Application signer is disconnected.',
                    },
                  ]
                : [],
            }
      const initialRangeRecovery = await recoverRangeOrders()
      logRangeRecovery(initialRangeRecovery)
      if (signerEnabled)
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
      rangeRecoveryLoop?.accept(initialRangeRecovery)
      const recoverNonRetirementCustody = async () => {
        const consolidationRecovery = await recoverWalletProofConsolidations({
          secrets,
          mutation: () => ({ fence: currentFence(), observedAtMs: Date.now() }),
        })
        const walletRecovery = await recoverPreparedWalletSends(secrets, {
          getCustodyFence: currentFence,
        })
        const receiveRecovery = await recoverDurableWalletReceives(secrets, {
          getCustodyFence: currentFence,
        })
        const importRecovery = await recoverDurableWalletProofImports(secrets, {
          getCustodyFence: currentFence,
        })
        const outgoingRecovery = await recoverDurableOutgoingCashuTransfers(
          secrets,
          {
            getCustodyFence: currentFence,
          },
          signerEnabled
            ? {
                client: rangeRecoveryClient,
                accountSubject: secrets.nostrPublicKeyHex,
              }
            : undefined,
        )
        const completeSetRecovery = await recoverCompleteSetSplits({
          secrets,
          deps: { getCustodyFence: currentFence },
        })
        const invoiceRecovery = await nativeLightningOps.recoverPage()
        const positionClaimRecovery = await recoverDaemonPositionClaims({
          profile,
          secrets,
          fence: currentFence(),
          walletDependencies: { getCustodyFence: currentFence },
        })
        const paymentRecoveryPage = await nativeWalletPaymentOps.recoverPage()
        const accountRecoveryPending = !signerEnabled && (await hasUnfinishedDaemonAccountWork())
        const recovery = composeStartupCustodyRecovery([
          consolidationRecovery,
          walletRecovery,
          receiveRecovery,
          importRecovery,
          outgoingRecovery,
          completeSetRecovery,
          positionClaimRecovery,
          invoiceRecovery.recovery,
          paymentRecoveryPage.recovery,
          ...(accountRecoveryPending
            ? [
                {
                  recovered: [],
                  pending: [
                    {
                      operationId: 'application-account-recovery',
                      error: 'Application signer is disconnected.',
                    },
                  ],
                },
              ]
            : []),
        ])
        const outgoingStatus = outgoingCashuRecoveryStatus(outgoingRecovery)
        const hasMore =
          receiveRecovery.hasMore ||
          importRecovery.hasMore ||
          outgoingRecovery.hasMore ||
          invoiceRecovery.hasMore ||
          paymentRecoveryPage.hasMore
        const blockingPending =
          accountRecoveryPending ||
          consolidationRecovery.pending.length > 0 ||
          walletRecovery.pending.length > 0 ||
          receiveRecovery.pending.length > 0 ||
          receiveRecovery.pendingCount > 0 ||
          receiveRecovery.hasMore ||
          importRecovery.pendingCount > 0 ||
          importRecovery.hasMore ||
          completeSetRecovery.pending.length > 0 ||
          positionClaimRecovery.pending.length > 0 ||
          outgoingStatus.blockingPending ||
          invoiceRecovery.blockingPending ||
          paymentRecoveryPage.blockingPending
        return {
          recovery,
          hasMore,
          importHasMore: importRecovery.hasMore,
          invoiceHasMore: invoiceRecovery.hasMore,
          paymentHasMore: paymentRecoveryPage.hasMore,
          pending:
            consolidationRecovery.pending.length > 0 ||
            walletRecovery.pending.length > 0 ||
            receiveRecovery.pending.length > 0 ||
            receiveRecovery.pendingCount > 0 ||
            receiveRecovery.hasMore ||
            importRecovery.pendingCount > 0 ||
            importRecovery.hasMore ||
            completeSetRecovery.pending.length > 0 ||
            positionClaimRecovery.pending.length > 0 ||
            outgoingStatus.retryPending ||
            invoiceRecovery.retryPending ||
            paymentRecoveryPage.retryPending,
          blockingPending,
        }
      }
      const initialNonRetirementRecovery = await recoverNonRetirementCustody()
      const nonRetirementRecovery = initialNonRetirementRecovery.recovery
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
      const readiness = createCustodyReadinessTracker({
        nonRetirementPending: initialNonRetirementRecovery.blockingPending,
        retryPending: initialNonRetirementRecovery.pending,
        retirementPending: pendingRetirements.length > 0,
      })
      const { createNativePaymentRequestService } = await import('./nativePaymentRequestService.ts')
      const { createNativePaymentRequestReceiver } =
        await import('./nativePaymentRequestReceiver.ts')
      nativePaymentRequests = createNativePaymentRequestService({
        profile,
        secrets,
        getFence: currentFence,
        receiver: createNativePaymentRequestReceiver({
          walletSeedHex: secrets.walletSeedHex,
          relayUrls: nativeConfig.daemon.nostrRelays,
        }),
        isCustodyReady: () => leaseFailure === undefined && readiness.isReady(),
        triggerCustodyRecovery: () => nonRetirementRecoveryLoop?.trigger(),
        deps: { getCustodyFence: currentFence },
      })
      const refreshNativePaymentRequestReceiver = async () => {
        try {
          await nativePaymentRequests?.resumeReceiving()
        } catch {
          process.stderr.write('native payment request receiver is unavailable\n')
        }
      }
      const startAssetMonitoringWhenReady = async () => {
        if (
          !nativeConfig.daemon.assetMonitoringEnabled ||
          !signerEnabled ||
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
            onAccepted: () => walletWatch?.refreshPortfolio(),
          })
          assetMonitoring.start()
        } finally {
          assetMonitoringStarting = false
        }
      }
      process.stderr.write(
        `Startup custody recovery: recovered=${startupRecovery.recoveredCount} ` +
          `blockingPending=${initialNonRetirementRecovery.blockingPending} ` +
          `retryPending=${initialNonRetirementRecovery.pending} ` +
          `hasMore=${initialNonRetirementRecovery.hasMore} ` +
          `retirementPending=${pendingRetirements.length > 0}\n`,
      )
      let orderHubStarted = false
      const startOrderHubWhenReady = async () => {
        if (!signerEnabled || !readiness.isReady() || orderHubStarted) return
        orderHubStarted = true
        try {
          const state = await ensureState()
          for (const order of await listLocalOrders()) {
            await orderHub.trackOrder(order.marketId, order.orderId)
          }
          await orderHub.start()
          if (nativeConfig.daemon.autoRetireResolvedConditionInventory && marketHub) {
            await trackManagedConditionMarkets(marketHub, state)
            await marketHub.start()
          }
        } catch (error) {
          orderHubStarted = false
          throw error
        }
      }
      const markCustodyReady = () => {
        void startAssetMonitoringWhenReady().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`asset-monitoring startup failed: ${message}\n`)
        })
        void startOrderHubWhenReady().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`bitcaster-daemon order lifecycle start failed: ${message}\n`)
        })
      }
      const runAutomaticNonRetirementRecovery = async () => {
        const generation = readiness.beginAutomaticNonRetirementScan()
        try {
          const result = await recoverNonRetirementCustody()
          if (
            !readiness.completeAutomaticNonRetirementScan(
              generation,
              result.blockingPending,
              result.pending,
            )
          ) {
            return {
              pending: readiness.isRetryPending(),
              importHasMore: result.importHasMore,
              invoiceHasMore: result.invoiceHasMore,
              paymentHasMore: result.paymentHasMore,
            }
          }
          process.stderr.write(
            `Automatic non-retirement custody recovery: recovered=${result.recovery.recoveredCount} ` +
              `blockingPending=${result.blockingPending} retryPending=${result.pending} ` +
              `hasMore=${result.hasMore}\n`,
          )
          await refreshNativePaymentRequestReceiver()
          if (readiness.isReady()) markCustodyReady()
          return {
            pending: result.pending,
            importHasMore: result.importHasMore,
            invoiceHasMore: result.invoiceHasMore,
            paymentHasMore: result.paymentHasMore,
          }
        } catch (error) {
          const applied = readiness.completeAutomaticNonRetirementScan(generation, true, true)
          if (applied) {
            await refreshNativePaymentRequestReceiver()
            process.stderr.write('Automatic non-retirement custody recovery remains pending\n')
          }
          throw error
        }
      }
      nonRetirementRecoveryLoop = createNonRetirementCustodyRecoveryLoop({
        recover: runAutomaticNonRetirementRecovery,
        onResult: (result) => {
          if (result.importHasMore || result.invoiceHasMore || result.paymentHasMore) {
            nonRetirementRecoveryLoop?.trigger()
          }
        },
        onError: (error: Error) => {
          process.stderr.write(
            `Automatic non-retirement custody recovery failed: ${error.message}\n`,
          )
        },
        retryAfterError: () => readiness.isRetryPending(),
      })
      nonRetirementRecoveryLoop.accept({ pending: initialNonRetirementRecovery.pending })
      if (
        initialNonRetirementRecovery.importHasMore ||
        initialNonRetirementRecovery.invoiceHasMore ||
        initialNonRetirementRecovery.paymentHasMore
      ) {
        nonRetirementRecoveryLoop.trigger()
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
          await refreshNativePaymentRequestReceiver()
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
          if (readiness.completeAutomaticRetirementScan(generation, true)) {
            await refreshNativePaymentRequestReceiver()
            scheduleRetirementRetry()
          }
          throw error
        }
      }
      if (pendingRetirements.length > 0) scheduleRetirementRetry()
      currentFence()
      const server = await startDaemonServer({
        observeOrderTimeline,
        watch: (command, signal) => {
          const lifetime = AbortSignal.any([signal, liveViewLifetime.signal])
          switch (command.method) {
            case 'market.watch':
              if ('liked' in command.params) return likedMarketWatch.watch(lifetime)
              if (!signerEnabled) throw new Error('Application signer is disconnected.')
              return marketWatch!.watch(command.params.conditionIds, lifetime)
            case 'wallet.watch':
              return walletWatch!.watch(lifetime)
            case 'wallet.request.watch':
              throw new Error('Payment request watches require the request service dispatcher')
          }
        },
        nativeLightningOps,
        nativeWalletPaymentOps,
        nativePaymentRequests,
        trackOwnedOrder: async (marketId, orderId) => {
          await orderHub.trackOrder(marketId, orderId)
          await startOrderHubWhenReady()
        },
        prepareSettlementCapability: (input, client, beforeCreateCapability, consentedFeeFacts) =>
          rangeOrderCoordinator.prepare(input, client, beforeCreateCapability, consentedFeeFacts),
        previewSettlementCapabilityFees: (input, client) =>
          rangeOrderCoordinator.previewFeeFacts(input, client),
        triggerSettlementRecovery: () => rangeRecoveryLoop?.trigger(),
        triggerCustodyRecovery: () => nonRetirementRecoveryLoop?.trigger(),
        getCustodyFence: currentFence,
        isCustodyReady: () => readiness.isReady(),
        markCustodyReady,
        onManualCustodyRecoveryStatus: (status) => {
          readiness.updateManualRecovery(status)
          nonRetirementRecoveryLoop?.accept({ pending: status.retryPending })
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
        shutdown = installShutdownHandlers(
          server,
          {
            stop: async () => {
              await Promise.all([orderHub.stop(), marketHub.stop()])
            },
          },
          releaseResources,
          async () => {
            liveViewLifetime.abort()
            await nativePaymentRequests!.stop()
          },
        )
      } catch (error) {
        await closeServer(server)
        throw error
      }
      void startOrderHubWhenReady().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(
          `bitcaster-daemon order lifecycle start failed; RPC will remain available: ${message}\n`,
        )
      })
      if (readiness.isReady()) markCustodyReady()
      await refreshNativePaymentRequestReceiver()
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
                         --recovery-id <id> --mint <url> --unit <msat>
                         --acknowledge-seed-disclosure
  bitcaster-daemon [--datadir <path>] run
`)
    process.exitCode = 1
}

function parseRecoverSeedOptions(args: readonly string[]): {
  recoveryId: string
  mintUrl: string
  unit: 'sat' | 'msat'
  walletSeedHexFile: string
  disclosureAcknowledged: true
} {
  let recoveryId: string | undefined
  let mintUrl: string | undefined
  let unit: 'sat' | 'msat' | undefined
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
    else if (option === '--unit' && value === 'msat') unit = value
    else if (option === '--unit') throw new Error('recover-seed unit must be msat')
    else if (option === '--wallet-seed-hex-file') walletSeedHexFile = value
    else throw new Error(`Unknown recover-seed option: ${option}`)
  }
  if (!disclosureAcknowledged) {
    throw new Error('recover-seed requires --acknowledge-seed-disclosure')
  }
  if (unit === undefined) throw new Error('recover-seed unit must be msat')
  return {
    recoveryId: requiredArg(recoveryId, '--recovery-id'),
    mintUrl: requiredArg(mintUrl, '--mint'),
    unit,
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
  hub: { setManagedMarkets(marketIds: readonly string[]): Promise<void> },
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
  await hub.setManagedMarkets([...marketIds].sort())
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
  beforeClose?: () => Promise<void>,
): (reason: string, exitCode?: number) => Promise<void> {
  let shuttingDown = false
  const shutdown = async (reason: string, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write(`bitcaster-daemon received ${reason}, shutting down\n`)
    try {
      // Closing the server first would wait indefinitely for active watch responses.
      await beforeClose?.()
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
