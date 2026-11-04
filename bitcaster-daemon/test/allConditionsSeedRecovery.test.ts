import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OutputData } from '@cashu/cashu-ts'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import {
  conditionRecoveryId,
  importedSeedRestoreHint,
  runOfflineDaemonSeedRecoveryAllConditions,
} from '../src/allConditionsSeedRecovery.ts'
import type { OfflineDaemonSeedRecoveryInput } from '../src/emergencySeedRecovery.ts'

const SEED_HEX = 'ab'.repeat(64)
const SEED = Uint8Array.from(Buffer.from(SEED_HEX, 'hex'))
const HELD = '11'.repeat(32)
const UNTOUCHED = '22'.repeat(32)
const FOREIGN = '33'.repeat(32)

function keyset(id: string, conditionId: string, outcomeCollection: string, unit = 'msat') {
  return {
    id,
    unit,
    active: true,
    input_fee_ppk: 0,
    condition_id: conditionId,
    outcome_collection: outcomeCollection,
    outcome_collection_id: deriveRootCtfOutcomeCollectionId({ conditionId, outcomeCollection }),
    registered_at: 1_700_000_000,
  }
}

const KEYSETS = [
  keyset(`01${'a1'.repeat(32)}`, HELD, 'YES'),
  keyset(`01${'a2'.repeat(32)}`, HELD, 'NO'),
  keyset(`01${'b1'.repeat(32)}`, UNTOUCHED, 'YES'),
  keyset(`01${'b2'.repeat(32)}`, UNTOUCHED, 'NO'),
  keyset(`01${'c1'.repeat(32)}`, FOREIGN, 'YES', 'sat'),
]

function fakeMint(signed: Set<string>) {
  const requests: { path: string; body?: unknown }[] = []
  return {
    requests,
    async getConditionalKeysets(query: { condition_id?: string; limit: number; cursor?: string }) {
      requests.push({ path: '/v1/conditional_keysets', body: query })
      return {
        keysets: KEYSETS.filter(
          ({ condition_id }) => query.condition_id === undefined || condition_id === query.condition_id,
        ),
        next_cursor: null,
      }
    },
    async restore(payload: { outputs: unknown[] }) {
      requests.push({ path: '/v1/restore', body: payload })
      const outputs = (payload.outputs as { B_: string; id: string }[]).filter(({ B_ }) =>
        signed.has(B_),
      )
      return {
        outputs,
        signatures: outputs.map(({ id }) => ({ id, amount: 4, C_: `02${'aa'.repeat(32)}` })),
      }
    },
  }
}

async function seedFile(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-all-conditions-'))
  const path = join(directory, 'wallet-seed.hex')
  await writeFile(path, `${SEED_HEX}\n`, { mode: 0o600 })
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test('recovers regular keysets and each catalogue market with a probe signature', async () => {
  const file = await seedFile()
  try {
    const signed = new Set([
      OutputData.createSingleDeterministicData(0, SEED, 3, KEYSETS[1]!.id).blindedMessage.B_,
    ])
    const mint = fakeMint(signed)
    const recoverCalls: OfflineDaemonSeedRecoveryInput[] = []
    const engineRequests: { url: string; headers: unknown }[] = []
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      engineRequests.push({ url: String(url), headers: init?.headers })
      return new Response(
        JSON.stringify({
          markets: [
            { conditionId: HELD, outcomes: ['YES', 'NO'] },
            { conditionId: UNTOUCHED, outcomes: ['YES', 'NO'] },
            { conditionId: FOREIGN, outcomes: ['YES', 'NO'] },
          ],
          nextCursor: null,
          lastSuccessfulRefreshAt: '2026-11-04T00:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    const result = await runOfflineDaemonSeedRecoveryAllConditions(
      {
        recoveryId: 'restore-1',
        mintUrl: 'https://mint.example',
        unit: 'msat',
        walletSeedHexFile: file.path,
        disclosureAcknowledged: true,
      },
      {
        engineBaseUrl: 'https://engine.example',
        fetchImpl,
        mint,
        recover: async (input) => {
          recoverCalls.push(input)
          return { recovered: input.recoveryId } as never
        },
      },
    )

    assert.deepEqual(
      recoverCalls.map(({ recoveryId, scanPolicy }) => ({ recoveryId, scanPolicy })),
      [
        { recoveryId: 'restore-1', scanPolicy: { version: 1, scope: 'regular-msat', gapLimit: 300 } },
        {
          recoveryId: conditionRecoveryId('restore-1', HELD),
          scanPolicy: { version: 1, scope: 'condition', conditionId: HELD, gapLimit: 300 },
        },
      ],
    )
    assert.equal(result.catalogueSource, 'engine')
    assert.equal(result.marketsChecked, 3)
    assert.equal(result.foreignSkipped, 1)
    assert.deepEqual(
      result.conditions.map(({ conditionId }) => conditionId),
      [HELD],
    )
    // The catalogue read is anonymous, and the mint requests carry only outputs.
    assert.deepEqual(engineRequests[0]!.headers, { Accept: 'application/json' })
    const restoreBodies = mint.requests.filter(({ path }) => path === '/v1/restore')
    assert.ok(restoreBodies.length > 0)
    for (const { body } of restoreBodies) {
      assert.deepEqual(Object.keys(body as object), ['outputs'])
      assert.doesNotMatch(JSON.stringify(body), new RegExp(SEED_HEX))
    }
  } finally {
    await file.cleanup()
  }
})

test('uses the strict mint listing when the catalogue is not available', async () => {
  const file = await seedFile()
  try {
    const mint = fakeMint(new Set())
    const result = await runOfflineDaemonSeedRecoveryAllConditions(
      {
        recoveryId: 'restore-2',
        mintUrl: 'https://mint.example',
        unit: 'msat',
        walletSeedHexFile: file.path,
        disclosureAcknowledged: true,
      },
      {
        engineBaseUrl: 'https://engine.example',
        fetchImpl: (async () => new Response('unavailable', { status: 503 })) as typeof fetch,
        mint,
        recover: async () => ({}) as never,
      },
    )
    assert.equal(result.catalogueSource, 'mint')
    // The sat keyset is foreign; the two binary markets remain.
    assert.equal(result.marketsChecked, 2)
    assert.deepEqual(result.conditions, [])
  } finally {
    await file.cleanup()
  }
})

test('names the restore command after an imported seed without a secret', () => {
  const hint = importedSeedRestoreHint('https://mint.example')
  assert.match(hint, /wallet recover-seed .*--all-conditions/)
  assert.match(hint, /--mint https:\/\/mint\.example/)
  assert.doesNotMatch(hint, /[0-9a-f]{64}/)
})
