import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readRpcToken } from '../src/rpcAuth.ts'
import { createDaemonSecrets, readSecrets } from '../src/secrets.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { completedProofAuthorityDigest } from '@bitcaster-market/client-sdk/ctfSplit'
import { emptyDaemonState, readDaemonKeysetCounters, writeState } from '../src/state.ts'
import { dispatch, orderBackingError, startDaemonServer } from '../src/server.ts'
import {
  createDaemonCompleteSetOutputMode,
  recoverCompleteSetSplits,
} from '../src/completeSetConversion.ts'
import {
  composeStartupCustodyRecovery,
  createCustodyReadinessTracker,
} from '../src/startupRecovery.ts'

async function bootstrapTestProfile(directory: string): Promise<void> {
  await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: '11'.repeat(64),
    nostrSecretKeyHex: '22'.repeat(32),
  })
}

test('startDaemonServer rejects non-loopback bind hosts', async () => {
  await assert.rejects(
    () => startDaemonServer({ host: '0.0.0.0', port: 0 }),
    /refuses to bind non-loopback host 0\.0\.0\.0/,
  )
})

test('complete-set conversion binds its deterministic counters to the live custody fence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-complete-set-counter-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    const profile = await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
    const fence = await claimCustodyScopeLease(directory, {
      scopeId: profile.walletScopeId,
      incarnationId: 'complete-set-test',
      observedAtMs: 1,
    })
    const mode = createDaemonCompleteSetOutputMode('11'.repeat(64), {
      getCustodyFence: () => fence,
    })

    assert.deepEqual(await mode.counterSource.reserve(`01${'a'.repeat(64)}`, 3), {
      start: 0,
      count: 3,
    })
    assert.deepEqual(await readDaemonKeysetCounters(), { [`01${'a'.repeat(64)}`]: 3 })
    assert.throws(() => createDaemonCompleteSetOutputMode('11'.repeat(64), {}), /authority/)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})

test('complete-set startup recovery skips an atomically completed CTF operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-complete-set-recovery-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    const profile = await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
    const fence = await claimCustodyScopeLease(directory, {
      scopeId: profile.walletScopeId,
      incarnationId: 'complete-set-recovery-test',
      observedAtMs: 1,
    })
    const state = emptyDaemonState()
    state.proofOperations['root:ctf-split'] = completedCompleteSetOperation()
    await writeState(state)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error('completed complete-set recovery must not call the mint')
    }
    try {
      const result = await recoverCompleteSetSplits({
        secrets: (await readSecrets())!,
        deps: { getCustodyFence: () => fence },
      })
      assert.deepEqual(result, { recovered: [], recoveredCount: 0, pending: [] })
    } finally {
      globalThis.fetch = originalFetch
    }
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})

