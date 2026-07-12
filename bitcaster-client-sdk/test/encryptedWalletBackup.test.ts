import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import * as Cashu from '@cashu/cashu-ts'
import * as BackupModule from '../src/encryptedWalletBackup.ts'
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { decode, encode, rfc8949EncodeOptions } from 'cborg'
import {
  ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES_RESERVED,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES_RESERVED,
  createEncryptedWalletBackupKeyHandle,
  decryptEncryptedWalletBackupProofChunk,
  packEncryptedWalletBackupProofChunk,
  prepareEncryptedWalletBackupObject,
  prepareEncryptedWalletBackupProof,
  verifyEncryptedWalletBackupConditionalKeyset,
  readPreparedEncryptedWalletBackupObject,
  type EncryptedWalletBackupProofInput,
  type VerifiedEncryptedWalletBackupConditionalKeyset,
  type EncryptedWalletBackupRuntime,
} from '../src/encryptedWalletBackup.ts'
import { preflightEncryptedProofChunkCbor } from '../src/encryptedWalletBackupCbor.ts'

const vector = JSON.parse(await readFile(
  new URL('../../test-vectors/encrypted-wallet-backup-v1.json', import.meta.url),
  'utf8',
)) as BackupVector

const SEED = fromHex(vector.inputs.seedHex)
const SECRET = vector.expected.derivedSecretHex
const CTF_KEYSET_ID = '0170110f06b9bb85565a6746ca5715f877b99db14d87219f6e9030cb529f61e6ea'
const CTF_MINT_KEYS = {
  id: CTF_KEYSET_ID,
  unit: 'sat',
  active: true,
  input_fee_ppk: 0,
  final_expiry: 1_754_296_607,
  keys: {
    1: '02f970b6ee058705c0dddc4313721cffb7efd3d142d96ea8e01d31c2b2ff09f181',
    2: '03361cd8bd1329fea797a6add1cf1990ffcf2270ceb9fc81eeee0e8e9c1bd0cdf5',
  },
}
const CTF_CONDITIONAL_METADATA = {
  conditionId: 'aa'.repeat(32),
  outcomeCollection: 'YES',
  outcomeCollectionId: 'cc'.repeat(32),
  registeredAt: 1_700_000_000,
}
type UnboundProofInput = Omit<EncryptedWalletBackupProofInput, 'proofSnapshotStore'>

test('public vector freezes key derivation, canonical proof bytes, AEAD body, and restore', async () => {
  const runtime = deterministicRuntime([
    fromHex(vector.inputs.objectIdHex),
    fromHex(vector.inputs.nonceHex),
  ])
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: vector.inputs.realm,
    runtime,
  })
  assert.deepEqual(keyHandle, {
    formatVersion: 1,
    realm: vector.inputs.realm,
    vaultId: vector.expected.vaultIdHex,
    requestAuthPublicKey: vector.expected.requestAuthPublicKeyHex,
  })
  assert.equal(JSON.stringify(keyHandle).includes(vector.inputs.seedHex), false)
  assert.equal(Object.isFrozen(keyHandle), true)

  const proofHandle = await prepareEncryptedWalletBackupProof(proofInput(keyHandle))
  assert.deepEqual(proofHandle, {
    proofId: vector.expected.proofIdHex,
    commitment: vector.expected.commitmentHex,
  })
  assert.equal(JSON.stringify(proofHandle).includes(SECRET), false)
  const canonicalRoot = decode(fromHex(vector.expected.canonicalCborHex)) as unknown[]
  const canonicalRecord = (canonicalRoot[2] as unknown[][])[0]!
  const encodedSecret = canonicalRecord[6] as Uint8Array
  assert.equal(encodedSecret.byteLength, 64)
  assert.match(new TextDecoder().decode(encodedSecret), /^[0-9a-f]{64}$/)
  const chunk = packEncryptedWalletBackupProofChunk([proofHandle])
  assert.deepEqual(chunk.bindings, [{
    proofId: vector.expected.proofIdHex,
    commitment: vector.expected.commitmentHex,
  }])
  assert.equal(JSON.stringify(chunk).includes(SECRET), false)

  const prepared = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk,
    generation: vector.inputs.generation,
    runtime,
    objectIdExists: () => false,
  })
  const wire = readPreparedEncryptedWalletBackupObject(prepared)
  assert.equal(wire.objectId, vector.inputs.objectIdHex)
  assert.equal(wire.digest, vector.expected.objectDigestHex)
  assert.equal(wire.body.byteLength, vector.expected.bodyLength)
  assert.equal(toHex(wire.aad), vector.expected.aadHex)
  assert.equal(toHex(await sha256(wire.body)), vector.expected.bodySha256Hex)
  assert.equal(toHex(wire.body.slice(-16)), vector.expected.tagHex)
  assert.equal(JSON.stringify(prepared).includes(SECRET), false)
  assert.equal(JSON.stringify(wire).includes(SECRET), false)
  assert.throws(
    () => readPreparedEncryptedWalletBackupObject({ ...prepared }),
    /prepared backup object is invalid/,
  )

  const retry = readPreparedEncryptedWalletBackupObject(prepared)
  assert.deepEqual(retry.body, wire.body)
  assert.deepEqual(retry.aad, wire.aad)
  const restored = await decryptEncryptedWalletBackupProofChunk({ keyHandle, seed: SEED, object: wire })
  assert.deepEqual(restored, { formatVersion: 1, kindCode: 1, recordCount: 1 })
  assert.equal(Object.isFrozen(restored), true)
  assert.equal(JSON.stringify(restored).includes(SECRET), false)
  assert.equal('proof' in restored, false)
  assert.equal('proofKind' in restored, false)
})

