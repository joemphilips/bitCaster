import assert from 'node:assert/strict'
import { test } from 'node:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  canSalvageDurableRefund,
  classifyDurableTradeRecoveryDisposition,
  createDurableTradeExpectedProofOperation,
  createDurableTradeProofOperationLink,
  deriveDurableProofOperationId,
  recoverDurableTradeSessions,
  isDurableTradeSessionPurgeEligible,
  resumeDurableTradeSession,
  reduceDurableTradeSession,
  scanDurableTradeRecoveryLinks,
  validateDurableTradeSession,
  validateDurableTradePendingIntent,
  validateDurableTradePrivateKeyBinding,
  verifyDurableTradeSessionCipherIntegrity,
  type DurableRefundSalvageEvidence,
  type DurableProofOperationRepository,
  type DurableTradeMintRecoveryState,
  type DurableTradeRecoveryPorts,
  type DurableTradeProofOperationLink,
  type DurableTradeSessionRepository,
  type DurableTradeSession,
} from '../src/durableTradeRecovery.ts'

const LOCAL_PROTOCOL_PUBKEY = 'a'.repeat(64)
const COUNTERPARTY_PROTOCOL_PUBKEY = 'b'.repeat(64)
const REFUND_PRIVATE_KEY = '01'.repeat(32)
const REFUND_PROTOCOL_PUBKEY = Array.from(
  secp256k1.getPublicKey(new Uint8Array(32).fill(1), true),
).map((part) => part.toString(16).padStart(2, '0')).join('')

function session(
  overrides: Partial<DurableTradeSession> = {},
): DurableTradeSession {
  const tradeId = overrides.tradeId ?? 'trade-001'
  const role = overrides.role ?? 'seller'
  const mintUrl = overrides.mintUrl ?? 'https://mint.example'
  const sellerLocktimeSecs = overrides.sellerLocktimeSecs ?? 120
  const buyerLocktimeSecs = overrides.buyerLocktimeSecs ?? 100
  const localProtocolPubkey = overrides.localProtocolPubkey ?? LOCAL_PROTOCOL_PUBKEY
  const counterpartyProtocolPubkey =
    overrides.counterpartyProtocolPubkey ?? COUNTERPARTY_PROTOCOL_PUBKEY

  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId,
    role,
    localProtocolPubkey,
    counterpartyProtocolPubkey,
    mintUrl,
    sellerLocktimeSecs,
    buyerLocktimeSecs,
    ephemeralKeyHandle: {
      keyId: 'ephemeral-key-001',
      tradeId,
      role,
      localProtocolPubkey,
      counterpartyProtocolPubkey,
      mintUrl,
      sellerLocktimeSecs,
      buyerLocktimeSecs,
    },
    stage: 'intent',
    proofOperations: [],
    receivedCiphers: {},
    outboundCiphers: {},
    ...overrides,
  }
}

function preparedOperation(
  tradeId = 'trade-001',
  role: DurableTradeSession['role'] = 'seller',
): DurableTradeProofOperationLink {
  return {
    operationId: deriveDurableProofOperationId(tradeId, role, 'proof-reservation'),
    tradeId,
    role,
    stage: 'proof-reservation',
    state: 'prepared',
  }
}

function expectedOperation(operation: DurableTradeProofOperationLink) {
  return createDurableTradeExpectedProofOperation({
    tradeId: operation.tradeId,
    role: operation.role,
    stage: operation.stage,
    operationKey: operation.operationKey ?? 'legacy-operation-key-is-not-relinkable',
  })
}

function dependentContext(mergeOperationKey: string, lockOperationKey: string) {
  return {
    contextVersion: 1 as const,
    tradeId: 'trade-001',
    role: 'buyer' as const,
    localProtocolPubkey: LOCAL_PROTOCOL_PUBKEY,
    counterpartyProtocolPubkey: COUNTERPARTY_PROTOCOL_PUBKEY,
    mintUrl: 'https://mint.example',
    sellerLocktimeSecs: 120,
    buyerLocktimeSecs: 100,
    conditionId: 'condition-001',
    ammScopeId: 'condition-001',
    inventoryAccountId: 'condition:001',
    baseAsset: 'sat',
    unit: 'sat',
    outcomeSetCommitment: 'a'.repeat(64),
    keysetCommitment: 'b'.repeat(64),
    feeCommitment: 'c'.repeat(64),
    mergeInputCommitment: 'd'.repeat(64),
    expectedOutputCommitment: 'e'.repeat(64),
    mergeOperationKey,
    lockOperationKey,
  }
}

test('deterministic proof-operation identifiers bind trade, role, and stage', () => {
  const sellerReservation = deriveDurableProofOperationId(
    'trade-001',
    'seller',
    'proof-reservation',
  )

  assert.equal(
    sellerReservation,
    'trade-recovery:trade-001:seller:proof-reservation',
  )
  assert.notEqual(
    sellerReservation,
    deriveDurableProofOperationId('trade-001', 'buyer', 'proof-reservation'),
  )
  assert.notEqual(
    sellerReservation,
    deriveDurableProofOperationId('trade-001', 'seller', 'refund'),
  )
})

test('a client operation key is bound into the SDK recovery identity', () => {
  const operation = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'trade-001/browser/seller-lock',
  })

  assert.equal(operation.operationKey, 'trade-001/browser/seller-lock')
  assert.equal(
    operation.operationId,
    deriveDurableProofOperationId(
      'trade-001',
      'seller',
      'proof-reservation',
      'trade-001/browser/seller-lock',
    ),
  )
  assert.match(
    validateDurableTradeSession(session({
      stage: 'proof-reserved',
      proofOperations: [{ ...operation, operationKey: 'different-operation' }],
    })) ?? '',
    /not bound/,
  )
})

test('new durable proof-operation links require the retained operation key', () => {
  assert.throws(
    () => createDurableTradeProofOperationLink({
      tradeId: 'trade-001',
      role: 'seller',
      stage: 'proof-reservation',
      state: 'prepared',
    } as never),
    /operation key is invalid/,
  )
})

