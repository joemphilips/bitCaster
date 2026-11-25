import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DURABLE_CUSTODY_RECORD_BYTES_MAX,
  createDurableCustodyDispatchIntent,
  createDurableProofOperationFacts,
  decodeDurableCustodyRecord,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyRecord,
} from '../src/durableCustody.ts'
import { assertDurableCustodyRecordCanHoldResult } from '../src/durableCustodyProofOperationRecord.ts'
import {
  LATER_RECORD_TEXT_BYTES,
  NEW_WALLET_OPERATION_INPUT_LIMIT,
  WalletOperationTooLargeError,
  assertNewWalletOperationFits,
  newWalletOperationBytes,
} from '../src/walletOperationSize.ts'

const PUBLIC_KEY = `02${'11'.repeat(32)}`
/** Two amounts of 53 bits, each split into powers of two: the send and its change. */
const LARGEST_SEND_OUTPUTS = 106
/** A scheme, a host name of 253 characters, and a port. Custody accepts only a mint origin. */
const LONGEST_MINT_ORIGIN = 267
const WORST = {
  inputs: NEW_WALLET_OPERATION_INPUT_LIMIT,
  outputs: 53,
  keysets: 1,
  mintOriginBytes: LONGEST_MINT_ORIGIN,
  operationKeyBytes: 128,
}

test('the size bound covers the completed record of each shape and refuses the rest', () => {
  for (const keysets of [1, 2, 8]) {
    for (const outputs of [1, 12, 53, LARGEST_SEND_OUTPUTS]) {
      for (let inputs = 1; inputs <= 200; inputs += 1) {
        const shape = { ...WORST, inputs, outputs, keysets }
        const ids = keysetIds(shape).slice(0, Math.min(inputs, keysets))
        const proofs = Array.from({ length: inputs }, (_, index) => ({
          id: ids[index % ids.length]!,
        }))
        const bound = newWalletOperationBytes(proofs, outputs)
        const fits = passes(() => assertNewWalletOperationFits(proofs, outputs))
        assert.equal(
          fits,
          inputs <= NEW_WALLET_OPERATION_INPUT_LIMIT && bound <= DURABLE_CUSTODY_RECORD_BYTES_MAX,
        )
        if (inputs % 20 !== 0 && !(fits && inputs === NEW_WALLET_OPERATION_INPUT_LIMIT)) continue
        if (bound > DURABLE_CUSTODY_RECORD_BYTES_MAX + 4_000) continue
        const record = createRecord(shape)
        assert.ok(bytesOf(withResult(record)) + LATER_RECORD_TEXT_BYTES <= bound)
        // What the shared check accepts, the last check before the effect accepts too.
        if (fits) assertDurableCustodyRecordCanHoldResult(record)
      }
    }
  }
})

test('the exact worst case fits, and one more output is refused', () => {
  const most = (outputs: number, inputs: number) =>
    passes(() =>
      assertNewWalletOperationFits(Array(inputs).fill({ id: keysetIds(WORST)[0]! }), outputs),
    )
  const outputs = Array.from({ length: 200 }, (_, index) => index).filter((count) =>
    most(count, NEW_WALLET_OPERATION_INPUT_LIMIT),
  )
  const largest = Math.max(...outputs)
  const record = createRecord({ ...WORST, outputs: largest })
  assertDurableCustodyRecordCanHoldResult(record)
  decodeDurableCustodyRecord(withResult(record))
  assert.equal(most(largest + 1, NEW_WALLET_OPERATION_INPUT_LIMIT), false)
  assert.equal(most(largest, NEW_WALLET_OPERATION_INPUT_LIMIT + 1), false)
  assert.ok(largest >= 48, `${largest} outputs at the input limit`)
})

test('a record that holds its request but not its result is refused with the fixed code', () => {
  // The daemon reached this state near 190 inputs: the mint signed, and no recovery could save it.
  const record = createRecord({
    ...WORST,
    inputs: 185,
    outputs: 12,
    keysets: 1,
    mintOriginBytes: 24,
  })
  assert.ok(bytesOf(record) <= DURABLE_CUSTODY_RECORD_BYTES_MAX)
  assert.throws(
    () => assertDurableCustodyRecordCanHoldResult(record),
    (error: Error) =>
      error instanceof WalletOperationTooLargeError &&
      error.code === 'wallet-operation-too-large' &&
      error.message.includes('Use a smaller amount'),
  )
})

test('a saved record above the new-operation limit still loads', () => {
  const record = createRecord({
    ...WORST,
    inputs: 180,
    outputs: 2,
    mintOriginBytes: 24,
    operationKeyBytes: 1,
  })
  assert.equal(decodeDurableCustodyRecord(record).operation.reservation.inputs.length, 180)
})

