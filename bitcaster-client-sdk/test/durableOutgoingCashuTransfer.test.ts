import assert from 'node:assert/strict'
import test from 'node:test'
import { Amount, getEncodedTokenV4, OutputData } from '@cashu/cashu-ts'
import { deriveDurableCustodyArtifactFingerprint } from '../src/durableCustody.ts'
import {
  acknowledgeDurableOutgoingCashuRecipient,
  admitDurableOutgoingCashuToken,
  classifyDurableOutgoingBearerProofStates,
  createDurableOutgoingCashuTransfer,
  decodeDurableOutgoingCashuTransfer,
  completeDurableOutgoingCashuReclaim,
  planDurableOutgoingCashuProofStateChunks,
  planDurableOutgoingCashuRecoveryPage,
  prepareDurableOutgoingCashuReclaim,
  redactedTransferMetadata,
  runDurableOutgoingCashuTransfer,
  runDurableOutgoingCashuReclaim,
  scheduleDurableOutgoingCashuRecoveryRetry,
} from '../src/durableOutgoingCashuTransfer.ts'
import {
  deriveDurableWalletOperationAuthority,
  deriveDurableWalletProofY,
  decodeDurableWalletOperation,
  hydrateDurableWalletProof,
  serializeDurableWalletReceiveOperation,
  serializeDurableWalletSendOperation,
  type DurableWalletProof,
  type DurableWalletSendOperation,
} from '../src/durableWalletOperation.ts'

const KEYSET_ID = '0000000000000001'
const TOKEN_C = `02${'1'.repeat(64)}`
const SECOND_TOKEN_C = `02${'2'.repeat(64)}`

test('strictly creates and decodes one exact outgoing bearer transfer', () => {
  const transfer = bearerTransfer()

  assert.equal(transfer.deliveryState, 'prepared')
  assert.equal(transfer.walletSendOperationAuthority.requestFingerprint.length, 64)
  assert.throws(() => decodeDurableOutgoingCashuTransfer({ ...transfer, foreign: true }), /foreign/)
  assert.throws(
    () => decodeDurableOutgoingCashuTransfer({ ...transfer, requestedAmount: '3' }),
    /foreign/,
  )
})

test('classifies complete bearer proof vectors and journals only exact reclaim authority', () => {
  const admitted = admittedBearerTransfer()
  const Y = deriveDurableWalletProofY(admitted.token!.proofs[0]!)

  const unspent = classifyDurableOutgoingBearerProofStates({
    transfer: admitted,
    states: [{ Y, state: 'UNSPENT' }],
    dueAtMs: 10,
  }).transfer
  const reclaim = prepareDurableOutgoingCashuReclaim({
    transfer: unspent,
    reclaimId: 'reclaim-1',
    states: [{ Y, state: 'UNSPENT' }],
    dueAtMs: 11,
    walletReceiveOperation: reclaimOperation('reclaim-1', admitted.token!.proofs),
  })
  assert.equal(reclaim.deliveryState, 'reclaim-prepared')
  assert.deepEqual(reclaim.reclaim?.proofs, admitted.token!.proofs)

  const spent = classifyDurableOutgoingBearerProofStates({
    transfer: admitted,
    states: [{ Y, state: 'SPENT' }],
    dueAtMs: 10,
  }).transfer
  assert.equal(spent.deliveryState, 'bearer-spent')

  const uncertain = classifyDurableOutgoingBearerProofStates({
    transfer: admitted,
    states: [{ Y, state: 'PENDING' }],
    dueAtMs: 10,
  }).transfer
  assert.equal(uncertain.token?.unspentProofs, null)
  assert.throws(
    () =>
      prepareDurableOutgoingCashuReclaim({
        transfer: uncertain,
        reclaimId: 'nope',
        states: [{ Y, state: 'PENDING' }],
        dueAtMs: 11,
        walletReceiveOperation: reclaimOperation('nope', admitted.token!.proofs),
      }),
    /not authorized/,
  )
})

