import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

const vector = JSON.parse(
  await readFile(
    new URL('../../test-vectors/encrypted-wallet-backup-v2-bundle.json', import.meta.url),
    'utf8',
  ),
) as BundleVector
const SEED = Uint8Array.from({ length: 64 }, (_value, index) => index)
const REALM = 'backup.production'
const ASSET = Object.freeze({
  mintUrl: 'https://mint.example/cashu',
  unit: 'sat',
  assetIdentity: 'cashu:ordinary',
})
const FRAME_BYTES = ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_BODY_BYTES - 16
const FIRST_OBJECT_PAYLOAD_BYTES = FRAME_BYTES - 16

test('v2 bundle matches the shared deterministic vector', async () => {
  const keyHandle = await keyHandleFor(vector.inputs.seedHex, vector.inputs.realm)
  const runtime = deterministicRuntime([vector.inputs.bundleIdHex, vector.inputs.nonceHex])
  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    operationId: vector.inputs.operationId,
    assets: vector.inputs.assets,
    canonicalPayload: fromHex(vector.inputs.payloadHex),
    runtime,
  })
  const object = prepared.objects[0]!

  assert.equal(prepared.descriptor.vaultId, vector.expected.vaultId)
  assert.equal(prepared.descriptor.bundleId, vector.expected.bundleId)
  assert.equal(prepared.descriptor.operationLocator, vector.expected.operationLocator)
  assert.deepEqual(prepared.descriptor.assetLocators, vector.expected.assetLocators)
  assert.equal(prepared.descriptor.payloadCommitment, vector.expected.payloadCommitment)
  assert.equal(object.objectId, vector.expected.objectId)
  assert.equal(object.digest, vector.expected.objectDigest)
  assert.equal(toHex(object.aad), vector.expected.aadHex)
  assertBytesEqual(
    await decryptEncryptedWalletBackupV2TransportBundle({ keyHandle, runtime, ...prepared }),
    fromHex(vector.inputs.payloadHex),
  )
})

test('v2 bundle accepts native Crypto directly and a minimal key runtime', async () => {
  const keyHandle = await keyHandleFor(undefined, REALM, minimalKeyRuntime())
  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    operationId: 'operation',
    assets: [ASSET],
    canonicalPayload: Uint8Array.of(1, 2, 3),
    runtime: webcrypto,
  })
  assertBytesEqual(
    await decryptEncryptedWalletBackupV2TransportBundle({
      keyHandle,
      runtime: webcrypto,
      ...prepared,
    }),
    Uint8Array.of(1, 2, 3),
  )
})

test('v2 bundle restores one byte and exact frame boundaries', async () => {
  await assertRoundTrip(Uint8Array.of(7), 1)
  await assertRoundTrip(new Uint8Array(FIRST_OBJECT_PAYLOAD_BYTES).fill(8), 1)
  await assertRoundTrip(new Uint8Array(FIRST_OBJECT_PAYLOAD_BYTES + 1).fill(9), 2)
})

test('v2 bundle accepts the exact maximum payload with 64 asset locators', async () => {
  const payload = new Uint8Array(ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_PAYLOAD_MAX_BYTES)
  payload[0] = 1
  payload[payload.length - 1] = 2
  const assets = Array.from({ length: 64 }, (_, index) => ({
    ...ASSET,
    assetIdentity: `asset-${index}`,
  }))
  const keyHandle = await keyHandleFor()
  const prepared = await prepareBundle(keyHandle, payload, { assets })
  assert.equal(prepared.objects.length, 15)
  assert.equal(prepared.descriptor.assetLocators.length, 64)
  assertBytesEqual(
    await decryptEncryptedWalletBackupV2TransportBundle({
      keyHandle,
      runtime: webcrypto,
      ...prepared,
    }),
    payload,
  )
})

test('v2 bundle rejects oversize payloads before randomness', async () => {
  const keyHandle = await keyHandleFor()
  let randomCalls = 0
  const runtime: EncryptedWalletBackupV2BundleRuntime = {
    subtle: webcrypto.subtle,
    getRandomValues: (target) => {
      randomCalls += 1
      return target
    },
  }
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupV2TransportBundle({
        keyHandle,
        operationId: 'operation',
        assets: [ASSET],
        canonicalPayload: new Uint8Array(ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_PAYLOAD_MAX_BYTES + 1),
        runtime,
      }),
    /canonical transport payload is invalid/,
  )
  assert.equal(randomCalls, 0)
})

