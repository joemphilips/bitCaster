import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createNativeLightningOpsWithCoordinator,
  createNativeLightningRecoveryPager,
  type NativeBolt11MintQuoteCoordinatorLike,
} from '../src/nativeLightningOps.ts'
import type {
  NativeBolt11MintQuoteRecoveryItem,
  NativeBolt11MintQuoteView,
} from '../src/nativeBolt11MintQuoteCoordinator.ts'
import { createCustodyReadinessTracker } from '../src/startupRecovery.ts'
import { MintOperationError } from '@cashu/cashu-ts'
import { NativeMintPaymentAmountError } from '../src/nativeMintPaymentLimits.ts'

const firstInvoice = invoice('a'.repeat(64), 'UNPAID')
const secondInvoice = invoice('b'.repeat(64), 'UNPAID')

test('native invoice replacement does not create a new quote when hiding the old one fails', async () => {
  const calls: string[] = []
  const coordinator: NativeBolt11MintQuoteCoordinatorLike = {
    create: async ({ amountMsat }) => {
      calls.push(`create:${amountMsat}`)
      return secondInvoice
    },
    get: async (id) => {
      calls.push(`get:${id}`)
      return firstInvoice
    },
    hide: async (id) => {
      calls.push(`hide:${id}`)
      throw new Error('hide failed')
    },
    recoverActivePage: async () => ({ outcomes: [], nextCursor: null, hasMore: false }),
  }
  const ops = createNativeLightningOpsWithCoordinator(coordinator, 'https://mint.example')

  await assert.rejects(ops.replaceInvoice(firstInvoice.quoteRecordId, 25_000), /hide failed/)

  assert.deepEqual(calls, [
    `get:${firstInvoice.quoteRecordId}`,
    `hide:${firstInvoice.quoteRecordId}`,
  ])
})

test('native invoice replacement hides the old quote before creating its replacement', async () => {
  const calls: string[] = []
  const coordinator: NativeBolt11MintQuoteCoordinatorLike = {
    create: async ({ amountMsat }) => {
      calls.push(`create:${amountMsat}`)
      return secondInvoice
    },
    get: async (id) => {
      calls.push(`get:${id}`)
      return firstInvoice
    },
    hide: async (id) => {
      calls.push(`hide:${id}`)
      return { ...firstInvoice, presentationState: 'hidden' }
    },
    recoverActivePage: async () => ({ outcomes: [], nextCursor: null, hasMore: false }),
  }
  const ops = createNativeLightningOpsWithCoordinator(coordinator, 'https://mint.example')

  const replacement = await ops.replaceInvoice(firstInvoice.quoteRecordId, 25_000)

  assert.deepEqual(calls, [
    `get:${firstInvoice.quoteRecordId}`,
    `hide:${firstInvoice.quoteRecordId}`,
    'create:25000',
  ])
  assert.deepEqual(replacement, { invoice: secondInvoice })
})

test('native invoice replacement keeps the hidden old quote recoverable when creation fails', async () => {
  const calls: string[] = []
  const recoveryCursors: Array<string | null> = []
  let oldQuoteHidden = false
  const coordinator: NativeBolt11MintQuoteCoordinatorLike = {
    create: async () => {
      calls.push('create')
      throw new Error('mint request failed')
    },
    get: async (id) => {
      calls.push(`get:${id}`)
      return oldQuoteHidden ? { ...firstInvoice, presentationState: 'hidden' } : firstInvoice
    },
    hide: async (id) => {
      calls.push(`hide:${id}`)
      oldQuoteHidden = true
      return { ...firstInvoice, presentationState: 'hidden' }
    },
    recoverActivePage: async ({ cursor }) => {
      recoveryCursors.push(cursor)
      calls.push(`recover:${cursor ?? 'first'}`)
      return oldQuoteHidden
        ? {
            outcomes: [
              { quoteRecordId: firstInvoice.quoteRecordId, outcome: 'recovered', blocking: false },
            ],
            nextCursor: null,
            hasMore: false,
          }
        : {
            outcomes: [
              {
                quoteRecordId: firstInvoice.quoteRecordId,
                outcome: 'unpaid',
                retryPending: true,
                blocking: false,
              },
            ],
            nextCursor: 'page-2',
            hasMore: true,
          }
    },
  }
  const ops = createNativeLightningOpsWithCoordinator(coordinator, 'https://mint.example')

  const beforeReplace = await ops.recoverPage()
  assert.equal(beforeReplace.hasMore, true)

  await assert.rejects(
    ops.replaceInvoice(firstInvoice.quoteRecordId, 30_000),
    /mint request failed/,
  )
  assert.equal((await ops.showInvoice(firstInvoice.quoteRecordId))?.presentationState, 'hidden')
  const recovered = await ops.recoverPage()

  assert.deepEqual(calls, [
    'recover:first',
    `get:${firstInvoice.quoteRecordId}`,
    `hide:${firstInvoice.quoteRecordId}`,
    'create',
    `get:${firstInvoice.quoteRecordId}`,
    'recover:first',
  ])
  assert.deepEqual(recoveryCursors, [null, null])
  assert.deepEqual(recovered.recovery.recovered, [firstInvoice.quoteRecordId])
  assert.equal(recovered.recovery.recoveredCount, 1)
  assert.equal(recovered.retryPending, false)
})

