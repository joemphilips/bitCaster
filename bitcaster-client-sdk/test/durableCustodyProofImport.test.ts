import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Amount, type Proof } from '@cashu/cashu-ts'
import {
  deriveDurableCustodyScopeId,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScopeState,
  type DurableCustodyTransaction,
} from '../src/durableCustody.ts'
import {
  applyDurableCustodyProofImport,
  bindDurableCustodyProofImport,
  prepareDurableCustodyProofImport,
  type PreparedDurableCustodyProofImport,
} from '../src/durableCustodyProofImport.ts'
import { FaultInjectingDurableCustodyAdapter } from './support/faultInjectingDurableCustodyAdapter.ts'

const CONDITION_ID = 'ab'.repeat(32)
const SCOPE_INPUT = {
  scopeKind: 'condition-inventory' as const,
  conditionId: CONDITION_ID,
  inventoryAccountId: `condition:${CONDITION_ID}`,
  normalizedMint: 'https://mint.example',
  unit: 'msat' as const,
}
const SCOPE = { ...SCOPE_INPUT, scopeId: deriveDurableCustodyScopeId(SCOPE_INPUT) }
const KEYSET = {
  keysetId: `01${'11'.repeat(32)}`,
  unit: 'msat',
  curve: 'secp256k1' as const,
  publicKeys: { '1': `02${'22'.repeat(32)}` },
  keysetExpiryMs: null,
  requireDleq: true,
}

