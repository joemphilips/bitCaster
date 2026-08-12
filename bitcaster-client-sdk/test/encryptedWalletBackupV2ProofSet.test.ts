import assert from 'node:assert/strict'
import { createCtfRangeManifest, deriveKeysetId } from '@cashu/cashu-ts'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import {
  createEncryptedWalletBackupV2AssetIdentity,
  decryptEncryptedWalletBackupV2ProofSetBundle,
  encryptedWalletBackupV2LocalAssetKey,
  prepareEncryptedWalletBackupV2ProofSetBundle,
  requireEncryptedWalletBackupV2VerifiedProofSet,
  verifyEncryptedWalletBackupV2RestoredProofSet,
  type EncryptedWalletBackupV2RestoreVerificationPort,
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

test('v2 proof-set asset identity keeps mint, unit, and verified CTF collection distinct', () => {
  const ordinary = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: 'sat',
    asset: { kind: 'ordinary' },
  })
  const ctf = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: 'msat',
    asset: {
      kind: 'ctf',
      conditionId: '11'.repeat(32),
      outcomeLabel: 'Display label',
      outcomeCollectionId: '22'.repeat(32),
      registeredAt: 1,
      finalExpiry: 2,
    },
  })
  assert.equal(ordinary.assetIdentity, 'cashu:ordinary')
  assert.equal(ctf.assetIdentity, `ctf:${'11'.repeat(32)}:${'22'.repeat(32)}`)
  assert.notEqual(
    encryptedWalletBackupV2LocalAssetKey(ordinary),
    encryptedWalletBackupV2LocalAssetKey(ctf),
  )
  assert.throws(() =>
    encryptedWalletBackupV2LocalAssetKey({ ...ordinary, assetIdentity: 'ctf:Display label' }),
  )
})

test('v2 proof-set preserves an explicit missing CTF final expiry', async () => {
  const entry = proof(0, { ...ctfAsset(), finalExpiry: null }, true)
  const result = await restored([entry])

  assert.equal(result.unverified.proofs[0]!.asset.kind, 'ctf')
  if (result.unverified.proofs[0]!.asset.kind === 'ctf')
    assert.equal(result.unverified.proofs[0]!.asset.finalExpiry, null)
})

test('v2 proof-set rejects a non-positive or pre-registration CTF final expiry', () => {
  const asset = ctfAsset()
  assert.throws(
    () =>
      createEncryptedWalletBackupV2AssetIdentity({
        mintUrl: MINT,
        unit: 'sat',
        asset: { ...asset, finalExpiry: 0 },
      }),
    /encrypted backup time is invalid/,
  )
  assert.throws(
    () =>
      createEncryptedWalletBackupV2AssetIdentity({
        mintUrl: MINT,
        unit: 'sat',
        asset: { ...asset, finalExpiry: asset.registeredAt },
      }),
    /proof set asset is invalid/,
  )
})

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

test('v2 restored proof verifier accepts ordinary and CTF proof sets', async () => {
  const ordinary = await restored([proof(0, { kind: 'ordinary' })])
  const ctf = await restored([proof(0, ctfAsset(), true)])
  const verified = await verifyEncryptedWalletBackupV2RestoredProofSet(ordinary)
  assert.equal(requireEncryptedWalletBackupV2VerifiedProofSet(verified), verified)
  assert.throws(
    () => requireEncryptedWalletBackupV2VerifiedProofSet({ ...verified }),
    /verified proof set is invalid/,
  )
  await assert.doesNotReject(() => verifyEncryptedWalletBackupV2RestoredProofSet(ctf))
})

