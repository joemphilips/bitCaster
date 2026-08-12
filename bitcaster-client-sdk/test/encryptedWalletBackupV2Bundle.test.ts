import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import {
  decryptEncryptedWalletBackupV2TransportBundle,
  ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_BODY_BYTES,
  ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_PAYLOAD_MAX_BYTES,
  prepareEncryptedWalletBackupV2TransportBundle,
  type EncryptedWalletBackupV2BundleRuntime,
  type EncryptedWalletBackupV2PreparedTransportBundle,
} from '../src/encryptedWalletBackupV2Bundle.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'

const SEED = Uint8Array.from({ length: 64 }, (_value, index) => index)
const REALM = 'backup.production'
const ASSET = Object.freeze({
  mintUrl: 'https://mint.example/cashu',
  unit: 'sat',
  assetIdentity: 'cashu:ordinary',
})
const FRAME_BYTES = ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_BODY_BYTES - 16
const FIRST_OBJECT_PAYLOAD_BYTES = FRAME_BYTES - 16

test('v2 bundle binds one asset and exact uint64 custody metadata', async () => {
  const keyHandle = await keyHandleFor()
  const prepared = await prepare(keyHandle, Uint8Array.of(1, 2, 3), {
    declaredAmount: 18_446_744_073_709_551_615n,
    custodyRevision: 18_446_744_073_709_551_615n,
  })
  assert.equal(prepared.descriptor.assetLocator.length, 64)
  assert.equal(prepared.descriptor.declaredAmount, 18_446_744_073_709_551_615n)
  assert.equal(prepared.descriptor.custodyRevision, 18_446_744_073_709_551_615n)
  assertBytesEqual(await decrypt(keyHandle, prepared), Uint8Array.of(1, 2, 3))
})

test('v2 bundle accepts native Crypto and a minimal key runtime', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: REALM,
    runtime: {
      subtle: {
        importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
        deriveBits: webcrypto.subtle.deriveBits.bind(webcrypto.subtle),
      },
    },
  })
  const prepared = await prepare(keyHandle, Uint8Array.of(1, 2, 3))
  assertBytesEqual(await decrypt(keyHandle, prepared), Uint8Array.of(1, 2, 3))
})

test('v2 bundle restores exact frame boundaries and the maximum payload', async () => {
  const keyHandle = await keyHandleFor()
  for (const payload of [
    Uint8Array.of(7),
    new Uint8Array(FIRST_OBJECT_PAYLOAD_BYTES).fill(8),
    new Uint8Array(FIRST_OBJECT_PAYLOAD_BYTES + 1).fill(9),
  ]) {
    const prepared = await prepare(keyHandle, payload)
    assertBytesEqual(await decrypt(keyHandle, prepared), payload)
  }
  const maximum = new Uint8Array(ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_PAYLOAD_MAX_BYTES)
  maximum[0] = 1
  maximum[maximum.length - 1] = 2
  const prepared = await prepare(keyHandle, maximum)
  assert.equal(prepared.objects.length, 15)
  assertBytesEqual(await decrypt(keyHandle, prepared), maximum)
})

test('v2 bundle rejects invalid one-asset authority before randomness', async () => {
  const keyHandle = await keyHandleFor()
  let randomCalls = 0
  const runtime: EncryptedWalletBackupV2BundleRuntime = {
    subtle: webcrypto.subtle,
    getRandomValues: (target) => {
      randomCalls += 1
      return target
    },
  }
  for (const input of [
    { canonicalPayload: new Uint8Array(ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_PAYLOAD_MAX_BYTES + 1) },
    { declaredAmount: -1n },
    { custodyRevision: 18_446_744_073_709_551_616n },
  ])
    await assert.rejects(() => prepare(keyHandle, Uint8Array.of(1), { ...input, runtime }))
  assert.equal(randomCalls, 0)
})

test('v2 bundle rejects descriptor metadata and object substitutions', async () => {
  const keyHandle = await keyHandleFor()
  const prepared = await prepare(keyHandle, Uint8Array.of(1, 2, 3))
  for (const descriptor of [
    { ...prepared.descriptor, assetLocator: '00'.repeat(32) },
    { ...prepared.descriptor, declaredAmount: 2n },
    { ...prepared.descriptor, custodyRevision: 2n },
  ])
    await assertCorrupt(keyHandle, { ...prepared, descriptor })
  const corrupted = structuredClone(prepared) as MutableBundle
  corrupted.objects[0]!.body[0] ^= 1
  await assertCorrupt(keyHandle, corrupted)
})

test('v2 bundle keeps plaintext metadata private and isolates copied data', async () => {
  const keyHandle = await keyHandleFor()
  const payload = Uint8Array.of(1, 2, 3)
  const first = await prepare(keyHandle, payload, {
    runtime: deterministicRuntime(['01'.repeat(16), '03'.repeat(12)]),
  })
  const second = await prepare(keyHandle, payload, {
    runtime: deterministicRuntime(['02'.repeat(16), '03'.repeat(12)]),
  })
  assert.notEqual(first.descriptor.payloadCommitment, second.descriptor.payloadCommitment)
  const descriptorText = Object.keys(first.descriptor).join(',')
  for (const privateField of ['proofCount', 'payloadLength', 'payloadDigest', 'mint.example'])
    assert.equal(descriptorText.includes(privateField), false)
  payload[0] = 99
  const exposed = first.objects[0]!.body
  exposed[0] ^= 1
  const restored = await decrypt(keyHandle, first)
  restored[0] = 88
  assertBytesEqual(await decrypt(keyHandle, first), Uint8Array.of(1, 2, 3))
})