test('saved invoice creation restarts a cursor from the beginning', async () => {
  const cursors: Array<string | null> = []
  const coordinator: NativeBolt11MintQuoteCoordinatorLike = {
    create: async () => secondInvoice,
    get: async () => firstInvoice,
    hide: async () => firstInvoice,
    recoverActivePage: async ({ cursor }) => {
      cursors.push(cursor)
      return cursor === null
        ? { outcomes: [], nextCursor: 'page-2', hasMore: true }
        : { outcomes: [], nextCursor: null, hasMore: false }
    },
  }
  const ops = createNativeLightningOpsWithCoordinator(coordinator, 'https://mint.example')

  assert.equal((await ops.recoverPage()).hasMore, true)
  await ops.createInvoice(25_000)
  assert.equal((await ops.recoverPage()).hasMore, true)
  assert.deepEqual(cursors, [null, null])
})

test('invoice recovery aggregates unpaid and error states until each cursor cycle completes', async () => {
  const pages: Array<{
    outcomes: readonly NativeBolt11MintQuoteRecoveryItem[]
    nextCursor: string | null
    hasMore: boolean
  }> = [
    {
      outcomes: [
        { quoteRecordId: 'c'.repeat(64), outcome: 'unpaid', retryPending: true, blocking: false },
      ],
      nextCursor: 'page-2',
      hasMore: true,
    },
    {
      outcomes: [{ quoteRecordId: 'd'.repeat(64), outcome: 'recovered', blocking: false }],
      nextCursor: null,
      hasMore: false,
    },
    {
      outcomes: [
        {
          quoteRecordId: 'e'.repeat(64),
          outcome: 'error',
          blocking: true,
          error: 'coordinator error detail',
        },
      ],
      nextCursor: 'page-2',
      hasMore: true,
    },
    {
      outcomes: [{ quoteRecordId: 'f'.repeat(64), outcome: 'recovered', blocking: false }],
      nextCursor: null,
      hasMore: false,
    },
    {
      outcomes: [{ quoteRecordId: '1'.repeat(64), outcome: 'recovered', blocking: false }],
      nextCursor: null,
      hasMore: false,
    },
  ]
  const pager = createNativeLightningRecoveryPager(async () => {
    const page = pages.shift()
    assert.ok(page)
    return page
  })

  const unpaidFirstPage = await pager.recoverPage()
  assert.equal(unpaidFirstPage.hasMore, true)
  assert.equal(unpaidFirstPage.retryPending, true)
  assert.equal(unpaidFirstPage.blockingPending, false)
  assert.equal(unpaidFirstPage.recovery.pending.length, 0)
  const recoveredLastPage = await pager.recoverPage()
  assert.equal(recoveredLastPage.hasMore, false)
  assert.equal(recoveredLastPage.retryPending, true)
  assert.equal(recoveredLastPage.blockingPending, false)
  assert.equal(recoveredLastPage.recovery.recoveredCount, 1)
  assert.equal(recoveredLastPage.recovery.pending.length, 0)

  const errorFirstPage = await pager.recoverPage()
  assert.equal(errorFirstPage.blockingPending, true)
  const errorCycleCompleted = await pager.recoverPage()
  assert.equal(errorCycleCompleted.blockingPending, true)
  assert.equal(errorCycleCompleted.retryPending, true)

  pager.restart()
  const nextCompletedCycle = await pager.recoverPage()
  assert.equal(nextCompletedCycle.hasMore, false)
  assert.equal(nextCompletedCycle.blockingPending, false)
  assert.equal(nextCompletedCycle.retryPending, false)
})

test('a recover-page failure stays blocking through partial scans until one clean cycle completes', async () => {
  let calls = 0
  const pager = createNativeLightningRecoveryPager(async () => {
    calls += 1
    if (calls === 1) throw new Error('temporary recovery failure')
    return calls === 2
      ? { outcomes: [], nextCursor: 'page-2', hasMore: true }
      : { outcomes: [], nextCursor: null, hasMore: false }
  })

  await assert.rejects(pager.recoverPage(), /temporary recovery failure/)
  const partial = await pager.recoverPage()
  assert.equal(partial.hasMore, true)
  assert.equal(partial.blockingPending, true)

  const clean = await pager.recoverPage()
  assert.equal(clean.hasMore, false)
  assert.equal(clean.blockingPending, false)
})

