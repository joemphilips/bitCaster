import assert from 'node:assert/strict'
import { createCtfRangeManifest, deriveKeysetId } from '@cashu/cashu-ts'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import {
  decryptEncryptedWalletBackupV2ProofSetBundle,
  prepareEncryptedWalletBackupV2ProofSetBundle,
  type EncryptedWalletBackupV2ProofSetProof,
} from '../src/encryptedWalletBackupV2ProofSet.ts'
import {
  prepareEncryptedWalletBackupV2TransportBundle,
  type EncryptedWalletBackupV2BundleRuntime,
  type EncryptedWalletBackupV2PreparedTransportBundle,
} from '../src/encryptedWalletBackupV2Bundle.ts'
import { encodeCanonicalBackupCbor } from '../src/encryptedWalletBackupCbor.ts'
import { serializeDurableCustodyProofArtifact } from '../src/durableCustodyProofMaterial.ts'
import { encodeDurableWalletProofDerivationLocatorCbor } from '../src/durableWalletProofDerivationLocator.ts'
import { deriveDurableWalletProofSecret } from '../src/durableWalletProofDerivationLocator.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'

const SEED = Uint8Array.from({ length: 64 }, (_value, index) => index)
const KEYSET = deriveKeysetId(
  { '1': '02194603ffa36356f4a56b7df9371fc3192472351453ec7398b8da8117e7c3e104' },
  { unit: 'sat', versionByte: 1 },
)
const MINT = 'https://mint.example'

test('v2 proof set restores one asset proof material', async () => {
  const keyHandle = await handle()
  const proofs = [proof(0, { kind: 'ordinary' }), proof(1, { kind: 'ordinary' })]
  const prepared = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset: proofSetAsset(proofs[0]!),
    custodyRevision: 1n,
    proofs,
    counterHighWaterMarks: [{ mintUrl: MINT, unit: 'sat', keysetId: KEYSET, nextCounter: 2 }],
    runtime: webcrypto,
  })
  assert.equal(
    Object.values(prepared.descriptor).some((value) => value === MINT),
    false,
  )
  const descriptorText = Object.keys(prepared.descriptor).join(',')
  for (const privateValue of [
    MINT,
    'YES',
    proofs[1]!.asset.kind === 'ctf' ? proofs[1]!.asset.conditionId : '',
    proofs[0]!.proof.id,
    proofs[0]!.proof.secret,
    'proofCount',
    'payloadLength',
  ].filter((value) => value.length > 0))
    assert.equal(descriptorText.includes(privateValue), false)
  const restored = await decryptEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    expectedAsset: proofSetAsset(proofs[0]!),
    custodyRevision: 1n,
    runtime: webcrypto,
    ...prepared,
  })
  assert.equal(restored.proofs.length, 2)
  assert.equal(restored.proofs[1]!.asset.kind, 'ordinary')
  assert.equal(restored.counterHighWaterMarks[0]!.nextCounter, 2)
  restored.proofs[0]!.proof.secret = '00'.repeat(32)
  assert.notEqual(restored.proofs[0]!.proof.secret, proof(0, { kind: 'ordinary' }).proof.secret)
})

test('v2 proof set derives the declared amount from every retained proof', async () => {
  const keyHandle = await handle()
  const change = proof(0, { kind: 'ordinary' }, false, 3)
  const retained = proof(1, { kind: 'ordinary' }, false, 7)
  const asset = proofSetAsset(change)
  const prepared = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset,
    custodyRevision: 2n,
    proofs: [change, retained],
    counterHighWaterMarks: [counter(2)],
    runtime: webcrypto,
  })
  assert.equal(prepared.descriptor.declaredAmount, 10n)

  const staleSuccessor = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset,
    declaredAmount: 10n,
    custodyRevision: 3n,
    canonicalPayload: proofSetPayload([change], [counter(2)]),
    runtime: webcrypto,
  })
  await assert.rejects(
    () =>
      decryptEncryptedWalletBackupV2ProofSetBundle({
        keyHandle,
        seed: SEED,
        expectedAsset: asset,
        custodyRevision: 3n,
        runtime: webcrypto,
        ...staleSuccessor,
      }),
    /declared amount/,
  )
})