test('a pending trade intent validates only the pre-TradeCreated durable binding', () => {
  const intent = {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    tradeId: 'trade-001',
    orderId: 'order-001',
    marketId: 'condition-YES',
    localProtocolPubkey: `02${LOCAL_PROTOCOL_PUBKEY}`,
    deadline: '2026-07-10T12:00:00.000Z',
  }

  assert.equal(validateDurableTradePendingIntent(intent), null)
  assert.match(
    validateDurableTradePendingIntent({ ...intent, deadline: 'not-a-date' }) ?? '',
    /deadline/,
  )
  assert.match(
    validateDurableTradePendingIntent({ ...intent, localProtocolPubkey: 'x' }) ?? '',
    /public key/,
  )
})

test('private recovery material must derive the persisted protocol public key', () => {
  const privateKey = '01'.repeat(32)
  const publicKey = Array.from(secp256k1.getPublicKey(new Uint8Array(32).fill(1), true))
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('')

  assert.equal(validateDurableTradePrivateKeyBinding(privateKey, publicKey), null)
  assert.match(
    validateDurableTradePrivateKeyBinding(privateKey, `02${'b'.repeat(64)}`) ?? '',
    /does not match/,
  )
})

test('write-ahead reducer retains the operation link through mint submission and reconciliation', () => {
  const prepared = reduceDurableTradeSession(session(), {
    kind: 'proof-operation-prepared',
    operation: preparedOperation(),
  })
  assert.equal(prepared.stage, 'proof-reserved')
  assert.equal(prepared.revision, 1)
  assert.equal(prepared.proofOperations[0]?.state, 'prepared')

  const submitted = reduceDurableTradeSession(prepared, {
    kind: 'mint-submitted',
    operationId: prepared.proofOperations[0]!.operationId,
  })
  assert.equal(submitted.stage, 'mint-submitted')
  assert.equal(submitted.proofOperations[0]?.state, 'mint-submitted')

  const reconciled = reduceDurableTradeSession(submitted, {
    kind: 'proof-operation-reconciled',
    operationId: submitted.proofOperations[0]!.operationId,
  })
  assert.equal(reconciled.stage, 'reconciliation-complete')
  assert.equal(isDurableTradeSessionPurgeEligible(reconciled), true)
})

test('v2 keeps a planned buyer lock waiting after merge reconciliation, then activates and completes it', async () => {
  const merge = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'buyer',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'condition-001:trade-001:buyer-ctf-merge',
    kind: 'condition-ctf-merge',
  } as never)
  const lockOperationKey = 'condition-001:trade-001:buyer-sat-lock'
  const lockOperationId = deriveDurableProofOperationId(
    'trade-001',
    'buyer',
    'proof-reservation',
    lockOperationKey,
    'cashu-atomic',
  )
  const plannedLock = {
    operationId: lockOperationId,
    operationKey: lockOperationKey,
    kind: 'cashu-atomic',
    stage: 'proof-reservation',
    dependsOnOperationId: merge.operationId,
    context: dependentContext(merge.operationKey!, lockOperationKey),
  }
  const v2 = session({ schemaVersion: 2 as never, role: 'buyer' })
  const planned = reduceDurableTradeSession(v2, {
    kind: 'dependent-operations-planned',
    active: {
      ...createDurableTradeExpectedProofOperation({
        tradeId: 'trade-001',
        role: 'buyer',
        stage: 'proof-reservation',
        operationKey: merge.operationKey!,
        kind: 'condition-ctf-merge',
      } as never),
    },
    plan: plannedLock,
  } as never)
  const mergePrepared = reduceDurableTradeSession(planned, {
    kind: 'proof-operation-prepared',
    operation: merge,
  })
  const mergeSubmitted = reduceDurableTradeSession(mergePrepared, {
    kind: 'mint-submitted', operationId: merge.operationId,
  })
  const waiting = reduceDurableTradeSession(mergeSubmitted, {
    kind: 'proof-operation-reconciled', operationId: merge.operationId,
  })
  assert.equal(waiting.stage, 'awaiting-dependent-operation')
  assert.equal(isDurableTradeSessionPurgeEligible(waiting), false)
  assert.equal(waiting.plannedProofOperations?.length, 1)
  const waitingFixture = recoveryFixture({
    sessions: [waiting],
    operations: [{ ...merge, state: 'reconciled' }],
  })
  assert.deepEqual((await recoverDurableTradeSessions(waitingFixture.ports)).sessions, [{
    kind: 'awaiting-dependent-operation',
    tradeId: 'trade-001',
    operationIds: [lockOperationId],
  }])
  assert.deepEqual(waitingFixture.calls, [])

  const activated = reduceDurableTradeSession(waiting, {
    kind: 'dependent-operation-activated', operationId: lockOperationId,
  } as never)
  assert.equal(activated.stage, 'proof-reserved')
  assert.equal(activated.plannedProofOperations?.length, 0)
  assert.equal(activated.expectedProofOperations?.[1]?.operationId, lockOperationId)

  const lock = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'buyer',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: lockOperationKey,
    kind: 'cashu-atomic',
  } as never)
  const lockPrepared = reduceDurableTradeSession(activated, {
    kind: 'proof-operation-prepared', operation: lock,
  })
  const lockSubmitted = reduceDurableTradeSession(lockPrepared, {
    kind: 'mint-submitted', operationId: lock.operationId,
  })
  const complete = reduceDurableTradeSession(lockSubmitted, {
    kind: 'proof-operation-reconciled', operationId: lock.operationId,
  })
  assert.equal(complete.stage, 'reconciliation-complete')
  assert.equal(isDurableTradeSessionPurgeEligible(complete), true)
})

