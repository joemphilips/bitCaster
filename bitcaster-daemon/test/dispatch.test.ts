import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  Amount,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  getEncodedToken,
  pointFromHex,
  type Proof,
} from '@cashu/cashu-ts'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { completedProofAuthorityDigest } from '@bitcaster-market/client-sdk/ctfSplit'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import { EngineClientError } from '@bitcaster-market/client-sdk/engineClient'
import {
  decodeDurableRecipientDeliveryStatus,
  deriveDurableRecipientTupleFingerprint,
  type DurableRecipientDeliverySubmission,
} from '@bitcaster-market/client-sdk/durableRecipientDelivery'
import {
  dispatch,
  type EngineClientLike,
  type PrepareSettlementCapabilityInput,
} from '../src/server.ts'
import { profileDir, readProfile } from '../src/profile.ts'
import { createDaemonSecrets, readSecrets } from '../src/secrets.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import {
  emptyDaemonState,
  readState,
  writeState as persistState,
  type DaemonState,
} from '../src/state.ts'
import { splitAvailableSatProofsForCtfCollateral } from '../src/walletOps.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { canonicalTestKeysetId } from './support/canonicalKeysetId.ts'

const TEST_KEYSET_ID = canonicalTestKeysetId('dispatch')
const CTF_KEYSET_ID = canonicalTestKeysetId('dispatch:ctf')
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { DaemonDurableOutgoingCashuCoordinator } from '../src/durableOutgoingCashuCoordinator.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { reserveDaemonKeysetCounter } from '../src/state.ts'

const V2_KEYSET_ID = `01${'a'.repeat(64)}`
const V1_KEYSET_ID = `00${'a'.repeat(14)}`

async function writeState(state: DaemonState): Promise<void> {
  for (const record of state.wallet.proofs) {
    const outcome =
      record.asset.kind === 'Outcome' || (record.asset as { kind?: unknown }).kind === 'outcome'
    record.asset = outcome
      ? {
          ...record.asset,
          kind: 'Outcome',
          baseAsset: 'sat',
          unit: 'msat',
        }
      : {
          ...record.asset,
          kind: 'sats',
          baseAsset: 'sat',
          unit: record.asset.unit === 'sat' ? 'sat' : 'msat',
        }
  }
  for (const order of Object.values(state.orders)) {
    order.baseAsset ??= 'sat'
    order.divisibility ??= 10_000
  }
  await persistState(state)
}