test('v2 proof set enforces proof and counter row bounds before randomness', async () => {
  const keyHandle = await handle()
  const runtime = countingRuntime()
  const sharedCtfAsset = ctfAsset()
  const exactProofs = Array.from({ length: 512 }, (_, index) => proof(index, sharedCtfAsset, true))
  await assert.rejects(
    () =>
      prepareWithRuntime(
        keyHandle,
        Array.from({ length: 65 }, (_, index) => proof(index, ctfAssetFor(index))),
        [counter(65)],
        webcrypto,
      ),
    /asset is foreign/,
  )
  const exactCounters = Array.from({ length: 512 }, (_, index) =>
    index === 0 ? counter(512) : counterForKeyset(keysetFor(index), 0),
  )
  const exactPrepared = await prepareWithRuntime(keyHandle, exactProofs, exactCounters, webcrypto)
  const exactRestored = await restore(
    keyHandle,
    exactPrepared,
    proofSetAsset(exactProofs[0]!),
    512n,
  )
  assert.equal(exactRestored.proofs.length, 512)
  assert.equal(exactRestored.counterHighWaterMarks.length, 512)
  await assert.rejects(
    () =>
      prepareWithRuntime(
        keyHandle,
        Array.from({ length: 513 }, () => proof(0, { kind: 'ordinary' })),
        [],
        runtime,
      ),
    /proofs are invalid/,
  )
  await assert.rejects(
    () =>
      prepareWithRuntime(
        keyHandle,
        [proof(0, { kind: 'ordinary' })],
        Array.from({ length: 513 }, () => counter(1)),
        runtime,
      ),
    /counters are invalid/,
  )
  assert.equal(runtime.calls, 0)
})

test('v2 proof set accepts CTF range provenance without a NUT-13 counter row', async () => {
  const keyHandle = await handle()
  const rangeProof = ctfRangeProof()
  const prepared = await prepareWithRuntime(keyHandle, [rangeProof], [], webcrypto)
  const restored = await decryptEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    expectedAsset: proofSetAsset(rangeProof),
    custodyRevision: 1n,
    runtime: webcrypto,
    ...prepared,
  })
  assert.equal(restored.proofs[0]!.locator.kind, 'ctf-range-manifest')
})

test('v2 proof set rejects authenticated asset and custody metadata mismatches', async () => {
  const keyHandle = await handle()
  const proofs = [proof(0, { kind: 'ordinary' })]
  const payload = proofSetPayload(proofs, [counter(2)])
  const ordinary = proofSetAsset(proofs[0]!)
  const foreignAsset = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset: { ...ordinary, assetIdentity: 'cashu:foreign' },
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: payload,
    runtime: webcrypto,
  })
  await assert.rejects(() => restore(keyHandle, foreignAsset), /asset is foreign/)
  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset: ordinary,
    declaredAmount: 2n,
    custodyRevision: 1n,
    canonicalPayload: payload,
    runtime: webcrypto,
  })
  await assert.rejects(
    () =>
      decryptEncryptedWalletBackupV2ProofSetBundle({
        keyHandle,
        seed: SEED,
        expectedAsset: ordinary,
        custodyRevision: 1n,
        runtime: webcrypto,
        ...prepared,
      }),
    /declared amount/,
  )
})

test('v2 proof set snapshots accessor-backed descriptor bindings before await', async () => {
  const keyHandle = await handle()
  const entry = proof(0, { kind: 'ordinary' })
  const payload = proofSetPayload([entry], [counter(1)])
  const ordinary = { mintUrl: MINT, unit: 'sat' as const, assetIdentity: 'cashu:ordinary' }
  const expected = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset: ordinary,
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: payload,
    runtime: webcrypto,
  })
  const foreignAsset = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset: { ...ordinary, assetIdentity: 'cashu:foreign' },
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: payload,
    runtime: webcrypto,
  })
  await assert.rejects(
    () =>
      restore(keyHandle, {
        ...foreignAsset,
        descriptor: accessorDescriptor(foreignAsset.descriptor, 'assetLocator', [
          expected.descriptor.assetLocator,
          foreignAsset.descriptor.assetLocator,
        ]),
      }),
    /asset is foreign|corrupt encrypted/,
  )
})

