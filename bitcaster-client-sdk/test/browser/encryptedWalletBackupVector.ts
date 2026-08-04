import vector from '../../../test-vectors/encrypted-wallet-backup-v1.json'
import * as Cashu from '@cashu/cashu-ts'
import {
  createEncryptedWalletBackupKeyHandle,
  decryptEncryptedWalletBackupProofChunk,
  encodeEncryptedWalletBackupRequestProof,
  packEncryptedWalletBackupProofChunk,
  prepareEncryptedWalletBackupObject,
  prepareEncryptedWalletBackupProof,
  prepareEncryptedWalletBackupRequestProof,
  verifyEncryptedWalletBackupConditionalKeyset,
  readPreparedEncryptedWalletBackupObject,
  type EncryptedWalletBackupProofInput,
  type EncryptedWalletBackupRuntime,
} from '../../src/encryptedWalletBackup.ts'
import { encodeCanonicalBackupCbor } from '../../src/encryptedWalletBackupCbor.ts'
import { encodeDurableWalletProofDerivationLocatorCbor } from '../../src/durableWalletProofDerivationLocator.ts'
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '../../src/durableCustody.ts'
import { buildBoundedEncryptedWalletBackupManifestVector } from './encryptedWalletBackupBoundedManifest.ts'

const CTF_KEYSET_ID = '01e9c2aad6d0fdad988a3b58ef6940416c9bb12b3dd344b5320d7a3f28e919284c'
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
const CTF_METADATA = {
  conditionId: 'aa'.repeat(32),
  outcomeCollection: 'YES',
  outcomeCollectionId: 'def71b1ff5a53597a8175729a718b1bf931d12c2a76500f208ab450c12444c4e',
  registeredAt: 1_700_000_000,
}
type UnboundProofInput = Omit<EncryptedWalletBackupProofInput, 'proofSnapshotStore'>

declare global {
  var __encryptedWalletBackupVectorResult:
    | {
        ok: true
        legacyRestoreMs: number
        modeledChunks: number
        modeledWorkSlices: number
      }
    | { ok: false; error: string }
}

void run().then(
  (metrics) => {
    globalThis.__encryptedWalletBackupVectorResult = { ok: true, ...metrics }
  },
  (error: unknown) => {
    globalThis.__encryptedWalletBackupVectorResult = {
      ok: false,
      error: error instanceof Error ? error.message : 'unknown browser vector failure',
    }
  },
)

async function run(): Promise<{
  legacyRestoreMs: number
  modeledChunks: number
  modeledWorkSlices: number
}> {
  const input = vector.inputs
  const expected = vector.expected
  const seed = fromHex(input.seedHex)
  const runtime = deterministicRuntime([fromHex(input.objectIdHex), fromHex(input.nonceHex)])
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: input.realm,
    runtime,
  })
  equal(keyHandle.vaultId, expected.vaultIdHex, 'vaultIdHex')
  equal(keyHandle.requestAuthPublicKey, expected.requestAuthPublicKeyHex, 'requestAuthPublicKeyHex')
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: input.request.enrollmentEpoch,
    method: input.request.method as 'POST',
    url: input.request.url,
    issuedAtUnixSeconds: input.request.issuedAtUnixSeconds,
    expiresAtUnixSeconds: input.request.expiresAtUnixSeconds,
    payload: fromHex(input.request.payloadHex),
    signal: AbortSignal.timeout(60_000),
    runtime: deterministicRuntime([
      fromHex(input.request.replayNonceHex),
      fromHex(input.request.auxiliaryRandomnessHex),
    ]),
  })
  equal(requestProof.payloadDigest, expected.requestPayloadDigestHex, 'request payload digest')
  equal(requestProof.signature, expected.requestSignatureHex, 'request signature')
  equal(
    toHex(encodeEncryptedWalletBackupRequestProof(requestProof)),
    expected.requestProofCborHex,
    'request proof CBOR',
  )
  const proofHandle = await prepareEncryptedWalletBackupProof(
    await bindProofStore(baseProofInput(seed, keyHandle)),
  )
  equal(proofHandle.proofId, expected.proofIdHex, 'proofIdHex')
  equal(proofHandle.commitment, expected.commitmentHex, 'commitmentHex')
  const prepared = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk: packEncryptedWalletBackupProofChunk([proofHandle]),
    generation: input.generation,
    runtime,
  })
  const wire = readPreparedEncryptedWalletBackupObject(prepared)
  equal(wire.objectId, input.objectIdHex, 'objectIdHex')
  equal(wire.digest, expected.objectDigestHex, 'objectDigestHex')
  equal(toHex(wire.aad), expected.aadHex, 'aadHex')
  equal(toHex(await digest(wire.body)), expected.bodySha256Hex, 'bodySha256Hex')
  equal(toHex(wire.body.slice(-16)), expected.tagHex, 'tagHex')
  equal(wire.body.byteLength, expected.bodyLength, 'bodyLength')
  const restored = await decryptEncryptedWalletBackupProofChunk({
    keyHandle,
    seed,
    object: wire,
  })
  equal(restored.formatVersion, 1, 'decoded format')
  equal(restored.kindCode, 1, 'decoded kind')
  equal(restored.recordCount, 1, 'decoded record count')
  equal(JSON.stringify(restored).includes(expected.derivedSecretHex), false, 'decoded opacity')

  await exerciseManifestVector(seed, keyHandle)
  await exerciseBlsAndCtf(seed, keyHandle)
  await exerciseFailureCases(seed, keyHandle, prepared, wire)
  return exerciseMaxLegacyRestoreScheduling(seed, keyHandle)
}

