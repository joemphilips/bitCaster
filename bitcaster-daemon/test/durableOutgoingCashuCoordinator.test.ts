import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  Amount,
  CheckStateEnum,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
  type Proof,
} from '@cashu/cashu-ts'
import {
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import { DaemonDurableOutgoingCashuCoordinator } from '../src/durableOutgoingCashuCoordinator.ts'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { DurableOutgoingCashuSqliteStore } from '../src/durableOutgoingCashuSqlite.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { addAvailableProofs, advanceDaemonKeysetCounter } from '../src/state.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'

const MINT_URL = 'https://mint.example'
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7])
const KEY = bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true))
const KEYS = { '1': KEY, '2': KEY, '4': KEY, '8': KEY }
const KEYSET_ID = deriveKeysetId(KEYS, { unit: 'sat', versionByte: 1 })
const FEE_KEYSET_ID = deriveKeysetId(KEYS, {
  unit: 'sat',
  versionByte: 1,
  input_fee_ppk: 500,
})

test('outgoing transfer persists exact authority before mint I/O and returns an identical token on retry', async () => {
  const fixture = await createFixture()
  try {
    let mintCalls = 0
    const wallet = fixture.wallet(async () => {
      mintCalls += 1
      assert.equal(await fixture.preMintPersisted(), true)
      return { keep: fixture.keepProofs, send: fixture.sendProofs }
    })
    const first = await fixture.coordinator.execute({
      transferId: 'outgoing-retry',
      amountSats: 5,
      mintUrl: MINT_URL,
      wallet,
    })
    assert.ok(first.token)
    const second = await fixture.coordinator.recover({
      transfer: first,
      amountSats: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => {
        throw new Error('terminal retry must not mint')
      }),
    })
    assert.equal(mintCalls, 1)
    assert.equal(second.token?.encodedToken, first.token?.encodedToken)
    assert.equal(await fixture.count('target_wallet_proofs'), 2)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 1)
    assert.equal(await fixture.count('custody_active_work'), 0)
    await assert.rejects(
      () => fixture.putForeignTransferBinding(second),
      /custody operation is foreign/,
    )
  } finally {
    await fixture.close()
  }
})

test('post-mint failure remains recoverable from its exact persisted operation without selecting new proofs', async () => {
  const fixture = await createFixture()
  try {
    let selected = 0
    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          transferId: 'outgoing-recover',
          amountSats: 5,
          mintUrl: MINT_URL,
          wallet: fixture.wallet(async () => {
            selected += 1
            throw new Error('response lost after mint')
          }),
        }),
      /response lost after mint/,
    )
    const prepared = await fixture.transfer('outgoing-recover')
    assert.ok(prepared)
    const recovered = await fixture.coordinator.recover({
      transfer: prepared!,
      amountSats: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => {
        throw new Error('recovery must not select or mint a new plan')
      }, CheckStateEnum.SPENT),
    })
    assert.equal(selected, 1)
    assert.ok(recovered.token)
    assert.equal(await fixture.count('target_wallet_proofs'), 2)
  } finally {
    await fixture.close()
  }
})

test('automatic recovery classifies a persisted bearer token without minting or emitting it', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-auto',
      amountSats: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    let wallets = 0
    let checks = 0
    const result = await fixture.coordinator.recoverDue({
      walletFor: async () => {
        wallets += 1
        const wallet = fixture.wallet(async () => {
          throw new Error('automatic recovery must not mint or present a token')
        })
        return {
          ...wallet,
          checkProofsStates: async (proofs) => {
            checks += 1
            return proofs.map((proof) => ({
              Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
              state: CheckStateEnum.UNSPENT,
              witness: null,
            }))
          },
        }
      },
    })
    const persisted = await fixture.transfer(transfer.transferId)
    assert.equal(wallets, 1)
    assert.equal(checks, 1)
    assert.deepEqual(result.pending, [])
    assert.equal(result.hasMore, false)
    assert.equal(result.hasPending, true)
    assert.equal(result.hasBlockingPending, false)
    assert.equal(persisted?.deliveryState, 'delivery-pending')
    assert.equal(persisted?.recovery.attemptCount, 1)
    assert.ok((persisted?.recovery.dueAtMs ?? 0) > 0)
    const futureDue = await fixture.coordinator.recoverDue({
      walletFor: async () => {
        throw new Error('future-due transfer must not open a wallet')
      },
    })
    assert.deepEqual(futureDue.pending, [])
    assert.equal(futureDue.hasMore, false)
    assert.equal(futureDue.hasPending, true)
    assert.equal(futureDue.hasBlockingPending, false)
  } finally {
    await fixture.close()
  }
})

