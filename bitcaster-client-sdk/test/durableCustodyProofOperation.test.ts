import assert from 'node:assert/strict'
import test from 'node:test'
import { OutputData } from '@cashu/cashu-ts'
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
  deriveDurableCustodyProofOperationFingerprints,
  deriveDurableCustodyProofResultFingerprint,
} from '../src/durableCustodyProofOperationRecord.ts'
import {
  addDurableWalletProofTransitionMetadata,
  createDurableWalletProofTransition,
} from '../src/durableWalletProofTransition.ts'
import { FaultInjectingDurableCustodyAdapter } from './support/faultInjectingDurableCustodyAdapter.ts'
import {
  durableCustodyProofOperationSemanticKind,
  decodeDurableCustodyProofOperationInput,
  deserializeDurableCustodyOutput,
  resolveDurableCustodyProofOperationFacts,
  serializeDurableCustodyOutput,
  type DurableCustodyProofOperationInput,
} from '../src/durableCustodyProofOperation.ts'
import {
  assertDurableCustodyArtifactMatchesReference,
  assertDurableCustodyImmutableAuthorityMatches,
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyScopeId,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyScope,
} from '../src/durableCustody.ts'

const KEYSET = 'keyset-1'
const PUBLIC_KEY = `02${'44'.repeat(32)}`

function exactBoundary() {
  const artifact = (value: unknown) => ({
    encoding: 'canonical-json' as const,
    artifact: value,
    fingerprint: deriveDurableCustodyArtifactFingerprint(value),
  })
  return {
    method: 'POST' as const,
    path: '/v1/real-mint-boundary',
    idempotencyKey: 'real-boundary-operation-1',
    requestBody: artifact({ wire: 'request', bytes: [1, 2, 3] }),
    output: artifact({ wire: 'outputs', bytes: [4, 5, 6] }),
    privateMaterial: artifact({ wire: 'private', bytes: [7, 8, 9] }),
  }
}

function walletScope(): DurableCustodyScope {
  const input = { scopeKind: 'wallet' as const, walletId: 'a'.repeat(64) }
  return { ...input, scopeId: deriveDurableCustodyScopeId(input) }
}

function operation(kind: DurableCustodyProofOperationInput['kind'] = 'regular-split') {
  return {
    operationId: 'operation-1',
    kind,
    mintUrl: 'https://mint.example',
    inputs: [{ id: KEYSET, amount: 1, secret: 'secret-1', C: 'signature-1' }],
    outputs: {
      keep: [
        {
          blindedMessage: { id: KEYSET, amount: 1, B_: 'blinded-1' },
          blindingFactor: 'blinding-1',
          secret: 'output-secret-1',
        },
      ],
    },
    metadata: { unit: 'sat' },
  } satisfies DurableCustodyProofOperationInput
}

test('proof-operation facts bind exact wallet unit, scope, and real mint keys', async () => {
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation: operation(),
    resolveMintKeys: async () =>
      new Map([
        [
          KEYSET,
          {
            id: KEYSET,
            unit: 'sat',
            keys: { '1': PUBLIC_KEY },
          },
        ],
      ]),
    requireDleq: false,
  })
  assert.deepEqual(facts.binding, {
    kind: 'wallet',
    activityId: 'operation-1',
    stage: 'send',
  })
  assert.equal(facts.unit, 'sat')
  assert.equal(facts.verification.inputKeysets[0]?.keysetId, KEYSET)
  assert.equal(
    durableCustodyProofOperationSemanticKind('conditional-keyset-swap'),
    'conditional-keyset-swap',
  )
  assert.equal(
    durableCustodyProofOperationSemanticKind('ctf-range-regular-source'),
    'ctf-range-regular-source',
  )
  assert.equal(
    durableCustodyProofOperationSemanticKind('ctf-range-conditional-source'),
    'ctf-range-conditional-source',
  )
  assert.equal(
    durableCustodyProofOperationSemanticKind('ctf-range-collateral-convert'),
    'ctf-range-collateral-convert',
  )
  assert.equal(durableCustodyProofOperationSemanticKind('ctf-range-refund'), 'ctf-range-refund')
  assert.throws(() => durableCustodyProofOperationSemanticKind('swap-refund' as never), /kind/)
})

