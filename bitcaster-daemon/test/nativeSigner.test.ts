import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import {
  bootstrapFreshDaemonProfile,
  readBootstrappedProfileSecrets,
} from '../src/profileBootstrap.ts'
import { createDaemonStateSqliteSession } from '../src/stateSqlite.ts'
import { acquireDaemonRunLock } from '../src/runLock.ts'
import {
  readSelectedDaemonSigner,
  disconnectDaemonSigner,
  reconnectDaemonSigner,
  replaceDaemonSigner,
  DaemonSignerEditError,
  readSecrets,
} from '../src/secrets.ts'
import { createNativeOracleCreationStore } from '../src/nativeOracleCreationStore.ts'
import {
  prepareNativeMarketOracle,
  signNativeMarketOutcome,
  type NativeMarketCreationInput,
} from '../src/nativeMarketOracle.ts'
import { deriveNostrPublicKey } from '../src/profileSecretProtection.ts'
import { dispatch } from '../src/server.ts'
import { addAvailableProofs } from '../src/state.ts'

const KEY = '22'.repeat(32),
  NEXT = '44'.repeat(32),
  SEED = '11'.repeat(64),
  NONCE = '33'.repeat(32)
const input: NativeMarketCreationInput = {
  creationId: 'old',
  eventId: 'old-event',
  market: {
    title: 'Choice',
    description: 'Choose',
    outcomeType: 'yesno',
    outcomeDetails: [{ name: 'Yes' }, { name: 'No' }],
    maturityEpoch: 2_000_000_000,
    categoryTags: [],
    baseAsset: 'sat',
  },
  registration: { requiredFeeMsat: 0 },
  destination: {
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    relayUrls: [],
  },
}