async function exerciseManifestVector(
  seed: Uint8Array,
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
): Promise<void> {
  const input = vector.inputs
  const derive = (
    Cashu as unknown as {
      createSecretAndBlindingFactorDeriver(
        seed: Uint8Array,
        keyset: string,
      ): (counter: number) => { secret: Uint8Array }
    }
  ).createSecretAndBlindingFactorDeriver(seed, input.proof.keysetId)
  const proofs = []
  for (let counter = 0; counter < 4; counter += 1) {
    const base = baseProofInput(seed, keyHandle)
    proofs.push(
      await prepareEncryptedWalletBackupProof(
        await bindProofStore({
          ...base,
          derivationLocator: nut13(base.proof.id, counter),
          proof: { ...base.proof, secret: toHex(derive(counter).secret) },
        }),
      ),
    )
  }
  proofs.sort((left, right) => left.proofId.localeCompare(right.proofId))
  const manifest = await buildBoundedEncryptedWalletBackupManifestVector({
    seed,
    keyHandle,
    proofs,
    packRuntimes: [
      deterministicRuntime([new Uint8Array(16).fill(1), new Uint8Array(12).fill(11)]),
      deterministicRuntime([new Uint8Array(16).fill(2), new Uint8Array(12).fill(12)]),
    ],
    pageRuntime: deterministicRuntime([new Uint8Array(16).fill(21), new Uint8Array(12).fill(31)]),
  })
  const pageWire = readPreparedEncryptedWalletBackupObject(manifest.page)
  equal(toHex(manifest.head), vector.expected.manifestPipelineCanonicalHeadHex, 'manifest head')
  equal(
    toHex(manifest.references),
    vector.expected.manifestPipelineCanonicalReferenceSetHex,
    'manifest reference set',
  )
  equal(
    pageWire.objectId,
    vector.expected.manifestPipelinePageObjectIdHex,
    'manifest page object id',
  )
  equal(pageWire.digest, vector.expected.manifestPipelinePageDigestHex, 'manifest page digest')
  equal(toHex(pageWire.aad), vector.expected.manifestPipelinePageAadHex, 'manifest page AAD')
  equal(
    toHex(await digest(pageWire.body)),
    vector.expected.manifestPipelinePageBodySha256Hex,
    'manifest page body digest',
  )
}