test('v2 bundle rejects encrypted frame corruption and invalid outer shapes', async () => {
  const keyHandle = await keyHandleFor()
  const header = await prepare(keyHandle, Uint8Array.of(1), {
    runtime: alteredEncryptRuntime((frame) => frame.fill(0, 8, 12)),
  })
  const padding = await prepare(keyHandle, Uint8Array.of(1), {
    runtime: alteredEncryptRuntime((frame) => {
      frame[17] = 1
    }),
  })
  await assertCorrupt(keyHandle, header)
  await assertCorrupt(keyHandle, padding)
  const prepared = await prepare(keyHandle, Uint8Array.of(1))
  await assertCorrupt(await keyHandleForSeed(new Uint8Array(64).fill(255)), prepared)
  await assertCorrupt(keyHandle, { ...prepared, objects: [] })
  const unknown = structuredClone(prepared) as MutableBundle
  unknown.descriptor.unexpected = true
  await assertCorrupt(keyHandle, unknown)
  const unsupported = structuredClone(prepared) as MutableBundle
  unsupported.objects[0]!.formatVersion = 3
  await assertCorrupt(keyHandle, unsupported)
})

test('v2 bundle bounds collisions and validates complete object references', async () => {
  const keyHandle = await keyHandleFor()
  let checks = 0
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupV2TransportBundle({
        keyHandle,
        asset: ASSET,
        declaredAmount: 1n,
        custodyRevision: 1n,
        canonicalPayload: Uint8Array.of(1),
        runtime: deterministicRuntime(),
        bundleIdExists: () => {
          checks += 1
          return true
        },
      }),
    /bundle id collision limit/,
  )
  assert.equal(checks, 8)
  const prepared = await prepare(keyHandle, new Uint8Array(FIRST_OBJECT_PAYLOAD_BYTES + 1))
  const missingReference = structuredClone(prepared) as MutableBundle
  missingReference.descriptor.objects = missingReference.descriptor.objects.slice(1)
  await assertCorrupt(keyHandle, missingReference)
})

async function prepare(
  keyHandle: Awaited<ReturnType<typeof keyHandleFor>>,
  payload: Uint8Array,
  overrides: Partial<{
    asset: typeof ASSET
    declaredAmount: bigint
    custodyRevision: bigint
    canonicalPayload: Uint8Array
    runtime: EncryptedWalletBackupV2BundleRuntime
  }> = {},
): Promise<EncryptedWalletBackupV2PreparedTransportBundle> {
  return prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset: overrides.asset ?? ASSET,
    declaredAmount: overrides.declaredAmount ?? 1n,
    custodyRevision: overrides.custodyRevision ?? 1n,
    canonicalPayload: overrides.canonicalPayload ?? payload,
    runtime: overrides.runtime ?? webcrypto,
  })
}

async function keyHandleFor() {
  return createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM, runtime: webcrypto })
}

async function keyHandleForSeed(seed: Uint8Array) {
  return createEncryptedWalletBackupV2KeyHandle({ seed, realm: REALM, runtime: webcrypto })
}

async function decrypt(
  keyHandle: Awaited<ReturnType<typeof keyHandleFor>>,
  prepared: EncryptedWalletBackupV2PreparedTransportBundle,
): Promise<Uint8Array> {
  return decryptEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    runtime: webcrypto,
    ...prepared,
  })
}

async function assertCorrupt(
  keyHandle: Awaited<ReturnType<typeof keyHandleFor>>,
  value: unknown,
): Promise<void> {
  await assert.rejects(
    () =>
      decryptEncryptedWalletBackupV2TransportBundle({
        keyHandle,
        runtime: webcrypto,
        ...(value as EncryptedWalletBackupV2PreparedTransportBundle),
      }),
    /corrupt encrypted wallet backup v2 bundle/,
  )
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  const equal =
    actual.byteLength === expected.byteLength &&
    actual.every((byte, index) => byte === expected[index])
  assert.equal(equal, true, 'byte values differ')
}

interface MutableBundle {
  descriptor: Record<string, unknown> & { objects: { objectId: string; digest: string }[] }
  objects: { body: Uint8Array; nonce: Uint8Array; aad: Uint8Array; formatVersion: number }[]
}

function deterministicRuntime(
  hexValues: readonly string[] = [],
): EncryptedWalletBackupV2BundleRuntime {
  let index = 0
  return {
    subtle: webcrypto.subtle,
    getRandomValues: (target) => {
      const source =
        hexValues[index] === undefined
          ? new Uint8Array(target.length).fill(index + 1)
          : fromHex(hexValues[index]!)
      index += 1
      if (source.byteLength !== target.byteLength) throw new Error('randomness vector is invalid')
      target.set(source)
      return target
    },
  }
}

function alteredEncryptRuntime(
  alter: (frame: Uint8Array) => void,
): EncryptedWalletBackupV2BundleRuntime {
  return {
    subtle: {
      importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
      deriveBits: webcrypto.subtle.deriveBits.bind(webcrypto.subtle),
      decrypt: webcrypto.subtle.decrypt.bind(webcrypto.subtle),
      encrypt: async (algorithm, key, data) => {
        const frame = new Uint8Array(data as ArrayBuffer).slice()
        alter(frame)
        return webcrypto.subtle.encrypt(algorithm, key, frame)
      },
    },
    getRandomValues: (target) => target.fill(7),
  }
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (item) => Number.parseInt(item, 16))
}
