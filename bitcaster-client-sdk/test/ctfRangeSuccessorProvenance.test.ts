import assert from 'node:assert/strict'
import test from 'node:test'
import { OutputData, createCtfSelectionBitmap } from '@cashu/cashu-ts'
import { signedOwnerRangeFixture } from './support/signedOwnerRangeFixture.ts'
import { FaultInjectingDurableCustodyAdapter } from './support/faultInjectingDurableCustodyAdapter.ts'
import {
  createDurableCtfRangeCustodyBinding,
  createDurableCtfRangeResultEnvelope,
  prepareDurableCtfRangeVerifiedResult,
  toDurableCtfRangeProofOperationInput,
} from '../src/durableCtfRangeOperation.ts'
import { mapDurableCtfRangeSuccessorProofs } from '../src/durableCtfRangeCustody.ts'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  resolveDurableCustodyProofOperationFacts,
} from '../src/index.ts'
import { bindDurableCustodyProofOperation } from '../src/durableCustodyProofOperationRecord.ts'
import { createEncryptedWalletBackupV2AssetIdentity } from '../src/encryptedWalletBackupV2ProofSet.ts'
import { deserializeDurableCustodyProofArtifact } from '../src/durableCustodyProofMaterial.ts'

async function stagedFixture(plain: boolean, side: 'Buy' | 'Sell' = 'Buy', zero = false) {
  const fixture = signedOwnerRangeFixture({
    plain,
    side,
    ...(zero ? { offerStart: 0, receiveStart: 0 } : {}),
  })
  const { operation, preparation, seed, keys } = fixture
  const walletId = deriveDurableCustodyWalletId(seed)
  const scope = {
    scopeKind: 'wallet' as const,
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId }),
  }
  const mintKeysets = new Map(
    [operation.keysetAuthority.offer, operation.keysetAuthority.receive].map((authority) => [
      authority.keysetId,
      {
        canonicalMintUrl: operation.mintUrl,
        id: authority.keysetId,
        unit: authority.unit,
        keys,
        inputFeePpk: authority.inputFeePpk,
        finalExpiry: authority.finalExpiry,
      },
    ]),
  )
  const binding = createDurableCtfRangeCustodyBinding({
    scope,
    operation,
    facts: await resolveDurableCustodyProofOperationFacts({
      operation: toDurableCtfRangeProofOperationInput(operation),
      resolveMintKeys: async () =>
        new Map(
          [...mintKeysets].map(([id, k]) => [
            id,
            { id, unit: k.unit, keys: k.keys, final_expiry: k.finalExpiry ?? undefined },
          ]),
        ),
      requireDleq: true,
    }),
    mintKeysets,
    inventoryAccountId: null,
    boundary: {
      method: 'POST',
      path: '/v1/range-authorizations',
      idempotencyKey: operation.authorizationId,
      requestBody: { authorizationId: operation.authorizationId },
    },
  })
  const receive = BigInt(operation.policy.minReceive)
  const selected = operation.manifest.entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) => (BigInt(entry.amount) & (entry.role === 'receive' ? receive : 1n)) !== 0n,
    )
  const selection = createCtfSelectionBitmap(
    operation.manifest.entries.length,
    selected.map((x) => x.index),
  )
  const result = prepareDurableCtfRangeVerifiedResult({
    record: binding.record,
    operation,
    envelope: createDurableCtfRangeResultEnvelope({
      operation,
      requestDigest: 'ef'.repeat(32),
      selection,
      signatures: selected.map(({ entry }) =>
        fixture.signBlindedMessage(OutputData.deserialize(entry.outputData).blindedMessage),
      ),
    }),
    resolveKeyset: (_url, id) => mintKeysets.get(id),
  })
  assert.equal(result.kind, 'confirmed')
  if (result.kind !== 'confirmed') throw new Error('fixture result not verified')
  const adapter = new FaultInjectingDurableCustodyAdapter({
    schemaVersion: 1,
    scope,
    fencingEpoch: 1,
    owner: { incarnationId: 'process-1', leaseExpiresAtMs: 1000 },
    effectiveClock: { highWaterMarkMs: 10 },
  })
  adapter.run((tx) => bindDurableCustodyProofOperation(tx, binding.record, binding.artifacts))
  adapter.run((tx) =>
    tx.stageVerifiedResult({
      operationId: binding.record.operation.operationId,
      expectedRevision: 0,
      authorization: { incarnationId: 'process-1', fencingEpoch: 1, observedAtMs: 20 },
      outputPlanFingerprint: binding.record.operation.outputPlan.outputPlanFingerprint,
      resultHandle: result.resultHandle,
      resultFingerprint: result.resultFingerprint,
      exactResult: result.exactResult,
      selectedSuccessorProofIds: result.selectedSuccessorProofIds,
    }),
  )
  return { fixture, operation, preparation, seed, record: adapter.readOperation()!, result }
}