test('realm separation and exact-object capability provenance fail closed', async () => {
  const first = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test' })
  const second = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test-2' })
  assert.notEqual(first.vaultId, second.vaultId)
  assert.notEqual(first.requestAuthPublicKey, second.requestAuthPublicKey)
  const firstInput = proofInput(first)
  await assert.rejects(
    () => prepareEncryptedWalletBackupProof({ ...firstInput, keyHandle: { ...first } }),
    /backup key handle is invalid/,
  )
  const proof = await prepareEncryptedWalletBackupProof(proofInput(first))
  assert.throws(() => packEncryptedWalletBackupProofChunk([{ ...proof }]), /proof handle is invalid/)
  const chunk = packEncryptedWalletBackupProofChunk([proof])
  await assert.rejects(() => prepareEncryptedWalletBackupObject({
    keyHandle: first,
    chunk: { ...chunk },
    generation: 1,
  }), /proof chunk handle is invalid/)
  await assert.rejects(
    () => createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test-' }),
    /backup realm is invalid/,
  )
  await assert.rejects(
    () => createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: `a${'.'.repeat(63)}` }),
    /backup realm is invalid/,
  )
  await assert.rejects(
    () => createEncryptedWalletBackupKeyHandle({ seed: new Uint8Array(63), realm: 'test' }),
    /backup seed is invalid/,
  )
  await assert.rejects(
    () => createEncryptedWalletBackupKeyHandle({ seed: new Uint8Array(65), realm: 'test' }),
    /backup seed is invalid/,
  )
  const valid64 = `a${'b'.repeat(62)}c`
  assert.equal((await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: valid64 })).realm, valid64)
})

test('request-auth scalar derivation rejects zero and out-of-range candidates and caps exhaustion', async () => {
  const order = fromHex('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
  const overOrder = fromHex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
  const validOne = fromHex(`${'00'.repeat(31)}01`)
  const accepted = scalarCandidateRuntime([new Uint8Array(32), order, overOrder, validOne])
  const handle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'scalar-test',
    runtime: accepted.runtime,
  })
  assert.equal(handle.requestAuthPublicKey, '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
  assert.equal(accepted.scalarCalls(), 4)

  const exhausted = scalarCandidateRuntime(new Array(256).fill(new Uint8Array(32)))
  await assert.rejects(() => createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'scalar-exhaustion',
    runtime: exhausted.runtime,
  }), /scalar derivation exhausted/)
  assert.equal(exhausted.scalarCalls(), 256)
})

test('preparation validates seed, counter, classifier facts, proof class, fields, and keyset wire', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test' })
  await assert.rejects(
    () => prepareEncryptedWalletBackupProof({ ...proofInput(keyHandle), seed: new Uint8Array(64) }),
    /backup seed does not match key handle/,
  )
  await assert.rejects(
    () => prepareEncryptedWalletBackupProof({ ...proofInput(keyHandle), counter: 8 }),
    /proof secret does not match deterministic derivation/,
  )
  for (const override of [
    { provenance: 'external' },
    { provenance: 'unknown' },
    { operationBinding: 'nonterminal' },
    { operationBinding: 'unknown' },
    { reserved: true },
    { ambiguousMintOperation: true },
    { derivationLocator: 'missing' },
  ]) {
    await assert.rejects(
      () => prepareEncryptedWalletBackupProof(withProofStore(proofInput(keyHandle), null, override)),
      /proof is not backup eligible/,
    )
  }
  await assert.rejects(() => prepareEncryptedWalletBackupProof({
    ...proofInput(keyHandle),
    proof: { ...proofInput(keyHandle).proof, witness: 'secret-witness' },
  } as never), /unsupported proof field/)
  await assert.rejects(() => prepareEncryptedWalletBackupProof({
    ...proofInput(keyHandle),
    proof: { ...proofInput(keyHandle).proof, p2pk_e: '02'.repeat(33) },
  } as never), /unsupported proof field/)
  await assert.rejects(() => prepareEncryptedWalletBackupProof({
    ...proofInput(keyHandle),
    proof: { ...proofInput(keyHandle).proof, id: '01abcdefabcdefab' },
  }), /unresolved short modern keyset/)

  for (const keysetId of ['009a1f293253e41e', '9mlfd5vCzgGl']) {
    const input = proofInputForKeyset(keyHandle, keysetId)
    const prepared = await prepareEncryptedWalletBackupProof(input)
    assert.match(prepared.proofId, /^[0-9a-f]{64}$/)
  }

  const padded = proofInputForKeyset(keyHandle, 'AQIDBA==')
  const unpadded = proofInputForKeyset(keyHandle, 'AQIDBA')
  assert.equal(padded.proof.secret, unpadded.proof.secret)
  const paddedPrepared = await prepareEncryptedWalletBackupProof(padded)
  const unpaddedPrepared = await prepareEncryptedWalletBackupProof(unpadded)
  assert.equal(paddedPrepared.proofId, unpaddedPrepared.proofId)
  assert.throws(
    () => packEncryptedWalletBackupProofChunk([paddedPrepared, unpaddedPrepared]),
    /proof id is duplicated/,
  )
  assert.throws(() => proofInputForKeyset(keyHandle, '+___'), /Unrecognized|mixes Base64 alphabets/)
})