test('complete-set pending reports custody unavailable and later clear recovery can mark ready', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-complete-set-startup-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await bootstrapTestProfile(home)
    let recovery = composeStartupCustodyRecovery([
      {
        recovered: [],
        pending: [{ operationId: 'complete-set-root', error: 'mint evidence is pending' }],
      },
    ])
    let markedReady = false
    const markCustodyReady = () => {
      markedReady = true
    }
    const health = await dispatch(
      { method: 'health' },
      {
        isCustodyReady: () => recovery.pending.length === 0,
      },
    )
    assert.equal(health.ok, true)
    if (!health.ok) throw new Error('health command must succeed')
    assert.equal(health.result.state, 'custody-recovery-pending')

    recovery = composeStartupCustodyRecovery([{ recovered: [], pending: [] }])
    if (recovery.pending.length === 0) markCustodyReady()
    assert.equal(markedReady, true)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('manual recovery cannot clear automatic retirement pending custody', () => {
  const readiness = createCustodyReadinessTracker({
    nonRetirementPending: true,
    retirementPending: true,
  })

  readiness.updateManualRecovery({ nonRetirementPending: false, retirementPending: false })
  assert.equal(readiness.isReady(), false)
})

test('latest automatic retirement scan can clear custody readiness', () => {
  const readiness = createCustodyReadinessTracker({
    nonRetirementPending: false,
    retirementPending: true,
  })

  const generation = readiness.beginAutomaticRetirementScan()
  assert.equal(readiness.completeAutomaticRetirementScan(generation, false), true)
  assert.equal(readiness.isReady(), true)
})

test('manual recovery can report newly pending persisted retirement work', () => {
  const readiness = createCustodyReadinessTracker({
    nonRetirementPending: false,
    retirementPending: false,
  })

  readiness.updateManualRecovery({ nonRetirementPending: false, retirementPending: true })
  assert.equal(readiness.isReady(), false)
})

test('older automatic retirement scan result cannot overwrite newer generation', () => {
  const readiness = createCustodyReadinessTracker({
    nonRetirementPending: false,
    retirementPending: true,
  })

  const olderGeneration = readiness.beginAutomaticRetirementScan()
  const latestGeneration = readiness.beginAutomaticRetirementScan()
  assert.equal(readiness.completeAutomaticRetirementScan(latestGeneration, false), true)
  assert.equal(readiness.completeAutomaticRetirementScan(olderGeneration, true), false)
  assert.equal(readiness.isReady(), true)
})

test('manual recovery status callback owns production ready transition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-manual-recovery-status-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    const profile = await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
    const fence = await claimCustodyScopeLease(directory, {
      scopeId: profile.walletScopeId,
      incarnationId: 'manual-recovery-status-test',
      observedAtMs: 1,
    })
    let markedReady = false
    let status: { nonRetirementPending: boolean; retirementPending: boolean } | undefined

    const response = await dispatch(
      { method: 'wallet.recover' },
      {
        getCustodyFence: () => fence,
        markCustodyReady: () => {
          markedReady = true
        },
        onManualCustodyRecoveryStatus: (reported) => {
          status = reported
        },
      },
    )

    assert.equal(response.ok, true)
    assert.deepEqual(status, { nonRetirementPending: false, retirementPending: false })
    assert.equal(markedReady, false)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})

