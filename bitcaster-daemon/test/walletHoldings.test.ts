import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { readDaemonTokenHoldings } from '../src/walletHoldings.ts'

const MINT_URL = 'https://mint.example'
const CONDITION_ID = 'condition-1'

test('indexed wallet holdings aggregate more than ten thousand proofs without loading bodies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-wallet-holdings-'))
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: MINT_URL,
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
      initializedAtMs: 1,
    })
    const database = await openDaemonStateSqlite(directory)
    const { scopeId } = database
      .prepare("SELECT scope_id AS scopeId FROM custody_scopes WHERE scope_kind = 'wallet'")
      .get() as { scopeId: string }
    database.exec('BEGIN IMMEDIATE')
    try {
      const insert = walletProofInsert(database)
      for (let index = 0; index < 10_000; index += 1) {
        insertProof(insert, {
          index,
          scopeId,
          mintUrl: MINT_URL,
          amount: 1,
          assetKind: 'outcome',
          conditionId: CONDITION_ID,
          outcomeSetId: 'YES|NO',
        })
      }
      insertProof(insert, {
        index: 10_000,
        scopeId,
        mintUrl: MINT_URL,
        amount: 2,
        unit: 'sat',
        assetKind: 'sats',
      })
      insertProof(insert, {
        index: 10_001,
        scopeId,
        mintUrl: MINT_URL,
        amount: 3,
        assetKind: 'sats',
      })
      insertProof(insert, {
        index: 10_002,
        scopeId,
        mintUrl: MINT_URL,
        amount: 500,
        state: 'reserved',
        assetKind: 'outcome',
        conditionId: CONDITION_ID,
        outcomeSetId: 'YES',
      })
      insertProof(insert, {
        index: 10_003,
        scopeId,
        mintUrl: MINT_URL,
        amount: 700,
        assetKind: 'outcome',
        conditionId: 'other-condition',
        outcomeSetId: 'YES',
      })
      insertProof(insert, {
        index: 10_004,
        scopeId,
        mintUrl: 'https://other-mint.example',
        amount: 900,
        assetKind: 'outcome',
        conditionId: CONDITION_ID,
        outcomeSetId: 'YES',
      })
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    } finally {
      database.close()
    }

    assert.deepEqual(
      await readDaemonTokenHoldings(directory, {
        mintUrl: MINT_URL,
        conditionId: CONDITION_ID,
        baseAsset: 'sat',
      }),
      {
        primitiveProofsByAtom: { YES: 10_000, NO: 10_000 },
        complementProofsByAtom: {},
        baseUnitProofs: 2_003,
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function walletProofInsert(database: DatabaseSync) {
  return database.prepare(
    `INSERT INTO target_wallet_proofs (
       proof_id, scope_id, normalized_mint, unit, keyset_id, amount,
       secret, signature, proof_body, state, reserved_by,
       asset_kind, condition_id, outcome_set_id, base_asset,
       created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sat', 1, 1)`,
  )
}

function insertProof(
  insert: ReturnType<DatabaseSync['prepare']>,
  input: {
    readonly index: number
    readonly scopeId: string
    readonly mintUrl: string
    readonly amount: number
    readonly unit?: 'sat' | 'msat'
    readonly state?: 'available' | 'reserved'
    readonly assetKind: 'sats' | 'outcome'
    readonly conditionId?: string
    readonly outcomeSetId?: string
  },
): void {
  const proofId = input.index.toString(16).padStart(64, '0')
  const state = input.state ?? 'available'
  insert.run(
    proofId,
    input.scopeId,
    input.mintUrl,
    input.unit ?? 'msat',
    'keyset-1',
    input.amount,
    `secret-${input.index}`,
    'signature',
    Buffer.from([input.index & 0xff]),
    state,
    state === 'reserved' ? 'reservation-1' : null,
    input.assetKind,
    input.conditionId ?? null,
    input.outcomeSetId ?? null,
  )
}