test('CTF range refunds retain an explicit non-HTLC custody stage', async () => {
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation: operation('ctf-range-refund'),
    resolveMintKeys: async () =>
      new Map([[KEYSET, { id: KEYSET, unit: 'sat', keys: { '1': PUBLIC_KEY } }]]),
    requireDleq: false,
  })
  assert.equal(facts.binding.stage, 'ctf-range-refund')
})

test('proof-operation bounds and curve-specific mint keys fail closed', async () => {
  const base = operation()
  const proof = base.inputs[0]!
  const atMaximum = {
    ...base,
    inputs: Array.from({ length: 256 }, (_, index) => ({
      ...proof,
      secret: `secret-${index}`,
      C: `signature-${index}`,
    })),
  }
  assert.equal(decodeDurableCustodyProofOperationInput(atMaximum).inputs.length, 256)
  assert.throws(
    () =>
      decodeDurableCustodyProofOperationInput({
        ...atMaximum,
        inputs: [...atMaximum.inputs, proof],
      }),
    /input limit/,
  )
  const bls = await resolveDurableCustodyProofOperationFacts({
    operation: base,
    resolveMintKeys: async () =>
      new Map([
        [
          KEYSET,
          {
            id: KEYSET,
            unit: 'sat',
            keys: { '1': `8${'0'.repeat(191)}` },
          },
        ],
      ]),
    requireDleq: false,
  })
  assert.equal(bls.verification.inputKeysets[0]?.curve, 'bls12-381')
  await assert.rejects(
    () =>
      resolveDurableCustodyProofOperationFacts({
        operation: base,
        resolveMintKeys: async () =>
          new Map([[KEYSET, { id: KEYSET, unit: 'sat', keys: { '1': '00'.repeat(96) } }]]),
        requireDleq: false,
      }),
    /public keys/,
  )
})

test('proof-operation nested metadata and witness are strict and bounded', () => {
  assert.throws(
    () =>
      decodeDurableCustodyProofOperationInput({
        ...operation(),
        inputs: [
          {
            ...operation().inputs[0],
            dleq: { e: 'e', s: 's', foreign: true },
          },
        ],
      }),
    /foreign fields/,
  )
  let deep: unknown = 'leaf'
  for (let index = 0; index < 33; index += 1) deep = { child: deep }
  assert.throws(
    () =>
      decodeDurableCustodyProofOperationInput({
        ...operation(),
        metadata: { unit: 'sat', deep },
      }),
    /structure limit/,
  )
})

test('proof-operation semantics reject foreign protocol operations', async () => {
  assert.throws(
    () => durableCustodyProofOperationSemanticKind('foreign-operation' as never),
    /kind/,
  )
  await assert.rejects(
    () =>
      resolveDurableCustodyProofOperationFacts({
        operation: { ...operation(), foreignAuthority: {} } as never,
        resolveMintKeys: async () => new Map(),
        requireDleq: false,
      }),
    /foreign fields|invalid/,
  )
})

test('canonical proof-operation record binds exact request and result authority', async () => {
  const exact = operation()
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation: exact,
    resolveMintKeys: async () =>
      new Map([[KEYSET, { id: KEYSET, unit: 'sat', keys: { '1': PUBLIC_KEY } }]]),
    requireDleq: false,
  })
  const record = createDurableCustodyProofOperation({
    scope: walletScope(),
    operation: exact,
    facts,
    inventoryAccountId: null,
    exactBoundary: exactBoundary(),
  })
  const fingerprints = exactBoundary()
  assert.equal(
    record.operation.exactRequest.requestFingerprint,
    fingerprints.requestBody.fingerprint,
  )
  assert.equal(record.operation.exactRequest.method, fingerprints.method)
  assert.equal(record.operation.exactRequest.path, fingerprints.path)
  assert.equal(record.operation.exactRequest.idempotencyKey, fingerprints.idempotencyKey)
  assertDurableCustodyArtifactMatchesReference(
    record.operation.exactRequest.body,
    fingerprints.requestBody,
  )
  assert.notEqual(
    record.operation.exactRequest.requestFingerprint,
    deriveDurableCustodyProofOperationFingerprints(exact).requestFingerprint,
  )
  assert.match(
    deriveDurableCustodyProofResultFingerprint({
      keep: exact.inputs,
    }),
    /^[0-9a-f]{64}$/,
  )
  assert.throws(
    () =>
      createDurableCustodyProofOperation({
        scope: walletScope(),
        operation: exact,
        facts: { ...facts, unit: 'usd' },
        inventoryAccountId: null,
        exactBoundary: exactBoundary(),
      }),
    /unit/,
  )
  assert.throws(
    () =>
      assertDurableCustodyImmutableAuthorityMatches(
        {
          ...record,
          operation: {
            ...record.operation,
            exactRequest: {
              ...record.operation.exactRequest,
              method: 'DELETE',
            },
          },
        },
        record,
      ),
    /immutable authority/,
  )
})

