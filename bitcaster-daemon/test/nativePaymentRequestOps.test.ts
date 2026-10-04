import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import test from 'node:test'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { nip19 } from 'nostr-tools'
import {
  Mint,
  Wallet,
  OutputData,
  CheckStateEnum,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  deriveConditionalKeysetId,
  getEncodedToken,
  pointFromHex,
  type Proof,
  type RequestOptions,
} from '@cashu/cashu-ts'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { derivePaymentRequestReceiveKeyPair } from '@bitcaster-market/client-sdk/paymentRequest'
import { NativePaymentRequestOps } from '../src/nativePaymentRequestOps.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { emptyDaemonState, writeState } from '../src/state.ts'
import { withDaemonStateSqliteTransaction, type StateSqliteFaultPhase } from '../src/stateSqlite.ts'
import {
  createDaemonCounterSource,
  deserializeOutputGroups,
  receiveWalletToken,
  recoverDurableWalletProofImports,
  recoverDurableWalletReceives,
  type CashuWalletLike,
  type WalletOpsDependencies,
} from '../src/walletOps.ts'
import { composeStartupCustodyRecovery } from '../src/startupRecovery.ts'
import { dispatch } from '../src/server.ts'

const MINT = 'https://mint.example'
const SEED = '11'.repeat(64)
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7])
const KEYS = { '1': bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)) }
const REGULAR_ID = deriveKeysetId(KEYS, { unit: 'msat', versionByte: 1 })
const REGULAR = [signed(REGULAR_ID, 'external-a'), signed(REGULAR_ID, 'external-b')]
const CONDITIONAL = ['ab', 'ac'].map((prefix) => {
  const conditionId = prefix.repeat(32)
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId,
    outcomeCollection: 'YES',
  })
  return {
    id: deriveConditionalKeysetId({ keys: KEYS, unit: 'msat', conditionId, outcomeCollectionId }),
    conditionId,
    outcomeCollection: 'YES',
    outcomeCollectionId,
  }
})
const POSITIONS = [
  ...Array.from({ length: 33 }, (_, i) => signed(CONDITIONAL[0]!.id, `position-a-${i}`)),
  signed(CONDITIONAL[1]!.id, 'position-b'),
]

for (const [name, tokenMint, profileMint, throughDispatch] of [
  ['token root slash', `${MINT}/`, MINT, false],
  ['profile root slash', MINT, `${MINT}/`, false],
  ['dispatch token root slash', `${MINT}/`, MINT, true],
] as const) {
  test(`ordinary receive uses canonical mint authority for ${name}`, async () => {
    const f = await fixture()
    try {
      const token = getEncodedToken({ mint: tokenMint, unit: 'msat', proofs: REGULAR })
      const received = throughDispatch
        ? await dispatch({ method: 'wallet.receive', params: { token } }, f.deps())
        : await receiveWalletToken(
            token,
            { ...f.profile, mintUrl: profileMint },
            { walletSeedHex: SEED },
            f.deps(),
          )
      const result = throughDispatch
        ? (received as { ok: true; result: { mintUrl: string; amountMsat: number } }).result
        : (received as { mintUrl: string; amountMsat: number })
      if (throughDispatch) assert.equal((received as { ok: boolean }).ok, true)
      assert.equal(result.mintUrl, MINT)
      assert.equal(result.amountMsat, 2)
      assert.equal(f.counts.prepared, 1)
      assert.equal(f.counts.swaps, 1)
      assert.equal(f.counts.registry, 1)
      assert.equal(f.counts.wallets, 1)
      const rows = await f.query((db) => ({
        local: db.prepare('SELECT normalized_mint, unit, amount FROM target_wallet_proofs').all(),
        canonical: db.prepare('SELECT normalized_mint FROM custody_proofs').all(),
        operations: db.prepare('SELECT normalized_mint FROM custody_operations').all(),
      }))
      assert.equal(rows.local.length, 2)
      assert.equal(
        rows.local.reduce((amount, row) => amount + Number(row.amount), 0),
        2,
      )
      assert.equal(rows.operations.length, 1)
      assert.ok(rows.canonical.length > 0)
      for (const row of [...rows.local, ...rows.canonical, ...rows.operations])
        assert.equal(row.normalized_mint, MINT)
      assert.ok(rows.local.every((row) => row.unit === 'msat'))
    } finally {
      await f.close()
    }
  })
}