test('v2 rejects invalid dependent graphs and early activation', () => {
  const merge = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'buyer',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'condition-001:trade-001:buyer-ctf-merge',
    kind: 'condition-ctf-merge',
  } as never)
  const early = session({
    schemaVersion: 2 as never,
    role: 'buyer',
    expectedProofOperations: [createDurableTradeExpectedProofOperation({
      tradeId: 'trade-001',
      role: 'buyer',
      stage: 'proof-reservation',
      operationKey: merge.operationKey!,
      kind: 'condition-ctf-merge',
    } as never)],
    proofOperations: [{ ...merge, state: 'prepared' }],
    plannedProofOperations: [{
      operationId: deriveDurableProofOperationId(
        'trade-001',
        'buyer',
        'proof-reservation',
        'lock',
        'cashu-atomic',
      ),
      operationKey: 'lock',
      kind: 'cashu-atomic',
      stage: 'proof-reservation',
      dependsOnOperationId: merge.operationId,
      context: dependentContext(merge.operationKey!, 'lock'),
    }],
  } as never)
  assert.throws(
    () => reduceDurableTradeSession(early, {
      kind: 'dependent-operation-activated',
      operationId: early.plannedProofOperations![0]!.operationId,
    } as never),
    /waiting session/,
  )
  assert.match(
    validateDurableTradeSession({
      ...early,
      plannedProofOperations: [{
        ...early.plannedProofOperations![0]!,
        dependsOnOperationId: 'missing-operation',
      }],
    }) ?? '',
    /dependency/,
  )
  const secondPlan = {
    ...early.plannedProofOperations![0]!,
    operationKey: 'lock-2',
    operationId: deriveDurableProofOperationId(
      'trade-001',
      'buyer',
      'proof-reservation',
      'lock-2',
      'cashu-atomic',
    ),
    dependsOnOperationId: early.plannedProofOperations![0]!.operationId,
    context: dependentContext(merge.operationKey!, 'lock-2'),
  }
  assert.match(
    validateDurableTradeSession({
      ...early,
      plannedProofOperations: [{
        ...early.plannedProofOperations![0]!,
        dependsOnOperationId: secondPlan.operationId,
      }, secondPlan],
    }) ?? '',
    /exactly one planned lock/,
  )
  assert.match(
    validateDurableTradeSession({
      ...early,
      plannedProofOperations: [early.plannedProofOperations![0]!, secondPlan],
    }) ?? '',
    /exactly one planned lock/,
  )
  assert.match(
    validateDurableTradeSession({
      ...early,
      expectedProofOperations: [
        early.expectedProofOperations![0]!,
        createDurableTradeExpectedProofOperation({
          tradeId: 'trade-001',
          role: 'buyer',
          stage: 'proof-reservation',
          operationKey: 'extra-active',
          kind: 'cashu-atomic',
        } as never),
      ],
    }) ?? '',
    /exactly one active merge/,
  )
  assert.match(
    validateDurableTradeSession({
      ...early,
      expectedProofOperations: [
        early.expectedProofOperations![0]!,
        createDurableTradeExpectedProofOperation({
          tradeId: 'trade-001',
          role: 'buyer',
          stage: 'proof-reservation',
          operationKey: merge.operationKey!,
          kind: 'cashu-atomic',
        } as never),
      ],
    }) ?? '',
    /duplicate expected proof operation keys/,
  )
  assert.match(
    validateDurableTradeSession({
      ...early,
      plannedProofOperations: [{
        ...early.plannedProofOperations![0]!,
        context: {
          ...early.plannedProofOperations![0]!.context,
          tradeId: 'foreign-trade',
        },
      }],
    }) ?? '',
    /context is invalid/,
  )
  assert.match(
    validateDurableTradeSession({
      ...early,
      plannedProofOperations: [{
        ...early.plannedProofOperations![0]!,
        context: {
          ...early.plannedProofOperations![0]!.context,
          expectedOutputCommitment: 'not-a-commitment',
        },
      }],
    }) ?? '',
    /context is invalid/,
  )
  assert.throws(
    () => reduceDurableTradeSession(session({ schemaVersion: 2 as never, role: 'buyer' }), {
      kind: 'dependent-operations-planned',
      active: createDurableTradeExpectedProofOperation({
        tradeId: 'trade-001',
        role: 'buyer',
        stage: 'proof-reservation',
        operationKey: merge.operationKey!,
        kind: 'cashu-atomic',
      } as never),
      plan: early.plannedProofOperations![0]!,
    } as never),
    /dependent operation plan is invalid/,
  )

})

test('outbound cipher journal replay is byte-identical and rejects replacement ciphertext', () => {
  const journaled = reduceDurableTradeSession(session(), {
    kind: 'outbound-cipher-journaled',
    messageType: 'adaptor-point',
    ciphertext: 'cipher-a',
    sha256: 'c'.repeat(64),
  })
  const replay = reduceDurableTradeSession(journaled, {
    kind: 'outbound-cipher-journaled',
    messageType: 'adaptor-point',
    ciphertext: 'cipher-a',
    sha256: 'c'.repeat(64),
  })

  assert.equal(replay, journaled)
  assert.throws(
    () => reduceDurableTradeSession(journaled, {
      kind: 'outbound-cipher-journaled',
      messageType: 'adaptor-point',
      ciphertext: 'cipher-b',
      sha256: 'd'.repeat(64),
    }),
    /different ciphertext/,
  )
})

test('session validation fails closed for an unknown schema or foreign protocol-key binding', () => {
  assert.match(
    validateDurableTradeSession({ ...session(), schemaVersion: 1 }) ?? '',
    /schema version/,
  )
  assert.match(
    validateDurableTradeSession({ ...session(), schemaVersion: 99 }) ?? '',
    /schema version/,
  )
  assert.match(
    validateDurableTradeSession(session({
      ephemeralKeyHandle: {
        ...session().ephemeralKeyHandle,
        counterpartyProtocolPubkey: 'c'.repeat(64),
      },
    })) ?? '',
    /key handle binding/,
  )
})

test('cipher integrity validation rejects altered persisted ciphertext before recovery acts', async () => {
  const valid = reduceDurableTradeSession(session(), {
    kind: 'received-cipher-recorded',
    messageType: 'locked-proofs-seller',
    ciphertext: 'cipher-a',
    sha256: 'a'.repeat(64),
  })

  assert.equal(
    await verifyDurableTradeSessionCipherIntegrity(valid, async () => 'a'.repeat(64)),
    null,
  )
  assert.match(
    await verifyDurableTradeSessionCipherIntegrity(valid, async () => 'b'.repeat(64)) ?? '',
    /cipher hash mismatch/,
  )
})

