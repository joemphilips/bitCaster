import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  decodeEncryptedWalletBackupV2BundleObjectWire,
  encodeEncryptedWalletBackupV2BundleObjectWire,
  prepareEncryptedWalletBackupV2TransportBundle,
} from '../src/encryptedWalletBackupV2Bundle.ts'
import { encodeCanonicalBackupCbor } from '../src/encryptedWalletBackupCbor.ts'
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2CurrentHead,
  enumerateEncryptedWalletBackupV2DescriptorPages,
} from '../src/encryptedWalletBackupV2Head.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'
import { prepareEncryptedWalletBackupV2BundleSupersessionMutation } from '../src/encryptedWalletBackupV2Mutation.ts'
import {
  issueEncryptedWalletBackupV2BundleSupersessionReceipt,
  verifyEncryptedWalletBackupV2BundleSupersessionReceipt,
} from '../src/encryptedWalletBackupV2Receipt.ts'
import {
  decodeEncryptedWalletBackupV2BundleSupersessionReceiptWire,
  decodeEncryptedWalletBackupV2DescriptorPage,
  decodeEncryptedWalletBackupV2UploadGroup,
  encodeEncryptedWalletBackupV2BundleSupersessionReceipt,
  encodeEncryptedWalletBackupV2DescriptorPage,
  encodeEncryptedWalletBackupV2UploadGroup,
  ENCRYPTED_WALLET_BACKUP_V2_UPLOAD_GROUP_MAX_BYTES,
} from '../src/encryptedWalletBackupV2ServiceCodec.ts'

const REALM = 'backup.production'
const SIGNING_PRIVATE_KEY = '03'.repeat(32)
const SIGNING_KEY_ID = '55'.repeat(16)
const vector = JSON.parse(
  await readFile(
    new URL('../../test-vectors/encrypted-wallet-backup-v2-service-codec.json', import.meta.url),
    'utf8',
  ),
) as { readonly expected: Record<string, string> }
test('v2 service codecs produce canonical object, group, page, and receipt wires', async () => {
  const fixture = await createFixture()
  const object = fixture.prepared.objects[0]!
  const objectWire = encodeEncryptedWalletBackupV2BundleObjectWire(
    object,
    fixture.prepared.descriptor,
  )
  const decodedObject = decodeEncryptedWalletBackupV2BundleObjectWire(
    objectWire,
    fixture.prepared.descriptor,
  )
  assert.equal(decodedObject.objectId, object.objectId)
  assert.equal(
    bytesEqual(
      objectWire,
      encodeEncryptedWalletBackupV2BundleObjectWire(decodedObject, fixture.prepared.descriptor),
    ),
    true,
  )
  assert.equal(toHex(sha256(objectWire)), vector.expected.objectWireSha256)

  const group = encodeEncryptedWalletBackupV2UploadGroup({
    envelope: fixture.envelope,
    objects: fixture.prepared.objects,
  })
  const decodedGroup = decodeEncryptedWalletBackupV2UploadGroup({
    bytes: group,
    expectedRequestAuthPublicKey: fixture.keyHandle.requestAuthPublicKey,
    expectedContext: fixture.scope,
  })
  assert.equal(decodedGroup.mutationEvidence.envelope.requestDigest, fixture.envelope.requestDigest)
  assert.equal(decodedGroup.objects[0]!.digest, object.digest)
  assert.equal(
    bytesEqual(
      group,
      encodeEncryptedWalletBackupV2UploadGroup({
        envelope: fixture.envelope,
        objects: decodedGroup.objects,
      }),
    ),
    true,
  )
  assert.equal(toHex(sha256(group)), vector.expected.uploadGroupSha256)

  const pageWire = encodeEncryptedWalletBackupV2DescriptorPage(fixture.pages[0]!)
  const page = decodeEncryptedWalletBackupV2DescriptorPage(pageWire)
  assert.equal(page.head.activeSetDigest, fixture.resultHead.activeSetDigest)
  assert.equal(page.bundles[0]!.bundleId, fixture.prepared.descriptor.bundleId)
  assert.equal(toHex(sha256(pageWire)), vector.expected.descriptorPageSha256)

  const receipt = await issueReceipt(fixture)
  const receiptWire = encodeEncryptedWalletBackupV2BundleSupersessionReceipt(receipt)
  const decodedReceipt = decodeEncryptedWalletBackupV2BundleSupersessionReceiptWire(receiptWire)
  assert.equal(decodedReceipt.signature, receipt.signature)
  assert.equal(
    bytesEqual(receiptWire, encodeEncryptedWalletBackupV2BundleSupersessionReceipt(decodedReceipt)),
    true,
  )
  assert.equal(toHex(sha256(receiptWire)), vector.expected.receiptWireSha256)
  assert.equal(receipt.signature, vector.expected.receiptSignature)
  assert.equal(
    verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
      receipt: decodedReceipt,
      mutationEvidence: decodedGroup.mutationEvidence,
      pinnedSigningKeys: [{ keyId: SIGNING_KEY_ID, publicKey: signingPublicKey() }],
    }).receipt.bundleId,
    fixture.prepared.descriptor.bundleId,
  )
})