test('v2 restored proof verifier binds immutable nested proof evidence', async () => {
  const entry = proof(1, ctfAsset(), true)
  const unverified = {
    proofs: [{ ...entry, proofId: '11'.repeat(32) }],
    counterHighWaterMarks: [counter(2)],
  }
  const verified = await verifyEncryptedWalletBackupV2RestoredProofSet({
    seed: SEED,
    expectedAsset: proofSetAsset(entry),
    unverified,
    port: verificationPort(),
  })
  const source = unverified.proofs[0]!
  ;(source.proof as { C: string; dleq: { e: string; s: string } }).C = `03${'33'.repeat(32)}`
  ;(source.proof as { dleq: { e: string; s: string } }).dleq.e = '44'.repeat(32)
  ;(source.locator as { counter: number }).counter = 99
  ;(source.asset as { outcomeLabel: string }).outcomeLabel = 'NO'
  unverified.counterHighWaterMarks[0]!.nextCounter = 99

  const snapshot = requireEncryptedWalletBackupV2VerifiedProofSet(verified)
  const snapshotProof = snapshot.proofs[0]!
  assert.equal(snapshotProof.proof.C, `02${'11'.repeat(32)}`)
  assert.equal(snapshotProof.proof.dleq?.e, '11'.repeat(32))
  assert.equal((snapshotProof.locator as { counter: number }).counter, 1)
  assert.equal((snapshotProof.asset as { outcomeLabel: string }).outcomeLabel, 'YES')
  assert.equal(snapshot.counterHighWaterMarks[0]!.nextCounter, 2)
  assert.equal(Object.isFrozen(snapshotProof.proof), true)
  assert.equal(Object.isFrozen(snapshotProof.locator), true)
  assert.equal(Object.isFrozen(snapshotProof.asset), true)
  assert.equal(Object.isFrozen(snapshot.counterHighWaterMarks[0]!), true)
})

test('v2 restored proof verifier rejects invalid keysets and proof verification', async () => {
  const input = await restored([proof(0, { kind: 'ordinary' })])
  await assert.rejects(
    () =>
      verifyEncryptedWalletBackupV2RestoredProofSet({
        ...input,
        port: verificationPort({ verify: false }),
      }),
    /keyset is invalid/,
  )
  await assert.rejects(
    () =>
      verifyEncryptedWalletBackupV2RestoredProofSet({
        ...input,
        port: verificationPort({ signatures: false }),
      }),
    /signature failed/,
  )
})

test('v2 restored proof verifier requires an exact all-unspent NUT-07 result', async () => {
  const input = await restored([proof(0, { kind: 'ordinary' }), proof(1, { kind: 'ordinary' })])
  for (const states of [
    [{ proofId: input.unverified.proofs[0]!.proofId, state: 'PENDING' }],
    [{ proofId: input.unverified.proofs[0]!.proofId, state: 'SPENT' }],
    [{ proofId: input.unverified.proofs[0]!.proofId, state: 'UNSPENT' }],
    [
      { proofId: input.unverified.proofs[0]!.proofId, state: 'UNSPENT' },
      { proofId: input.unverified.proofs[0]!.proofId, state: 'UNSPENT' },
    ],
    [
      { proofId: input.unverified.proofs[0]!.proofId, state: 'UNSPENT' },
      { proofId: '00'.repeat(32), state: 'UNSPENT' },
    ],
  ]) {
    await assert.rejects(
      () =>
        verifyEncryptedWalletBackupV2RestoredProofSet({
          ...input,
          port: verificationPort({ states }),
        }),
      /proof state/,
    )
  }
})

async function restored(proofs: readonly EncryptedWalletBackupV2ProofSetProof[]) {
  const keyHandle = await handle()
  const asset = proofSetAsset(proofs[0]!)
  const prepared = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset,
    proofs,
    custodyRevision: 1n,
    counterHighWaterMarks: proofs[0]!.locator.kind === 'nut13' ? [counter(proofs.length)] : [],
    runtime: webcrypto,
  })
  return {
    seed: SEED,
    expectedAsset: asset,
    unverified: await decryptEncryptedWalletBackupV2ProofSetBundle({
      keyHandle,
      seed: SEED,
      expectedAsset: asset,
      custodyRevision: 1n,
      runtime: webcrypto,
      ...prepared,
    }),
    port: verificationPort(),
  }
}

function verificationPort(
  options: {
    verify?: boolean
    signatures?: boolean
    states?: readonly { readonly proofId: string; readonly state: string }[]
  } = {},
): EncryptedWalletBackupV2RestoreVerificationPort {
  return {
    async resolveKeyset({ mintUrl, unit, keysetId }) {
      return {
        mintUrl,
        unit,
        keysetId,
        keyset: {},
        requireDleq: true,
        verify: () => options.verify !== false,
      }
    },
    verifyProofs() {
      if (options.signatures === false) throw new Error('signature failed')
    },
    async checkProofStates({ proofs }) {
      return options.states ?? proofs.map(({ proofId }) => ({ proofId, state: 'UNSPENT' }))
    },
  }
}

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
