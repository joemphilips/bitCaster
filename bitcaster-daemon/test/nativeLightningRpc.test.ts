import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { dispatch } from '../src/server.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { readSecrets } from '../src/secrets.ts'
import { emptyDaemonState, writeState } from '../src/state.ts'
import { claimCustodyScopeLease, releaseCustodyScopeLease } from '../src/profileFencing.ts'
import type { NativeLightningOps } from '../src/nativeLightningOps.ts'
import { createNativeLightningRecoveryPager } from '../src/nativeLightningOps.ts'
import type { NativeBolt11MintQuoteRecoveryItem } from '../src/nativeBolt11MintQuoteCoordinator.ts'
import type { NativeBolt11MintQuoteView } from '../src/nativeBolt11MintQuoteCoordinator.ts'
import type { DispatchDependencies } from '../src/server.ts'
import type { NativeWalletPaymentRecoveryScan } from '../src/nativeWalletPaymentRecovery.ts'
import { createCustodyReadinessTracker } from '../src/startupRecovery.ts'

test('malformed native invoice params return a redacted refusal without calling the adapter', async () => {
  const calls: string[] = []
  const nativeLightningOps: NativeLightningOps = {
    createInvoice: async () => {
      calls.push('create')
      return invoice('a'.repeat(64))
    },
    showInvoice: async () => {
      calls.push('show')
      return null
    },
    hideInvoice: async () => {
      calls.push('hide')
      return invoice('a'.repeat(64))
    },
    replaceInvoice: async () => {
      calls.push('replace')
      return { invoice: invoice('a'.repeat(64)) }
    },
    recoverPage: async () => {
      calls.push('recover')
      return {
        recovery: { recovered: [], recoveredCount: 0, pending: [] },
        hasMore: false,
        retryPending: false,
        blockingPending: false,
      }
    },
    restartRecoveryScan: () => undefined,
  }
  const malformed = [
    { method: 'wallet.invoice.create' },
    { method: 'wallet.invoice.create', params: null },
    { method: 'wallet.invoice.create', params: {} },
    { method: 'wallet.invoice.replace' },
    { method: 'wallet.invoice.replace', params: null },
    { method: 'wallet.invoice.replace', params: { quoteRecordId: 'b'.repeat(64) } },
    { method: 'wallet.invoice.show', params: null },
    { method: 'wallet.invoice.show', params: {} },
    { method: 'wallet.invoice.hide' },
    { method: 'wallet.invoice.hide', params: {} },
  ]

  for (const request of malformed) {
    const response = await dispatch(request as never, {
      nativeLightningOps,
      isCustodyReady: () => true,
    })
    assert.deepEqual(response, {
      ok: false,
      code: 'invalid-invoice-request',
      error: 'Invoice request is invalid',
    })
  }
  assert.deepEqual(calls, [])
})

test('native invoice RPC validates readiness and dispatches saved quote operations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-native-invoice-rpc-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
    let custodyReady = false
    let recoveryTriggers = 0
    const calls: string[] = []
    const saved = invoice('a'.repeat(64))
    const ops: NativeLightningOps = {
      createInvoice: async (amountMsat) => {
        calls.push(`create:${amountMsat}`)
        return saved
      },
      showInvoice: async (id) => {
        calls.push(`show:${id}`)
        return id === saved.quoteRecordId ? saved : null
      },
      hideInvoice: async (id) => {
        calls.push(`hide:${id}`)
        return { ...saved, presentationState: 'hidden' }
      },
      replaceInvoice: async (id, amountMsat) => {
        calls.push(`replace:${id}:${amountMsat}`)
        return { invoice: { ...saved, requestedAmount: String(amountMsat) } }
      },
      recoverPage: async () => ({
        recovery: { recovered: [], recoveredCount: 0, pending: [] },
        hasMore: false,
        retryPending: false,
        blockingPending: false,
      }),
      restartRecoveryScan: () => undefined,
    }
    const deps = {
      nativeLightningOps: ops,
      isCustodyReady: () => custodyReady,
      triggerCustodyRecovery: () => {
        recoveryTriggers += 1
      },
    }

    const blocked = await dispatch(
      { method: 'wallet.invoice.create', params: { amountMsat: 2_000 } },
      deps,
    )
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'custody-recovery-pending')
    assert.deepEqual(calls, [])

    custodyReady = true
    const invalid = await dispatch(
      { method: 'wallet.invoice.create', params: { amountMsat: 0 } },
      deps,
    )
    assert.equal(invalid.ok, false)
    assert.equal(invalid.code, 'invalid-invoice-request')

    const created = await dispatch(
      { method: 'wallet.invoice.create', params: { amountMsat: 2_000 } },
      deps,
    )
    assert.equal(created.ok, true)
    assert.equal(recoveryTriggers, 1)
    const shown = await dispatch(
      { method: 'wallet.invoice.show', params: { quoteRecordId: saved.quoteRecordId } },
      deps,
    )
    assert.equal(shown.ok, true)
    const hidden = await dispatch(
      { method: 'wallet.invoice.hide', params: { quoteRecordId: saved.quoteRecordId } },
      deps,
    )
    assert.equal(hidden.ok, true)
    const replaced = await dispatch(
      {
        method: 'wallet.invoice.replace',
        params: { quoteRecordId: saved.quoteRecordId, amountMsat: 3_000 },
      },
      deps,
    )
    assert.equal(replaced.ok, true)
    assert.equal(recoveryTriggers, 2)
    assert.deepEqual(calls, [
      'create:2000',
      `show:${saved.quoteRecordId}`,
      `hide:${saved.quoteRecordId}`,
      `replace:${saved.quoteRecordId}:3000`,
    ])
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
  }
})