test('recovery scan finds both a missing session link and a separately persisted orphan operation', () => {
  const linked = preparedOperation()
  const scan = scanDurableTradeRecoveryLinks({
    sessions: [session({
      stage: 'proof-reserved',
      proofOperations: [linked],
    })],
    operations: [
      {
        ...linked,
        operationId: deriveDurableProofOperationId('trade-002', 'buyer', 'refund'),
        tradeId: 'trade-002',
        role: 'buyer',
        stage: 'refund',
      },
    ],
  })

  assert.deepEqual(scan.missingOperations, [linked.operationId])
  assert.deepEqual(scan.orphanOperations, [
    deriveDurableProofOperationId('trade-002', 'buyer', 'refund'),
  ])
})

test('corrupt session cannot resume, but independently bound post-locktime evidence can salvage only its refund', () => {
  const evidence: DurableRefundSalvageEvidence = {
    tradeId: 'trade-001',
    role: 'seller',
    localProtocolPubkey: LOCAL_PROTOCOL_PUBKEY,
    counterpartyProtocolPubkey: COUNTERPARTY_PROTOCOL_PUBKEY,
    mintUrl: 'https://mint.example',
    sellerLocktimeSecs: 120,
    buyerLocktimeSecs: 100,
    keyHandle: session().ephemeralKeyHandle,
    proofOperation: {
      operationId: deriveDurableProofOperationId('trade-001', 'seller', 'refund'),
      tradeId: 'trade-001',
      role: 'seller',
      stage: 'refund',
      state: 'mint-submitted',
    },
  }

  assert.notEqual(validateDurableTradeSession({ ...session(), revision: -1 }), null)
  assert.equal(canSalvageDurableRefund(evidence, 119), false)
  assert.equal(canSalvageDurableRefund(evidence, 120), true)
  assert.equal(canSalvageDurableRefund({
    ...evidence,
    proofOperation: { ...evidence.proofOperation, state: 'prepared' },
  }, 120), false)
  assert.equal(canSalvageDurableRefund({
    ...evidence,
    keyHandle: {
      ...evidence.keyHandle,
      localProtocolPubkey: 'd'.repeat(64),
    },
  }, 120), false)
})

test('a session remains non-purgeable until every linked operation is reconciled', () => {
  const prepared = reduceDurableTradeSession(session(), {
    kind: 'proof-operation-prepared',
    operation: preparedOperation(),
  })
  assert.equal(isDurableTradeSessionPurgeEligible(prepared), false)
})

test('recovery rejoins then replays only journalled outbound ciphers in protocol order', async () => {
  const journaled = reduceDurableTradeSession(
    reduceDurableTradeSession(session(), {
      kind: 'outbound-cipher-journaled',
      messageType: 'locked-proofs-seller',
      ciphertext: 'seller-cipher',
      sha256: 'a'.repeat(64),
    }),
    {
      kind: 'outbound-cipher-journaled',
      messageType: 'adaptor-point',
      ciphertext: 'adaptor-cipher',
      sha256: 'b'.repeat(64),
    },
  )
  const calls: string[] = []

  const result = await resumeDurableTradeSession(journaled, {
    joinTrade: async (tradeId) => { calls.push(`join:${tradeId}`) },
    sendCipher: async (_tradeId, messageType, ciphertext) => {
      calls.push(`${messageType}:${ciphertext}`)
    },
  })

  assert.equal(result.kind, 'replayed')
  assert.deepEqual(calls, [
    'join:trade-001',
    'adaptor-point:adaptor-cipher',
    'locked-proofs-seller:seller-cipher',
  ])
})

test('recovery fails closed before joining or sending an invalid durable session', async () => {
  const calls: string[] = []
  const result = await resumeDurableTradeSession(
    { ...session(), schemaVersion: 99 },
    {
      joinTrade: async () => { calls.push('join') },
      sendCipher: async () => { calls.push('send') },
    },
  )

  assert.equal(result.kind, 'invalid-session')
  assert.deepEqual(calls, [])
})

test('the coordinator disposition table is pure, exhaustive, and never retries terminal or ambiguous mint states', () => {
  assert.deepEqual(
    classifyDurableTradeRecoveryDisposition('prepared-unspent'),
    { action: 'resume-exact-prepared-operation' },
  )
  assert.deepEqual(
    classifyDurableTradeRecoveryDisposition('prepared-spent-restorable'),
    { action: 'restore-exact-persisted-outputs' },
  )
  assert.deepEqual(
    classifyDurableTradeRecoveryDisposition('pending-or-mixed'),
    { action: 'backoff', reason: 'pending-or-mixed' },
  )
  assert.deepEqual(
    classifyDurableTradeRecoveryDisposition('mint-response-unknown'),
    { action: 'backoff', reason: 'mint-response-unknown' },
  )
  assert.deepEqual(
    classifyDurableTradeRecoveryDisposition('engine-terminal'),
    { action: 'await-refund-salvage' },
  )
  assert.deepEqual(
    classifyDurableTradeRecoveryDisposition('corrupt'),
    { action: 'fail-closed', reason: 'corrupt' },
  )
})

test('the coordinator restores spent prepared outputs, reconciles both stores, then replays only the journalled bytes', async () => {
  const operation = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'gui:trade-001:seller-lock',
  })
  const durableSession = reduceDurableTradeSession(
    session(),
    { kind: 'proof-operation-prepared', operation },
  )
  const journalled = reduceDurableTradeSession(durableSession, {
    kind: 'outbound-cipher-journaled',
    messageType: 'adaptor-point',
    ciphertext: 'journalled-adaptor-cipher',
    sha256: 'a'.repeat(64),
  })
  const fixture = recoveryFixture({ sessions: [journalled], operations: [operation] })
  fixture.mint.next = 'prepared-spent-restorable'

  const result = await recoverDurableTradeSessions(fixture.ports)

  assert.deepEqual(fixture.calls, [
    `restore:${operation.operationId}`,
    `reconciled:${operation.operationId}`,
    'join:trade-001',
    'send:adaptor-point:journalled-adaptor-cipher',
  ])
  assert.equal(result.sessions[0]?.kind, 'replayed')
  assert.equal(fixture.sessions.get('trade-001')?.stage, 'reconciliation-complete')
  assert.equal(fixture.operations.get(operation.operationId)?.state, 'reconciled')
})