test('active CTF requires complete unexpired metadata and ordinary proof forbids it', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test' })
  const ctfInput = ctfProofInput(keyHandle)
  const metadata = ctfInput.ctfMetadata
  await prepareEncryptedWalletBackupProof(withProofStore(ctfInput, verifiedConditionalEvidence()))
  await assert.rejects(() => prepareEncryptedWalletBackupProof({
    ...proofInput(keyHandle),
    proofKind: 'ctf-active',
    ctfMetadata: null,
  }), /CTF metadata is invalid/)
  await assert.rejects(() => prepareEncryptedWalletBackupProof({
    ...proofInput(keyHandle),
    proofKind: 'ctf-active',
    ctfMetadata: { ...metadata, finalExpiryUnixSeconds: 1_700_000_000 },
    effectiveNowUnixSeconds: 1_700_000_000,
  }), /CTF proof is expired/)
  await assert.rejects(() => prepareEncryptedWalletBackupProof({
    ...ctfInput,
    ctfMetadata: { ...ctfInput.ctfMetadata, registeredAtUnixSeconds: null },
  } as never), /CTF registration time is invalid/)
  await assert.rejects(() => prepareEncryptedWalletBackupProof({
    ...proofInput(keyHandle),
    ctfMetadata: metadata,
  }), /ordinary proof cannot contain CTF metadata/)
})

test('authoritative snapshot binds proof bytes and every validated conditional-keyset field', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test' })
  const ctfInput = ctfProofInput(keyHandle)
  const conditional = verifiedConditionalEvidence()
  const bound = withProofStore(ctfInput, conditional)
  await assert.rejects(
    () => prepareEncryptedWalletBackupProof(withProofStore(ctfInput)),
    /validated conditional keyset/,
  )
  for (const metadataOverride of [
    { conditionId: '33'.repeat(32) },
    { outcomeLabel: 'NO' },
    { outcomeCollectionId: '44'.repeat(32) },
    { registeredAtUnixSeconds: ctfInput.ctfMetadata.registeredAtUnixSeconds + 1 },
    // A later claimed expiry must not extend the cryptographically verified keyset lifetime.
    { finalExpiryUnixSeconds: ctfInput.ctfMetadata.finalExpiryUnixSeconds + 10_000 },
  ]) {
    const spoofed = {
      ...ctfInput,
      ctfMetadata: { ...ctfInput.ctfMetadata, ...metadataOverride },
    }
    await assert.rejects(
      () => prepareEncryptedWalletBackupProof(withProofStore(spoofed, conditional)),
      /proof does not match validated conditional keyset/,
    )
  }
  for (const proof of [
    { ...bound.proof, amount: '2' },
    { ...bound.proof, C: `03${bound.proof.C.slice(2)}` },
  ]) {
    await assert.rejects(
      () => prepareEncryptedWalletBackupProof({ ...bound, proof }),
      /proof commitment does not match authoritative storage snapshot/,
    )
  }
  await assert.rejects(() => prepareEncryptedWalletBackupProof({
    ...bound,
    ctfMetadata: { ...bound.ctfMetadata, outcomeLabel: 'NO' },
  }), /proof commitment does not match authoritative storage snapshot/)
  await assert.rejects(() => prepareEncryptedWalletBackupProof({
    ...withProofStore(ctfInput, { ...conditional }),
  }), /conditional keyset evidence is invalid/)

  const foreignKeyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'foreign' })
  const foreignBound = proofInput(foreignKeyHandle)
  await assert.rejects(() => prepareEncryptedWalletBackupProof({
    ...bound,
    proofSnapshotStore: foreignBound.proofSnapshotStore,
  }))

  const context = conditionalContext()
  const foreignMintEvidence = verifyConditionalEvidence({
    ...context, mint: 'https://other-mint.example',
  })
  await assert.rejects(
    () => prepareEncryptedWalletBackupProof(withProofStore(ctfInput, foreignMintEvidence)),
    /validated conditional keyset/,
  )
  for (const changed of [
    { ...context, unit: 'usd' },
    { ...context, outcomeLabel: 'NO' },
    { ...context, registeredAtUnixSeconds: context.registeredAtUnixSeconds + 1 },
    { ...context, mintKeys: { ...CTF_MINT_KEYS, id: vector.inputs.proof.keysetId } },
    { ...context, mintKeys: { ...CTF_MINT_KEYS, id: `02${CTF_KEYSET_ID.slice(2)}` } },
    { ...context, mintKeys: { ...CTF_MINT_KEYS, final_expiry: CTF_MINT_KEYS.final_expiry + 1 } },
    { ...context, mintKeys: { ...CTF_MINT_KEYS, final_expiry: CTF_CONDITIONAL_METADATA.registeredAt } },
    { ...context, mintKeys: { ...CTF_MINT_KEYS, input_fee_ppk: -1 } },
    { ...context, mintKeys: { ...CTF_MINT_KEYS, keys: {} } },
    { ...context, mintKeys: { ...CTF_MINT_KEYS, keys: { 1: '04'.repeat(33) } } },
    {
      ...context,
      mintKeys: {
        ...CTF_MINT_KEYS,
        conditional: { ...CTF_CONDITIONAL_METADATA, outcomeCollection: 'NO' },
      },
    },
    { ...context, conditionalMetadata: { ...CTF_CONDITIONAL_METADATA, conditionId: '33'.repeat(32) } },
    { ...context, conditionalMetadata: { ...CTF_CONDITIONAL_METADATA, outcomeCollectionId: '44'.repeat(32) } },
    { ...context, conditionalMetadata: { ...CTF_CONDITIONAL_METADATA, registeredAt: 1_700_000_001 } },
  ]) {
    assert.throws(
      () => verifyConditionalEvidence(changed),
      /conditional|keyset/,
    )
  }
})