test('automatic recovery retries every transfer in a malformed proof-state response chunk', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-malformed-state-response',
      amountSats: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    const before = await fixture.transfer(transfer.transferId)
    let mintCalls = 0
    const result = await fixture.coordinator.recoverDue({
      walletFor: async () => {
        const wallet = fixture.wallet(async () => {
          mintCalls += 1
          throw new Error('automatic recovery must not mint')
        })
        return {
          ...wallet,
          checkProofsStates: async (proofs) =>
            proofs.slice(0, -1).map((proof) => ({
              Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
              state: CheckStateEnum.UNSPENT,
              witness: null,
            })),
        }
      },
    })

    const persisted = await fixture.transfer(transfer.transferId)
    assert.equal(mintCalls, 0)
    assert.deepEqual(result.recovered, [])
    assert.deepEqual(
      result.pending.map(({ transferId }) => transferId),
      [transfer.transferId],
    )
    assert.match(result.pending[0]?.error ?? '', /response length/i)
    assert.equal(persisted?.recovery.attemptCount, (before?.recovery.attemptCount ?? 0) + 1)
    assert.ok((persisted?.recovery.dueAtMs ?? 0) > (before?.recovery.dueAtMs ?? 0))
  } finally {
    await fixture.close()
  }
})

test('fresh explicit reclaim reactivates only its classified bearer proofs and admits exact successors', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-reclaim',
      amountSats: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    const successorOutputs = [
      OutputData.createSingleData(4, KEYSET_ID, 'reclaim-successor-four', 20n),
      OutputData.createSingleData(1, KEYSET_ID, 'reclaim-successor-one', 21n),
    ]
    const successors = successorOutputs.map(signedProof)
    await fixture.advanceCounter(22)
    let checks = 0
    const reclaimed = await fixture.coordinator.reclaim({
      transferId: transfer.transferId,
      wallet: fixture.reclaimWallet({
        successorOutputs,
        successors,
        proofState: () => {
          checks += 1
          return CheckStateEnum.UNSPENT
        },
      }),
    })

    assert.equal(reclaimed.deliveryState, 'reclaimed')
    assert.equal(checks, 2)
    assert.equal(await fixture.custodySelectability(successors[0]!), 'retained')
    assert.equal(await fixture.targetWalletHasProof(successors[0]!), true)
    const predecessor = reclaimed.reclaim?.proofs[0]
    const evidence = reclaimed.reclaim?.completionEvidence
    assert.ok(predecessor)
    assert.ok(evidence)
    const identity = deriveDurableCustodyArtifactFingerprint({
      id: predecessor.id,
      secret: predecessor.secret,
      C: predecessor.C,
    })
    assert.equal(
      evidence.custodyRevisions.find((entry) => entry.proofIdentity === identity)?.revision,
      await fixture.custodyRevision(predecessor),
    )
  } finally {
    await fixture.close()
  }
})

test('fresh all-spent reclaim returns terminal success and repeats without mint work', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-already-spent',
      amountSats: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    let checks = 0
    const firstWallet = fixture.reclaimWallet({
      successorOutputs: [],
      successors: [],
      proofState: () => {
        checks += 1
        return CheckStateEnum.SPENT
      },
    })
    firstWallet.prepareSwapToReceive = async () => {
      throw new Error('all-spent reclaim must not prepare a mint request')
    }

    const terminal = await fixture.coordinator.reclaim({
      transferId: transfer.transferId,
      wallet: firstWallet,
    })
    const retryWallet = fixture.reclaimWallet({
      successorOutputs: [],
      successors: [],
      proofState: () => {
        throw new Error('terminal reclaim retry must not classify again')
      },
    })
    const retry = await fixture.coordinator.reclaim({
      transferId: transfer.transferId,
      wallet: retryWallet,
    })

    assert.equal(checks, 1)
    assert.equal(terminal.deliveryState, 'bearer-spent')
    assert.equal(retry.deliveryState, 'bearer-spent')
    assert.equal(retry.revision, terminal.revision)
  } finally {
    await fixture.close()
  }
})

test('recipient-spent reclaim terminalizes its linked receive operation in the same recovery action', async () => {
  const fixture = await createFixture({
    restoreOutputGroups: async () => ({ keep: [], send: [] }),
  })
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-recipient-spent',
      amountSats: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    let checks = 0
    const successorOutputs = [
      OutputData.createSingleData(4, KEYSET_ID, 'recipient-spent-four', 22n),
      OutputData.createSingleData(1, KEYSET_ID, 'recipient-spent-one', 23n),
    ]
    await fixture.advanceCounter(24)
    const terminal = await fixture.coordinator.reclaim({
      transferId: transfer.transferId,
      wallet: fixture.reclaimWallet({
        successors: successorOutputs.map(signedProof),
        successorOutputs,
        proofState: () => {
          checks += 1
          return checks === 1 ? CheckStateEnum.UNSPENT : CheckStateEnum.SPENT
        },
      }),
    })

    assert.equal(terminal.deliveryState, 'bearer-spent')
    assert.equal(terminal.reclaim, null)
    assert.equal(await fixture.activeReclaimWorkCount(), 0)
  } finally {
    await fixture.close()
  }
})

