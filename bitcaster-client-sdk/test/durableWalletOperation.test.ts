import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  Amount,
  OutputData,
  type MeltPreview,
  type MintPreview,
  type OutputDataLike,
  type Proof,
  type SwapPreview,
} from '@cashu/cashu-ts'
import {
  createDurableWalletMeltOperation,
  createDurableWalletMintOperation,
  createDurableWalletReceiveOperation,
  createDurableWalletSendOperation,
  decideDurableWalletOperationRecovery,
  decodeDurableWalletOperation,
  deriveDurableWalletOperationAuthority,
  rehydrateDurableWalletOperation,
  rehydrateDurableWalletMeltChange,
  requireDurableWalletOperationFromCustody,
  restoreDurableWalletOperationOutputs,
  serializeDurableWalletMeltChange,
  toDurableCustodyProofOperationInput,
  type DurableWalletOperation,
  type DurableWalletOperationRecoveryEvidence,
  type DurableWalletVerifiedExactOutputRestore,
} from '../src/durableWalletOperation.ts'
import { durableCustodyProofOperationSemanticKind } from '../src/durableCustodyProofOperation.ts'
import { deriveDurableCustodyProofResultFingerprint } from '../src/durableCustodyProofOperationRecord.ts'
import { requireDurableWalletProofTransition } from '../src/durableWalletProofTransition.ts'

const KEYSET_ID = `00${'22'.repeat(7)}`
const MINT_URL = 'https://mint.example'
const MINT_QUOTE_EXPIRY = 2_000
const OUTPUT_PLAN_FINGERPRINT = /^[a-f0-9]{64}$/
const RESULT_FINGERPRINT = deriveDurableCustodyProofResultFingerprint({
  receive: [proof(1, '77')],
})

test('all ordinary wallet previews have one strict persisted round trip', () => {
  const operations = operationFixtures()

  for (const operation of operations) {
    const decoded = decodeDurableWalletOperation(
      JSON.parse(JSON.stringify(operation)),
    )
    const authority = deriveDurableWalletOperationAuthority(decoded)
    const custody = toDurableCustodyProofOperationInput(decoded)
    const runtime = rehydrateDurableWalletOperation(decoded)

    assert.equal(decoded.kind, operation.kind)
    assert.equal(decoded.operationId, operation.operationId)
    assert.match(authority.requestFingerprint, OUTPUT_PLAN_FINGERPRINT)
    assert.match(authority.outputPlanFingerprint, OUTPUT_PLAN_FINGERPRINT)
    assert.equal(custody.kind, operation.kind)
    assert.equal(custody.operationId, operation.operationId)
    assert.equal(runtime.kind, operation.kind)
  }

  assert.equal(
    durableCustodyProofOperationSemanticKind('wallet-mint'),
    'generic-receive',
  )
  assert.equal(
    durableCustodyProofOperationSemanticKind('wallet-receive'),
    'generic-receive',
  )
  assert.equal(
    durableCustodyProofOperationSemanticKind('wallet-send'),
    'wallet-send',
  )
  assert.equal(
    durableCustodyProofOperationSemanticKind('wallet-melt'),
    'generic-send',
  )
})

test('rehydration uses only exact persisted outputs and request authority', () => {
  const preview = mintPreview()
  const operation = createDurableWalletMintOperation({
    operationId: 'mint-001',
    mintUrl: MINT_URL,
    unit: 'sat',
    quoteExpiryUnixSeconds: MINT_QUOTE_EXPIRY,
    preview,
  })
  preview.outputData[0]!.secret.fill(0xff)
  preview.payload.quote = 'mutated-quote'

  const restored = rehydrateDurableWalletOperation(operation)
  assert.equal(restored.kind, 'wallet-mint')
  assert.equal(restored.preview.payload.quote, 'mint-quote-001')
  assert.equal(restored.preview.outputData[0]!.secret[0], 0x11)
  assert.equal(restored.preview.outputData[0]!.blindingFactor, 2n)
  assert.equal(
    restored.preview.outputData[0]!.ephemeralE,
    `02${'55'.repeat(32)}`,
  )
})