test('proof-store transaction is the only synchronous exact-row authority boundary', async () => {
  assert.equal('prepareEncryptedWalletBackupStorageSnapshot' in BackupModule, false)
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test' })
  const valid = proofInput(keyHandle)
  const validStore = valid.proofSnapshotStore

  const doubleRead = {
    async withCommittedProofSnapshot<T>(stableProofId: string, read: (row: never) => T): Promise<T> {
      return validStore.withCommittedProofSnapshot(stableProofId, (row) => {
        const first = read(row as never)
        read(row as never)
        return first
      })
    },
  }
  await assert.rejects(
    () => prepareEncryptedWalletBackupProof({ ...valid, proofSnapshotStore: doubleRead }),
    /transaction callback is invalid/,
  )

  const substitutedReturn = {
    async withCommittedProofSnapshot<T>(stableProofId: string, read: (row: never) => T): Promise<T> {
      return validStore.withCommittedProofSnapshot(stableProofId, (row) => {
        read(row as never)
        return {} as T
      })
    },
  }
  await assert.rejects(
    () => prepareEncryptedWalletBackupProof({ ...valid, proofSnapshotStore: substitutedReturn }),
    /transaction must be synchronous and exact/,
  )

  let lateRead: ((row: never) => unknown) | undefined
  let capturedRow: never | undefined
  const lateStore = {
    async withCommittedProofSnapshot<T>(stableProofId: string, read: (row: never) => T): Promise<T> {
      lateRead = read
      return validStore.withCommittedProofSnapshot(stableProofId, (row) => {
        capturedRow = row as never
        return {} as T
      })
    },
  }
  await assert.rejects(
    () => prepareEncryptedWalletBackupProof({ ...valid, proofSnapshotStore: lateStore }),
    /transaction must be synchronous and exact/,
  )
  assert.throws(() => lateRead!(capturedRow!), /transaction callback is invalid/)

  await assert.rejects(
    () => prepareEncryptedWalletBackupProof(withProofStore(valid, null, { proofId: 'ff'.repeat(32) })),
    /proof id does not match authoritative storage snapshot/,
  )
})

test('v3 BLS proof uses a full 02 keyset, 48-byte signature, and null DLEQ', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test' })
  const keysetId = `02${'55'.repeat(32)}`
  const input = proofInputForKeyset(keyHandle, keysetId)
  const prepared = await prepareEncryptedWalletBackupProof({
    ...withProofStore({
      ...input,
      proof: { ...input.proof, C: 'aa'.repeat(48), dleq: undefined },
    }),
  })
  const runtime = deterministicRuntime([new Uint8Array(16).fill(3), new Uint8Array(12).fill(4)])
  const object = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk: packEncryptedWalletBackupProofChunk([prepared]),
    generation: 1,
    runtime,
  })
  const restored = await decryptEncryptedWalletBackupProofChunk({
    keyHandle,
    seed: SEED,
    object: readPreparedEncryptedWalletBackupObject(object),
  })
  assert.deepEqual(restored, { formatVersion: 1, kindCode: 1, recordCount: 1 })
})

test('an expired-at-restore CTF remains opaque and cannot advertise an active or selectable proof', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test' })
  const ctfInput = ctfProofInput(keyHandle)
  const preparedProof = await prepareEncryptedWalletBackupProof(
    withProofStore(ctfInput, verifiedConditionalEvidence()),
  )
  const runtime = deterministicRuntime([new Uint8Array(16).fill(5), new Uint8Array(12).fill(6)])
  const preparedObject = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk: packEncryptedWalletBackupProofChunk([preparedProof]),
    generation: 1,
    runtime,
  })

  // At a later restore time this CTF may already be expired. Commit 3 intentionally
  // exposes no proof body or disposition; commit 5 must verify and classify it.
  const decoded = await decryptEncryptedWalletBackupProofChunk({
    keyHandle,
    seed: SEED,
    object: readPreparedEncryptedWalletBackupObject(preparedObject),
  })
  assert.deepEqual(decoded, { formatVersion: 1, kindCode: 1, recordCount: 1 })
  assert.equal('proof' in decoded, false)
  assert.equal('proofKind' in decoded, false)
  assert.equal('ctfMetadata' in decoded, false)
})

