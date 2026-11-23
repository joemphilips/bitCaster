import type { Server } from 'node:http'
import { boundedErrorText } from './mintErrorText.ts'
import { createOrderTimelineStderrSink } from './orderTimeline.ts'
import { randomUUID } from 'node:crypto'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  isLoopbackHttpUrl,
} from '@bitcaster-market/client-sdk'
import { assertDaemonProfileStorageComplete, profileDir } from './profile.ts'
import { readSelectedDaemonSigner, hasUnfinishedDaemonAccountWork } from './secrets.ts'
import type { CtfRangeRecoveryLoop } from './ctfRangeRecoveryLoop.ts'
import type { NonRetirementCustodyRecoveryLoop } from './startupRecovery.ts'
import type { NativeWalletPaymentApproval } from './nativeWalletPaymentOps.ts'
import type { NativePaymentRequestService } from './nativePaymentRequestService.ts'
import type { ResolvedConditionDiscovery } from './managedConditionRetirement.ts'
import {
  assertDaemonEngineUrlTrusted,
  freezeNativeConfigAtStartup,
  nativeRecoveryIndexRealm,
} from './nativeConfig.ts'
import {
  applyNativeSettingOverrides,
  nativeSettingOverrideDigests,
  type NativeSettingOverrides,
} from './nativeConfigLayers.ts'
import type { DaemonRecoveryIndex, DaemonRecoveryIndexStatus } from './daemonRecoveryIndex.ts'

export interface DaemonRuntimeOptions {
  readonly authorizationLifetimeSeconds?: number
  /** The settings of the environment and options of the CLI that starts the daemon. */
  readonly settingOverrides?: NativeSettingOverrides
}

/**
 * A forward-only profile schema upgrade runs only under the run lock, so no
 * older daemon holds the profile open. A missing profile is left to validation.
 */
async function upgradeProfileUnderRunLock(
  acquireDaemonRunLock: typeof import('./runLock.ts').acquireDaemonRunLock,
): Promise<void> {
  const { access } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { DAEMON_PROFILE_DATABASE } = await import('./profileSchema.ts')
  try {
    await access(join(profileDir(), DAEMON_PROFILE_DATABASE))
  } catch {
    return
  }
  const lock = await acquireDaemonRunLock()
  try {
    const { upgradeDaemonProfileSchema } = await import('./profileSchemaUpgrade.ts')
    await upgradeDaemonProfileSchema(profileDir())
  } finally {
    await lock.release()
  }
}