test('manual wallet recovery shares invoice and payment paging and wakes the custody loop', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-native-invoice-recovery-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  let fence: Awaited<ReturnType<typeof claimCustodyScopeLease>> | undefined
  try {
    const profile = await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '33'.repeat(64),
      nostrSecretKeyHex: '44'.repeat(32),
    })
    const secrets = await readSecrets()
    assert.ok(secrets)
    fence = await claimCustodyScopeLease(home, {
      scopeId: profile.walletScopeId,
      incarnationId: 'native-invoice-recovery-test',
      observedAtMs: Date.now(),
    })
    await writeState(emptyDaemonState())

    let recoveries = 0
    let paymentRecoveries = 0
    let recoveryTriggers = 0
    let manualStatus: { nonRetirementPending: boolean; retryPending: boolean } | undefined
    const nativeLightningOps: NativeLightningOps = {
      createInvoice: async () => invoice('b'.repeat(64)),
      showInvoice: async () => null,
      hideInvoice: async () => invoice('b'.repeat(64)),
      replaceInvoice: async () => ({ invoice: invoice('b'.repeat(64)) }),
      recoverPage: async () => {
        recoveries += 1
        return {
          recovery: { recovered: [], recoveredCount: 0, pending: [] },
          hasMore: true,
          retryPending: true,
          blockingPending: false,
        }
      },
      restartRecoveryScan: () => undefined,
    }
    const paymentRecovery: NativeWalletPaymentRecoveryScan = {
      recovery: {
        recovered: [],
        recoveredCount: 0,
        pending: [
          {
            operationId: `wallet-melt:${'c'.repeat(64)}`,
            error: 'wallet payment remains pending',
          },
        ],
      },
      hasMore: true,
      retryPending: true,
      blockingPending: true,
    }
    const nativeWalletPaymentOps: NonNullable<DispatchDependencies['nativeWalletPaymentOps']> = {
      quote: async () => {
        throw new Error('not used')
      },
      pay: async () => {
        throw new Error('not used')
      },
      status: async () => null,
      recoverPage: async () => {
        paymentRecoveries += 1
        return paymentRecovery
      },
    }

    const response = await dispatch(
      { method: 'wallet.recover' },
      {
        nativeLightningOps,
        nativeWalletPaymentOps,
        getCustodyFence: () => fence!,
        triggerCustodyRecovery: () => {
          recoveryTriggers += 1
        },
        onManualCustodyRecoveryStatus: (status) => {
          manualStatus = status
        },
      },
    )

    assert.equal(response.ok, true, JSON.stringify(response))
    assert.equal(recoveries, 1)
    assert.equal(paymentRecoveries, 1)
    assert.equal(recoveryTriggers, 1)
    assert.equal(manualStatus?.nonRetirementPending, true)
    assert.equal(manualStatus?.retryPending, true)
    assert.deepEqual((response.result as { pending: Array<unknown> }).pending, [
      {
        operationId: `wallet-melt:${'c'.repeat(64)}`,
        error: 'wallet payment remains pending',
      },
    ])
  } finally {
    if (fence !== undefined) {
      await releaseCustodyScopeLease(home, fence, Date.now()).catch(() => undefined)
    }
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
  }
})