for (const passphrase of [undefined, 'fixture-passphrase']) {
  test(`replacement keeps wallet and nonce authority with ${passphrase ? 'encrypted' : 'owner-only'} secrets`, async () => {
    await fixture(passphrase, async (f) => {
      await addAvailableProofs(
        'https://mint.example',
        [
          {
            id: '01' + 'ab'.repeat(32),
            amount: 1,
            secret: 'fixture-proof',
            C: '02' + 'ab'.repeat(32),
          },
        ],
        { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      )
      await f.session.transaction((db) =>
        db
          .prepare(`INSERT INTO target_keyset_counters VALUES (?,?, 'msat',?,17,0)`)
          .run(f.scope, 'https://mint.example', '01' + 'ab'.repeat(32)),
      )
      const before = await custodyDigest(f)
      const old = await prepareNativeMarketOracle(f.oracle(KEY), input)
      const replaced = await replaceDaemonSigner({ expectedRevision: 0, nostrSecretKeyHex: NEXT })
      assert.equal(replaced.publicKeyHex, deriveNostrPublicKey(NEXT))
      assert.equal(replaced.enabled, true)
      const restarted = await readBootstrappedProfileSecrets(f.directory, passphrase)
      assert.ok(restarted.walletSeedHex === SEED, 'wallet seed changed')
      assert.ok(restarted.nativeOracleNonceSeedHex === NONCE, 'nonce master changed')
      assert.ok(restarted.nostrSecretKeyHex === NEXT, 'replacement did not survive restart')
      assert.equal(await custodyDigest(f), before)
      const original = await createNativeOracleCreationStore(f.directory, {
        passphrase,
      }).readCreationSigner('old')
      assert.ok(original.secretKeyHex === KEY, 'original signer was not retained')
      await assert.rejects(
        signNativeMarketOutcome(f.oracle(NEXT), old.record.announcement!.conditionId, 'Yes'),
        /requires signer/,
      )
      assert.equal((await f.store.readCreation('old'))!.chosenOutcome, null)
      await signNativeMarketOutcome(
        f.oracle(original.secretKeyHex),
        old.record.announcement!.conditionId,
        'Yes',
      )
      const resumed = await prepareNativeMarketOracle(f.oracle(original.secretKeyHex), input)
      assert.equal(resumed.record.creatorPublicKeyHex, deriveNostrPublicKey(KEY))
      const fresh = await prepareNativeMarketOracle(f.oracle(NEXT), {
        ...input,
        creationId: 'new',
        eventId: 'new-event',
      })
      assert.equal(fresh.record.creatorPublicKeyHex, deriveNostrPublicKey(NEXT))
      assert.equal(fresh.record.nonceIndex, 1)
      assert.equal(await custodyDigest(f), before)
      if (passphrase) {
        const bytes = await readFile(join(f.directory, 'daemon-state.sqlite'))
        assert.ok(
          !bytes.includes(Buffer.from(KEY, 'hex')) && !bytes.includes(Buffer.from(NEXT, 'hex')),
          'private signer persisted without protection',
        )
      }
    })
  })
}

test('disconnect retains identity and requires an explicit reconnect, including after replacement', async () => {
  await fixture(undefined, async (f) => {
    const before = await custodyDigest(f)
    assert.equal((await disconnectDaemonSigner(0)).enabled, false)
    assert.ok((await readSecrets())!.nostrSecretKeyHex === KEY, 'disconnect discarded signer')
    assert.equal((await readSelectedDaemonSigner()).publicKeyHex, deriveNostrPublicKey(KEY))
    assert.equal(
      (await replaceDaemonSigner({ expectedRevision: 1, nostrSecretKeyHex: NEXT })).enabled,
      false,
    )
    assert.equal((await reconnectDaemonSigner(2)).enabled, true)
    assert.equal(await custodyDigest(f), before)
  })
})

test('an interrupted reserved creation resumes its original key and nonce after replacement and restart', async () => {
  await fixture('fixture-passphrase', async (f) => {
    const failed = f.oracle(KEY)
    failed.helper.createEnum = async () => {
      throw new Error('helper response lost')
    }
    await assert.rejects(prepareNativeMarketOracle(failed, input), /response lost/)
    assert.equal((await f.store.readCreation('old'))!.announcement, null)
    await replaceDaemonSigner({ expectedRevision: 0, nostrSecretKeyHex: NEXT })
    const reopened = createNativeOracleCreationStore(f.directory, {
      passphrase: 'fixture-passphrase',
    })
    const retained = await reopened.readCreationSigner('old')
    const resumed = await prepareNativeMarketOracle(
      { ...f.oracle(retained.secretKeyHex), store: reopened },
      input,
    )
    assert.equal(resumed.record.nonceIndex, 0)
    assert.equal(resumed.record.creatorPublicKeyHex, deriveNostrPublicKey(KEY))
    assert.equal(
      (
        await prepareNativeMarketOracle(f.oracle(NEXT), {
          ...input,
          creationId: 'new',
          eventId: 'new-event',
        })
      ).record.nonceIndex,
      1,
    )
  })
})

test('disconnected reservation and invalid replacement fail before consuming authority', async () => {
  await fixture(undefined, async (f) => {
    const before = await identityDigest(f)
    await assert.rejects(
      replaceDaemonSigner({ expectedRevision: 0, nostrSecretKeyHex: '00'.repeat(32) }),
      /secret body is invalid/,
    )
    assert.equal(await identityDigest(f), before)
    await disconnectDaemonSigner(0)
    await assert.rejects(
      f.store.reserveCreation({
        creationId: 'blocked',
        eventId: 'blocked-event',
        canonicalInput: '{}',
      }),
      /conflict/,
    )
    assert.equal(await f.store.readCreation('blocked'), null)
    await reconnectDaemonSigner(1)
    assert.equal(
      (
        await f.store.reserveCreation({
          creationId: 'allowed',
          eventId: 'allowed-event',
          canonicalInput: '{}',
        })
      ).nonceIndex,
      0,
    )
  })
})

for (const phase of ['before-protection', 'before-commit'] as const) {
  test(`${phase} failure leaves selected signer, ciphertext and custody unchanged`, async () => {
    await fixture('fixture-passphrase', async (f) => {
      const before = await identityDigest(f)
      await assert.rejects(
        replaceDaemonSigner({
          expectedRevision: 0,
          nostrSecretKeyHex: NEXT,
          injectFault: (current) => {
            if (current === phase) throw new Error('fixture failure')
          },
        }),
        /fixture failure/,
      )
      assert.equal(await identityDigest(f), before)
      assert.ok(
        (await readBootstrappedProfileSecrets(f.directory, 'fixture-passphrase'))
          .nostrSecretKeyHex === KEY,
        'failed edit changed private key',
      )
      assert.equal((await readSelectedDaemonSigner()).revision, 0)
    })
  })
}

test('stale edits, wrong unlock key and live-daemon edits leave bindings unchanged', async () => {
  await fixture('fixture-passphrase', async (f) => {
    await disconnectDaemonSigner(0)
    const before = await identityDigest(f)
    await assert.rejects(
      replaceDaemonSigner({ expectedRevision: 0, nostrSecretKeyHex: NEXT }),
      (e) => e instanceof DaemonSignerEditError && e.reason === 'stale-edit',
    )
    process.env.BITCASTER_DAEMON_PASSPHRASE = 'wrong'
    await assert.rejects(
      replaceDaemonSigner({ expectedRevision: 1, nostrSecretKeyHex: NEXT }),
      /could not be unlocked/,
    )
    process.env.BITCASTER_DAEMON_PASSPHRASE = 'fixture-passphrase'
    const lock = await acquireDaemonRunLock()
    try {
      await assert.rejects(reconnectDaemonSigner(1), /already running/)
    } finally {
      await lock.release()
    }
    assert.equal(await identityDigest(f), before)
  })
})

test('unfinished range account work blocks replacement but not disconnect; terminal history permits replacement', async () => {
  await fixture(undefined, async (f) => {
    await f.session.transaction((db) =>
      db
        .prepare(
          `INSERT INTO daemon_ctf_range_preparations
      (scope_id,range_operation_id,source_operation_id,authorization_id,client_order_id,order_route_id,
      normalized_mint,condition_id,unit,token_side,side,price_subunits,amount_subunits,minimum_fill_amount_subunits,
      consolidate_proofs,divisibility,authorization_expires_at_unix_seconds,preparation_body,lifecycle_state,revision,created_at_ms,updated_at_ms)
      VALUES (?,'range','source','authorization','client','condition-Yes','https://mint.example','condition','msat','Outcome','Buy',500,1000,1000,0,1000,2000000000,?,'prepared',0,0,0)`,
        )
        .run(f.scope, Buffer.from('{}')),
    )
    const before = await identityDigest(f)
    await assert.rejects(
      replaceDaemonSigner({ expectedRevision: 0, nostrSecretKeyHex: NEXT }),
      (e) => e instanceof DaemonSignerEditError && e.reason === 'unfinished-account-work',
    )
    assert.equal(await identityDigest(f), before)
    await disconnectDaemonSigner(0)
    await f.session.transaction((db) =>
      db
        .prepare(
          "UPDATE daemon_ctf_range_preparations SET lifecycle_state='terminal',revision=revision+1",
        )
        .run(),
    )
    await replaceDaemonSigner({ expectedRevision: 1, nostrSecretKeyHex: NEXT })
  })
})

test('disconnected account commands refuse before I/O while local wallet reads stay available', async () => {
  await fixture(undefined, async () => {
    await disconnectDaemonSigner(0)
    let network = 0
    const deps = {
      createEngineClient: () => {
        network++
        throw new Error('must not authenticate')
      },
    }
    for (const command of [
      { method: 'score.show' },
      {
        method: 'market.fund',
        params: {
          conditionId: 'ab'.repeat(32),
          attempt: {
            kind: 'begin',
            newAttemptId: '77777777-7777-4777-8777-777777777777',
            expectedPreviousTransferId: null,
            requestedAmount: '1000',
          },
          maxWalletDebitMsat: 1000,
        },
      },
      { method: 'market.create-native', params: {} },
      { method: 'order.status', params: { marketId: 'condition-Yes', orderId: 'order' } },
    ] as const) {
      const result = await dispatch(command as Parameters<typeof dispatch>[0], deps)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'signer-disconnected')
    }
    assert.equal((await dispatch({ method: 'wallet.balance' }, deps)).ok, true)
    assert.equal(network, 0)
  })
})