test('does not expose a token in redacted metadata and requires a persisted recipient receipt', async () => {
  const recipient = createDurableOutgoingCashuTransfer({
    transferId: 'recipient-1',
    walletScopeId: 'wallet-1',
    requestedAmount: '2',
    walletSendOperation: walletSendOperation(),
    deliveryIntent: {
      policy: 'durable-recipient-ack',
      expectedSubject: 'account-subject-1',
      opaqueProductBinding: 'product-binding-1',
      tokenBytesLimit: 1024,
      tokenProofLimit: 1,
    },
  })
  const admitted = admitDurableOutgoingCashuToken({
    transfer: recipient,
    keepProofs: [],
    sendProofs: [sendProof()],
    encodedToken: encodedToken([sendProof()]),
    custodyRevisions: custodyRevisions(recipient.walletSendOperation, [], [sendProof()]),
    dueAtMs: 10,
  })
  const metadata = redactedTransferMetadata(admitted)

  assert.equal(JSON.stringify(metadata).includes(encodedToken([sendProof()])), false)
  const acknowledged = await acknowledgeDurableOutgoingCashuRecipient({
    transfer: admitted,
    receiptAdapter: {
      readAndPersistReceipt: async ({ transfer }) =>
        decodeDurableOutgoingCashuTransfer({
          ...transfer,
          deliveryState: 'recipient-acknowledged',
          recipientReceipt: {
            transferId: admitted.transferId,
            expectedSubject: 'account-subject-1',
            opaqueProductBinding: 'product-binding-1',
            mintUrl: admitted.mintUrl,
            unit: admitted.unit,
            requestedAmount: admitted.requestedAmount,
            tokenSha256: admitted.token!.sha256,
            tokenLength: admitted.token!.encodedLength,
            durableReceiveAuthority: admitted.walletSendOperationAuthority,
            durableResultFingerprint: admitted.token!.sha256,
          },
          revision: transfer.revision + 1,
        }),
    },
  })
  assert.equal(acknowledged.deliveryState, 'recipient-acknowledged')
})

test('mixed bearer classification retains only the exact unspent subset for reclaim', () => {
  const transfer = createDurableOutgoingCashuTransfer({
    transferId: 'partial-1',
    walletScopeId: 'wallet-1',
    requestedAmount: '2',
    walletSendOperation: twoOutputWalletSendOperation(),
    deliveryIntent: {
      policy: 'bearer-spend-classification',
      tokenBytesLimit: 1024,
      tokenProofLimit: 2,
    },
  })
  const proofs = [partialFirstSendProof(), secondSendProof()]
  const admitted = admitDurableOutgoingCashuToken({
    transfer,
    keepProofs: [],
    sendProofs: proofs,
    encodedToken: encodedToken(proofs),
    custodyRevisions: custodyRevisions(transfer.walletSendOperation, [], proofs),
    dueAtMs: 10,
  })
  const states = [
    { Y: deriveDurableWalletProofY(proofs[0]!), state: 'SPENT' as const },
    { Y: deriveDurableWalletProofY(proofs[1]!), state: 'UNSPENT' as const },
  ]
  const partial = classifyDurableOutgoingBearerProofStates({
    transfer: admitted,
    states,
    dueAtMs: 11,
  }).transfer
  const reclaim = prepareDurableOutgoingCashuReclaim({
    transfer: partial,
    reclaimId: 'partial-reclaim',
    states,
    dueAtMs: 12,
    walletReceiveOperation: reclaimOperation('partial-reclaim', [secondSendProof()]),
  })

  assert.equal(partial.deliveryState, 'bearer-partial')
  assert.deepEqual(reclaim.reclaim?.proofs, [secondSendProof()])

  const contradictory = classifyDurableOutgoingBearerProofStates({
    transfer: partial,
    states: [
      { Y: deriveDurableWalletProofY(proofs[0]!), state: 'UNSPENT' },
      { Y: deriveDurableWalletProofY(proofs[1]!), state: 'SPENT' },
    ],
    dueAtMs: 13,
  }).transfer
  assert.equal(contradictory.deliveryState, 'bearer-spent')
  assert.equal(contradictory.token?.unspentProofs, null)
})