test('preparation failure leaves the exact custody proof selectable and creates no transfer', async () => {
  const fixture = await createFixture()
  try {
    const wallet = fixture.wallet(async () => {
      throw new Error('completeSwap must not run after a preparation failure')
    })
    wallet.prepareSwapToSend = async () => {
      throw new Error('preparation failed before mint I/O')
    }

    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          transferId: 'outgoing-preparation-failure',
          amountSats: 5,
          mintUrl: MINT_URL,
          wallet,
        }),
      /preparation failed before mint I\/O/,
    )

    assert.equal(await fixture.transfer('outgoing-preparation-failure'), null)
    assert.equal(await fixture.custodySelectability(fixture.inputProof), 'selectable')
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 0)
  } finally {
    await fixture.close()
  }
})

test('outgoing insert failure rolls back the custody bind and target reservation', async () => {
  const fixture = await createFixture()
  try {
    await fixture.installOutgoingTransferAbort('insert')
    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          transferId: 'outgoing-insert-rollback',
          amountSats: 5,
          mintUrl: MINT_URL,
          wallet: fixture.wallet(async () => ({
            keep: fixture.keepProofs,
            send: fixture.sendProofs,
          })),
        }),
      /outgoing transfer insert fault/,
    )
    await fixture.removeOutgoingTransferAbort('insert')

    assert.equal(await fixture.custodySelectability(fixture.inputProof), 'selectable')
    assert.equal(await fixture.count('target_proof_operations'), 0)
    assert.equal(await fixture.count('custody_operations'), 0)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 0)
    assert.equal(await fixture.count('custody_artifacts'), 0)
  } finally {
    await fixture.close()
  }
})

test('outgoing post-mint update failure admits no successors and exact recovery reuses its plan', async () => {
  const fixture = await createFixture()
  try {
    let prepares = 0
    const wallet = fixture.wallet(async () => ({
      keep: fixture.keepProofs,
      send: fixture.sendProofs,
    }))
    const prepare = wallet.prepareSwapToSend
    wallet.prepareSwapToSend = async (...input) => {
      prepares += 1
      return prepare(...input)
    }
    await fixture.installOutgoingTransferAbort('update')
    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          transferId: 'outgoing-update-rollback',
          amountSats: 5,
          mintUrl: MINT_URL,
          wallet,
        }),
      /outgoing transfer update fault/,
    )
    await fixture.removeOutgoingTransferAbort('update')

    assert.equal(prepares, 1)
    assert.equal(await fixture.count('custody_proofs'), 1)
    assert.equal(await fixture.count('target_wallet_proofs'), 1)
    await fixture.removeOutgoingTransferAbort('update')

    const prepared = await fixture.transfer('outgoing-update-rollback')
    assert.ok(prepared)
    const recovered = await fixture.coordinator.recover({
      transfer: prepared!,
      amountSats: 5,
      mintUrl: MINT_URL,
      wallet,
    })
    assert.ok(recovered.token)
    assert.equal(prepares, 1)
  } finally {
    await fixture.close()
  }
})

test('reclaim-prepared work resumes after restart without preparing a second receive operation', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-reclaim-restart',
      amountSats: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    const successorOutputs = [
      OutputData.createSingleData(4, KEYSET_ID, 'reclaim-restart-four', 30n),
      OutputData.createSingleData(1, KEYSET_ID, 'reclaim-restart-one', 31n),
    ]
    const successors = successorOutputs.map(signedProof)
    await fixture.advanceCounter(32)
    const interrupted = fixture.reclaimWallet({
      successors,
      successorOutputs,
      proofState: () => CheckStateEnum.UNSPENT,
    })
    interrupted.completeSwap = async () => {
      throw new Error('mint response was interrupted')
    }
    await assert.rejects(
      () => fixture.coordinator.reclaim({ transferId: transfer.transferId, wallet: interrupted }),
      /mint response was interrupted/,
    )
    assert.equal((await fixture.transfer(transfer.transferId))?.deliveryState, 'reclaim-prepared')

    let preparations = 0
    const recovery = await fixture.coordinator.recoverDue({
      walletFor: async () => {
        const wallet = fixture.reclaimWallet({
          successors,
          successorOutputs,
          proofState: () => CheckStateEnum.UNSPENT,
        })
        const prepare = wallet.prepareSwapToReceive!
        wallet.prepareSwapToReceive = async (...args) => {
          preparations += 1
          return prepare(...args)
        }
        return wallet
      },
    })

    assert.deepEqual(recovery.pending, [])
    assert.deepEqual(recovery.recovered, [transfer.transferId])
    assert.equal(preparations, 0)
    assert.equal((await fixture.transfer(transfer.transferId))?.deliveryState, 'reclaimed')
    assert.equal(await fixture.targetWalletHasProof(successors[0]!), true)
  } finally {
    await fixture.close()
  }
})

