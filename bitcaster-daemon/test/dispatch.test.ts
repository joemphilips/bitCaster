import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getEncodedToken, type Proof } from '@cashu/cashu-ts'
import { EngineClientError } from '@bitcaster-market/client-sdk/engineClient'
import { dispatch, type EngineClientLike } from '../src/server.ts'
import { profileFromPublicKey, readProfile, writeProfile } from '../src/profile.ts'
import {
  createDaemonSecrets,
  readSecrets,
  writeSecrets,
} from '../src/secrets.ts'
import {
  emptyDaemonState,
  readState,
  writeState,
  type DaemonState,
} from '../src/state.ts'
import {
  recoverPreparedWalletSends,
  splitAvailableSatProofsForCtfCollateral,
} from '../src/walletOps.ts'

test('daemon dispatch persists wallet, order, and swap state', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-test-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    profile.mintUrl = 'mint-a'
    await writeProfile(profile)
    await writeSecrets(secrets)

    await t.test('wallet.balance summarizes durable proof state', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord('mint-a', 100, 'available', { kind: 'sats' }),
        proofRecord('mint-a', 50, 'reserved', { kind: 'sats' }),
        proofRecord('mint-a', 999, 'available', { kind: 'sats', baseAsset: 'usd' }),
        proofRecord('mint-a', 25, 'locked', {
          kind: 'outcome',
          conditionId: 'cond',
          outcomeSetId: 'YES',
        }),
      )
      await writeState(state)

      const result = await dispatch({ method: 'wallet.balance' })

      assert.equal(result.ok, true)
      assert.deepEqual(result.result, {
        totalAvailableSats: 100,
        totalReservedSats: 50,
        totalLockedSats: 25,
        byMint: [
          {
            mintUrl: 'mint-a',
            availableSats: 100,
            reservedSats: 50,
            lockedSats: 25,
          },
        ],
        outcomePositions: [
          {
            mintUrl: 'mint-a',
            conditionId: 'cond',
            outcomeSetId: 'YES',
            availableSats: 0,
            reservedSats: 0,
            lockedSats: 25,
          },
        ],
      })
    })

    await t.test('preflight collateral preparation opens sat markets with msat wallet unit', async () => {
      const priorState = await readState()
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord('mint-a', 1_000, 'available', { kind: 'sats', baseAsset: 'sat' }, 'msat-proof'),
      )
      await writeState(state)

      const requestedUnits: Array<string | null | undefined> = []
      try {
        await assert.rejects(
          () => splitAvailableSatProofsForCtfCollateral(
            1_000,
            'mint-a',
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
    })

    await t.test('daemon.status returns redacted profile and state summary', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord('mint-a', 10, 'available', { kind: 'sats' }, 'status-secret'),
      )
      state.proofOperations['op-status'] = {
        operationId: 'op-status',
        kind: 'wallet-send',
        state: 'prepared',
        mintUrl: 'mint-a',
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
        tradeIds: ['trade-status'],
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
      state.swaps['trade-status'] = {
        tradeId: 'trade-status',
        marketId: 'cond-YES',
        orderId: 'order-status',
        messages: {},
        step: 'seller-opened',
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
          swaps: 1,
        },
        wallet: {
          totalAvailableSats: 10,
          totalReservedSats: 0,
          totalLockedSats: 0,
          byMint: [
            {
              mintUrl: 'mint-a',
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

    await t.test('daemon state serializes native CTF proof operation amounts as numbers', async () => {
      const state = emptyDaemonState()
      state.proofOperations['ctf-native-op'] = {
        operationId: 'ctf-native-op',
        kind: 'conditional-keyset-swap',
        state: 'completed',
        mintUrl: 'mint-a',
        inputs: [
          { id: 'ctf-keyset', amount: 136n as never, secret: 'ctf-input', C: 'C-in' },
        ],
        outputs: {
          lock: [
            {
              blindedMessage: { amount: 100n as never, id: 'ctf-keyset', B_: 'B-lock' },
              blindingFactor: '01',
              secret: '02',
            },
          ],
        },
        metadata: { fees: 0n },
        resultProofs: {
          lock: [
            { id: 'ctf-keyset', amount: 100n as never, secret: 'ctf-lock', C: 'C-out' },
          ],
        },
        createdAt: 1,
        updatedAt: 2,
      }

      await writeState(state)
      const restored = await readState()

      assert.equal(restored?.proofOperations['ctf-native-op']?.kind, 'conditional-keyset-swap')
      assert.equal(restored?.proofOperations['ctf-native-op']?.inputs[0].amount, 136)
      assert.equal(restored?.proofOperations['ctf-native-op']?.outputs.lock[0].blindedMessage.amount, 100)
      assert.equal(restored?.proofOperations['ctf-native-op']?.resultProofs?.lock[0].amount, 100)
    })

    await t.test('daemon.config updates engine and mint URLs without replacing identity', async () => {
      await writeState(emptyDaemonState())
      const response = await dispatch({
        method: 'daemon.config',
        params: {
          engineUrl: 'http://engine.example/',
          mintUrl: 'https://mint.example/',
        },
      })

      assert.equal(response.ok, true)
      assert.deepEqual(response.result, {
        profile: {
          ...profile,
          engineBaseUrl: 'http://engine.example',
          mintUrl: 'https://mint.example',
        },
        restartRequired: true,
        reason:
          'restart bitcaster-daemon to reconnect long-lived TradeHub runtime with updated endpoints',
      })

      const status = await dispatch({ method: 'daemon.status' })
      assert.equal(status.ok, true)
      assert.equal(
        (status.result as { profile: { nostrPublicKey?: string } }).profile
          .nostrPublicKey,
        profile.nostrPublicKey,
      )
      assert.equal(
        (status.result as { profile: { engineBaseUrl: string } }).profile
          .engineBaseUrl,
        'http://engine.example',
      )
      await writeProfile(profile)
    })

    await t.test('daemon.config refuses endpoint changes after durable state exists', async () => {
      for (const buildState of [
        () => {
          const state = emptyDaemonState()
          state.wallet.proofs.push(
            proofRecord('mint-a', 1, 'available', { kind: 'sats' }, 'config-proof'),
          )
          return state
        },
        () => {
          const state = emptyDaemonState()
          state.proofOperations['config-op'] = {
            operationId: 'config-op',
            kind: 'wallet-send',
            state: 'prepared',
            mintUrl: 'mint-a',
            inputs: [{ amount: 1, secret: 'config-op-secret', C: 'C-config' }],
            outputs: {},
            metadata: {},
            createdAt: 1,
            updatedAt: 2,
          }
          return state
        },
        () => {
          const state = emptyDaemonState()
          state.orders['config-order'] = {
            orderId: 'config-order',
            marketId: 'cond-YES',
            status: 'resting',
            tradeIds: [],
            createdAt: '2026-05-21T00:00:00.000Z',
            updatedAt: '2026-05-21T00:00:00.000Z',
          }
          return state
        },
        () => {
          const state = emptyDaemonState()
          state.swaps['config-trade'] = {
            tradeId: 'config-trade',
            marketId: 'cond-YES',
            messages: {},
            step: 'seller-opened',
            createdAt: '2026-05-21T00:00:00.000Z',
            updatedAt: '2026-05-21T00:00:00.000Z',
          }
          return state
        },
      ]) {
        await writeState(buildState())
        const response = await dispatch({
          method: 'daemon.config',
          params: { mintUrl: 'http://mint.example' },
        })

        assert.equal(response.ok, false)
        assert.match(
          response.error ?? '',
          /cannot be changed after wallet, proof-operation, order, or swap state exists/,
        )
        assert.equal((await readProfile())?.mintUrl, profile.mintUrl)
      }
    })

    await t.test('daemon.config allows no-op endpoint updates with durable state', async () => {
      const state = emptyDaemonState()
      state.orders['config-noop-order'] = {
        orderId: 'config-noop-order',
        marketId: 'cond-YES',
        status: 'resting',
        tradeIds: [],
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
      await writeState(state)

      const response = await dispatch({
        method: 'daemon.config',
        params: {
          engineUrl: `${profile.engineBaseUrl}/`,
        },
      })

      assert.equal(response.ok, true)
      assert.deepEqual(
        (response.result as { profile: typeof profile }).profile,
        profile,
      )
    })

    await t.test('wallet.receive redeems token proofs into daemon state', async () => {
      await writeState(emptyDaemonState())
      const token = getEncodedToken({
        mint: 'mint-a',
        unit: 'sat',
        proofs: [cashuProof(7, 'token-secret')],
      })
      const response = await dispatch(
        { method: 'wallet.receive', params: { token } },
        {
          createCashuWallet(mintUrl) {
            assert.equal(mintUrl, 'mint-a')
            return {
              async loadMint() {},
              async receive(receivedToken, config) {
                assert.equal(receivedToken, token)
                assert.deepEqual(config?.proofsWeHave, [])
                return [cashuProof(7, 'fresh-secret')]
              },
              async send() {
                throw new Error('send unused')
              },
            }
          },
        },
      )

      assert.equal(response.ok, true)
      assert.deepEqual(response.result, {
        mintUrl: 'mint-a',
        amountSats: 7,
        proofCount: 1,
        asset: { kind: 'sats', baseAsset: 'sat' },
      })
      const state = await readState()
      assert.equal(state?.wallet.proofs[0]?.proof.secret, 'fresh-secret')
      assert.equal(state?.wallet.proofs[0]?.state, 'available')
      assert.deepEqual(state?.wallet.proofs[0]?.asset, { kind: 'sats', baseAsset: 'sat' })
    })

    await t.test('wallet.receive can classify imported proofs as outcome tokens', async () => {
      await writeState(emptyDaemonState())
      const token = getEncodedToken({
        mint: 'mint-a',
        unit: 'sat',
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
          async resolveConditionKeysetIds(mintUrl, conditionId) {
            assert.equal(mintUrl, 'mint-a')
            assert.equal(conditionId, 'cond')
            return ['009a1f293253e41e']
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
                assert.deepEqual(proofs, [
                  { id: '009a1f293253e41e', secret: 'outcome-token-secret' },
                ])
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
        mintUrl: 'mint-a',
        amountSats: 11,
        proofCount: 1,
        asset: {
          kind: 'outcome',
          conditionId: 'cond',
          outcomeSetId: 'YES',
          baseAsset: 'sat',
        },
      })
      const state = await readState()
      assert.deepEqual(state?.wallet.proofs[0]?.asset, {
        kind: 'outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
        baseAsset: 'sat',
      })
      assert.equal(state?.wallet.proofs[0]?.proof.secret, 'outcome-token-secret')
    })

    await t.test('wallet.receive rejects spent outcome-token proofs before persistence', async () => {
      await writeState(emptyDaemonState())
      const token = getEncodedToken({
        mint: 'mint-a',
        unit: 'sat',
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
              async resolveConditionKeysetIds() {
                return ['009a1f293253e41e']
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
    })

    await t.test('wallet.receive rejects partial outcome metadata', async () => {
      const token = getEncodedToken({
        mint: 'mint-a',
        unit: 'sat',
        proofs: [cashuProof(7, 'partial-outcome-secret')],
      })

      await assert.rejects(
        () =>
          dispatch({
            method: 'wallet.receive',
            params: { token, conditionId: 'cond' },
          }),
        /conditionId and outcomeSetId must be supplied together/,
      )
    })

    await t.test('wallet.receive rejects tokens for unexpected mints', async () => {
      const token = getEncodedToken({
        mint: 'http://unexpected-mint.local',
        unit: 'sat',
        proofs: [cashuProof(7, 'unexpected-mint-secret')],
      })

      await assert.rejects(
        () => dispatch({ method: 'wallet.receive', params: { token } }),
        /mint does not match daemon profile mint/,
      )
    })

    await t.test('wallet.send spends stored proofs and returns an encoded token', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord('mint-a', 8, 'available', { kind: 'sats' }, 'spend-secret-a'),
        proofRecord('mint-a', 4, 'available', { kind: 'sats' }, 'spend-secret-b'),
      )
      await writeState(state)
      const response = await dispatch(
        { method: 'wallet.send', params: { amountSats: 5, mintUrl: 'mint-a' } },
        {
          createCashuWallet(mintUrl) {
            assert.equal(mintUrl, 'mint-a')
            return resumableSendWallet({
              onPrepare(amount, proofs) {
                assert.equal(amount, 5)
                assert.deepEqual(
                  proofs.map((proof) => proof.secret),
                  ['spend-secret-a'],
                )
              },
              onComplete() {
                return {
                  send: [cashuProof(5, 'sent-secret')],
                  keep: [cashuProof(3, 'change-secret')],
                }
              },
            })
          },
        },
      )

      assert.equal(response.ok, true)
      assert.equal((response.result as { amountSats: number }).amountSats, 5)
      assert.match(
        (response.result as { operationId: string }).operationId,
        /^wallet-send-/,
      )
      assert.match((response.result as { token: string }).token, /^cashu/)
      const updated = await readState()
      assert.equal(
        updated?.proofOperations[
          (response.result as { operationId: string }).operationId
        ]?.state,
        'completed',
      )
      assert.deepEqual(
        updated?.wallet.proofs.map((record) => record.proof.secret).sort(),
        ['change-secret', 'spend-secret-b'],
      )
    })

    await t.test('concurrent wallet.send calls reserve distinct proofs', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord('mint-a', 8, 'available', { kind: 'sats' }, 'send-a'),
        proofRecord('mint-a', 8, 'available', { kind: 'sats' }, 'send-b'),
      )
      await writeState(state)
      const selectedSecrets: string[] = []

      const responses = await Promise.all([
        dispatch(
          { method: 'wallet.send', params: { amountSats: 5, mintUrl: 'mint-a' } },
          { createCashuWallet: concurrentSendWallet(selectedSecrets) },
        ),
        dispatch(
          { method: 'wallet.send', params: { amountSats: 5, mintUrl: 'mint-a' } },
          { createCashuWallet: concurrentSendWallet(selectedSecrets) },
        ),
      ])

      assert.deepEqual(responses.map((response) => response.ok), [true, true])
      assert.deepEqual(selectedSecrets.sort(), ['send-a', 'send-b'])
      const updated = await readState()
      assert.deepEqual(
        updated?.wallet.proofs.map((record) => record.proof.secret).sort(),
        ['change-send-a', 'change-send-b'],
      )
    })

    await t.test('wallet.send releases reserved proofs when mint send fails', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord('mint-a', 8, 'available', { kind: 'sats' }, 'send-fail'),
      )
      await writeState(state)

      await assert.rejects(
        () =>
          dispatch(
            { method: 'wallet.send', params: { amountSats: 5, mintUrl: 'mint-a' } },
            {
              createCashuWallet() {
                return {
                  async loadMint() {},
                  async receive() {
                    throw new Error('receive unused')
                  },
                  async send() {
                    throw new Error('send unused')
                  },
                  async prepareSwapToSend() {
                    throw new Error('mint unavailable')
                  },
                  async completeSwap() {
                    throw new Error('complete unused')
                  },
                }
              },
            },
          ),
        /mint unavailable/,
      )

      const updated = await readState()
      assert.equal(updated?.wallet.proofs[0]?.proof.secret, 'send-fail')
      assert.equal(updated?.wallet.proofs[0]?.state, 'available')
      assert.equal(updated?.wallet.proofs[0]?.reservedBy, undefined)
    })

    await t.test('wallet.send with operation id is idempotent after completion', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord('mint-a', 8, 'available', { kind: 'sats' }, 'send-op'),
      )
      await writeState(state)
      let prepared = 0
      let completed = 0

      const first = await dispatch(
        {
          method: 'wallet.send',
          params: {
            amountSats: 5,
            mintUrl: 'mint-a',
            operationId: 'wallet-send-op-1',
          },
        },
        {
          createCashuWallet() {
            return resumableSendWallet({
              onPrepare: () => {
                prepared += 1
              },
              onComplete: () => {
                completed += 1
                return {
                  send: [cashuProof(5, 'sent-op')],
                  keep: [cashuProof(3, 'change-op')],
                }
              },
            })
          },
        },
      )
      const second = await dispatch(
        {
          method: 'wallet.send',
          params: {
            amountSats: 5,
            mintUrl: 'mint-a',
            operationId: 'wallet-send-op-1',
          },
        },
        {
          createCashuWallet() {
            return resumableSendWallet({
              onPrepare: () => {
                throw new Error('prepare should not run for completed operation')
              },
              onComplete: () => {
                throw new Error('complete should not run for completed operation')
              },
            })
          },
        },
      )

      assert.equal(first.ok, true)
      assert.equal(second.ok, true)
      assert.equal((first.result as { token: string }).token, (second.result as { token: string }).token)
      assert.equal(prepared, 1)
      assert.equal(completed, 1)
      const updated = await readState()
      assert.equal(updated?.proofOperations['wallet-send-op-1']?.state, 'completed')
      assert.deepEqual(
        updated?.wallet.proofs.map((record) => record.proof.secret),
        ['change-op'],
      )
    })

    await t.test('wallet.send with operation id restores spent prepared outputs', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord('mint-a', 8, 'available', { kind: 'sats' }, 'send-restore'),
      )
      await writeState(state)

      await assert.rejects(
        () =>
          dispatch(
            {
              method: 'wallet.send',
              params: {
                amountSats: 5,
                mintUrl: 'mint-a',
                operationId: 'wallet-send-restore',
              },
            },
            {
              createCashuWallet() {
                return resumableSendWallet({
                  onComplete: () => {
                    throw new Error('connection lost after prepare')
                  },
                })
              },
            },
          ),
        /connection lost after prepare/,
      )

      const retried = await dispatch(
        {
          method: 'wallet.send',
          params: {
            amountSats: 5,
            mintUrl: 'mint-a',
            operationId: 'wallet-send-restore',
          },
        },
        {
          createCashuWallet() {
            return resumableSendWallet({
              proofState: 'SPENT',
              onPrepare: () => {
                throw new Error('prepare should not run during restore')
              },
              onComplete: () => {
                throw new Error('complete should not run when inputs are spent')
              },
            })
          },
          async restoreOutputGroups(_mintUrl, outputs) {
            assert.deepEqual(Object.keys(outputs).sort(), ['keep', 'send'])
            return {
              send: [cashuProof(5, 'restored-send')],
              keep: [cashuProof(3, 'restored-keep')],
            }
          },
        },
      )

      assert.equal(retried.ok, true)
      assert.match((retried.result as { token: string }).token, /^cashu/)
      const updated = await readState()
      assert.equal(updated?.proofOperations['wallet-send-restore']?.state, 'completed')
      assert.deepEqual(
        updated?.wallet.proofs.map((record) => record.proof.secret),
        ['restored-keep'],
      )
    })

    await t.test('wallet recovery sweep completes spent prepared sends', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord('mint-a', 8, 'available', { kind: 'sats' }, 'recover-spent'),
      )
      await writeState(state)

      await assert.rejects(
        () =>
          dispatch(
            {
              method: 'wallet.send',
              params: {
                amountSats: 5,
                mintUrl: 'mint-a',
                operationId: 'wallet-send-recover-spent',
              },
            },
            {
              createCashuWallet() {
                return resumableSendWallet({
                  onComplete: () => {
                    throw new Error('connection lost after prepare')
                  },
                })
              },
            },
          ),
        /connection lost after prepare/,
      )

      const recovery = await recoverPreparedWalletSends(secrets, {
        createCashuWallet() {
          return resumableSendWallet({
            proofState: 'SPENT',
            onPrepare: () => {
              throw new Error('prepare should not run during recovery')
            },
            onComplete: () => {
              throw new Error('complete should not run when inputs are spent')
            },
          })
        },
        async restoreOutputGroups(_mintUrl, outputs) {
          assert.deepEqual(Object.keys(outputs).sort(), ['keep', 'send'])
          return {
            send: [cashuProof(5, 'sweep-send')],
            keep: [cashuProof(3, 'sweep-keep')],
          }
        },
      })

      assert.deepEqual(recovery, {
        recovered: ['wallet-send-recover-spent'],
        pending: [],
      })
      const updated = await readState()
      assert.equal(updated?.proofOperations['wallet-send-recover-spent']?.state, 'completed')
      assert.deepEqual(
        updated?.wallet.proofs.map((record) => record.proof.secret),
        ['sweep-keep'],
      )
    })

    await t.test('wallet recovery sweep reports mint-pending sends without throwing', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord('mint-a', 8, 'available', { kind: 'sats' }, 'recover-pending'),
      )
      await writeState(state)

      await assert.rejects(
        () =>
          dispatch(
            {
              method: 'wallet.send',
              params: {
                amountSats: 5,
                mintUrl: 'mint-a',
                operationId: 'wallet-send-recover-pending',
              },
            },
            {
              createCashuWallet() {
                return resumableSendWallet({
                  onComplete: () => {
                    throw new Error('connection lost after prepare')
                  },
                })
              },
            },
          ),
        /connection lost after prepare/,
      )

      const recovery = await recoverPreparedWalletSends(secrets, {
        createCashuWallet() {
          return resumableSendWallet({
            proofState: 'PENDING',
            onPrepare: () => {
              throw new Error('prepare should not run during recovery')
            },
            onComplete: () => {
              throw new Error('complete should not run while mint is pending')
            },
          })
        },
      })

      assert.deepEqual(recovery.recovered, [])
      assert.equal(recovery.pending.length, 1)
      assert.equal(
        recovery.pending[0].operationId,
        'wallet-send-recover-pending',
      )
      assert.match(recovery.pending[0].error, /still pending at the mint/)
      const updated = await readState()
      assert.equal(updated?.proofOperations['wallet-send-recover-pending']?.state, 'prepared')
      assert.equal(updated?.wallet.proofs[0]?.state, 'reserved')
      assert.equal(
        updated?.wallet.proofs[0]?.reservedBy,
        'wallet-send:wallet-send-recover-pending',
      )
    })

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
        mintUrl: 'mint-a',
        inputs: [
          { amount: 2, secret: 'input-secret-a', C: 'C-a' },
          { amount: 3, secret: 'input-secret-b', C: 'C-b' },
        ],
        outputs: {
          send: [
            {
              blindedMessage: { amount: 5, id: 'keyset-a', B_: 'B-a' },
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
      state.proofOperations['op-b'] = {
        operationId: 'op-b',
        kind: 'ctf-split',
        state: 'completed',
        mintUrl: 'mint-b',
        inputs: [{ amount: 8, secret: 'input-secret-c', C: 'C-c' }],
        outputs: {},
        metadata: {},
        resultProofs: {
          YES: [{ amount: 8, secret: 'result-secret', C: 'C-result' }],
        },
        lastError: null,
        createdAt: 30,
        updatedAt: 40,
      }
      await writeState(state)

      const all = await dispatch({ method: 'wallet.operations', params: {} })
      assert.equal(all.ok, true)
      assert.deepEqual(
        (all.result as Array<{ operationId: string }>).map(
          (operation) => operation.operationId,
        ),
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
          mintUrl: 'mint-a',
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

    await t.test('order.submit stores local order and private ephemeral key', async () => {
      await writeState(emptyDaemonState())
      let capturedOptions: { baseUrl: string; nostrSecretKeyHex: string } | null =
        null
      let capturedRequest: unknown = null
      let runtimeStartOrderIds: string[] = []
      const engine: EngineClientLike = {
        ...scoreDisabledEngineMethods,
        async submitOrder(_marketId, request) {
          capturedRequest = request
          return {
            orderId: 'order-1',
            status: 'matched',
            remainingAmountSubunits: 0,
            ephemeralPubkey: request.ephemeralPubkey,
            fills: [
              {
                id: 'fill-1',
                makerOrderId: 'maker-1',
                takerOrderId: 'order-1',
                outcomeId: request.outcomeId,
                amountSubunits: request.amountSubunits,
                executionPrice: request.price,
                path: 'Complementary',
                status: 'Matched',
                filledAt: '2026-05-21T00:00:00.000Z',
                tradeId: 'trade-1',
              },
            ],
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
            price: 42,
            amountSats: 100,
            timeInForce: 'GTC',
          },
        },
        {
          createEngineClient(options) {
            capturedOptions = options
            return engine
          },
          generateEphemeralKeypair: () => ({
            privateKeyHex: '11'.repeat(32),
            publicKeyHex: `02${'22'.repeat(32)}`,
          }),
          tradeRuntime: {
            async start(state) {
              runtimeStartOrderIds = Object.keys(state.orders)
              return { orders: [], trades: [] }
            },
            async stop() {},
          },
        },
      )

      assert.equal(response.ok, true)
      assert.deepEqual(capturedOptions, {
        baseUrl: 'http://localhost:5000',
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      assert.deepEqual(capturedRequest, {
        outcomeId: 'YES',
        tokenSide: 'Outcome',
        side: 'Buy',
        price: 42,
        amountSubunits: 100,
        timeInForce: 'GTC',
        ephemeralPubkey: `02${'22'.repeat(32)}`,
      })

      const state = await readState()
      assert.equal(state?.orders['order-1']?.ephemeralPubkey, `02${'22'.repeat(32)}`)
      assert.equal(state?.swaps['trade-1']?.step, 'awaiting-trade-created')
      assert.deepEqual(runtimeStartOrderIds, ['order-1'])

      const updatedSecrets = await readSecrets()
      assert.deepEqual(updatedSecrets?.orderEphemeralKeys['order-1'], {
        orderId: 'order-1',
        marketId: 'cond-YES',
        privateKeyHex: '11'.repeat(32),
        publicKeyHex: `02${'22'.repeat(32)}`,
        createdAt: updatedSecrets.orderEphemeralKeys['order-1'].createdAt,
      })
    })

    await t.test('order.submit validates D=1000 prices using engine market metadata', async () => {
      await writeState(emptyDaemonState())
      let capturedRequest: unknown = null
      const engine: EngineClientLike = {
        ...scoreDisabledEngineMethods,
        async submitOrder(_marketId, request) {
          capturedRequest = request
          return {
            orderId: 'order-d1000',
            status: 'resting',
            remainingAmountSubunits: request.amountSubunits,
            ephemeralPubkey: request.ephemeralPubkey,
            fills: [],
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
          return { conditionId: 'cond', baseAsset: 'sat', divisibility: 1_000 }
        },
      }

      const response = await dispatch(
        {
          method: 'order.submit',
          params: {
            marketId: 'cond-YES',
            outcomeId: 'YES',
            side: 'Buy',
            price: 500,
            amountSubunits: 1_000,
            timeInForce: 'GTC',
          },
        },
        {
          createEngineClient() {
            return engine
          },
          generateEphemeralKeypair: () => ({
            privateKeyHex: '55'.repeat(32),
            publicKeyHex: `02${'66'.repeat(32)}`,
          }),
          tradeRuntime: {
            async start() {
              return { orders: [], trades: [] }
            },
            async stop() {},
          },
        },
      )

      assert.equal(response.ok, true)
      assert.deepEqual(capturedRequest, {
        outcomeId: 'YES',
        tokenSide: 'Outcome',
        side: 'Buy',
        price: 500,
        amountSubunits: 1_000,
        timeInForce: 'GTC',
        ephemeralPubkey: `02${'66'.repeat(32)}`,
      })
    })

    await t.test('order.submit starts runtime with complement order subscription state', async () => {
      const priorState = await readState()
      await writeState(emptyDaemonState())
      try {
        const engine: EngineClientLike = {
          ...scoreDisabledEngineMethods,
          async submitOrder(_marketId, request) {
            return {
              orderId: 'order-complement',
              status: 'resting',
              remainingAmountSubunits: request.amountSubunits,
              fills: [],
              ephemeralPubkey: request.ephemeralPubkey,
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
        let runtimeOrder:
          | {
              marketId: string
              tokenSide?: 'Outcome' | 'Complement'
              orderId: string
            }
          | undefined

        const response = await dispatch(
          {
            method: 'order.submit',
            params: {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              tokenSide: 'Complement',
              side: 'Buy',
              price: 99,
              amountSats: 100,
              timeInForce: 'GTC',
            },
          },
          {
            createEngineClient() {
              return engine
            },
            generateEphemeralKeypair: () => ({
              privateKeyHex: '33'.repeat(32),
              publicKeyHex: `02${'44'.repeat(32)}`,
            }),
            tradeRuntime: {
              async start(state) {
                runtimeOrder = state.orders['order-complement']
                return { orders: [], trades: [] }
              },
              async stop() {},
            },
          },
        )

        assert.equal(response.ok, true)
        assert.equal(runtimeOrder?.orderId, 'order-complement')
        assert.equal(runtimeOrder?.marketId, 'cond-YES')
        assert.equal(runtimeOrder?.tokenSide, 'Complement')
      } finally {
        if (priorState) await writeState(priorState)
      }
    })

    await t.test('order.submit propagates engine machine-code rejections', async () => {
      const priorState = await readState()
      await writeState(emptyDaemonState())
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

      const response = await dispatch(
        {
          method: 'order.submit',
          params: {
            marketId: 'cond-Bob',
            outcomeId: 'Bob',
            side: 'Buy',
            price: 42,
            amountSats: 100,
            timeInForce: 'GTC',
          },
        },
        {
          createEngineClient() {
            return engine
          },
          generateEphemeralKeypair: () => ({
            privateKeyHex: '11'.repeat(32),
            publicKeyHex: `02${'22'.repeat(32)}`,
          }),
        },
      )

      assert.equal(response.ok, false)
      assert.equal(response.code, 'InvalidOutcome')
      assert.equal(
        response.error,
        'OutcomeId must match the primitive outcome segment of marketId.',
      )
      assert.deepEqual((await readState())?.orders, {})
      if (priorState) await writeState(priorState)
    })

    await t.test('order.submit pays missing Participation Score from wallet sats before submitting', async () => {
      const priorState = await readState()
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord('mint-a', 8, 'available', { kind: 'sats' }, 'score-proof'),
      )
      await writeState(state)

      try {
        const calls: string[] = []
        let capturedPayment:
          | { amountSats: number; token: string; paymentId?: string }
          | null = null
        const engine: EngineClientLike = {
          async getParticipationScore() {
            calls.push('score')
            return scoreResponse({ balance: -1, matchDebitScore: 1 })
          },
          async payParticipationScoreEcash(amountSats, token, paymentId) {
            calls.push('pay-score')
            capturedPayment = { amountSats, token, paymentId }
            return {
              paymentId: paymentId ?? 'missing-payment-id',
              status: 'credited',
              amountSats,
              creditedScore: amountSats,
              creditedAt: '2026-06-09T00:00:00.000Z',
            }
          },
          async submitOrder(_marketId, request) {
            calls.push('submit')
            return {
              orderId: 'order-score',
              status: 'resting',
              remainingAmountSubunits: request.amountSubunits,
              ephemeralPubkey: request.ephemeralPubkey,
              fills: [],
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
              price: 42,
              amountSats: 100,
              timeInForce: 'GTC',
            },
          },
          {
            createEngineClient() {
              return engine
            },
            createCashuWallet() {
              return resumableSendWallet({
                onPrepare(amount, proofs) {
                  assert.equal(amount, 2)
                  assert.deepEqual(
                    proofs.map((proof) => proof.secret),
                    ['score-proof'],
                  )
                },
                onComplete() {
                  return {
                    send: [cashuProof(2, 'score-token-proof')],
                    keep: [cashuProof(6, 'score-change')],
                  }
                },
              })
            },
            generateEphemeralKeypair: () => ({
              privateKeyHex: '55'.repeat(32),
              publicKeyHex: `02${'55'.repeat(32)}`,
            }),
          },
        )

        assert.equal(response.ok, true)
        assert.deepEqual(calls, ['score', 'pay-score', 'submit'])
        assert.equal(capturedPayment?.amountSats, 2)
        assert.match(capturedPayment?.token ?? '', /^cashu/)
        assert.match(capturedPayment?.paymentId ?? '', /^[0-9a-f-]{36}$/)
        assert.match(
          (response.result as { participationScore: { operationId: string } })
            .participationScore.operationId,
          /^engine-score:/,
        )
        assert.equal(
          (response.result as { participationScore: { kind: string } })
            .participationScore.kind,
          'paid',
        )
        const updated = await readState()
        assert.equal(
          Object.values(updated?.proofOperations ?? {})[0]?.kind,
          'wallet-send',
        )
        assert.deepEqual(
          updated?.wallet.proofs.map((record) => record.proof.secret).sort(),
          ['score-change'],
        )
      } finally {
        if (priorState) await writeState(priorState)
      }
    })

    await t.test('order.submit rejects malformed order intent before side effects', async () => {
      const priorState = await readState()
      await writeState(emptyDaemonState())

      try {
        for (const params of [
          {
            marketId: 'cond-YES',
            outcomeId: 'YES',
            side: 'Buy',
            price: 0,
            amountSats: 100,
            timeInForce: 'GTC',
          },
          {
            marketId: 'cond-YES',
            outcomeId: 'YES',
            side: 'Buy',
            price: 42,
            amountSats: 50,
            timeInForce: 'GTC',
          },
          {
            marketId: 'cond-YES',
            outcomeId: 'YES',
            side: 'Buy',
            price: 42,
            amountSats: 100,
            timeInForce: 'IOC',
          },
          {
            marketId: 'cond-Bob|Carol',
            outcomeId: 'Bob',
            side: 'Buy',
            price: 42,
            amountSats: 100,
            timeInForce: 'GTC',
          },
          {
            marketId: 'cond-Bob',
            outcomeId: 'Bob|Carol',
            side: 'Buy',
            price: 42,
            amountSats: 100,
            timeInForce: 'GTC',
          },
          {
            marketId: 'cond-Bob',
            outcomeId: 'Carol',
            side: 'Buy',
            price: 42,
            amountSats: 100,
            timeInForce: 'GTC',
          },
        ]) {
          let generatedEphemeral = false
          let createdEngineClient = false
          let startedRuntime = false

          const response = await dispatch(
            {
              method: 'order.submit',
              params,
            } as never,
            {
              createEngineClient() {
                createdEngineClient = true
                throw new Error('createEngineClient unused')
              },
              generateEphemeralKeypair: () => {
                generatedEphemeral = true
                throw new Error('generateEphemeralKeypair unused')
              },
              tradeRuntime: {
                async start() {
                  startedRuntime = true
                  return { orders: [], trades: [] }
                },
                async stop() {},
              },
            },
          )

          assert.equal(response.ok, false)
          assert.match(response.error ?? '', /Order rejected:/)
          assert.equal(generatedEphemeral, false)
          assert.equal(createdEngineClient, false)
          assert.equal(startedRuntime, false)
          assert.deepEqual((await readState())?.orders, {})
        }
      } finally {
        if (priorState) await writeState(priorState)
      }
    })

    await t.test('trade.watch reads persisted swap state', async () => {
      const state = emptyDaemonState()
      state.swaps['trade-1'] = {
        tradeId: 'trade-1',
        marketId: 'cond-YES',
        orderId: 'order-1',
        fillAmountSubunits: 100,
        outcomeFaceAmountSubunits: 100,
        quotePaymentSubunits: 42,
        messages: {},
        step: 'awaiting-trade-created',
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
      await writeState(state)

      const response = await dispatch({
        method: 'trade.watch',
        params: { tradeId: 'trade-1' },
      })

      assert.equal(response.ok, true)
      assert.equal(
        (response.result as { tradeId?: string } | null)?.tradeId,
        'trade-1',
      )
    })

    await t.test('trade.list reads filtered local daemon swap state', async () => {
      const state = emptyDaemonState()
      state.swaps['trade-a'] = {
        tradeId: 'trade-a',
        marketId: 'cond-YES',
        orderId: 'order-a',
        messages: {},
        step: 'seller-opened',
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
      state.swaps['trade-b'] = {
        tradeId: 'trade-b',
        marketId: 'cond-NO',
        orderId: 'order-b',
        messages: {},
        step: 'confirmed',
        createdAt: '2026-05-21T00:00:01.000Z',
        updatedAt: '2026-05-21T00:00:02.000Z',
      }
      state.swaps['trade-c'] = {
        tradeId: 'trade-c',
        marketId: 'cond-YES',
        orderId: 'order-c',
        messages: {},
        step: 'buyer-responded',
        createdAt: '2026-05-21T00:00:03.000Z',
        updatedAt: '2026-05-21T00:00:03.000Z',
      }
      await writeState(state)

      const all = await dispatch({ method: 'trade.list', params: {} })
      assert.equal(all.ok, true)
      assert.deepEqual(
        (all.result as Array<{ tradeId: string }>).map((swap) => swap.tradeId),
        ['trade-c', 'trade-b', 'trade-a'],
      )

      const filtered = await dispatch({
        method: 'trade.list',
        params: { marketId: 'cond-YES', step: 'seller-opened' },
      })
      assert.equal(filtered.ok, true)
      assert.deepEqual(filtered.result, [state.swaps['trade-a']])
    })

    await t.test('trade.recover delegates active swap recovery to daemon executor', async () => {
      const state = emptyDaemonState()
      state.swaps['trade-recover'] = {
        tradeId: 'trade-recover',
        marketId: 'cond-YES',
        orderId: 'order-recover',
        messages: {},
        step: 'settling',
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
      await writeState(state)
      let runtimeStartSawTrade = false
      let executorSawTrade = false

      const response = await dispatch(
        { method: 'trade.recover' },
        {
          tradeRuntime: {
            async start(runtimeState) {
              runtimeStartSawTrade = !!runtimeState.swaps['trade-recover']
              return { orders: [], trades: [] }
            },
            async stop() {},
          },
          swapExecutor: {
            async resumeActiveSwaps(runtimeState) {
              executorSawTrade = !!runtimeState.swaps['trade-recover']
              return { activeSwaps: 1 }
            },
          },
        },
      )

      assert.deepEqual(response, {
        ok: true,
        result: { activeSwaps: 1 },
      })
      assert.equal(runtimeStartSawTrade, true)
      assert.equal(executorSawTrade, true)
    })

    await t.test('order.list reads filtered local daemon order state', async () => {
      const state = emptyDaemonState()
      state.orders['order-a'] = {
        orderId: 'order-a',
        marketId: 'cond-YES',
        status: 'resting',
        tradeIds: [],
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
      state.orders['order-b'] = {
        orderId: 'order-b',
        marketId: 'cond-NO',
        status: 'matched',
        tradeIds: ['trade-b'],
        createdAt: '2026-05-21T00:00:01.000Z',
        updatedAt: '2026-05-21T00:00:02.000Z',
      }
      state.orders['order-c'] = {
        orderId: 'order-c',
        marketId: 'cond-YES',
        status: 'cancelled',
        tradeIds: [],
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
          ephemeralPubkey: undefined,
          tradeIds: [],
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

    await t.test('order.submit remains successful when trade runtime start fails after persistence', async () => {
      await writeState(emptyDaemonState())
      const engine: EngineClientLike = {
        ...scoreDisabledEngineMethods,
        async submitOrder(_marketId, request) {
          return {
            orderId: 'order-runtime-fail',
            status: 'resting',
            remainingAmountSubunits: request.amountSubunits,
            ephemeralPubkey: request.ephemeralPubkey,
            fills: [],
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
            price: 42,
            amountSats: 100,
            timeInForce: 'GTC',
          },
        },
        {
          createEngineClient() {
            return engine
          },
          generateEphemeralKeypair: () => ({
            privateKeyHex: '33'.repeat(32),
            publicKeyHex: `02${'33'.repeat(32)}`,
          }),
          tradeRuntime: {
            async start() {
              throw new Error('TradeHub unavailable')
            },
            async stop() {},
          },
        },
      )

      assert.equal(response.ok, true)
      const state = await readState()
      assert.equal(state?.orders['order-runtime-fail']?.status, 'resting')
      const updatedSecrets = await readSecrets()
      assert.equal(
        updatedSecrets?.orderEphemeralKeys['order-runtime-fail']?.privateKeyHex,
        '33'.repeat(32),
      )
    })

    await t.test('order.submit accepts direct sell flow after same-outcome CTF swaps are supported', async () => {
      await writeState(emptyDaemonState())
      let capturedRequest: unknown = null

      const response = await dispatch(
        {
          method: 'order.submit',
          params: {
            marketId: 'cond-YES',
            outcomeId: 'YES',
            side: 'Sell',
            price: 42,
            amountSats: 100,
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
                  remainingAmountSubunits: request.amountSubunits,
                  ephemeralPubkey: request.ephemeralPubkey,
                  fills: [],
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
          generateEphemeralKeypair: () => ({
            privateKeyHex: '44'.repeat(32),
            publicKeyHex: `02${'44'.repeat(32)}`,
          }),
          tradeRuntime: {
            async start() {
              return { orders: [], trades: [] }
            },
            async stop() {},
          },
        },
      )

      assert.equal(response.ok, true)
      assert.deepEqual(capturedRequest, {
        outcomeId: 'YES',
        tokenSide: 'Outcome',
        side: 'Sell',
        price: 42,
        amountSubunits: 100,
        timeInForce: 'GTC',
        ephemeralPubkey: `02${'44'.repeat(32)}`,
      })
      assert.equal((await readState())?.orders['order-direct-sell']?.status, 'resting')
      assert.equal(
        (await readSecrets())?.orderEphemeralKeys['order-direct-sell']?.privateKeyHex,
        '44'.repeat(32),
      )
    })

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

function proofRecord(
  mintUrl: string,
  amount: number,
  state: DaemonState['wallet']['proofs'][number]['state'],
  asset: DaemonState['wallet']['proofs'][number]['asset'],
  secret = `secret-${amount}`,
): DaemonState['wallet']['proofs'][number] {
  return {
    mintUrl,
    state,
    asset,
    proof: {
      id: `keyset-${amount}`,
      amount,
      secret,
      C: `c-${amount}`,
    },
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  }
}

const scoreDisabledEngineMethods = {
  async getParticipationScore() {
    return scoreResponse({ enabled: false })
  },
  async payParticipationScoreEcash() {
    throw new Error('payParticipationScoreEcash unused')
  },
} satisfies Pick<
  EngineClientLike,
  'getParticipationScore' | 'payParticipationScoreEcash'
>

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
    id: '009a1f293253e41e',
    amount,
    secret,
    C: `02${'11'.repeat(32)}`,
  }
}

function concurrentSendWallet(selectedSecrets: string[]) {
  return () => ({
    async loadMint() {},
    async receive() {
      throw new Error('receive unused')
    },
    async send(amount: number, proofs: Proof[]) {
      throw new Error(`send unused ${amount} ${proofs.length}`)
    },
    async prepareSwapToSend(amount: number, proofs: Proof[]) {
      assert.equal(amount, 5)
      assert.equal(proofs.length, 1)
      selectedSecrets.push(proofs[0].secret)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        amount,
        fees: 0,
        keysetId: proofs[0].id,
        inputs: proofs,
        sendOutputs: [preparedOutput(`send-${proofs[0].secret}`)],
        keepOutputs: [preparedOutput(`keep-${proofs[0].secret}`)],
        unselectedProofs: [],
      }
    },
    async completeSwap(preview: { inputs: Proof[] }) {
      const secret = preview.inputs[0].secret
      return {
        send: [cashuProof(5, `sent-${secret}`)],
        keep: [cashuProof(3, `change-${secret}`)],
      }
    },
  })
}

function resumableSendWallet(options: {
  proofState?: string
  onPrepare?: (amount: number, proofs: Proof[]) => void
  onComplete?: () => { send: Proof[]; keep: Proof[] }
}) {
  return {
    async loadMint() {},
    async receive() {
      throw new Error('receive unused')
    },
    async send() {
      throw new Error('send unused')
    },
    async prepareSwapToSend(amount: number, proofs: Proof[]) {
      options.onPrepare?.(amount, proofs)
      return {
        amount,
        fees: 0,
        keysetId: proofs[0].id,
        inputs: proofs,
        sendOutputs: [preparedOutput('send-output')],
        keepOutputs: [preparedOutput('keep-output')],
        unselectedProofs: [],
      }
    },
    async completeSwap() {
      return options.onComplete?.() ?? {
        send: [cashuProof(5, 'sent-default')],
        keep: [cashuProof(3, 'change-default')],
      }
    },
    async checkProofsStates(proofs: Array<Pick<Proof, 'secret'>>) {
      return proofs.map((proof) => ({
        Y: proof.secret,
        state: options.proofState ?? 'UNSPENT',
        witness: null,
      }))
    },
  }
}

function preparedOutput(secret: string) {
  return {
    blindedMessage: {
      amount: 5,
      id: '009a1f293253e41e',
      B_: `blinded-${secret}`,
    },
    blindingFactor: 1n,
    secret: new Uint8Array([secret.length]),
  }
}