test('recovery pages require a stable starvation-safe due order', () => {
  const first = bearerTransfer()
  const second = decodeDurableOutgoingCashuTransfer({
    ...first,
    transferId: 'transfer-2',
    recovery: { dueAtMs: 1, attemptCount: 0 },
  })
  const page = {
    storedBytes: 1024,
    transfers: [first, second],
    nextCursor: { dueAtMs: 2, transferId: 'transfer-3' },
  }
  const planned = planDurableOutgoingCashuRecoveryPage({ page, limit: 2, maximumBytes: 4096 })

  assert.equal(planned.get('https://mint.example')?.length, 2)
  assert.throws(
    () =>
      planDurableOutgoingCashuRecoveryPage({
        page: { ...page, transfers: [second, first] },
        limit: 2,
        maximumBytes: 4096,
      }),
    /order/,
  )
})

test('reclaim executes the exact unspent plan and accepts one atomic completion evidence', async () => {
  const reclaim = preparedReclaim('reclaim-execute')
  const successor = successorProof(reclaim)
  const calls = { swaps: 0, persists: 0, admissions: 0 }
  let snapshot = {
    operation: reclaim.reclaim!.walletReceiveOperation,
    state: 'prepared' as const,
    result: null,
  }
  const result = await runDurableOutgoingCashuReclaim({
    transfer: reclaim,
    walletReceive: {
      // The reclaim coordinator ignores caller mode and forces a fresh NUT-07 recovery check.
      mode: 'execute',
      operationId: reclaim.reclaim!.reclaimId,
      store: {
        loadOperation: async () => snapshot,
        persistCompletedResult: async ({ result }) => {
          calls.persists += 1
          snapshot = {
            operation: reclaim.reclaim!.walletReceiveOperation,
            state: 'completed',
            result,
          }
          return 'completed'
        },
      },
      wallet: {
        checkProofsStates: async () =>
          reclaim.reclaim!.proofs.map((proof) => ({
            Y: deriveDurableWalletProofY(proof),
            state: 'UNSPENT',
            witness: null,
          })) as never,
        completeSwap: async () => {
          calls.swaps += 1
          return { keep: [successor], send: [] }
        },
      },
      restoreExactOutputs: async () => ({ receive: [successor] }),
    },
    admitAndComplete: async ({ successorProofs }) => {
      calls.admissions += 1
      return reclaimEvidence(reclaim, successorProofs)
    },
  })

  assert.equal(result.deliveryState, 'reclaimed')
  assert.deepEqual(calls, { swaps: 1, persists: 1, admissions: 1 })
  assert.deepEqual(
    completeDurableOutgoingCashuReclaim({
      transfer: result,
      successorProofs: [successor],
      evidence: reclaimEvidence(reclaim, [successor]),
    }),
    result,
  )
  assert.throws(
    () =>
      completeDurableOutgoingCashuReclaim({
        transfer: result,
        successorProofs: [successor],
        evidence: { ...reclaimEvidence(reclaim, [successor]), reclaimId: 'foreign-reclaim' },
      }),
    /conflicts/,
  )
})

test('reclaim recovery restores exact successors after a crash and leaves pending input nonterminal', async () => {
  const reclaim = preparedReclaim('reclaim-crash')
  const successor = successorProof(reclaim)
  let restores = 0
  const recovered = await runDurableOutgoingCashuReclaim({
    transfer: reclaim,
    walletReceive: {
      mode: 'recover',
      operationId: reclaim.reclaim!.reclaimId,
      store: {
        loadOperation: async () => ({
          operation: reclaim.reclaim!.walletReceiveOperation,
          state: 'prepared',
          result: null,
        }),
        persistCompletedResult: async () => 'completed',
      },
      wallet: {
        checkProofsStates: async () =>
          reclaim.reclaim!.proofs.map((proof) => ({
            Y: deriveDurableWalletProofY(proof),
            state: 'SPENT',
            witness: null,
          })) as never,
        completeSwap: async () => {
          throw new Error('spent reclaim must restore, not repeat mint I/O')
        },
      },
      restoreExactOutputs: async () => {
        restores += 1
        return { receive: [successor] }
      },
    },
    admitAndComplete: async ({ successorProofs }) => reclaimEvidence(reclaim, successorProofs),
  })
  assert.equal(recovered.deliveryState, 'reclaimed')
  assert.equal(restores, 1)
})