test('external wallet receive retains exact inputs without local reservation lineage', async () => {
  const external = {
    ...operation('wallet-receive'),
    metadata: addDurableWalletProofTransitionMetadata(
      { unit: 'sat' },
      createDurableWalletProofTransition({
        inputSource: 'external',
        plannedOutputLabels: ['keep'],
        resultGroups: { keep: { kind: 'wallet', asset: 'regular', reservedBy: null } },
      }),
    ),
  }
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation: external,
    resolveMintKeys: async () =>
      new Map([[KEYSET, { id: KEYSET, unit: 'sat', keys: { '1': PUBLIC_KEY } }]]),
    requireDleq: false,
  })
  const requestBody = prepareDurableCustodyExactArtifact(external)
  const boundary = { ...exactBoundary(), requestBody }
  const record = createDurableCustodyProofOperation({
    scope: walletScope(),
    operation: external,
    facts,
    inventoryAccountId: null,
    exactBoundary: boundary,
  })
  assert.deepEqual(
    (boundary.requestBody.artifact as DurableCustodyProofOperationInput).inputs,
    external.inputs,
  )
  assert.equal(external.inputs.length, 1)
  assert.deepEqual(record.operation.reservation.inputs, [])
  assert.deepEqual(record.operation.exactRequest.inputProofIds, [])
  assert.deepEqual(record.operation.proofStorage.lineage.predecessorProofIds, [])
  const adapter = new FaultInjectingDurableCustodyAdapter({
    schemaVersion: 1,
    scope: walletScope(),
    fencingEpoch: 0,
    owner: null,
    effectiveClock: { highWaterMarkMs: 0 },
  })
  assert.doesNotThrow(() =>
    adapter.run((transaction) =>
      bindDurableCustodyProofOperation(transaction, record, {
        requestBody: boundary.requestBody,
        output: boundary.output,
        privateMaterial: boundary.privateMaterial,
      }),
    ),
  )
})

test('wallet-input proof operations retain their reservation lineage', async () => {
  const exact = operation()
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation: exact,
    resolveMintKeys: async () =>
      new Map([[KEYSET, { id: KEYSET, unit: 'sat', keys: { '1': PUBLIC_KEY } }]]),
    requireDleq: false,
  })
  const record = createDurableCustodyProofOperation({
    scope: walletScope(),
    operation: exact,
    facts,
    inventoryAccountId: null,
    exactBoundary: exactBoundary(),
  })
  assert.equal(record.operation.reservation.inputs.length, 1)
  assert.equal(record.operation.exactRequest.inputProofIds.length, 1)
  assert.equal(record.operation.proofStorage.lineage.predecessorProofIds.length, 1)
})

test('custody output serialization preserves final proof identity and exact private material', () => {
  const output = OutputData.createSingleRandomData(1, KEYSET)
  const serialized = serializeDurableCustodyOutput(output)
  const restored = deserializeDurableCustodyOutput(serialized)
  assert.deepEqual(OutputData.serialize(restored), OutputData.serialize(output))

  assert.throws(
    () =>
      deserializeDurableCustodyOutput({
        ...serialized,
        blindedMessage: { ...serialized.blindedMessage, B_: `02${'11'.repeat(32)}` },
      }),
    /does not match/,
  )
})