test('proof field, curve, amount, time, and keyset boundaries fail closed', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test' })
  const base = proofInput(keyHandle)
  const invalidInputs = [
    { ...base, unit: '' },
    { ...base, unit: 'sat\u0000' },
    { ...base, unit: 'x'.repeat(65) },
    { ...base, counter: -1 },
    { ...base, counter: 2_147_483_648 },
    { ...base, createdAtUnixSeconds: -1 },
    { ...base, updatedAtUnixSeconds: base.createdAtUnixSeconds - 1 },
    { ...base, updatedAtUnixSeconds: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, proof: { ...base.proof, amount: '0' } },
    { ...base, proof: { ...base.proof, amount: '01' } },
    { ...base, proof: { ...base.proof, amount: '18446744073709551616' } },
    { ...base, proof: { ...base.proof, secret: SECRET.toUpperCase() } },
    { ...base, proof: { ...base.proof, C: '02'.repeat(32) } },
    { ...base, proof: { ...base.proof, dleq: { ...base.proof.dleq, e: '22'.repeat(31) } } },
    { ...base, proof: { ...base.proof, id: `00${'11'.repeat(32)}` } },
    { ...base, proof: { ...base.proof, id: '0111111111111111' } },
  ]
  for (const input of invalidInputs) {
    await assert.rejects(() => prepareEncryptedWalletBackupProof(input as never))
  }
  const ctf = {
    ...base,
    proofKind: 'ctf-active' as const,
    ctfMetadata: {
      conditionId: '11'.repeat(32),
      outcomeLabel: 'YES\u0000',
      outcomeCollectionId: '22'.repeat(32),
      registeredAtUnixSeconds: null,
      finalExpiryUnixSeconds: 1_800_000_000,
    },
  }
  await assert.rejects(() => prepareEncryptedWalletBackupProof(ctf), /outcome label is invalid/)
  await assert.rejects(() => prepareEncryptedWalletBackupProof({
    ...ctf,
    ctfMetadata: { ...ctf.ctfMetadata, conditionId: '11'.repeat(31) },
  }), /condition id is invalid/)
})

test('packing rejects duplicates, count and canonical-size overflow, and collision exhaustion', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test' })
  const proof = await prepareEncryptedWalletBackupProof(proofInput(keyHandle))
  assert.throws(() => packEncryptedWalletBackupProofChunk([proof, proof]), /proof id is duplicated/)
  assert.throws(() => packEncryptedWalletBackupProofChunk(new Array(513).fill(proof)), /proof count/)

  const runtime = deterministicRuntime(new Array(8).fill(fromHex(vector.inputs.objectIdHex)))
  await assert.rejects(() => prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk: packEncryptedWalletBackupProofChunk([proof]),
    generation: 1,
    runtime,
    objectIdExists: () => true,
  }), /object id collision limit exceeded/)

  const repeatedId = new Uint8Array(16).fill(7)
  const internalRuntime = deterministicRuntime([
    repeatedId,
    new Uint8Array(12).fill(8),
    ...new Array(8).fill(repeatedId),
  ])
  const chunk = packEncryptedWalletBackupProofChunk([proof])
  await prepareEncryptedWalletBackupObject({
    keyHandle, chunk, generation: 1, runtime: internalRuntime,
  })
  await assert.rejects(() => prepareEncryptedWalletBackupObject({
    keyHandle, chunk, generation: 2, runtime: internalRuntime,
  }), /object id collision limit exceeded/)
  assert.equal(ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES_RESERVED, 65_536)
  assert.equal(ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES_RESERVED, 65_532)
})

test('concurrent object preparation reserves each candidate before asynchronous collision checks', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test' })
  const proof = await prepareEncryptedWalletBackupProof(proofInput(keyHandle))
  const chunk = packEncryptedWalletBackupProofChunk([proof])
  const firstId = new Uint8Array(16).fill(10)
  const secondId = new Uint8Array(16).fill(11)
  const runtime = deterministicRuntime([
    firstId,
    firstId,
    secondId,
    new Uint8Array(12).fill(12),
    new Uint8Array(12).fill(13),
  ])
  let arrivals = 0
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const objectIdExists = async () => {
    arrivals += 1
    if (arrivals === 2) release()
    await barrier
    return false
  }

  const [first, second] = await Promise.all([
    prepareEncryptedWalletBackupObject({ keyHandle, chunk, generation: 1, runtime, objectIdExists }),
    prepareEncryptedWalletBackupObject({ keyHandle, chunk, generation: 2, runtime, objectIdExists }),
  ])
  assert.equal(first.objectId, toHex(firstId))
  assert.equal(second.objectId, toHex(secondId))
  assert.notEqual(first.objectId, second.objectId)
})

test('a failed collision callback releases its synchronous object-id reservation', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test' })
  const proof = await prepareEncryptedWalletBackupProof(proofInput(keyHandle))
  const chunk = packEncryptedWalletBackupProofChunk([proof])
  const reusableId = new Uint8Array(16).fill(14)
  await assert.rejects(() => prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk,
    generation: 1,
    runtime: deterministicRuntime([reusableId]),
    objectIdExists: () => { throw new Error('lookup failed') },
  }), /lookup failed/)
  const prepared = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk,
    generation: 2,
    runtime: deterministicRuntime([reusableId, new Uint8Array(12).fill(15)]),
  })
  assert.equal(prepared.objectId, toHex(reusableId))
})

