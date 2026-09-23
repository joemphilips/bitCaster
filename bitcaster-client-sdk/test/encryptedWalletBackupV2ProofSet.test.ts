import assert from 'node:assert/strict'
import { createCtfRangeManifest, deriveKeysetId } from '@cashu/cashu-ts'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import {
  createEncryptedWalletBackupV2AssetIdentity,
  decryptEncryptedWalletBackupV2ProofSetBundle,
  discoverEncryptedWalletBackupV2ProofSetBundle,
  encryptedWalletBackupV2LocalAssetKey,
  authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse,
  issueEncryptedWalletBackupV2TerminalSeal,
  prepareEncryptedWalletBackupV2ProofSetBundle,
  requireEncryptedWalletBackupV2DecryptedProofSet,
  requireEncryptedWalletBackupV2DecryptedProofSetSource,
  requireEncryptedWalletBackupV2RemoteTerminalSealReuseAuthority,
  requireEncryptedWalletBackupV2VerifiedProofSet,
  verifyEncryptedWalletBackupV2RestoredProofSet,
  type EncryptedWalletBackupV2RestoreVerificationPort,
  type EncryptedWalletBackupV2ProofSetProof,
} from '../src/encryptedWalletBackupV2ProofSet.ts'
import {
  createDurableCustodyArtifactReference,
  createDurableProofOperationFacts,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyRecord,
} from '../src/durableCustody.ts'
import { createDurableCustodyProofOperation } from '../src/durableCustodyProofOperationRecord.ts'
import { serializeDurableCustodyProofInput } from '../src/durableCustodyProofOperation.ts'
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
import {
  createEncryptedWalletBackupV2CurrentHead,
  enumerateEncryptedWalletBackupV2DescriptorPages,
} from '../src/encryptedWalletBackupV2Head.ts'
import type { EncryptedWalletBackupV2RemotePort } from '../src/encryptedWalletBackupV2HttpAdapter.ts'

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
  assert.equal(Object.isFrozen(restored.proofs[0]!.proof), true)
  assert.throws(() => {
    restored.proofs[0]!.proof.secret = '00'.repeat(32)
  }, TypeError)
  assert.equal(restored.proofs[0]!.proof.secret, proof(0, { kind: 'ordinary' }).proof.secret)
})

test('v2 proof-set discovery derives ordinary and CTF identities from authenticated payloads', async () => {
  for (const entry of [proof(0, { kind: 'ordinary' }), proof(0, ctfAsset(), true)]) {
    const keyHandle = await handle()
    const prepared = await prepareEncryptedWalletBackupV2ProofSetBundle({
      keyHandle,
      seed: SEED,
      asset: proofSetAsset(entry),
      proofs: [entry],
      custodyRevision: 1n,
      counterHighWaterMarks: [counter(1)],
      runtime: webcrypto,
    })

    const discovered = await discover(keyHandle, prepared)
    assert.deepEqual(discovered.asset, proofSetAsset(entry))
    assert.equal(
      requireEncryptedWalletBackupV2DecryptedProofSet(discovered.unverified).proofs.length,
      1,
    )
    assert.equal(
      requireEncryptedWalletBackupV2DecryptedProofSetSource(discovered.unverified).bundleId,
      prepared.descriptor.bundleId,
    )
    assert.throws(() => requireEncryptedWalletBackupV2VerifiedProofSet(discovered.unverified))
  }
})

test('v2 proof-set discovery rejects mixed mint, unit, or asset identities', async () => {
  const keyHandle = await handle()
  const first = proof(0, { kind: 'ordinary' })
  const ordinary = proofSetAsset(first)
  const cases = [
    {
      second: { ...proof(1, { kind: 'ordinary' }), mintUrl: 'https://other-mint.example' },
      counters: [counter(1), { ...counter(2), mintUrl: 'https://other-mint.example' }],
    },
    {
      second: { ...proof(1, { kind: 'ordinary' }), unit: 'msat' as const },
      counters: [counter(1), { ...counter(2), unit: 'msat' as const }],
    },
    {
      second: proof(1, ctfAsset(), true),
      counters: [counter(2)],
    },
  ]

  for (const { second, counters } of cases) {
    const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
      keyHandle,
      asset: ordinary,
      declaredAmount: 2n,
      custodyRevision: 1n,
      canonicalPayload: proofSetPayload([first, second], counters),
      runtime: webcrypto,
    })
    await assert.rejects(() => discover(keyHandle, prepared), /proof set asset is foreign/)
  }
})