test('custody conversion is self-contained and emits strict wallet delta policies', () => {
  for (const operation of operationFixtures()) {
    const custody = toDurableCustodyProofOperationInput(operation)
    const recovered = requireDurableWalletOperationFromCustody(custody)
    const policy = requireDurableWalletProofTransition(
      custody.metadata ?? {},
      Object.keys(custody.outputs),
    )

    assert.equal(recovered.kind, operation.kind)
    assert.equal(
      policy.inputSource,
      operation.kind === 'wallet-mint' || operation.kind === 'wallet-receive'
        ? 'external'
        : 'wallet',
    )
    for (const [label, cardinality] of Object.entries(
      policy.resultCardinality,
    )) {
      assert.equal(
        cardinality,
        operation.kind === 'wallet-melt' && label === 'change'
          ? 'prefix'
          : 'exact',
      )
    }
    if (operation.kind === 'wallet-send') {
      assert.equal(policy.passthroughResultGroups.keep?.length, 1)
      const runtime = rehydrateDurableWalletOperation(operation)
      assert.equal(runtime.kind, 'wallet-send')
      assert.equal(
        custody.outputs.send![0]!.secret,
        new TextDecoder().decode(runtime.preview.sendOutputs[0]!.secret),
      )
    }
  }

  const custody = toDurableCustodyProofOperationInput(
    operationByKind('wallet-mint'),
  )
  custody.outputs.receive![0]!.ephemeralE = `02${'66'.repeat(32)}`
  assert.throws(
    () => requireDurableWalletOperationFromCustody(custody),
    /does not match its exact persisted preview/,
  )
})

test('mint and receive restore use exact persisted output groups through one port', async () => {
  for (const kind of ['wallet-mint', 'wallet-receive'] as const) {
    const operation = operationByKind(kind)
    let observedSecret = -1
    const result = await restoreDurableWalletOperationOutputs(operation, {
      restoreVerifiedOutputGroups: async ({ outputs }) => {
        observedSecret = outputs.receive![0]!.secret[0]!
        return {
          receive: outputs.receive!.map((outputData) => ({
            id: outputData.blindedMessage.id,
            amount: outputData.blindedMessage.amount,
            secret: new TextDecoder().decode(outputData.secret),
            C: `02${'99'.repeat(32)}`,
          })),
        }
      },
    })
    assert.equal(observedSecret, 0x11)
    assert.equal(result.kind, 'exact')
    if (result.kind === 'exact') {
      assert.match(result.resultFingerprint, OUTPUT_PLAN_FINGERPRINT)
      assert.equal(result.resultGroups.receive?.length, 1)
    }
  }

  const partial = await restoreDurableWalletOperationOutputs(
    operationByKind('wallet-receive'),
    { restoreVerifiedOutputGroups: async () => ({ receive: [] }) },
  )
  assert.deepEqual(partial, { kind: 'partial' })
})