for (const mintUrl of ['https://foreign.example', 'https://foreign.example/']) {
  test(`ordinary receive refuses foreign mint ${mintUrl} before resolution or effects`, async () => {
    const f = await fixture()
    try {
      const before = await f.snapshot()
      await assert.rejects(
        receiveWalletToken(
          getEncodedToken({ mint: mintUrl, unit: 'msat', proofs: REGULAR }),
          f.profile,
          { walletSeedHex: SEED },
          f.deps(),
        ),
        /allowed canonical mint set/,
      )
      assert.equal(f.counts.registry, 0)
      assert.equal(f.counts.wallets, 0)
      assert.equal(f.counts.prepared, 0)
      assert.equal(f.counts.swaps, 0)
      assert.equal(
        isDeepStrictEqual(before, await f.snapshot()),
        true,
        'foreign mint refusal must not change fixture files',
      )
    } finally {
      await f.close()
    }
  })
}

test('ordinary receive and request receive share real Cashu preparation and reserve one range each', async () => {
  const f = await fixture()
  try {
    const ordinary = [signed(REGULAR_ID, 'ordinary-a'), signed(REGULAR_ID, 'ordinary-b')]
    const received = await receiveWalletToken(
      getEncodedToken({ mint: MINT, unit: 'msat', proofs: ordinary }),
      f.profile,
      { walletSeedHex: SEED },
      f.deps(),
    )
    assert.equal(received.amountMsat, 2)
    const request = await f.create()
    assert.equal(await f.ops().hasUncreditedRequests(), true)
    const first = await f.ops().receive(message(REGULAR))
    assert.deepEqual(first, {
      state: 'credited',
      requestId: 'request',
      amountMsat: 2,
      proofCount: 2,
    })
    assert.deepEqual(await f.ops().receive(message([...REGULAR].reverse())), first)
    assert.equal(f.counts.prepared, 2)
    assert.equal(f.counts.swaps, 2)
    assert.equal(f.counts.registry, 2)
    assert.equal(await f.targetCount(), 4)
    assert.equal((await f.ops().status({ requestId: 'request' })).state, 'credited')
    assert.equal(await f.ops().hasUncreditedRequests(), false)
    assert.deepEqual(Object.keys(request).sort(), [
      'createdAtMs',
      'encoded',
      'mintUrl',
      'receivePublicKey',
      'requestId',
      'unit',
    ])
    assertRedacted([request, first, await f.ops().list({ cursor: null })])
  } finally {
    await f.close()
  }
})

for (const recovery of ['request', 'existing-funds-recovery'] as const) {
  test(`lost regular mint response recovers through ${recovery} without another receive plan`, async () => {
    const f = await fixture()
    try {
      await f.create()
      f.control.failAfterMintEffect = true
      await assert.rejects(f.ops().receive(message(REGULAR)), {
        message: 'native payment request receive failed',
      })
      assert.equal((await f.ops().status({ requestId: 'request' })).state, 'pending')
      assert.equal(await f.ops().hasUncreditedRequests(), true)
      const counters = await f.query((db) =>
        db.prepare('SELECT * FROM custody_keyset_counters').all(),
      )
      f.control.state = CheckStateEnum.SPENT
      f.control.restoreOutputs = true
      if (recovery === 'request')
        assert.equal((await f.ops().recover({ requestId: 'request' })).state, 'credited')
      else {
        const result = composeStartupCustodyRecovery([
          await recoverDurableWalletReceives({ walletSeedHex: SEED }, f.deps()),
        ])
        assert.equal(result.recoveredCount, 1)
        assert.equal(result.pending.length, 0)
      }
      assert.equal((await f.ops().status({ requestId: 'request' })).state, 'credited')
      assert.equal(await f.ops().hasUncreditedRequests(), false)
      assert.equal(f.counts.prepared, 1)
      assert.equal(f.counts.swaps, 1)
      assert.equal(f.counts.registry, 1)
      assert.equal(f.counts.restores, 1)
      assert.equal(await f.targetCount(), 2)
      assert.equal(
        isDeepStrictEqual(
          await f.query((db) => db.prepare('SELECT * FROM custody_keyset_counters').all()),
          counters,
        ),
        true,
        'saved receive counters changed',
      )
    } finally {
      await f.close()
    }
  })
}