test('v2 proof-set discovery rejects locator, descriptor, ciphertext, amount, and revision mismatches', async () => {
  const keyHandle = await handle()
  const entry = proof(0, { kind: 'ordinary' })
  const ordinary = proofSetAsset(entry)
  const payload = proofSetPayload([entry], [counter(1)])
  const wrongLocator = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset: { ...ordinary, assetIdentity: `ctf:${'11'.repeat(32)}:${'22'.repeat(32)}` },
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: payload,
    runtime: webcrypto,
  })
  await assert.rejects(() => discover(keyHandle, wrongLocator), /proof set asset is foreign/)

  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset: ordinary,
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: payload,
    runtime: webcrypto,
  })
  const changedCommitment = `${prepared.descriptor.payloadCommitment[0] === '0' ? '1' : '0'}${prepared.descriptor.payloadCommitment.slice(1)}`
  await assert.rejects(
    () =>
      discover(keyHandle, {
        ...prepared,
        descriptor: { ...prepared.descriptor, payloadCommitment: changedCommitment },
      }),
    /corrupt encrypted wallet backup v2 bundle/,
  )

  const changedBody = new Uint8Array(prepared.objects[0]!.body)
  changedBody[0] = changedBody[0]! ^ 1
  await assert.rejects(
    () =>
      discover(keyHandle, {
        ...prepared,
        objects: [{ ...prepared.objects[0]!, body: changedBody }],
      }),
    /corrupt encrypted wallet backup v2 bundle/,
  )

  const wrongAmount = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset: ordinary,
    declaredAmount: 2n,
    custodyRevision: 1n,
    canonicalPayload: payload,
    runtime: webcrypto,
  })
  await assert.rejects(() => discover(keyHandle, wrongAmount), /declared amount is invalid/)
  await assert.rejects(() => discover(keyHandle, prepared, 2n), /custody metadata is foreign/)
})