test('automatic reclaim recovery backs off a nonterminal exact reclaim without a new plan or token', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-reclaim-nonterminal',
      amountSats: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    const successorOutputs = [
      OutputData.createSingleData(4, KEYSET_ID, 'reclaim-pending-four', 34n),
      OutputData.createSingleData(1, KEYSET_ID, 'reclaim-pending-one', 35n),
    ]
    const successors = successorOutputs.map(signedProof)
    await fixture.advanceCounter(36)
    const interrupted = fixture.reclaimWallet({
      successors,
      successorOutputs,
      proofState: () => CheckStateEnum.UNSPENT,
    })
    interrupted.completeSwap = async () => {
      throw new Error('reclaim response was interrupted')
    }
    await assert.rejects(
      () => fixture.coordinator.reclaim({ transferId: transfer.transferId, wallet: interrupted }),
      /reclaim response was interrupted/,
    )
    const before = await fixture.transfer(transfer.transferId)
    let preparations = 0
    let mintCalls = 0
    const recovery = await fixture.coordinator.recoverDue({
      walletFor: async () => {
        const wallet = fixture.reclaimWallet({
          successors,
          successorOutputs,
          proofState: () => CheckStateEnum.PENDING,
        })
        const prepare = wallet.prepareSwapToReceive!
        wallet.prepareSwapToReceive = async (...args) => {
          preparations += 1
          return prepare(...args)
        }
        wallet.completeSwap = async () => {
          mintCalls += 1
          throw new Error('nonterminal reclaim must not mint')
        }
        return wallet
      },
    })

    const persisted = await fixture.transfer(transfer.transferId)
    assert.deepEqual(recovery.recovered, [])
    assert.deepEqual(
      recovery.pending.map(({ transferId }) => transferId),
      [transfer.transferId],
    )
    assert.match(recovery.pending[0]?.error ?? '', /reclaim remains pending/i)
    assert.equal(preparations, 0)
    assert.equal(mintCalls, 0)
    assert.equal(persisted?.deliveryState, 'reclaim-prepared')
    assert.equal(recovery.hasPending, true)
    assert.equal(recovery.hasBlockingPending, true)
    assert.equal(persisted?.recovery.attemptCount, (before?.recovery.attemptCount ?? 0) + 1)
    assert.ok((persisted?.recovery.dueAtMs ?? 0) > (before?.recovery.dueAtMs ?? 0))
  } finally {
    await fixture.close()
  }
})

test('durable send gives cashu-ts all eligible proofs for nonzero input fees and reserves only its preview inputs', async () => {
  const fixture = await createFixture()
  try {
    await fixture.addAvailableInput(MINT_URL, 'fee-aware-input-one', FEE_KEYSET_ID, 999n)
    await fixture.addAvailableInput(MINT_URL, 'fee-aware-input-two', FEE_KEYSET_ID, 1000n)
    const sendOutputs = [
      OutputData.createSingleData(4, FEE_KEYSET_ID, 'fee-aware-send-four', 40n),
      OutputData.createSingleData(1, FEE_KEYSET_ID, 'fee-aware-send-one', 41n),
    ]
    const keepOutputs = [
      OutputData.createSingleData(8, FEE_KEYSET_ID, 'fee-aware-keep-eight', 42n),
      OutputData.createSingleData(2, FEE_KEYSET_ID, 'fee-aware-keep-two', 43n),
    ]
    const wallet = fixture.wallet(
      async () => ({
        keep: [...keepOutputs.map(signedProof), fixture.inputProof],
        send: sendOutputs.map(signedProof),
      }),
      CheckStateEnum.UNSPENT,
      { sendOutputs, keepOutputs },
    )
    let previewInputs: Proof[] = []
    wallet.prepareSwapToSend = async (_amount, proofs) => {
      assert.equal(proofs.length, 3)
      previewInputs = proofs.filter((proof) => proof.id === FEE_KEYSET_ID)
      assert.equal(previewInputs.length, 2)
      return {
        amount: Amount.from(5),
        fees: Amount.from(1),
        keysetId: FEE_KEYSET_ID,
        inputs: previewInputs,
        sendOutputs,
        keepOutputs,
        unselectedProofs: proofs.filter((proof) => proof.id !== FEE_KEYSET_ID),
      }
    }
    wallet.getKeyset = (id) => ({
      id,
      unit: 'sat',
      keys: KEYS,
      fee: id === FEE_KEYSET_ID ? 500 : 0,
      verify: () => true,
    })

    await fixture.coordinator.execute({
      transferId: 'outgoing-fee-aware-selection',
      amountSats: 5,
      mintUrl: MINT_URL,
      wallet,
    })

    assert.equal(previewInputs.length, 2)
    assert.equal(await fixture.custodySelectability(previewInputs[0]!), 'spent')
    assert.equal(await fixture.custodySelectability(previewInputs[1]!), 'spent')
    assert.equal(await fixture.custodySelectability(fixture.inputProof), 'selectable')
    assert.equal(await fixture.custodyRevision(fixture.inputProof), 0)
  } finally {
    await fixture.close()
  }
})