test('daemon dispatch persists wallet and order state', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-test-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'http://localhost:5000',
      mintUrl: 'https://mint-a.example',
      walletSeedHex: secrets.walletSeedHex,
      nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      nostrPublicKeyHex: secrets.nostrPublicKeyHex,
    })
    const profile = (await readProfile())!

    await t.test(
      'wallet.balance summarizes durable proof and custody state',
      async (balanceTest) => {
        const state = emptyDaemonState()
        state.wallet.proofs.push(
          proofRecord('https://mint-a.example', 100, 'available', {
            kind: 'sats',
            baseAsset: 'sat',
            unit: 'sat',
          }),
          {
            ...proofRecord('https://mint-a.example', 50_000, 'reserved', {
              kind: 'sats',
              baseAsset: 'sat',
              unit: 'msat',
            }),
            reservedBy: 'balance-test',
          },
          {
            ...proofRecord('https://mint-a.example', 25_000, 'locked', {
              kind: 'Outcome',
              conditionId: 'cond',
              outcomeSetId: 'YES',
              baseAsset: 'sat',
              unit: 'msat',
            }),
            reservedBy: 'balance-lock-test',
          },
        )
        await writeState(state)
        await insertCustodyBalanceProof({
          proofId: 'ab'.repeat(32),
          amount: 75_000,
          nut07State: 'UNSPENT',
          selectability: 'locked',
        })
        await insertCustodyBalanceProof({
          proofId: 'cd'.repeat(32),
          amount: 1_000_000,
          nut07State: 'SPENT',
          selectability: 'spent',
        })
        balanceTest.after(async () => {
          await withDaemonStateSqliteTransaction(profileDir(), (database) => {
            database.prepare('DELETE FROM custody_proofs').run()
          })
        })

        const result = await dispatch({ method: 'wallet.balance' })

        assert.equal(result.ok, true)
        assert.deepEqual(result.result, {
          totalAvailableSats: 100,
          totalReservedSats: 50,
          totalLockedSats: 100,
          byMint: [
            {
              mintUrl: 'https://mint-a.example',
              availableSats: 100,
              reservedSats: 50,
              lockedSats: 100,
            },
          ],
          outcomePositions: [
            {
              mintUrl: 'https://mint-a.example',
              conditionId: 'cond',
              outcomeSetId: 'YES',
              availableSats: 0,
              reservedSats: 0,
              lockedSats: 25,
            },
          ],
        })
      },
    )

    await t.test(
      'preflight collateral preparation opens sat markets with msat wallet unit',
      async () => {
        const priorState = await readState()
        const state = emptyDaemonState()
        state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            1_000,
            'available',
            { kind: 'sats', baseAsset: 'sat' },
            'msat-proof',
          ),
        )
        await writeState(state)

        const requestedUnits: Array<string | null | undefined> = []
        try {
          await assert.rejects(
            () =>
              splitAvailableSatProofsForCtfCollateral(
                1_000,
                'https://mint-a.example',
                'preflight-msat-unit',
                secrets,
                {
                  createCashuWallet(_mintUrl, unit) {
                    requestedUnits.push(unit)
                    return {
                      async loadMint() {},
                      async receive() {
                        throw new Error('receive unused')
                      },
                      async send() {
                        throw new Error('send unused')
                      },
                    }
                  },
                },
                'sat',
              ),
            /cashu wallet does not support fee-aware proof selection/,
          )

          assert.deepEqual(requestedUnits, ['msat'])
        } finally {
          if (priorState) {
            await writeState(priorState)
          } else {
            await writeState(emptyDaemonState())
          }
        }
      },
    )

    await t.test('daemon.status returns redacted profile and state summary', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord(
          'https://mint-a.example',
          10,
          'available',
          { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
          'status-secret',
        ),
      )
      state.proofOperations['op-status'] = {
        operationId: 'op-status',
        kind: 'wallet-send',
        state: 'prepared',
        mintUrl: 'https://mint-a.example',
        inputs: [{ amount: 10, secret: 'operation-input-secret', C: 'C-status' }],
        outputs: {},
        metadata: {},
        createdAt: 1,
        updatedAt: 2,
      }
      state.orders['order-status'] = {
        orderId: 'order-status',
        marketId: 'cond-YES',
        status: 'resting',
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
      await writeState(state)

      const result = await dispatch({ method: 'daemon.status' })

      assert.equal(result.ok, true)
      assert.deepEqual(result.result, {
        profile,
        counts: {
          proofs: 1,
          proofOperations: 1,
          orders: 1,
        },
        wallet: {
          totalAvailableSats: 10,
          totalReservedSats: 0,
          totalLockedSats: 0,
          byMint: [
            {
              mintUrl: 'https://mint-a.example',
              availableSats: 10,
              reservedSats: 0,
              lockedSats: 0,
            },
          ],
          outcomePositions: [],
        },
      })
      const text = JSON.stringify(result.result)
      assert.doesNotMatch(text, /walletSeedHex|nostrSecretKeyHex/)
      assert.doesNotMatch(text, /status-secret|operation-input-secret/)
    })

    await t.test(
      'daemon state serializes native CTF proof operation amounts as numbers',
      async () => {
        const state = emptyDaemonState()
        state.proofOperations['ctf-native-op'] = {
          operationId: 'ctf-native-op',
          kind: 'conditional-keyset-swap',
          state: 'completed',
          mintUrl: 'https://mint-a.example',
          inputs: [{ id: CTF_KEYSET_ID, amount: 136n as never, secret: 'ctf-input', C: 'C-in' }],
          outputs: {
            lock: [
              {
                blindedMessage: { amount: 100n as never, id: CTF_KEYSET_ID, B_: 'B-lock' },
                blindingFactor: '01',
                secret: '02',
              },
            ],
          },
          metadata: { fees: 0n },
          resultProofs: {
            lock: [{ id: CTF_KEYSET_ID, amount: 100n as never, secret: 'ctf-lock', C: 'C-out' }],
          },
          createdAt: 1,
          updatedAt: 2,
        }

        await writeState(state)
        const restored = await readState()

        assert.equal(restored?.proofOperations['ctf-native-op']?.kind, 'conditional-keyset-swap')
        assert.equal(restored?.proofOperations['ctf-native-op']?.inputs[0].amount, 136)
        assert.equal(
          restored?.proofOperations['ctf-native-op']?.outputs.lock[0].blindedMessage.amount,
          100,
        )
        assert.equal(restored?.proofOperations['ctf-native-op']?.resultProofs?.lock[0].amount, 100)
      },
    )

    await t.test('wallet.receive binds exact durable authority before completeSwap', async () => {
      await writeState(emptyDaemonState())
      const keysetId = deriveKeysetId(
        { '1': `02${'11'.repeat(32)}` },
        { unit: 'sat', versionByte: 1 },
      )
      const token = getEncodedToken({
        mint: 'https://mint-a.example',
        unit: 'sat',
        proofs: [{ ...cashuProof(7, 'token-secret'), id: keysetId }],
      })
      const fence = await claimCustodyScopeLease(profileDir(), {
        scopeId: deriveDurableCustodyScopeId({
          scopeKind: 'wallet',
          walletId: deriveDurableCustodyWalletId(Buffer.from(secrets.walletSeedHex, 'hex')),
        }),
        incarnationId: 'wallet-receive-bind-test',
        observedAtMs: Date.now(),
      })
      await reserveDaemonKeysetCounter(
        keysetId,
        1,
        { fence, observedAtMs: Date.now() },
        { normalizedMint: 'https://mint-a.example', unit: 'sat' },
      )
      let completeCalled = false
      await assert.rejects(
        () =>
          dispatch(
            { method: 'wallet.receive', params: { token } },
            {
              getCustodyFence: () => fence,
              resolveMintKeysetIds: async () => [keysetId],
              resolveTokenImportKeysets: async () => ({
                freshness: 'fresh' as const,
                regularKeysets: [{ keysetId, unit: 'sat', active: true }],
                conditionalKeysets: [],
              }),
              createCashuWallet(mintUrl) {
                assert.equal(mintUrl, 'https://mint-a.example')
                const output = OutputData.createSingleData(
                  Amount.from(7),
                  keysetId,
                  'fresh-secret',
                  1n,
                )
                return {
                  async loadMint() {},
                  async receive() {
                    throw new Error('legacy receive must not be called')
                  },
                  async prepareSwapToReceive(receivedToken, config) {
                    assert.equal(receivedToken, token)
                    assert.deepEqual(config?.proofsWeHave, [])
                    config?.onCountersReserved?.({ keysetId, start: 0, count: 1 })
                    return {
                      amount: Amount.from(7),
                      fees: Amount.zero(),
                      keysetId,
                      inputs: [{ ...cashuProof(7, 'token-secret'), id: keysetId }],
                      keepOutputs: [output],
                    }
                  },
                  async completeSwap() {
                    completeCalled = true
                    const custodyRows = await withDaemonStateSqliteTransaction(
                      profileDir(),
                      (database) =>
                        database.prepare('SELECT operation_id FROM custody_operations').all(),
                    )
                    assert.equal(custodyRows.length, 1)
                    return { keep: [{ ...cashuProof(7, 'fresh-secret'), id: keysetId }], send: [] }
                  },
                  async checkProofsStates() {
                    return []
                  },
                  getKeyset() {
                    return {
                      id: keysetId,
                      unit: 'sat',
                      keys: { '1': `02${'11'.repeat(32)}` },
                      fee: 0,
                      verify: () => true,
                    }
                  },
                  async send() {
                    throw new Error('send unused')
                  },
                }
              },
            },
          ),
        /custody mint proof differs|Invalid point|proof/i,
      )
      assert.equal(completeCalled, true)
    })

    await t.test(
      'wallet.receive rejects resolved V1 ordinary proofs before wallet or counter work',
      async () => {
        await writeState(emptyDaemonState())
        const legacyKeysetId = `00${'b'.repeat(14)}`
        const token = getEncodedToken({
          mint: 'https://mint-a.example',
          unit: 'sat',
          proofs: [{ ...cashuProof(7, 'legacy-ordinary-secret'), id: legacyKeysetId }],
        })
        let walletCreated = false
        await assert.rejects(
          () =>
            dispatch(
              { method: 'wallet.receive', params: { token } },
              {
                resolveTokenImportKeysets: async () => ({
                  freshness: 'fresh' as const,
                  regularKeysets: [{ keysetId: legacyKeysetId, unit: 'sat', active: true }],
                  conditionalKeysets: [],
                }),
                createCashuWallet() {
                  walletCreated = true
                  throw new Error('wallet must not be created')
                },
              },
            ),
          /daemon wallet receive supports only V2 keysets/,
        )
        assert.equal(walletCreated, false)
        const counterRows = await withDaemonStateSqliteTransaction(
          profileDir(),
          (database) =>
            database
              .prepare(
                `SELECT COUNT(*) AS count FROM target_keyset_counters
                 WHERE normalized_mint = ? AND unit = ? AND keyset_id = ?`,
              )
              .get('https://mint-a.example', 'sat', legacyKeysetId) as { count: number },
        )
        assert.equal(counterRows.count, 0)
      },
    )

    await t.test('wallet.receive can classify imported proofs as outcome tokens', async () => {
      await writeState(emptyDaemonState())
      const token = getEncodedToken({
        mint: 'https://mint-a.example',
        unit: 'msat',
        proofs: [cashuProof(11, 'outcome-token-secret')],
      })
      const response = await dispatch(
        {
          method: 'wallet.receive',
          params: {
            token,
            conditionId: 'cond',
            outcomeSetId: 'YES',
          },
        },
        {
          resolveTokenImportKeysets: tokenImportKeysetResolver('conditional', 'msat'),
          resolveMintKeysetIds: async () => [V2_KEYSET_ID],
          async resolveConditionKeysetIds(mintUrl, conditionId) {
            assert.equal(mintUrl, 'https://mint-a.example')
            assert.equal(conditionId, 'cond')
            return [V2_KEYSET_ID]
          },
          createCashuWallet() {
            return {
              async loadMint() {},
              async receive() {
                throw new Error('receive unused for outcome imports')
              },
              async send() {
                throw new Error('send unused')
              },
              async checkProofsStates(proofs) {
                assert.deepEqual(proofs, [{ id: V2_KEYSET_ID, secret: 'outcome-token-secret' }])
                return [
                  {
                    Y: 'proof-y',
                    state: 'UNSPENT',
                    witness: null,
                  },
                ]
              },
            }
          },
        },
      )

      assert.equal(response.ok, true)
      assert.deepEqual(response.result, {
        mintUrl: 'https://mint-a.example',
        amountSats: 11,
        proofCount: 1,
        asset: {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'YES',
          baseAsset: 'sat',
          unit: 'msat',
        },
        unit: 'msat',
        hasInactiveProofs: false,
      })
      const state = await readState()
      assert.deepEqual(state?.wallet.proofs[0]?.asset, {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
        baseAsset: 'sat',
        unit: 'msat',
      })
      assert.equal(state?.wallet.proofs[0]?.proof.secret, 'outcome-token-secret')
    })

    await t.test(
      'wallet.receive rejects non-V2 outcome proof keysets before wallet I/O',
      async () => {
        const token = getEncodedToken({
          mint: 'https://mint-a.example',
          unit: 'msat',
          proofs: [{ ...cashuProof(11, 'legacy-outcome-secret'), id: V1_KEYSET_ID }],
        })
        let walletCreated = false
        await assert.rejects(
          () =>
            dispatch(
              {
                method: 'wallet.receive',
                params: { token, conditionId: 'cond', outcomeSetId: 'YES' },
              },
              {
                resolveTokenImportKeysets: async () => ({
                  freshness: 'fresh' as const,
                  regularKeysets: [],
                  conditionalKeysets: [{ keysetId: V1_KEYSET_ID, unit: 'msat', active: true }],
                }),
                createCashuWallet() {
                  walletCreated = true
                  throw new Error('wallet must not be created')
                },
              },
            ),
          /daemon wallet receive supports only V2 keysets/,
        )
        assert.equal(walletCreated, false)
      },
    )

    await t.test(
      'wallet.receive rejects spent outcome-token proofs before persistence',
      async () => {
        await writeState(emptyDaemonState())
        const token = getEncodedToken({
          mint: 'https://mint-a.example',
          unit: 'msat',
          proofs: [cashuProof(11, 'spent-outcome-secret')],
        })

        await assert.rejects(
          () =>
            dispatch(
              {
                method: 'wallet.receive',
                params: {
                  token,
                  conditionId: 'cond',
                  outcomeSetId: 'YES',
                },
              },
              {
                resolveTokenImportKeysets: tokenImportKeysetResolver('conditional', 'msat'),
                resolveMintKeysetIds: async () => [V2_KEYSET_ID],
                async resolveConditionKeysetIds() {
                  return [V2_KEYSET_ID]
                },
                createCashuWallet() {
                  return {
                    async loadMint() {},
                    async receive() {
                      throw new Error('receive unused for outcome imports')
                    },
                    async send() {
                      throw new Error('send unused')
                    },
                    async checkProofsStates() {
                      return [
                        {
                          Y: 'proof-y',
                          state: 'SPENT',
                          witness: null,
                        },
                      ]
                    },
                  }
                },
              },
            ),
          /cashu outcome proof is not spendable: SPENT/,
        )
        assert.deepEqual((await readState())?.wallet.proofs, [])
      },
    )

    await t.test('wallet.receive rejects partial outcome metadata', async () => {
      const token = getEncodedToken({
        mint: 'https://mint-a.example',
        unit: 'msat',
        proofs: [cashuProof(7, 'partial-outcome-secret')],
      })

      await assert.rejects(
        () =>
          dispatch(
            {
              method: 'wallet.receive',
              params: { token, conditionId: 'cond' },
            },
            {
              resolveTokenImportKeysets: tokenImportKeysetResolver('conditional', 'msat'),
            },
          ),
        /conditionId and outcomeSetId must be supplied together/,
      )
    })

    await t.test('wallet.receive rejects tokens for unexpected mints', async () => {
      let resolverCalls = 0
      const token = getEncodedToken({
        mint: 'https://unexpected-mint.example',
        unit: 'sat',
        proofs: [cashuProof(7, 'unexpected-mint-secret')],
      })

      await assert.rejects(
        () =>
          dispatch(
            { method: 'wallet.receive', params: { token } },
            {
              resolveTokenImportKeysets: async (request) => {
                resolverCalls += 1
                return tokenImportKeysetResolver('regular', 'sat')(request)
              },
            },
          ),
        /allowed canonical mint set/,
      )
      assert.equal(resolverCalls, 0)
    })

    await t.test('wallet.receive rejects unsupported units byte-identically', async () => {
      let resolverCalls = 0
      const token = getEncodedToken({
        mint: 'https://mint-a.example',
        unit: 'usd' as never,
        proofs: [cashuProof(7, 'unsupported-unit-secret')],
      })
      const before = await profileFileSnapshot(home)

      await assert.rejects(
        () =>
          dispatch(
            { method: 'wallet.receive', params: { token } },
            {
              resolveTokenImportKeysets: async () => {
                resolverCalls += 1
                throw new Error('unsupported units must fail before keyset resolution')
              },
            },
          ),
        /unsupported.*unit/i,
      )

      assert.equal(resolverCalls, 0)
      assert.deepEqual(await profileFileSnapshot(home), before)
    })

    await t.test('wallet.send requires strict custody authority', async () => {
      await assert.rejects(
        () =>
          dispatch({
            method: 'wallet.send',
            params: { amountSats: 5, mintUrl: 'https://mint-a.example' },
          }),
        /requires custody authority/,
      )
    })

    await t.test('wallet.send rejects an unsafe outgoing amount before custody work', async () => {
      await assert.rejects(
        () =>
          dispatch({
            method: 'wallet.send',
            params: { amountSats: Number.MAX_SAFE_INTEGER + 1, mintUrl: 'https://mint-a.example' },
          }),
        /positive safe integer/,
      )
    })

    await t.test('wallet.send uses a leased strict-custody path for a V2 DLEQ proof', async () => {
      const privateKey = Uint8Array.from([...new Uint8Array(31), 9])
      const publicKey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
      const keys = { '1': publicKey, '2': publicKey, '4': publicKey, '8': publicKey }
      const keysetId = deriveKeysetId(keys, { unit: 'sat', versionByte: 1 })
      const input = signedDleqProof(
        OutputData.createSingleData(8, keysetId, 'strict-send-input', 1n),
        privateKey,
        keys,
      )
      const sendOutputs = [
        OutputData.createSingleData(4, keysetId, 'strict-send-four', 2n),
        OutputData.createSingleData(1, keysetId, 'strict-send-one', 3n),
      ]
      const keepOutputs = [
        OutputData.createSingleData(2, keysetId, 'strict-send-keep-two', 4n),
        OutputData.createSingleData(1, keysetId, 'strict-send-keep-one', 5n),
      ]
      const sent = sendOutputs.map((output) => signedDleqProof(output, privateKey, keys))
      const kept = keepOutputs.map((output) => signedDleqProof(output, privateKey, keys))
      const scopeId = deriveDurableCustodyScopeId({
        scopeKind: 'wallet',
        walletId: deriveDurableCustodyWalletId(Buffer.from(secrets.walletSeedHex, 'hex')),
      })
      const fence = await claimCustodyScopeLease(profileDir(), {
        scopeId,
        incarnationId: 'wallet-receive-bind-test',
        observedAtMs: Date.now(),
      })
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord(
          'https://mint-a.example',
          8,
          'available',
          { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
          input.secret,
        ),
      )
      state.wallet.proofs[0]!.proof = input
      await writeState(state)
      await withDurableCustodyUnitOfWork(profileDir(), fence, Date.now(), (database) => {
        const row = createCustodyProofSqliteRow({
          scopeId,
          normalizedMint: 'https://mint-a.example',
          unit: 'sat',
          proof: input,
          baseAsset: 'sat',
          conditionId: null,
          outcomeSetId: null,
          productBinding: null,
          signatureVerified: true,
          dleqState: 'verified',
          nut07State: 'UNSPENT',
          selectability: 'selectable',
          storageClass: 'pinned-operation-bound-deterministic',
          reservationOperationId: null,
          revision: 0,
          nowMs: Date.now(),
        })
        new DurableCustodySqliteStore(database).putProofBatchCas([
          { proof: row, expectedRevision: null },
        ])
      })
      let completeCalls = 0
      const response = await dispatch(
        {
          method: 'wallet.send',
          params: {
            amountSats: 5,
            mintUrl: 'https://mint-a.example',
            operationId: 'strict-wallet-send',
          },
        },
        {
          getCustodyFence: () => fence,
          createCashuWallet: () => ({
            loadMint: async () => {},
            receive: async () => [],
            send: async () => ({ keep: [], send: [] }),
            prepareSwapToSend: async (_amount, proofs) => {
              assert.equal(proofs.length, 1)
              assert.equal(proofs[0]?.secret, input.secret)
              return {
                amount: Amount.from(5),
                fees: Amount.zero(),
                keysetId,
                inputs: proofs,
                sendOutputs,
                keepOutputs,
                unselectedProofs: [],
              }
            },
            completeSwap: async () => {
              completeCalls += 1
              return { keep: kept, send: sent }
            },
            checkProofsStates: async () => [],
            getKeyset: () => ({ id: keysetId, unit: 'sat', keys, fee: 0, verify: () => true }),
          }),
          restoreOutputGroups: async (_mintUrl, outputs) => {
            assert.deepEqual(Object.keys(outputs).sort(), ['keep', 'send'])
            return { keep: kept, send: sent }
          },
        },
      )

      assert.equal(response.ok, true)
      assert.equal(completeCalls, 1)
      assert.equal((response.result as { proofCount: number }).proofCount, 2)
    })

    await t.test(
      'order.submit reuses one Score delivery across projection lag and retires it after the purchase epoch advances',
      async () => {
        const privateKey = Uint8Array.from([...new Uint8Array(31), 9])
        const publicKey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
        const keys = { '1': publicKey, '2': publicKey, '4': publicKey, '8': publicKey }
        const keysetId = deriveKeysetId(keys, { unit: 'sat', versionByte: 1 })
        const scopeId = deriveDurableCustodyScopeId({
          scopeKind: 'wallet',
          walletId: deriveDurableCustodyWalletId(Buffer.from(secrets.walletSeedHex, 'hex')),
        })
        const fence = await claimCustodyScopeLease(profileDir(), {
          scopeId,
          incarnationId: 'wallet-receive-bind-test',
          observedAtMs: Date.now(),
        })
        const input = signedDleqProof(
          OutputData.createSingleData(8, keysetId, 'score-input', 19n),
          privateKey,
          keys,
        )
        const state = emptyDaemonState()
        state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            8,
            'available',
            { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
            input.secret,
          ),
        )
        state.wallet.proofs[0]!.proof = input
        await writeState(state)
        await withDurableCustodyUnitOfWork(profileDir(), fence, Date.now(), (database) => {
          const row = createCustodyProofSqliteRow({
            scopeId,
            normalizedMint: 'https://mint-a.example',
            unit: 'sat',
            proof: input,
            baseAsset: 'sat',
            conditionId: null,
            outcomeSetId: null,
            productBinding: null,
            signatureVerified: true,
            dleqState: 'verified',
            nut07State: 'UNSPENT',
            selectability: 'selectable',
            storageClass: 'pinned-operation-bound-deterministic',
            reservationOperationId: null,
            revision: 0,
            nowMs: Date.now(),
          })
          new DurableCustodySqliteStore(database).putProofBatchCas([
            { proof: row, expectedRevision: null },
          ])
        })
        const scoreOutputs = [
          OutputData.createSingleData(1, keysetId, 'score-send-one-a', 20n),
          OutputData.createSingleData(1, keysetId, 'score-send-one-b', 21n),
        ]
        const scoreProofs = scoreOutputs.map((output) => signedDleqProof(output, privateKey, keys))
        const scoreKeepOutputs = [OutputData.createSingleData(2, keysetId, 'score-keep-two', 22n)]
        scoreKeepOutputs.push(OutputData.createSingleData(4, keysetId, 'score-keep-four', 23n))
        const scoreKeepProofs = scoreKeepOutputs.map((output) =>
          signedDleqProof(output, privateKey, keys),
        )
        let completed = 0
        let deliveries = 0
        let deliveryId: string | null = null
        let scoreReads = 0
        let recoveryWakes = 0
        const command = {
          method: 'order.submit' as const,
          params: {
            marketId: 'cond-YES',
            outcomeId: 'YES',
            side: 'Buy' as const,
            price: 1_000,
            amountSubunits: 10_000,
            timeInForce: 'FAK' as const,
          },
        }
        const dispatchDeps = {
          getCustodyFence: () => fence,
          createCashuWallet: () => ({
            loadMint: async () => {},
            receive: async () => [],
            send: async () => ({ keep: [], send: [] }),
            prepareSwapToSend: async (amount, proofs) => {
              assert.equal(amount, 2)
              assert.equal(proofs.length, 1)
              assert.equal(Number(proofs[0]?.amount), 8)
              return {
                amount: Amount.from(2),
                fees: Amount.zero(),
                keysetId,
                inputs: proofs,
                sendOutputs: scoreOutputs,
                keepOutputs: scoreKeepOutputs,
                unselectedProofs: [],
              }
            },
            completeSwap: async () => {
              completed += 1
              return { keep: scoreKeepProofs, send: scoreProofs }
            },
            checkProofsStates: async () => [],
            getKeyset: () => ({ id: keysetId, unit: 'sat', keys, fee: 0, verify: () => true }),
          }),
          restoreOutputGroups: async () => ({ keep: scoreKeepProofs, send: scoreProofs }),
          triggerCustodyRecovery: () => {
            recoveryWakes += 1
          },
          createEngineClient: () => ({
            ...scoreDisabledEngineMethods,
            getParticipationScore: async () => {
              scoreReads += 1
              return scoreReads === 1 || scoreReads === 2 || scoreReads === 3
                ? scoreResponse({ balance: -1, matchDebitScore: 1 })
                : scoreResponse({ balance: 1, purchasedTotal: 2, matchDebitScore: 1 })
            },
            getDurableRecipientDeliveryStatus: async () => null,
            submitDurableRecipientDelivery: async (submission) => {
              deliveries += 1
              deliveryId = submission.deliveryId
              assert.equal(submission.requestedAmount, '2')
              assert.match(submission.token, /^cashu/)
              return creditedRecipientStatus(submission)
            },
            submitOrder: async () => ({
              orderId: 'score-paid-order',
              status: 'resting',
              remainingAmountSubunits: 10_000,
              fills: [],
              baseAsset: 'sat',
              divisibility: 10_000,
              activeSettlementGroup: null,
            }),
          }),
          prepareSettlementCapability: prepareSettlementCapability('score-paid-order'),
        }

        await assert.rejects(
          () => dispatch(command, dispatchDeps),
          /Participation Score credit is not available for this order/,
        )
        const response = await dispatch(command, dispatchDeps)

        assert.equal(response.ok, true, JSON.stringify(response))
        assert.equal(completed, 1)
        assert.equal(deliveries, 1)
        assert.equal(recoveryWakes, 2)
        assert.equal(
          (response.result as { participationScore: { kind: string } }).participationScore.kind,
          'paid',
        )
        assert.ok(deliveryId)
        const restarted = new DaemonDurableOutgoingCashuCoordinator(profileDir(), () => fence)
        await restarted.preflightParticipationScoreDelivery({
          transferId: 'f4444444-4444-4444-8444-444444444444',
          amountSats: 1,
          purchasedTotal: 2,
          accountSubject: secrets.nostrPublicKeyHex,
          mintUrl: 'https://mint-a.example',
        })
        assert.equal(await restarted.loadTransfer(deliveryId), null)
      },
    )

    await t.test('wallet.recover delegates manual recovery to wallet operations', async () => {
      await writeState(emptyDaemonState())

      const response = await dispatch({ method: 'wallet.recover' })

      assert.deepEqual(response, {
        ok: true,
        result: { recovered: [], pending: [] },
      })
    })

    await t.test('wallet.operations lists redacted proof operation summaries', async () => {
      const state = emptyDaemonState()
      state.proofOperations['op-a'] = {
        operationId: 'op-a',
        kind: 'wallet-send',
        state: 'prepared',
        mintUrl: 'https://mint-a.example',
        inputs: [
          { amount: 2, secret: 'input-secret-a', C: 'C-a' },
          { amount: 3, secret: 'input-secret-b', C: 'C-b' },
        ],
        outputs: {
          send: [
            {
              blindedMessage: { amount: 5, id: TEST_KEYSET_ID, B_: 'B-a' },
              blindingFactor: 'blind-secret-a',
              secret: 'output-secret-a',
            },
          ],
          keep: [],
        },
        metadata: { note: 'not returned' },
        createdAt: 10,
        updatedAt: 20,
      }
      const completedResults = {
        YES: [{ id: TEST_KEYSET_ID, amount: 8, secret: 'result-secret', C: 'C-result' }],
      }
      state.proofOperations['op-b'] = {
        operationId: 'op-b',
        kind: 'ctf-split',
        state: 'completed',
        mintUrl: 'mint-b',
        inputs: [{ amount: 8, secret: 'input-secret-c', C: 'C-c' }],
        outputs: {},
        metadata: {},
        resultProofs: completedResults,
        resultProofsDigest: completedProofAuthorityDigest(
          completedResults as Record<string, Proof[]>,
        ),
        lastError: null,
        createdAt: 30,
        updatedAt: 40,
      }
      await writeState(state)

      const all = await dispatch({ method: 'wallet.operations', params: {} })
      assert.equal(all.ok, true)
      assert.deepEqual(
        (all.result as Array<{ operationId: string }>).map((operation) => operation.operationId),
        ['op-b', 'op-a'],
      )
      assert.doesNotMatch(JSON.stringify(all.result), /secret|blind-secret/)

      const filtered = await dispatch({
        method: 'wallet.operations',
        params: { kind: 'wallet-send', state: 'prepared' },
      })
      assert.equal(filtered.ok, true)
      assert.deepEqual(filtered.result, [
        {
          operationId: 'op-a',
          kind: 'wallet-send',
          state: 'prepared',
          mintUrl: 'https://mint-a.example',
          inputAmountSats: 5,
          inputCount: 2,
          outputCounts: { send: 1, keep: 0 },
          resultProofCounts: {},
          lastError: null,
          createdAt: 10,
          updatedAt: 20,
        },
      ])
    })

    await t.test(
      'order.submit prepares a capability and submits only its bound reference',
      async () => {
        await writeState(backedDaemonState('cond', 1_000_000))
        let capturedOptions: { baseUrl: string; nostrSecretKeyHex: string } | null = null
        let capturedRequest: unknown = null
        let capturedPreparation: PrepareSettlementCapabilityInput | null = null
        const engine: EngineClientLike = {
          ...scoreDisabledEngineMethods,
          async submitOrder(_marketId, request) {
            capturedRequest = request
            return {
              orderId: 'order-1',
              status: 'resting',
              remainingAmountSubunits: 20_000,
              fills: [],
              baseAsset: 'sat',
              divisibility: 10_000,
              activeSettlementGroup: null,
            }
          },
          async getOrderStatus() {
            return null
          },
          async cancelOrder() {
            throw new Error('cancelOrder unused')
          },
          async getOrderBook() {
            throw new Error('getOrderBook unused')
          },
          async queryMarkets() {
            return { markets: [], nextCursor: null }
          },
        }

        const response = await dispatch(
          {
            method: 'order.submit',
            params: {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 4_200,
              amountSubunits: 20_000,
              minimumFillAmountSubunits: 10_000,
              continueAfterPartialFill: true,
              consolidateProofs: true,
              timeInForce: 'GTC',
            },
          },
          {
            createEngineClient(options) {
              capturedOptions = options
              return engine
            },
            prepareSettlementCapability: prepareSettlementCapability('order-1', (input) => {
              capturedPreparation = input
            }),
          },
        )

        assert.equal(response.ok, true)
        assert.deepEqual(capturedOptions, {
          baseUrl: 'http://localhost:5000',
          nostrSecretKeyHex: secrets.nostrSecretKeyHex,
        })
        assert.deepEqual(capturedRequest, {
          settlementCapability: {
            artifactId: '00000000-0000-4000-8000-000000000001',
            bindingDigest: 'ab'.repeat(32),
          },
          comment: null,
        })
        assert.match(
          (capturedPreparation as unknown as { clientOrderId: string }).clientOrderId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        )
        assert.deepEqual(capturedPreparation, {
          clientOrderId: (capturedPreparation as unknown as { clientOrderId: string })
            .clientOrderId,
          marketId: 'cond-YES',
          conditionId: 'cond',
          outcomeId: 'YES',
          tokenSide: 'Outcome',
          side: 'Buy',
          price: 4_200,
          amountSubunits: 20_000,
          minimumFillAmountSubunits: 10_000,
          continueAfterPartialFill: true,
          consolidateProofs: true,
          baseAsset: 'sat',
          collateralUnit: 'msat',
          divisibility: 10_000,
          timeInForce: 'GTC',
          expiresAt: null,
          mintUrl: 'https://mint-a.example',
          walletSeedHex: secrets.walletSeedHex,
        })

        const state = await readState()
        assert.equal(
          state?.orders['order-1']?.clientOrderId,
          (capturedPreparation as unknown as { clientOrderId: string }).clientOrderId,
        )
      },
    )

    await t.test(
      'order.submit validates D=1000000 prices using engine market metadata',
      async () => {
        await writeState(backedDaemonState('cond', 1_000_000))
        let capturedRequest: unknown = null
        let capturedPreparation: PrepareSettlementCapabilityInput | null = null
        const engine: EngineClientLike = {
          ...scoreDisabledEngineMethods,
          async submitOrder(_marketId, request) {
            capturedRequest = request
            return {
              orderId: 'order-d1000000',
              status: 'resting',
              remainingAmountSubunits: 1_000_000,
              fills: [],
              baseAsset: 'sat',
              divisibility: 1_000_000,
              activeSettlementGroup: null,
            }
          },
          async getOrderStatus() {
            return null
          },
          async cancelOrder() {
            throw new Error('cancelOrder unused')
          },
          async getOrderBook() {
            throw new Error('getOrderBook unused')
          },
          async queryMarkets() {
            return { markets: [], nextCursor: null }
          },
          async getMarket() {
            return { conditionId: 'cond', baseAsset: 'sat', divisibility: 1_000_000 }
          },
        }

        const response = await dispatch(
          {
            method: 'order.submit',
            params: {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 500_000,
              amountSubunits: 1_000_000,
              timeInForce: 'GTC',
            },
          },
          {
            createEngineClient() {
              return engine
            },
            prepareSettlementCapability: prepareSettlementCapability('order-d1000000', (input) => {
              capturedPreparation = input
            }),
          },
        )

        assert.equal(response.ok, true, response.error)
        assert.deepEqual(capturedRequest, {
          settlementCapability: {
            artifactId: '00000000-0000-4000-8000-000000000001',
            bindingDigest: 'ab'.repeat(32),
          },
          comment: null,
        })
        assert.equal(
          (capturedPreparation as unknown as PrepareSettlementCapabilityInput).divisibility,
          1_000_000,
        )
        assert.equal(
          (capturedPreparation as unknown as PrepareSettlementCapabilityInput).price,
          500_000,
        )
        assert.equal(
          (capturedPreparation as unknown as PrepareSettlementCapabilityInput)
            .minimumFillAmountSubunits,
          1_000_000,
        )
        assert.equal(
          (capturedPreparation as unknown as PrepareSettlementCapabilityInput)
            .continueAfterPartialFill,
          false,
        )
        assert.equal(
          (capturedPreparation as unknown as PrepareSettlementCapabilityInput).consolidateProofs,
          false,
        )
      },
    )

    await t.test(
      'order.submit blocks before POST when local buy collateral is insufficient',
      async () => {
        await writeState(emptyDaemonState())
        let submitCalls = 0
        const engine: EngineClientLike = {
          ...scoreDisabledEngineMethods,
          async submitOrder() {
            submitCalls += 1
            throw new Error('submitOrder should be gated before POST')
          },
          async getOrderStatus() {
            return null
          },
          async cancelOrder() {
            throw new Error('cancelOrder unused')
          },
          async getOrderBook() {
            throw new Error('getOrderBook unused')
          },
          async queryMarkets() {
            return { markets: [], nextCursor: null }
          },
          async getMarket() {
            return { conditionId: 'cond', baseAsset: 'sat', divisibility: 1_000_000 }
          },
        }

        const response = await dispatch(
          {
            method: 'order.submit',
            params: {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 500_000,
              amountSubunits: 2_000_000,
              timeInForce: 'GTC',
            },
          },
          { createEngineClient: () => engine },
        )

        assert.equal(response.ok, false)
        assert.equal(response.error, 'insufficient backing: have 0 base subunits, need 1000000')
        assert.equal(submitCalls, 0)
        assert.deepEqual((await readState())?.orders, {})
        // Bypass invariant: this client gate is UX-only. If bypassed, the engine
        // and Cashu/mint settlement path remain authoritative and must reject or
        // fail unbacked orders without spending proofs.
      },
    )

    await t.test('order.submit allows POST when local buy collateral is sufficient', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord(
          'https://mint-a.example',
          1_000_000,
          'available',
          {
            kind: 'sats',
            baseAsset: 'sat',
          },
          'base-collateral',
        ),
      )
      await writeState(state)
      let capturedRequest: unknown = null
      let capturedPreparation: PrepareSettlementCapabilityInput | null = null
      const engine: EngineClientLike = {
        ...scoreDisabledEngineMethods,
        async submitOrder(_marketId, request) {
          capturedRequest = request
          return {
            orderId: 'order-backed',
            status: 'resting',
            remainingAmountSubunits: 2_000_000,
            fills: [],
            baseAsset: 'sat',
            divisibility: 1_000_000,
            activeSettlementGroup: null,
          }
        },
        async getOrderStatus() {
          return null
        },
        async cancelOrder() {
          throw new Error('cancelOrder unused')
        },
        async getOrderBook() {
          throw new Error('getOrderBook unused')
        },
        async queryMarkets() {
          return { markets: [], nextCursor: null }
        },
        async getMarket() {
          return { conditionId: 'cond', baseAsset: 'sat', divisibility: 1_000_000 }
        },
      }

      const response = await dispatch(
        {
          method: 'order.submit',
          params: {
            marketId: 'cond-YES',
            outcomeId: 'YES',
            side: 'Buy',
            price: 500_000,
            amountSubunits: 2_000_000,
            timeInForce: 'GTC',
          },
        },
        {
          createEngineClient: () => engine,
          prepareSettlementCapability: prepareSettlementCapability('order-backed', (input) => {
            capturedPreparation = input
          }),
        },
      )

      assert.equal(response.ok, true)
      assert.deepEqual(capturedRequest, {
        settlementCapability: {
          artifactId: '00000000-0000-4000-8000-000000000001',
          bindingDigest: 'ab'.repeat(32),
        },
        comment: null,
      })
      assert.equal(
        (capturedPreparation as unknown as PrepareSettlementCapabilityInput).amountSubunits,
        2_000_000,
      )
      assert.equal((await readState())?.orders['order-backed']?.orderId, 'order-backed')
    })

    await t.test('order.submit binds complement intent and tracks its lifecycle', async () => {
      const priorState = await readState()
      await writeState(backedDaemonState())
      try {
        const engine: EngineClientLike = {
          ...scoreDisabledEngineMethods,
          async submitOrder(_marketId, request) {
            return {
              orderId: 'order-complement',
              status: 'resting',
              remainingAmountSubunits: 10_000,
              fills: [],
              baseAsset: 'sat',
              divisibility: 10_000,
              activeSettlementGroup: null,
            }
          },
          async getOrderStatus() {
            throw new Error('getOrderStatus unused')
          },
          async cancelOrder() {
            throw new Error('cancelOrder unused')
          },
          async getOrderBook() {
            throw new Error('getOrderBook unused')
          },
          async queryMarkets() {
            throw new Error('queryMarkets unused')
          },
        }
        let preparedTokenSide: 'Outcome' | 'Complement' | undefined

        const response = await dispatch(
          {
            method: 'order.submit',
            params: {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              tokenSide: 'Complement',
              side: 'Buy',
              price: 9_900,
              amountSubunits: 10_000,
              timeInForce: 'GTC',
            },
          },
          {
            createEngineClient() {
              return engine
            },
            prepareSettlementCapability: prepareSettlementCapability(
              'order-complement',
              (input) => {
                preparedTokenSide = input.tokenSide
              },
            ),
          },
        )

        assert.equal(response.ok, true, response.error)
        assert.equal(preparedTokenSide, 'Complement')
        assert.equal((await readState())?.orders['order-complement']?.tokenSide, 'Complement')
      } finally {
        if (priorState) await writeState(priorState)
      }
    })

    await t.test('order.submit propagates engine machine-code rejections', async () => {
      const priorState = await readState()
      await writeState(backedDaemonState())
      const engine: EngineClientLike = {
        ...scoreDisabledEngineMethods,
        async submitOrder() {
          throw new EngineClientError(
            400,
            '{"code":"InvalidOutcome","detail":"OutcomeId must match the primitive outcome segment of marketId."}',
            'InvalidOutcome',
            'OutcomeId must match the primitive outcome segment of marketId.',
          )
        },
        async getOrderStatus() {
          return null
        },
        async cancelOrder() {
          throw new Error('cancelOrder unused')
        },
        async getOrderBook() {
          throw new Error('getOrderBook unused')
        },
        async queryMarkets() {
          return { markets: [], nextCursor: null }
        },
      }

      let markedRejected = false
      const response = await dispatch(
        {
          method: 'order.submit',
          params: {
            marketId: 'cond-Bob',
            outcomeId: 'Bob',
            side: 'Buy',
            price: 4_200,
            amountSubunits: 10_000,
            timeInForce: 'GTC',
          },
        },
        {
          createEngineClient() {
            return engine
          },
          prepareSettlementCapability: prepareSettlementCapability(
            'order-rejected',
            undefined,
            () => {
              markedRejected = true
            },
          ),
        },
      )

      assert.equal(response.ok, false)
      assert.equal(response.code, 'InvalidOutcome')
      assert.equal(
        response.error,
        'OutcomeId must match the primitive outcome segment of marketId.',
      )
      assert.equal(markedRejected, true)
      assert.deepEqual((await readState())?.orders, {})
      if (priorState) await writeState(priorState)
    })

    await t.test(
      'order.submit retains a prepared capability after a retryable 409 conflict',
      async () => {
        const priorState = await readState()
        await writeState(backedDaemonState())
        let markedRejected = false
        let recoveryTriggers = 0
        const engine: EngineClientLike = {
          ...scoreDisabledEngineMethods,
          async submitOrder() {
            throw new EngineClientError(
              409,
              'Order book changed while submitting order; retry the request.',
              undefined,
              'Order book changed while submitting order; retry the request.',
            )
          },
          async getOrderStatus() {
            return null
          },
          async cancelOrder() {
            throw new Error('cancelOrder unused')
          },
          async getOrderBook() {
            throw new Error('getOrderBook unused')
          },
          async queryMarkets() {
            return { markets: [], nextCursor: null }
          },
        }

        const response = await dispatch(
          {
            method: 'order.submit',
            params: {
              marketId: 'cond-Bob',
              outcomeId: 'Bob',
              side: 'Buy',
              price: 4_200,
              amountSubunits: 10_000,
              timeInForce: 'GTC',
            },
          },
          {
            createEngineClient: () => engine,
            prepareSettlementCapability: prepareSettlementCapability(
              'order-retryable',
              undefined,
              () => {
                markedRejected = true
              },
            ),
            triggerSettlementRecovery: () => {
              recoveryTriggers += 1
            },
          },
        )

        assert.equal(response.ok, false)
        assert.equal(response.code, undefined)
        assert.equal(markedRejected, false)
        assert.equal(recoveryTriggers, 1)
        assert.deepEqual((await readState())?.orders, {})
        if (priorState) await writeState(priorState)
      },
    )

    await t.test(
      'order.submit checks combined order and Score backing before spending either',
      async () => {
        const priorState = await readState()
        const state = emptyDaemonState()
        state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            6,
            'available',
            { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
            'joint-backing-proof',
          ),
        )
        await writeState(state)
        let scorePayments = 0
        let preparations = 0
        try {
          const response = await dispatch(
            {
              method: 'order.submit',
              params: {
                marketId: 'cond-YES',
                outcomeId: 'YES',
                side: 'Buy',
                price: 4_200,
                amountSubunits: 10_000,
                timeInForce: 'GTC',
              },
            },
            {
              createEngineClient: () => ({
                ...scoreDisabledEngineMethods,
                getMarket: async (conditionId) => ({
                  conditionId,
                  baseAsset: 'sat',
                  divisibility: 10_000,
                }),
                getParticipationScore: async () =>
                  scoreResponse({ balance: -1, matchDebitScore: 1 }),
                payParticipationScoreEcash: async () => {
                  scorePayments += 1
                  throw new Error('Score payment must not start')
                },
              }),
              prepareSettlementCapability: prepareSettlementCapability('unused', () => {
                preparations += 1
              }),
            },
          )

          assert.equal(response.ok, false)
          assert.match(response.error, /insufficient combined backing/)
          assert.equal(scorePayments, 0)
          assert.equal(preparations, 0)
          assert.equal((await readState())?.wallet.proofs[0]?.proof.secret, 'joint-backing-proof')
        } finally {
          if (priorState) await writeState(priorState)
        }
      },
    )

    await t.test(
      'order.submit rejects malformed order intent before mutation or submission',
      async () => {
        const priorState = await readState()
        await writeState(backedDaemonState())

        try {
          for (const params of [
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 0,
              amountSubunits: 10_000,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 4_200,
              amountSubunits: 5_000,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 4_200,
              amountSubunits: 20_000,
              minimumFillAmountSubunits: 5_000,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 4_200,
              amountSubunits: 20_000,
              minimumFillAmountSubunits: 30_000,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 4_200,
              amountSubunits: 20_000,
              minimumFillAmountSubunits: null,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 4_200,
              amountSubunits: 10_000,
              timeInForce: 'IOC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 4_200,
              amountSubunits: 10_000,
              continueAfterPartialFill: 'yes',
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 4_200,
              amountSubunits: 10_000,
              consolidateProofs: 'yes',
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 4_200,
              amountSubunits: 10_000,
              continueAfterPartialFill: true,
              timeInForce: 'FAK',
            },
            {
              marketId: 'cond-Bob|Carol',
              outcomeId: 'Bob',
              side: 'Buy',
              price: 4_200,
              amountSubunits: 10_000,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-Bob',
              outcomeId: 'Bob|Carol',
              side: 'Buy',
              price: 4_200,
              amountSubunits: 10_000,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-Bob',
              outcomeId: 'Carol',
              side: 'Buy',
              price: 4_200,
              amountSubunits: 10_000,
              timeInForce: 'GTC',
            },
          ]) {
            let prepareCalls = 0
            let submitCalls = 0

            const response = await dispatch(
              {
                method: 'order.submit',
                params,
              } as never,
              {
                createEngineClient() {
                  return {
                    ...scoreDisabledEngineMethods,
                    async submitOrder() {
                      submitCalls += 1
                      throw new Error('submitOrder unused')
                    },
                    async getOrderStatus() {
                      throw new Error('getOrderStatus unused')
                    },
                    async cancelOrder() {
                      throw new Error('cancelOrder unused')
                    },
                    async getOrderBook() {
                      throw new Error('getOrderBook unused')
                    },
                    async queryMarkets() {
                      throw new Error('queryMarkets unused')
                    },
                  }
                },
                prepareSettlementCapability: prepareSettlementCapability('unused', () => {
                  prepareCalls += 1
                }),
              },
            )

            assert.equal(response.ok, false)
            assert.match(response.error ?? '', /Order rejected:/)
            assert.equal(prepareCalls, 0)
            assert.equal(submitCalls, 0)
            assert.deepEqual((await readState())?.orders, {})
          }
        } finally {
          if (priorState) await writeState(priorState)
        }
      },
    )

    await t.test('order.list reads filtered local daemon order state', async () => {
      const state = emptyDaemonState()
      state.orders['order-a'] = {
        orderId: 'order-a',
        marketId: 'cond-YES',
        status: 'resting',
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
      state.orders['order-b'] = {
        orderId: 'order-b',
        marketId: 'cond-NO',
        status: 'matched',
        createdAt: '2026-05-21T00:00:01.000Z',
        updatedAt: '2026-05-21T00:00:02.000Z',
      }
      state.orders['order-c'] = {
        orderId: 'order-c',
        marketId: 'cond-YES',
        status: 'cancelled',
        createdAt: '2026-05-21T00:00:03.000Z',
        updatedAt: '2026-05-21T00:00:03.000Z',
      }
      await writeState(state)

      const all = await dispatch({ method: 'order.list', params: {} })
      assert.equal(all.ok, true)
      assert.deepEqual(
        (all.result as Array<{ orderId: string }>).map((order) => order.orderId),
        ['order-c', 'order-b', 'order-a'],
      )

      const filtered = await dispatch({
        method: 'order.list',
        params: { marketId: 'cond-YES', status: 'resting' },
      })
      assert.equal(filtered.ok, true)
      assert.deepEqual(filtered.result, [state.orders['order-a']])
    })

    await t.test('order.cancel delegates to engine and marks local order cancelled', async () => {
      await writeState(emptyDaemonState())
      let capturedCancel: unknown = null

      const response = await dispatch(
        {
          method: 'order.cancel',
          params: {
            marketId: 'cond-YES',
            orderId: 'order-cancel',
          },
        },
        {
          createEngineClient() {
            return {
              async submitOrder() {
                throw new Error('submitOrder unused')
              },
              async getOrderStatus() {
                throw new Error('getOrderStatus unused')
              },
              async cancelOrder(marketId, orderId) {
                capturedCancel = { marketId, orderId }
                return true
              },
              async getMarket(conditionId) {
                return { conditionId, baseAsset: 'sat', divisibility: 10_000 }
              },
              async getOrderBook() {
                throw new Error('getOrderBook unused')
              },
              async queryMarkets() {
                throw new Error('queryMarkets unused')
              },
            }
          },
        },
      )

      assert.equal(response.ok, true)
      assert.deepEqual(capturedCancel, {
        marketId: 'cond-YES',
        orderId: 'order-cancel',
      })
      assert.deepEqual(response.result, {
        cancelled: true,
        local: {
          orderId: 'order-cancel',
          marketId: 'cond-YES',
          status: 'cancelled',
          baseAsset: 'sat',
          divisibility: 10_000,
          engineStatus: {
            orderId: 'order-cancel',
            marketId: 'cond-YES',
            status: 'cancelled',
          },
          createdAt: (response.result as { local: { createdAt: string } }).local.createdAt,
          updatedAt: (response.result as { local: { updatedAt: string } }).local.updatedAt,
        },
      })
      assert.equal((await readState())?.orders['order-cancel']?.status, 'cancelled')
    })

    await t.test('order.book delegates snapshot reads to engine client', async () => {
      let capturedMarketId: string | null = null
      const response = await dispatch(
        {
          method: 'order.book',
          params: { marketId: 'cond-YES' },
        },
        {
          createEngineClient() {
            return {
              async submitOrder() {
                throw new Error('submitOrder unused')
              },
              async getOrderStatus() {
                throw new Error('getOrderStatus unused')
              },
              async cancelOrder() {
                throw new Error('cancelOrder unused')
              },
              async getOrderBook(marketId) {
                capturedMarketId = marketId
                return {
                  marketId,
                  bids: [{ price: 42, amount: 100 }],
                  asks: [],
                  spread: null,
                }
              },
              async queryMarkets() {
                throw new Error('queryMarkets unused')
              },
            }
          },
        },
      )

      assert.equal(response.ok, true)
      assert.equal(capturedMarketId, 'cond-YES')
      assert.deepEqual(response.result, {
        marketId: 'cond-YES',
        bids: [{ price: 42, amount: 100 }],
        asks: [],
        spread: null,
      })
    })

    await t.test('order.submit tracks the order lifecycle after persistence', async () => {
      await writeState(backedDaemonState())
      let tracked: { marketId: string; orderId: string } | null = null
      const engine: EngineClientLike = {
        ...scoreDisabledEngineMethods,
        async submitOrder(_marketId, request) {
          return {
            orderId: 'order-runtime-fail',
            status: 'resting',
            remainingAmountSubunits: 10_000,
            fills: [],
            baseAsset: 'sat',
            divisibility: 10_000,
            activeSettlementGroup: null,
          }
        },
        async getOrderStatus() {
          return null
        },
        async cancelOrder() {
          throw new Error('cancelOrder unused')
        },
        async getOrderBook() {
          throw new Error('getOrderBook unused')
        },
        async queryMarkets() {
          return { markets: [], nextCursor: null }
        },
      }

      const response = await dispatch(
        {
          method: 'order.submit',
          params: {
            marketId: 'cond-YES',
            outcomeId: 'YES',
            side: 'Buy',
            price: 4_200,
            amountSubunits: 10_000,
            timeInForce: 'GTC',
          },
        },
        {
          createEngineClient() {
            return engine
          },
          prepareSettlementCapability: prepareSettlementCapability('order-runtime-fail'),
          async trackOwnedOrder(marketId, orderId) {
            assert.equal((await readState())?.orders[orderId]?.status, 'resting')
            tracked = { marketId, orderId }
            throw new Error('SignalR is unavailable')
          },
        },
      )

      assert.equal(response.ok, true)
      const state = await readState()
      assert.equal(state?.orders['order-runtime-fail']?.status, 'resting')
      assert.deepEqual(tracked, { marketId: 'cond-YES', orderId: 'order-runtime-fail' })
    })

    await t.test(
      'order.submit accepts direct sell flow after same-outcome CTF swaps are supported',
      async () => {
        await writeState(backedDaemonState())
        let capturedRequest: unknown = null
        let capturedPreparation: PrepareSettlementCapabilityInput | null = null

        const response = await dispatch(
          {
            method: 'order.submit',
            params: {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Sell',
              price: 4_200,
              amountSubunits: 10_000,
              timeInForce: 'GTC',
            },
          },
          {
            createEngineClient() {
              return {
                ...scoreDisabledEngineMethods,
                async submitOrder(_marketId, request) {
                  capturedRequest = request
                  return {
                    orderId: 'order-direct-sell',
                    status: 'resting',
                    remainingAmountSubunits: 10_000,
                    fills: [],
                    baseAsset: 'sat',
                    divisibility: 10_000,
                    activeSettlementGroup: null,
                  }
                },
                async getOrderStatus() {
                  return null
                },
                async cancelOrder() {
                  throw new Error('cancelOrder unused')
                },
                async getOrderBook() {
                  throw new Error('getOrderBook unused')
                },
                async queryMarkets() {
                  return { markets: [], nextCursor: null }
                },
              }
            },
            prepareSettlementCapability: prepareSettlementCapability(
              'order-direct-sell',
              (input) => {
                capturedPreparation = input
              },
            ),
          },
        )

        assert.equal(response.ok, true)
        assert.deepEqual(capturedRequest, {
          settlementCapability: {
            artifactId: '00000000-0000-4000-8000-000000000001',
            bindingDigest: 'ab'.repeat(32),
          },
          comment: null,
        })
        assert.equal(
          (capturedPreparation as unknown as PrepareSettlementCapabilityInput).side,
          'Sell',
        )
        assert.equal((await readState())?.orders['order-direct-sell']?.status, 'resting')
      },
    )

    await t.test('markets.query delegates catalogue reads to engine client', async () => {
      let capturedParams: unknown = null
      const response = await dispatch(
        {
          method: 'markets.query',
          params: { search: 'weather', limit: 5, state: 'All' },
        },
        {
          createEngineClient() {
            return {
              async submitOrder() {
                throw new Error('submitOrder unused')
              },
              async getOrderStatus() {
                throw new Error('getOrderStatus unused')
              },
              async cancelOrder() {
                throw new Error('cancelOrder unused')
              },
              async getOrderBook() {
                throw new Error('getOrderBook unused')
              },
              async queryMarkets(params) {
                capturedParams = params
                return {
                  markets: [{ conditionId: 'cond', title: 'Weather' }],
                  nextCursor: null,
                }
              },
            }
          },
        },
      )

      assert.equal(response.ok, true)
      assert.deepEqual(capturedParams, {
        search: 'weather',
        limit: 5,
        state: 'All',
      })
      assert.deepEqual(response.result, {
        markets: [{ conditionId: 'cond', title: 'Weather' }],
        nextCursor: null,
      })
    })

    await t.test('markets.show delegates single-market reads to engine client', async () => {
      let capturedConditionId = ''
      const response = await dispatch(
        {
          method: 'markets.show',
          params: { conditionId: 'condition-1' },
        },
        {
          createEngineClient() {
            return {
              async submitOrder() {
                throw new Error('submitOrder unused')
              },
              async getOrderStatus() {
                throw new Error('getOrderStatus unused')
              },
              async cancelOrder() {
                throw new Error('cancelOrder unused')
              },
              async getOrderBook() {
                throw new Error('getOrderBook unused')
              },
              async queryMarkets() {
                throw new Error('queryMarkets unused')
              },
              async getMarket(conditionId) {
                capturedConditionId = conditionId
                return { conditionId, title: 'Weather' }
              },
            }
          },
        },
      )

      assert.equal(response.ok, true)
      assert.equal(capturedConditionId, 'condition-1')
      assert.deepEqual(response.result, {
        conditionId: 'condition-1',
        title: 'Weather',
      })
    })
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

async function insertCustodyBalanceProof(input: {
  readonly proofId: string
  readonly amount: number
  readonly nut07State: 'UNSPENT' | 'SPENT'
  readonly selectability: 'locked' | 'spent'
}): Promise<void> {
  await withDaemonStateSqliteTransaction(profileDir(), (database) => {
    const scope = database
      .prepare(`SELECT scope_id AS scopeId FROM custody_scopes WHERE scope_kind = 'wallet'`)
      .get() as { scopeId: string }
    database
      .prepare(
        `INSERT INTO custody_proofs (
          proof_id, scope_id, normalized_mint, unit, keyset_id, amount,
          base_asset, condition_id, outcome_set_id, product_binding,
          proof_body, proof_fingerprint, curve, signature_verified,
          dleq_state, nut07_state, selectability, storage_class,
          reservation_operation_id, revision, created_at_ms, updated_at_ms
        ) VALUES (
          ?, ?, 'https://mint-a.example', 'msat', '${TEST_KEYSET_ID}', ?,
          'sat', NULL, NULL, NULL,
          ?, ?, 'secp256k1', 1,
          'not-present', ?, ?, 'pinned-operation-bound-deterministic',
          'balance-operation', 0, 0, 0
        )`,
      )
      .run(
        input.proofId,
        scope.scopeId,
        input.amount,
        new Uint8Array([1]),
        input.proofId,
        input.nut07State,
        input.selectability,
      )
  })
}

function prepareSettlementCapability(
  orderId: string,
  onPrepare?: (input: PrepareSettlementCapabilityInput) => void,
  onRejected?: () => void,
) {
  return async (input: PrepareSettlementCapabilityInput) => {
    onPrepare?.(input)
    return {
      operationId: `range:${input.clientOrderId}`,
      markSubmitted: async () => undefined,
      markRejected: async () => onRejected?.(),
      consolidation: { operationIds: [], feeSubunits: 0 },
      capability: {
        reference: {
          artifactId: '00000000-0000-4000-8000-000000000001',
          bindingDigest: 'ab'.repeat(32),
        },
        orderId,
        clientOrderId: input.clientOrderId,
        marketId: input.marketId,
        artifactDigest: 'cd'.repeat(32),
        state: 'bound' as const,
        version: 1,
        authorizationExpiresAt: '2026-08-01T00:00:00.000Z',
        stageExpiresAt: '2026-07-31T23:59:00.000Z',
        settlementGroup: null,
      },
    }
  }
}

function proofRecord(
  mintUrl: string,
  amount: number,
  state: DaemonState['wallet']['proofs'][number]['state'],
  asset: DaemonState['wallet']['proofs'][number]['asset'],
  secret = `secret-${amount}`,
): DaemonState['wallet']['proofs'][number] {
  const strictAsset =
    asset.kind === 'Outcome' || (asset as { kind?: unknown }).kind === 'outcome'
      ? {
          ...asset,
          kind: 'Outcome' as const,
          baseAsset: 'sat' as const,
          unit: 'msat' as const,
        }
      : {
          ...asset,
          kind: 'sats' as const,
          baseAsset: 'sat' as const,
          unit: asset.unit === 'sat' ? ('sat' as const) : ('msat' as const),
        }
  return {
    mintUrl,
    state,
    asset: strictAsset,
    proof: {
      id: canonicalTestKeysetId(`dispatch:${amount}`),
      amount,
      secret,
      C: `c-${amount}`,
    },
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  }
}

function backedDaemonState(conditionId = 'cond', amount = 10_000): DaemonState {
  const state = emptyDaemonState()
  state.wallet.proofs.push(
    proofRecord(
      'https://mint-a.example',
      amount,
      'available',
      {
        kind: 'outcome',
        conditionId,
        outcomeSetId: 'YES',
        baseAsset: 'sat',
        unit: 'msat',
      },
      `${conditionId}-yes-vcs`,
    ),
    proofRecord(
      'https://mint-a.example',
      amount,
      'available',
      {
        kind: 'outcome',
        conditionId,
        outcomeSetId: 'NO',
        baseAsset: 'sat',
        unit: 'msat',
      },
      `${conditionId}-no-vcs`,
    ),
    proofRecord(
      'https://mint-a.example',
      amount,
      'available',
      {
        kind: 'sats',
        baseAsset: 'sat',
        unit: 'msat',
      },
      `${conditionId}-base`,
    ),
  )
  return state
}

const scoreDisabledEngineMethods = {
  async getMarket(conditionId: string) {
    return { conditionId, baseAsset: 'sat', divisibility: 10_000 }
  },
  async getParticipationScore() {
    return scoreResponse({ enabled: false })
  },
} satisfies Pick<EngineClientLike, 'getMarket' | 'getParticipationScore'>

function creditedRecipientStatus(submission: DurableRecipientDeliverySubmission) {
  const { token: _token, ...delivery } = submission
  return decodeDurableRecipientDeliveryStatus({
    delivery,
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(submission),
    state: 'credited',
    result: {
      creditedAmount: submission.requestedAmount,
      receiveFee: '0',
      creditVerification: submission.creditPolicy,
      receiveOperationId: 'receive-1',
      receivedAt: '2026-08-11T00:00:00.000Z',
      businessEventId: 'event-1',
      businessEventAt: '2026-08-11T00:00:00.000Z',
    },
  })
}

function scoreResponse(
  overrides: Partial<Awaited<ReturnType<EngineClientLike['getParticipationScore']>>> = {},
): Awaited<ReturnType<EngineClientLike['getParticipationScore']>> {
  return {
    pubkey: 'a'.repeat(64),
    balance: 0,
    purchasedTotal: 0,
    consumedTotal: 0,
    penaltyTotal: 0,
    matchDebitScore: 1,
    enabled: true,
    ...overrides,
  }
}

function cashuProof(amount: number, secret: string): Proof {
  return {
    id: V2_KEYSET_ID,
    amount,
    secret,
    C: `02${'11'.repeat(32)}`,
  }
}

function signedDleqProof(
  output: OutputData,
  privateKey: Uint8Array,
  keys: Record<string, string>,
): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    privateKey,
    output.blindedMessage.id,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), privateKey)
  const proof = output.toProof(
    {
      id: output.blindedMessage.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: output.blindedMessage.id, keys },
  )
  return {
    id: proof.id,
    amount: proof.amount,
    secret: proof.secret,
    C: proof.C,
    dleq: proof.dleq === undefined ? null : { ...proof.dleq, r: proof.dleq.r ?? null },
    p2pkE: null,
    witness: null,
  } as Proof
}

function tokenImportKeysetResolver(registry: 'regular' | 'conditional', unit: 'sat' | 'msat') {
  return async () => ({
    freshness: 'fresh' as const,
    regularKeysets: registry === 'regular' ? [{ keysetId: V2_KEYSET_ID, unit, active: true }] : [],
    conditionalKeysets:
      registry === 'conditional' ? [{ keysetId: V2_KEYSET_ID, unit, active: true }] : [],
  })
}

async function profileFileSnapshot(directory: string): Promise<Array<[string, Buffer]>> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  return Promise.all(files.map(async (file) => [file, await readFile(join(directory, file))]))
}
