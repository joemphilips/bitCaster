import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  decodeEncryptedWalletBackupV2BundleDescriptor,
  decodeEncryptedWalletBackupV2BundleDescriptorWire,
  digestEncryptedWalletBackupV2BundleDescriptor,
  encodeEncryptedWalletBackupV2BundleDescriptor,
} from '../src/encryptedWalletBackupV2Descriptor.ts'
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2CurrentHead,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  requireEncryptedWalletBackupV2CollectedHeadEvidence,
  digestEncryptedWalletBackupV2ActiveSet,
} from '../src/encryptedWalletBackupV2Head.ts'

const REALM = 'backup.production'
const VAULT = '11'.repeat(32)
const vector = JSON.parse(
  await readFile(
    new URL('../../test-vectors/encrypted-wallet-backup-v2-head.json', import.meta.url),
    'utf8',
  ),
) as {
  readonly inputs: {
    readonly realm: string
    readonly vaultId: string
    readonly enrollmentEpoch: number
    readonly headVersion: number
    readonly descriptorCount: number
  }
  readonly expected: {
    readonly firstDescriptorDigest: string
    readonly emptyActiveSetDigest: string
    readonly activeSetDigest: string
    readonly head: unknown
    readonly pageBundleCounts: readonly number[]
    readonly pageCursors: readonly (string | null)[]
  }
}

test('v2 descriptor codec is canonical and tamper-sensitive', () => {
  const value = descriptor(1)
  const originalAssetLocator = value.assetLocator
  const decoded = decodeEncryptedWalletBackupV2BundleDescriptor(value, {
    realm: REALM,
    vaultId: VAULT,
  })
  assert.equal(
    digestEncryptedWalletBackupV2BundleDescriptor(decoded),
    digestEncryptedWalletBackupV2BundleDescriptor(value),
  )
  assert.notEqual(
    digestEncryptedWalletBackupV2BundleDescriptor(decoded),
    digestEncryptedWalletBackupV2BundleDescriptor({ ...value, assetLocator: 'ff'.repeat(32) }),
  )
  value.assetLocator = 'ff'.repeat(32)
  assert.equal(decoded.assetLocator, originalAssetLocator)
  for (const invalid of [
    { ...descriptor(1), unexpected: true },
    { ...descriptor(1), realm: 'INVALID REALM' },
    { ...descriptor(1), vaultId: 'aa' },
    { ...descriptor(1), objects: [descriptor(1).objects[0]!, descriptor(1).objects[0]!] },
  ])
    assert.throws(() => decodeEncryptedWalletBackupV2BundleDescriptor(invalid))
})

test('v2 descriptor binds one asset locator and exact uint64 metadata', () => {
  const value = {
    ...descriptor(1),
    assetLocator: '21'.repeat(32),
    declaredAmount: 18_446_744_073_709_551_615n,
    custodyRevision: 18_446_744_073_709_551_615n,
  }
  const decoded = decodeEncryptedWalletBackupV2BundleDescriptor(value)
  assert.equal(decoded.assetLocator, '21'.repeat(32))
  assert.equal(decoded.declaredAmount, 18_446_744_073_709_551_615n)
  assert.equal(decoded.custodyRevision, 18_446_744_073_709_551_615n)
})

test('v2 descriptor wire decoder accepts canonical wire and rejects tampering', () => {
  const value = descriptor(1)
  const wire = encodeEncryptedWalletBackupV2BundleDescriptor(value)
  assert.deepEqual(
    decodeEncryptedWalletBackupV2BundleDescriptorWire(wire, {
      realm: REALM,
      vaultId: VAULT,
    }),
    decodeEncryptedWalletBackupV2BundleDescriptor(value),
  )

  const trailingByte = new Uint8Array(wire.byteLength + 1)
  trailingByte.set(wire)
  assert.throws(() => decodeEncryptedWalletBackupV2BundleDescriptorWire(trailingByte))

  const tampered = new Uint8Array(wire)
  tampered[0] = 0x87
  assert.throws(() => decodeEncryptedWalletBackupV2BundleDescriptorWire(tampered))
})