test('durable send rejects a non-V2 available proof before cashu-ts preparation', async () => {
  const fixture = await createFixture()
  try {
    const legacy = await fixture.addAvailableInput(MINT_URL, 'legacy-keyset-input', 'AbCdEfGhIjKl')
    const wallet = fixture.wallet(async () => ({ keep: [], send: [] }))
    let preparations = 0
    wallet.prepareSwapToSend = async () => {
      preparations += 1
      throw new Error('cashu-ts preparation must not run')
    }

    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          transferId: 'outgoing-v2-boundary',
          amountSats: 1,
          mintUrl: MINT_URL,
          wallet,
        }),
      /supports only V2 keysets/,
    )

    assert.equal(preparations, 0)
    assert.equal(await fixture.custodySelectability(legacy), 'selectable')
  } finally {
    await fixture.close()
  }
})

test('one bounded automatic page batches bearer classification, reuses its mint wallet, and records backoff', async () => {
  const fixture = await createFixture()
  try {
    const mintUrls = [
      MINT_URL,
      'https://mint-b.example',
      'https://mint-c.example',
      'https://mint-d.example',
      'https://mint-e.example',
    ]
    for (const mintUrl of mintUrls) {
      await fixture.addAvailableInput(mintUrl, `${mintUrl}-first`)
      await fixture.addAvailableInput(mintUrl, `${mintUrl}-second`)
    }
    const transfers = []
    for (const [mintIndex, mintUrl] of mintUrls.entries()) {
      for (const transferIndex of mintIndex === 4 ? [0] : [0, 1]) {
        const outputOffset = BigInt(100 + mintIndex * 10 + transferIndex * 2)
        const sendOutputs = [
          OutputData.createSingleData(
            4,
            KEYSET_ID,
            `page-${mintIndex}-${transferIndex}-four`,
            outputOffset,
          ),
          OutputData.createSingleData(
            1,
            KEYSET_ID,
            `page-${mintIndex}-${transferIndex}-one`,
            outputOffset + 1n,
          ),
        ]
        const keepOutputs = [
          OutputData.createSingleData(
            2,
            KEYSET_ID,
            `page-${mintIndex}-${transferIndex}-keep-two`,
            outputOffset + 2n,
          ),
          OutputData.createSingleData(
            1,
            KEYSET_ID,
            `page-${mintIndex}-${transferIndex}-keep-one`,
            outputOffset + 3n,
          ),
        ]
        transfers.push(
          await fixture.coordinator.execute({
            transferId: `outgoing-page-${mintIndex}-${transferIndex}`,
            amountSats: 5,
            mintUrl,
            wallet: fixture.wallet(
              async () => ({
                keep: keepOutputs.map(signedProof),
                send: sendOutputs.map(signedProof),
              }),
              CheckStateEnum.UNSPENT,
              { sendOutputs, keepOutputs },
            ),
          }),
        )
      }
    }

    let wallets = 0
    let checks = 0
    const result = await fixture.coordinator.recoverDue({
      walletFor: async () => {
        wallets += 1
        const wallet = fixture.wallet(async () => {
          throw new Error('automatic bearer recovery must not mint')
        })
        return {
          ...wallet,
          checkProofsStates: async (proofs) => {
            checks += 1
            return proofs.map((proof) => ({
              Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
              state: CheckStateEnum.UNSPENT,
              witness: null,
            }))
          },
        }
      },
    })

    assert.equal(wallets, 4)
    assert.equal(checks, 4)
    assert.equal(result.hasMore, true)
    assert.deepEqual(result.recovered, [])
    assert.equal(result.pending.length, 0)
    for (const transfer of transfers.slice(0, 8)) {
      const persisted = await fixture.transfer(transfer.transferId)
      assert.equal(persisted?.deliveryState, 'delivery-pending')
      assert.equal(persisted?.recovery.attemptCount, 1)
    }
    assert.equal((await fixture.transfer(transfers[8]!.transferId))?.recovery.attemptCount, 0)

    const second = await fixture.coordinator.recoverDue({
      walletFor: async () => {
        wallets += 1
        const wallet = fixture.wallet(async () => {
          throw new Error('automatic bearer recovery must not mint')
        })
        return {
          ...wallet,
          checkProofsStates: async (proofs) => {
            checks += 1
            return proofs.map((proof) => ({
              Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
              state: CheckStateEnum.UNSPENT,
              witness: null,
            }))
          },
        }
      },
    })
    assert.equal(second.hasMore, false)
    assert.equal(wallets, 5)
    assert.equal(checks, 5)
    assert.equal((await fixture.transfer(transfers[8]!.transferId))?.recovery.attemptCount, 1)
  } finally {
    await fixture.close()
  }
})