async function exerciseBlsAndCtf(
  seed: Uint8Array,
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
): Promise<void> {
  const blsKeyset = `02${'55'.repeat(32)}`
  const blsBase = proofInputForKeyset(seed, keyHandle, blsKeyset)
  const blsInput = {
    ...blsBase,
    proof: { ...blsBase.proof, C: 'aa'.repeat(48), dleq: undefined },
  }
  const blsProof = await prepareEncryptedWalletBackupProof(
    await bindProofStore({
      ...blsInput,
    }),
  )
  const blsObject = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk: packEncryptedWalletBackupProofChunk([blsProof]),
    generation: 2,
    runtime: deterministicRuntime([new Uint8Array(16).fill(31), new Uint8Array(12).fill(32)]),
  })
  const blsDecoded = await decryptEncryptedWalletBackupProofChunk({
    keyHandle,
    seed,
    object: readPreparedEncryptedWalletBackupObject(blsObject),
  })
  equal(blsDecoded.recordCount, 1, 'BLS record count')

  const ctfInput = {
    ...proofInputForKeyset(seed, keyHandle, CTF_KEYSET_ID),
    proofKind: 'ctf',
    ctfMetadata: {
      conditionId: CTF_METADATA.conditionId,
      outcomeLabel: CTF_METADATA.outcomeCollection,
      outcomeCollectionId: CTF_METADATA.outcomeCollectionId,
      registeredAtUnixSeconds: CTF_METADATA.registeredAt,
      finalExpiryUnixSeconds: CTF_MINT_KEYS.final_expiry,
    },
  }
  const conditionalKeyset = verifyEncryptedWalletBackupConditionalKeyset({
    mint: ctfInput.mint,
    unit: ctfInput.unit,
    outcomeLabel: ctfInput.ctfMetadata.outcomeLabel,
    registeredAtUnixSeconds: ctfInput.ctfMetadata.registeredAtUnixSeconds,
    mintKeys: CTF_MINT_KEYS,
    conditionalMetadata: CTF_METADATA,
  })
  const ctfProof = await prepareEncryptedWalletBackupProof(
    await bindProofStore(ctfInput, conditionalKeyset),
  )
  const ctfObject = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk: packEncryptedWalletBackupProofChunk([ctfProof]),
    generation: 3,
    runtime: deterministicRuntime([new Uint8Array(16).fill(33), new Uint8Array(12).fill(34)]),
  })
  const ctfDecoded = await decryptEncryptedWalletBackupProofChunk({
    keyHandle,
    seed,
    object: readPreparedEncryptedWalletBackupObject(ctfObject),
  })
  equal(ctfDecoded.recordCount, 1, 'CTF record count')
  equal('proofKind' in ctfDecoded, false, 'CTF disposition remains opaque')
}

async function exerciseFailureCases(
  seed: Uint8Array,
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  prepared: Awaited<ReturnType<typeof prepareEncryptedWalletBackupObject>>,
  wire: ReturnType<typeof readPreparedEncryptedWalletBackupObject>,
): Promise<void> {
  await rejects(
    () =>
      decryptEncryptedWalletBackupProofChunk({
        keyHandle,
        seed,
        object: { ...wire, body: mutate(wire.body, 100) },
      }),
    'tamper',
  )
  await rejects(
    () =>
      decryptEncryptedWalletBackupProofChunk({
        keyHandle,
        seed,
        object: { ...wire, body: wire.body.slice(1) },
      }),
    'truncation',
  )
  const noncanonical = await encryptRawFrame(Uint8Array.of(0x83, 0x18, 0x01, 0x01, 0x80))
  await rejects(
    () =>
      decryptEncryptedWalletBackupProofChunk({
        keyHandle,
        seed,
        object: noncanonical,
      }),
    'noncanonical CBOR',
  )
  await rejects(
    async () => readPreparedEncryptedWalletBackupObject({ ...prepared }),
    'prepared-object capability clone',
  )
  await rejects(
    async () =>
      prepareEncryptedWalletBackupProof({
        ...(await bindProofStore(baseProofInput(seed, keyHandle))),
        keyHandle: { ...keyHandle },
      }),
    'key capability clone',
  )
  const collisionProof = await prepareEncryptedWalletBackupProof(
    await bindProofStore(baseProofInput(seed, keyHandle)),
  )
  await rejects(
    () =>
      prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk: packEncryptedWalletBackupProofChunk([collisionProof]),
        generation: 4,
        runtime: deterministicRuntime(new Array(8).fill(new Uint8Array(16).fill(35))),
        objectIdExists: () => true,
      }),
    'collision exhaustion',
  )
}