test('v2 proof-set discovery preserves authenticated terminal seal provenance', async () => {
  const entry = proof(0, ctfAsset(), true)
  const committed = committedTerminalStore(entry, 'redeem:discovery-sealed-losing')
  const terminalSeal = await issueEncryptedWalletBackupV2TerminalSeal({
    seed: SEED,
    proof: entry,
    operationId: committed.operationId,
    store: committed.store,
  })
  const keyHandle = await handle()
  const prepared = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset: proofSetAsset(entry),
    proofs: [{ ...entry, terminalSeal }],
    custodyRevision: 1n,
    counterHighWaterMarks: [counter(1)],
    runtime: webcrypto,
  })
  const discovered = await discover(keyHandle, prepared)
  const unavailable: EncryptedWalletBackupV2RestoreVerificationPort = {
    resolveKeyset: async () => {
      throw new Error('mint unavailable')
    },
    verifyProofs: () => {
      throw new Error('mint unavailable')
    },
    checkProofStates: async () => {
      throw new Error('mint unavailable')
    },
  }

  const verified = await verifyEncryptedWalletBackupV2RestoredProofSet({
    seed: SEED,
    expectedAsset: discovered.asset,
    unverified: discovered.unverified,
    port: unavailable,
  })
  assert.equal(verified.proofs[0]!.selectionAuthority, 'terminal-sealed-non-selectable')
  await assert.rejects(
    () =>
      verifyEncryptedWalletBackupV2RestoredProofSet({
        seed: SEED,
        expectedAsset: discovered.asset,
        unverified: { ...discovered.unverified },
        port: unavailable,
      }),
    /authenticated decrypted material/,
  )
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
  await assert.rejects(
    () =>
      prepare({
        keyHandle,
        seed: SEED,
        proofs: [{ ...entry, proofId: '00'.repeat(32) } as EncryptedWalletBackupV2ProofSetProof],
        counters: [],
      }),
    /proof id is invalid/,
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

test('v2 sealed losing CTF restores complete and non-selectable without mint access', async () => {
  const entry = proof(0, ctfAsset(), true)
  const committed = committedTerminalStore(entry, 'redeem:sealed-losing')
  const seal = await issueEncryptedWalletBackupV2TerminalSeal({
    seed: SEED,
    proof: entry,
    operationId: committed.operationId,
    store: committed.store,
  })
  assert.equal(seal.code, 13015)
  assert.equal(seal.operationIdDigest.length, 64)
  assert.equal(seal.requestDigest.length, 64)
  assert.equal(seal.proofCommitment.length, 64)
  const input = await restored([{ ...entry, terminalSeal: seal }])
  const unavailable: EncryptedWalletBackupV2RestoreVerificationPort = {
    resolveKeyset: async () => {
      throw new Error('mint unavailable')
    },
    verifyProofs: () => {
      throw new Error('mint unavailable')
    },
    checkProofStates: async () => {
      throw new Error('mint unavailable')
    },
  }
  const verified = await verifyEncryptedWalletBackupV2RestoredProofSet({
    ...input,
    port: unavailable,
  })
  assert.equal(verified.proofs[0]!.selectionAuthority, 'terminal-sealed-non-selectable')
  assert.equal(verified.proofs[0]!.proof.secret, entry.proof.secret)
  assert.equal(verified.proofs[0]!.terminalSeal?.requestDigest, seal.requestDigest)
  assert.throws(() => {
    ;(input.unverified.proofs[0]!.terminalSeal as { classifiedAtMs: number }).classifiedAtMs = 1
  }, TypeError)
  await assert.doesNotReject(() =>
    verifyEncryptedWalletBackupV2RestoredProofSet({ ...input, port: unavailable }),
  )
  await assert.rejects(
    () =>
      verifyEncryptedWalletBackupV2RestoredProofSet({
        ...input,
        unverified: { ...input.unverified },
        port: unavailable,
      }),
    /authenticated decrypted material/,
  )
})

test('v2 remote terminal seal reuse ignores a spent sibling in the current bundle', async () => {
  const keyHandle = await handle()
  const losing = proof(0, ctfAsset(), true)
  const losingSibling = proof(1, ctfAsset(), true)
  const spentSibling = proof(2, ctfAsset(), true)
  const unspentSibling = proof(3, ctfAsset(), true)
  const committed = committedTerminalStore(losing, 'redeem:remote-reuse')
  const committedSibling = committedTerminalStore(losingSibling, 'redeem:remote-reuse-2')
  const seal = await issueEncryptedWalletBackupV2TerminalSeal({
    seed: SEED,
    proof: losing,
    operationId: committed.operationId,
    store: committed.store,
  })
  const siblingSeal = await issueEncryptedWalletBackupV2TerminalSeal({
    seed: SEED,
    proof: losingSibling,
    operationId: committedSibling.operationId,
    store: committedSibling.store,
  })
  const asset = proofSetAsset(losing)
  const prepared = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset,
    proofs: [
      { ...losing, terminalSeal: seal },
      { ...losingSibling, terminalSeal: siblingSeal },
      spentSibling,
      unspentSibling,
    ],
    custodyRevision: 1n,
    counterHighWaterMarks: [counter(4)],
    runtime: webcrypto,
  })
  const result = await authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse({
    keyHandle,
    seed: SEED,
    expectedAsset: asset,
    custodyRevision: 1n,
    expectedEnrollmentEpoch: 1,
    remote: remotePort(keyHandle, prepared),
    remoteRequest: requestContext(),
    runtime: webcrypto,
  })
  const reuses = result.authorities
  assert.equal(result.currentHeadEvidence.bundles[0]!.bundleId, prepared.descriptor.bundleId)
  assert.equal(reuses.length, 2)
  for (const reuse of reuses)
    assert.equal(requireEncryptedWalletBackupV2RemoteTerminalSealReuseAuthority(reuse), reuse)
  const restoredBundle = result.decrypted
  const restoredLosers = restoredBundle.proofs.filter((entry) => entry.terminalSeal !== undefined)
  assert.equal(restoredLosers.length, 2)
  const retainedLosing = restoredLosers[1]!
  const retainedAuthority = reuses.find((authority) => authority.proofId === retainedLosing.proofId)
  assert.notEqual(retainedAuthority, undefined)
  const successor = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset,
    proofs: [retainedLosing, restoredBundle.proofs[3]!],
    custodyRevision: 2n,
    counterHighWaterMarks: [counter(4)],
    runtime: webcrypto,
    remoteTerminalSealReuses: [retainedAuthority!],
    remoteTerminalSealReuseHeadEvidence: result.currentHeadEvidence,
  })
  assert.equal(successor.descriptor.custodyRevision, 2n)
})

