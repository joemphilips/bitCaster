import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { updateNativeConfig } from '../src/nativeConfig.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { addAvailableProofs, readState } from '../src/state.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { canonicalTestKeysetId } from './support/canonicalKeysetId.ts'

const CONDITION = 'a'.repeat(64)
/** The discard port. The engine does not answer. */
const ENGINE_URL = 'http://127.0.0.1:9'

// The real process exits here. Nothing of the shutdown is mocked.
test('a daemon that stops during its startup retirement pass leaves a whole profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bc-retire-stop-'))
  const directory = join(root, 'p')
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const held: ServerResponse[] = []
  let markRead!: () => void
  let nextRead = new Promise<void>((resolve) => (markRead = resolve))
  const mint = createServer((request, response) => {
    if (request.url?.startsWith(`/v1/conditions/${CONDITION}`)) {
      // The pass waits for this answer while the daemon stops.
      held.push(response)
      markRead()
      return
    }
    response.writeHead(503).end()
  })
  try {
    mint.listen(0, '127.0.0.1')
    await once(mint, 'listening')
    const mintUrl = `http://127.0.0.1:${(mint.address() as AddressInfo).port}`
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: ENGINE_URL,
      mintUrl,
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
      nativeOracleNonceSeedHex: '33'.repeat(32),
    })
    updateNativeConfig((config) => ({
      ...config,
      cli: { ...config.cli, trustedEngineUrls: [ENGINE_URL] },
      daemon: { ...config.daemon, recoveryIndexRealm: 'disabled', nostrRelays: [] },
    }))
    await addAvailableProofs(
      mintUrl,
      [
        {
          id: canonicalTestKeysetId('retirement-shutdown'),
          amount: 1,
          secret: 'held-proof',
          C: `02${'11'.repeat(32)}`,
        },
      ],
      {
        kind: 'Outcome',
        conditionId: CONDITION,
        outcomeSetId: 'YES',
        baseAsset: 'sat',
        unit: 'msat',
      },
    )
    // The second start proves that the first stop released the profile.
    for (let start = 0; start < 2; start += 1) {
      const daemon = spawn(
        process.execPath,
        [
          '--experimental-strip-types',
          join(import.meta.dirname, '..', 'src', 'main.ts'),
          '--datadir',
          directory,
          'run',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
      let stderr = ''
      daemon.stderr.on('data', (chunk) => (stderr += String(chunk)))
      const exited = once(daemon, 'exit') as Promise<[number | null, string | null]>
      await bounded(
        Promise.race([
          nextRead,
          exited.then(([code]) => {
            throw new Error(`daemon exited with ${code}: ${stderr}`)
          }),
        ]),
        'the retirement pass did not read the mint',
      )
      nextRead = new Promise<void>((resolve) => (markRead = resolve))
      daemon.kill('SIGTERM')
      const [code, signal] = await bounded(exited, 'the daemon did not stop')
      assert.deepEqual([code, signal], [0, null], stderr)
      held.splice(0).forEach((response) => response.destroy())

      const database = await openDaemonStateSqlite(directory)
      try {
        assert.deepEqual(
          { ...database.prepare('PRAGMA integrity_check').get() },
          {
            integrity_check: 'ok',
          },
        )
      } finally {
        database.close()
      }
      const state = await readState()
      assert.deepEqual(
        state.wallet.proofs.map(({ state: proofState }) => proofState),
        ['available'],
      )
    }
  } finally {
    held.forEach((response) => response.destroy())
    mint.closeAllConnections()
    mint.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

/** A failed wait ends after 20 seconds instead of holding the test. */
async function bounded<T>(wait: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 20_000)
  })
  try {
    return await Promise.race([wait, timeout])
  } finally {
    clearTimeout(timer)
  }
}