test('strict codec rejects unknown fields, noncanonical values, and mixed variants', () => {
  const mint = createDurableWalletMintOperation({
    operationId: 'mint-001',
    mintUrl: MINT_URL,
    unit: 'sat',
    quoteExpiryUnixSeconds: MINT_QUOTE_EXPIRY,
    preview: mintPreview(),
  })
  const unknown = structuredClone(mint) as unknown as Record<string, unknown>
  unknown.foreign = true
  assert.throws(
    () => decodeDurableWalletOperation(unknown),
    /unknown field 'foreign'/,
  )

  const noncanonicalAmount = structuredClone(mint)
  noncanonicalAmount.preview.outputData[0]!.blindedMessage.amount = '01'
  assert.throws(
    () => decodeDurableWalletOperation(noncanonicalAmount),
    /output amount is invalid/,
  )

  const invalidExpiry = structuredClone(mint)
  invalidExpiry.preview.quoteExpiryUnixSeconds = -1
  assert.throws(
    () => decodeDurableWalletOperation(invalidExpiry),
    /mint quote expiry is invalid/,
  )

  const missingExpiry = structuredClone(mint) as unknown as {
    preview: Record<string, unknown>
  }
  delete missingExpiry.preview.quoteExpiryUnixSeconds
  assert.throws(
    () => decodeDurableWalletOperation(missingExpiry),
    /missing required field 'quoteExpiryUnixSeconds'/,
  )

  const mismatchedPayload = structuredClone(mint)
  mismatchedPayload.preview.payload.outputs[0]!.B_ = `02${'99'.repeat(32)}`
  assert.throws(
    () => decodeDurableWalletOperation(mismatchedPayload),
    /mint payload does not match exact outputs/,
  )

  const mixed = structuredClone(mint) as unknown as {
    kind: string
    preview: Record<string, unknown>
  }
  mixed.kind = 'wallet-melt'
  assert.throws(
    () => decodeDurableWalletOperation(mixed),
    /unknown field/,
  )

  const oversizedOperationId = structuredClone(mint)
  oversizedOperationId.operationId = 'x'.repeat(513)
  assert.throws(
    () => decodeDurableWalletOperation(oversizedOperationId),
    /wallet operation id is invalid/,
  )

  const oversizedRecoveryId = recoveryEvidence(mint, {
    quoteState: 'PAID',
    restore: 'none',
  })
  oversizedRecoveryId.operationId = 'x'.repeat(513)
  assert.deepEqual(
    decideDurableWalletOperationRecovery(mint, oversizedRecoveryId),
    {
      kind: 'fail-closed',
      classification: 'corrupt',
      reason: 'corrupt-evidence',
    },
  )

  const invalidObservation = recoveryEvidence(mint, {
    quoteState: 'UNPAID',
    restore: 'none',
  })
  if (invalidObservation.quote?.kind !== 'mint') {
    throw new Error('missing mint quote fixture')
  }
  invalidObservation.quote.observedAtUnixSeconds = -1
  assert.equal(
    decideDurableWalletOperationRecovery(mint, invalidObservation).kind,
    'fail-closed',
  )
})

test('mint recovery is quote-bound and never reissues an issued quote without exact restore', async () => {
  const operation = operationByKind('wallet-mint')
  const exactRestore = await verifiedExactRestore(operation)

  assert.equal(
    decide(operation, { quoteState: 'PAID', restore: 'none' }).kind,
    'reissue-exact-operation',
  )
  assert.equal(
    decide(operation, { quoteState: 'UNPAID', restore: 'none' }).kind,
    'retry-later',
  )
  assert.equal(
    decide(operation, { quoteState: 'ISSUED', restore: 'none' }).kind,
    'retry-later',
  )
  assert.equal(
    decide(operation, { quoteState: 'ISSUED', restore: exactRestore }).kind,
    'reconcile-exact-operation',
  )

  const foreignQuote = recoveryEvidence(operation, {
    quoteState: 'PAID',
    restore: 'none',
  })
  if (foreignQuote.quote === null) throw new Error('missing quote fixture')
  foreignQuote.quote.quoteId = 'foreign-quote'
  assert.deepEqual(
    decideDurableWalletOperationRecovery(operation, foreignQuote),
    {
      kind: 'fail-closed',
      classification: 'foreign',
      reason: 'quote-authority',
    },
  )

  const foreignMethod = recoveryEvidence(operation, {
    quoteState: 'PAID',
    restore: 'none',
  })
  if (foreignMethod.quote !== null) foreignMethod.quote.method = 'bolt12'
  assert.deepEqual(
    decideDurableWalletOperationRecovery(operation, foreignMethod),
    {
      kind: 'fail-closed',
      classification: 'foreign',
      reason: 'quote-authority',
    },
  )
})