test('the coordinator resumes an unspent operation exactly once and repairs a stale session link through CAS', async () => {
  const operation = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'daemon:trade-001:seller-lock',
  })
  const preparedSession = reduceDurableTradeSession(session(), {
    kind: 'proof-operation-prepared',
    operation,
  })
  const staleSession: DurableTradeSession = {
    ...preparedSession,
    revision: preparedSession.revision + 1,
    stage: 'mint-submitted',
    proofOperations: [{ ...operation, state: 'mint-submitted' }],
  }
  const fixture = recoveryFixture({ sessions: [staleSession], operations: [operation] })
  fixture.mint.next = 'prepared-unspent'

  const result = await recoverDurableTradeSessions(fixture.ports)

  assert.deepEqual(fixture.calls, [
    `submitted:${operation.operationId}`,
    `resume:${operation.operationId}`,
    `reconciled:${operation.operationId}`,
    'join:trade-001',
  ])
  assert.equal(result.sessions[0]?.kind, 'ready')
  assert.equal(fixture.operations.get(operation.operationId)?.state, 'reconciled')
  assert.equal(fixture.sessions.get('trade-001')?.proofOperations[0]?.state, 'reconciled')
})

test('the coordinator uses and validates an adapter atomic transition without fallback CAS', async () => {
  const operation = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'wallet:trade-001:atomic-lock',
  })
  const durableSession = reduceDurableTradeSession(session(), {
    kind: 'proof-operation-prepared',
    operation,
  })
  const fixture = recoveryFixture({ sessions: [durableSession], operations: [operation] })
  fixture.mint.next = 'prepared-unspent'
  let fallbackCasCalls = 0
  const fallbackCas = fixture.ports.sessions.compareAndSwap
  fixture.ports.sessions.compareAndSwap = async (...args) => {
    fallbackCasCalls += 1
    return fallbackCas(...args)
  }
  const transitions: string[] = []
  fixture.ports.atomicTransition = {
    advance: async ({ session: current, operation: currentOperation, state }) => {
      transitions.push(state)
      const nextOperation = { ...currentOperation, state }
      const nextSession = reduceDurableTradeSession(current,
        state === 'mint-submitted'
          ? { kind: 'mint-submitted', operationId: currentOperation.operationId }
          : { kind: 'proof-operation-reconciled', operationId: currentOperation.operationId },
      )
      fixture.sessions.set(nextSession.tradeId, nextSession)
      fixture.operations.set(nextOperation.operationId, nextOperation)
      return { session: nextSession, operation: nextOperation }
    },
  }

  const result = await recoverDurableTradeSessions(fixture.ports)

  assert.deepEqual(transitions, ['mint-submitted', 'reconciled'])
  assert.equal(fallbackCasCalls, 0)
  assert.deepEqual(fixture.calls, [
    `resume:${operation.operationId}`,
    'join:trade-001',
  ])
  assert.equal(result.sessions[0]?.kind, 'ready')
  assert.equal(fixture.sessions.get('trade-001')?.proofOperations[0]?.state, 'reconciled')
  assert.equal(fixture.operations.get(operation.operationId)?.state, 'reconciled')

  const invalid = recoveryFixture({ sessions: [durableSession], operations: [operation] })
  invalid.mint.next = 'prepared-unspent'
  invalid.ports.atomicTransition = {
    advance: async ({ session: current, operation: currentOperation, state }) => {
      const nextSession = reduceDurableTradeSession(current,
        state === 'mint-submitted'
          ? { kind: 'mint-submitted', operationId: currentOperation.operationId }
          : { kind: 'proof-operation-reconciled', operationId: currentOperation.operationId },
      )
      return {
        session: { ...nextSession, mintUrl: 'https://foreign.example' },
        operation: { ...currentOperation, state },
      }
    },
  }
  assert.deepEqual(await recoverDurableTradeSessions(invalid.ports).then((value) => value.sessions), [{
    kind: 'failed-closed',
    tradeId: 'trade-001',
    reason: 'session-cas-conflict',
  }])
  assert.deepEqual(invalid.calls, [])

  const submittedOperation = { ...operation, state: 'mint-submitted' as const }
  const submittedSession = reduceDurableTradeSession(
    reduceDurableTradeSession(session(), {
      kind: 'proof-operation-prepared', operation,
    }),
    { kind: 'mint-submitted', operationId: operation.operationId },
  )
  const alreadySubmitted = recoveryFixture({
    sessions: [submittedSession],
    operations: [submittedOperation],
  })
  alreadySubmitted.mint.next = 'prepared-unspent'
  let submittedFallbackCasCalls = 0
  const submittedFallbackCas = alreadySubmitted.ports.sessions.compareAndSwap
  alreadySubmitted.ports.sessions.compareAndSwap = async (...args) => {
    submittedFallbackCasCalls += 1
    return submittedFallbackCas(...args)
  }
  const submittedTransitions: string[] = []
  alreadySubmitted.ports.atomicTransition = {
    advance: async ({ session: current, operation: currentOperation, state }) => {
      submittedTransitions.push(state)
      assert.equal(state, 'reconciled')
      const nextOperation = { ...currentOperation, state }
      const nextSession = reduceDurableTradeSession(current, {
        kind: 'proof-operation-reconciled',
        operationId: currentOperation.operationId,
      })
      alreadySubmitted.sessions.set(nextSession.tradeId, nextSession)
      alreadySubmitted.operations.set(nextOperation.operationId, nextOperation)
      return { session: nextSession, operation: nextOperation }
    },
  }
  assert.equal((await recoverDurableTradeSessions(alreadySubmitted.ports)).sessions[0]?.kind, 'ready')
  assert.deepEqual(submittedTransitions, ['reconciled'])
  assert.equal(submittedFallbackCasCalls, 0)
  assert.deepEqual(alreadySubmitted.calls, [
    `resume:${operation.operationId}`,
    'join:trade-001',
  ])
})

