import assert from 'node:assert/strict'
import { createECDH, createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getEncodedToken, type MintKeys, type Proof } from '@cashu/cashu-ts'
import { EngineClientError } from '@bitcaster-market/client-sdk/engineClient'
import type {
  CtfProofOperationRecord,
  CtfProofOperationStore,
} from '@bitcaster-market/client-sdk/ctfSplit'
import {
  daemonWalletCustodyScope,
  DaemonDurableCustodyLease,
} from '../src/durableCustodyLifecycle.ts'
import { SqliteDurableCustodyStore } from '../src/durableCustodySqliteStore.ts'
import { DaemonProofOperationCoordinator } from '../src/durableProofOperationCoordinator.ts'
import {
  DaemonOrderCollateralCoordinator,
  installDaemonOrderCollateralCoordinator,
} from '../src/durableOrderCollateralCoordinator.ts'
import {
  setDaemonCustodyUnitOfWorkFaultHookForTest,
} from '../src/durableCustodyUnitOfWork.ts'
import { dispatch, type EngineClientLike } from '../src/server.ts'
import {
  profileFromPublicKey,
  readProfile,
  writeProfile,
} from '../src/profile.ts'
import {
  createDaemonSecrets,
  readSecrets,
  writeSecrets,
} from '../src/secrets.ts'
import {
  emptyDaemonState,
  installDaemonProofOperationCoordinator,
  readState,
  writeState,
  type DaemonState,
} from '../src/state.ts'
import {
  recoverPreparedWalletSends,
  splitAvailableSatProofsForCtfCollateral,
} from '../src/walletOps.ts'
import { writeStateWithDurableSessionKeys } from './durableSessionTestStore.ts'