test('v2 proof set rejects noncanonical authenticated payloads', async () => {
  const keyHandle = await handle()
  const entry = proof(0, { kind: 'ordinary' })
  const canonical = proofSetPayload([entry], [counter(1)])
  const noncanonical = new Uint8Array(canonical.byteLength + 1)
  noncanonical.set([0x84, 0x18, 0x01])
  noncanonical.set(canonical.subarray(2), 3)
  const transport = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset: { mintUrl: MINT, unit: 'sat', assetIdentity: 'cashu:ordinary' },
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: noncanonical,
    runtime: webcrypto,
  })
  await assert.rejects(
    () => restore(keyHandle, transport),
    /proof set CBOR is invalid|noncanonical/,
  )
})

test('v2 proof set rejects wrong seed, duplicate proofs, and low counters before encryption', async () => {
  const keyHandle = await handle()
  const entry = proof(0, { kind: 'ordinary' })
  await assert.rejects(
    () => prepare({ keyHandle, seed: new Uint8Array(64).fill(9), proofs: [entry], counters: [] }),
    /seed does not match/,
  )
  await assert.rejects(
    () => prepare({ keyHandle, seed: SEED, proofs: [entry, entry], counters: [] }),
    /duplicated/,
  )
  await assert.rejects(
    () => prepare({ keyHandle, seed: SEED, proofs: [entry], counters: [counter(0)] }),
    /absent or low/,
  )
  await assert.rejects(
    () => prepare({ keyHandle, seed: SEED, proofs: [entry], counters: [] }),
    /absent or low/,
  )
  await assert.rejects(
    () => prepare({ keyHandle, seed: SEED, proofs: [entry], counters: [counter(1), counter(1)] }),
    /duplicated/,
  )
})

async function prepare(input: {
  keyHandle: Awaited<ReturnType<typeof handle>>
  seed: Uint8Array
  proofs: readonly EncryptedWalletBackupV2ProofSetProof[]
  counters: readonly { mintUrl: string; unit: 'sat'; keysetId: string; nextCounter: number }[]
}) {
  return prepareWithRuntime(input.keyHandle, input.proofs, input.counters, webcrypto, input.seed)
}

function prepareWithRuntime(
  keyHandle: Awaited<ReturnType<typeof handle>>,
  proofs: readonly EncryptedWalletBackupV2ProofSetProof[],
  counters: readonly { mintUrl: string; unit: 'sat'; keysetId: string; nextCounter: number }[],
  runtime: EncryptedWalletBackupV2BundleRuntime,
  seed = SEED,
) {
  return prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed,
    asset: proofSetAsset(proofs[0]!),
    custodyRevision: 1n,
    proofs,
    counterHighWaterMarks: counters,
    runtime,
  })
}

function restore(
  keyHandle: Awaited<ReturnType<typeof handle>>,
  prepared: EncryptedWalletBackupV2PreparedTransportBundle,
  expectedAsset = { mintUrl: MINT, unit: 'sat' as const, assetIdentity: 'cashu:ordinary' },
) {
  return decryptEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    expectedAsset,
    custodyRevision: 1n,
    runtime: webcrypto,
    ...prepared,
  })
}

function proofSetAsset(value: EncryptedWalletBackupV2ProofSetProof) {
  return {
    mintUrl: value.mintUrl,
    unit: value.unit,
    assetIdentity:
      value.asset.kind === 'ordinary'
        ? 'cashu:ordinary'
        : `ctf:${value.asset.conditionId}:${value.asset.outcomeCollectionId}`,
  }
}

function proof(
  counter: number,
  asset: EncryptedWalletBackupV2ProofSetProof['asset'],
  includeProofMetadata = false,
  amount = 1,
): EncryptedWalletBackupV2ProofSetProof {
  const locator = { schemaVersion: 1 as const, kind: 'nut13' as const, keysetId: KEYSET, counter }
  return {
    mintUrl: MINT,
    unit: 'sat',
    asset,
    locator,
    proof: {
      id: KEYSET,
      amount,
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator,
        proofKeysetId: KEYSET,
        proofAmount: amount,
      }),
      C: `02${'11'.repeat(32)}`,
      ...(includeProofMetadata
        ? { dleq: { e: '11'.repeat(32), s: '22'.repeat(32) }, witness: { signatures: ['sig'] } }
        : {}),
    },
  }
}

function counter(nextCounter: number) {
  return { mintUrl: MINT, unit: 'sat' as const, keysetId: KEYSET, nextCounter }
}