test('v2 remote terminal seal reuse reconstructs after restart and fresh refetch', async () => {
  const originalKeyHandle = await handle()
  const losing = proof(0, ctfAsset(), true)
  const committed = committedTerminalStore(losing, 'redeem:remote-restart')
  const seal = await issueEncryptedWalletBackupV2TerminalSeal({
    seed: SEED,
    proof: losing,
    operationId: committed.operationId,
    store: committed.store,
  })
  const asset = proofSetAsset(losing)
  const prepared = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle: originalKeyHandle,
    seed: SEED,
    asset,
    proofs: [{ ...losing, terminalSeal: seal }],
    custodyRevision: 4n,
    counterHighWaterMarks: [counter(1)],
    runtime: webcrypto,
  })
  const restartedKeyHandle = await handle()
  const result = await authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse({
    keyHandle: restartedKeyHandle,
    seed: SEED,
    expectedAsset: asset,
    custodyRevision: 4n,
    expectedEnrollmentEpoch: 1,
    remote: remotePort(restartedKeyHandle, prepared),
    remoteRequest: requestContext(),
    runtime: webcrypto,
  })
  const reuse = result.authorities[0]!
  const restored = result.decrypted
  await assert.doesNotReject(() =>
    prepareEncryptedWalletBackupV2ProofSetBundle({
      keyHandle: restartedKeyHandle,
      seed: SEED,
      asset,
      proofs: [restored.proofs[0]!],
      custodyRevision: 5n,
      counterHighWaterMarks: [counter(1)],
      runtime: webcrypto,
      remoteTerminalSealReuses: [reuse],
      remoteTerminalSealReuseHeadEvidence: result.currentHeadEvidence,
    }),
  )
})

test('v2 remote terminal seal reuse refuses newer remote material without the old seal', async () => {
  const keyHandle = await handle()
  const losing = proof(0, ctfAsset(), true)
  const committed = committedTerminalStore(losing, 'redeem:remote-newer')
  const seal = await issueEncryptedWalletBackupV2TerminalSeal({
    seed: SEED,
    proof: losing,
    operationId: committed.operationId,
    store: committed.store,
  })
  const asset = proofSetAsset(losing)
  const old = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset,
    proofs: [{ ...losing, terminalSeal: seal }],
    custodyRevision: 7n,
    counterHighWaterMarks: [counter(1)],
    runtime: webcrypto,
  })
  const newer = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset,
    proofs: [losing],
    custodyRevision: 8n,
    counterHighWaterMarks: [counter(1)],
    runtime: webcrypto,
  })
  await assert.rejects(
    () =>
      authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse({
        keyHandle,
        seed: SEED,
        expectedAsset: asset,
        custodyRevision: 8n,
        expectedEnrollmentEpoch: 1,
        remote: remotePort(keyHandle, newer),
        remoteRequest: requestContext(),
        runtime: webcrypto,
      }),
    /terminal seal is missing/,
  )
  assert.equal(old.descriptor.custodyRevision, 7n)
})

