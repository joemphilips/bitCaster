import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { DispatchDependencies } from '../src/server.ts'
import { dispatch } from '../src/server.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import type { WalletPaymentQuote } from '../src/protocol.ts'

test('malformed wallet payment requests are refused before adapter calls', async () => {
  const calls: string[] = []
  const operations = createOperations(calls)
  const malformed = [
    { method: 'wallet.pay.quote' },
    { method: 'wallet.pay.quote', params: null },
    { method: 'wallet.pay.quote', params: {} },
    { method: 'wallet.pay.quote', params: { invoice: '' } },
    { method: 'wallet.pay.quote', params: { invoice: 'x'.repeat(10_001) } },
    { method: 'wallet.pay.quote', params: { invoice: ' lnbc-invalid' } },
    { method: 'wallet.pay.execute' },
    { method: 'wallet.pay.execute', params: null },
    { method: 'wallet.pay.execute', params: { consent: null } },
    {
      method: 'wallet.pay.execute',
      params: { consent: { ...quote(), approvedMaxDebitMsat: 1_200 } },
    },
    { method: 'wallet.pay.status' },
    { method: 'wallet.pay.status', params: { operationId: 'foreign-operation' } },
  ]

  for (const request of malformed) {
    assert.deepEqual(
      await dispatch(request as never, {
        nativeWalletPaymentOps: operations,
        isCustodyReady: () => true,
      }),
      {
        ok: false,
        code: 'invalid-wallet-payment-request',
        error: 'Wallet payment request is invalid',
      },
    )
  }
  assert.deepEqual(calls, [])
})

test('wallet payment RPC binds the exact quote debit and permits read-only status before readiness', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-wallet-payment-rpc-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '71'.repeat(64),
      nostrSecretKeyHex: '72'.repeat(32),
    })
    const calls: string[] = []
    const approvedDebits: number[] = []
    let ready = false
    let failPayment = false
    const operations = createOperations(calls, {
      quote: async ({ invoice }) => {
        calls.push(`quote:${invoice}`)
        return quote(invoice)
      },
      pay: async (approval) => {
        calls.push('pay')
        approvedDebits.push(approval.approvedMaxDebitMsat)
        if (failPayment) throw new Error(`transport error contained ${approval.invoice}`)
        return { operationId: approval.operationId, state: 'pending', changeCount: 0 }
      },
      status: async ({ operationId }) => {
        calls.push(`status:${operationId}`)
        return null
      },
    })
    let recoveryTriggers = 0
    const deps = {
      nativeWalletPaymentOps: operations,
      isCustodyReady: () => ready,
      triggerCustodyRecovery: () => {
        recoveryTriggers += 1
      },
    }

    const blockedQuote = await dispatch(
      { method: 'wallet.pay.quote', params: { invoice: 'lnbc-rpc-invoice' } },
      deps,
    )
    assert.equal(blockedQuote.code, 'custody-recovery-pending')
    assert.deepEqual(calls, [])

    const statusBeforeReadiness = await dispatch(
      { method: 'wallet.pay.status', params: { operationId: quote().operationId } },
      deps,
    )
    assert.deepEqual(statusBeforeReadiness, { ok: true, result: null })
    assert.deepEqual(calls, [`status:${quote().operationId}`])

    ready = true
    const paymentQuote = quote()
    const quoted = await dispatch(
      { method: 'wallet.pay.quote', params: { invoice: paymentQuote.invoice } },
      deps,
    )
    assert.deepEqual(quoted, { ok: true, result: paymentQuote })
    const executed = await dispatch(
      { method: 'wallet.pay.execute', params: { consent: paymentQuote } },
      deps,
    )
    assert.deepEqual(executed, {
      ok: true,
      result: { operationId: paymentQuote.operationId, state: 'pending', changeCount: 0 },
    })
    assert.deepEqual(approvedDebits, [paymentQuote.totalWalletDebitMsat])
    assert.equal(recoveryTriggers, 1)

    failPayment = true
    const failed = await dispatch(
      { method: 'wallet.pay.execute', params: { consent: paymentQuote } },
      deps,
    )
    assert.deepEqual(failed, {
      ok: false,
      code: 'wallet-payment-unconfirmed',
      error: 'Wallet payment could not be confirmed; inspect status before retrying',
      result: { operationId: paymentQuote.operationId },
    })
    assert.doesNotMatch(JSON.stringify(failed), /lnbc-rpc-invoice/)
    assert.equal(recoveryTriggers, 2)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

function createOperations(
  calls: string[],
  overrides: Partial<NonNullable<DispatchDependencies['nativeWalletPaymentOps']>> = {},
): NonNullable<DispatchDependencies['nativeWalletPaymentOps']> {
  return {
    quote: async (input) => {
      calls.push(`quote:${input.invoice}`)
      return quote(input.invoice)
    },
    pay: async (approval) => {
      calls.push('pay')
      return { operationId: approval.operationId, state: 'paid', changeCount: 1 }
    },
    status: async ({ operationId }) => {
      calls.push(`status:${operationId}`)
      return null
    },
    recoverPage: async () => ({
      recovery: { recovered: [], recoveredCount: 0, pending: [] },
      hasMore: false,
      retryPending: false,
      blockingPending: false,
    }),
    ...overrides,
  }
}

function quote(invoice = 'lnbc-rpc-invoice'): WalletPaymentQuote {
  return {
    operationId: `wallet-melt:${'a'.repeat(64)}`,
    walletId: 'b'.repeat(64),
    mintUrl: 'https://mint.example',
    unit: 'msat',
    method: 'bolt11',
    invoice,
    quoteId: 'rpc-quote-1',
    amountMsat: 1_000,
    feeReserveMsat: 22,
    selectedInputFeeMsat: 2,
    totalWalletDebitMsat: 1_024,
    expiryUnixSeconds: 1_900_000_000,
    state: 'UNPAID',
  }
}