test('a crypto failure releases its synchronous object-id reservation', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test' })
  const proof = await prepareEncryptedWalletBackupProof(proofInput(keyHandle))
  const chunk = packEncryptedWalletBackupProofChunk([proof])
  const reusableId = new Uint8Array(16).fill(16)
  const failingBase = deterministicRuntime([reusableId, new Uint8Array(12).fill(17)])
  const failingRuntime: EncryptedWalletBackupRuntime = {
    ...failingBase,
    subtle: new Proxy(webcrypto.subtle, {
      get(target, property) {
        if (property === 'encrypt') return async () => { throw new Error('encrypt failed') }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as SubtleCrypto,
  }
  await assert.rejects(() => prepareEncryptedWalletBackupObject({
    keyHandle, chunk, generation: 1, runtime: failingRuntime,
  }), /encrypt failed/)
  const prepared = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk,
    generation: 2,
    runtime: deterministicRuntime([reusableId, new Uint8Array(12).fill(18)]),
  })
  assert.equal(prepared.objectId, toHex(reusableId))
})

test('decrypt rejects metadata, body, AAD, tamper, truncation, padding, and noncanonical CBOR generically', async () => {
  const runtime = deterministicRuntime([
    fromHex(vector.inputs.objectIdHex),
    fromHex(vector.inputs.nonceHex),
  ])
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test', runtime })
  const proof = await prepareEncryptedWalletBackupProof(proofInput(keyHandle))
  const prepared = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk: packEncryptedWalletBackupProofChunk([proof]),
    generation: 1,
    runtime,
    objectIdExists: () => false,
  })
  const wire = readPreparedEncryptedWalletBackupObject(prepared)
  const cases = [
    { ...wire, realm: 'test-2' },
    { ...wire, generation: 2 },
    { ...wire, objectId: 'ff'.repeat(16) },
    { ...wire, digest: 'ff'.repeat(32) },
    { ...wire, aad: wire.aad.slice(1) },
    { ...wire, body: wire.body.slice(1) },
    { ...wire, body: mutate(wire.body, 100) },
  ]
  for (const object of cases) {
    await assert.rejects(
      () => decryptEncryptedWalletBackupProofChunk({ keyHandle, seed: SEED, object }),
      exactCorruptError,
    )
  }

  for (const malformed of [
    Uint8Array.of(0x9f, 0x01, 0x01, 0x80, 0xff),
    Uint8Array.of(0x83, 0x18, 0x01, 0x01, 0x80),
    Uint8Array.of(0xa0),
    Uint8Array.of(0xc0, 0x80),
    Uint8Array.of(0xf4),
    Uint8Array.of(0xf7),
    Uint8Array.of(0xfb, 0, 0, 0, 0, 0, 0, 0, 0),
    Uint8Array.of(0x20),
    Uint8Array.of(0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
    concat(fromHex(vector.expected.canonicalCborHex), Uint8Array.of(0)),
    encodeDeepArray(20),
    encode(new Array(20_000).fill(0), rfc8949EncodeOptions),
  ]) {
    const object = await encryptRawFrame(malformed, 0)
    await assert.rejects(
      () => decryptEncryptedWalletBackupProofChunk({ keyHandle, seed: SEED, object }),
      exactCorruptError,
    )
  }
  const nonzeroPadding = await encryptRawFrame(fromHex(vector.expected.canonicalCborHex), 1)
  await assert.rejects(
    () => decryptEncryptedWalletBackupProofChunk({ keyHandle, seed: SEED, object: nonzeroPadding }),
    exactCorruptError,
  )

  const decoded = decode(fromHex(vector.expected.canonicalCborHex)) as unknown[]
  const records = decoded[2] as unknown[][]
  const oversizedMint = structuredClone(records[0]!)
  oversizedMint[2] = `https://mint.example/${'a'.repeat(2_048)}`
  assert.throws(
    () => preflightEncryptedProofChunkCbor(encode([1, 1, [oversizedMint]], rfc8949EncodeOptions)),
    /mint shape/,
  )
  const nullCtfRegistration = structuredClone(records[0]!)
  nullCtfRegistration[10] = 1
  nullCtfRegistration[11] = [new Uint8Array(32), 'YES', new Uint8Array(32), null, 1_800_000_000]
  assert.throws(
    () => preflightEncryptedProofChunkCbor(encode([1, 1, [nullCtfRegistration]], rfc8949EncodeOptions)),
    /registration shape/,
  )
  for (const mutation of [
    (record: unknown[]) => { record[2] = 'https://other-mint.example' },
    (record: unknown[]) => { record[3] = 'usd' },
    (record: unknown[]) => { record[4] = [2, `01${'22'.repeat(32)}`] },
    (record: unknown[]) => { record[6] = new TextEncoder().encode('11'.repeat(32)) },
    (record: unknown[]) => { record[0] = new Uint8Array(32).fill(9) },
    (record: unknown[]) => { record[1] = new Uint8Array(32).fill(9) },
  ]) {
    const changed = structuredClone(records[0]!)
    mutation(changed)
    const object = await encryptRawFrame(encode([1, 1, [changed]], rfc8949EncodeOptions), 0)
    await assert.rejects(
      () => decryptEncryptedWalletBackupProofChunk({ keyHandle, seed: SEED, object }),
      exactCorruptError,
    )
  }
})

