import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  createCtfRangePreparationIntent,
  decodeCtfRangeOrderPreparationFromRecord,
  type PersistedCtfRangeOrderPreparationV2,
} from '@bitcaster-market/client-sdk/ctfRangeOrderProtocol'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import {
  deriveRecoveryIndexKeys,
  openRecoveryIndexDocument,
  type RecoveryIndexEntry,
} from '@bitcaster-market/client-sdk/recoveryIndexDocument'
import { RECOVERY_INDEX_REALMS } from '@bitcaster-market/client-sdk/recoveryIndexEngine'
import { mintDenominationKeys } from '../../bitcaster-client-sdk/test/support/mintDenominationKeys.ts'
import { RecoveryIndexFakeEngine } from '../../bitcaster-client-sdk/test/support/recoveryIndexFakeEngine.ts'
import { signedOwnerRangeFixture } from '../../bitcaster-client-sdk/test/support/signedOwnerRangeFixture.ts'
import {
  encodeCanonicalRangePreparation,
  insertRangePreparation,
  toSdkRangePreparationRecord,
  transitionRangePreparation,
  type RangePreparationRecord,
} from '../src/ctfRangeOrderJournalSqlite.ts'
import {
  createDaemonRecoveryIndex,
  DaemonBuyReceiveForms,
  readDaemonRecoveryIndexLocalEntries,
  startDaemonRecoveryIndexWriter,
  type DaemonRecoveryIndex,
} from '../src/daemonRecoveryIndex.ts'
import type { CustodyScopeFence } from '../src/profileFencing.ts'
import { dispatch } from '../src/server.ts'
import {
  advanceDaemonKeysetCounter,
  reserveDaemonCtfPreparation,
  type CounterBinding,
} from '../src/state.ts'
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
    readonly fence: CustodyScopeFence
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
        fence,
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

/** An order of one YES share whose mint keys derive its keyset ids (NUT-02, NUT-CTF). */
function orderCandidate(side: 'Buy' | 'Sell' = 'Buy'): PersistedCtfRangeOrderPreparationV2 {
  const { preparation } = signedOwnerRangeFixture({ plain: false, seed: SEED, side })
  if (preparation.version !== 2) throw new Error('the fixture must give a preparation candidate')
  return preparation
}

/**
 * The production reservation of `order submit`: the counters of the offer and
 * receive keysets and the preparation, in one commit. No output is admitted.
 */
async function reservePreparation(
  directory: string,
  fence: CustodyScopeFence,
  candidate: PersistedCtfRangeOrderPreparationV2,
  offerStart = 0,
) {
  const record = await reserveDaemonCtfPreparation({
    storage: createDaemonStateSqliteSession(directory),
    mutation: { fence, observedAtMs: 5 },
    intent: createCtfRangePreparationIntent({
      scopeId: fence.scopeId,
      request: candidate.request,
      feeConsentBytes: null,
      consolidateProofs: false,
    }).intent,
    candidate,
    seed: SEED,
    counterStarts: { offer: offerStart, receive: 0 },
  })
  assert.ok(record !== null, 'the counters of a fresh profile start at 0')
  return record
}

async function endPreparation(
  directory: string,
  record: { readonly scopeId: string; readonly rangeOperationId: string },
) {
  await withDaemonStateSqliteTransaction(directory, (database) =>
    transitionRangePreparation(database, {
      scopeId: record.scopeId,
      rangeOperationId: record.rangeOperationId,
      expectedRevision: 0,
      from: 'prepared',
      to: 'terminal',
      updatedAtMs: 6,
    }),
  )
}

async function localEntries(
  directory: string,
  scopeId: string,
  buyReceiveForms?: DaemonBuyReceiveForms,
) {
  return sorted(
    await createDaemonStateSqliteSession(directory).read((database) =>
      readDaemonRecoveryIndexLocalEntries(database, scopeId, buyReceiveForms),
    ),
  )
}

/** The production decoder, with a count of its calls. */
function countingDecoder() {
  const decoder = {
    calls: 0,
    decode: (record: RangePreparationRecord) => {
      decoder.calls += 1
      return decodeCtfRangeOrderPreparationFromRecord(toSdkRangePreparationRecord(record))
    },
  }
  return decoder
}

/** An active Buy row whose body is not a preparation, for example after storage damage. */
async function insertUnreadableBuy(directory: string, scopeId: string) {
  await withDaemonStateSqliteTransaction(directory, (database) =>
    insertRangePreparation(database, {
      scopeId,
      rangeOperationId: 'range:unreadable',
      sourceOperationId: 'source:unreadable',
      authorizationId: 'authorization:unreadable',
      clientOrderId: 'unreadable',
      orderRouteId: `${CONDITION}-Yes`,
      normalizedMint: MINT,
      conditionId: CONDITION,
      unit: 'msat',
      tokenSide: 'Outcome',
      side: 'Buy',
      priceSubunits: 500,
      amountSubunits: 1_000,
      minimumFillAmountSubunits: 1_000,
      consolidateProofs: false,
      divisibility: 1_000,
      authorizationExpiresAtUnixSeconds: 2_000_000_000,
      preparationBytes: encodeCanonicalRangePreparation({ rangeOperationId: 'range:unreadable' }),
      feeConsentBytes: null,
      createdAtMs: 1,
    }),
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

test('a Buy lists its receive keyset at the counter reservation, and its admitted output changes no document', async () => {
  await withProfile(async ({ directory, scopeId, fence, counter, proof }) => {
    const candidate = orderCandidate()
    const payment = regular(candidate.offerKeyset.id)
    const receive = conditional(candidate.receiveKeyset.id, candidate.conditionId, 'YES')
    // The wallet pays the Buy from its regular keyset.
    await counter(candidate.offerKeyset.id, 40)
    await proof({ store: 'custody', keysetId: candidate.offerKeyset.id, label: 'payment' })
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
        return () => {}
      },
    })
    try {
      index.start()
      await index.settled()
      assert.deepEqual(stored(engine), [payment])

      // `order submit` reserves the counters. The daemon can stop before it
      // admits the outputs, so the reservation commit lists the receive keyset.
      clock.nowMs += 5_000
      engine.nowSeconds = clock.nowMs / 1000
      const record = await reservePreparation(directory, fence, candidate, 40)
      commit!()
      await index.settled()
      const listed = sorted([payment, receive])
      assert.deepEqual(stored(engine), listed)
      const requests = engine.requests.length

      // The order fills: the daemon admits the output, and the preparation ends.
      await proof({
        store: 'custody',
        keysetId: candidate.receiveKeyset.id,
        conditionId: candidate.conditionId,
        outcome: 'YES',
        label: 'filled',
      })
      await endPreparation(directory, record)
      assert.deepEqual(await localEntries(directory, scopeId), listed)
      commit!()
      await index.settled()
      assert.equal(engine.requests.length, requests, 'the proof row gives the listed entry')
      assert.deepEqual(stored(engine), listed)
    } finally {
      index.stop()
    }
  })
})

