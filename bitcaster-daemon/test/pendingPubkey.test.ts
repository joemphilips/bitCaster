import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { generateOrderEphemeralKeypair } from '../src/ephemeralKey.ts'
import { submitPersistedPendingPubkey } from '../src/pendingPubkey.ts'
import { createDaemonSecrets, readSecrets, writeSecrets } from '../src/secrets.ts'
import { submitPendingEphemeralPubkeys } from '../src/server.ts'

async function withDaemonHome(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-pending-pubkey-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await run()
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

test('pending pubkey retries submit one persisted exact keypair', async () => {
  await withDaemonHome(async () => {
    await writeSecrets(createDaemonSecrets('2026-07-12T00:00:00.000Z'))
    const submitted: string[] = []
    const submit = async (publicKeyHex: string) => {
      submitted.push(publicKeyHex)
    }

    const first = await submitPersistedPendingPubkey({
      tradeId: 'trade-1',
      orderId: 'order-1',
      marketId: 'cond-YES',
      submit,
    })
    const second = await submitPersistedPendingPubkey({
      tradeId: 'trade-1',
      orderId: 'order-1',
      marketId: 'cond-YES',
      submit,
    })

    assert.equal(second, first)
    assert.deepEqual(submitted, [first, first])
    const retained = (await readSecrets())?.orderEphemeralKeys['trade-1']
    assert.equal(retained?.orderId, 'order-1')
    assert.equal(retained?.tradeId, 'trade-1')
    assert.equal(retained?.marketId, 'cond-YES')
    assert.equal(retained?.publicKeyHex, first)
  })
})

test('pending pubkey never submits before private-key retention succeeds', async () => {
  await withDaemonHome(async () => {
    let submitCalls = 0
    await assert.rejects(
      () => submitPersistedPendingPubkey({
        tradeId: 'trade-1',
        orderId: 'order-1',
        marketId: 'cond-YES',
        submit: async () => {
          submitCalls += 1
        },
      }),
      /daemon secrets are not initialized/,
    )
    assert.equal(submitCalls, 0)
  })
})

test('direct order pending-pubkey submissions retain one exact key under concurrency', async () => {
  await withDaemonHome(async () => {
    await writeSecrets(createDaemonSecrets('2026-07-12T00:00:00.000Z'))
    const generated = [generateOrderEphemeralKeypair(), generateOrderEphemeralKeypair()]
    let generatedCount = 0
    const submitted: string[] = []
    const input = {
      client: {
        async submitEphemeralPubkey(_tradeId: string, publicKeyHex: string) {
          submitted.push(publicKeyHex)
        },
      },
      marketId: 'cond-YES',
      conditionId: 'cond',
      orderId: 'order-1',
      pendingPubkeySubmissions: [{
        tradeId: 'trade-1',
        role: 'taker' as const,
        fillAmountSubunits: 100,
        deadline: '2026-07-12T00:01:00.000Z',
      }],
      generateEphemeralKeypair: () => generated[generatedCount++],
    }

    await Promise.all([
      submitPendingEphemeralPubkeys(input),
      submitPendingEphemeralPubkeys(input),
    ])

    assert.equal(generatedCount, 1)
    assert.deepEqual(submitted, [generated[0].publicKeyHex, generated[0].publicKeyHex])
    await assert.rejects(
      () => submitPendingEphemeralPubkeys({
        ...input,
        orderId: 'other-order',
      }),
      /stored ephemeral key conflicts/,
    )
  })
})