test('unpaid invoice pages keep wallet readiness open while a previous error blocks until a clean scan', async () => {
  const pages: Array<{
    outcomes: readonly NativeBolt11MintQuoteRecoveryItem[]
    nextCursor: string | null
    hasMore: boolean
  }> = [
    {
      outcomes: [
        { quoteRecordId: '2'.repeat(64), outcome: 'unpaid', retryPending: true, blocking: false },
      ],
      nextCursor: 'page-2',
      hasMore: true,
    },
    {
      outcomes: [{ quoteRecordId: '3'.repeat(64), outcome: 'recovered', blocking: false }],
      nextCursor: null,
      hasMore: false,
    },
    {
      outcomes: [
        {
          quoteRecordId: '4'.repeat(64),
          outcome: 'error',
          blocking: true,
          error: 'redacted coordinator failure',
        },
      ],
      nextCursor: 'page-2',
      hasMore: true,
    },
    {
      outcomes: [{ quoteRecordId: '5'.repeat(64), outcome: 'recovered', blocking: false }],
      nextCursor: null,
      hasMore: false,
    },
    {
      outcomes: [{ quoteRecordId: '6'.repeat(64), outcome: 'recovered', blocking: false }],
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
  const applyRecoveryPage = async () => {
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

  const unpaidFirstPage = await applyRecoveryPage()
  assert.equal(unpaidFirstPage.retryPending, true)
  assert.equal(unpaidFirstPage.blockingPending, false)
  assert.equal(readiness.isReady(), true)
  const unpaidCycle = await applyRecoveryPage()
  assert.equal(unpaidCycle.retryPending, true)
  assert.equal(unpaidCycle.blockingPending, false)
  assert.equal(readiness.isReady(), true)

  const errorFirstPage = await applyRecoveryPage()
  assert.equal(errorFirstPage.blockingPending, true)
  assert.equal(readiness.isReady(), false)
  const errorCycle = await applyRecoveryPage()
  assert.equal(errorCycle.blockingPending, true)
  assert.equal(readiness.isReady(), false)

  pager.restart()
  const cleanCycle = await applyRecoveryPage()
  assert.equal(cleanCycle.blockingPending, false)
  assert.equal(readiness.isReady(), true)
})

test('invoice recovery cursor reset supersedes a stale in-flight page', async () => {
  let resolveFirst:
    | ((value: {
        outcomes: readonly NativeBolt11MintQuoteRecoveryItem[]
        nextCursor: string | null
        hasMore: boolean
      }) => void)
    | undefined
  const cursors: Array<string | null> = []
  const pager = createNativeLightningRecoveryPager((cursor) => {
    cursors.push(cursor)
    if (cursors.length === 1) {
      return new Promise((resolve) => {
        resolveFirst = resolve
      })
    }
    return Promise.resolve({ outcomes: [], nextCursor: null, hasMore: false })
  })

  const first = pager.recoverPage()
  pager.restart()
  assert.ok(resolveFirst)
  resolveFirst({
    outcomes: [
      {
        quoteRecordId: '7'.repeat(64),
        outcome: 'error',
        blocking: true,
        error: 'coordinator failure',
      },
    ],
    nextCursor: 'stale-cursor',
    hasMore: true,
  })
  const superseded = await first
  assert.equal(superseded.hasMore, true)
  assert.equal(superseded.blockingPending, true)

  const restarted = await pager.recoverPage()
  assert.equal(restarted.hasMore, false)
  assert.equal(restarted.blockingPending, false)
  assert.deepEqual(cursors, [null, null])
})

function mintInfo(maxDepositMsat: number): Record<string, unknown> {
  return {
    nuts: {
      '4': {
        methods: [
          { method: 'bolt11', unit: 'msat', min_amount: 1_000, max_amount: maxDepositMsat },
        ],
        disabled: false,
      },
      '5': { methods: [], disabled: false },
    },
  }
}

function recordingCoordinator(
  calls: string[],
  create: (amountMsat: number) => Promise<NativeBolt11MintQuoteView> = async () => secondInvoice,
): NativeBolt11MintQuoteCoordinatorLike {
  return {
    create: async ({ amountMsat }) => {
      calls.push(`create:${amountMsat}`)
      return create(amountMsat)
    },
    get: async (id) => {
      calls.push(`get:${id}`)
      return firstInvoice
    },
    hide: async (id) => {
      calls.push(`hide:${id}`)
      return { ...firstInvoice, presentationState: 'hidden' }
    },
    recoverActivePage: async () => ({ outcomes: [], nextCursor: null, hasMore: false }),
  }
}

test('invoice creation refuses an amount above the mint maximum before it asks for a quote', async () => {
  const calls: string[] = []
  const reads: string[] = []
  const ops = createNativeLightningOpsWithCoordinator(
    recordingCoordinator(calls),
    'https://mint.example',
    {
      readMintInfo: async (mintUrl) => {
        reads.push(mintUrl)
        return mintInfo(200_000_000)
      },
    },
  )

  const refused = await ops.createInvoice(200_000_001).then(
    () => assert.fail('an amount above the maximum must be refused'),
    (error: unknown) => error,
  )
  assert.ok(refused instanceof NativeMintPaymentAmountError)
  assert.equal(
    refused.message,
    'This mint accepts 1 to 200,000 sats for each deposit. Deposit in parts.',
  )
  assert.equal(refused.direction, 'deposit')
  assert.equal(refused.amountMsat, 200_000_001)
  assert.deepEqual(refused.rejection, { kind: 'above-maximum', minSat: 1, maxSat: 200_000 })
  assert.deepEqual(calls, [])

  assert.deepEqual(await ops.createInvoice(200_000_000), secondInvoice)
  assert.deepEqual(calls, ['create:200000000'])
  assert.deepEqual(reads, ['https://mint.example', 'https://mint.example'])
})

test('a mint refusal is explained with limits read again after the refusal', async () => {
  const calls: string[] = []
  const infos = [mintInfo(300_000_000), mintInfo(100_000_000)]
  const ops = createNativeLightningOpsWithCoordinator(
    recordingCoordinator(calls, async () => {
      throw new MintOperationError(
        11006,
        'Amount must be between `1000` and `100000000` is `150000000`',
      )
    }),
    'https://mint.example',
    { readMintInfo: async () => infos.shift() },
  )

  await assert.rejects(
    ops.createInvoice(150_000_000),
    (error: unknown) =>
      error instanceof NativeMintPaymentAmountError &&
      error.message === 'This mint accepts 1 to 100,000 sats for each deposit. Deposit in parts.',
  )
  assert.deepEqual(calls, ['create:150000000'])
  assert.deepEqual(infos, [])
})

test('unavailable mint limits leave the limit check to the mint', async () => {
  const calls: string[] = []
  const ops = createNativeLightningOpsWithCoordinator(
    recordingCoordinator(calls, async () => {
      throw new Error('mint request failed')
    }),
    'https://mint.example',
    {
      readMintInfo: async () => {
        throw new Error('mint info is unavailable')
      },
    },
  )

  await assert.rejects(ops.createInvoice(300_000_000), /mint request failed/)
  assert.deepEqual(calls, ['create:300000000'])
})

test('invoice replacement refuses an amount above the maximum before it hides the old invoice', async () => {
  const calls: string[] = []
  const ops = createNativeLightningOpsWithCoordinator(
    recordingCoordinator(calls),
    'https://mint.example',
    { readMintInfo: async () => mintInfo(200_000_000) },
  )

  await assert.rejects(
    ops.replaceInvoice(firstInvoice.quoteRecordId, 250_000_000),
    NativeMintPaymentAmountError,
  )
  assert.deepEqual(calls, [`get:${firstInvoice.quoteRecordId}`])
})

function invoice(
  quoteRecordId: string,
  observedState: NativeBolt11MintQuoteView['observedState'],
): NativeBolt11MintQuoteView {
  return {
    quoteRecordId,
    mintUrl: 'https://mint.example',
    unit: 'msat',
    paymentMethod: 'bolt11',
    requestedAmount: '25000',
    quoteId: `mint-quote-${quoteRecordId.slice(0, 8)}`,
    invoiceRequest: `lnbc250n1${quoteRecordId.slice(0, 20)}`,
    expiryUnixSeconds: 1_900_000_000,
    presentationState: 'visible',
    observedState,
    revision: 0,
  }
}

test('a replacement refused after the old invoice is hidden says that the old invoice is hidden', async () => {
  const calls: string[] = []
  const infos: unknown[] = [undefined, mintInfo(100_000_000)]
  const ops = createNativeLightningOpsWithCoordinator(
    recordingCoordinator(calls, async () => {
      throw new MintOperationError(11006, 'Amount out of limit range')
    }),
    'https://mint.example',
    {
      readMintInfo: async () => {
        const info = infos.shift()
        if (info === undefined) throw new Error('mint info is unavailable')
        return info
      },
    },
  )

  await assert.rejects(
    ops.replaceInvoice(firstInvoice.quoteRecordId, 150_000_000),
    (error: unknown) =>
      error instanceof NativeMintPaymentAmountError && error.previousInvoiceHidden,
  )
  assert.deepEqual(calls, [
    `get:${firstInvoice.quoteRecordId}`,
    `hide:${firstInvoice.quoteRecordId}`,
    'create:150000000',
  ])
})