const exactCorruptError = (error: unknown) => {
  assert.equal((error as Error).message, 'corrupt encrypted wallet backup object')
  assert.equal((error as Error).message.includes(SECRET), false)
  return true
}

function proofInput(keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>) {
  const proof = vector.inputs.proof
  const input = {
    keyHandle,
    seed: SEED,
    mint: proof.mint,
    unit: proof.unit,
    counter: proof.counter,
    proof: {
      id: proof.keysetId,
      amount: proof.amount,
      secret: SECRET,
      C: proof.signatureHex,
      dleq: { ...proof.dleq },
    },
    proofKind: 'ordinary' as const,
    ctfMetadata: null,
    effectiveNowUnixSeconds: 1_700_000_000,
    createdAtUnixSeconds: proof.createdAtUnixSeconds,
    updatedAtUnixSeconds: proof.updatedAtUnixSeconds,
  } satisfies UnboundProofInput
  return withProofStore(input)
}

function proofInputForKeyset(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  keysetId: string,
) {
  const counter = 1
  const derive = (Cashu as unknown as {
    createSecretAndBlindingFactorDeriver(seed: Uint8Array, keyset: string):
      (counter: number) => { secret: Uint8Array }
  }).createSecretAndBlindingFactorDeriver(SEED, keysetId)
  const input = {
    ...proofInput(keyHandle),
    counter,
    proof: {
      ...proofInput(keyHandle).proof,
      id: keysetId,
      secret: toHex(derive(counter).secret),
    },
  }
  return withProofStore(input)
}

function ctfProofInput(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
) {
  return {
    ...proofInputForKeyset(keyHandle, CTF_KEYSET_ID),
    proofKind: 'ctf-active' as const,
    ctfMetadata: {
      conditionId: CTF_CONDITIONAL_METADATA.conditionId,
      outcomeLabel: CTF_CONDITIONAL_METADATA.outcomeCollection,
      outcomeCollectionId: CTF_CONDITIONAL_METADATA.outcomeCollectionId,
      registeredAtUnixSeconds: CTF_CONDITIONAL_METADATA.registeredAt,
      finalExpiryUnixSeconds: CTF_MINT_KEYS.final_expiry,
    },
    effectiveNowUnixSeconds: 1_700_000_001,
  }
}

function withProofStore(
  input: UnboundProofInput,
  conditionalKeysetEvidence: VerifiedEncryptedWalletBackupConditionalKeyset | null = null,
  rowOverrides: Record<string, unknown> = {},
) {
  const keysetId = input.proof.id
  const keysetKind = /^(?:01|02)[0-9a-f]{64}$/.test(keysetId) ? 2
    : /^00[0-9a-f]{14}$/.test(keysetId) ? 1 : 0
  const identityKeyset = keysetKind === 0
    ? `legacy:${toHex(fromBase64(keysetId))}`
    : keysetId
  const proofId = deriveProofIdForTest(input.mint, input.unit, identityKeyset, input.proof.secret)
  const ctf = input.ctfMetadata === null ? null : [
    fromHex(input.ctfMetadata.conditionId),
    input.ctfMetadata.outcomeLabel,
    fromHex(input.ctfMetadata.outcomeCollectionId),
    input.ctfMetadata.registeredAtUnixSeconds,
    input.ctfMetadata.finalExpiryUnixSeconds,
  ]
  const signature = fromHex(input.proof.C)
  const dleq = input.proof.dleq === undefined ? null : [
    fromHex(input.proof.dleq.e), fromHex(input.proof.dleq.s), fromHex(input.proof.dleq.r),
  ]
  const commitment = toHex(nobleSha256(encode([
    1, 'proof-record-commitment', input.mint, input.unit, [keysetKind, keysetId],
    input.proof.amount, new TextEncoder().encode(input.proof.secret), signature, dleq,
    input.counter, input.proofKind === 'ordinary' ? 0 : 1, ctf,
    input.createdAtUnixSeconds, input.updatedAtUnixSeconds,
  ], rfc8949EncodeOptions)))
  const row = Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: 'test-snapshot',
    revision: 1,
    proofId,
    proofCommitment: commitment,
    proofKind: input.proofKind,
    ctfMetadata: input.ctfMetadata,
    conditionalKeysetEvidence,
    provenance: 'wallet-seed' as const,
    operationBinding: 'terminally-unlinked' as const,
    reserved: false,
    ambiguousMintOperation: false,
    proofPins: {
      openOrderCollateral: 'absent' as const,
      outbox: 'absent' as const,
      retryCursor: 'absent' as const,
      replayTombstone: 'absent' as const,
      dependentWork: 'absent' as const,
    },
    derivationLocator: 'committed' as const,
    ...rowOverrides,
  })
  return {
    ...input,
    proofSnapshotStore: {
      async withCommittedProofSnapshot<T>(stableProofId: string, read: (value: typeof row) => T): Promise<T> {
        assert.equal(stableProofId, proofId)
        return read(row)
      },
    },
  }
}