test('v2 descriptor and page decoders snapshot accessor-backed collections once', () => {
  const assets = descriptor(1)
  let assetReads = 0
  Object.defineProperty(assets, 'assetLocator', {
    enumerable: true,
    get: () => {
      assetReads += 1
      return assetReads === 1 ? '21'.repeat(32) : '22'.repeat(32)
    },
  })
  assert.equal(decodeEncryptedWalletBackupV2BundleDescriptor(assets).assetLocator, '21'.repeat(32))
  assert.equal(assetReads, 1)

  const objects = descriptor(2)
  let objectReads = 0
  Object.defineProperty(objects, 'objects', {
    enumerable: true,
    get: () => {
      objectReads += 1
      return objectReads === 1
        ? [descriptor(2).objects[0]!]
        : Array.from({ length: 16 }, (_, index) => descriptor(index + 3).objects[0]!)
    },
  })
  assert.equal(decodeEncryptedWalletBackupV2BundleDescriptor(objects).objects.length, 1)
  assert.equal(objectReads, 1)

  const bundle = descriptor(3)
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: VAULT,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [bundle],
  })
  const page = enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles: [bundle] })[0]!
  const accessorPage = { ...page }
  let bundleReads = 0
  Object.defineProperty(accessorPage, 'bundles', {
    enumerable: true,
    get: () => {
      bundleReads += 1
      return bundleReads === 1
        ? page.bundles
        : Array.from({ length: 16 }, (_, index) => descriptor(index + 4))
    },
  })
  assert.equal(collectEncryptedWalletBackupV2DescriptorPages([accessorPage]).bundles.length, 1)
  assert.equal(bundleReads, 1)
})

test('v2 current head snapshots input accessors before deriving its digest', () => {
  const bundles = [descriptor(1)]
  let realmReads = 0
  let vaultReads = 0
  let epochReads = 0
  let versionReads = 0
  let bundleReads = 0
  const input = {
    get realm(): string {
      realmReads += 1
      return realmReads === 1 ? REALM : 'other.realm'
    },
    get vaultId(): string {
      vaultReads += 1
      return vaultReads === 1 ? VAULT : '22'.repeat(32)
    },
    get enrollmentEpoch(): number {
      epochReads += 1
      return epochReads === 1 ? 1 : 2
    },
    get headVersion(): number {
      versionReads += 1
      return versionReads === 1 ? 1 : 2
    },
    get bundles() {
      bundleReads += 1
      return bundleReads === 1 ? bundles : [descriptor(2)]
    },
  }
  const head = createEncryptedWalletBackupV2CurrentHead(input)
  assert.equal(head.realm, REALM)
  assert.equal(head.vaultId, VAULT)
  assert.equal(head.enrollmentEpoch, 1)
  assert.equal(head.headVersion, 1)
  assert.equal(
    head.activeSetDigest,
    digestEncryptedWalletBackupV2ActiveSet({
      realm: REALM,
      vaultId: VAULT,
      enrollmentEpoch: 1,
      bundles,
    }),
  )
  assert.equal(realmReads, 1)
  assert.equal(vaultReads, 1)
  assert.equal(epochReads, 1)
  assert.equal(versionReads, 1)
  assert.equal(bundleReads, 1)
})