async function exerciseMaxLegacyRestoreScheduling(
  seed: Uint8Array,
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
): Promise<{
  legacyRestoreMs: number
  modeledChunks: number
  modeledWorkSlices: number
}> {
  const legacyKeyset = '009a1f293253e41e'
  const derive = (
    Cashu as unknown as {
      createSecretAndBlindingFactorDeriver(
        seed: Uint8Array,
        keyset: string,
      ): (counter: number) => { secret: Uint8Array }
    }
  ).createSecretAndBlindingFactorDeriver(seed, legacyKeyset)
  const preparedProofs = []
  for (let counter = 0; counter < 512; counter += 1) {
    const base = baseProofInput(seed, keyHandle)
    const input = {
      ...base,
      derivationLocator: nut13(legacyKeyset, counter),
      proof: {
        ...base.proof,
        id: legacyKeyset,
        secret: toHex(derive(counter).secret),
      },
    }
    preparedProofs.push(await prepareEncryptedWalletBackupProof(await bindProofStore(input)))
  }
  const object = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk: packEncryptedWalletBackupProofChunk(preparedProofs),
    generation: 4,
    runtime: deterministicRuntime([new Uint8Array(16).fill(41), new Uint8Array(12).fill(42)]),
  })
  let timerRan = false
  setTimeout(() => {
    timerRan = true
  }, 0)
  const started = performance.now()
  const decoded = await decryptEncryptedWalletBackupProofChunk({
    keyHandle,
    seed,
    object: readPreparedEncryptedWalletBackupObject(object),
  })
  const elapsedMs = performance.now() - started
  equal(decoded.recordCount, 512, 'legacy max record count')
  equal(timerRan, true, 'legacy restore yielded to timer')
  if (elapsedMs > 20_000) throw new Error(`legacy restore exceeded generous bound: ${elapsedMs}`)

  let modeled = 0
  let chunks = 0
  let workSlices = 0
  while (modeled < 50_000) {
    const records = Math.min(512, 50_000 - modeled)
    modeled += records
    chunks += 1
    workSlices += Math.ceil(records / 4)
  }
  equal(modeled, 50_000, 'modeled record count')
  equal(chunks, 98, 'modeled bounded chunk count')
  equal(workSlices, 12_500, 'modeled cooperative work slices')
  return {
    legacyRestoreMs: elapsedMs,
    modeledChunks: chunks,
    modeledWorkSlices: workSlices,
  }
}

function baseProofInput(
  seed: Uint8Array,
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
) {
  const input = vector.inputs
  return {
    keyHandle,
    seed,
    mint: input.proof.mint,
    unit: input.proof.unit,
    derivationLocator: nut13(input.proof.keysetId, input.proof.counter),
    proof: {
      id: input.proof.keysetId,
      amount: input.proof.amount,
      secret: vector.expected.derivedSecretHex,
      C: input.proof.signatureHex,
      dleq: input.proof.dleq,
    },
    proofKind: 'ordinary' as const,
    ctfMetadata: null,
    terminalEvidence: null,
    effectiveNowUnixSeconds: input.proof.createdAtUnixSeconds,
    createdAtUnixSeconds: input.proof.createdAtUnixSeconds,
    updatedAtUnixSeconds: input.proof.updatedAtUnixSeconds,
  } satisfies UnboundProofInput
}

async function bindProofStore(
  input: UnboundProofInput,
  conditionalKeysetEvidence: ReturnType<
    typeof verifyEncryptedWalletBackupConditionalKeyset
  > | null = null,
) {
  const keysetKind = /^(?:01|02)[0-9a-f]{64}$/.test(input.proof.id)
    ? 2
    : /^00[0-9a-f]{14}$/.test(input.proof.id)
      ? 1
      : 0
  const ctf =
    input.ctfMetadata === null
      ? null
      : [
          fromHex(input.ctfMetadata.conditionId),
          input.ctfMetadata.outcomeLabel,
          fromHex(input.ctfMetadata.outcomeCollectionId),
          input.ctfMetadata.registeredAtUnixSeconds,
          input.ctfMetadata.finalExpiryUnixSeconds,
          null,
        ]
  const dleq =
    input.proof.dleq === undefined
      ? null
      : [fromHex(input.proof.dleq.e), fromHex(input.proof.dleq.s), fromHex(input.proof.dleq.r)]
  const commitment = toHex(
    await digest(
      encodeCanonicalBackupCbor([
        1,
        'proof-record-commitment',
        input.mint,
        input.unit,
        [keysetKind, input.proof.id],
        input.proof.amount,
        new TextEncoder().encode(input.proof.secret),
        fromHex(input.proof.C),
        dleq,
        encodeDurableWalletProofDerivationLocatorCbor(input.derivationLocator),
        input.proofKind === 'ordinary' ? 0 : 1,
        ctf,
        input.createdAtUnixSeconds,
        input.updatedAtUnixSeconds,
      ]),
    ),
  )
  const identityKeyset =
    keysetKind === 0 ? `legacy:${toHex(fromBase64(input.proof.id))}` : input.proof.id
  const proofId = deriveDurableCustodyProofId({
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: deriveDurableCustodyWalletId(input.seed),
    }),
    normalizedMint: input.mint,
    unit: input.unit,
    keysetId: identityKeyset,
    secret: input.proof.secret,
  })
  const row = Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: 'browser-vector-snapshot',
    revision: 1,
    proofId,
    proofCommitment: commitment,
    proofKind: input.proofKind,
    ctfMetadata: input.ctfMetadata,
    terminalOperationId: null,
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
    derivationLocator: input.derivationLocator,
  })
  return {
    ...input,
    proofSnapshotStore: {
      async withCommittedProofSnapshot<T>(
        stableProofId: string,
        read: (value: typeof row) => T,
      ): Promise<T> {
        equal(stableProofId, proofId, 'stable proof id')
        return read(row)
      },
    },
  }
}