function conditionalContext() {
  return {
    mint: vector.inputs.proof.mint,
    unit: 'sat',
    outcomeLabel: CTF_CONDITIONAL_METADATA.outcomeCollection,
    registeredAtUnixSeconds: CTF_CONDITIONAL_METADATA.registeredAt,
    mintKeys: CTF_MINT_KEYS,
    conditionalMetadata: CTF_CONDITIONAL_METADATA,
  }
}

function verifyConditionalEvidence(
  input: Parameters<typeof verifyEncryptedWalletBackupConditionalKeyset>[0],
) {
  return verifyEncryptedWalletBackupConditionalKeyset(input)
}

function verifiedConditionalEvidence() {
  return verifyConditionalEvidence(conditionalContext())
}

function deriveProofIdForTest(mint: string, unit: string, keysetId: string, secret: string): string {
  const parts = ['bitcaster/custody-proof-id/v1', mint, unit, keysetId, secret]
  const encoded = parts.map((part) => {
    const bytes = new TextEncoder().encode(part)
    return concat(uint32(bytes.byteLength), bytes)
  })
  return toHex(nobleSha256(concat(...encoded)))
}

function fromBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const text = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(text, (character) => character.charCodeAt(0))
}

function deterministicRuntime(values: Uint8Array[]): EncryptedWalletBackupRuntime {
  let offset = 0
  return {
    subtle: webcrypto.subtle,
    getRandomValues(target) {
      const value = values[offset++]
      if (value === undefined || value.byteLength !== target.byteLength) {
        throw new Error('unexpected random request')
      }
      target.set(value)
      return target
    },
  }
}

function scalarCandidateRuntime(candidates: Uint8Array[]): {
  runtime: EncryptedWalletBackupRuntime
  scalarCalls(): number
} {
  let scalarCalls = 0
  const subtle = new Proxy(webcrypto.subtle, {
    get(target, property) {
      if (property === 'deriveBits') {
        return async (algorithm: HkdfParams, key: CryptoKey, length: number) => {
          const info = new TextDecoder().decode(toBytes(algorithm.info))
          if (info.includes('request-auth-scalar')) {
            const candidate = candidates[scalarCalls++]
            if (candidate === undefined) throw new Error('missing scalar candidate')
            return candidate.slice().buffer
          }
          return target.deriveBits(algorithm, key, length)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as SubtleCrypto
  return {
    runtime: {
      subtle,
      getRandomValues(target) { return webcrypto.getRandomValues(target) },
    },
    scalarCalls: () => scalarCalls,
  }
}

function toBytes(value: BufferSource): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

async function encryptRawFrame(cbor: Uint8Array, paddingByte: number) {
  const frame = new Uint8Array(262_144)
  new DataView(frame.buffer).setUint32(0, cbor.byteLength, false)
  frame.set(cbor, 4)
  if (paddingByte !== 0) frame.fill(paddingByte, 4 + cbor.byteLength)
  const aad = fromHex(vector.expected.aadHex)
  const nonce = fromHex(vector.inputs.nonceHex)
  const key = await webcrypto.subtle.importKey(
    'raw', fromHex(vector.expected.objectKeyHex), 'AES-GCM', false, ['encrypt'],
  )
  const encrypted = new Uint8Array(await webcrypto.subtle.encrypt({
    name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128,
  }, key, frame))
  const body = concat(nonce, encrypted)
  const digest = toHex(await sha256(concat(uint32(aad.byteLength), aad, body)))
  return {
    formatVersion: 1 as const,
    kindCode: 1 as const,
    realm: vector.inputs.realm,
    vaultId: vector.expected.vaultIdHex,
    objectId: vector.inputs.objectIdHex,
    generation: vector.inputs.generation,
    paddedLength: 262_144 as const,
    digest,
    aad,
    body,
  }
}

function encodeDeepArray(depth: number): Uint8Array {
  const bytes = new Uint8Array(depth + 1)
  bytes.fill(0x81, 0, depth)
  bytes[depth] = 0
  return bytes
}

function mutate(value: Uint8Array, index: number) {
  const result = value.slice()
  result[index] ^= 1
  return result
}

async function sha256(value: Uint8Array) {
  return new Uint8Array(await webcrypto.subtle.digest('SHA-256', value))
}

function uint32(value: number) {
  const result = new Uint8Array(4)
  new DataView(result.buffer).setUint32(0, value, false)
  return result
}

function concat(...values: Uint8Array[]) {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) { result.set(value, offset); offset += value.byteLength }
  return result
}

function fromHex(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
}

function toHex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface BackupVector {
  inputs: {
    seedHex: string
    realm: string
    objectIdHex: string
    nonceHex: string
    generation: number
    proof: {
      mint: string
      unit: string
      keysetId: string
      amount: string
      counter: number
      signatureHex: string
      dleq: { e: string; s: string; r: string }
      proofKind: string
      createdAtUnixSeconds: number
      updatedAtUnixSeconds: number
    }
  }
  expected: Record<string, string | number> & {
    derivedSecretHex: string
    vaultIdHex: string
    requestAuthPublicKeyHex: string
    proofIdHex: string
    commitmentHex: string
    canonicalCborHex: string
    aadHex: string
    bodySha256Hex: string
    objectDigestHex: string
    objectKeyHex: string
    tagHex: string
    bodyLength: number
  }
}