test('recovery bounds stored bytes, cursor advancement, proof chunks, and capped retry backoff', () => {
  const transfer = admittedBearerTransfer()
  assert.throws(
    () =>
      planDurableOutgoingCashuRecoveryPage({
        page: { storedBytes: 4097, transfers: [transfer], nextCursor: null },
        limit: 1,
        maximumBytes: 4096,
      }),
    /byte budget/,
  )
  assert.throws(
    () =>
      planDurableOutgoingCashuRecoveryPage({
        page: {
          storedBytes: 1,
          transfers: [transfer],
          nextCursor: { dueAtMs: transfer.recovery.dueAtMs, transferId: transfer.transferId },
        },
        limit: 1,
        maximumBytes: 4096,
      }),
    /does not advance/,
  )
  assert.throws(
    () =>
      planDurableOutgoingCashuRecoveryPage({
        page: {
          storedBytes: 1,
          transfers: [transfer],
          nextCursor: { dueAtMs: 99, transferId: 'next' },
        },
        cursor: { dueAtMs: transfer.recovery.dueAtMs, transferId: transfer.transferId },
        limit: 1,
        maximumBytes: 4096,
      }),
    /repeats the requested cursor/,
  )
  const chunks = planDurableOutgoingCashuProofStateChunks({
    transfers: [
      transfer,
      decodeDurableOutgoingCashuTransfer({ ...transfer, transferId: 'chunk-2' }),
      decodeDurableOutgoingCashuTransfer({ ...transfer, transferId: 'chunk-3' }),
    ],
    maximumCalls: 4,
    maximumProofsPerCall: 128,
  })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]?.proofs.length, 3)
  const capped = scheduleDurableOutgoingCashuRecoveryRetry({
    transfer: decodeDurableOutgoingCashuTransfer({
      ...transfer,
      recovery: { dueAtMs: 0, attemptCount: 99 },
    }),
    nowMs: 100_000,
  })
  assert.equal(capped.recovery.dueAtMs, 100_000 + 60 * 60 * 1_000)
})

test('a 512-proof transfer retains complete custody evidence and splits into exact NUT-07 ranges', () => {
  const transfer = largeAdmittedBearerTransfer()
  assert.throws(
    () =>
      planDurableOutgoingCashuProofStateChunks({
        transfers: [transfer],
        maximumCalls: 3,
        maximumProofsPerCall: 128,
      }),
    /cannot cover one token/,
  )
  const chunks = planDurableOutgoingCashuProofStateChunks({
    transfers: [transfer],
    maximumCalls: 4,
    maximumProofsPerCall: 128,
  })
  assert.equal(chunks.length, 4)
  assert.deepEqual(
    chunks.map((chunk) => chunk.proofAssociations[0]),
    [
      { transferId: transfer.transferId, proofOffset: 0, proofCount: 128 },
      { transferId: transfer.transferId, proofOffset: 128, proofCount: 128 },
      { transferId: transfer.transferId, proofOffset: 256, proofCount: 128 },
      { transferId: transfer.transferId, proofOffset: 384, proofCount: 128 },
    ],
  )
  assert.equal(
    chunks.reduce((total, chunk) => total + chunk.proofs.length, 0),
    512,
  )
  assert.equal(transfer.token?.custodyRevisions.length, 513)

  const stopped = planDurableOutgoingCashuProofStateChunks({
    transfers: [admittedBearerTransfer(), transfer],
    maximumCalls: 4,
    maximumProofsPerCall: 128,
  })
  assert.equal(stopped.length, 1)
  assert.equal(stopped[0]?.proofs.length, 1)
  assert.deepEqual(stopped[0]?.proofAssociations, [
    { transferId: 'transfer-1', proofOffset: 0, proofCount: 1 },
  ])
})