test('daemon dispatch persists wallet, order, and swap state', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-test-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  let lease: DaemonDurableCustodyLease | undefined
  let uninstallCoordinator: (() => void) | undefined
  let uninstallOrderCollateral: (() => void) | undefined
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    profile.mintUrl = 'https://mint-a.example'
    await writeProfile(profile)
    await writeSecrets(secrets)
    const custodyStore = new SqliteDurableCustodyStore()
    await custodyStore.registerScope(
      daemonWalletCustodyScope(secrets.walletSeedHex),
    )
    lease = await DaemonDurableCustodyLease.claim({
      store: custodyStore,
      walletSeedHex: secrets.walletSeedHex,
    })
    uninstallCoordinator = installDaemonProofOperationCoordinator(
      new DaemonProofOperationCoordinator({
        authority: lease,
        resolveMintKeys: async (_mintUrl, keysetIds) => new Map(
          keysetIds.map((keysetId) => [keysetId, fakeMintKeys(keysetId)]),
        ),
      }),
    )
    uninstallOrderCollateral = installDaemonOrderCollateralCoordinator(
      new DaemonOrderCollateralCoordinator(lease),
    )

    await t.test('wallet.balance summarizes durable proof state', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord('https://mint-a.example', 100, 'available', {
          kind: 'sats',
        }),
        proofRecord('https://mint-a.example', 50, 'reserved', { kind: 'sats' }),
        proofRecord('https://mint-a.example', 999, 'available', {
          kind: 'sats',
          baseAsset: 'usd',
        }),
        proofRecord('https://mint-a.example', 25, 'locked', {
          kind: 'Outcome',
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
            mintUrl: 'https://mint-a.example',
            availableSats: 100,
            reservedSats: 50,
            lockedSats: 25,
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
    })

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
              splitAvailableSatProofsForCtfCollateral({
                amountSats: 1_000,
                mintUrl: 'https://mint-a.example',
                operationId: 'preflight-msat-unit',
                secrets,
                deps: {
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
                baseAsset: 'sat',
              }),
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

    await t.test(
      'collateral selection fails closed when its durable pin write fails',
      async () => {
        const priorState = await readState()
        const state = emptyDaemonState()
        state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            100,
            'available',
            { kind: 'sats', baseAsset: 'sat' },
            'pin-write-input',
          ),
        )
        await writeState(state)
        let fallbackSelections = 0
        try {
          await assert.rejects(
            splitAvailableSatProofsForCtfCollateral({
              amountSats: 100,
              mintUrl: 'https://mint-a.example',
              operationId: 'pin-write-failure',
              secrets,
              deps: {
                createCashuWallet() {
                  return unusedWallet()
                },
                resolveInputFeePpkByKeyset: zeroInputFees,
                async selectCollateralForCtfSplit() {
                  fallbackSelections += 1
                  throw new Error('fallback selection must not run')
                },
              },
              baseAsset: 'sat',
              async beforeCollateralUse() {
                throw new Error('durable pin write failed')
              },
            }),
            /durable pin write failed/,
          )
          assert.equal(fallbackSelections, 0)
        } finally {
          await writeState(priorState ?? emptyDaemonState())
        }
      },
    )

    await t.test(
      'completed collateral split resumes its persisted msat amount without current mint planning',
      async () => {
        const persisted: CtfProofOperationRecord = {
          operationId: 'persisted-msat-collateral',
          kind: 'regular-split',
          state: 'completed',
          mintUrl: 'https://mint-a.example',
          inputs: [cashuProof(101, 'input')],
          outputs: { send: [], keep: [] },
          metadata: {
            amount: 100,
            baseAsset: 'sat',
            unit: 'msat',
            unselectedProofs: [],
          },
          resultProofs: {
            send: [cashuProof(100, 'send')],
            keep: [cashuProof(1, 'keep')],
          },
          createdAt: 1,
          updatedAt: 2,
        }
        const store: CtfProofOperationStore = {
          async getProofOperation() {
            return structuredClone(persisted)
          },
          async prepareProofOperation() {
            throw new Error('completed recovery must not prepare')
          },
          async markProofOperationMintSubmitted() {
            throw new Error('completed recovery must not submit')
          },
          async markProofOperationCompleted() {
            throw new Error('completed recovery must not complete again')
          },
        }
        const requestedUnits: Array<string | null | undefined> = []
        let loadMintCalls = 0

        const result = await splitAvailableSatProofsForCtfCollateral({
          amountSats: 100,
          mintUrl: 'https://mint-a.example',
          operationId: persisted.operationId,
          secrets,
          proofOperationStore: store,
          deps: {
            createCashuWallet(_mintUrl, unit) {
              requestedUnits.push(unit)
              return {
                ...unusedWallet(),
                async loadMint() {
                  loadMintCalls += 1
                },
              }
            },
            async resolveInputFeePpkByKeyset() {
              return { '009a1f293253e41e': 0 }
            },
          },
          baseAsset: 'sat',
        })

        assert.deepEqual(requestedUnits, [])
        assert.equal(loadMintCalls, 0)
        assert.deepEqual(result.inputs, [cashuProof(100, 'send')])
        assert.deepEqual(result.spent, [cashuProof(101, 'input')])
      },
    )

    await t.test(
      'daemon.status returns redacted profile and state summary',
      async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            10,
            'available',
            { kind: 'sats' },
            'status-secret',
          ),
      )
      state.proofOperations['op-status'] = {
        operationId: 'op-status',
        kind: 'wallet-send',
        state: 'prepared',
          mintUrl: 'https://mint-a.example',
          inputs: [
            { amount: 10, secret: 'operation-input-secret', C: 'C-status' },
          ],
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
      },
    )

    await t.test(
      'daemon state serializes native CTF proof operation amounts as numbers',
      async () => {
      const state = emptyDaemonState()
      state.proofOperations['ctf-native-op'] = {
        operationId: 'ctf-native-op',
        kind: 'conditional-keyset-swap',
        state: 'completed',
          mintUrl: 'https://mint-a.example',
        inputs: [
            {
              id: 'ctf-keyset',
              amount: 136n as never,
              secret: 'ctf-input',
              C: 'C-in',
            },
        ],
        outputs: {
          lock: [
            {
                blindedMessage: {
                  amount: 100n as never,
                  id: 'ctf-keyset',
                  B_: 'B-lock',
                },
              blindingFactor: '01',
              secret: '02',
            },
          ],
        },
        metadata: { fees: 0n },
        resultProofs: {
          lock: [
              {
                id: 'ctf-keyset',
                amount: 100n as never,
                secret: 'ctf-lock',
                C: 'C-out',
              },
          ],
        },
        createdAt: 1,
        updatedAt: 2,
      }

      await writeState(state)
      const restored = await readState()

        assert.equal(
          restored?.proofOperations['ctf-native-op']?.kind,
          'conditional-keyset-swap',
        )
        assert.equal(
          restored?.proofOperations['ctf-native-op']?.inputs[0].amount,
          136,
        )
        assert.equal(
          restored?.proofOperations['ctf-native-op']?.outputs.lock[0]
            .blindedMessage.amount,
          100,
        )
        assert.equal(
          restored?.proofOperations['ctf-native-op']?.resultProofs?.lock[0]
            .amount,
          100,
        )
      },
    )

    await t.test(
      'daemon.config updates engine and mint URLs without replacing identity',
      async () => {
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
      },
    )

    await t.test(
      'daemon.config refuses endpoint changes after durable state exists',
      async () => {
      for (const buildState of [
        () => {
          const state = emptyDaemonState()
          state.wallet.proofs.push(
              proofRecord(
                'https://mint-a.example',
                1,
                'available',
                { kind: 'sats' },
                'config-proof',
              ),
          )
          return state
        },
        () => {
          const state = emptyDaemonState()
          state.proofOperations['config-op'] = {
            operationId: 'config-op',
            kind: 'wallet-send',
            state: 'prepared',
              mintUrl: 'https://mint-a.example',
              inputs: [
                { amount: 1, secret: 'config-op-secret', C: 'C-config' },
              ],
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
          () => {
            const state = emptyDaemonState()
            state.durableTradeSessions['config-session'] = {
              schemaVersion: 2,
              revision: 0,
              tradeId: 'config-session',
              role: 'seller',
              localProtocolPubkey: 'a'.repeat(64),
              counterpartyProtocolPubkey: 'b'.repeat(64),
              mintUrl: 'https://mint-a.example',
              sellerLocktimeSecs: 120,
              buyerLocktimeSecs: 100,
              ephemeralKeyHandle: {
                keyId: 'config-session-key',
                tradeId: 'config-session',
                role: 'seller',
                localProtocolPubkey: 'a'.repeat(64),
                counterpartyProtocolPubkey: 'b'.repeat(64),
                mintUrl: 'https://mint-a.example',
                sellerLocktimeSecs: 120,
                buyerLocktimeSecs: 100,
              },
              stage: 'intent',
              proofOperations: [],
              receivedCiphers: {},
              outboundCiphers: {},
            }
            return state
          },
      ]) {
          await writeStateWithDurableSessionKeys(buildState())
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
      },
    )

    await t.test(
      'daemon.config allows no-op endpoint updates with durable state',
      async () => {
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
      },
    )

    await t.test(
      'wallet.receive redeems token proofs into daemon state',
      async () => {
      await writeState(emptyDaemonState())
      const token = getEncodedToken({
          mint: 'https://mint-a.example',
        unit: 'sat',
        proofs: [cashuProof(7, 'token-secret')],
      })
      const response = await dispatch(
        { method: 'wallet.receive', params: { token } },
        {
          createCashuWallet(mintUrl) {
              assert.equal(mintUrl, 'https://mint-a.example')
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
          mintUrl: 'https://mint-a.example',
        amountSats: 7,
        proofCount: 1,
        asset: { kind: 'sats', baseAsset: 'sat' },
      })
      const state = await readState()
      assert.equal(state?.wallet.proofs[0]?.proof.secret, 'fresh-secret')
      assert.equal(state?.wallet.proofs[0]?.state, 'available')
        assert.deepEqual(state?.wallet.proofs[0]?.asset, {
          kind: 'sats',
          baseAsset: 'sat',
    })
      },
    )

    await t.test(
      'wallet.receive can classify imported proofs as outcome tokens',
      async () => {
      await writeState(emptyDaemonState())
      const token = getEncodedToken({
          mint: 'https://mint-a.example',
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
              assert.equal(mintUrl, 'https://mint-a.example')
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
          mintUrl: 'https://mint-a.example',
        amountSats: 11,
        proofCount: 1,
        asset: {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'YES',
          baseAsset: 'sat',
        },
      })
      const state = await readState()
      assert.deepEqual(state?.wallet.proofs[0]?.asset, {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
        baseAsset: 'sat',
      })
        assert.equal(
          state?.wallet.proofs[0]?.proof.secret,
          'outcome-token-secret',
        )
      },
    )

    await t.test(
      'wallet.receive rejects spent outcome-token proofs before persistence',
      async () => {
      await writeState(emptyDaemonState())
      const token = getEncodedToken({
          mint: 'https://mint-a.example',
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
      },
    )

    await t.test(
      'wallet.receive rejects partial outcome metadata',
      async () => {
      const token = getEncodedToken({
          mint: 'https://mint-a.example',
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
      },
    )

    await t.test(
      'wallet.receive rejects tokens for unexpected mints',
      async () => {
      const token = getEncodedToken({
        mint: 'http://unexpected-mint.local',
        unit: 'sat',
        proofs: [cashuProof(7, 'unexpected-mint-secret')],
      })

      await assert.rejects(
        () => dispatch({ method: 'wallet.receive', params: { token } }),
        /mint does not match daemon profile mint/,
      )
      },
    )

    await t.test(
      'wallet.send spends stored proofs and returns an encoded token',
      async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            8,
            'available',
            { kind: 'sats' },
            'spend-secret-a',
          ),
          proofRecord(
            'https://mint-a.example',
            4,
            'available',
            { kind: 'sats' },
            'spend-secret-b',
          ),
      )
      await writeState(state)
      const response = await dispatch(
          {
            method: 'wallet.send',
            params: { amountSats: 5, mintUrl: 'https://mint-a.example' },
          },
        {
          createCashuWallet(mintUrl) {
              assert.equal(mintUrl, 'https://mint-a.example')
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
      },
    )

    await t.test(
      'concurrent wallet.send calls reserve distinct proofs',
      async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            8,
            'available',
            { kind: 'sats' },
            'send-a',
          ),
          proofRecord(
            'https://mint-a.example',
            8,
            'available',
            { kind: 'sats' },
            'send-b',
          ),
      )
      await writeState(state)
      const selectedSecrets: string[] = []

      const responses = await Promise.all([
        dispatch(
            {
              method: 'wallet.send',
              params: { amountSats: 5, mintUrl: 'https://mint-a.example' },
            },
          { createCashuWallet: concurrentSendWallet(selectedSecrets) },
        ),
        dispatch(
            {
              method: 'wallet.send',
              params: { amountSats: 5, mintUrl: 'https://mint-a.example' },
            },
          { createCashuWallet: concurrentSendWallet(selectedSecrets) },
        ),
      ])

        assert.deepEqual(
          responses.map((response) => response.ok),
          [true, true],
        )
      assert.deepEqual(selectedSecrets.sort(), ['send-a', 'send-b'])
      const updated = await readState()
      assert.deepEqual(
        updated?.wallet.proofs.map((record) => record.proof.secret).sort(),
        ['change-send-a', 'change-send-b'],
      )
      },
    )

    await t.test(
      'wallet.send leaves proofs available when preparation fails before reservation',
      async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            8,
            'available',
            { kind: 'sats' },
            'send-fail',
          ),
      )
      await writeState(state)

      await assert.rejects(
        () =>
          dispatch(
              {
                method: 'wallet.send',
                params: { amountSats: 5, mintUrl: 'https://mint-a.example' },
              },
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
      },
    )

    await t.test(
      'wallet.send with operation id is idempotent after completion',
      async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            8,
            'available',
            { kind: 'sats' },
            'send-op',
          ),
      )
      await writeState(state)
      let prepared = 0
      let completed = 0

      const first = await dispatch(
        {
          method: 'wallet.send',
          params: {
            amountSats: 5,
              mintUrl: 'https://mint-a.example',
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
              mintUrl: 'https://mint-a.example',
            operationId: 'wallet-send-op-1',
          },
        },
        {
          createCashuWallet() {
            return resumableSendWallet({
              onPrepare: () => {
                  throw new Error(
                    'prepare should not run for completed operation',
                  )
              },
              onComplete: () => {
                  throw new Error(
                    'complete should not run for completed operation',
                  )
              },
            })
          },
        },
      )

      assert.equal(first.ok, true)
      assert.equal(second.ok, true)
        assert.equal(
          (first.result as { token: string }).token,
          (second.result as { token: string }).token,
        )
      assert.equal(prepared, 1)
      assert.equal(completed, 1)
      const updated = await readState()
        assert.equal(
          updated?.proofOperations['wallet-send-op-1']?.state,
          'completed',
        )
      assert.deepEqual(
        updated?.wallet.proofs.map((record) => record.proof.secret),
        ['change-op'],
      )
      },
    )

    await t.test(
      'wallet.send with operation id restores spent prepared outputs',
      async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            8,
            'available',
            { kind: 'sats' },
            'send-restore',
          ),
      )
      await writeState(state)

      await assert.rejects(
        () =>
          dispatch(
            {
              method: 'wallet.send',
              params: {
                amountSats: 5,
                  mintUrl: 'https://mint-a.example',
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
              mintUrl: 'https://mint-a.example',
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
                  throw new Error(
                    'complete should not run when inputs are spent',
                  )
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
        assert.equal(
          updated?.proofOperations['wallet-send-restore']?.state,
          'completed',
        )
      assert.deepEqual(
        updated?.wallet.proofs.map((record) => record.proof.secret),
        ['restored-keep'],
      )
      },
    )

    await t.test(
      'wallet recovery sweep completes spent prepared sends',
      async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            8,
            'available',
            { kind: 'sats' },
            'recover-spent',
          ),
      )
      await writeState(state)

      await assert.rejects(
        () =>
          dispatch(
            {
              method: 'wallet.send',
              params: {
                amountSats: 5,
                  mintUrl: 'https://mint-a.example',
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
        recoveredCount: 1,
        pendingCount: 0,
        recovered: ['wallet-send-recover-spent'],
        pending: [],
        summaryTruncated: false,
      })
      const updated = await readState()
        assert.equal(
          updated?.proofOperations['wallet-send-recover-spent']?.state,
          'completed',
        )
      assert.deepEqual(
        updated?.wallet.proofs.map((record) => record.proof.secret),
        ['sweep-keep'],
      )
      },
    )

    await t.test(
      'wallet send result and proof reconciliation share one crash boundary',
      async () => {
        for (const faultStage of ['before-commit', 'after-commit'] as const) {
          const operationId = `wallet-send-atomic-${faultStage}`
          const inputSecret = `atomic-input-${faultStage}`
          const keepSecret = `atomic-keep-${faultStage}`
          const state = emptyDaemonState()
          state.wallet.proofs.push(
            proofRecord(
              'https://mint-a.example',
              8,
              'available',
              { kind: 'sats' },
              inputSecret,
            ),
          )
          await writeState(state)

          let faultArmed = false
          try {
            await assert.rejects(
              () =>
                dispatch(
                  {
                    method: 'wallet.send',
                    params: {
                      amountSats: 5,
                      mintUrl: 'https://mint-a.example',
                      operationId,
                    },
                  },
                  {
                    createCashuWallet() {
                      return resumableSendWallet({
                        onComplete: () => {
                          faultArmed = true
                          setDaemonCustodyUnitOfWorkFaultHookForTest((observed) => {
                            if (observed !== faultStage) return
                            setDaemonCustodyUnitOfWorkFaultHookForTest(undefined)
                            throw new Error(
                              `simulated ${faultStage} wallet finalization fault`,
                            )
    })
                          return {
                            send: [cashuProof(5, `atomic-send-${faultStage}`)],
                            keep: [cashuProof(3, keepSecret)],
                          }
                        },
                      })
                    },
                  },
                ),
              new RegExp(`simulated ${faultStage} wallet finalization fault`),
            )
          } finally {
            setDaemonCustodyUnitOfWorkFaultHookForTest(undefined)
          }
          assert.equal(faultArmed, true)

          const interrupted = await readState()
          assert.ok(interrupted)
          const interruptedOperation = interrupted.proofOperations[operationId]
          if (faultStage === 'before-commit') {
            assert.equal(interruptedOperation?.state, 'mint-submitted')
            assert.equal(
              interrupted.wallet.proofs.some(
                (proof) =>
                  proof.proof.secret === inputSecret &&
                  proof.state === 'reserved',
              ),
              true,
            )

            const recovery = await recoverPreparedWalletSends(secrets, {
              createCashuWallet() {
                return resumableSendWallet({ proofState: 'SPENT' })
              },
              async restoreOutputGroups() {
                return {
                  send: [cashuProof(5, `atomic-send-${faultStage}`)],
                  keep: [cashuProof(3, keepSecret)],
                }
              },
            })
            assert.deepEqual(recovery, {
              recoveredCount: 1,
              pendingCount: 0,
              recovered: [operationId],
              pending: [],
              summaryTruncated: false,
            })
          }

          const finalized = await readState()
          assert.ok(finalized)
          assert.equal(
            finalized.proofOperations[operationId]?.state,
            'completed',
          )
          assert.equal(
            finalized.wallet.proofs.some((proof) => proof.state === 'reserved'),
            false,
          )
          assert.deepEqual(
            finalized.wallet.proofs.map((proof) => proof.proof.secret),
            [keepSecret],
          )
        }
      },
    )

    await t.test(
      'wallet recovery sweep reports mint-pending sends without throwing',
      async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            8,
            'available',
            { kind: 'sats' },
            'recover-pending',
          ),
      )
      await writeState(state)

      await assert.rejects(
        () =>
          dispatch(
            {
              method: 'wallet.send',
              params: {
                amountSats: 5,
                  mintUrl: 'https://mint-a.example',
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
      assert.equal(recovery.pending[0].reason, 'mint-response-unknown')
      const updated = await readState()
        assert.equal(
          updated?.proofOperations['wallet-send-recover-pending']?.state,
          'mint-submitted',
        )
      assert.equal(updated?.wallet.proofs[0]?.state, 'reserved')
      assert.equal(
        updated?.wallet.proofs[0]?.reservedBy,
        'wallet-send:wallet-send-recover-pending',
      )
      const cleanup = await recoverPreparedWalletSends(secrets, {
        createCashuWallet: () => resumableSendWallet({
          proofState: 'SPENT',
          onComplete: () => {
            throw new Error('complete should not run during cleanup restore')
          },
        }),
        async restoreOutputGroups() {
          return {
            send: [cashuProof(5, 'pending-cleanup-send')],
            keep: [cashuProof(3, 'pending-cleanup-keep')],
          }
        },
      })
      assert.equal(cleanup.recoveredCount, 1)
      },
    )

    await t.test(
      'wallet.recover delegates manual recovery to wallet operations',
      async () => {
      await writeState(emptyDaemonState())

      const response = await dispatch({ method: 'wallet.recover' })

      assert.deepEqual(response, {
        ok: true,
        result: {
          recoveredCount: 0,
          pendingCount: 0,
          recovered: [],
          pending: [],
          summaryTruncated: false,
        },
      })
      },
    )

    await t.test(
      'wallet.seed-recover requires disclosure acknowledgement and uses stored seed',
      async () => {
        const rejected = await dispatch({
          method: 'wallet.seed-recover',
          params: { acknowledgeHistoryDisclosure: false as never },
        })
        assert.equal(rejected.ok, false)
        assert.match(rejected.error ?? '', /history-disclosure/)

        let receivedStoredSeed = false
        const response = await dispatch(
          {
            method: 'wallet.seed-recover',
            params: {
              acknowledgeHistoryDisclosure: true,
              unit: 'sat',
            },
          },
          {
            async recoverWalletFromSeed(input) {
              receivedStoredSeed = input.walletSeedHex.length === 64
                && input.walletSeedHex === secrets.walletSeedHex
              return {
                recoveryId: 'recovery-rpc',
                state: 'completed',
                completedKeysets: 1,
                totalKeysets: 1,
                batchesProcessed: 2,
                importedProofs: 1,
                ignoredSpentProofs: 0,
                pendingProofs: 0,
              }
            },
          },
        )

        assert.equal(receivedStoredSeed, true)
        assert.deepEqual(response, {
          ok: true,
          result: {
            recoveryId: 'recovery-rpc',
            state: 'completed',
            completedKeysets: 1,
            totalKeysets: 1,
            batchesProcessed: 2,
            importedProofs: 1,
            ignoredSpentProofs: 0,
            pendingProofs: 0,
          },
        })
      },
    )

    await t.test(
      'wallet.operations lists redacted proof operation summaries',
      async () => {
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
              blindedMessage: { amount: 5, id: 'keyset-a', B_: 'B-a' },
              blindingFactor: 'blind-secret-a',
              secret: 'output-secret-a',
            },
          ],
          keep: [],
        },
        metadata: { note: 'not returned' },
        lastError: 'upstream leaked secret',
        createdAt: 10,
        updatedAt: 20,
      }
      state.proofOperations['op-b'] = {
        operationId: 'op-b',
        kind: 'ctf-split',
        state: 'completed',
          mintUrl: 'https://mint-b.example',
        inputs: [{ amount: 8, secret: 'input-secret-c', C: 'C-c' }],
          outputs: {
            YES: [
              {
                blindedMessage: { amount: 8, id: 'keyset-b', B_: 'B-b' },
                blindingFactor: 'blind-b',
                secret: 'output-b',
              },
            ],
          },
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
        (all.result as { items: Array<{ operationId: string }> }).items.map(
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
      assert.deepEqual(filtered.result, {
        items: [{
          operationId: 'op-a',
          kind: 'wallet-send',
          state: 'prepared',
            mintUrl: 'https://mint-a.example',
          inputAmountSats: 5,
          inputCount: 2,
          outputCounts: { send: 1, keep: 0 },
          resultProofCounts: {},
          createdAt: 10,
          updatedAt: 20,
        }],
        nextCursor: null,
      })
      },
    )

    await t.test(
      'order.submit uses clientOrderId and submits pubkey only for pending matches',
      async () => {
      await writeState(backedDaemonState('cond', 10_000, 'matched'))
        let capturedOptions: {
          baseUrl: string
          nostrSecretKeyHex: string
        } | null = null
      let capturedRequest: unknown = null
      const submittedPubkeys: Array<{ tradeId: string; pubkey: string }> = []
      let runtimeStartOrderIds: string[] = []
      const engine: EngineClientLike = {
        ...scoreDisabledEngineMethods,
        async submitOrder(_marketId, request) {
          capturedRequest = request
          return {
            orderId: 'order-1',
            status: 'matched',
            remainingAmountSubunits: 0,
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
            pendingPubkeySubmissions: [
              {
                tradeId: 'trade-1',
                role: 'taker',
                fillAmountSubunits: request.amountSubunits,
                deadline: '2026-05-21T00:01:00.000Z',
              },
            ],
          }
        },
        async submitEphemeralPubkey(tradeId, pubkey, conditionId) {
          submittedPubkeys.push({ tradeId, pubkey, conditionId })
          return { tradeId, role: 'taker', bothReceived: false }
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
          resolveInputFeePpkByKeyset: zeroInputFees,
          createEngineClient(options) {
            capturedOptions = options
            return engine
          },
            generateEphemeralKeypair: () =>
              testEphemeralKeypair('11'.repeat(32)),
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
          clientOrderId: (capturedRequest as { clientOrderId?: unknown })
            .clientOrderId,
      })
      assert.match(
        (capturedRequest as { clientOrderId: string }).clientOrderId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
      assert.deepEqual(submittedPubkeys, [
        {
          tradeId: 'trade-1',
          pubkey: testEphemeralKeypair('11'.repeat(32)).publicKeyHex,
          conditionId: 'cond',
        },
      ])

      const state = await readState()
      assert.equal(
        state?.orders['order-1']?.clientOrderId,
        (capturedRequest as { clientOrderId: string }).clientOrderId,
      )
      assert.equal(state?.swaps['trade-1']?.step, 'awaiting-trade-created')
      assert.deepEqual(runtimeStartOrderIds, ['order-1'])

      const updatedSecrets = await readSecrets()
      assert.deepEqual(updatedSecrets?.orderEphemeralKeys['trade-1'], {
        orderId: 'order-1',
        tradeId: 'trade-1',
        marketId: 'cond-YES',
        privateKeyHex: '11'.repeat(32),
        publicKeyHex: testEphemeralKeypair('11'.repeat(32)).publicKeyHex,
        createdAt: updatedSecrets.orderEphemeralKeys['trade-1'].createdAt,
      })
      },
    )

    await t.test(
      'order.submit validates D=1000 prices using engine market metadata',
      async () => {
      await writeState(backedDaemonState('cond', 10_000, 'd1000'))
      let capturedRequest: unknown = null
      const engine: EngineClientLike = {
        ...scoreDisabledEngineMethods,
        async submitOrder(_marketId, request) {
          capturedRequest = request
          return {
            orderId: 'order-d1000',
            status: 'resting',
            remainingAmountSubunits: request.amountSubunits,
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
            return {
              conditionId: 'cond',
              baseAsset: 'sat',
              divisibility: 1_000,
            }
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
          resolveInputFeePpkByKeyset: zeroInputFees,
          createEngineClient() {
            return engine
          },
            generateEphemeralKeypair: () =>
              testEphemeralKeypair('55'.repeat(32)),
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
          clientOrderId: (capturedRequest as { clientOrderId?: unknown })
            .clientOrderId,
      })
      assert.match(
        (capturedRequest as { clientOrderId: string }).clientOrderId,
        /^[0-9a-f-]{36}$/i,
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
            return {
              conditionId: 'cond',
              baseAsset: 'sat',
              divisibility: 1_000,
            }
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
            amountSubunits: 2_000,
            timeInForce: 'GTC',
          },
        },
        {
          resolveInputFeePpkByKeyset: zeroInputFees,
          createEngineClient: () => engine,
        },
      )

      assert.equal(response.ok, false)
        assert.equal(
          response.error,
          'insufficient backing: have 0 base subunits, need 1000',
        )
      assert.equal(submitCalls, 0)
      assert.deepEqual((await readState())?.orders, {})
      // Bypass invariant: this client gate is UX-only. If bypassed, the engine
      // and Cashu/mint settlement path remain authoritative and must reject or
      // fail unbacked orders without spending proofs.
      },
    )

    await t.test(
      'order.submit allows POST when local buy collateral is sufficient',
      async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            1_000,
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
      const engine: EngineClientLike = {
        ...scoreDisabledEngineMethods,
        async submitOrder(_marketId, request) {
          capturedRequest = request
          return {
            orderId: 'order-backed',
            status: 'resting',
            remainingAmountSubunits: request.amountSubunits,
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
            return {
              conditionId: 'cond',
              baseAsset: 'sat',
              divisibility: 1_000,
            }
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
            amountSubunits: 2_000,
            timeInForce: 'GTC',
          },
        },
        {
          resolveInputFeePpkByKeyset: zeroInputFees,
          createEngineClient: () => engine,
            generateEphemeralKeypair: () =>
              testEphemeralKeypair('77'.repeat(32)),
        },
      )

      assert.equal(response.ok, true)
        assert.equal(
          (capturedRequest as { amountSubunits?: number }).amountSubunits,
          2_000,
        )
        assert.equal(
          (await readState())?.orders['order-backed']?.orderId,
          'order-backed',
        )
      },
    )

    await t.test(
      'order.submit starts runtime with complement order subscription state',
      async () => {
      const priorState = await readState()
      await writeState(backedDaemonState('cond', 10_000, 'complement'))
      try {
        const engine: EngineClientLike = {
          ...scoreDisabledEngineMethods,
          async submitOrder(_marketId, request) {
            return {
              orderId: 'order-complement',
              status: 'resting',
              remainingAmountSubunits: request.amountSubunits,
              fills: [],
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
            resolveInputFeePpkByKeyset: zeroInputFees,
            createEngineClient() {
              return engine
            },
              generateEphemeralKeypair: () =>
                testEphemeralKeypair('33'.repeat(32)),
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
      },
    )

    await t.test(
      'order.submit propagates engine machine-code rejections',
      async () => {
      const priorState = await readState()
      await writeState(backedDaemonState('cond', 10_000, 'rejected'))
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
          resolveInputFeePpkByKeyset: zeroInputFees,
          createEngineClient() {
            return engine
          },
            generateEphemeralKeypair: () =>
              testEphemeralKeypair('11'.repeat(32)),
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
      },
    )

    await t.test(
      'order.submit pays missing Participation Score from wallet sats before submitting',
      async () => {
      const priorState = await readState()
      const state = emptyDaemonState()
      state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            100,
            'available',
            { kind: 'sats', baseAsset: 'sat' },
            'score-proof',
          ),
      )
      await writeState(state)

      try {
        const calls: string[] = []
          let capturedPayment: {
            amountSats: number
            token: string
            paymentId?: string
          } | null = null
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
            resolveInputFeePpkByKeyset: zeroInputFees,
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
                    keep: [cashuProof(98, 'score-change')],
                  }
                },
              })
            },
              generateEphemeralKeypair: () =>
                testEphemeralKeypair('55'.repeat(32)),
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
          updated?.wallet.proofs
            .filter((record) => record.asset.kind === 'sats')
            .map((record) => record.proof.secret)
            .sort(),
          ['score-change'],
        )
      } finally {
        if (priorState) await writeState(priorState)
      }
      },
    )

    await t.test(
      'order.submit rejects malformed order intent before side effects',
      async () => {
      const priorState = await readState()
      await writeState(backedDaemonState('cond', 10_000, 'malformed'))

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
      },
    )

    await t.test('trade.watch reads persisted swap state', async () => {
      const state = emptyDaemonState()
      state.swaps['trade-1'] = {
        tradeId: 'trade-1',
        marketId: 'cond-YES',
        orderId: 'order-1',
        fillAmountSubunits: 100,
        outcomeFaceAmountSubunits: 100,
        quotePaymentSubunits: 42,
        messages: { adaptorPoint: 'watch-private-cipher' },
        sellerAdaptorSecretHex: 'aa',
        sellerAdaptorPointHex: 'bb',
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
      assert.deepEqual(response.result, {
        tradeId: 'trade-1',
        marketId: 'cond-YES',
        orderId: 'order-1',
        step: 'awaiting-trade-created',
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      })
      assert.doesNotMatch(
        JSON.stringify(response.result),
        /watch-private-cipher|sellerAdaptorSecretHex|sellerAdaptorPointHex/,
      )
    })

    await t.test(
      'trade.list reads filtered local daemon swap state',
      async () => {
      const state = emptyDaemonState()
      state.swaps['trade-a'] = {
        tradeId: 'trade-a',
        marketId: 'cond-YES',
        orderId: 'order-a',
        messages: { adaptorPoint: 'private-adaptor-cipher' },
        sellerAdaptorSecretHex: 'aa',
        sellerAdaptorPointHex: 'bb',
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
          (all.result as { items: Array<{ tradeId: string }> }).items.map(
            (swap) => swap.tradeId,
          ),
        ['trade-c', 'trade-b', 'trade-a'],
      )
      assert.doesNotMatch(
        JSON.stringify(all.result),
        /private-adaptor-cipher|sellerAdaptorSecretHex|sellerAdaptorPointHex/,
      )

      const filtered = await dispatch({
        method: 'trade.list',
        params: { marketId: 'cond-YES', step: 'seller-opened' },
      })
      assert.equal(filtered.ok, true)
      assert.deepEqual(filtered.result, {
        items: [{
          tradeId: 'trade-a',
          marketId: 'cond-YES',
          orderId: 'order-a',
          step: 'seller-opened',
          createdAt: '2026-05-21T00:00:00.000Z',
          updatedAt: '2026-05-21T00:00:00.000Z',
        }],
        nextCursor: null,
      })
      },
    )

    await t.test(
      'trade.recover runs the durable coordinator before legacy swap recovery',
      async () => {
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
      const recoveryOrder: string[] = []
      let runtimeStartSawTrade = false
      let legacyExecutorCalls = 0

      const dependencies = {
        tradeRuntime: {
          async start(runtimeState: DaemonState) {
            runtimeStartSawTrade = !!runtimeState.swaps['trade-recover']
            recoveryOrder.push('runtime')
            return { orders: [], trades: [] }
          },
          async stop() {},
        },
        swapExecutor: {
          async resumeActiveSwaps() {
            legacyExecutorCalls += 1
            recoveryOrder.push('legacy-executor')
            return { activeSwaps: 1 }
          },
        },
        durableTradeRecovery: {
          async recover() {
            recoveryOrder.push('coordinator')
            recoveryOrder.push('executor')
            return { activeSwaps: 1 }
          },
        },
      } as unknown as Parameters<typeof dispatch>[1]
      const response = await dispatch(
        { method: 'trade.recover' },
        dependencies,
      )

      assert.deepEqual(response, {
        ok: true,
        result: { activeSwaps: 1 },
      })
      assert.equal(runtimeStartSawTrade, true)
      assert.equal(legacyExecutorCalls, 0)
      assert.deepEqual(recoveryOrder, ['runtime', 'coordinator', 'executor'])
      },
    )

    await t.test(
      'order.list reads filtered local daemon order state',
      async () => {
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
          (all.result as { items: Array<{ orderId: string }> }).items.map(
            (order) => order.orderId,
          ),
        ['order-c', 'order-b', 'order-a'],
      )

      const firstPage = await dispatch({
        method: 'order.list',
        params: { limit: 1 },
      })
      const firstResult = firstPage.result as {
        items: Array<{ orderId: string }>
        nextCursor: string | null
      }
      assert.deepEqual(firstResult.items.map((order) => order.orderId), [
        'order-c',
      ])
      assert.equal(typeof firstResult.nextCursor, 'string')
      const secondPage = await dispatch({
        method: 'order.list',
        params: { limit: 1, cursor: firstResult.nextCursor! },
      })
      assert.deepEqual(
        (secondPage.result as { items: Array<{ orderId: string }> }).items.map(
          (order) => order.orderId,
        ),
        ['order-b'],
      )

      const filtered = await dispatch({
        method: 'order.list',
        params: { marketId: 'cond-YES', status: 'resting' },
      })
      assert.equal(filtered.ok, true)
      assert.deepEqual(filtered.result, {
        items: [{
          orderId: 'order-a',
          marketId: 'cond-YES',
          status: 'resting',
          createdAt: '2026-05-21T00:00:00.000Z',
          updatedAt: '2026-05-21T00:00:00.000Z',
        }],
        nextCursor: null,
      })
      },
    )

    await t.test(
      'order.cancel delegates to engine and marks local order cancelled',
      async () => {
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
          resolveInputFeePpkByKeyset: zeroInputFees,
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
          tradeIds: [],
          engineStatus: {
            orderId: 'order-cancel',
            marketId: 'cond-YES',
            status: 'cancelled',
          },
            createdAt: (response.result as { local: { createdAt: string } })
              .local.createdAt,
            updatedAt: (response.result as { local: { updatedAt: string } })
              .local.updatedAt,
        },
      })
        assert.equal(
          (await readState())?.orders['order-cancel']?.status,
          'cancelled',
        )
      },
    )

    await t.test(
      'order.book delegates snapshot reads to engine client',
      async () => {
      let capturedMarketId: string | null = null
      const response = await dispatch(
        {
          method: 'order.book',
          params: { marketId: 'cond-YES' },
        },
        {
          resolveInputFeePpkByKeyset: zeroInputFees,
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
      },
    )

    await t.test(
      'order.submit remains successful when trade runtime start fails after persistence',
      async () => {
      await writeState(backedDaemonState('cond', 10_000, 'runtime-fail'))
      const engine: EngineClientLike = {
        ...scoreDisabledEngineMethods,
        async submitOrder(_marketId, request) {
          return {
            orderId: 'order-runtime-fail',
            status: 'resting',
            remainingAmountSubunits: request.amountSubunits,
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
          resolveInputFeePpkByKeyset: zeroInputFees,
          createEngineClient() {
            return engine
          },
            generateEphemeralKeypair: () =>
              testEphemeralKeypair('33'.repeat(32)),
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
        updatedSecrets?.orderEphemeralKeys['order-runtime-fail'],
        undefined,
      )
      },
    )

    await t.test(
      'order.submit accepts direct sell flow after same-outcome CTF swaps are supported',
      async () => {
      await writeState(backedDaemonState('cond', 10_000, 'direct-sell'))
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
          resolveInputFeePpkByKeyset: zeroInputFees,
          createEngineClient() {
            return {
              ...scoreDisabledEngineMethods,
              async submitOrder(_marketId, request) {
                capturedRequest = request
                return {
                  orderId: 'order-direct-sell',
                  status: 'resting',
                  remainingAmountSubunits: request.amountSubunits,
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
            generateEphemeralKeypair: () =>
              testEphemeralKeypair('44'.repeat(32)),
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
          clientOrderId: (capturedRequest as { clientOrderId?: unknown })
            .clientOrderId,
      })
      assert.match(
        (capturedRequest as { clientOrderId: string }).clientOrderId,
        /^[0-9a-f-]{36}$/i,
      )
        assert.equal(
          (await readState())?.orders['order-direct-sell']?.status,
          'resting',
        )
      assert.equal(
        (await readSecrets())?.orderEphemeralKeys['order-direct-sell'],
        undefined,
      )
      },
    )

    await t.test(
      'markets.query delegates catalogue reads to engine client',
      async () => {
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
      },
    )

    await t.test(
      'markets.show delegates single-market reads to engine client',
      async () => {
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
      },
    )
  } finally {
    uninstallOrderCollateral?.()
    uninstallCoordinator?.()
    await lease?.stopAndRelease()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

function fakeMintKeys(id: string): MintKeys {
  return {
    id,
    unit: 'msat',
    active: true,
    input_fee_ppk: 0,
    keys: {
      '1': `02${'11'.repeat(32)}`,
      '2': `02${'22'.repeat(32)}`,
      '4': `02${'33'.repeat(32)}`,
      '8': `02${'44'.repeat(32)}`,
    },
  } as MintKeys
}

function unusedWallet() {
  return {
    async loadMint() {},
    async receive(): Promise<never> {
      throw new Error('receive unused')
    },
    async send(): Promise<never> {
      throw new Error('send unused')
    },
  }
}

function proofRecord(
  mintUrl: string,
  amount: number,
  state: DaemonState['wallet']['proofs'][number]['state'],
  asset: DaemonState['wallet']['proofs'][number]['asset'],
  secret = `secret-${amount}`,
): DaemonState['wallet']['proofs'][number] {
  const baseAsset = asset.baseAsset ?? 'sat'
  return {
    mintUrl,
    unit: baseAsset === 'usd' ? 'usd' : 'msat',
    state,
    ...(state === 'available' ? {} : { reservedBy: `test-${state}` }),
    asset: { ...asset, baseAsset },
    proof: {
      id: `keyset-${amount}`,
      amount,
      secret,
      C: `02${createHash('sha256').update(secret).digest('hex')}`,
    },
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  }
}

function backedDaemonState(
  conditionId = 'cond',
  amount = 10_000,
  proofNamespace = 'default',
): DaemonState {
  const state = emptyDaemonState()
  state.wallet.proofs.push(
    proofRecord(
      'https://mint-a.example',
      amount,
      'available',
      {
      kind: 'Outcome',
      conditionId,
      outcomeSetId: 'YES',
      baseAsset: 'sat',
      },
      `${conditionId}-${proofNamespace}-yes-vcs`,
    ),
    proofRecord(
      'https://mint-a.example',
      amount,
      'available',
      {
      kind: 'Outcome',
      conditionId,
      outcomeSetId: 'NO',
      baseAsset: 'sat',
      },
      `${conditionId}-${proofNamespace}-no-vcs`,
    ),
    proofRecord(
      'https://mint-a.example',
      amount,
      'available',
      {
      kind: 'sats',
      baseAsset: 'sat',
      },
      `${conditionId}-${proofNamespace}-base`,
    ),
  )
  return state
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
  overrides: Partial<
    Awaited<ReturnType<EngineClientLike['getParticipationScore']>>
  > = {},
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

async function zeroInputFees(
  _mintUrl: string,
  keysetIds: string[],
): Promise<Record<string, number>> {
  return Object.fromEntries(keysetIds.map((keysetId) => [keysetId, 0]))
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
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        amount,
        fees: 0,
        keysetId: proofs[0].id,
        inputs: proofs,
        sendOutputs: [
          preparedOutput(`send-${proofs[0].secret}`, proofs[0].id),
        ],
        keepOutputs: [
          preparedOutput(`keep-${proofs[0].secret}`, proofs[0].id),
        ],
        unselectedProofs: [],
      }
    },
    async completeSwap(preview: { inputs: Proof[] }) {
      const secret = preview.inputs[0].secret
      selectedSecrets.push(secret)
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
        sendOutputs: [preparedOutput('send-output', proofs[0].id)],
        keepOutputs: [preparedOutput('keep-output', proofs[0].id)],
        unselectedProofs: [],
      }
    },
    async completeSwap() {
      return (
        options.onComplete?.() ?? {
        send: [cashuProof(5, 'sent-default')],
        keep: [cashuProof(3, 'change-default')],
      }
      )
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

function preparedOutput(secret: string, keysetId: string) {
  const digest = createHash('sha256').update(secret).digest('hex')
  return {
    blindedMessage: {
      amount: 5,
      id: keysetId,
      B_: `02${digest}`,
    },
    blindingFactor: 1n,
    secret: new TextEncoder().encode(secret),
  }
}

function testEphemeralKeypair(privateKeyHex: string) {
  const key = createECDH('secp256k1')
  key.setPrivateKey(Buffer.from(privateKeyHex, 'hex'))
  return {
    privateKeyHex,
    publicKeyHex: key.getPublicKey(undefined, 'compressed').toString('hex'),
  }
}