test('v2 bundle enforces asset bounds and canonicalizes locators', async () => {
  const keyHandle = await keyHandleFor()
  const prepared = await prepareBundle(keyHandle, Uint8Array.of(1), {
    assets: [
      { ...ASSET, mintUrl: 'HTTPS://MINT.EXAMPLE./cashu///' },
      ASSET,
      { ...ASSET, assetIdentity: 'cashu:conditional' },
    ],
  })
  assert.equal(prepared.descriptor.assetLocators.length, 2)
  assert.equal(
    [...prepared.descriptor.assetLocators].sort().join(','),
    prepared.descriptor.assetLocators.join(','),
  )
  assert.equal(JSON.stringify(prepared.descriptor).includes('mint.example'), false)
  await assert.rejects(
    () => prepareBundle(keyHandle, Uint8Array.of(1), { assets: [] }),
    /asset identities/,
  )
})

test('v2 bundle keeps private metadata out of its public descriptor', async () => {
  const keyHandle = await keyHandleFor()
  const payload = Uint8Array.of(1, 2, 3)
  const first = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    operationId: 'operation',
    assets: [ASSET],
    canonicalPayload: payload,
    runtime: deterministicRuntime(['01'.repeat(16), '03'.repeat(12)]),
  })
  const second = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    operationId: 'operation',
    assets: [ASSET],
    canonicalPayload: payload,
    runtime: deterministicRuntime(['02'.repeat(16), '03'.repeat(12)]),
  })
  const otherVault = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle: await keyHandleFor('ff'.repeat(64)),
    operationId: 'operation',
    assets: [ASSET],
    canonicalPayload: payload,
    runtime: deterministicRuntime(['01'.repeat(16), '03'.repeat(12)]),
  })
  assert.notEqual(first.descriptor.payloadCommitment, second.descriptor.payloadCommitment)
  assert.notEqual(first.descriptor.payloadCommitment, otherVault.descriptor.payloadCommitment)
  const descriptorText = JSON.stringify(first.descriptor)
  for (const privateField of ['proofCount', 'payloadLength', 'payloadDigest'])
    assert.equal(descriptorText.includes(privateField), false)
})

test('v2 bundle rejects descriptor and object tampering', async () => {
  const keyHandle = await keyHandleFor()
  const prepared = await prepareBundle(
    keyHandle,
    new Uint8Array(FIRST_OBJECT_PAYLOAD_BYTES + 1).fill(1),
  )
  for (const descriptor of [
    { ...prepared.descriptor, bundleId: '00'.repeat(16) },
    { ...prepared.descriptor, operationLocator: '00'.repeat(32) },
    { ...prepared.descriptor, assetLocators: ['00'.repeat(32)] },
    { ...prepared.descriptor, payloadCommitment: '00'.repeat(32) },
    { ...prepared.descriptor, objects: [...prepared.descriptor.objects].reverse() },
  ]) {
    await assertCorrupt(keyHandle, { ...prepared, descriptor })
  }
  for (const mutation of ['nonce', 'aad', 'body'] as const) {
    const tampered = clonedBundle(prepared)
    tampered.objects[0]![mutation][0] ^= 1
    await assertCorrupt(keyHandle, tampered)
  }
  const tag = clonedBundle(prepared)
  tag.objects[0]!.body[tag.objects[0]!.body.length - 1] ^= 1
  await assertCorrupt(keyHandle, tag)
  const reference = clonedBundle(prepared)
  reference.descriptor.objects = reference.descriptor.objects.slice(1)
  await assertCorrupt(keyHandle, reference)
  const { payloadCommitment, ...descriptorFields } = prepared.descriptor
  await assertCorrupt(keyHandle, {
    ...prepared,
    descriptor: Object.assign(Object.create({ payloadCommitment }), descriptorFields, {
      unexpected: true,
    }),
  })
})

test('v2 bundle rejects an encrypted invalid length header and nonzero padding', async () => {
  const keyHandle = await keyHandleFor()
  const headerPrepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    operationId: 'operation',
    assets: [ASSET],
    canonicalPayload: Uint8Array.of(1),
    runtime: headerRuntime(),
  })
  await assertCorrupt(keyHandle, headerPrepared)
  const paddingPrepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    operationId: 'operation',
    assets: [ASSET],
    canonicalPayload: Uint8Array.of(1),
    runtime: paddingRuntime(),
  })
  await assertCorrupt(keyHandle, paddingPrepared)
})

test('v2 bundle rejects wrong handles, cardinality, unknown fields, and versions', async () => {
  const keyHandle = await keyHandleFor()
  const prepared = await prepareBundle(keyHandle, Uint8Array.of(1))
  await assertCorrupt(await keyHandleFor('ff'.repeat(64)), prepared)
  await assertCorrupt(await keyHandleFor(toHex(SEED), 'backup.staging'), prepared)
  await assertCorrupt(keyHandle, { ...prepared, objects: prepared.objects.slice(1) })
  const unknown = clonedBundle(prepared)
  unknown.descriptor.unexpected = true
  await assertCorrupt(keyHandle, unknown)
  const unsupported = clonedBundle(prepared)
  unsupported.objects[0]!.formatVersion = 3
  await assertCorrupt(keyHandle, unsupported)
})