test('unpaid invoice paging keeps wallet send available but a recovery error blocks until a clean scan', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-native-invoice-readiness-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  let fence: Awaited<ReturnType<typeof claimCustodyScopeLease>> | undefined
  try {
    const profile = await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '55'.repeat(64),
      nostrSecretKeyHex: '66'.repeat(32),
    })
    const secrets = await readSecrets()
    assert.ok(secrets)
    fence = await claimCustodyScopeLease(home, {
      scopeId: profile.walletScopeId,
      incarnationId: 'native-invoice-readiness-test',
      observedAtMs: Date.now(),
    })
    await writeState(emptyDaemonState())

    const pages: Array<{
      outcomes: readonly NativeBolt11MintQuoteRecoveryItem[]
      nextCursor: string | null
      hasMore: boolean
    }> = [
      {
        outcomes: [
          { quoteRecordId: '8'.repeat(64), outcome: 'unpaid', retryPending: true, blocking: false },
        ],
        nextCursor: 'page-2',
        hasMore: true,
      },
      {
        outcomes: [{ quoteRecordId: '9'.repeat(64), outcome: 'recovered', blocking: false }],
        nextCursor: null,
        hasMore: false,
      },
      {
        outcomes: [
          {
            quoteRecordId: 'a'.repeat(64),
            outcome: 'error',
            blocking: true,
            error: 'redacted recovery error',
          },
        ],
        nextCursor: 'page-2',
        hasMore: true,
      },
      {
        outcomes: [{ quoteRecordId: 'b'.repeat(64), outcome: 'recovered', blocking: false }],
        nextCursor: null,
        hasMore: false,
      },
      {
        outcomes: [{ quoteRecordId: 'c'.repeat(64), outcome: 'recovered', blocking: false }],
        nextCursor: null,
        hasMore: false,
      },
    ]
    const pager = createNativeLightningRecoveryPager(async () => {
      const page = pages.shift()
      assert.ok(page)
      return page
    })
    const readiness = createCustodyReadinessTracker({
      nonRetirementPending: false,
      retryPending: false,
      retirementPending: false,
    })
    const walletCommandCalls = { count: 0 }
    const send = () =>
      dispatch(
        { method: 'wallet.send', params: { amountMsat: 1_000 } },
        {
          isCustodyReady: () => readiness.isReady(),
          getCustodyFence: () => fence!,
          createCashuWallet: () => {
            walletCommandCalls.count += 1
            throw new Error('test wallet construction stopped before mint I/O')
          },
        },
      )
    const applyPage = async () => {
      const generation = readiness.beginAutomaticNonRetirementScan()
      const page = await pager.recoverPage()
      assert.equal(
        readiness.completeAutomaticNonRetirementScan(
          generation,
          page.blockingPending,
          page.retryPending,
        ),
        true,
      )
      return page
    }

    const unpaidFirstPage = await applyPage()
    assert.equal(unpaidFirstPage.hasMore, true)
    assert.equal(unpaidFirstPage.retryPending, true)
    assert.equal(unpaidFirstPage.blockingPending, false)
    assert.equal(readiness.isReady(), true)
    await assert.rejects(send(), /test wallet construction stopped before mint I\/O/)
    const unpaidCycle = await applyPage()
    assert.equal(unpaidCycle.retryPending, true)
    assert.equal(unpaidCycle.blockingPending, false)
    assert.equal(readiness.isReady(), true)
    await assert.rejects(send(), /test wallet construction stopped before mint I\/O/)
    assert.equal(walletCommandCalls.count, 2)

    const errorFirstPage = await applyPage()
    assert.equal(errorFirstPage.blockingPending, true)
    const refusedDuringScan = await send()
    assert.equal(refusedDuringScan.ok, false)
    assert.equal(refusedDuringScan.code, 'custody-recovery-pending')
    const errorCycle = await applyPage()
    assert.equal(errorCycle.blockingPending, true)
    const refusedAfterErrorPage = await send()
    assert.equal(refusedAfterErrorPage.ok, false)
    assert.equal(refusedAfterErrorPage.code, 'custody-recovery-pending')
    assert.equal(walletCommandCalls.count, 2)

    pager.restart()
    const cleanCycle = await applyPage()
    assert.equal(cleanCycle.blockingPending, false)
    assert.equal(readiness.isReady(), true)
    await assert.rejects(send(), /test wallet construction stopped before mint I\/O/)
    assert.equal(walletCommandCalls.count, 3)
  } finally {
    if (fence !== undefined) {
      await releaseCustodyScopeLease(home, fence, Date.now()).catch(() => undefined)
    }
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
  }
})

function invoice(quoteRecordId: string): NativeBolt11MintQuoteView {
  return {
    quoteRecordId,
    mintUrl: 'https://mint.example',
    unit: 'msat',
    paymentMethod: 'bolt11',
    requestedAmount: '2000',
    quoteId: 'invoice-quote',
    invoiceRequest: 'lnbc20n1invoice',
    expiryUnixSeconds: 1_900_000_000,
    presentationState: 'visible',
    observedState: 'UNPAID',
    revision: 0,
  }
}