describe('durable custody completed proof import', () => {
  it('binds discoverable work and atomically applies exact successor proofs', () => {
    const prepared = prepareImport()
    const adapter = createAdapter()
    let indexedOperationId: string | null = null

    adapter.run((transaction) =>
      bindDurableCustodyProofImport({
        transaction: recordingIndex(
          transaction,
          (operationId) => (indexedOperationId = operationId),
        ),
        prepared,
      }),
    )
    const applied = adapter.run((transaction) => applyImport(transaction, prepared, 20))

    assert.equal(indexedOperationId, prepared.record.operation.operationId)
    assert.equal(applied.operation.result.state, 'applied')
    assert.deepEqual(adapter.readAdmittedProofIds(), prepared.successorProofIds)
  })

  it('makes an exact applied retry idempotent', () => {
    const prepared = prepareImport()
    const adapter = createAdapter()
    adapter.run((transaction) => bindDurableCustodyProofImport({ transaction, prepared }))
    const first = adapter.run((transaction) => applyImport(transaction, prepared, 20))
    const second = adapter.reopen().run((transaction) => applyImport(transaction, prepared, 30))

    assert.equal(second.revision, first.revision)
    assert.equal(second.operation.result.resultFingerprint, prepared.artifacts.result.fingerprint)
  })

  it('rejects a changed canonical proof body under the same source operation', () => {
    const prepared = prepareImport()
    const changed = prepareImport({ proofs: [proof({ C: 'changed-proof-C' })] })
    const adapter = createAdapter()
    adapter.run((transaction) => bindDurableCustodyProofImport({ transaction, prepared }))

    assert.throws(
      () =>
        adapter.run((transaction) =>
          bindDurableCustodyProofImport({ transaction, prepared: changed }),
        ),
      /immutable authority/,
    )
    assert.notEqual(changed.artifacts.result.fingerprint, prepared.artifacts.result.fingerprint)
  })

  it('resumes one exact staged result after restart', () => {
    const prepared = prepareImport()
    const adapter = createAdapter()
    adapter.run((transaction) => bindDurableCustodyProofImport({ transaction, prepared }))
    adapter.run((transaction) => stageImport(transaction, prepared, 20))

    const restarted = adapter.reopen()
    const applied = restarted.run((transaction) => applyImport(transaction, prepared, 30))

    assert.equal(applied.operation.result.state, 'applied')
    assert.deepEqual(restarted.readAdmittedProofIds(), prepared.successorProofIds)
  })

  it('rejects a staged result artifact conflict before admitting proofs', () => {
    const prepared = prepareImport()
    const adapter = createAdapter()
    adapter.run((transaction) => bindDurableCustodyProofImport({ transaction, prepared }))
    adapter.run((transaction) => stageImport(transaction, prepared, 20))

    assert.throws(
      () =>
        adapter.run((transaction) =>
          applyImport(withForeignResultArtifact(transaction), prepared, 30),
        ),
      /artifact does not match its exact reference/,
    )
    assert.deepEqual(adapter.readAdmittedProofIds(), [])
  })

  it('rejects substituted staged and applied replay metadata', () => {
    const prepared = prepareImport()
    const staged = createAdapter()
    staged.run((transaction) => bindDurableCustodyProofImport({ transaction, prepared }))
    staged.run((transaction) => stageImport(transaction, prepared, 20))
    const applied = staged.reopen()
    applied.run((transaction) => applyImport(transaction, prepared, 30))

    for (const adapter of [staged, applied]) {
      for (const mutate of resultAuthorityMutations()) {
        assert.throws(
          () =>
            adapter
              .reopen()
              .run((transaction) =>
                applyImport(withMutatedResult(transaction, mutate), prepared, 40),
              ),
          /custody/,
        )
      }
    }
  })

  it('rejects foreign owner authorization and successor admission', () => {
    const prepared = prepareImport()
    const adapter = createAdapter()
    adapter.run((transaction) => bindDurableCustodyProofImport({ transaction, prepared }))

    assert.throws(
      () =>
        adapter.run((transaction) =>
          applyDurableCustodyProofImport({
            transaction,
            prepared,
            authorization: { ...owner(20), incarnationId: 'foreign-owner' },
            successorAdmission: admission(prepared),
          }),
        ),
      /authorization/,
    )
    assert.throws(
      () =>
        adapter.run((transaction) =>
          applyDurableCustodyProofImport({
            transaction,
            prepared,
            authorization: owner(20),
            successorAdmission: {
              ...admission(prepared),
              proofRows: [
                { proofId: 'foreign-proof', expectedRevision: null, admittedRevision: 0 },
              ],
            },
          }),
        ),
      /successor admission/,
    )
    assert.equal(adapter.readOperation()?.operation.result.state, 'none')
  })

  it('rolls back bind and apply fault boundaries and succeeds on exact retry', () => {
    const prepared = prepareImport()
    const adapter = createAdapter()
    assert.throws(
      () =>
        adapter.run(
          (transaction) => bindDurableCustodyProofImport({ transaction, prepared }),
          'rebuild-index',
        ),
      /injected fault/,
    )
    assert.equal(adapter.readOperation(), null)

    adapter.run((transaction) => bindDurableCustodyProofImport({ transaction, prepared }))
    assert.throws(
      () => adapter.run((transaction) => applyImport(transaction, prepared, 20), 'apply-result'),
      /injected fault/,
    )
    assert.equal(adapter.readOperation()?.operation.result.state, 'none')

    const applied = adapter.reopen().run((transaction) => applyImport(transaction, prepared, 30))
    assert.equal(applied.operation.result.state, 'applied')
  })

  it('rejects duplicate proof identities, unused keysets, and foreign keyset facts', () => {
    const exactProof = proof()
    assert.throws(() => prepareImport({ proofs: [exactProof, exactProof] }), /duplicated/)
    assert.throws(
      () => prepareImport({ keysets: [KEYSET, { ...KEYSET, keysetId: `01${'33'.repeat(32)}` }] }),
      /incomplete/,
    )
    assert.throws(() => prepareImport({ keysets: [{ ...KEYSET, unit: 'sat' }] }), /foreign/)
    assert.throws(() => prepareImport({ keysets: [{ ...KEYSET, curve: 'bls12-381' }] }), /foreign/)
  })
})

function prepareImport(
  override: Partial<Parameters<typeof prepareDurableCustodyProofImport>[0]> = {},
): PreparedDurableCustodyProofImport {
  return prepareDurableCustodyProofImport({
    scope: SCOPE,
    sourceOperationId: 'deposit:one',
    normalizedMint: SCOPE.normalizedMint,
    unit: SCOPE.unit,
    inventoryAccountId: SCOPE.inventoryAccountId,
    keysets: [KEYSET],
    proofs: [proof()],
    ...override,
  })
}