test('only an exact unsubmitted unpaid mint quote at its persisted expiry can abort', () => {
  const operation = operationByKind('wallet-mint')

  assert.deepEqual(
    decide(operation, {
      quoteState: 'UNPAID',
      submissionState: 'not-submitted',
      observedAtUnixSeconds: MINT_QUOTE_EXPIRY,
      restore: 'none',
    }),
    {
      kind: 'abort-no-transport',
      classification: 'all-inputs-unspent',
      reason: 'mint-quote-expired',
    },
  )
  assert.equal(
    decide(operation, {
      quoteState: 'UNPAID',
      submissionState: 'not-submitted',
      observedAtUnixSeconds: MINT_QUOTE_EXPIRY - 1,
      restore: 'none',
    }).kind,
    'retry-later',
  )
  assert.equal(
    decide(operation, {
      quoteState: 'UNPAID',
      submissionState: 'submitted',
      observedAtUnixSeconds: MINT_QUOTE_EXPIRY,
      restore: 'none',
    }).kind,
    'retry-later',
  )

  const noExpiry = {
    ...operation,
    preview: { ...operation.preview, quoteExpiryUnixSeconds: null },
  }
  assert.equal(
    decide(noExpiry, {
      quoteState: 'UNPAID',
      submissionState: 'not-submitted',
      observedAtUnixSeconds: MINT_QUOTE_EXPIRY,
      restore: 'none',
    }).kind,
    'retry-later',
  )

  const foreignExpiry = recoveryEvidence(operation, {
    quoteState: 'UNPAID',
    submissionState: 'not-submitted',
    observedAtUnixSeconds: MINT_QUOTE_EXPIRY,
    restore: 'none',
  })
  if (foreignExpiry.quote?.kind !== 'mint') {
    throw new Error('missing mint quote fixture')
  }
  foreignExpiry.quote.expiryUnixSeconds += 1
  assert.deepEqual(
    decideDurableWalletOperationRecovery(operation, foreignExpiry),
    {
      kind: 'fail-closed',
      classification: 'foreign',
      reason: 'quote-authority',
    },
  )
})

test('caller-invented or cloned exact restore evidence never reconciles proofs', async () => {
  const operation = operationByKind('wallet-mint')
  const evidence = recoveryEvidence(operation, {
    quoteState: 'ISSUED',
    restore: 'none',
  }) as unknown as Record<string, unknown>
  const authority = deriveDurableWalletOperationAuthority(operation)
  evidence.restore = {
    kind: 'exact',
    outputPlanFingerprint: authority.outputPlanFingerprint,
    resultFingerprint: RESULT_FINGERPRINT,
  }

  assert.equal(
    decideDurableWalletOperationRecovery(operation, evidence).kind,
    'fail-closed',
  )

  const issued = await verifiedExactRestore(operation)
  assert.equal(
    decide(operation, {
      quoteState: 'ISSUED',
      restore: structuredClone(issued),
    }).kind,
    'fail-closed',
  )
})

test('exact restore handles fail closed after any proof authority mutation', async () => {
  const operation = operationByKind('wallet-mint')
  const mutations: Array<(proof: Proof) => void> = [
    (proof) => {
      proof.id = `00${'88'.repeat(7)}`
    },
    (proof) => {
      proof.secret = 'aa'.repeat(32)
    },
    (proof) => {
      proof.amount = Amount.from(9)
    },
    (proof) => {
      proof.C = `02${'88'.repeat(32)}`
    },
    (proof) => {
      proof.dleq!.e = 'aa'
    },
    (proof) => {
      proof.p2pk_e = `02${'88'.repeat(32)}`
    },
    (proof) => {
      proof.witness = 'changed-witness'
    },
  ]

  for (const mutate of mutations) {
    const restored = await verifiedExactRestore(operation)
    mutate(restored.resultGroups.receive![0]!)
    const decision = decide(operation, {
      quoteState: 'ISSUED',
      restore: restored,
    })
    assert.equal(decision.kind, 'fail-closed')
  }
})

test('exact restore handle is bound to one operation and output plan', async () => {
  const operation = operationByKind('wallet-mint')
  const foreignOperation = createDurableWalletMintOperation({
    operationId: 'mint-foreign',
    mintUrl: MINT_URL,
    unit: 'sat',
    quoteExpiryUnixSeconds: MINT_QUOTE_EXPIRY,
    preview: mintPreview(),
  })
  const foreignOperationRestore = await verifiedExactRestore(foreignOperation)
  assert.equal(
    decide(operation, {
      quoteState: 'ISSUED',
      restore: foreignOperationRestore,
    }).kind,
    'fail-closed',
  )

  const changedPreview = mintPreview()
  changedPreview.outputData[0] = output(1, 0x12)
  changedPreview.payload.outputs = changedPreview.outputData.map(
    ({ blindedMessage }) => blindedMessage,
  )
  const foreignPlan = createDurableWalletMintOperation({
    operationId: operation.operationId,
    mintUrl: MINT_URL,
    unit: 'sat',
    quoteExpiryUnixSeconds: MINT_QUOTE_EXPIRY,
    preview: changedPreview,
  })
  const foreignPlanRestore = await verifiedExactRestore(foreignPlan)
  assert.equal(
    decide(operation, {
      quoteState: 'ISSUED',
      restore: foreignPlanRestore,
    }).kind,
    'fail-closed',
  )
})

