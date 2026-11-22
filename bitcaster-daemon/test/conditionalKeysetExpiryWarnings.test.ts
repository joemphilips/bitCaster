import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  CheckStateEnum,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  hashToCurve,
  pointFromHex,
  type Proof,
} from '@cashu/cashu-ts'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { DurableWalletProofImportCoordinator } from '../src/durableWalletProofImportCoordinator.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'
import { emptyDaemonState, writeState } from '../src/state.ts'
import { dispatch } from '../src/server.ts'
import type { DatabaseSync } from 'node:sqlite'

const MINT = 'https://mint.example'
const DAY_MS = 24 * 60 * 60 * 1_000
const CODE = 'conditional-keyset-final-expiry-soon'
// Whole seconds, as NUT-02 `final_expiry`, so that each fixture time is exact.
const NOW_S = Math.floor(Date.now() / 1_000)

interface FixtureKeyset {
  readonly conditionId: string
  readonly finalExpiry: number | null
  readonly privateKey: Uint8Array
  readonly id: string
  readonly keys: Record<string, string>
  readonly outcomeCollectionId: string
}

function fixtureKeyset(seed: number, finalExpiry: number | null): FixtureKeyset {
  const privateKey = Uint8Array.from([...new Uint8Array(31), seed])
  const keys = { '1': bytesToHex(secp256k1.getPublicKey(privateKey, true)) }
  const conditionId = seed.toString(16).padStart(2, '0').repeat(32)
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId,
    outcomeCollection: 'YES',
  })
  const id = deriveConditionalKeysetId({
    keys,
    unit: 'msat',
    ...(finalExpiry === null ? {} : { final_expiry: finalExpiry }),
    conditionId,
    outcomeCollectionId,
  })
  return { conditionId, finalExpiry, privateKey, id, keys, outcomeCollectionId }
}

// One keyset expires in one day, one in 30 days, and one has no final expiry.
const SOON = fixtureKeyset(0x0a, NOW_S + 1 * 86_400)
const LATER = fixtureKeyset(0x0b, NOW_S + 30 * 86_400)
const NEVER = fixtureKeyset(0x0c, null)

test('a held conditional keyset with a final expiry within 7 days gives one warning', async () => {
  const f = await fixture()
  try {
    for (const keyset of [SOON, LATER, NEVER]) await f.importProof(keyset)
    // The import writer stores the NUT-02 seconds in the millisecond column.
    assert.deepEqual(
      await f.query((db) =>
        db
          .prepare(
            `SELECT keyset_expiry_ms AS expiryMs FROM custody_operations
             WHERE keyset_expiry_ms IS NOT NULL ORDER BY keyset_expiry_ms`,
          )
          .all()
          .map((row) => row.expiryMs),
      ),
      [SOON.finalExpiry, LATER.finalExpiry],
    )
    const expected = [
      {
        code: CODE,
        conditionId: SOON.conditionId,
        keysetId: SOON.id,
        finalExpiryAt: new Date(SOON.finalExpiry! * 1_000).toISOString(),
      },
    ]
    for (const command of [
      { method: 'health' },
      { method: 'daemon.status' },
      { method: 'wallet.balance' },
      { method: 'wallet.positions' },
      { method: 'wallet.portfolio', params: {} },
      // A refused order still carries the warning.
      { method: 'order.submit', params: { timeInForce: 'FOK' } },
    ] as const) {
      const response = await dispatch(command as Parameters<typeof dispatch>[0])
      assert.deepEqual(response.warnings, expected, command.method)
      assert.doesNotMatch(JSON.stringify(response.warnings), /amount|secret/i)
    }
    // A command that does not read holdings does not read the expiries.
    assert.equal('warnings' in (await dispatch({ method: 'order.recovery' })), false)

    // A spent keyset is not held, so its warning ends.
    await f.query((db) => {
      db.prepare(
        `UPDATE custody_proofs SET selectability = 'spent', nut07_state = 'SPENT',
           revision = revision + 1 WHERE keyset_id = ?`,
      ).run(SOON.id)
      db.prepare('DELETE FROM target_wallet_proofs WHERE keyset_id = ?').run(SOON.id)
    })
    assert.equal('warnings' in (await dispatch({ method: 'wallet.balance' })), false)
  } finally {
    await f.close()
  }
})

test('the warning starts less than 7 days before the final expiry and stays after it', async () => {
  const { readConditionalKeysetExpiryWarnings } =
    await import('../src/conditionalKeysetExpiryWarnings.ts')
  const f = await fixture()
  try {
    await f.importProof(SOON)
    const expiryMs = SOON.finalExpiry! * 1_000
    const read = (nowMs: number) =>
      f.query((db) => readConditionalKeysetExpiryWarnings(db, nowMs).map((w) => w.keysetId))
    assert.deepEqual(await read(expiryMs - 7 * DAY_MS), [])
    assert.deepEqual(await read(expiryMs - 7 * DAY_MS + 1), [SOON.id])
    assert.deepEqual(await read(expiryMs + 1), [SOON.id])

    // An operation that also binds another keyset gives only the earliest expiry
    // of all its keysets, so it is not the expiry of this keyset.
    await f.query((db) => {
      const binding = db
        .prepare(
          `SELECT operation_id AS operationId, binding_position AS position
           FROM custody_verification_bindings WHERE keyset_id = ?`,
        )
        .get(SOON.id) as { operationId: string; position: number }
      db.prepare(
        `INSERT INTO custody_verification_bindings (
           scope_id, operation_id, keyset_id, curve, keyset_fingerprint, require_dleq,
           binding_position
         ) VALUES (?, ?, ?, 'secp256k1', ?, 1, ?)`,
      ).run(f.scopeId, binding.operationId, LATER.id, 'f'.repeat(64), binding.position + 1)
    })
    assert.deepEqual(await read(expiryMs + 1), [])
  } finally {
    await f.close()
  }
})