test('v2 remote terminal seal reuse rejects wrong remote scope and copied authority', async () => {
  const keyHandle = await handle()
  const losing = proof(0, ctfAsset(), true)
  const committed = committedTerminalStore(losing, 'redeem:remote-scope')
  const seal = await issueEncryptedWalletBackupV2TerminalSeal({
    seed: SEED,
    proof: losing,
    operationId: committed.operationId,
    store: committed.store,
  })
  const asset = proofSetAsset(losing)
  const prepared = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset,
    proofs: [{ ...losing, terminalSeal: seal }],
    custodyRevision: 7n,
    counterHighWaterMarks: [counter(1)],
    runtime: webcrypto,
  })
  await assert.rejects(
    () =>
      authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse({
        keyHandle,
        seed: SEED,
        expectedAsset: { ...asset, assetIdentity: 'cashu:ordinary' },
        custodyRevision: 7n,
        expectedEnrollmentEpoch: 1,
        remote: remotePort(keyHandle, prepared),
        remoteRequest: requestContext(),
        runtime: webcrypto,
      }),
    /not current/,
  )
  await assert.rejects(
    () =>
      authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse({
        keyHandle,
        seed: SEED,
        expectedAsset: asset,
        custodyRevision: 8n,
        expectedEnrollmentEpoch: 1,
        remote: remotePort(keyHandle, prepared),
        remoteRequest: requestContext(),
        runtime: webcrypto,
      }),
    /binding is invalid/,
  )
  const validRemote = remotePort(keyHandle, prepared)
  await assert.rejects(
    () =>
      authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse({
        keyHandle,
        seed: SEED,
        expectedAsset: asset,
        custodyRevision: 7n,
        expectedEnrollmentEpoch: 1,
        remote: {
          ...validRemote,
          readDescriptorPage: async (request) => {
            const page = await validRemote.readDescriptorPage(request)
            return { ...page, head: { ...page.head, activeSetDigest: '00'.repeat(32) } }
          },
        },
        remoteRequest: requestContext(),
        runtime: webcrypto,
      }),
    /head authority/,
  )
  await assert.rejects(
    () =>
      authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse({
        keyHandle,
        seed: SEED,
        expectedAsset: asset,
        custodyRevision: 7n,
        expectedEnrollmentEpoch: 2,
        remote: remotePort(keyHandle, prepared, false),
        remoteRequest: requestContext(),
        runtime: webcrypto,
      }),
    /head scope/,
  )
  const result = await authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse({
    keyHandle,
    seed: SEED,
    expectedAsset: asset,
    custodyRevision: 7n,
    expectedEnrollmentEpoch: 1,
    remote: remotePort(keyHandle, prepared),
    remoteRequest: requestContext(),
    runtime: webcrypto,
  })
  const copied = { ...result.authorities[0]! }
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupV2ProofSetBundle({
        keyHandle,
        seed: SEED,
        asset,
        proofs: [{ ...losing, terminalSeal: seal }],
        custodyRevision: 8n,
        counterHighWaterMarks: [counter(1)],
        runtime: webcrypto,
        remoteTerminalSealReuses: result.authorities,
      }),
    /head evidence is required/,
  )
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupV2ProofSetBundle({
        keyHandle,
        seed: SEED,
        asset,
        proofs: [{ ...losing, terminalSeal: seal }],
        custodyRevision: 8n,
        counterHighWaterMarks: [counter(1)],
        runtime: webcrypto,
        remoteTerminalSealReuses: [copied],
        remoteTerminalSealReuseHeadEvidence: result.currentHeadEvidence,
      }),
    /authority is invalid/,
  )
})

test('v2 terminal seal rejects forged, missing, and foreign authority', async () => {
  const entry = proof(0, ctfAsset(), true)
  const committed = committedTerminalStore(entry, 'redeem:terminal-guards')
  const seal = await issueEncryptedWalletBackupV2TerminalSeal({
    seed: SEED,
    proof: entry,
    operationId: committed.operationId,
    store: committed.store,
  })
  const keyHandle = await handle()
  for (const terminalSeal of [
    { ...seal },
    { ...seal, code: 13016 as 13015 },
    { ...seal, requestDigest: '00'.repeat(32) },
  ]) {
    await assert.rejects(
      () => prepareWithRuntime(keyHandle, [{ ...entry, terminalSeal }], [counter(1)], webcrypto),
      /terminal seal/,
    )
  }
  await assert.rejects(
    () =>
      prepareWithRuntime(
        keyHandle,
        [{ ...proof(1, ctfAsset(), true), terminalSeal: seal }],
        [counter(2)],
        webcrypto,
      ),
    /terminal seal proof binding/,
  )
  await assert.rejects(
    () =>
      issueEncryptedWalletBackupV2TerminalSeal({
        seed: SEED,
        proof: proof(1, ctfAsset(), true),
        operationId: committed.operationId,
        store: committed.store,
      }),
    /terminal seal operation is foreign/,
  )
  const active = await restored([entry])
  await assert.rejects(
    () =>
      verifyEncryptedWalletBackupV2RestoredProofSet({
        ...active,
        port: {
          ...active.port,
          resolveKeyset: async () => {
            throw new Error('mint unavailable')
          },
        },
      }),
    /mint unavailable/,
  )
})