test('the coordinator relinks an expected orphan and recovers it in the same invocation without creating a replacement', async () => {
  const operation = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'wallet:trade-001:seller-lock',
  })
  const fixture = recoveryFixture({ sessions: [session({
    expectedProofOperations: [expectedOperation(operation)],
  })], operations: [operation] })
  fixture.mint.next = 'prepared-spent-restorable'

  const result = await recoverDurableTradeSessions(fixture.ports)

  assert.equal(fixture.preparedCount, 0)
  assert.equal(fixture.sessions.get('trade-001')?.proofOperations[0]?.operationId, operation.operationId)
  assert.deepEqual(result.orphans, [])
  assert.deepEqual(result.sessions, [{ kind: 'ready', tradeId: 'trade-001' }])
  assert.deepEqual(fixture.calls, [
    `restore:${operation.operationId}`,
    `reconciled:${operation.operationId}`,
    'join:trade-001',
  ])

  const missing = recoveryFixture({
    sessions: [reduceDurableTradeSession(session(), {
      kind: 'proof-operation-prepared',
      operation,
    })],
    operations: [],
  })
  const missingResult = await recoverDurableTradeSessions(missing.ports)
  assert.equal(missing.preparedCount, 0)
  assert.deepEqual(missingResult.sessions, [{
    kind: 'failed-closed',
    tradeId: 'trade-001',
    reason: 'missing-proof-operation',
  }])
})

test('rate limits back off before the local deadline and terminal states never retry or replay', async () => {
  const operation = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'cli:trade-001:seller-lock',
  })
  const active = reduceDurableTradeSession(session({
    sellerLocktimeSecs: 10,
    buyerLocktimeSecs: 9,
  }), {
    kind: 'proof-operation-prepared',
    operation,
  })
  const rateLimited = recoveryFixture({ sessions: [active], operations: [operation], nowMs: 1_000 })
  rateLimited.mint.next = 'rate-limited'
  rateLimited.mint.retryAfterMs = 9_500
  const limited = await recoverDurableTradeSessions(rateLimited.ports)
  assert.equal(limited.sessions[0]?.kind, 'retry-scheduled')
  assert.deepEqual(rateLimited.calls, [`retry:${operation.operationId}:9000:rate-limited`])

  const terminal = recoveryFixture({ sessions: [active], operations: [operation], nowMs: 1_000 })
  terminal.mint.next = 'engine-terminal'
  const terminalResult = await recoverDurableTradeSessions(terminal.ports)
  assert.deepEqual(terminalResult.sessions, [{
    kind: 'awaiting-refund-salvage',
    tradeId: 'trade-001',
    operationId: operation.operationId,
  }])
  assert.deepEqual(terminal.calls, [])
})

test('refund salvage requires the bound refund operation, private key handle, and own locktime', async () => {
  const operation = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'refund',
    state: 'prepared',
    operationKey: 'seller-refund',
  })
  const prepared = reduceDurableTradeSession(session({
    localProtocolPubkey: REFUND_PROTOCOL_PUBKEY,
    sellerLocktimeSecs: 10,
    buyerLocktimeSecs: 9,
  }), {
    kind: 'proof-operation-prepared',
    operation,
  })
  const active = reduceDurableTradeSession(prepared, {
    kind: 'mint-submitted',
    operationId: operation.operationId,
  })
  const submittedOperation = { ...operation, state: 'mint-submitted' as const }
  const evidence: DurableRefundSalvageEvidence & { privateKeyHex: string } = {
    tradeId: active.tradeId,
    role: active.role,
    localProtocolPubkey: active.localProtocolPubkey,
    counterpartyProtocolPubkey: active.counterpartyProtocolPubkey,
    mintUrl: active.mintUrl,
    sellerLocktimeSecs: active.sellerLocktimeSecs,
    buyerLocktimeSecs: active.buyerLocktimeSecs,
    keyHandle: active.ephemeralKeyHandle,
    proofOperation: submittedOperation,
    privateKeyHex: REFUND_PRIVATE_KEY,
  }

  const beforeLocktime = recoveryFixture({
    sessions: [active],
    operations: [submittedOperation],
    nowMs: 9_999,
  })
  beforeLocktime.mint.next = 'expired-refund-salvage'
  beforeLocktime.mint.refundEvidence = evidence
  assert.equal((await recoverDurableTradeSessions(beforeLocktime.ports)).sessions[0]?.kind, 'awaiting-refund-salvage')
  assert.deepEqual(beforeLocktime.calls, [])

  const valid = recoveryFixture({ sessions: [active], operations: [submittedOperation], nowMs: 10_000 })
  valid.mint.next = 'expired-refund-salvage'
  valid.mint.refundEvidence = evidence
  assert.equal((await recoverDurableTradeSessions(valid.ports)).sessions[0]?.kind, 'ready')
  assert.deepEqual(valid.calls, [
    `salvage:${operation.operationId}`,
    `reconciled:${operation.operationId}`,
    'join:trade-001',
  ])
})

test('a lost exact-mint response retains mint-submitted state and cannot clear or replay custody state', async () => {
  const operation = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'gui:trade-001:lost-response',
  })
  const active = reduceDurableTradeSession(session(), {
    kind: 'proof-operation-prepared',
    operation,
  })
  const fixture = recoveryFixture({ sessions: [active], operations: [operation] })
  fixture.mint.next = 'prepared-unspent'
  fixture.mint.resumeError = new Error('response lost')

  const result = await recoverDurableTradeSessions(fixture.ports)

  assert.deepEqual(result.sessions, [{
    kind: 'mint-response-unknown',
    tradeId: 'trade-001',
    operationId: operation.operationId,
  }])
  assert.deepEqual(fixture.calls, [`submitted:${operation.operationId}`, `resume:${operation.operationId}`])
  assert.equal(fixture.operations.get(operation.operationId)?.state, 'mint-submitted')
  assert.equal(fixture.sessions.get('trade-001')?.stage, 'mint-submitted')
})