test('empty authenticated restore remains a pending request with no credit', async () => {
  const f = await fixture()
  try {
    await f.create()
    f.control.failAfterMintEffect = true
    await assert.rejects(f.ops().receive(message(REGULAR)), /receive failed/)
    f.control.state = CheckStateEnum.SPENT
    assert.equal((await f.ops().recover({ requestId: 'request' })).state, 'pending')
    assert.equal(await f.ops().hasUncreditedRequests(), true)
    assert.equal(await f.targetCount(), 0)
    assert.equal(f.counts.prepared, 1)
    assert.equal((await f.ops().list({ cursor: null })).rows[0]?.receiptAccepted, true)
  } finally {
    await f.close()
  }
})

test('existing conditional recovery composes with request status without registry lookup or redelivery', async () => {
  const f = await fixture()
  try {
    await f.create()
    let commits = 0
    await assert.rejects(
      f
        .ops((phase) => {
          if (phase === 'before-commit' && ++commits === 5) throw new Error('page crash')
        })
        .receive(message(POSITIONS)),
      /receive failed/,
    )
    assert.equal((await f.ops().status({ requestId: 'request' })).state, 'pending')
    assert.equal(await f.ops().hasUncreditedRequests(), true)
    assert.equal(await f.targetCount(), 32)
    await f.query((db) =>
      db.exec(
        "UPDATE custody_proofs SET selectability = 'spent', nut07_state = 'SPENT', revision = revision + 1; DELETE FROM target_wallet_proofs",
      ),
    )
    const old = await f.query((db) =>
      db.prepare('SELECT * FROM custody_proofs ORDER BY proof_id').all(),
    )
    f.counts.checked = 0
    const firstPass = await recoverDurableWalletProofImports({ walletSeedHex: SEED }, f.deps())
    assert.equal(firstPass.pendingCount, 1)
    assert.equal((await f.ops().status({ requestId: 'request' })).state, 'pending')
    const recovery = composeStartupCustodyRecovery([
      firstPass,
      await recoverDurableWalletProofImports({ walletSeedHex: SEED }, f.deps()),
    ])
    assert.equal(recovery.pending.length, 0)
    assert.equal(recovery.recoveredCount, 2)
    assert.equal(f.counts.checked, 2)
    assert.equal(f.counts.registry, 1)
    assert.equal(f.counts.keys, 2)
    const result = await f.ops().status({ requestId: 'request' })
    assert.equal(await f.ops().hasUncreditedRequests(), false)
    assert.deepEqual(result, {
      state: 'credited',
      requestId: 'request',
      amountMsat: 34,
      proofCount: 34,
    })
    const current = await f.query((db) =>
      db.prepare('SELECT * FROM custody_proofs ORDER BY proof_id').all(),
    )
    assert.equal(
      isDeepStrictEqual(
        current.filter((row) => old.some((saved) => saved.proof_id === row.proof_id)),
        old,
      ),
      true,
      'applied custody state changed',
    )
    assert.equal(await f.targetCount(), 2)
    assertRedacted(result)
  } finally {
    await f.close()
  }
})

test('conditional authority uses classified metadata and rejects a foreign public-key result before credit', async () => {
  const f = await fixture()
  try {
    await f.create()
    f.control.foreignKeys = true
    await assert.rejects(f.ops().receive(message(POSITIONS)), {
      message: 'native payment request receive failed',
    })
    assert.equal(f.counts.registry, 1)
    assert.equal((await f.ops().status({ requestId: 'request' })).state, 'awaiting')
    assert.equal(await f.targetCount(), 0)
    assert.equal(
      await f.query(
        (db) => db.prepare('SELECT count(*) n FROM native_payment_request_receipts').get()!.n,
      ),
      0,
    )
  } finally {
    await f.close()
  }
})