test('v2 proof-set rejects the old V1 payload instead of silently falling back', async () => {
  const entry = proof(0, { kind: 'ordinary' })
  const keyHandle = await handle()
  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset: proofSetAsset(entry),
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: proofSetPayload([entry], [counter(1)], 1),
    runtime: webcrypto,
  })
  await assert.rejects(() => restore(keyHandle, prepared), /proof set CBOR is invalid/)
})

test('v2 proof-set rejects an unknown terminal seal version in authenticated ciphertext', async () => {
  const entry = proof(0, ctfAsset(), true)
  const seal = {
    schemaVersion: 2 as 1,
    kind: 'ctf-verified-losing' as const,
    operationIdDigest: '11'.repeat(32),
    requestDigest: '22'.repeat(32),
    code: 13015 as const,
    classifiedAtMs: 1_700_000_000_000,
    proofCommitment: '33'.repeat(32),
  }
  const keyHandle = await handle()
  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset: proofSetAsset(entry),
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: proofSetPayload([{ ...entry, terminalSeal: seal }], [counter(1)]),
    runtime: webcrypto,
  })
  await assert.rejects(
    () => restore(keyHandle, prepared, proofSetAsset(entry)),
    /terminal seal is invalid/,
  )
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

function committedTerminalStore(entry: EncryptedWalletBackupV2ProofSetProof, operationId: string) {
  const scopeInput = { scopeKind: 'wallet' as const, walletId: deriveDurableCustodyWalletId(SEED) }
  const scope = { ...scopeInput, scopeId: deriveDurableCustodyScopeId(scopeInput) }
  const operation = {
    operationId,
    kind: 'ctf-redeem' as const,
    mintUrl: MINT,
    inputs: [serializeDurableCustodyProofInput(entry.proof)],
    outputs: {},
    metadata: { unit: 'sat' },
  }
  const requestBody = prepareDurableCustodyExactArtifact(operation)
  const output = prepareDurableCustodyExactArtifact(operation.outputs)
  const privateMaterial = prepareDurableCustodyExactArtifact(operation)
  const facts = createDurableProofOperationFacts({
    unit: 'sat',
    binding: { kind: 'wallet', activityId: operationId, stage: 'ctf-redeem' },
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: false,
    inputKeysetRequirement: 'required',
    keysets: [
      {
        keysetId: KEYSET,
        unit: 'sat',
        curve: 'secp256k1',
        publicKeys: { '1': '02194603ffa36356f4a56b7df9371fc3192472351453ec7398b8da8117e7c3e104' },
        keysetExpiryMs: null,
        requireDleq: true,
        usedByInputs: true,
        usedByOutputs: false,
      },
    ],
  })
  const initial = createDurableCustodyProofOperation({
    scope,
    operation,
    facts,
    inventoryAccountId: null,
    exactBoundary: {
      method: 'POST',
      path: '/v1/redeem_outcome',
      idempotencyKey: operationId,
      requestBody,
      output,
      privateMaterial,
    },
  })
  const authority = {
    schemaVersion: 1,
    kind: 'authenticated-terminal-mint-rejection',
    operationId: initial.operation.operationId,
    semanticKind: 'ctf-redeem',
    normalizedMint: MINT,
    requestFingerprint: initial.operation.exactRequest.requestFingerprint,
    code: 13015,
    transportProvenance: 'authenticated-mint-transport',
    transportOperationId: operationId,
    rejectionBody: { code: 13015 },
    predecessorDisposition: 'retain',
    selectedSuccessorProofIds: [],
  }
  const exactRejection = prepareDurableCustodyExactArtifact(authority)
  const record: DurableCustodyRecord = {
    ...initial,
    operation: {
      ...initial.operation,
      state: 'aborted',
      terminalMintRejection: {
        kind: 'authenticated-terminal-mint-rejection',
        code: 13015,
        rejectionHandle: `mint-terminal-rejection:${exactRejection.fingerprint}`,
        rejectionFingerprint: exactRejection.fingerprint,
        exactRejection: createDurableCustodyArtifactReference(
          `artifact:${operationId}:terminal-mint-rejection`,
          exactRejection,
        ),
        predecessorDisposition: 'retain',
        selectedSuccessorProofIds: [],
      },
    },
  }
  return {
    operationId: initial.operation.operationId,
    store: {
      async withCommittedTerminalRejection<T>(
        requestedId: string,
        read: (value: {
          record: DurableCustodyRecord
          exactRejection: typeof exactRejection
          classifiedAtMs: number
        }) => T,
      ): Promise<T> {
        assert.equal(requestedId, initial.operation.operationId)
        return read({ record, exactRejection, classifiedAtMs: 1_700_000_000_000 })
      },
    },
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

function discover(
  keyHandle: Awaited<ReturnType<typeof handle>>,
  prepared: EncryptedWalletBackupV2PreparedTransportBundle,
  custodyRevision = prepared.descriptor.custodyRevision,
) {
  return discoverEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    custodyRevision,
    runtime: webcrypto,
    ...prepared,
  })
}