test('v2 service codecs reject hostile, foreign, and noncanonical inputs', async () => {
  const fixture = await createFixture()
  const objectWire = encodeEncryptedWalletBackupV2BundleObjectWire(
    fixture.prepared.objects[0]!,
    fixture.prepared.descriptor,
  )
  const group = encodeEncryptedWalletBackupV2UploadGroup({
    envelope: fixture.envelope,
    objects: fixture.prepared.objects,
  })
  const expected = {
    expectedRequestAuthPublicKey: fixture.keyHandle.requestAuthPublicKey,
    expectedContext: fixture.scope,
  }
  for (const bytes of [group.subarray(0, group.length - 1), new Uint8Array([...group, 0])])
    assert.throws(() => decodeEncryptedWalletBackupV2UploadGroup({ bytes, ...expected }))
  assert.throws(() =>
    decodeEncryptedWalletBackupV2UploadGroup({
      bytes: encodeCanonicalBackupCbor(new Map([[1, 2]])),
      ...expected,
    }),
  )
  for (const bytes of [
    Uint8Array.of(0x9f),
    Uint8Array.of(0xbf),
    Uint8Array.of(0xc0, 0x02),
    Uint8Array.of(0xf9, 0x00, 0x00),
    Uint8Array.of(0x20),
  ])
    assert.throws(() => decodeEncryptedWalletBackupV2UploadGroup({ bytes, ...expected }))
  assert.throws(() =>
    decodeEncryptedWalletBackupV2BundleObjectWire(objectWire, {
      ...fixture.prepared.descriptor,
      bundleId: '00'.repeat(16),
    }),
  )
  const tampered = objectWire.slice()
  tampered[tampered.length - 1] ^= 1
  assert.throws(() =>
    decodeEncryptedWalletBackupV2BundleObjectWire(tampered, fixture.prepared.descriptor),
  )
  assert.throws(() =>
    encodeEncryptedWalletBackupV2UploadGroup({
      envelope: {
        ...fixture.envelope,
        mutation: { ...fixture.envelope.mutation, addedBundle: null },
      },
      objects: [],
    }),
  )
  const evidence = decodeEncryptedWalletBackupV2UploadGroup({
    bytes: group,
    ...expected,
  }).mutationEvidence
  await assert.rejects(
    () =>
      issueEncryptedWalletBackupV2BundleSupersessionReceipt({
        mutationEvidence: evidence,
        resultHead: fixture.resultHead,
        signingKeyId: SIGNING_KEY_ID,
        signingPublicKey: signingPublicKey(),
        signDigest: () => new Uint8Array(64),
      }),
    /signer/,
  )
})

test('v2 upload-group maximum has room for fifteen exact object wires', async () => {
  const fixture = await createFixture(15)
  const group = encodeEncryptedWalletBackupV2UploadGroup({
    envelope: fixture.envelope,
    objects: fixture.prepared.objects,
  })
  assert.equal(fixture.prepared.objects.length, 15)
  assert.equal(group.byteLength <= ENCRYPTED_WALLET_BACKUP_V2_UPLOAD_GROUP_MAX_BYTES, true)
  assert.equal(group.byteLength > 3_900_000, true)
  assert.throws(() =>
    encodeEncryptedWalletBackupV2UploadGroup({
      envelope: fixture.envelope,
      objects: [...fixture.prepared.objects].reverse(),
    }),
  )
})

test('v2 upload-group rejects a high-token nested mutation before CBOR materialization', async () => {
  const fixture = await createFixture()
  const bytes = highTokenUploadGroup()
  assert.equal(bytes.byteLength < 70_000, true)
  assert.throws(
    () =>
      decodeEncryptedWalletBackupV2UploadGroup({
        bytes,
        expectedRequestAuthPublicKey: fixture.keyHandle.requestAuthPublicKey,
        expectedContext: fixture.scope,
      }),
    /token limit/,
  )
})