test('request enumeration is bounded, restart-safe, redacted, and scope/mint-bound', async () => {
  const f = await fixture()
  try {
    for (const requestId of ['a', 'b', 'c', 'd', 'e']) await f.create(requestId)
    const ids: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await f.ops().list({ cursor, limit: 2 })
      assert.ok(page.rows.length <= 2)
      assertRedacted(page)
      ids.push(...page.rows.map((row) => row.requestId))
      cursor = page.nextCursor
      pages++
    } while (cursor !== null)
    assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e'])
    assert.equal(pages, 3)
    const first = await f.ops().list({ cursor: null, limit: 2 })
    assert.ok(first.nextCursor)
    const foreignCursor = Buffer.from(
      JSON.stringify({ scopeId: 'foreign', mintUrl: MINT, requestId: 'b' }),
    ).toString('base64url')
    for (const bad of [foreignCursor, 'bad', 'x'.repeat(4097)])
      await assert.rejects(f.ops().list({ cursor: bad }), /listing failed/)
    await assert.rejects(f.ops().list({ cursor: null, limit: 257 }), /listing failed/)
    await assert.rejects(f.ops().status({ requestId: 'x'.repeat(257) }), /status failed/)
    await assert.rejects(f.ops().recover({ requestId: '' }), /recovery failed/)
    const generated = await f.ops().create({
      nprofile: nip19.nprofileEncode({
        pubkey: derivePaymentRequestReceiveKeyPair(Buffer.from(SEED, 'hex')).publicKey,
      }),
    })
    assert.match(generated.requestId, /^wallet-request-/)
    const foreignSeed = new NativePaymentRequestOps({
      profile: f.profile,
      secrets: { walletSeedHex: '33'.repeat(64) },
      getFence: () => f.fence,
      deps: f.deps(),
    })
    await assert.rejects(foreignSeed.status({ requestId: 'a' }), /status failed/)
    const foreignMint = new NativePaymentRequestOps({
      profile: { ...f.profile, mintUrl: 'https://other.example' },
      secrets: { walletSeedHex: SEED },
      getFence: () => f.fence,
      deps: f.deps(),
    })
    await assert.rejects(foreignMint.status({ requestId: 'a' }), /status failed/)
    assert.equal(f.counts.wallets, 0)
    assert.equal(f.counts.registry, 0)
  } finally {
    await f.close()
  }
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'native-request-ops-'))
  const previous = process.env.BITCASTER_DAEMON_HOME
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('unmocked HTTP refused')
  }
  process.env.BITCASTER_DAEMON_HOME = directory
  const profile = {
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT,
    initializedAt: new Date().toISOString(),
  }
  const bootstrap = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: profile.engineBaseUrl,
    mintUrl: MINT,
    walletSeedHex: SEED,
    nostrSecretKeyHex: '22'.repeat(32),
  })
  await writeState(emptyDaemonState())
  const fence = await claimCustodyScopeLease(directory, {
    scopeId: bootstrap.walletScopeId,
    incarnationId: 'request-ops-test',
    observedAtMs: Date.now(),
  })
  const counts = {
    prepared: 0,
    swaps: 0,
    registry: 0,
    keys: 0,
    restores: 0,
    checked: 0,
    wallets: 0,
  }
  const control = {
    failAfterMintEffect: false,
    state: CheckStateEnum.UNSPENT as CheckStateEnum,
    restoreOutputs: false,
    foreignKeys: false,
  }
  const deps = (
    injectCustodyFault?: (phase: StateSqliteFaultPhase) => void,
  ): WalletOpsDependencies => ({
    getCustodyFence: () => fence,
    injectCustodyFault,
    resolveMintKeysetIds: async () => [REGULAR_ID],
    createCashuWallet: (mintUrl, unit) => {
      assert.equal(mintUrl, MINT)
      assert.equal(unit, 'msat')
      counts.wallets++
      const customRequest = async <T>(args: RequestOptions): Promise<T> => {
        const endpoint = new URL(args.endpoint).pathname
        if (endpoint === '/v1/info')
          return { name: 'mock mint', nuts: { '12': { supported: true } } } as T
        if (endpoint === '/v1/keysets')
          return {
            keysets: [{ id: REGULAR_ID, unit: 'msat', active: true, input_fee_ppk: 0 }],
          } as T
        if (endpoint === '/v1/keys')
          return { keysets: [{ id: REGULAR_ID, unit: 'msat', keys: KEYS, input_fee_ppk: 0 }] } as T
        if (endpoint === '/v1/swap') {
          counts.swaps++
          const body = args.requestBody as {
            outputs: Array<{ id: string; amount: number | string; B_: string }>
          }
          const signatures = body.outputs.map((output) => {
            const signature = createBlindSignature(pointFromHex(output.B_), PRIVATE_KEY, output.id)
            const dleq = createDLEQProof(pointFromHex(output.B_), PRIVATE_KEY)
            return {
              id: output.id,
              amount: output.amount,
              C_: signature.C_.toHex(true),
              dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
            }
          })
          if (control.failAfterMintEffect)
            throw new Error(`untrusted mint failure with ${REGULAR[0]!.secret}`)
          return { signatures } as T
        }
        if (endpoint === '/v1/checkstate') {
          const body = args.requestBody as { Ys: string[] }
          counts.checked += body.Ys.length
          return { states: body.Ys.map((Y) => ({ Y, state: control.state, witness: null })) } as T
        }
        throw new Error('unexpected mocked mint endpoint')
      }
      const wallet = new Wallet(new Mint(MINT, { customRequest }), {
        unit: 'msat',
        bip39seed: Buffer.from(SEED, 'hex'),
        counterSource: createDaemonCounterSource(() => ({ fence, observedAtMs: Date.now() }), {
          normalizedMint: MINT,
          unit: 'msat',
        }),
      })
      const prepare = wallet.prepareSwapToReceive.bind(wallet)
      wallet.prepareSwapToReceive = async (...args) => {
        counts.prepared++
        return prepare(...args)
      }
      return wallet as unknown as CashuWalletLike
    },
    resolveTokenImportKeysets: async (request) => {
      counts.registry++
      return {
        canonicalMintUrl: MINT,
        freshness: 'fresh',
        regularKeysets: request.encodedKeysetIds.some((id) => REGULAR_ID.startsWith(id))
          ? [{ keysetId: REGULAR_ID, unit: 'msat', active: true }]
          : [],
        conditionalKeysets: CONDITIONAL.filter((keyset) =>
          request.encodedKeysetIds.some((id) => keyset.id.startsWith(id)),
        ).map((keyset) => ({ keysetId: keyset.id, unit: 'msat', active: true, ...keyset })),
      }
    },
    resolveMintKeysByKeyset: async (_mint, ids) => {
      counts.keys++
      return Object.fromEntries(
        ids.map((id) => [
          id,
          { id: control.foreignKeys ? REGULAR_ID : id, unit: 'msat', keys: KEYS },
        ]),
      )
    },
    restoreOutputGroups: async (_mint, groups) => {
      counts.restores++
      return Object.fromEntries(
        Object.entries(deserializeOutputGroups(groups)).map(([group, outputs]) => [
          group,
          control.restoreOutputs ? outputs.map(sign) : [],
        ]),
      )
    },
  })
  const ops = (fault?: (phase: StateSqliteFaultPhase) => void) =>
    new NativePaymentRequestOps({
      profile,
      secrets: { walletSeedHex: SEED },
      getFence: () => fence,
      deps: deps(fault),
    })
  const query = <T>(run: (db: import('node:sqlite').DatabaseSync) => T) =>
    withDaemonStateSqliteTransaction(directory, run)
  return {
    profile,
    fence,
    deps,
    ops,
    query,
    counts,
    control,
    create: (requestId = 'request') =>
      ops().create({
        requestId,
        nprofile: nip19.nprofileEncode({
          pubkey: derivePaymentRequestReceiveKeyPair(Buffer.from(SEED, 'hex')).publicKey,
          relays: ['wss://relay.example'],
        }),
      }),
    targetCount: () =>
      query((db) => Number(db.prepare('SELECT count(*) n FROM target_wallet_proofs').get()!.n)),
    snapshot: () => fixtureFileDigests(directory),
    close: async () => {
      globalThis.fetch = previousFetch
      if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previous
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function fixtureFileDigests(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true })
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const file = join(directory, entry.name)
        const body = await readFile(file)
        return {
          file: entry.name,
          mode: (await stat(file)).mode & 0o777,
          bytes: body.byteLength,
          sha256: createHash('sha256').update(body).digest('hex'),
        }
      }),
  )
}

function message(proofs: readonly Proof[]) {
  return JSON.stringify({
    id: 'request',
    mint: MINT,
    unit: 'msat',
    proofs,
    sender: 'not authority',
  })
}
function assertRedacted(value: unknown) {
  const output = JSON.stringify(value)
  for (const secret of [
    SEED,
    REGULAR[0]!.secret,
    REGULAR[0]!.C,
    'proof_body',
    'decrypted',
    'privateKey',
  ])
    assert.equal(output.includes(secret), false, 'public request output contains private material')
}
function signed(id: string, secret: string): Proof {
  return sign(OutputData.createSingleData(1, id, secret, 19n))
}
function sign(output: OutputData): Proof {
  const { id, B_, amount } = output.blindedMessage
  const signature = createBlindSignature(pointFromHex(B_), PRIVATE_KEY, id)
  const dleq = createDLEQProof(pointFromHex(B_), PRIVATE_KEY)
  return output.toProof(
    {
      id,
      amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id, keys: KEYS },
  )
}