test('the reader reads seconds only for rows of the import writer', async () => {
  const { readConditionalKeysetExpiryWarnings } =
    await import('../src/conditionalKeysetExpiryWarnings.ts')
  const f = await fixture()
  try {
    await f.importProof(SOON)
    const read = () =>
      f.query((db) =>
        readConditionalKeysetExpiryWarnings(db, Date.now()).map((w) => w.finalExpiryAt),
      )
    const at = (ms: number) => new Date(ms).toISOString()
    // An old-style import row holds seconds.
    assert.deepEqual(await read(), [at(SOON.finalExpiry! * 1_000)])
    // An import row that holds milliseconds is read as milliseconds.
    await f.query((db) =>
      db
        .prepare(
          `UPDATE custody_operations SET keyset_expiry_ms = keyset_expiry_ms * 1000
           WHERE retained_operation_key GLOB 'completed-proof-import:*'`,
        )
        .run(),
    )
    assert.deepEqual(await read(), [at(SOON.finalExpiry! * 1_000)])

    // Another writer stores milliseconds. Its row is never read as seconds.
    const otherMs = SOON.finalExpiry! * 1_000 + 3_600_000
    await f.query((db) => {
      copyOperationAsOtherWriter(db, SOON.id, otherMs)
      db.prepare(
        `UPDATE custody_operations SET keyset_expiry_ms = NULL
         WHERE retained_operation_key GLOB 'completed-proof-import:*'`,
      ).run()
    })
    assert.deepEqual(await read(), [at(otherMs)])
    await f.query((db) =>
      db
        .prepare(
          `UPDATE custody_operations SET keyset_expiry_ms = ?
           WHERE retained_operation_key = 'other-writer'`,
        )
        .run(SOON.finalExpiry),
    )
    assert.deepEqual(await read(), [at(SOON.finalExpiry!)])
  } finally {
    await f.close()
  }
})

/** A copy of the operation that binds the keyset, under the key and path of another writer. */
function copyOperationAsOtherWriter(
  database: DatabaseSync,
  keysetId: string,
  expiryMs: number,
): void {
  const binding = database
    .prepare('SELECT * FROM custody_verification_bindings WHERE keyset_id = ?')
    .get(keysetId) as { operation_id: string }
  const columns = (
    database.prepare('PRAGMA table_info(custody_operations)').all() as Array<{ name: string }>
  ).map(({ name }) => name)
  const replaced: Record<string, string> = {
    operation_id: "'other-writer-operation'",
    retained_operation_key: "'other-writer'",
    reservation_id: "'other-writer-reservation'",
    request_path: "'/v1/swap'",
    keyset_expiry_ms: String(expiryMs),
  }
  database
    .prepare(
      `INSERT INTO custody_operations (${columns.join(', ')})
       SELECT ${columns.map((name) => replaced[name] ?? name).join(', ')}
       FROM custody_operations WHERE operation_id = ?`,
    )
    .run(binding.operation_id)
  database
    .prepare(
      `INSERT INTO custody_verification_bindings
         (scope_id, operation_id, keyset_id, curve, keyset_fingerprint, require_dleq, binding_position)
       SELECT scope_id, 'other-writer-operation', keyset_id, curve, keyset_fingerprint, require_dleq,
         binding_position
       FROM custody_verification_bindings WHERE operation_id = ? AND keyset_id = ?`,
    )
    .run(binding.operation_id, keysetId)
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'keyset-expiry-warning-'))
  const previous = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const profile = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT,
    walletSeedHex: '11'.repeat(64),
    nostrSecretKeyHex: '22'.repeat(32),
  })
  await writeState(emptyDaemonState())
  const fence = await claimCustodyScopeLease(directory, {
    scopeId: profile.walletScopeId,
    incarnationId: 'keyset-expiry-warning-test',
    observedAtMs: Date.now(),
  })
  return {
    scopeId: profile.walletScopeId,
    importProof: (keyset: FixtureKeyset) =>
      new DurableWalletProofImportCoordinator(directory, () => fence, Date.now).importOutcomeProofs(
        {
          mintUrl: MINT,
          asset: {
            kind: 'Outcome',
            conditionId: keyset.conditionId,
            outcomeSetId: 'YES',
            baseAsset: 'sat',
            unit: 'msat',
          },
          proofs: [signedProof(keyset)],
          keysets: [
            {
              canonicalMintUrl: MINT,
              id: keyset.id,
              unit: 'msat',
              keys: keyset.keys,
              inputFeePpk: 0,
              finalExpiry: keyset.finalExpiry,
              identity: {
                kind: 'conditional',
                conditionId: keyset.conditionId,
                outcomeCollection: 'YES',
                outcomeCollectionId: keyset.outcomeCollectionId,
              },
            },
          ],
          checkProofsStates: async (proofs) => unspent(proofs),
        },
      ),
    query: <T>(action: (database: import('node:sqlite').DatabaseSync) => T) =>
      withDaemonStateSqliteTransaction(directory, action),
    close: async () => {
      if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previous
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function unspent(proofs: readonly Pick<Proof, 'id' | 'secret'>[]) {
  return proofs.map((proof) => ({
    Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    state: CheckStateEnum.UNSPENT,
    witness: null,
  }))
}

function signedProof(keyset: FixtureKeyset): Proof {
  const output = OutputData.createSingleData(1, keyset.id, `expiry-proof-${keyset.id}`, 1n)
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    keyset.privateKey,
    keyset.id,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), keyset.privateKey)
  return output.toProof(
    {
      id: keyset.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: keyset.id, keys: keyset.keys },
  )
}