for (const plain of [false, true])
  for (const zero of plain ? [false, true] : [false])
    for (const side of ['Buy', 'Sell'] as const)
      test(`verified ${plain ? 'ordinary-counter' : 'legacy-contextual'} ${side} ${zero ? 'zero' : 'nonzero'} successors map to stored proofs and asset identities`, async () => {
        const { operation, preparation, seed, record, result } = await stagedFixture(
          plain,
          side,
          zero,
        )
        const successors = mapDurableCtfRangeSuccessorProofs(
          { record, operation, result: result.result, preparation, seed },
          (value) => value,
        )
        assert.ok(successors.some((s) => s.classification.conditionId === null))
        assert.ok(successors.some((s) => s.classification.conditionId !== null))
        for (const successor of successors) {
          const conditional = successor.classification.conditionId !== null
          const metadata = preparation.expiryObservation.conditionalKeysets.find(
            (k) => k.keysetId === successor.material.keysetId,
          )
          assert.equal(metadata !== undefined, conditional)
          const proof = deserializeDurableCustodyProofArtifact({
            schemaVersion: 1,
            ...successor.proof,
          })
          assert.equal(proof.id, successor.material.keysetId)
          const identity = createEncryptedWalletBackupV2AssetIdentity({
            mintUrl: operation.mintUrl,
            unit: 'msat',
            asset: conditional
              ? {
                  kind: 'ctf',
                  conditionId: operation.conditionId,
                  outcomeLabel: metadata!.outcomeCollection as string,
                  outcomeCollectionId: metadata!.outcomeCollectionId as string,
                  registeredAt: metadata!.registeredAt as number,
                  finalExpiry: metadata!.finalExpiry as number,
                }
              : { kind: 'ordinary' },
          })
          assert.equal(
            identity.assetIdentity,
            conditional
              ? `ctf:${operation.conditionId}:${metadata!.outcomeCollectionId}`
              : 'cashu:ordinary',
          )
        }
      })

test('ordinary successor provenance refuses missing, stripped and foreign preparation before mapping', async () => {
  const base = await stagedFixture(true)
  const stripped = structuredClone(base.preparation) as unknown as Record<string, unknown>
  delete stripped.receiveCounterStart
  const downgrade = structuredClone(base.preparation) as unknown as Record<string, unknown>
  downgrade.version = 2
  for (const field of [
    'preparationIntent',
    'preparationIntentDigest',
    'offerCounterStart',
    'offerCounterCount',
    'receiveCounterStart',
    'receiveCounterCount',
  ])
    delete downgrade[field]
  const variants = [
    undefined,
    stripped,
    downgrade,
    { ...base.preparation, receiveCounterStart: 12 },
    { ...base.preparation, offerCounterCount: 1 },
    { ...base.preparation, operationId: 'foreign' },
    { ...base.preparation, mintUrl: 'https://foreign.example' },
  ]
  for (const preparation of variants) {
    let mapped = 0
    assert.throws(() =>
      mapDurableCtfRangeSuccessorProofs(
        {
          record: base.record,
          operation: base.operation,
          result: base.result.result,
          preparation,
          seed: base.seed,
        },
        () => {
          mapped++
        },
      ),
    )
    assert.equal(mapped, 0)
  }
  const foreignSeed = new Uint8Array(base.seed)
  foreignSeed[0] ^= 1
  assert.throws(
    () =>
      mapDurableCtfRangeSuccessorProofs(
        {
          record: base.record,
          operation: base.operation,
          result: base.result.result,
          preparation: base.preparation,
          seed: foreignSeed,
        },
        () => null,
      ),
    /seed scope/,
  )
})
