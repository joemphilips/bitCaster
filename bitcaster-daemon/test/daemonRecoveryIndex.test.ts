import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import {
  deriveRecoveryIndexKeys,
  openRecoveryIndexDocument,
  type RecoveryIndexEntry,
} from '@bitcaster-market/client-sdk/recoveryIndexDocument'
import { RECOVERY_INDEX_REALMS } from '@bitcaster-market/client-sdk/recoveryIndexEngine'
import { RecoveryIndexFakeEngine } from '../../bitcaster-client-sdk/test/support/recoveryIndexFakeEngine.ts'
import {
  createDaemonRecoveryIndex,
  readDaemonRecoveryIndexLocalEntries,
  startDaemonRecoveryIndexWriter,
  type DaemonRecoveryIndex,
} from '../src/daemonRecoveryIndex.ts'
import { dispatch } from '../src/server.ts'
import { advanceDaemonKeysetCounter, type CounterBinding } from '../src/state.ts'
import {
  createDaemonStateSqliteSession,
  withDaemonStateSqliteTransaction,
} from '../src/stateSqlite.ts'
import { createSeedRecoveryProfile, withDaemonHome } from './seedRecoveryTestSupport.ts'
import { canonicalTestKeysetId } from './support/canonicalKeysetId.ts'

const SEED_HEX = '4d'.repeat(64)
const SEED = Uint8Array.from(Buffer.from(SEED_HEX, 'hex'))
const MINT = 'https://mint.example'
const MSAT: CounterBinding = { normalizedMint: MINT, unit: 'msat' }
const REALM = RECOVERY_INDEX_REALMS.local
const KEYS = deriveRecoveryIndexKeys(SEED, REALM)
const START_MS = 1_800_000_000_000
const CONDITION = 'c1'.repeat(32)
const OTHER_CONDITION = 'd2'.repeat(32)
const REGULAR = canonicalTestKeysetId('recovery-index:regular-msat')
const YES = canonicalTestKeysetId('recovery-index:condition-yes')
const OTHER_NO = canonicalTestKeysetId('recovery-index:other-condition-no')
const FAILED_ORDER = canonicalTestKeysetId('recovery-index:failed-order-receive')
const FOREIGN = canonicalTestKeysetId('recovery-index:received-without-counter')

function regular(keysetId: string): RecoveryIndexEntry {
  return { kind: 'regular', mintUrl: MINT, keysetId }
}

/** The conditional entry, with the NUT-CTF root outcome collection id of the outcome. */
function conditional(keysetId: string, conditionId: string, outcome: string): RecoveryIndexEntry {
  return {
    kind: 'conditional',
    mintUrl: MINT,
    keysetId,
    conditionId,
    outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
      conditionId,
      outcomeCollection: outcome,
    }),
  }
}

function sorted(entries: readonly RecoveryIndexEntry[]): RecoveryIndexEntry[] {
  return [...entries].sort((left, right) => left.keysetId.localeCompare(right.keysetId))
}