function proofInputForKeyset(
  seed: Uint8Array,
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  keysetId: string,
) {
  const counter = 1
  const derive = (
    Cashu as unknown as {
      createSecretAndBlindingFactorDeriver(
        seed: Uint8Array,
        keyset: string,
      ): (counter: number) => { secret: Uint8Array }
    }
  ).createSecretAndBlindingFactorDeriver(seed, keysetId)
  return {
    ...baseProofInput(seed, keyHandle),
    derivationLocator: nut13(keysetId, counter),
    proof: {
      ...baseProofInput(seed, keyHandle).proof,
      id: keysetId,
      secret: toHex(derive(counter).secret),
    },
  }
}

function nut13(keysetId: string, counter: number) {
  return { schemaVersion: 1 as const, kind: 'nut13' as const, keysetId, counter }
}

function deterministicRuntime(values: Uint8Array[]): EncryptedWalletBackupRuntime {
  let offset = 0
  return {
    subtle: crypto.subtle,
    getRandomValues(target) {
      const value = values[offset++]
      if (value === undefined || value.byteLength !== target.byteLength)
        throw new Error('random vector mismatch')
      target.set(value)
      return target
    },
  }
}

async function encryptRawFrame(cbor: Uint8Array) {
  const frame = new Uint8Array(262_144)
  new DataView(frame.buffer).setUint32(0, cbor.byteLength, false)
  frame.set(cbor, 4)
  const aad = fromHex(vector.expected.aadHex)
  const nonce = fromHex(vector.inputs.nonceHex)
  const key = await crypto.subtle.importKey(
    'raw',
    fromHex(vector.expected.objectKeyHex),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: aad,
        tagLength: 128,
      },
      key,
      frame,
    ),
  )
  const body = concat(nonce, encrypted)
  const digestValue = toHex(await digest(concat(uint32(aad.byteLength), aad, body)))
  return {
    formatVersion: 1 as const,
    kindCode: 1 as const,
    realm: vector.inputs.realm,
    vaultId: vector.expected.vaultIdHex,
    objectId: vector.inputs.objectIdHex,
    generation: vector.inputs.generation,
    paddedLength: 262_144 as const,
    digest: digestValue,
    aad,
    body,
  }
}

async function rejects(action: () => unknown | Promise<unknown>, field: string): Promise<void> {
  try {
    await action()
  } catch {
    return
  }
  throw new Error(`expected failure: ${field}`)
}

function equal(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    throw new Error(
      `vector mismatch: ${field}; actual=${String(actual)}; expected=${String(expected)}`,
    )
  }
}

async function digest(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value))
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
}

function toHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function mutate(value: Uint8Array, index: number): Uint8Array {
  const result = value.slice()
  result[index] ^= 1
  return result
}

function uint32(value: number): Uint8Array {
  const result = new Uint8Array(4)
  new DataView(result.buffer).setUint32(0, value, false)
  return result
}

function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.byteLength
  }
  return result
}

function encodeIdentity(parts: readonly string[]): Uint8Array {
  return concat(
    ...parts.flatMap((part) => {
      const bytes = new TextEncoder().encode(part)
      return [uint32(bytes.byteLength), bytes]
    }),
  )
}

function fromBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const text = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4))
  return Uint8Array.from(text, (character) => character.charCodeAt(0))
}