test('a crash after exact mint success but before reconciliation cannot replay the outbox or duplicate restored outputs', async () => {
  const operation = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'gui:trade-001:reconcile-crash',
  })
  const active = reduceDurableTradeSession(session(), {
    kind: 'proof-operation-prepared',
    operation,
  })
  const journalled = reduceDurableTradeSession(active, {
    kind: 'outbound-cipher-journaled',
    messageType: 'adaptor-point',
    ciphertext: 'crash-boundary-cipher',
    sha256: 'a'.repeat(64),
  })
  const fixture = recoveryFixture({ sessions: [journalled], operations: [operation] })
  fixture.mint.next = 'prepared-unspent'
  fixture.markReconciledError = new Error('crash before durable mark')

  assert.deepEqual((await recoverDurableTradeSessions(fixture.ports)).sessions, [{
    kind: 'failed-closed',
    tradeId: 'trade-001',
    reason: 'storage-unavailable',
  }])
  assert.deepEqual(fixture.calls, [
    `submitted:${operation.operationId}`,
    `resume:${operation.operationId}`,
  ])
  assert.equal(fixture.sessions.get('trade-001')?.stage, 'mint-submitted')

  fixture.markReconciledError = undefined
  fixture.mint.next = 'prepared-spent-restorable'
  assert.equal((await recoverDurableTradeSessions(fixture.ports)).sessions[0]?.kind, 'replayed')
  assert.deepEqual(fixture.calls, [
    `submitted:${operation.operationId}`,
    `resume:${operation.operationId}`,
    `restore:${operation.operationId}`,
    `reconciled:${operation.operationId}`,
    'join:trade-001',
    'send:adaptor-point:crash-boundary-cipher',
  ])
  assert.equal(fixture.restoredOutputCredits, 1)
})

test('an orphan must match the write-ahead retained operation identity before it can relink', async () => {
  const expected = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'expected-lock',
  })
  const stale = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'claim',
    state: 'prepared',
    operationKey: 'stale-claim',
  })
  const fixture = recoveryFixture({
    sessions: [session({ expectedProofOperations: [expectedOperation(expected)] })],
    operations: [stale],
  })

  const result = await recoverDurableTradeSessions(fixture.ports)

  assert.deepEqual(result.orphans, [{
    kind: 'failed-closed',
    operationId: stale.operationId,
    reason: 'invalid-operation',
  }])
  assert.equal(fixture.sessions.get('trade-001')?.proofOperations.length, 0)
  assert.deepEqual(fixture.calls, [])
})

test('a session cannot link an operation outside its write-ahead expected identity', () => {
  const expected = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'expected-lock',
  })
  const foreign = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'claim',
    state: 'prepared',
    operationKey: 'different-claim',
  })

  assert.throws(
    () => reduceDurableTradeSession(session({
      expectedProofOperations: [expectedOperation(expected)],
    }), { kind: 'proof-operation-prepared', operation: foreign }),
    /write-ahead identity/,
  )
})

test('legacy links remain parseable but are rejected before coordinator custody work', async () => {
  const legacy = preparedOperation()
  const active = reduceDurableTradeSession(session(), {
    kind: 'proof-operation-prepared',
    operation: legacy,
  })
  const fixture = recoveryFixture({ sessions: [active], operations: [legacy] })

  assert.deepEqual((await recoverDurableTradeSessions(fixture.ports)).sessions, [{
    kind: 'failed-closed',
    tradeId: 'trade-001',
    reason: 'foreign-proof-operation',
  }])
  assert.deepEqual(fixture.calls, [])
})

test('malformed persisted records and unknown mint inspection values fail closed per record', async () => {
  const malformed = recoveryFixture({
    sessions: [null as never, [] as never],
    operations: [null as never, [] as never],
  })
  assert.deepEqual(await recoverDurableTradeSessions(malformed.ports), {
    sessions: [
      { kind: 'failed-closed', tradeId: 'invalid-session-0', reason: 'invalid-session' },
      { kind: 'failed-closed', tradeId: 'invalid-session-1', reason: 'invalid-session' },
    ],
    orphans: [
      { kind: 'failed-closed', operationId: 'invalid-operation-0', reason: 'invalid-operation' },
      { kind: 'failed-closed', operationId: 'invalid-operation-1', reason: 'invalid-operation' },
    ],
  })

  const operation = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'unknown-inspection',
  })
  const active = reduceDurableTradeSession(session(), {
    kind: 'proof-operation-prepared',
    operation,
  })
  const unknown = recoveryFixture({ sessions: [active], operations: [operation] })
  unknown.mint.next = 'unrecognized-mint-state' as never
  assert.deepEqual((await recoverDurableTradeSessions(unknown.ports)).sessions, [{
    kind: 'failed-closed',
    tradeId: 'trade-001',
    reason: 'foreign-proof-operation',
  }])
  assert.deepEqual(unknown.calls, [])
})

test('corrupt sessions and CAS conflicts fail closed before mint or transport side effects', async () => {
  const operation = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'gui:trade-001:seller-lock',
  })
  const corrupt = recoveryFixture({
    sessions: [{ ...session(), schemaVersion: 999 }],
    operations: [operation],
  })
  assert.deepEqual(await recoverDurableTradeSessions(corrupt.ports), {
    sessions: [{ kind: 'failed-closed', tradeId: 'trade-001', reason: 'invalid-session' }],
    orphans: [{ kind: 'failed-closed', operationId: operation.operationId, reason: 'invalid-session' }],
  })
  assert.deepEqual(corrupt.calls, [])

  const valid = reduceDurableTradeSession(session(), {
    kind: 'proof-operation-prepared',
    operation,
  })
  const conflicted = recoveryFixture({ sessions: [valid], operations: [operation] })
  conflicted.conflictNextCas = true
  conflicted.mint.next = 'prepared-unspent'
  assert.deepEqual(await recoverDurableTradeSessions(conflicted.ports), {
    sessions: [{ kind: 'failed-closed', tradeId: 'trade-001', reason: 'session-cas-conflict' }],
    orphans: [],
  })
  assert.deepEqual(conflicted.calls, [])
})