test('coordinator executes once, recovers the persisted send result, and accepts a lost post-mint response', async () => {
  const prepared = createDurableOutgoingCashuTransfer({
    transferId: 'coordinator-1',
    walletScopeId: 'wallet-1',
    requestedAmount: '2',
    walletSendOperation: coordinatorWalletSendOperation(),
    deliveryIntent: {
      policy: 'bearer-spend-classification',
      tokenBytesLimit: 1024,
      tokenProofLimit: 1,
    },
  })
  const mintedSend = hydrateDurableWalletProof(sendProof())
  let swaps = 0
  let postMint = 0
  const persist = async () => {
    postMint += 1
    return admitDurableOutgoingCashuToken({
      transfer: prepared,
      keepProofs: [],
      sendProofs: [sendProof()],
      encodedToken: encodedToken([sendProof()]),
      custodyRevisions: custodyRevisions(prepared.walletSendOperation, [], [sendProof()]),
      dueAtMs: prepared.recovery.dueAtMs,
    })
  }
  const common = {
    transfer: {
      transferId: prepared.transferId,
      walletScopeId: prepared.walletScopeId,
      mintUrl: prepared.mintUrl,
      unit: prepared.unit,
      requestedAmount: prepared.requestedAmount,
      deliveryIntent: prepared.deliveryIntent,
    },
    wallet: {
      checkProofsStates: async (proofs) =>
        proofs.map((proof) => ({
          Y: deriveDurableWalletProofY({ ...sendProof(), secret: proof.secret }),
          state: 'SPENT',
          witness: null,
        })) as never,
      completeSwap: async () => {
        swaps += 1
        return { keep: [], send: [mintedSend] }
      },
    },
    restoreExactOutputs: async () => ({ keep: [], send: [mintedSend] }),
    postMint: { persistMinted: persist },
  }
  const executed = await runDurableOutgoingCashuTransfer({
    ...common,
    preMint: { prepare: async () => prepared },
  })
  assert.equal(executed.deliveryState, 'delivery-pending')
  assert.deepEqual({ swaps, postMint }, { swaps: 1, postMint: 1 })

  const walletOperationStore = {
    loadOperation: async () => ({
      operation: prepared.walletSendOperation,
      state: 'prepared' as const,
      result: null,
    }),
    persistCompletedResult: async () => {
      throw new Error('terminal recovery must not write the send result')
    },
  }
  const recovered = await runDurableOutgoingCashuTransfer({
    ...common,
    mode: 'recover',
    preMint: { prepare: async () => prepared, recover: async () => prepared },
    walletOperationStore,
  })
  assert.equal(recovered.deliveryState, 'delivery-pending')
  assert.deepEqual({ swaps, postMint }, { swaps: 1, postMint: 2 })

  const lostResponse = await runDurableOutgoingCashuTransfer({
    ...common,
    mode: 'recover',
    preMint: { prepare: async () => prepared, recover: async () => executed },
    walletOperationStore,
  })
  assert.equal(lostResponse.deliveryState, 'delivery-pending')
  assert.deepEqual({ swaps, postMint }, { swaps: 1, postMint: 2 })

  const foreignOperation = decodeDurableWalletOperation({
    ...prepared.walletSendOperation,
    operationId: 'foreign-wallet-send',
  })
  await assert.rejects(
    runDurableOutgoingCashuTransfer({
      ...common,
      mode: 'recover',
      preMint: { prepare: async () => prepared, recover: async () => prepared },
      walletOperationStore: {
        ...walletOperationStore,
        loadOperation: async () => ({
          operation: foreignOperation,
          state: 'prepared' as const,
          result: null,
        }),
      },
    }),
    /identity is foreign/,
  )
  assert.deepEqual({ swaps, postMint }, { swaps: 1, postMint: 2 })
})

function preparedReclaim(reclaimId: string) {
  const admitted = admittedBearerTransfer()
  const Y = deriveDurableWalletProofY(admitted.token!.proofs[0]!)
  return prepareDurableOutgoingCashuReclaim({
    transfer: admitted,
    reclaimId,
    states: [{ Y, state: 'UNSPENT' }],
    dueAtMs: 11,
    walletReceiveOperation: reclaimOperation(reclaimId, admitted.token!.proofs),
  })
}

function successorProof(reclaim: ReturnType<typeof preparedReclaim>) {
  const output = reclaim.reclaim!.walletReceiveOperation.preview.keepOutputs[0]!
  return hydrateDurableWalletProof({
    id: output.blindedMessage.id,
    amount: output.blindedMessage.amount,
    secret: output.secret,
    C: TOKEN_C,
    dleq: null,
    p2pkE: null,
    witness: null,
  })
}