async function createFixture(objectCount = 1) {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: Uint8Array.from({ length: 64 }, (_item, index) => index),
    realm: REALM,
    runtime: webcrypto,
  })
  const payload = new Uint8Array(objectCount === 1 ? 1 : 262_112 + 262_128 * 14)
  payload[0] = 7
  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset: { mintUrl: 'https://mint.example/cashu', unit: 'sat', assetIdentity: 'cashu:ordinary' },
    declaredAmount: BigInt(objectCount),
    custodyRevision: BigInt(objectCount),
    canonicalPayload: payload,
    runtime: deterministicBundleRuntime(objectCount),
  })
  const initialHead = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 0,
    bundles: [],
  })
  const scope = { realm: REALM, walletId: keyHandle.walletId, enrollmentEpoch: 1 }
  const envelope = await prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle,
    expectedHeadEvidence: collectEncryptedWalletBackupV2DescriptorPages(
      enumerateEncryptedWalletBackupV2DescriptorPages({ head: initialHead, bundles: [] }),
    ),
    addedBundle: prepared.descriptor,
    supersededBundleIds: [],
    runtime: deterministicRandom(['11'.repeat(16), '12'.repeat(32)]),
  })
  const resultHead = createEncryptedWalletBackupV2CurrentHead({
    ...scope,
    headVersion: 1,
    bundles: [prepared.descriptor],
  })
  return {
    keyHandle,
    prepared,
    envelope,
    resultHead,
    scope,
    pages: enumerateEncryptedWalletBackupV2DescriptorPages({
      head: resultHead,
      bundles: [prepared.descriptor],
    }),
  }
}

async function issueReceipt(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const evidence = decodeEncryptedWalletBackupV2UploadGroup({
    bytes: encodeEncryptedWalletBackupV2UploadGroup({
      envelope: fixture.envelope,
      objects: fixture.prepared.objects,
    }),
    expectedRequestAuthPublicKey: fixture.keyHandle.requestAuthPublicKey,
    expectedContext: fixture.scope,
  }).mutationEvidence
  return issueEncryptedWalletBackupV2BundleSupersessionReceipt({
    mutationEvidence: evidence,
    resultHead: fixture.resultHead,
    signingKeyId: SIGNING_KEY_ID,
    signingPublicKey: signingPublicKey(),
    signDigest: (digest) =>
      schnorr.sign(digest, fromHex(SIGNING_PRIVATE_KEY), fromHex('04'.repeat(32))),
  })
}

function deterministicRandom(values: readonly string[]) {
  const queue = values.map(fromHex)
  return {
    getRandomValues(target: Uint8Array) {
      const value = queue.shift()
      if (value === undefined || value.byteLength !== target.byteLength)
        throw new Error('random vector')
      target.set(value)
      return target
    },
  }
}

function deterministicBundleRuntime(objectCount: number) {
  return {
    subtle: webcrypto.subtle,
    getRandomValues: deterministicRandom([
      '01'.repeat(16),
      ...Array.from({ length: objectCount }, (_item, index) =>
        (index + 2).toString(16).padStart(2, '0').repeat(12),
      ),
    ]).getRandomValues,
  }
}

function signingPublicKey(): string {
  return toHex(schnorr.getPublicKey(fromHex(SIGNING_PRIVATE_KEY)))
}
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}
function fromHex(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_item, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  )
}
function toHex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, '0')).join('')
}

function highTokenUploadGroup(): Uint8Array {
  const mutation = new CborWriter(60_000)
  mutation.array(15)
  mutation.uint(2)
  mutation.text('bundle-supersession-mutation')
  mutation.uint(2)
  mutation.text('bundle-supersession')
  mutation.text(REALM)
  mutation.bytes(32)
  mutation.uint(1)
  mutation.bytes(16)
  mutation.uint(0)
  mutation.bytes(32)
  mutation.null()
  mutation.array(200)
  for (let row = 0; row < 200; row += 1) {
    mutation.array(256)
    for (let column = 0; column < 256; column += 1) mutation.uint(0)
  }
  mutation.bytes(32)
  mutation.bytes(32)
  mutation.bytes(64)
  const signed = mutation.finish()
  const group = new CborWriter(signed.byteLength + 64)
  group.array(4)
  group.uint(2)
  group.text('bundle-supersession-upload-group')
  group.rawBytes(signed)
  group.array(0)
  return group.finish()
}

class CborWriter {
  readonly target: Uint8Array
  offset = 0

  constructor(size: number) {
    this.target = new Uint8Array(size)
  }

  uint(value: number): void {
    this.head(0, value)
  }

  array(length: number): void {
    this.head(4, length)
  }

  text(value: string): void {
    const bytes = new TextEncoder().encode(value)
    this.head(3, bytes.byteLength)
    this.target.set(bytes, this.offset)
    this.offset += bytes.byteLength
  }

  bytes(length: number): void {
    this.head(2, length)
    this.offset += length
  }

  rawBytes(value: Uint8Array): void {
    this.head(2, value.byteLength)
    this.target.set(value, this.offset)
    this.offset += value.byteLength
  }

  null(): void {
    this.target[this.offset++] = 0xf6
  }

  finish(): Uint8Array {
    return this.target.slice(0, this.offset)
  }

  private head(major: number, value: number): void {
    if (value < 24) {
      this.target[this.offset++] = (major << 5) | value
      return
    }
    if (value <= 0xff) {
      this.target[this.offset++] = (major << 5) | 24
      this.target[this.offset++] = value
      return
    }
    this.target[this.offset++] = (major << 5) | 25
    this.target[this.offset++] = value >>> 8
    this.target[this.offset++] = value
  }
}