test('exact restore rejects changed labels, ordering, counts, and duplicates', async () => {
  const operation = operationByKind('wallet-send')
  const mutations: Array<
    (groups: DurableWalletVerifiedExactOutputRestore['resultGroups']) => void
  > = [
    (groups) => {
      delete groups.send
    },
    (groups) => {
      groups.foreign = []
    },
    (groups) => {
      const keep = groups.keep!
      delete groups.keep
      groups.keep = keep
    },
    (groups) => {
      groups.keep!.reverse()
    },
    (groups) => {
      groups.send!.pop()
    },
    (groups) => {
      groups.send![0] = groups.keep![0]!
    },
  ]

  for (const mutate of mutations) {
    const restored = await verifiedExactRestore(operation)
    mutate(restored.resultGroups)
    assert.equal(
      decide(operation, {
        inputStates: ['SPENT'],
        restore: restored,
      }).kind,
      'fail-closed',
    )
  }
})

test('send exact restore reconstructs all persisted passthrough proof fields', async () => {
  const operation = operationByKind('wallet-send')
  const restored = await verifiedExactRestore(operation)
  const passthrough = restored.resultGroups.keep![1]!

  assert.equal(
    passthrough.secret,
    operation.preview.unselectedProofs[0]!.secret,
  )
  assert.equal(passthrough.dleq?.e, '11')
  assert.equal(passthrough.p2pk_e, `02${'77'.repeat(32)}`)
  assert.equal(passthrough.witness, 'persisted-witness')
})

test('melt never accepts an exact output restore handle', async () => {
  const restore = await verifiedExactRestore(operationByKind('wallet-mint'))
  assert.equal(
    decide(operationByKind('wallet-melt'), {
      quoteState: 'PAID',
      inputStates: ['SPENT'],
      restore,
    }).kind,
    'fail-closed',
  )
})

test('receive and send recover only from an exact ordered NUT-07/restore classification', async () => {
  for (const kind of ['wallet-receive', 'wallet-send'] as const) {
    const operation = operationByKind(kind)
    const exactRestore = await verifiedExactRestore(operation)
    assert.equal(
      decide(operation, { inputStates: ['UNSPENT'], restore: 'none' }).kind,
      'reissue-exact-operation',
    )
    assert.equal(
      decide(operation, {
        inputStates: ['SPENT'],
        restore: exactRestore,
      }).kind,
      'reconcile-exact-operation',
    )
    assert.equal(
      decide(operation, { inputStates: ['SPENT'], restore: 'none' }).kind,
      'retry-later',
    )
    assert.equal(
      decide(operation, { inputStates: ['PENDING'], restore: 'none' }).kind,
      'retry-later',
    )
  }
})

test('melt recovery treats exact paid quote change as terminal authority', () => {
  const operation = operationByKind('wallet-melt')

  assert.equal(
    decide(operation, {
      quoteState: 'UNPAID',
      inputStates: ['UNSPENT'],
      restore: 'none',
    }).kind,
    'reissue-exact-operation',
  )
  assert.equal(
    decide(operation, {
      quoteState: 'PENDING',
      inputStates: ['PENDING'],
      restore: 'none',
    }).kind,
    'retry-later',
  )
  assert.equal(
    decide(operation, {
      quoteState: 'PAID',
      inputStates: ['SPENT'],
      restore: 'none',
      meltChange: meltChange(),
    }).kind,
    'reconcile-exact-operation',
  )
  assert.equal(
    decide(operation, {
      quoteState: 'PAID',
      inputStates: ['SPENT'],
      restore: 'none',
    }).kind,
    'reconcile-exact-operation',
  )

  const paidWithChange = decide(operation, {
    quoteState: 'PAID',
    inputStates: ['SPENT'],
    restore: 'none',
    meltChange: meltChange(),
  })
  assert.equal(paidWithChange.kind, 'reconcile-exact-operation')
  if (paidWithChange.kind !== 'reconcile-exact-operation') return
  assert.equal(paidWithChange.result.kind, 'melt-quote-change')
  if (paidWithChange.result.kind !== 'melt-quote-change') return
  assert.equal(
    rehydrateDurableWalletMeltChange(
      paidWithChange.result.change,
    )[0]!.amount.toString(),
    '1',
  )

  const zeroOutput = createDurableWalletMeltOperation({
    operationId: 'melt-zero-change',
    mintUrl: MINT_URL,
    unit: 'sat',
    preview: meltPreview([]),
  })
  const zeroChange = decide(zeroOutput, {
    quoteState: 'PAID',
    inputStates: ['SPENT'],
    restore: 'none',
    meltChange: [],
  })
  assert.equal(zeroChange.kind, 'reconcile-exact-operation')
})