function proof(override: Partial<Proof> = {}): Proof {
  return {
    id: KEYSET.keysetId,
    amount: Amount.from(1),
    secret: 'proof-secret',
    C: 'proof-C',
    ...override,
  }
}

function createAdapter(): FaultInjectingDurableCustodyAdapter {
  return new FaultInjectingDurableCustodyAdapter(scopeState())
}

function scopeState(): DurableCustodyScopeState {
  return {
    schemaVersion: 1,
    scope: SCOPE,
    fencingEpoch: 1,
    owner: { incarnationId: 'wallet-service-1', leaseExpiresAtMs: 1_000 },
    effectiveClock: { highWaterMarkMs: 0 },
  }
}

function owner(observedAtMs: number): DurableCustodyOwnerAuthorization {
  return { incarnationId: 'wallet-service-1', fencingEpoch: 1, observedAtMs }
}

function admission(prepared: PreparedDurableCustodyProofImport) {
  return {
    scopeId: SCOPE.scopeId,
    operationId: prepared.record.operation.operationId,
    admissionId: `proof-import:${prepared.record.operation.operationId}`,
    proofRows: prepared.successorProofIds.map((proofId) => ({
      proofId,
      expectedRevision: null,
      admittedRevision: 0,
    })),
  }
}

function applyImport(
  transaction: DurableCustodyTransaction,
  prepared: PreparedDurableCustodyProofImport,
  observedAtMs: number,
) {
  return applyDurableCustodyProofImport({
    transaction,
    prepared,
    authorization: owner(observedAtMs),
    successorAdmission: admission(prepared),
  })
}

function stageImport(
  transaction: DurableCustodyTransaction,
  prepared: PreparedDurableCustodyProofImport,
  observedAtMs: number,
): void {
  const record = transaction.getOperation(prepared.record.operation.operationId)
  if (record === null) throw new Error('test import operation is absent')
  transaction.stageVerifiedResult({
    operationId: record.operation.operationId,
    expectedRevision: record.revision,
    authorization: owner(observedAtMs),
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
    resultHandle: `proof-import-result:${prepared.artifacts.result.fingerprint}`,
    resultFingerprint: prepared.artifacts.result.fingerprint,
    exactResult: prepared.artifacts.result,
    selectedSuccessorProofIds: prepared.successorProofIds,
  })
}

function recordingIndex(
  transaction: DurableCustodyTransaction,
  record: (operationId: string) => void,
): DurableCustodyTransaction {
  return {
    ...transaction,
    rebuildActiveWorkIndex: (input) => {
      record(input.operationRows[0]?.operationId ?? '')
      transaction.rebuildActiveWorkIndex(input)
    },
  }
}

function withForeignResultArtifact(
  transaction: DurableCustodyTransaction,
): DurableCustodyTransaction {
  return {
    ...transaction,
    getArtifact: (input) => {
      const row = transaction.getArtifact(input)
      if (row === null || !input.reference.artifactId.endsWith(':result')) return row
      return { ...row, artifact: prepareDurableCustodyExactArtifact({ foreign: true }) }
    },
  }
}

function withMutatedResult(
  transaction: DurableCustodyTransaction,
  mutate: (record: DurableCustodyRecord) => void,
): DurableCustodyTransaction {
  return {
    ...transaction,
    getOperation: (operationId) => {
      const record = transaction.getOperation(operationId)
      if (record === null) return null
      mutate(record)
      return record
    },
  }
}

function resultAuthorityMutations(): Array<(record: DurableCustodyRecord) => void> {
  return [
    (record) => {
      record.operation.result.resultHandle = 'foreign-result-handle'
    },
    (record) => {
      record.operation.result.resultFingerprint = '00'.repeat(32)
    },
    (record) => {
      const reference = record.operation.result.exactResult
      if (reference === null) throw new Error('test result reference is absent')
      reference.artifactId = 'foreign-result-reference'
    },
    (record) => {
      record.operation.proofStorage.lineage.selectedSuccessorProofIds = ['foreign-proof']
    },
  ]
}