async function withProfile(
  run: (input: {
    readonly directory: string
    readonly scopeId: string
    readonly counter: (keysetId: string, next: number) => Promise<void>
    readonly proof: (input: ProofFixture) => Promise<void>
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-index-'))
  try {
    await withDaemonHome(directory, async () => {
      const { profile, fence } = await createSeedRecoveryProfile({
        directory,
        walletSeedHex: SEED_HEX,
        nostrSecretKeyHex: '5e'.repeat(32),
        incarnationId: 'recovery-index-incarnation',
      })
      const scopeId = profile.walletScopeId
      await run({
        directory,
        scopeId,
        // The production counter writer: it writes both counter authorities.
        counter: (keysetId, next) =>
          advanceDaemonKeysetCounter(keysetId, next, { fence, observedAtMs: 3 }, MSAT),
        proof: (input) =>
          withDaemonStateSqliteTransaction(directory, (database) =>
            insertProofFixture(database, scopeId, input),
          ),
      })
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

interface ProofFixture {
  readonly store: 'custody' | 'target'
  readonly keysetId: string
  readonly conditionId?: string
  readonly outcome?: string
  readonly label: string
}

/** A proof row in one of the two daemon proof stores. Only its metadata matters here. */
function insertProofFixture(database: DatabaseSync, scopeId: string, input: ProofFixture): void {
  const digest = (suffix: string) =>
    createHash('sha256').update(`${input.label}:${suffix}`).digest('hex')
  const conditionId = input.conditionId ?? null
  const outcome = input.outcome ?? null
  if (input.store === 'custody') {
    database
      .prepare(
        `INSERT INTO custody_proofs (
           proof_id, scope_id, normalized_mint, unit, keyset_id, amount, base_asset,
           condition_id, outcome_set_id, product_binding, proof_body, proof_fingerprint,
           curve, signature_verified, dleq_state, nut07_state, selectability, storage_class,
           reservation_operation_id, revision, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, 'msat', ?, 8, 'sat', ?, ?, NULL, ?, ?, 'secp256k1', 1,
           'verified', 'SPENT', 'spent', 'terminal-replay-retained', NULL, 0, 4, 4)`,
      )
      .run(
        digest('id'),
        scopeId,
        MINT,
        input.keysetId,
        conditionId,
        outcome,
        new Uint8Array([1]),
        digest('fingerprint'),
      )
    return
  }
  database
    .prepare(
      `INSERT INTO target_wallet_proofs (
         proof_id, scope_id, normalized_mint, unit, keyset_id, amount, secret, signature,
         proof_body, state, reserved_by, asset_kind, condition_id, outcome_set_id, base_asset,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 'msat', ?, 8, ?, ?, ?, 'available', NULL, ?, ?, ?, 'sat', 4, 4)`,
    )
    .run(
      digest('id'),
      scopeId,
      MINT,
      input.keysetId,
      digest('secret'),
      digest('signature'),
      new Uint8Array([1]),
      conditionId === null ? 'sats' : 'outcome',
      conditionId,
      outcome,
    )
}

async function localEntries(directory: string, scopeId: string) {
  return sorted(
    await createDaemonStateSqliteSession(directory).read((database) =>
      readDaemonRecoveryIndexLocalEntries(database, scopeId),
    ),
  )
}

/** The entries of the stored document, read with the seed keys. */
function stored(engine: RecoveryIndexFakeEngine): RecoveryIndexEntry[] {
  const row = engine.rows.get(KEYS.locatorPublicKey)
  assert.ok(row?.document != null, 'the engine holds a document')
  return sorted(
    openRecoveryIndexDocument({ keys: KEYS, document: row.document, storeVersion: row.version }),
  )
}

test('the local keysets are the counter keysets whose proofs show their form', async () => {
  await withProfile(async ({ directory, scopeId, counter, proof }) => {
    // The regular keyset: a counter and a spent custody proof.
    await counter(REGULAR, 40)
    await proof({ store: 'custody', keysetId: REGULAR, label: 'regular' })
    // A market keyset: a counter and a live conditional proof of the old store.
    await counter(YES, 12)
    await proof({
      store: 'target',
      keysetId: YES,
      conditionId: CONDITION,
      outcome: 'Yes',
      label: 'yes',
    })
    // A keyset of a failed order: counters, and no signed output.
    await counter(FAILED_ORDER, 17)
    // A received proof that the seed did not derive: no counter.
    await proof({
      store: 'custody',
      keysetId: FOREIGN,
      conditionId: OTHER_CONDITION,
      outcome: 'No',
      label: 'foreign',
    })

    assert.deepEqual(
      await localEntries(directory, scopeId),
      sorted([regular(REGULAR), conditional(YES, CONDITION, 'Yes')]),
    )
  })
})

test('the daemon writes the index at start, and again only after a commit that adds a keyset', async () => {
  await withProfile(async ({ directory, scopeId, counter, proof }) => {
    await counter(REGULAR, 40)
    await proof({ store: 'custody', keysetId: REGULAR, label: 'regular' })
    const engine = new RecoveryIndexFakeEngine(REALM, 'https://engine.example')
    engine.nowSeconds = START_MS / 1000
    const clock = { nowMs: START_MS }
    let commit: (() => void) | undefined
    const index = createDaemonRecoveryIndex({
      directory,
      scopeId,
      walletSeed: SEED,
      realm: REALM,
      engineBaseUrl: engine.baseUrl,
      walletMints: [MINT],
      fetchImpl: engine.fetch,
      nowMs: () => clock.nowMs,
      random: () => 0,
      setTimer: () => assert.fail('no retry is necessary'),
      clearTimer: () => {},
      subscribeToCommits: (callback) => {
        commit = callback
        return () => {
          commit = undefined
        }
      },
    })
    try {
      index.start()
      await index.settled()
      assert.deepEqual(stored(engine), [regular(REGULAR)])
      assert.deepEqual(
        engine.requests.map(({ method }) => method),
        ['GET', 'PUT'],
      )
      assert.deepEqual(index.status(), { realm: REALM, status: 'current' })

      // A commit in a listed keyset, for example a deposit: no engine request.
      await counter(REGULAR, 48)
      commit!()
      await index.settled()
      assert.equal(engine.requests.length, 2)

      // The CLI trades in a market that no other client used.
      clock.nowMs += 5_000
      engine.nowSeconds = clock.nowMs / 1000
      await counter(OTHER_NO, 30)
      await proof({
        store: 'custody',
        keysetId: OTHER_NO,
        conditionId: OTHER_CONDITION,
        outcome: 'No',
        label: 'other-no',
      })
      commit!()
      await index.settled()
      assert.deepEqual(
        stored(engine),
        sorted([regular(REGULAR), conditional(OTHER_NO, OTHER_CONDITION, 'No')]),
      )
      // The first upload of a new keyset reads the index before it writes.
      assert.deepEqual(
        engine.requests.map(({ method }) => method),
        ['GET', 'PUT', 'GET', 'PUT'],
      )
    } finally {
      index.stop()
    }
    assert.equal(commit, undefined, 'stop ends the commit subscription')
  })
})

test('the status command reports the writer of the running daemon', async () => {
  const blocked = await dispatch(
    { method: 'wallet.backup.status' },
    { readRecoveryIndexStatus: () => ({ realm: REALM, status: 'blocked', reason: 'over-cap' }) },
  )
  assert.deepEqual(blocked, {
    ok: true,
    result: { realm: REALM, status: 'blocked', reason: 'over-cap' },
  })

  // A dispatch outside the daemon runtime has no writer.
  assert.deepEqual(await dispatch({ method: 'wallet.backup.status' }), {
    ok: false,
    code: 'recovery-index-unavailable',
    error: 'the recovery index writer is not running',
  })
})

test('the disabled realm setting starts no writer, and the status says disabled', async () => {
  const created: string[] = []
  const fake = (realm: string): DaemonRecoveryIndex => {
    created.push(realm)
    let started = 0
    return {
      start: () => void started++,
      stop: () => {},
      status: () => ({ realm: REALM, status: started === 1 ? 'starting' : 'current' }),
      settled: async () => {},
    }
  }
  const disabled = startDaemonRecoveryIndexWriter({
    setting: 'disabled',
    signerEnabled: true,
    create: fake,
  })
  // No writer means no engine request for the index.
  assert.equal(disabled.writer, undefined)
  assert.deepEqual(created, [])
  assert.deepEqual(
    await dispatch(
      { method: 'wallet.backup.status' },
      { readRecoveryIndexStatus: disabled.readStatus },
    ),
    { ok: true, result: { status: 'disabled' } },
  )

  // A disconnected signer starts no writer either, so no status is available.
  const disconnected = startDaemonRecoveryIndexWriter({
    setting: REALM,
    signerEnabled: false,
    create: fake,
  })
  assert.equal(disconnected.writer, undefined)
  assert.equal(disconnected.readStatus, undefined)
  assert.deepEqual(created, [])

  const running = startDaemonRecoveryIndexWriter({
    setting: REALM,
    signerEnabled: true,
    create: fake,
  })
  assert.deepEqual(created, [REALM])
  assert.deepEqual(running.readStatus?.(), { realm: REALM, status: 'starting' })
})

test('a realm that the engine does not use leaves the upload pending with its reason', async () => {
  await withProfile(async ({ directory, scopeId, counter, proof }) => {
    await counter(REGULAR, 40)
    await proof({ store: 'custody', keysetId: REGULAR, label: 'regular' })
    // The engine signs requests for another realm, so it refuses this request key.
    const engine = new RecoveryIndexFakeEngine(
      RECOVERY_INDEX_REALMS.staging,
      'https://engine.example',
    )
    engine.nowSeconds = START_MS / 1000
    const retries: number[] = []
    const lines: string[] = []
    let commit: (() => void) | undefined
    const index = createDaemonRecoveryIndex({
      directory,
      scopeId,
      walletSeed: SEED,
      realm: REALM,
      engineBaseUrl: engine.baseUrl,
      walletMints: [MINT],
      fetchImpl: engine.fetch,
      nowMs: () => START_MS,
      random: () => 0,
      setTimer: (_callback, delayMs) => {
        retries.push(delayMs)
        return retries.length
      },
      clearTimer: () => {},
      subscribeToCommits: (callback) => {
        commit = callback
        return () => {}
      },
      log: (line) => lines.push(line),
    })
    try {
      index.start()
      await index.settled()
      assert.deepEqual(index.status(), {
        realm: REALM,
        status: 'pending',
        reason: 'unauthenticated',
      })
      assert.equal(engine.count('PUT'), 0)
      assert.deepEqual(retries, [5_000])

      // A commit during the backoff sends nothing. The state and the log still
      // name the refusal, and the log has one line.
      commit!()
      await index.settled()
      assert.deepEqual(index.status(), {
        realm: REALM,
        status: 'pending',
        reason: 'unauthenticated',
      })
      assert.equal(engine.requests.length, 1)
      assert.deepEqual(lines, [
        `Recovery index upload refused: check the recovery index realm ${REALM}`,
      ])
    } finally {
      index.stop()
    }
  })
})

test('a local read failure leaves the upload pending and logs one line', async () => {
  await withProfile(async ({ directory, scopeId }) => {
    const engine = new RecoveryIndexFakeEngine(REALM, 'https://engine.example')
    engine.nowSeconds = START_MS / 1000
    const lines: string[] = []
    const retries: number[] = []
    let commit: (() => void) | undefined
    const index = createDaemonRecoveryIndex({
      directory,
      scopeId,
      walletSeed: SEED,
      realm: REALM,
      engineBaseUrl: engine.baseUrl,
      walletMints: [MINT],
      fetchImpl: engine.fetch,
      nowMs: () => START_MS,
      random: () => 0,
      setTimer: (_callback, delayMs) => {
        retries.push(delayMs)
        return retries.length
      },
      clearTimer: () => {},
      storage: {
        read: async () => {
          throw new Error('profile database is unavailable')
        },
        transaction: async () => {
          throw new Error('the writer never writes the profile')
        },
      },
      subscribeToCommits: (callback) => {
        commit = callback
        return () => {}
      },
      log: (line) => lines.push(line),
    })
    try {
      index.start()
      await index.settled()
      commit!()
      await index.settled()

      assert.deepEqual(index.status(), {
        realm: REALM,
        status: 'pending',
        reason: 'local-failure',
      })
      assert.deepEqual(lines, [
        'Recovery index upload waits: the daemon cannot read its local keysets',
      ])
      // The second failure in a row doubles the wait. No engine request runs.
      assert.deepEqual(retries, [5_000, 10_000])
      assert.equal(engine.requests.length, 0)
    } finally {
      index.stop()
    }
  })
})