test('quote states reject contradictory restore and change evidence', async () => {
  const mint = operationByKind('wallet-mint')
  const mintRestore = await verifiedExactRestore(mint)
  for (const quoteState of ['UNPAID', 'PAID'] as const) {
    assert.equal(
      decide(mint, { quoteState, restore: mintRestore }).kind,
      'fail-closed',
    )
  }

  const melt = operationByKind('wallet-melt')
  for (const quoteState of ['UNPAID', 'PENDING', 'PAID'] as const) {
    assert.equal(
      decide(melt, {
        quoteState,
        inputStates: [quoteState === 'PAID' ? 'SPENT' : 'UNSPENT'],
        restore: mintRestore,
        meltChange: quoteState === 'PAID' ? meltChange() : [],
      }).kind,
      'fail-closed',
    )
  }
  assert.equal(
    decide(melt, {
      quoteState: 'PENDING',
      inputStates: ['PENDING'],
      restore: 'none',
      meltChange: meltChange(),
    }).kind,
    'fail-closed',
  )
})

test('input recovery authority rejects wrong length, order, and duplicates', () => {
  const operation = createDurableWalletSendOperation({
    operationId: 'send-input-authority',
    mintUrl: MINT_URL,
    unit: 'sat',
    preview: swapPreview('send', [proof(2, '33'), proof(3, '44')]),
  })
  const evidence = recoveryEvidence(operation, {
    inputStates: ['UNSPENT', 'UNSPENT'],
    restore: 'none',
  })
  const wrongLength = structuredClone(evidence)
  wrongLength.inputStates.pop()
  assert.equal(
    decideDurableWalletOperationRecovery(operation, wrongLength).kind,
    'fail-closed',
  )
  const wrongOrder = structuredClone(evidence)
  wrongOrder.inputStates.reverse()
  assert.equal(
    decideDurableWalletOperationRecovery(operation, wrongOrder).kind,
    'fail-closed',
  )
  const duplicate = structuredClone(evidence)
  duplicate.inputStates[1] = structuredClone(duplicate.inputStates[0]!)
  assert.equal(
    decideDurableWalletOperationRecovery(operation, duplicate).kind,
    'fail-closed',
  )
})

test('all bounded mixed, unknown, partial, and foreign evidence fails closed', async () => {
  const operation = operationByKind('wallet-send')
  const authority = deriveDurableWalletOperationAuthority(operation)
  const states = ['UNSPENT', 'PENDING', 'SPENT'] as const

  for (const left of states) {
    for (const right of states) {
      const twoInputOperation = createDurableWalletSendOperation({
        operationId: 'send-two-inputs',
        mintUrl: MINT_URL,
        unit: 'sat',
        preview: swapPreview('send', [proof(2), proof(3, '44')]),
      })
      const restore =
        left === 'SPENT' && right === 'SPENT'
          ? await verifiedExactRestore(twoInputOperation)
          : 'none'
      const result = decide(twoInputOperation, {
        inputStates: [left, right],
        restore,
      })
      if (left !== right) assert.equal(result.kind, 'retry-later')
    }
  }

  const malformed = recoveryEvidence(operation, {
    inputStates: ['UNSPENT'],
    restore: 'none',
  }) as unknown as Record<string, unknown>
  malformed.unknown = true
  assert.equal(
    decideDurableWalletOperationRecovery(operation, malformed).kind,
    'fail-closed',
  )

  const partial = recoveryEvidence(operation, {
    inputStates: ['SPENT'],
    restore: 'partial',
  })
  assert.equal(
    decideDurableWalletOperationRecovery(operation, partial).kind,
    'retry-later',
  )

  const foreign = recoveryEvidence(operation, {
    inputStates: ['UNSPENT'],
    restore: 'none',
  })
  foreign.requestFingerprint = `${
    authority.requestFingerprint[0] === 'f' ? 'e' : 'f'
  }${authority.requestFingerprint.slice(1)}`
  assert.equal(
    decideDurableWalletOperationRecovery(operation, foreign).kind,
    'fail-closed',
  )
})