test('v2 head pages enumerate and collect empty, page limits, and 256 bundles', () => {
  const empty = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: VAULT,
    enrollmentEpoch: 1,
    headVersion: 0,
    bundles: [],
  })
  const emptyPages = enumerateEncryptedWalletBackupV2DescriptorPages({ head: empty, bundles: [] })
  assert.equal(emptyPages.length, 1)
  const emptyEvidence = collectEncryptedWalletBackupV2DescriptorPages(emptyPages)
  assert.equal(requireEncryptedWalletBackupV2CollectedHeadEvidence(emptyEvidence), emptyEvidence)
  assert.throws(
    () => requireEncryptedWalletBackupV2CollectedHeadEvidence({ ...emptyEvidence }),
    /evidence/,
  )
  assert.throws(
    () => requireEncryptedWalletBackupV2CollectedHeadEvidence(structuredClone(emptyEvidence)),
    /evidence/,
  )
  assert.throws(
    () =>
      collectEncryptedWalletBackupV2DescriptorPages([
        { ...emptyPages[0]!, head: { ...empty, activeObjectCount: 1 } },
      ]),
    /head authority/,
  )
  const bundles = Array.from({ length: 256 }, (_, index) => descriptor(index + 1))
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: VAULT,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles,
  })
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles })
  assert.equal(pages.length, 18)
  assert.equal(pages[0]!.bundles.length, 15)
  assert.equal(pages[17]!.bundles.length, 1)
  const collected = collectEncryptedWalletBackupV2DescriptorPages(pages)
  assert.equal(collected.bundles.length, 256)
  assert.equal(collected.head.activeObjectCount, 256)
})

test('v2 head rejects duplicate assets or objects and page cursor tampering', () => {
  const first = descriptor(1)
  const duplicateAsset = { ...descriptor(2), assetLocator: first.assetLocator }
  assert.throws(
    () =>
      createEncryptedWalletBackupV2CurrentHead({
        realm: REALM,
        vaultId: VAULT,
        enrollmentEpoch: 1,
        headVersion: 1,
        bundles: [first, duplicateAsset],
      }),
    /asset locator/,
  )
  assert.throws(
    () =>
      createEncryptedWalletBackupV2CurrentHead({
        realm: REALM,
        vaultId: VAULT,
        enrollmentEpoch: 1,
        headVersion: 1,
        bundles: [first, { ...descriptor(2), bundleId: first.bundleId }],
      }),
    /unordered or duplicated/,
  )
  assert.throws(
    () =>
      createEncryptedWalletBackupV2CurrentHead({
        realm: REALM,
        vaultId: VAULT,
        enrollmentEpoch: 1,
        headVersion: 1,
        bundles: [first, { ...descriptor(2), assetLocator: first.assetLocator }],
      }),
    /asset locator/,
  )
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: VAULT,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [first],
  })
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles: [first] })
  assert.throws(
    () =>
      collectEncryptedWalletBackupV2DescriptorPages([
        { ...pages[0]!, nextAfterBundleId: first.bundleId },
      ]),
    /cursor/,
  )
  assert.throws(
    () =>
      createEncryptedWalletBackupV2CurrentHead({
        realm: REALM,
        vaultId: VAULT,
        enrollmentEpoch: 1,
        headVersion: 1,
        bundles: [first, { ...descriptor(2), objects: first.objects }],
      }),
    /object id/,
  )
})

test('v2 head enforces bundle, object, and page boundaries', () => {
  for (const count of [1, 15, 16]) {
    const bundles = Array.from({ length: count }, (_, index) => descriptor(index + 1))
    const head = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      vaultId: VAULT,
      enrollmentEpoch: 1,
      headVersion: 1,
      bundles,
    })
    assert.equal(
      enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles }).length,
      Math.ceil(count / 15),
    )
  }
  const maximum = Array.from({ length: 256 }, (_, index) => descriptor(index + 1))
  assert.throws(
    () =>
      createEncryptedWalletBackupV2CurrentHead({
        realm: REALM,
        vaultId: VAULT,
        enrollmentEpoch: 1,
        headVersion: 1,
        bundles: [...maximum, descriptor(257)],
      }),
    /active bundles/,
  )
  const objects = [
    descriptor(1, 15),
    ...Array.from({ length: 241 }, (_, index) => descriptor(index + 2)),
  ]
  assert.equal(
    createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      vaultId: VAULT,
      enrollmentEpoch: 1,
      headVersion: 1,
      bundles: objects,
    }).activeObjectCount,
    256,
  )
  assert.throws(
    () =>
      createEncryptedWalletBackupV2CurrentHead({
        realm: REALM,
        vaultId: VAULT,
        enrollmentEpoch: 1,
        headVersion: 1,
        bundles: [...objects, descriptor(999)],
      }),
    /object count/,
  )
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: VAULT,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: maximum,
  })
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles: maximum })
  assert.throws(() => collectEncryptedWalletBackupV2DescriptorPages([...pages, pages[0]!]), /pages/)
})

