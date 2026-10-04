import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createNativeWalletPaymentRecoveryPager,
  type NativeWalletPaymentRecoveryScan,
} from '../src/nativeWalletPaymentRecovery.ts'
import type { NativeWalletPaymentRecoveryPage } from '../src/nativeWalletPaymentOps.ts'

test('payment recovery preserves pending state across pages until a clean complete scan', async () => {
  const cursors: Array<string | null> = []
  const pages: NativeWalletPaymentRecoveryPage[] = [
    {
      outcomes: [{ operationId: 'wallet-melt:pending', outcome: 'pending' }],
      nextCursor: 'page-2',
      hasMore: true,
    },
    {
      outcomes: [{ operationId: 'wallet-melt:recovered', outcome: 'recovered' }],
      nextCursor: null,
      hasMore: false,
    },
    {
      outcomes: [{ operationId: 'wallet-melt:clean', outcome: 'recovered' }],
      nextCursor: null,
      hasMore: false,
    },
  ]
  const pager = createNativeWalletPaymentRecoveryPager(async ({ cursor }) => {
    cursors.push(cursor)
    const page = pages.shift()
    assert.ok(page)
    return page
  })

  const pendingFirstPage = await pager.recoverPage()
  assert.equal(pendingFirstPage.hasMore, true)
  assert.equal(pendingFirstPage.retryPending, true)
  assert.equal(pendingFirstPage.blockingPending, true)
  assert.deepEqual(pendingFirstPage.recovery.pending, [
    { operationId: 'wallet-melt:pending', error: 'wallet payment remains pending' },
  ])

  const pendingCycle = await pager.recoverPage()
  assert.equal(pendingCycle.hasMore, false)
  assert.equal(pendingCycle.retryPending, true)
  assert.equal(pendingCycle.blockingPending, true)
  assert.deepEqual(pendingCycle.recovery.recovered, ['wallet-melt:recovered'])
  assert.deepEqual(pendingCycle.recovery.pending, [
    { operationId: 'wallet-melt:pending', error: 'wallet payment remains pending' },
  ])

  const cleanCycle = await pager.recoverPage()
  assert.equal(cleanCycle.retryPending, false)
  assert.equal(cleanCycle.blockingPending, false)
  assert.deepEqual(cleanCycle.recovery.pending, [])
  assert.deepEqual(cursors, [null, 'page-2', null])
})

test('a restarted payment scan retains known blocking work and ignores stale rows', async () => {
  let releaseStalePage: ((page: NativeWalletPaymentRecoveryPage) => void) | undefined
  const cursors: Array<string | null> = []
  const pager = createNativeWalletPaymentRecoveryPager(({ cursor }) => {
    cursors.push(cursor)
    if (cursors.length === 1) {
      return new Promise((resolve) => {
        releaseStalePage = resolve
      })
    }
    return Promise.resolve({
      outcomes: [{ operationId: 'wallet-melt:clean', outcome: 'recovered' }],
      nextCursor: null,
      hasMore: false,
    })
  })

  const staleRead = pager.recoverPage()
  pager.restart()
  assert.ok(releaseStalePage)
  releaseStalePage({
    outcomes: [{ operationId: 'wallet-melt:pending', outcome: 'pending' }],
    nextCursor: null,
    hasMore: false,
  })

  const superseded: NativeWalletPaymentRecoveryScan = await staleRead
  assert.equal(superseded.hasMore, true)
  assert.equal(superseded.retryPending, true)
  assert.equal(superseded.blockingPending, true)
  const clean = await pager.recoverPage()
  assert.equal(clean.blockingPending, false)
  assert.deepEqual(cursors, [null, null])
})