export async function runDaemonRuntime(options: DaemonRuntimeOptions = {}): Promise<void> {
  const observeOrderTimeline = createOrderTimelineStderrSink(process.stderr)
  const settingOverrides = options.settingOverrides ?? {}
  const nativeConfig = freezeNativeConfigAtStartup((config) =>
    applyNativeSettingOverrides(config, settingOverrides),
  ).config
  // Each start of the runtime checks the engine URL before it sends a signed request.
  assertDaemonEngineUrlTrusted(nativeConfig)
  const { acquireDaemonRunLock } = await import('./runLock.ts')
  await upgradeProfileUnderRunLock(acquireDaemonRunLock)
  await assertDaemonProfileStorageComplete()
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
  const { readPublicMintInfo } = await import('@bitcaster-market/client-sdk/mintMetadata')
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
  const { createConditionRetirementRetry } = await import('./conditionRetirementRetry.ts')
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
  let recoveryIndex: DaemonRecoveryIndex | undefined
  let readRecoveryIndexStatus: (() => DaemonRecoveryIndexStatus) | undefined
  let assetMonitoringStarting = false
  let nativePaymentRequests: NativePaymentRequestService | undefined
  const liveViewLifetime = new AbortController()
  // The conditions that the engine reported closed and whose attestation was
  // not readable yet. The retry reads them again.
  const closedConditionIds = new Set<string>()
  const retirementRetry = createConditionRetirementRetry({
    run: () => {
      void wakeManagedConditionRetirements().catch((error: unknown) => {
        process.stderr.write(`Condition retirement retry failed: ${boundedErrorText(error)}\n`)
      })
    },
  })
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
    readMintInfo: (mintUrl) => readPublicMintInfo(mintUrl),
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
    recoveryIndex?.stop()
    await nativePaymentRequests?.stop().catch(() => {
      process.stderr.write('native payment request shutdown failed\n')
    })
    retirementRetry.stop()
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
  const automaticRetirement =
    signerEnabled && nativeConfig.daemon.autoRetireResolvedConditionInventory
  const resumeConditionRetirements = () =>
    resumeDaemonConditionRetirements({
      profile,
      secrets,
      fence: currentFence(),
      walletDependencies: { getCustodyFence: currentFence },
    })
  const runAutomaticRetirementScan = async (): Promise<ResolvedConditionDiscovery> => {
    const resumed = await resumeConditionRetirements()
    if (!automaticRetirement)
      return { results: resumed, awaitingAttestation: [], discoveryFailures: [] }
    const discovered = await retireResolvedDaemonConditions({
      profile,
      secrets,
      fence: currentFence(),
      engine: retirementEngine,
      walletDependencies: { getCustodyFence: currentFence },
      closedConditionIds,
    })
    return {
      results: mergeRetirementResults(resumed, discovered.results),
      awaitingAttestation: discovered.awaitingAttestation,
      discoveryFailures: discovered.discoveryFailures,
    }
  }
  // One retirement scan runs at a time, and only after the RPC server listens.
  // Until then, a wake, for example from a startup range recovery pass, only
  // records itself. The first scan after the listen serves it.
  let retirementScanOpen = false
  let retirementScanRunning = false
  let retirementScanRequested = false
  let wakeManagedConditionRetirements = async () => {
    retirementScanRequested = true
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
      if (status.state !== 'closed' || !nativeConfig.daemon.autoRetireResolvedConditionInventory) {
        return
      }
      closedConditionIds.add(status.conditionId)
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
    // The start is the wallet open: the writer reads the index once and
    // writes the pending keysets. Later commits ask for an upload. The startup
    // recovery below commits through the same signal.
    const { createDaemonRecoveryIndex, startDaemonRecoveryIndexWriter } =
      await import('./daemonRecoveryIndex.ts')
    const started = startDaemonRecoveryIndexWriter({
      setting: nativeRecoveryIndexRealm(nativeConfig),
      signerEnabled,
      create: (realm) =>
        createDaemonRecoveryIndex({
          directory: profileDir(),
          scopeId,
          walletSeed: Buffer.from(secrets.walletSeedHex, 'hex'),
          realm,
          engineBaseUrl: profile.engineBaseUrl,
          walletMints: nativeConfig.daemon.mintUrls,
          log: (line) => process.stderr.write(`${line}\n`),
        }),
    })
    recoveryIndex = started.writer
    readRecoveryIndexStatus = started.readStatus
    const rangeOrderCoordinator = new DaemonCtfRangeOrderCoordinator(profileDir(), currentFence, {
      observeOrderTimeline,
      ...(options.authorizationLifetimeSeconds === undefined
        ? {}
        : { authorizationLifetimeSeconds: options.authorizationLifetimeSeconds }),
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
      readonly pending: ReadonlyArray<{
        readonly operationId: string
        readonly error: string
        readonly halted?: true
      }>
      readonly released?: ReadonlyArray<{ readonly operationId: string; readonly message: string }>
    }) => {
      if (result.recovered.length > 0) {
        process.stderr.write(`Recovered range operations: ${result.recovered.join(', ')}\n`)
      }
      for (const released of result.released ?? []) {
        process.stderr.write(`Range operation ${released.operationId} ended: ${released.message}\n`)
      }
      for (const pending of result.pending) {
        process.stderr.write(
          pending.halted === true
            ? `Range operation ${pending.operationId} stopped: ${pending.error}\n`
            : `Range operation ${pending.operationId} remains pending: ${pending.error}\n`,
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
            process.stderr.write(`Condition retirement wake failed: ${boundedErrorText(error)}\n`)
          })
        },
        onError: (error: Error) => {
          process.stderr.write(`Range recovery sweep failed: ${boundedErrorText(error)}\n`)
        },
      })
    rangeRecoveryLoop?.accept(initialRangeRecovery)
    const recoverNonRetirementCustody = async () => {
      const consolidationRecovery = await recoverWalletProofConsolidations({
        secrets,
        mutation: () => ({ fence: currentFence(), observedAtMs: Date.now() }),
      })
      const walletRecovery = await recoverPreparedWalletSends({
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
    // Startup completes the unfinished retirements before the RPC server
    // listens. The discovery of newly resolved conditions reads the engine, so
    // it runs after the listen, as the first automatic wake.
    const retirementRecovery = await resumeConditionRetirements()
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
    const { createNativePaymentRequestReceiver } = await import('./nativePaymentRequestReceiver.ts')
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
        if (automaticRetirement && marketHub) {
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
          `Automatic non-retirement custody recovery failed: ${boundedErrorText(error)}\n`,
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
    // An order fill adds a holding without a receive. Each wake watches the
    // markets of the current holdings, so a close of that market wakes the scan.
    const refreshManagedConditionMarkets = async () => {
      if (!automaticRetirement || !orderHubStarted) return
      try {
        await trackManagedConditionMarkets(marketHub, await ensureState())
      } catch (error) {
        process.stderr.write(`Condition market watch failed: ${boundedErrorText(error)}\n`)
      }
    }
    const runRetirementPass = async () => {
      await refreshManagedConditionMarkets()
      const generation = readiness.beginAutomaticRetirementScan()
      try {
        const scan = await runAutomaticRetirementScan()
        // A closed condition stays known until a scan retires it. A failed read keeps it.
        for (const entry of scan.results) {
          if (entry.error === null) closedConditionIds.delete(entry.conditionId)
        }
        const pending = scan.results.filter((entry) => entry.error !== null)
        readiness.completeAutomaticRetirementScan(generation, pending.length > 0)
        // ADR-033 holds funds only until unfinished recovery completes. A failed
        // discovery started no work, so it only reads the condition again later.
        if (
          pending.length > 0 ||
          scan.awaitingAttestation.length > 0 ||
          scan.discoveryFailures.length > 0
        )
          retirementRetry.schedule()
        else retirementRetry.reset()
        await refreshNativePaymentRequestReceiver()
        for (const entry of pending) {
          process.stderr.write(
            `Condition retirement ${entry.conditionId} remains pending: ${entry.error}\n`,
          )
        }
        for (const conditionId of scan.awaitingAttestation) {
          process.stderr.write(
            `Condition ${conditionId} is closed; its attestation is not readable yet\n`,
          )
        }
        for (const entry of scan.discoveryFailures) {
          process.stderr.write(
            `Condition ${entry.conditionId} could not be checked; it is read again later: ${entry.error}\n`,
          )
        }
        if (pending.length === 0 && readiness.isReady()) markCustodyReady()
      } catch (error) {
        // A pass that throws keeps the funds commands held and gets a retry.
        readiness.completeAutomaticRetirementScan(generation, true)
        retirementRetry.schedule()
        await refreshNativePaymentRequestReceiver()
        throw error
      }
    }
    // Two scans could otherwise submit one page twice, and the result of a
    // slow failed pass could be lost. A wake during a scan returns at once and
    // makes the scan run one more pass. The wake reports only the error of the
    // last pass, because a later clean pass supersedes an earlier failure.
    wakeManagedConditionRetirements = async () => {
      retirementScanRequested = true
      if (!retirementScanOpen || retirementScanRunning) return
      retirementScanRunning = true
      let failure: unknown
      try {
        while (retirementScanRequested) {
          retirementScanRequested = false
          try {
            await runRetirementPass()
            failure = undefined
          } catch (error) {
            failure = error
          }
        }
      } finally {
        retirementScanRunning = false
      }
      if (failure !== undefined) throw failure
    }
    if (pendingRetirements.length > 0) retirementRetry.schedule()
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
      readRecoveryIndexStatus,
      launchSettingDigests: nativeSettingOverrideDigests(settingOverrides),
      trackOwnedOrder: async (marketId, orderId) => {
        await orderHub.trackOrder(marketId, orderId)
        await startOrderHubWhenReady()
      },
      prepareSettlementCapability: (input, client, beforeCreateCapability, consentedFeeFacts) =>
        rangeOrderCoordinator.prepare(input, client, beforeCreateCapability, consentedFeeFacts),
      previewSettlementCapabilityFees: (input, client) =>
        rangeOrderCoordinator.previewFeeFacts(input, client),
      triggerSettlementRecovery: () => rangeRecoveryLoop?.trigger(),
      readSettlementRecovery: () => rangeOrderCoordinator.recoveryStatus(),
      retrySettlementRecovery: (operationId) =>
        rangeRecoveryLoop !== undefined && rangeOrderCoordinator.retryHaltedRecovery(operationId),
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
    retirementScanOpen = true
    if (automaticRetirement || retirementScanRequested) {
      void wakeManagedConditionRetirements().catch((error: unknown) => {
        process.stderr.write(`Condition retirement scan failed: ${boundedErrorText(error)}\n`)
      })
    }
    if (readiness.isReady()) markCustodyReady()
    await refreshNativePaymentRequestReceiver()
  } catch (err) {
    await releaseResources().catch(() => undefined)
    throw err
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

/** Watch the markets of the available outcome proofs, the proofs that a retirement redeems. */
async function trackManagedConditionMarkets(
  hub: { setManagedMarkets(marketIds: readonly string[]): Promise<void> },
  state: {
    readonly wallet: {
      readonly proofs: ReadonlyArray<{
        readonly state: 'available' | 'reserved' | 'locked'
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
    if (proof.asset.kind !== 'Outcome' || proof.state !== 'available') continue
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