function passes(check: () => void): boolean {
  try {
    check()
    return true
  } catch (error) {
    assert.ok(error instanceof WalletOperationTooLargeError)
    return false
  }
}

function keysetIds(shape: Pick<typeof WORST, 'keysets'>): string[] {
  return Array.from({ length: shape.keysets }, (_, index) => `01${hex('a', index)}`)
}

function hex(prefix: string, index: number): string {
  return `${prefix}${index.toString(16)}`.padEnd(64, '0')
}

function createRecord(shape: typeof WORST): DurableCustodyRecord {
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(32).fill(7))
  const scope = { scopeKind: 'wallet' as const, walletId }
  const key = 'k'.repeat(shape.operationKeyBytes)
  const ids = keysetIds(shape)
  const facts = createDurableProofOperationFacts({
    unit: 'msat',
    binding: { kind: 'wallet', activityId: key, stage: 'send' },
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: true,
    inputKeysetRequirement: 'required',
    keysets: ids.map((keysetId, index) => ({
      keysetId,
      unit: 'msat',
      curve: 'secp256k1',
      publicKeys: { '1': PUBLIC_KEY },
      keysetExpiryMs: 9_999_999_999_999,
      requireDleq: true,
      usedByInputs: true,
      usedByOutputs: index === 0,
    })),
  })
  const inputs = Array.from({ length: shape.inputs }, (_, index) => ({
    proofId: hex('b', index + 4_096),
    keysetId: ids[index % ids.length]!,
    curve: 'secp256k1' as const,
  }))
  const proofIds = inputs.map(({ proofId }) => proofId)
  const artifact = prepareDurableCustodyExactArtifact({ kind: 'exact' })
  const { fingerprint } = artifact
  return createDurableCustodyDispatchIntent({
    scope: { ...scope, scopeId: deriveDurableCustodyScopeId(scope) },
    retainedOperationKey: key,
    semanticKind: 'wallet-send',
    facts,
    normalizedMint: mintOrigin(shape.mintOriginBytes),
    inventoryAccountId: null,
    reservation: {
      reservationId: `wallet-send:${key}`,
      parentReservationId: null,
      inputs,
    },
    proofLineage: {
      predecessorProofIds: proofIds,
      successorProofIds: Array.from({ length: shape.outputs }, (_, index) =>
        hex('c', index + 4_096),
      ),
      successorAdmissionMode: 'exact',
    },
    exactRequest: {
      requestId: `request:${fingerprint}`,
      requestFingerprint: fingerprint,
      payloadHandle: `request-payload:${fingerprint}`,
      inputProofIds: proofIds,
      outputPlanFingerprint: fingerprint,
      method: 'POST',
      path: '/v1/melt/bolt11',
      idempotencyKey: key,
      body: artifact,
    },
    outputPlan: {
      outputPlanId: `output-plan:${fingerprint}`,
      outputPlanFingerprint: fingerprint,
      outputMaterialHandle: `output-material:${fingerprint}`,
      exactOutput: artifact,
    },
    privateMaterial: {
      materialHandle: `private-material:${fingerprint}`,
      useId: `private-use:${fingerprint}`,
      publicFingerprint: fingerprint,
      exactPrivateMaterial: artifact,
    },
  })
}

function mintOrigin(bytes: number): string {
  const host = Array.from({ length: bytes - 'https://'.length - '.example'.length }, (_, index) =>
    index % 60 === 59 ? '.' : 'm',
  ).join('')
  return `https://${host.replace(/\.$/, 'm')}.example`
}

/** The record as the mint result transition completes it. */
function withResult(record: DurableCustodyRecord): DurableCustodyRecord {
  const { operation } = record
  const { lineage } = operation.proofStorage
  const fingerprint = operation.exactRequest.requestFingerprint
  return {
    ...record,
    revision: 2,
    operation: {
      ...operation,
      state: 'reconciled',
      result: {
        state: 'applied',
        resultHandle: `mint-result:${fingerprint}`,
        resultFingerprint: fingerprint,
        outputPlanFingerprint: fingerprint,
        exactResult: {
          ...operation.exactRequest.body,
          artifactId: operation.exactRequest.body.artifactId.replace(/request$/, 'result'),
        },
      },
      proofStorage: {
        ...operation.proofStorage,
        pinReasons: [],
        lineage: {
          ...lineage,
          selectedSuccessorProofIds: [...lineage.successorProofIds],
          successorAdmission: {
            scopeId: lineage.scopeId,
            operationId: lineage.operationId,
            admissionId: `wallet-send:${fingerprint}`,
            proofRows: lineage.successorProofIds.map((proofId) => ({
              proofId,
              expectedRevision: null,
              admittedRevision: 0,
            })),
          },
        },
      },
    },
  }
}

function bytesOf(record: DurableCustodyRecord): number {
  return new TextEncoder().encode(JSON.stringify(record)).length
}