function reclaimEvidence(
  reclaim: ReturnType<typeof preparedReclaim>,
  successorProofs: readonly ReturnType<typeof successorProof>[],
) {
  return {
    transferId: reclaim.transferId,
    reclaimId: reclaim.reclaim!.reclaimId,
    walletReceiveOperationAuthority: deriveDurableWalletOperationAuthority(
      reclaim.reclaim!.walletReceiveOperation,
    ),
    successorProofFingerprint: deriveDurableCustodyArtifactFingerprint(
      successorProofs.map((proof) => ({
        id: proof.id,
        amount: proof.amount.toString(),
        secret: proof.secret,
        C: proof.C,
        dleq: proof.dleq === undefined ? null : proof.dleq,
        p2pkE: proof.p2pk_e ?? null,
        witness: proof.witness ?? null,
      })),
    ),
    custodyRevisions: [...reclaim.reclaim!.proofs, ...successorProofs].map((proof) => ({
      proofIdentity: deriveDurableCustodyArtifactFingerprint({
        id: proof.id,
        secret: proof.secret,
        C: proof.C,
      }),
      revision: 4,
    })),
  }
}

function bearerTransfer() {
  return createDurableOutgoingCashuTransfer({
    transferId: 'transfer-1',
    walletScopeId: 'wallet-1',
    requestedAmount: '2',
    walletSendOperation: walletSendOperation(),
    deliveryIntent: {
      policy: 'bearer-spend-classification',
      tokenBytesLimit: 1024,
      tokenProofLimit: 1,
    },
  })
}

function largeAdmittedBearerTransfer() {
  const operation = decodeDurableWalletOperation({
    schemaVersion: 1,
    operationId: 'wallet-send-512',
    kind: 'wallet-send',
    mintUrl: 'https://mint.example',
    unit: 'sat',
    preview: {
      amount: '512',
      fees: '0',
      keysetId: KEYSET_ID,
      inputs: [
        {
          id: KEYSET_ID,
          amount: '512',
          secret: 'input-512',
          C: TOKEN_C,
          dleq: null,
          p2pkE: null,
          witness: null,
        },
      ],
      sendOutputs: Array.from({ length: 512 }, (_, index) => ({
        blindedMessage: { amount: '1', id: KEYSET_ID, B_: `send-blinded-512-${index}` },
        blindingFactor: String(index + 1),
        secret: `send-512-${index}`,
        ephemeralE: null,
      })),
      keepOutputs: [],
      unselectedProofs: [],
    },
  })
  if (operation.kind !== 'wallet-send') throw new Error('fixture operation is invalid')
  const transfer = createDurableOutgoingCashuTransfer({
    transferId: 'transfer-512',
    walletScopeId: 'wallet-1',
    requestedAmount: '512',
    walletSendOperation: operation,
    deliveryIntent: {
      policy: 'bearer-spend-classification',
      tokenBytesLimit: 100_000,
      tokenProofLimit: 512,
    },
  })
  const proofs = operation.preview.sendOutputs.map((output) => ({
    id: output.blindedMessage.id,
    amount: output.blindedMessage.amount,
    secret: output.secret,
    C: TOKEN_C,
    dleq: null,
    p2pkE: null,
    witness: null,
  }))
  return admitDurableOutgoingCashuToken({
    transfer,
    keepProofs: [],
    sendProofs: proofs,
    encodedToken: encodedToken(proofs),
    custodyRevisions: custodyRevisions(operation, [], proofs),
    dueAtMs: 10,
  })
}

function admittedBearerTransfer() {
  return admitDurableOutgoingCashuToken({
    transfer: bearerTransfer(),
    keepProofs: [],
    sendProofs: [sendProof()],
    encodedToken: encodedToken([sendProof()]),
    custodyRevisions: custodyRevisions(bearerTransfer().walletSendOperation, [], [sendProof()]),
    dueAtMs: 10,
  })
}

function walletSendOperation(): DurableWalletSendOperation {
  const operation = decodeDurableWalletOperation({
    schemaVersion: 1,
    operationId: 'wallet-send-1',
    kind: 'wallet-send',
    mintUrl: 'https://mint.example',
    unit: 'sat',
    preview: {
      amount: '2',
      fees: '0',
      keysetId: KEYSET_ID,
      inputs: [
        {
          id: KEYSET_ID,
          amount: '2',
          secret: 'input-secret',
          C: 'input-signature',
          dleq: null,
          p2pkE: null,
          witness: null,
        },
      ],
      sendOutputs: [
        {
          blindedMessage: { amount: '2', id: KEYSET_ID, B_: 'send-blinded' },
          blindingFactor: '1',
          secret: 'send-secret',
          ephemeralE: null,
        },
      ],
      keepOutputs: [],
      unselectedProofs: [],
    },
  })
  if (operation.kind !== 'wallet-send') throw new Error('fixture operation is invalid')
  return operation
}