function requestContext() {
  return {
    origin: 'https://backup.example',
    issuedAtUnixSeconds: 100,
    expiresAtUnixSeconds: 130,
    signal: new AbortController().signal,
    runtime: webcrypto,
  }
}

function remotePort(
  keyHandle: Awaited<ReturnType<typeof handle>>,
  prepared: EncryptedWalletBackupV2PreparedTransportBundle,
  assertRequestEpoch = true,
): Pick<EncryptedWalletBackupV2RemotePort, 'readDescriptorPage' | 'readObject'> {
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: prepared.descriptor.realm,
    walletId: prepared.descriptor.walletId,
    enrollmentEpoch: 1,
    headVersion: 7,
    bundles: [prepared.descriptor],
  })
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head,
    bundles: [prepared.descriptor],
  })
  const base = `https://backup.example/v1/encrypted-wallet-backup/realms/${keyHandle.realm}/wallets/${keyHandle.walletId}`
  return {
    readDescriptorPage: async ({ requestProof, afterBundleId }) => {
      assert.equal(requestProof.method, 'GET')
      if (assertRequestEpoch) assert.equal(requestProof.enrollmentEpoch, 1)
      assert.equal(
        requestProof.url,
        `${base}/head${afterBundleId === null ? '' : `/after/${afterBundleId}`}`,
      )
      const page = pages.find((candidate) => candidate.afterBundleId === afterBundleId)
      if (page === undefined) throw new Error('descriptor page not found')
      return page
    },
    readObject: async ({ requestProof, objectId, expectedDescriptor }) => {
      assert.equal(requestProof.method, 'GET')
      if (assertRequestEpoch) assert.equal(requestProof.enrollmentEpoch, 1)
      assert.equal(requestProof.url, `${base}/objects/${objectId}`)
      assert.equal(expectedDescriptor.bundleId, prepared.descriptor.bundleId)
      const object = prepared.objects.find((candidate) => candidate.objectId === objectId)
      if (object === undefined) throw new Error('object not found')
      return object
    },
  }
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
  version = 2,
): Uint8Array {
  return encodeCanonicalBackupCbor([
    version,
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
      ...(version === 1
        ? []
        : [
            entry.terminalSeal === undefined
              ? null
              : [
                  entry.terminalSeal.schemaVersion,
                  entry.terminalSeal.kind,
                  entry.terminalSeal.operationIdDigest,
                  entry.terminalSeal.requestDigest,
                  entry.terminalSeal.code,
                  entry.terminalSeal.classifiedAtMs,
                  entry.terminalSeal.proofCommitment,
                ],
          ]),
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