test('v2 bundle bounds bundle-id collision retries', async () => {
  const keyHandle = await keyHandleFor()
  let checks = 0
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupV2TransportBundle({
        keyHandle,
        operationId: 'operation',
        assets: [ASSET],
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
})

test('v2 bundle protects prepared objects from retry-time mutation', async () => {
  const keyHandle = await keyHandleFor()
  const prepared = await prepareBundle(keyHandle, Uint8Array.of(1, 2, 3))
  for (const field of ['nonce', 'aad', 'body'] as const) {
    const exposed = prepared.objects[0]![field]
    exposed[0] ^= 1
    assertBytesEqual(
      await decryptEncryptedWalletBackupV2TransportBundle({
        keyHandle,
        runtime: webcrypto,
        ...prepared,
      }),
      Uint8Array.of(1, 2, 3),
    )
  }
})

test('v2 bundle copies transport input and restored output', async () => {
  const keyHandle = await keyHandleFor()
  const payload = Uint8Array.of(1, 2, 3)
  const prepared = await prepareBundle(keyHandle, payload)
  payload[0] = 99
  const first = await decryptEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    runtime: webcrypto,
    ...prepared,
  })
  first[0] = 88
  const second = await decryptEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    runtime: webcrypto,
    ...prepared,
  })
  assert.equal(first[1], 2)
  assert.equal(second[0], 1)
})

async function assertRoundTrip(payload: Uint8Array, objectCount: number): Promise<void> {
  const keyHandle = await keyHandleFor()
  const prepared = await prepareBundle(keyHandle, payload)
  assert.equal(prepared.objects.length, objectCount)
  for (const object of prepared.objects)
    assert.equal(object.body.byteLength, ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_BODY_BYTES)
  assertBytesEqual(
    await decryptEncryptedWalletBackupV2TransportBundle({
      keyHandle,
      runtime: webcrypto,
      ...prepared,
    }),
    payload,
  )
}

async function prepareBundle(
  keyHandle: Awaited<ReturnType<typeof keyHandleFor>>,
  canonicalPayload: Uint8Array,
  overrides: Partial<{
    operationId: string
    assets: readonly { mintUrl: string; unit: string; assetIdentity: string }[]
  }> = {},
): Promise<EncryptedWalletBackupV2PreparedTransportBundle> {
  return prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    operationId: overrides.operationId ?? 'operation',
    assets: overrides.assets ?? [ASSET],
    canonicalPayload,
    runtime: deterministicRuntime(),
  })
}

async function keyHandleFor(
  seedHex = toHex(SEED),
  realm = REALM,
  runtime = { subtle: webcrypto.subtle },
) {
  return createEncryptedWalletBackupV2KeyHandle({
    seed: fromHex(seedHex),
    realm,
    runtime,
  })
}

function minimalKeyRuntime() {
  return {
    subtle: {
      importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
      deriveBits: webcrypto.subtle.deriveBits.bind(webcrypto.subtle),
    },
  }
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

function paddingRuntime(): EncryptedWalletBackupV2BundleRuntime {
  return alteredEncryptRuntime((frame) => {
    frame[17] = 1
  })
}

function headerRuntime(): EncryptedWalletBackupV2BundleRuntime {
  return alteredEncryptRuntime((frame) => {
    frame[8] = 0
    frame[9] = 0
    frame[10] = 0
    frame[11] = 0
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

function clonedBundle(value: EncryptedWalletBackupV2PreparedTransportBundle): MutableBundle {
  return structuredClone(value) as MutableBundle
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  const equal =
    actual.byteLength === expected.byteLength &&
    actual.every((byte, index) => byte === expected[index])
  assert.equal(equal, true, 'byte values differ')
}

interface BundleVector {
  readonly inputs: {
    readonly seedHex: string
    readonly realm: string
    readonly operationId: string
    readonly assets: readonly { mintUrl: string; unit: string; assetIdentity: string }[]
    readonly payloadHex: string
    readonly bundleIdHex: string
    readonly nonceHex: string
  }
  readonly expected: {
    readonly vaultId: string
    readonly bundleId: string
    readonly operationLocator: string
    readonly assetLocators: readonly string[]
    readonly payloadCommitment: string
    readonly objectId: string
    readonly objectDigest: string
    readonly aadHex: string
  }
}

interface MutableBundle {
  descriptor: {
    objects: { objectId: string; digest: string }[]
    [key: string]: unknown
  }
  objects: {
    objectId: string
    digest: string
    nonce: Uint8Array
    aad: Uint8Array
    body: Uint8Array
    formatVersion: number
    [key: string]: unknown
  }[]
}