function operationFixtures(): DurableWalletOperation[] {
  return [
    createDurableWalletMintOperation({
      operationId: 'mint-001',
      mintUrl: MINT_URL,
      unit: 'sat',
      quoteExpiryUnixSeconds: MINT_QUOTE_EXPIRY,
      preview: mintPreview(),
    }),
    createDurableWalletReceiveOperation({
      operationId: 'receive-001',
      mintUrl: MINT_URL,
      unit: 'sat',
      preview: swapPreview('receive'),
    }),
    createDurableWalletSendOperation({
      operationId: 'send-001',
      mintUrl: MINT_URL,
      unit: 'sat',
      preview: swapPreview('send'),
    }),
    createDurableWalletMeltOperation({
      operationId: 'melt-001',
      mintUrl: MINT_URL,
      unit: 'sat',
      preview: meltPreview(),
      requestOptions: { preferAsync: true, extraPayload: { fee_limit: 2 } },
    }),
  ]
}

function operationByKind<K extends DurableWalletOperation['kind']>(
  kind: K,
): Extract<DurableWalletOperation, { kind: K }> {
  const operation = operationFixtures().find(
    (candidate) => candidate.kind === kind,
  )
  if (!operation || operation.kind !== kind) throw new Error('missing fixture')
  return operation as Extract<DurableWalletOperation, { kind: K }>
}

function mintPreview(): MintPreview<{ quote: string }> {
  const outputData = [output(1)]
  return {
    method: 'bolt11',
    payload: {
      quote: 'mint-quote-001',
      outputs: outputData.map(({ blindedMessage }) => blindedMessage),
    },
    outputData,
    keysetId: KEYSET_ID,
    quote: { quote: 'mint-quote-001' },
  }
}

function swapPreview(
  kind: 'receive' | 'send',
  inputs: Proof[] = [proof(4)],
): SwapPreview {
  return kind === 'receive'
    ? {
        amount: Amount.from(3),
        fees: Amount.from(1),
        keysetId: KEYSET_ID,
        inputs,
        keepOutputs: [output(3)],
      }
    : {
        amount: Amount.from(2),
        fees: Amount.from(1),
        keysetId: KEYSET_ID,
        inputs,
        sendOutputs: [output(2, 0x11)],
        keepOutputs: [output(1, 0x12)],
        unselectedProofs: [proofWithAuthority(5, '55')],
      }
}

function meltPreview(
  outputData: OutputData[] = [output(0)],
): MeltPreview<{ quote: string; amount: Amount }> {
  return {
    method: 'bolt11',
    inputs: [proof(4)],
    outputData,
    keysetId: KEYSET_ID,
    quote: { quote: 'melt-quote-001', amount: Amount.from(3) },
  }
}

function output(amount: number, secretByte = 0x11): OutputData {
  return new OutputData(
    {
      amount: Amount.from(amount),
      id: KEYSET_ID,
      B_: `02${'33'.repeat(32)}`,
    },
    2n,
    new Uint8Array(32).fill(secretByte),
    `02${'55'.repeat(32)}`,
  )
}

function proof(amount: number, secretByte = '33'): Proof {
  return {
    id: KEYSET_ID,
    amount: Amount.from(amount),
    secret: secretByte.repeat(32),
    C: `02${'44'.repeat(32)}`,
  }
}