function proofSetPayload(
  proofs: readonly EncryptedWalletBackupV2ProofSetProof[],
  counters: readonly { mintUrl: string; unit: 'sat'; keysetId: string; nextCounter: number }[],
): Uint8Array {
  return encodeCanonicalBackupCbor([
    1,
    'encrypted-wallet-backup-v2-proof-set',
    proofs.map((entry) => [
      entry.mintUrl,
      entry.unit,
      entry.asset.kind === 'ordinary'
        ? [0]
        : [
            1,
            entry.asset.conditionId,
            entry.asset.outcomeLabel,
            entry.asset.outcomeCollectionId,
            entry.asset.registeredAt,
            entry.asset.finalExpiry,
          ],
      serializeDurableCustodyProofArtifact(entry.proof),
      encodeDurableWalletProofDerivationLocatorCbor(entry.locator),
    ]),
    counters.map((entry) => [entry.mintUrl, entry.unit, entry.keysetId, entry.nextCounter]),
  ])
}

function accessorDescriptor<Field extends 'assetLocator'>(
  descriptor: EncryptedWalletBackupV2PreparedTransportBundle['descriptor'],
  field: Field,
  values: readonly EncryptedWalletBackupV2PreparedTransportBundle['descriptor'][Field][],
): EncryptedWalletBackupV2PreparedTransportBundle['descriptor'] {
  let index = 0
  const copy = { ...descriptor }
  Object.defineProperty(copy, field, {
    enumerable: true,
    get: () => values[Math.min(index++, values.length - 1)]!,
  })
  return copy
}

function ctfAsset() {
  return {
    kind: 'ctf' as const,
    conditionId: '11'.repeat(32),
    outcomeLabel: 'YES',
    outcomeCollectionId: '22'.repeat(32),
    registeredAt: 1_700_000_000,
    finalExpiry: 1_800_000_000,
  }
}

function ctfAssetFor(index: number) {
  return {
    ...ctfAsset(),
    conditionId: index.toString(16).padStart(64, '0'),
  }
}

function ctfRangeProof(): EncryptedWalletBackupV2ProofSetProof {
  const keys = {
    '1': '02194603ffa36356f4a56b7df9371fc3192472351453ec7398b8da8117e7c3e104',
    '2': '02194603ffa36356f4a56b7df9371fc3192472351453ec7398b8da8117e7c3e104',
    '4': '02194603ffa36356f4a56b7df9371fc3192472351453ec7398b8da8117e7c3e104',
  }
  const receiveKeysetId = deriveKeysetId(keys, { unit: 'sat', versionByte: 1 })
  const manifest = createCtfRangeManifest({
    seed: SEED,
    operationId: 'range-operation-1',
    receiveKeyset: { id: receiveKeysetId, active: true, keys },
    offerKeyset: { id: '00deadbeef123456', active: true, keys },
    maxReceive: 3,
    maxChange: 3,
    maxEntries: 4,
  })
  const entry = manifest.entries[1]!
  const locator = {
    schemaVersion: 1 as const,
    kind: 'ctf-range-manifest' as const,
    rangeOperationId: 'range-operation-1',
    manifestIndex: 1,
  }
  return {
    mintUrl: MINT,
    unit: 'sat',
    asset: ctfAsset(),
    locator,
    proof: {
      id: entry.entry.id,
      amount: entry.entry.amount,
      secret: new TextDecoder().decode(entry.outputData.secret),
      C: `02${'22'.repeat(32)}`,
    },
  }
}

function counterForKeyset(keysetId: string, nextCounter: number) {
  return { mintUrl: MINT, unit: 'sat' as const, keysetId, nextCounter }
}

function keysetFor(index: number): string {
  const byte = index.toString(16).padStart(2, '0')
  return deriveKeysetId({ '1': `02${byte.repeat(32)}` }, { unit: 'sat', versionByte: 1 })
}

function countingRuntime(): EncryptedWalletBackupV2BundleRuntime & { calls: number } {
  const runtime = {
    calls: 0,
    subtle: webcrypto.subtle,
    getRandomValues(target: Uint8Array) {
      runtime.calls += 1
      return target
    },
  }
  return runtime
}

function handle() {
  return createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: 'backup.production',
    runtime: { subtle: webcrypto.subtle },
  })
}
