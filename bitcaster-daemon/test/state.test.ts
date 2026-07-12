import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  emptyDaemonState,
  ensureState,
  initializeState,
  prepareProofOperation,
  readState,
  statePath,
  writeState,
} from '../src/state.ts'

async function withDaemonHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-state-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await run(home)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

test('a fresh daemon profile creates only a durable SQLite state database', async () => {
  await withDaemonHome(async (home) => {
    const state = await initializeState()
    assert.deepEqual(state, emptyDaemonState())
    assert.equal(statePath(), join(home, 'daemon-state.sqlite'))
    assert.equal((await readFile(statePath())).subarray(0, 16).toString(), 'SQLite format 3\u0000')
    if (process.platform !== 'win32') {
      assert.equal((await stat(statePath())).mode & 0o777, 0o600)
    }

    const database = new DatabaseSync(statePath())
    try {
      assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    } finally {
      database.close()
    }
  })
})

test('an existing SQLite database with a missing state row fails closed', async () => {
  await withDaemonHome(async () => {
    await initializeState()
    const database = new DatabaseSync(statePath())
    try {
      database.exec('DELETE FROM daemon_state')
    } finally {
      database.close()
    }
    await assert.rejects(() => readState(), /state row is missing/)
    await assert.rejects(() => ensureState(), /state row is missing/)
  })
})

test('a malformed persisted proof never normalizes into an empty or usable state', async () => {
  await withDaemonHome(async () => {
    await initializeState()
    const database = new DatabaseSync(statePath())
    try {
      database.prepare(
        'UPDATE daemon_state SET payload = ? WHERE singleton = 1',
      ).run(JSON.stringify({
        version: 1,
        wallet: {
          proofs: [{
            proof: { amount: 1, secret: 'bearer-secret', C: 'signature', futureField: true },
            mintUrl: 'https://mint.example',
            state: 'available',
            asset: { kind: 'sats' },
            createdAt: '2026-07-12T00:00:00.000Z',
            updatedAt: '2026-07-12T00:00:00.000Z',
          }],
          keysetCounters: {},
        },
        proofOperations: {},
        durableTradeSessions: {},
        orders: {},
        swaps: {},
      }))
    } finally {
      database.close()
    }
    await assert.rejects(() => readState(), /unknown daemon SQLite state field 'futureField'/)
  })
})

test('a malformed persisted local swap never normalizes private recovery material', async () => {
  await withDaemonHome(async () => {
    const state = emptyDaemonState()
    state.swaps['trade-1'] = {
      tradeId: 'trade-1',
      messages: {},
      step: 'awaiting-trade-created',
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    }
    await writeState(state)

    const database = new DatabaseSync(statePath())
    try {
      const row = database.prepare(
        'SELECT payload FROM daemon_state WHERE singleton = 1',
      ).get() as { payload: string }
      const payload = JSON.parse(row.payload) as {
        swaps: Record<string, Record<string, unknown>>
      }
      payload.swaps['trade-1'].sellerAdaptorSecretHex = 'not-hex'
      database.prepare(
        'UPDATE daemon_state SET payload = ? WHERE singleton = 1',
      ).run(JSON.stringify(payload))
    } finally {
      database.close()
    }

    await assert.rejects(() => readState(), /local swap adaptor secret is invalid/)
  })
})

test('state round-trips through SQLite and ignores a legacy JSON state file', async () => {
  await withDaemonHome(async (home) => {
    await writeFile(join(home, 'daemon-state.json'), JSON.stringify({ version: 1, wallet: { proofs: ['legacy'] } }))
    assert.equal(await readState(), null)

    const state = emptyDaemonState()
    state.wallet.keysetCounters['https://mint.example/keyset'] = 3
    await writeState(state)

    assert.deepEqual((await readState())?.wallet.keysetCounters, {
      'https://mint.example/keyset': 3,
    })
  })
})

test('concurrent conflicting prepares cannot overwrite an exact persisted operation', async () => {
  await withDaemonHome(async () => {
    await writeState(emptyDaemonState())
    const operationId = 'exact-operation-race'
    const prepare = (secret: string) => prepareProofOperation({
      operationId,
      kind: 'wallet-send',
      mintUrl: 'https://mint.example',
      inputs: [{ amount: 1, secret, C: `C-${secret}` }],
      outputs: {},
    })
    const results = await Promise.allSettled([prepare('first'), prepare('second')])
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof prepare>>> =>
        result.status === 'fulfilled',
    )
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.match(String(rejected[0]?.reason), /does not match this swap step/)
    assert.equal((await readState())?.proofOperations[operationId]?.inputs[0]?.secret,
      fulfilled[0]?.value.inputs[0]?.secret)
  })
})