function recoveryFixture(input: {
  sessions: unknown[]
  operations: unknown[]
  nowMs?: number
}): {
  sessions: Map<string, DurableTradeSession>
  operations: Map<string, DurableTradeProofOperationLink>
  calls: string[]
  mint: {
    next: DurableTradeMintRecoveryState
    retryAfterMs?: number
    resumeError?: Error
    refundEvidence?: (DurableRefundSalvageEvidence & { privateKeyHex: string }) | null
  }
  restoredOutputCredits: number
  markReconciledError?: Error
  ports: DurableTradeRecoveryPorts
  preparedCount: number
  conflictNextCas: boolean
} {
  const sessions = new Map(input.sessions.flatMap((entry) =>
    entry && typeof entry === 'object' && typeof (entry as { tradeId?: unknown }).tradeId === 'string'
      ? [[(entry as { tradeId: string }).tradeId, structuredClone(entry) as DurableTradeSession] as const]
      : [],
  ))
  const operations = new Map(input.operations.flatMap((entry) =>
    entry && typeof entry === 'object' && typeof (entry as { operationId?: unknown }).operationId === 'string'
      ? [[(entry as { operationId: string }).operationId,
        structuredClone(entry) as DurableTradeProofOperationLink] as const]
      : [],
  ))
  const calls: string[] = []
  const state = {
    preparedCount: 0,
    conflictNextCas: false,
    restoredOutputCredits: 0,
    markReconciledError: undefined as Error | undefined,
  }
  const sessionRepository: DurableTradeSessionRepository = {
    get: async (tradeId) => sessions.get(tradeId) ?? null,
    listRecoverable: async () => [
      ...sessions.values(),
      ...input.sessions.filter((entry) => !entry || typeof entry !== 'object' ||
        typeof (entry as { tradeId?: unknown }).tradeId !== 'string'),
    ] as DurableTradeSession[],
    create: async (entry) => {
      state.preparedCount += 1
      sessions.set(entry.tradeId, entry)
      return entry
    },
    compareAndSwap: async (tradeId, revision, next) => {
      const current = sessions.get(tradeId)
      if (!current || current.revision !== revision || state.conflictNextCas) return null
      sessions.set(tradeId, structuredClone(next))
      return next
    },
    remove: async () => false,
  }
  const operationRepository: DurableProofOperationRepository = {
    get: async (operationId) => operations.get(operationId) ?? null,
    listByTrade: async (tradeId) => [...operations.values()].filter((item) => item.tradeId === tradeId),
    listRecoverable: async () => [
      ...operations.values(),
      ...input.operations.filter((entry) => !entry || typeof entry !== 'object' ||
        typeof (entry as { operationId?: unknown }).operationId !== 'string'),
    ] as DurableTradeProofOperationLink[],
    prepare: async (entry) => {
      state.preparedCount += 1
      operations.set(entry.operationId, entry)
      return entry
    },
    markMintSubmitted: async (operationId) => {
      const current = operations.get(operationId)
      assert.ok(current)
      const next = { ...current, state: 'mint-submitted' as const }
      operations.set(operationId, next)
      calls.push(`submitted:${operationId}`)
      return next
    },
    markReconciled: async (operationId) => {
      if (state.markReconciledError) throw state.markReconciledError
      const current = operations.get(operationId)
      assert.ok(current)
      const next = { ...current, state: 'reconciled' as const }
      operations.set(operationId, next)
      calls.push(`reconciled:${operationId}`)
      return next
    },
  }
  const mint: {
    next: DurableTradeMintRecoveryState
    retryAfterMs?: number
    resumeError?: Error
    refundEvidence?: (DurableRefundSalvageEvidence & { privateKeyHex: string }) | null
  } = {
    next: 'pending-or-mixed',
  }
  const ports: DurableTradeRecoveryPorts = {
    sessions: sessionRepository,
    operations: operationRepository,
    mint: {
      inspect: async () => ({ kind: mint.next, retryAfterMs: mint.retryAfterMs }),
      restoreExactPersistedOutputs: async (entry) => {
        calls.push(`restore:${entry.operationId}`)
        state.restoredOutputCredits = 1
      },
      resumeExactPreparedOperation: async (entry) => {
        calls.push(`resume:${entry.operationId}`)
        if (mint.resumeError) throw mint.resumeError
      },
      salvageExpiredRefund: async (entry) => { calls.push(`salvage:${entry.operationId}`) },
      getRefundSalvageEvidence: async () => mint.refundEvidence ?? null,
    },
    transport: {
      joinTrade: async (tradeId) => { calls.push(`join:${tradeId}`) },
      sendCipher: async (_tradeId, messageType, ciphertext) => { calls.push(`send:${messageType}:${ciphertext}`) },
    },
    clock: { nowMs: () => input.nowMs ?? 0 },
    hashCiphertext: async (ciphertext) => ciphertext === 'journalled-adaptor-cipher'
      ? 'a'.repeat(64)
      : 'a'.repeat(64),
    scheduleRetry: async (entry) => { calls.push(`retry:${entry.operationId}:${entry.delayMs}:${entry.reason}`) },
  }
  return {
    sessions,
    operations,
    calls,
    mint,
    ports,
    get preparedCount() { return state.preparedCount },
    get restoredOutputCredits() { return state.restoredOutputCredits },
    get markReconciledError() { return state.markReconciledError },
    set markReconciledError(value: Error | undefined) { state.markReconciledError = value },
    get conflictNextCas() { return state.conflictNextCas },
    set conflictNextCas(value: boolean) { state.conflictNextCas = value },
  }
}