function coordinatorWalletSendOperation() {
  return serializeDurableWalletSendOperation({
    operationId: 'wallet-send-coordinator',
    mintUrl: 'https://mint.example',
    unit: 'sat',
    preview: {
      amount: Amount.from(2),
      fees: Amount.zero(),
      keysetId: KEYSET_ID,
      inputs: [
        hydrateDurableWalletProof({
          id: KEYSET_ID,
          amount: '2',
          secret: 'input-coordinator',
          C: TOKEN_C,
          dleq: null,
          p2pkE: null,
          witness: null,
        }),
      ],
      sendOutputs: [OutputData.createSingleData('2', KEYSET_ID, 'send-secret', 5n)],
      keepOutputs: [],
    },
  })
}

function twoOutputWalletSendOperation(): DurableWalletSendOperation {
  const operation = decodeDurableWalletOperation({
    schemaVersion: 1,
    operationId: 'wallet-send-2',
    kind: 'wallet-send',
    mintUrl: 'https://mint.example',
    unit: 'sat',
    preview: {
      amount: '2',
      fees: '0',
      keysetId: KEYSET_ID,
      inputs: [
        {
          id: KEYSET_ID,
          amount: '2',
          secret: 'input-secret-2',
          C: 'input-signature-2',
          dleq: null,
          p2pkE: null,
          witness: null,
        },
      ],
      sendOutputs: [
        {
          blindedMessage: { amount: '1', id: KEYSET_ID, B_: 'send-blinded-1' },
          blindingFactor: '1',
          secret: 'send-secret',
          ephemeralE: null,
        },
        {
          blindedMessage: { amount: '1', id: KEYSET_ID, B_: 'send-blinded-2' },
          blindingFactor: '2',
          secret: 'second-send-secret',
          ephemeralE: null,
        },
      ],
      keepOutputs: [],
      unselectedProofs: [],
    },
  })
  if (operation.kind !== 'wallet-send') throw new Error('fixture operation is invalid')
  return operation
}

function sendProof(): DurableWalletProof {
  return {
    id: KEYSET_ID,
    amount: '2',
    secret: 'send-secret',
    C: TOKEN_C,
    dleq: null,
    p2pkE: null,
    witness: null,
  }
}

function secondSendProof(): DurableWalletProof {
  return {
    id: KEYSET_ID,
    amount: '1',
    secret: 'second-send-secret',
    C: SECOND_TOKEN_C,
    dleq: null,
    p2pkE: null,
    witness: null,
  }
}

function partialFirstSendProof(): DurableWalletProof {
  return {
    id: KEYSET_ID,
    amount: '1',
    secret: 'send-secret',
    C: TOKEN_C,
    dleq: null,
    p2pkE: null,
    witness: null,
  }
}

function encodedToken(proofs: readonly DurableWalletProof[]): string {
  return getEncodedTokenV4({
    mint: 'https://mint.example',
    unit: 'sat',
    proofs: proofs.map(hydrateDurableWalletProof),
  })
}

function custodyRevisions(
  operation: DurableWalletSendOperation,
  keep: readonly DurableWalletProof[],
  send: readonly DurableWalletProof[],
) {
  return [...operation.preview.inputs, ...keep, ...send].map((proof) => ({
    proofIdentity: deriveDurableCustodyArtifactFingerprint({
      id: proof.id,
      secret: proof.secret,
      C: proof.C,
    }),
    revision: 2,
  }))
}

function reclaimOperation(operationId: string, inputs: readonly DurableWalletProof[]) {
  return serializeDurableWalletReceiveOperation({
    operationId,
    mintUrl: 'https://mint.example',
    unit: 'sat',
    preview: {
      amount: Amount.from(inputs.reduce((total, proof) => total + BigInt(proof.amount), 0n)),
      fees: Amount.zero(),
      keysetId: KEYSET_ID,
      inputs: inputs.map(hydrateDurableWalletProof),
      keepOutputs: [
        OutputData.createSingleData('2', KEYSET_ID, `reclaim-successor-${operationId}`, 3n),
      ],
    },
  })
}