test('startDaemonServer serves local health RPC and returns a closeable server', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-server-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const server = await startDaemonServer({ host: '127.0.0.1', port: 0 })
  try {
    const address = server.address()
    assert.equal(typeof address, 'object')
    assert.ok(address)

    const response = await fetch(`http://127.0.0.1:${address.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'health' }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      ok: true,
      result: {
        status: 'ok',
        service: 'bitcaster-daemon',
        sdk: '@bitcaster-market/client-sdk',
        state: 'missing-profile',
      },
    })
  } finally {
    server.close()
    await once(server, 'close')
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('startDaemonServer serves default Unix socket RPC on Unix', async () => {
  if (process.platform === 'win32') return

  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-server-socket-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const server = await startDaemonServer()
  try {
    const response = await postSocketJson(join(home, 'daemon.sock'), {
      method: 'health',
    })

    assert.deepEqual(response, {
      ok: true,
      result: {
        status: 'ok',
        service: 'bitcaster-daemon',
        sdk: '@bitcaster-market/client-sdk',
        state: 'missing-profile',
      },
    })
  } finally {
    server.close()
    await once(server, 'close')
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('startDaemonServer refuses to replace a live Unix socket daemon', async () => {
  if (process.platform === 'win32') return

  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-live-socket-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const server = await startDaemonServer()
  try {
    await assert.rejects(() => startDaemonServer(), /RPC socket is already in use/)
  } finally {
    server.close()
    await once(server, 'close')
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('startDaemonServer removes stale Unix socket before restart', async () => {
  if (process.platform === 'win32') return

  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-stale-socket-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const socketPath = join(home, 'daemon.sock')
  const stale = spawn(
    process.execPath,
    [
      '-e',
      [
        "const net = require('node:net')",
        'const server = net.createServer()',
        "server.listen(process.argv[1], () => process.stdout.write('ready\\n'))",
        'setInterval(() => {}, 1000)',
      ].join(';'),
      socketPath,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )

  try {
    await once(stale.stdout, 'data')
    stale.kill('SIGKILL')
    await once(stale, 'exit')

    const server = await startDaemonServer()
    try {
      const response = await postSocketJson(socketPath, { method: 'health' })
      assert.equal((response as { ok?: boolean }).ok, true)
    } finally {
      server.close()
      await once(server, 'close')
    }
  } finally {
    if (!stale.killed) stale.kill('SIGKILL')
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('startDaemonServer requires initialized RPC token for non-health commands', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-server-auth-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await bootstrapTestProfile(home)
  const token = (await readRpcToken())!
  const server = await startDaemonServer({ host: '127.0.0.1', port: 0 })
  try {
    const address = server.address()
    assert.equal(typeof address, 'object')
    assert.ok(address)
    const url = `http://127.0.0.1:${address.port}/rpc`

    const missing = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'health' }),
    })
    assert.equal(missing.status, 401)
    assert.deepEqual(await missing.json(), {
      ok: false,
      error: 'unauthorized',
    })

    const authorized = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ method: 'health' }),
    })
    assert.equal(authorized.status, 200)
    assert.equal((await authorized.json()).ok, true)
  } finally {
    server.close()
    await once(server, 'close')
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

function completedCompleteSetOperation() {
  const conditionId = 'ab'.repeat(32)
  const resultProofs = {
    A: [{ id: 'outcome-keyset', amount: 1, secret: 'outcome-A', C: 'C-A' }],
    B: [{ id: 'outcome-keyset', amount: 1, secret: 'outcome-B', C: 'C-B' }],
  }
  return {
    operationId: 'root:ctf-split',
    kind: 'ctf-split' as const,
    state: 'completed' as const,
    mintUrl: 'https://mint.example',
    inputs: [{ id: 'collateral-keyset', amount: 1, secret: 'collateral', C: 'C-collateral' }],
    outputs: {
      A: [
        {
          blindedMessage: { amount: 1, id: 'outcome-keyset', B_: 'blind-A' },
          blindingFactor: 'factor-A',
          secret: 'output-A',
        },
      ],
      B: [
        {
          blindedMessage: { amount: 1, id: 'outcome-keyset', B_: 'blind-B' },
          blindingFactor: 'factor-B',
          secret: 'output-B',
        },
      ],
    },
    metadata: {
      purpose: 'daemon-complete-set-ctf-split',
      rootOperationId: 'root',
      conditionId,
      amountSats: 1,
      amountSubunits: 1,
      reservationId: 'root:ctf-split:reservation',
      inputAsset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      successorAssets: {
        A: { kind: 'Outcome', conditionId, outcomeSetId: 'A', baseAsset: 'sat', unit: 'msat' },
        B: { kind: 'Outcome', conditionId, outcomeSetId: 'B', baseAsset: 'sat', unit: 'msat' },
      },
    },
    resultProofs,
    resultProofsDigest: completedProofAuthorityDigest(resultProofs),
    lastError: null,
    createdAt: 1,
    updatedAt: 2,
  }
}

function postSocketJson(socketPath: string, body: unknown): Promise<unknown> {
  const text = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/rpc',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.on('error', reject)
    req.end(text)
  })
}

test('buy order backing uses quote payment, not face amount', () => {
  assert.equal(
    orderBackingError({
      side: 'Buy',
      price: 4_000,
      amountSubunits: 30_000,
      divisibility: 10_000,
      holdings: {
        baseUnitProofs: 12_000,
        primitiveProofsByAtom: {},
        complementProofsByAtom: {},
      },
    }),
    null,
  )
})

test('sell order backing still uses VCS face amount', () => {
  assert.match(
    orderBackingError({
      side: 'Sell',
      price: 4_000,
      amountSubunits: 30_000,
      divisibility: 10_000,
      holdings: {
        baseUnitProofs: 50_000,
        primitiveProofsByAtom: { Alpha: 20_000 },
        complementProofsByAtom: {},
      },
    }) ?? '',
    /need 3 shares/,
  )
})