function proofWithAuthority(amount: number, secretByte: string): Proof {
  return {
    ...proof(amount, secretByte),
    dleq: { e: '11', s: '22', r: '33' },
    p2pk_e: `02${'77'.repeat(32)}`,
    witness: 'persisted-witness',
  }
}

function decide(
  operation: DurableWalletOperation,
  input: {
    quoteState?: 'UNPAID' | 'PAID' | 'ISSUED' | 'PENDING'
    inputStates?: Array<'UNSPENT' | 'PENDING' | 'SPENT'>
    restore: 'none' | 'partial' | DurableWalletVerifiedExactOutputRestore
    meltChange?: ReturnType<typeof meltChange>
    submissionState?: 'not-submitted' | 'submitted'
    observedAtUnixSeconds?: number
  },
) {
  return decideDurableWalletOperationRecovery(
    operation,
    recoveryEvidence(operation, input),
  )
}

function recoveryEvidence(
  operation: DurableWalletOperation,
  input: {
    quoteState?: 'UNPAID' | 'PAID' | 'ISSUED' | 'PENDING'
    inputStates?: Array<'UNSPENT' | 'PENDING' | 'SPENT'>
    restore: 'none' | 'partial' | DurableWalletVerifiedExactOutputRestore
    meltChange?: ReturnType<typeof meltChange>
    submissionState?: 'not-submitted' | 'submitted'
    observedAtUnixSeconds?: number
  },
): DurableWalletOperationRecoveryEvidence {
  const authority = deriveDurableWalletOperationAuthority(operation)
  const inputs = toDurableCustodyProofOperationInput(operation).inputs
  return {
    schemaVersion: 1,
    operationId: operation.operationId,
    requestFingerprint: authority.requestFingerprint,
    submissionState: input.submissionState ?? 'submitted',
    quote:
      operation.kind === 'wallet-mint' || operation.kind === 'wallet-melt'
        ? operation.kind === 'wallet-mint'
          ? {
              kind: 'mint' as const,
              method: operation.preview.method,
              quoteId: operation.preview.payload.quote,
              state: input.quoteState as 'UNPAID' | 'PAID' | 'ISSUED',
              expiryUnixSeconds: operation.preview.quoteExpiryUnixSeconds,
              observedAtUnixSeconds: input.observedAtUnixSeconds ?? 1_000,
            }
          : {
              kind: 'melt' as const,
              method: operation.preview.method,
              quoteId: operation.preview.quote.quote,
              state: input.quoteState as 'UNPAID' | 'PENDING' | 'PAID',
              change: input.meltChange ?? [],
            }
        : null,
    inputStates: inputs.map((proof, index) => ({
      keysetId: proof.id!,
      secret: proof.secret,
      state: input.inputStates?.[index] ?? 'UNSPENT',
    })),
    restore:
      typeof input.restore === 'string'
        ? { kind: input.restore }
        : input.restore,
  }
}

async function verifiedExactRestore(
  operation: Exclude<
    DurableWalletOperation,
    Extract<DurableWalletOperation, { kind: 'wallet-melt' }>
  >,
): Promise<DurableWalletVerifiedExactOutputRestore> {
  const restored = await restoreDurableWalletOperationOutputs(operation, {
    restoreVerifiedOutputGroups: async ({ outputs }) =>
      Object.fromEntries(
        Object.entries(outputs).map(([label, values]) => [
          label,
          values.map((value) => restoredProof(value)),
        ]),
      ),
  })
  if (restored.kind !== 'exact')
    throw new Error('missing exact restore fixture')
  return restored
}

function restoredProof(outputData: OutputDataLike): Proof {
  return {
    id: outputData.blindedMessage.id,
    amount: outputData.blindedMessage.amount,
    secret: new TextDecoder().decode(outputData.secret),
    C: `02${'99'.repeat(32)}`,
    dleq: { e: '11', s: '22', r: '33' },
    p2pk_e: `02${'77'.repeat(32)}`,
    witness: 'test-witness',
  }
}

function meltChange() {
  return serializeDurableWalletMeltChange([
    {
      id: KEYSET_ID,
      amount: Amount.from(1),
      C_: `02${'88'.repeat(32)}`,
    },
  ])
}