test('a stale fence loses before mint I/O and the current fence completes the exact retry once', async () => {
  const fixture = await createFixture()
  try {
    const future = Date.now() + 120_000
    const currentFence = await fixture.takeoverFence(future)
    let mintCalls = 0
    const wallet = fixture.wallet(async () => {
      mintCalls += 1
      return { keep: fixture.keepProofs, send: fixture.sendProofs }
    })

    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          transferId: 'outgoing-stale-fence',
          amountSats: 5,
          mintUrl: MINT_URL,
          wallet,
        }),
      /stale|owner changed/,
    )
    assert.equal(mintCalls, 0)
    const current = fixture.coordinatorFor(currentFence, future + 1)
    const transfer = await current.execute({
      transferId: 'outgoing-stale-fence',
      amountSats: 5,
      mintUrl: MINT_URL,
      wallet,
    })
    assert.equal(transfer.deliveryState, 'delivery-pending')
    assert.equal(mintCalls, 1)
  } finally {
    await fixture.close()
  }
})

async function createFixture(
  options: {
    readonly restoreOutputGroups?: (
      mintUrl: string,
      outputs: Record<string, unknown[]>,
    ) => Promise<Record<string, Proof[]>>
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-outgoing-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const seed = '11'.repeat(64)
  await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT_URL,
    walletSeedHex: seed,
    nostrSecretKeyHex: '22'.repeat(32),
  })
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: deriveDurableCustodyWalletId(Buffer.from(seed, 'hex')),
  })
  const fence = await claimCustodyScopeLease(directory, {
    scopeId,
    incarnationId: 'durable-outgoing-test',
    observedAtMs: Date.now(),
  })
  const inputOutput = OutputData.createSingleData(8, KEYSET_ID, 'input-secret', 1n)
  const sendOutputs = [
    OutputData.createSingleData(4, KEYSET_ID, 'send-four', 2n),
    OutputData.createSingleData(1, KEYSET_ID, 'send-one', 3n),
  ]
  const keepOutputs = [
    OutputData.createSingleData(2, KEYSET_ID, 'keep-two', 4n),
    OutputData.createSingleData(1, KEYSET_ID, 'keep-one', 5n),
  ]
  const inputProof = signedProof(inputOutput)
  const sendProofs = sendOutputs.map(signedProof)
  const keepProofs = keepOutputs.map(signedProof)
  const outputProofs = new Map<string, Proof>([
    ...sendOutputs.map((output, index) => [output.blindedMessage.B_, sendProofs[index]!] as const),
    ...keepOutputs.map((output, index) => [output.blindedMessage.B_, keepProofs[index]!] as const),
  ])
  await addAvailableProofs(MINT_URL, [inputProof], { kind: 'sats', baseAsset: 'sat', unit: 'sat' })
  await withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
    const row = createCustodyProofSqliteRow({
      scopeId,
      normalizedMint: MINT_URL,
      unit: 'sat',
      proof: inputProof,
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
  const coordinator = new DaemonDurableOutgoingCashuCoordinator(directory, () => fence, {
    restoreOutputGroups:
      options.restoreOutputGroups ??
      (async (_mintUrl, outputs) => {
        const restore = (group: string) =>
          (outputs[group] ?? []).map((output) => {
            const proof = outputProofs.get(
              (output as { blindedMessage: { B_: string } }).blindedMessage.B_,
            )
            if (proof === undefined) throw new Error('output fixture is missing')
            return proof
          })
        return { send: restore('send'), keep: restore('keep') }
      }),
  })
  const outgoingTransferAbortRestore = new Map<'insert' | 'update', () => void>()
  return {
    coordinator,
    inputProof,
    sendProofs,
    keepProofs,
    wallet: (
      complete: () => Promise<{ keep: Proof[]; send: Proof[] }>,
      state: CheckStateEnum = CheckStateEnum.UNSPENT,
      outputPlan: {
        readonly sendOutputs: readonly OutputData[]
        readonly keepOutputs: readonly OutputData[]
      } = {
        sendOutputs,
        keepOutputs,
      },
    ) => {
      for (const output of outputPlan.sendOutputs)
        outputProofs.set(output.blindedMessage.B_, signedProof(output))
      for (const output of outputPlan.keepOutputs)
        outputProofs.set(output.blindedMessage.B_, signedProof(output))
      return {
        loadMint: async () => {},
        receive: async () => [],
        send: async () => ({ keep: [], send: [] }),
        prepareSwapToSend: async (_amount: number, proofs: Proof[]) => ({
          amount: Amount.from(5),
          fees: Amount.zero(),
          keysetId: KEYSET_ID,
          inputs: proofs,
          sendOutputs: outputPlan.sendOutputs,
          keepOutputs: outputPlan.keepOutputs,
          unselectedProofs: [],
        }),
        completeSwap: complete,
        checkProofsStates: async (proofs: Array<Pick<Proof, 'secret'>>) =>
          proofs.map((proof) => ({
            Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
            state,
            witness: null,
          })),
        getKeyset: () => ({ id: KEYSET_ID, unit: 'sat', keys: KEYS, fee: 0, verify: () => true }),
      }
    },
    reclaimWallet: ({
      successors,
      successorOutputs,
      proofState,
    }: {
      readonly successors: readonly Proof[]
      readonly successorOutputs: readonly OutputData[]
      readonly proofState: () => CheckStateEnum
    }) => ({
      loadMint: async () => {},
      receive: async () => [],
      send: async () => ({ keep: [], send: [] }),
      prepareSwapToReceive: async (
        _token: string,
        config?: {
          onCountersReserved?: (range: { keysetId: string; start: number; count: number }) => void
        },
      ) => {
        config?.onCountersReserved?.({ keysetId: KEYSET_ID, start: 20, count: 2 })
        return {
          amount: Amount.from(5),
          fees: Amount.zero(),
          keysetId: KEYSET_ID,
          inputs: sendProofs,
          keepOutputs: successorOutputs,
          unselectedProofs: [],
        }
      },
      completeSwap: async () => ({ keep: [...successors], send: [] }),
      checkProofsStates: async (proofs: Array<Pick<Proof, 'secret'>>) => {
        const state = proofState()
        return proofs.map((proof) => ({
          Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
          state,
          witness: null,
        }))
      },
      getKeyset: () => ({ id: KEYSET_ID, unit: 'sat', keys: KEYS, fee: 0, verify: () => true }),
    }),
    preMintPersisted: async () => {
      const transfer = await coordinator.loadTransfer('outgoing-retry')
      return transfer?.deliveryState === 'prepared'
    },
    transfer: (transferId: string) => coordinator.loadTransfer(transferId),
    putForeignTransferBinding: async (
      transfer: Awaited<ReturnType<typeof coordinator.loadTransfer>>,
    ) => {
      if (transfer === null) throw new Error('fixture transfer is missing')
      await withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
        new DurableOutgoingCashuSqliteStore(database).put({
          scopeId,
          custodyOperationId: 'foreign-custody-operation',
          transfer,
          nowMs: Date.now(),
        })
      })
    },
    installOutgoingTransferAbort: async (phase: 'insert' | 'update') => {
      const name = `test_outgoing_transfer_${phase}_abort`
      const statement =
        phase === 'insert'
          ? `CREATE TEMP TRIGGER ${name}
               BEFORE INSERT ON daemon_outgoing_cashu_transfers
               BEGIN SELECT RAISE(ABORT, 'outgoing transfer insert fault'); END`
          : `CREATE TEMP TRIGGER ${name}
               BEFORE UPDATE ON daemon_outgoing_cashu_transfers
               WHEN OLD.delivery_state = 'prepared' AND NEW.delivery_state = 'delivery-pending'
               BEGIN SELECT RAISE(ABORT, 'outgoing transfer update fault'); END`
      const originalExec = DatabaseSync.prototype.exec
      DatabaseSync.prototype.exec = function (sql: string) {
        const result = originalExec.call(this, sql)
        if (sql === 'BEGIN IMMEDIATE') originalExec.call(this, statement)
        return result
      }
      outgoingTransferAbortRestore.set(phase, () => {
        DatabaseSync.prototype.exec = originalExec
      })
    },
    removeOutgoingTransferAbort: async (phase: 'insert' | 'update') => {
      outgoingTransferAbortRestore.get(phase)?.()
      outgoingTransferAbortRestore.delete(phase)
    },
    count: async (table: string) => {
      if (
        ![
          'target_wallet_proofs',
          'target_proof_operations',
          'custody_proofs',
          'custody_operations',
          'custody_artifacts',
          'custody_active_work',
          'daemon_outgoing_cashu_transfers',
        ].includes(table)
      )
        throw new Error('table is foreign')
      return withDurableCustodyUnitOfWork(
        directory,
        fence,
        Date.now(),
        (database) =>
          (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
            .count,
      )
    },
    custodySelectability: async (proof: Proof) =>
      withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
        const proofId = deriveDurableCustodyProofId({
          scopeId,
          normalizedMint: MINT_URL,
          unit: 'sat',
          keysetId: proof.id,
          secret: proof.secret,
        })
        return (
          (
            database
              .prepare(
                'SELECT selectability FROM custody_proofs WHERE scope_id = ? AND proof_id = ?',
              )
              .get(scopeId, proofId) as { selectability: string } | undefined
          )?.selectability ?? null
        )
      }),
    custodyRevision: async (proof: Pick<Proof, 'id' | 'secret'>) =>
      withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
        const proofId = deriveDurableCustodyProofId({
          scopeId,
          normalizedMint: MINT_URL,
          unit: 'sat',
          keysetId: proof.id,
          secret: proof.secret,
        })
        return (
          (
            database
              .prepare('SELECT revision FROM custody_proofs WHERE scope_id = ? AND proof_id = ?')
              .get(scopeId, proofId) as { revision: number } | undefined
          )?.revision ?? null
        )
      }),
    targetWalletHasProof: async (proof: Proof) =>
      withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
        const row = database
          .prepare('SELECT 1 AS found FROM target_wallet_proofs WHERE secret = ?')
          .get(proof.secret) as { found: number } | undefined
        return row?.found === 1
      }),
    activeReclaimWorkCount: async () =>
      withDurableCustodyUnitOfWork(
        directory,
        fence,
        Date.now(),
        (database) =>
          (
            database
              .prepare(
                `SELECT COUNT(*) AS count FROM custody_active_work AS active
               JOIN custody_operations AS operation
                 ON operation.scope_id = active.scope_id
                AND operation.operation_id = active.operation_id
               WHERE active.scope_id = ? AND operation.retained_operation_key LIKE 'bearer-reclaim:%'`,
              )
              .get(scopeId) as { count: number }
          ).count,
      ),
    addAvailableInput: async (
      mintUrl: string,
      secret: string,
      keysetId = KEYSET_ID,
      counter = 999n,
    ) => {
      const proof = signedProof(OutputData.createSingleData(8, keysetId, secret, counter))
      await addAvailableProofs(mintUrl, [proof], { kind: 'sats', baseAsset: 'sat', unit: 'sat' })
      await withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
        const row = createCustodyProofSqliteRow({
          scopeId,
          normalizedMint: mintUrl,
          unit: 'sat',
          proof,
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
      return proof
    },
    takeoverFence: (observedAtMs: number) =>
      claimCustodyScopeLease(directory, {
        scopeId,
        incarnationId: 'durable-outgoing-test-takeover',
        observedAtMs,
      }),
    coordinatorFor: (currentFence: typeof fence, nowMs: number) =>
      new DaemonDurableOutgoingCashuCoordinator(
        directory,
        () => currentFence,
        {
          restoreOutputGroups:
            options.restoreOutputGroups ??
            (async (_mintUrl, outputs) => {
              const restore = (group: string) =>
                (outputs[group] ?? []).map((output) => {
                  const proof = outputProofs.get(
                    (output as { blindedMessage: { B_: string } }).blindedMessage.B_,
                  )
                  if (proof === undefined) throw new Error('output fixture is missing')
                  return proof
                })
              return { send: restore('send'), keep: restore('keep') }
            }),
        },
        () => nowMs,
      ),
    advanceCounter: async (minimum: number) =>
      advanceDaemonKeysetCounter(
        KEYSET_ID,
        minimum,
        { fence, observedAtMs: Date.now() },
        { normalizedMint: MINT_URL, unit: 'sat' },
      ),
    close: async () => {
      if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previousHome
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function signedProof(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEY,
    output.blindedMessage.id,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY)
  const proof = output.toProof(
    {
      id: output.blindedMessage.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: output.blindedMessage.id, keys: KEYS },
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