test('disconnected public market reads stay anonymous and wallet recovery remains available', async () => {
  await fixture(undefined, async () => {
    await disconnectDaemonSigner(0)
    const originalFetch = globalThis.fetch
    let reads = 0
    globalThis.fetch = async (_request, init) => {
      reads++
      assert.equal(new Headers(init?.headers).has('authorization'), false)
      return Response.json({ markets: [], bids: [], asks: [], nextCursor: null, hasMore: false })
    }
    try {
      assert.equal((await dispatch({ method: 'markets.query', params: {} })).ok, true)
      assert.equal(
        (await dispatch({ method: 'order.book', params: { marketId: 'condition-Yes' } })).ok,
        true,
      )
      assert.equal((await dispatch({ method: 'wallet.recover' })).ok, true)
      assert.equal(reads, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

type Fixture = {
  directory: string
  scope: string
  session: ReturnType<typeof createDaemonStateSqliteSession>
  store: ReturnType<typeof createNativeOracleCreationStore>
  oracle: (key: string) => Parameters<typeof prepareNativeMarketOracle>[0]
}
async function fixture(passphrase: string | undefined, run: (f: Fixture) => Promise<void>) {
  const directory = join(await mkdtemp(join(tmpdir(), 'bitcaster-signer-')), 'profile')
  const priorHome = process.env.BITCASTER_DAEMON_HOME,
    priorPassphrase = process.env.BITCASTER_DAEMON_PASSPHRASE
  process.env.BITCASTER_DAEMON_HOME = directory
  if (passphrase === undefined) delete process.env.BITCASTER_DAEMON_PASSPHRASE
  else process.env.BITCASTER_DAEMON_PASSPHRASE = passphrase
  try {
    const profile = await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: SEED,
      nostrSecretKeyHex: KEY,
      nativeOracleNonceSeedHex: NONCE,
      passphrase,
    })
    const store = createNativeOracleCreationStore(directory, { passphrase })
    await run({
      directory,
      scope: profile.walletScopeId,
      session: createDaemonStateSqliteSession(directory),
      store,
      oracle: (key) => ({
        store,
        oracleSecretKeyHex: key,
        nonceSeedHex: NONCE,
        helper: {
          assertAvailable() {},
          async createEnum(r) {
            return {
              eventId: r.eventId,
              oraclePublicKeyHex: deriveNostrPublicKey(r.oracleSecretKeyHex),
              announcementTlvHex: 'aabb',
              announcementNostrEventId: 'ab'.repeat(32),
              announcementNostrEventJson: '{"kind":88}',
            }
          },
          async signEnum(r) {
            assert.ok(r.oracleSecretKeyHex === KEY, 'attestation did not use original signer')
            return {
              eventId: r.eventId,
              chosenOutcome: r.chosenOutcome,
              attestationHex: 'ccdd',
              attestationNostrEventId: 'cd'.repeat(32),
              attestationNostrEventJson: '{"kind":89}',
            }
          },
        },
      }),
    })
  } finally {
    if (priorHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = priorHome
    if (priorPassphrase === undefined) delete process.env.BITCASTER_DAEMON_PASSPHRASE
    else process.env.BITCASTER_DAEMON_PASSPHRASE = priorPassphrase
    await rm(join(directory, '..'), { recursive: true, force: true })
  }
}
async function digest(f: Fixture, where: string) {
  return f.session.read((db) => {
    const names = db
      .prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND (${where}) ORDER BY name`)
      .all() as { name: string }[]
    const values = names.map(({ name }) => [name, db.prepare(`SELECT * FROM ${name}`).all()])
    return createHash('sha256').update(JSON.stringify(values)).digest('hex')
  })
}
const custodyDigest = (f: Fixture) => digest(f, "name LIKE 'custody_%' OR name LIKE 'target_%'")
const identityDigest = (f: Fixture) =>
  digest(
    f,
    "name IN ('daemon_profile','daemon_secret_authority','custody_scopes','custody_scope_state')",
  )