test('v2 head collector fails closed for compact page corruption cases', () => {
  const bundles = Array.from({ length: 16 }, (_, index) => descriptor(index + 1))
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: VAULT,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles,
  })
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles })
  const changedHead = { ...head, headVersion: 2 }
  const cases: readonly unknown[][] = [
    [pages[0]!],
    [pages[0]!, pages[0]!],
    [...pages].reverse(),
    [pages[0]!, { ...pages[1]!, head: changedHead }],
    [pages[0]!, { ...pages[1]!, afterBundleId: null }],
    [{ ...pages[0]!, nextAfterBundleId: null }, pages[1]!],
    pages.map((page) => ({ ...page, head: { ...head, activeBundleCount: 15 } })),
    pages.map((page) => ({ ...page, head: { ...head, activeObjectCount: 15 } })),
    pages.map((page) => ({ ...page, head: { ...head, activeSetDigest: 'ff'.repeat(32) } })),
  ]
  for (const value of cases)
    assert.throws(() => collectEncryptedWalletBackupV2DescriptorPages(value))
})

test('v2 head commits sorted bundle and descriptor digest pairs', () => {
  const bundles = Array.from({ length: 16 }, (_, index) => descriptor(index + 1))
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: VAULT,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles,
  })
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles })
  assert.equal(
    head.activeSetDigest,
    digestEncryptedWalletBackupV2ActiveSet({
      realm: REALM,
      vaultId: VAULT,
      enrollmentEpoch: 1,
      bundles,
    }),
  )
  assert.deepEqual(
    pages.map((page) => page.bundles.length),
    [15, 1],
  )
  assert.equal(collectEncryptedWalletBackupV2DescriptorPages(pages).bundles.length, 16)
})

test('v2 head golden vector fixes descriptor, active-set, and cursor values', () => {
  const bundles = Array.from({ length: vector.inputs.descriptorCount }, (_, index) =>
    descriptor(index + 1),
  )
  const head = createEncryptedWalletBackupV2CurrentHead({ ...vector.inputs, bundles })
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles })
  assert.equal(
    digestEncryptedWalletBackupV2BundleDescriptor(bundles[0]!),
    vector.expected.firstDescriptorDigest,
  )
  assert.equal(
    digestEncryptedWalletBackupV2ActiveSet({ ...vector.inputs, bundles: [] }),
    vector.expected.emptyActiveSetDigest,
  )
  assert.equal(head.activeSetDigest, vector.expected.activeSetDigest)
  assert.deepEqual(head, vector.expected.head)
  assert.deepEqual(
    pages.map((page) => page.bundles.length),
    vector.expected.pageBundleCounts,
  )
  assert.deepEqual(
    pages.map((page) => page.nextAfterBundleId),
    vector.expected.pageCursors,
  )
})

function descriptor(index: number, objectCount = 1) {
  const bundleId = index.toString(16).padStart(32, '0')
  return {
    formatVersion: 2 as const,
    realm: REALM,
    vaultId: VAULT,
    bundleId,
    assetLocator: (index + 16).toString(16).padStart(64, '0'),
    declaredAmount: BigInt(index),
    custodyRevision: BigInt(index),
    payloadCommitment: (index + 32).toString(16).padStart(64, '0'),
    objects: Array.from({ length: objectCount }, (_, objectIndex) => ({
      objectId: (index * 16 + objectIndex + 48).toString(16).padStart(32, '0'),
      digest: (index * 16 + objectIndex + 64).toString(16).padStart(64, '0'),
    })),
  }
}