test('a Buy that ends without an output gives its receive keyset no form', async () => {
  await withProfile(async ({ directory, scopeId, fence }) => {
    const candidate = orderCandidate()
    const record = await reservePreparation(directory, fence, candidate)
    assert.deepEqual(await localEntries(directory, scopeId), [
      conditional(candidate.receiveKeyset.id, candidate.conditionId, 'YES'),
    ])

    // For example, the engine refuses the order. The mint signs no output.
    await endPreparation(directory, record)
    assert.deepEqual(await localEntries(directory, scopeId), [])
  })
})

test('a Buy receive keyset that its mint keys do not derive gives no form', async () => {
  await withProfile(async ({ directory, scopeId, fence }) => {
    const candidate = orderCandidate()
    const foreignKeys = mintDenominationKeys(
      new Uint8Array(32).fill(9),
      Object.keys(candidate.receiveKeyset.keys),
    )
    await reservePreparation(directory, fence, {
      ...candidate,
      receiveKeyset: { ...candidate.receiveKeyset, keys: foreignKeys },
    })

    // The keyset id does not commit to this condition with these keys, so the
    // form waits for the first proof row.
    assert.deepEqual(await localEntries(directory, scopeId), [])
  })
})

test('a Buy whose stored outcome collection id is not the id of its outcome collection gives no form', async () => {
  await withProfile(async ({ directory, scopeId, fence }) => {
    const candidate = orderCandidate()
    await reservePreparation(directory, fence, {
      ...candidate,
      receiveKeyset: {
        ...candidate.receiveKeyset,
        outcomeCollectionId: 'ee'.repeat(32),
      } as PersistedCtfRangeOrderPreparationV2['receiveKeyset'],
    })

    assert.deepEqual(await localEntries(directory, scopeId), [])
  })
})

test('an active Sell gives no form, and the writer does not decode it', async () => {
  await withProfile(async ({ directory, scopeId, fence }) => {
    // The Sell reserves counters in its conditional offer keyset and its regular receive keyset.
    await reservePreparation(directory, fence, orderCandidate('Sell'))
    const decoder = countingDecoder()

    assert.deepEqual(
      await localEntries(directory, scopeId, new DaemonBuyReceiveForms({ decode: decoder.decode })),
      [],
    )
    assert.equal(decoder.calls, 0)
  })
})

test('the writer decodes each active Buy once, and forgets it when it ends', async () => {
  await withProfile(async ({ directory, scopeId, fence }) => {
    const candidate = orderCandidate()
    const record = await reservePreparation(directory, fence, candidate)
    const decoder = countingDecoder()
    const forms = new DaemonBuyReceiveForms({ decode: decoder.decode })
    const receive = [conditional(candidate.receiveKeyset.id, candidate.conditionId, 'YES')]

    // The upload can read the local keysets twice. The preparation body does not change.
    assert.deepEqual(await localEntries(directory, scopeId, forms), receive)
    assert.deepEqual(await localEntries(directory, scopeId, forms), receive)
    assert.equal(decoder.calls, 1)
    assert.deepEqual(forms.rangeOperationIds, [record.rangeOperationId])

    await endPreparation(directory, record)
    assert.deepEqual(await localEntries(directory, scopeId, forms), [])
    assert.deepEqual(forms.rangeOperationIds, [])
    assert.equal(decoder.calls, 1)
  })
})

test('an unreadable active Buy is skipped with one log line, and other keysets still upload', async () => {
  await withProfile(async ({ directory, scopeId, counter, proof }) => {
    await counter(REGULAR, 40)
    await proof({ store: 'custody', keysetId: REGULAR, label: 'regular' })
    // A keyset with counters and no proof row makes the writer read the preparations.
    await counter(FAILED_ORDER, 17)
    await insertUnreadableBuy(directory, scopeId)
    const engine = new RecoveryIndexFakeEngine(REALM, 'https://engine.example')
    engine.nowSeconds = START_MS / 1000
    const clock = { nowMs: START_MS }
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
      nowMs: () => clock.nowMs,
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
      assert.deepEqual(index.status(), { realm: REALM, status: 'current' })
      assert.deepEqual(stored(engine), [regular(REGULAR)])

      // A new market keyset still uploads. The skipped record logs no second line.
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
      assert.deepEqual(lines, [
        'Recovery index skips an order preparation that the daemon cannot read',
      ])
      assert.deepEqual(retries, [])
    } finally {
      index.stop()
    }
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
