import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { bootstrapFreshDaemonProfile } from '../../bitcaster-daemon/src/profileBootstrap.ts'

const execFileAsync = promisify(execFile)
const MINT = 'https://mint.example'
const DAEMON_SOURCE = new URL('../../bitcaster-daemon/src/', import.meta.url).href
/** The NUT-04 and NUT-05 limits of the production mint, with a lower withdrawal maximum. */
const MINT_INFO = {
  nuts: {
    '4': {
      methods: [{ method: 'bolt11', unit: 'msat', min_amount: 1000, max_amount: 200000000 }],
      disabled: false,
    },
    '5': {
      methods: [{ method: 'bolt11', unit: 'msat', min_amount: 1000, max_amount: 150000000 }],
      disabled: false,
    },
  },
}

let directory: string
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wallet-mint-limits-cli-'))
  await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT,
    walletSeedHex: '11'.repeat(64),
    nostrSecretKeyHex: '22'.repeat(32),
  })
})
after(async () => {
  await rm(directory, { recursive: true, force: true })
})

/**
 * Serve the CLI's daemon RPC with the daemon's own dispatcher and limit check.
 * Only the mint is fake: it serves its info and must receive no quote request.
 * `payResult` replaces the payment operations with the result of one payment.
 */
function preload(payResult?: unknown): string {
  const code = `
    import assert from 'node:assert/strict'
    import { configureDataDir } from ${JSON.stringify(`${DAEMON_SOURCE}dataDir.ts`)}
    import { dispatch } from ${JSON.stringify(`${DAEMON_SOURCE}server.ts`)}
    import { createNativeLightningOpsWithCoordinator } from ${JSON.stringify(`${DAEMON_SOURCE}nativeLightningOps.ts`)}
    import { NativeWalletPaymentOps } from ${JSON.stringify(`${DAEMON_SOURCE}nativeWalletPaymentOps.ts`)}
    configureDataDir(${JSON.stringify(directory)})
    globalThis[Symbol.for('bitcaster.test.daemon-url')] = 'http://daemon.test'
    const readMintInfo = async (mintUrl) => {
      assert.equal(mintUrl, ${JSON.stringify(MINT)})
      return ${JSON.stringify(MINT_INFO)}
    }
    const refuseMintRequest = () => assert.fail('the mint received a quote request')
    const nativeLightningOps = createNativeLightningOpsWithCoordinator(
      { create: refuseMintRequest, get: refuseMintRequest, hide: refuseMintRequest, recoverActivePage: refuseMintRequest },
      ${JSON.stringify(MINT)},
      { readMintInfo },
    )
    const payResult = ${JSON.stringify(payResult ?? null)}
    const nativeWalletPaymentOps = payResult !== null ? { pay: async () => payResult } : new NativeWalletPaymentOps({
      profile: { engineBaseUrl: 'https://engine.example', mintUrl: ${JSON.stringify(MINT)}, initializedAt: new Date(1).toISOString() },
      secrets: { walletSeedHex: '11'.repeat(64) },
      directory: ${JSON.stringify(directory)},
      getFence: refuseMintRequest,
      walletFor: refuseMintRequest,
      readMintInfo,
    })
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'http://daemon.test/rpc')
      const response = await dispatch(JSON.parse(init.body), {
        nativeLightningOps,
        nativeWalletPaymentOps,
        isCustodyReady: () => true,
      })
      return Response.json(response)
    }
  `
  return `data:text/javascript,${encodeURIComponent(code)}`
}

async function run(
  args: string[],
  payResult?: unknown,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        preload(payResult),
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        '--datadir',
        directory,
        ...args,
      ],
      { env: { ...process.env, NODE_NO_WARNINGS: '1' }, timeout: 10000, maxBuffer: 128 * 1024 },
    )
    return { stdout: result.stdout, stderr: result.stderr, code: 0 }
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: failed.code ?? -1 }
  }
}

test('wallet invoice create refuses an amount above the mint deposit maximum', async () => {
  const result = await run(['wallet', 'invoice', 'create', '--amount-msat', '200000001'])

  assert.equal(result.code, 1, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    code: 'amount-outside-mint-limits',
    error: 'This mint accepts 1 to 200,000 sats for each deposit. Deposit in parts.',
    result: {
      direction: 'deposit',
      amountMsat: 200_000_001,
      rejection: { kind: 'above-maximum', minSat: 1, maxSat: 200_000 },
    },
  })
})

test('wallet pay quote refuses an invoice above the mint withdrawal maximum', async () => {
  // The daemon profile directory refuses unknown files, so keep the invoice outside it.
  const invoiceDirectory = await mkdtemp(join(tmpdir(), 'wallet-mint-limits-invoice-'))
  try {
    const invoiceFile = join(invoiceDirectory, 'withdrawal.invoice')
    // 2m = 200,000 sats in the BOLT11 human-readable part.
    await writeFile(invoiceFile, 'lnbc2m1pfakeinvoice\n', { mode: 0o600 })

    const result = await run(['wallet', 'pay', 'quote', '--invoice-file', invoiceFile])

    assert.equal(result.code, 1, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      code: 'amount-outside-mint-limits',
      error: 'This mint accepts 1 to 150,000 sats for each withdrawal. Withdraw in parts.',
      result: {
        direction: 'withdrawal',
        amountMsat: 200_000_000,
        rejection: { kind: 'above-maximum', minSat: 1, maxSat: 150_000 },
      },
    })
  } finally {
    await rm(invoiceDirectory, { recursive: true, force: true })
  }
})

test('wallet pay execute reports a reached mint payment limit with its code', async () => {
  const consentDirectory = await mkdtemp(join(tmpdir(), 'wallet-mint-limits-consent-'))
  try {
    const operationId = `wallet-melt:${'a'.repeat(64)}`
    const consentFile = join(consentDirectory, 'payment-quote.json')
    const consent = {
      operationId,
      walletId: 'b'.repeat(64),
      mintUrl: MINT,
      unit: 'msat',
      method: 'bolt11',
      invoice: 'lnbc10n1pfakeinvoice',
      quoteId: 'payment-quote-1',
      amountMsat: 1_000,
      feeReserveMsat: 22,
      selectedInputFeeMsat: 2,
      totalWalletDebitMsat: 1_024,
      expiryUnixSeconds: 1_900_000_000,
      state: 'UNPAID',
    }
    await writeFile(consentFile, JSON.stringify({ ok: true, result: consent }), { mode: 0o600 })

    const payResult = { operationId, state: 'unpaid', unpaidReason: 'mint-limit', changeCount: 0 }
    const result = await run(
      ['wallet', 'pay', 'execute', '--fee-consent-file', consentFile],
      payResult,
    )

    assert.equal(result.code, 1, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      code: 'mint-payment-limit-reached',
      error:
        "The mint's payment limit is reached. No payment was made. Get a new quote and try again later.",
      result: payResult,
    })
  } finally {
    await rm(consentDirectory, { recursive: true, force: true })
  }
})
