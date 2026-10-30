import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { encodeCanonicalBackupCbor } from '../src/encryptedWalletBackupCbor.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'
import {
  encodeEncryptedWalletBackupV2BundleDescriptor,
  digestEncryptedWalletBackupV2BundleDescriptor,
} from '../src/encryptedWalletBackupV2Descriptor.ts'
import {
  createEncryptedWalletBackupOwnerCurrentHead,
  encodeEncryptedWalletBackupOwnerCurrentHead,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
  collectEncryptedWalletBackupOwnerDescriptorPages,
  requireEncryptedWalletBackupOwnerCollectedHeadEvidence,
  type EncryptedWalletBackupOwnerContext,
} from '../src/encryptedWalletBackupOwnerHead.ts'
import {
  prepareEncryptedWalletBackupOwnerBundleSupersessionMutation,
  verifyEncryptedWalletBackupOwnerBundleSupersessionMutation,
  requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation,
} from '../src/encryptedWalletBackupOwnerMutation.ts'
import {
  decodeEncryptedWalletBackupOwnerCurrentHeadWire,
  encodeEncryptedWalletBackupOwnerDescriptorPage,
  decodeEncryptedWalletBackupOwnerDescriptorPageWire,
  encodeEncryptedWalletBackupOwnerCurrentInventory,
  decodeEncryptedWalletBackupOwnerCurrentInventory,
  requireEncryptedWalletBackupOwnerCurrentInventoryScope,
  encodeEncryptedWalletBackupOwnerSignedMutation,
  decodeEncryptedWalletBackupOwnerSignedMutationWire,
} from '../src/encryptedWalletBackupOwnerServiceCodec.ts'
import {
  createEncryptedWalletBackupV2CurrentHead,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  collectEncryptedWalletBackupV2DescriptorPages,
  requireEncryptedWalletBackupV2CollectedHeadEvidence,
} from '../src/encryptedWalletBackupV2Head.ts'
import { requireEncryptedWalletBackupV2VerifiedBundleSupersessionMutation } from '../src/encryptedWalletBackupV2Mutation.ts'
const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/backup-owner/durable-vectors.json', import.meta.url), 'utf8'),
)
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const bytes = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))
const id = (n: number, width: number) => n.toString(16).padStart(width * 2, '0')
const scope = (owner = vectors.a.owner): EncryptedWalletBackupOwnerContext => ({
  ownerScopeId: owner,
  realm: vectors.realm,
  walletId: vectors.walletId,
  enrollmentEpoch: 1,
})
function descriptor(n = 1, objectCount = 1, realm = vectors.realm) {
  return {
    formatVersion: 2 as const,
    realm,
    walletId: vectors.walletId,
    bundleId: id(n, 16),
    assetLocator: id(n + 16, 32),
    declaredAmount: BigInt(n),
    custodyRevision: BigInt(n),
    payloadCommitment: id(n + 32, 32),
    objects: Array.from({ length: objectCount }, (_, i) => ({
      objectId: id(n + 48 + i * 1000, 16),
      digest: id(n + 64 + i * 1000, 32),
    })),
  }
}
function evidence(context = scope(), bundles = [descriptor()], headVersion = 7) {
  const head = createEncryptedWalletBackupOwnerCurrentHead({ ...context, bundles, headVersion })
  return collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({ head, bundles }),
    context,
  )
}
const runtime = {
  getRandomValues: (target: Uint8Array) => {
    target.fill(0x11)
    return target
  },
}
const key = () =>
  createEncryptedWalletBackupV2KeyHandle({
    seed: Uint8Array.from({ length: 64 }, (_, i) => i),
    realm: vectors.realm,
    runtime: webcrypto,
  })

test('owner heads, empty sets, pages, inventory and real signed mutations match independent complete byte vectors', async () => {
  const keyHandle = await key()
  assert.equal(keyHandle.requestAuthPublicKey, vectors.requestPublicKey)
  assert.equal(hex(encodeEncryptedWalletBackupV2BundleDescriptor(descriptor())), vectors.descriptor)
  assert.equal(
    digestEncryptedWalletBackupV2BundleDescriptor(descriptor()),
    vectors.descriptorDigest,
  )
  for (const vector of [vectors.a, vectors.b]) {
    const context = scope(vector.owner),
      empty = evidence(context, [], 0),
      full = evidence(context)
    assert.equal(empty.head.activeSetDigest, vector.emptyDigest)
    assert.equal(full.head.activeSetDigest, vector.activeDigest)
    assert.equal(hex(encodeEncryptedWalletBackupOwnerCurrentHead(empty.head)), vector.emptyHead)
    assert.equal(hex(encodeEncryptedWalletBackupOwnerCurrentHead(full.head)), vector.head)
    assert.deepEqual(decodeEncryptedWalletBackupOwnerCurrentHeadWire(bytes(vector.head)), full.head)
    const page = enumerateEncryptedWalletBackupOwnerDescriptorPages(full)[0]!
    assert.equal(hex(encodeEncryptedWalletBackupOwnerDescriptorPage(page)), vector.page)
    assert.deepEqual(decodeEncryptedWalletBackupOwnerDescriptorPageWire(bytes(vector.page)), page)
    const inventory = {
      ...context,
      headVersion: 7,
      activeSetDigest: full.head.activeSetDigest,
      entries: [
        {
          assetLocator: descriptor().assetLocator,
          declaredAmount: 1n,
          custodyRevision: 1n,
          bundleId: descriptor().bundleId,
          descriptorDigest: vectors.descriptorDigest,
        },
      ],
    }
    assert.equal(hex(encodeEncryptedWalletBackupOwnerCurrentInventory(inventory)), vector.inventory)
    assert.deepEqual(
      requireEncryptedWalletBackupOwnerCurrentInventoryScope({
        inventory: decodeEncryptedWalletBackupOwnerCurrentInventory(bytes(vector.inventory)),
        expectedContext: context,
      }),
      inventory,
    )
    const envelope = await prepareEncryptedWalletBackupOwnerBundleSupersessionMutation({
      keyHandle,
      expectedContext: context,
      expectedHeadEvidence: empty,
      addedBundle: descriptor(),
      supersededBundleIds: [],
      runtime,
    })
    assert.equal(envelope.requestDigest, vector.mutationDigest)
    assert.equal(envelope.signature, vector.signature)
    assert.equal(hex(encodeEncryptedWalletBackupOwnerSignedMutation(envelope)), vector.mutation)
    assert.deepEqual(
      decodeEncryptedWalletBackupOwnerSignedMutationWire(bytes(vector.mutation)),
      envelope,
    )
    const verified = verifyEncryptedWalletBackupOwnerBundleSupersessionMutation({
      envelope,
      expectedContext: context,
      expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
    })
    assert.equal(
      requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation(verified, context),
      verified,
    )
  }
  assert.notEqual(vectors.a.emptyDigest, vectors.b.emptyDigest)
  assert.notEqual(vectors.a.activeDigest, vectors.b.activeDigest)
  assert.notEqual(vectors.a.mutationDigest, vectors.b.mutationDigest)
})

test('same wallet, epoch and counters cannot cross owner boundaries or gain authority through legacy/forged capabilities', async () => {
  const a = scope(),
    b = scope(vectors.b.owner),
    head = evidence(a),
    keyHandle = await key()
  assert.throws(
    () =>
      collectEncryptedWalletBackupOwnerDescriptorPages(
        enumerateEncryptedWalletBackupOwnerDescriptorPages(head),
        b,
      ),
    /context/,
  )
  assert.throws(() => requireEncryptedWalletBackupOwnerCollectedHeadEvidence(head, b), /context/)
  assert.throws(
    () => requireEncryptedWalletBackupOwnerCollectedHeadEvidence({ ...head }, a),
    /evidence/,
  )
  assert.throws(() => requireEncryptedWalletBackupV2CollectedHeadEvidence(head), /evidence/)
  const legacyHead = createEncryptedWalletBackupV2CurrentHead({
    ...a,
    headVersion: 7,
    bundles: [descriptor()],
  })
  const legacy = collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({ head: legacyHead, bundles: [descriptor()] }),
  )
  assert.throws(() => requireEncryptedWalletBackupOwnerCollectedHeadEvidence(legacy, a), /evidence/)
  await assert.rejects(
    prepareEncryptedWalletBackupOwnerBundleSupersessionMutation({
      keyHandle,
      expectedContext: b,
      expectedHeadEvidence: head,
      addedBundle: descriptor(2),
      supersededBundleIds: [],
      runtime,
    }),
    /context/,
  )
  const envelope = decodeEncryptedWalletBackupOwnerSignedMutationWire(bytes(vectors.a.mutation))
  const verify = (value: unknown, expectedContext = a) =>
    verifyEncryptedWalletBackupOwnerBundleSupersessionMutation({
      envelope: value,
      expectedContext,
      expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
    })
  assert.throws(() => verify(envelope, b), /context/)
  assert.throws(
    () =>
      verify({ ...envelope, mutation: { ...envelope.mutation, ownerScopeId: b.ownerScopeId } }, b),
    /signature/,
  )
  assert.throws(() => verify({ ...envelope, signature: '00'.repeat(64) }), /signature/)
  const verified = verify(envelope)
  assert.throws(
    () => requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation(verified, b),
    /context/,
  )
  assert.throws(
    () => requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation({ ...verified }, a),
    /verified mutation/,
  )
  assert.throws(
    () => requireEncryptedWalletBackupV2VerifiedBundleSupersessionMutation(verified),
    /verified mutation/,
  )
  const inventory = decodeEncryptedWalletBackupOwnerCurrentInventory(bytes(vectors.a.inventory))
  assert.throws(
    () => requireEncryptedWalletBackupOwnerCurrentInventoryScope({ inventory, expectedContext: b }),
    /context/,
  )
  assert.throws(
    () =>
      requireEncryptedWalletBackupOwnerCurrentInventoryScope({
        inventory: { ...inventory, ownerScopeId: b.ownerScopeId },
        expectedContext: b,
      }),
    /digest/,
  )
})

test('owner mutation retains exact predecessor and immutable expected-head rules', async () => {
  const keyHandle = await key(),
    context = scope(),
    head = evidence(context)
  const prepare = (
    addedBundle: ReturnType<typeof descriptor> | null,
    supersededBundleIds: readonly string[],
  ) =>
    prepareEncryptedWalletBackupOwnerBundleSupersessionMutation({
      keyHandle,
      expectedContext: context,
      expectedHeadEvidence: head,
      addedBundle,
      supersededBundleIds,
      runtime,
    })
  await assert.rejects(prepare(null, []), /no-op/)
  await assert.rejects(
    prepare(descriptor(2), [descriptor().bundleId]),
    /addition has a predecessor/,
  )
  await assert.rejects(
    prepare({ ...descriptor(2), assetLocator: descriptor().assetLocator }, []),
    /replacement predecessor/,
  )
  await assert.rejects(prepare(null, [id(9, 16)]), /not current/)
  const replacement = await prepare({ ...descriptor(2), assetLocator: descriptor().assetLocator }, [
    descriptor().bundleId,
  ])
  assert.equal(replacement.mutation.expectedHeadVersion, 7)
  assert.equal(replacement.mutation.expectedActiveSetDigest, head.head.activeSetDigest)
  const removal = await prepare(null, [descriptor().bundleId])
  assert.equal(removal.mutation.addedBundle, null)
  assert.ok(Object.isFrozen(replacement.mutation.addedBundle))
  assert.ok(Object.isFrozen(replacement.mutation.supersededBundleIds))
  const verify = (value: unknown) =>
    verifyEncryptedWalletBackupOwnerBundleSupersessionMutation({
      envelope: value,
      expectedContext: context,
      expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
    })
  for (const change of [
    { expectedHeadVersion: 8 },
    { expectedActiveSetDigest: '00'.repeat(32) },
    { enrollmentEpoch: 2 },
    { formatVersion: 2 },
  ])
    assert.throws(() =>
      verify({ ...replacement, mutation: { ...replacement.mutation, ...change } }),
    )
})

test('owner pagination is complete, bounded and cannot mix heads or duplicate assets and objects', () => {
  const context = scope(),
    bundles = Array.from({ length: 256 }, (_, i) => descriptor(i + 1)),
    head = createEncryptedWalletBackupOwnerCurrentHead({ ...context, headVersion: 1, bundles })
  const pages = enumerateEncryptedWalletBackupOwnerDescriptorPages({ head, bundles })
  assert.equal(pages.length, 18)
  assert.equal(collectEncryptedWalletBackupOwnerDescriptorPages(pages, context).bundles.length, 256)
  assert.throws(() => collectEncryptedWalletBackupOwnerDescriptorPages(pages.slice(0, -1), context))
  assert.throws(() =>
    collectEncryptedWalletBackupOwnerDescriptorPages([...pages, pages[0]], context),
  )
  assert.throws(() =>
    collectEncryptedWalletBackupOwnerDescriptorPages(
      [pages[1], pages[0], ...pages.slice(2)],
      context,
    ),
  )
  const foreign = { ...pages[1], head: { ...head, ownerScopeId: vectors.b.owner } }
  assert.throws(() =>
    collectEncryptedWalletBackupOwnerDescriptorPages(
      [pages[0], foreign, ...pages.slice(2)],
      context,
    ),
  )
  for (const second of [
    { ...descriptor(2), assetLocator: descriptor().assetLocator },
    { ...descriptor(2), objects: descriptor().objects },
    descriptor(),
  ])
    assert.throws(() =>
      createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion: 1,
        bundles: [descriptor(), second],
      }),
    )
  assert.throws(() =>
    createEncryptedWalletBackupOwnerCurrentHead({
      ...context,
      headVersion: 1,
      bundles: [...bundles, descriptor(257)],
    }),
  )
})

test('maximum legal owner inventory and page remain encodable; oversized and mixed-version wires refuse', () => {
  const context = { ...scope(), realm: 'a'.repeat(64), enrollmentEpoch: Number.MAX_SAFE_INTEGER }
  const bundles = Array.from({ length: 256 }, (_, i) => ({
    ...descriptor(i + 1, 1, context.realm),
    declaredAmount: (1n << 64n) - 1n,
    custodyRevision: (1n << 64n) - 1n,
  }))
  const head = createEncryptedWalletBackupOwnerCurrentHead({
    ...context,
    headVersion: Number.MAX_SAFE_INTEGER,
    bundles,
  })
  const inventory = {
    ...context,
    headVersion: head.headVersion,
    activeSetDigest: head.activeSetDigest,
    entries: bundles.map((b) => ({
      assetLocator: b.assetLocator,
      declaredAmount: b.declaredAmount,
      custodyRevision: b.custodyRevision,
      bundleId: b.bundleId,
      descriptorDigest: digestEncryptedWalletBackupV2BundleDescriptor(b),
    })),
  }
  const encoded = encodeEncryptedWalletBackupOwnerCurrentInventory(inventory)
  assert.ok(encoded.length < 60000)
  assert.deepEqual(
    requireEncryptedWalletBackupOwnerCurrentInventoryScope({
      inventory: decodeEncryptedWalletBackupOwnerCurrentInventory(encoded),
      expectedContext: context,
    }),
    inventory,
  )
  const largeBundles = Array.from({ length: 15 }, (_, i) => ({
    ...descriptor(i + 1, 15, context.realm),
    declaredAmount: (1n << 64n) - 1n,
    custodyRevision: (1n << 64n) - 1n,
  }))
  const largeHead = createEncryptedWalletBackupOwnerCurrentHead({
    ...context,
    headVersion: Number.MAX_SAFE_INTEGER,
    bundles: largeBundles,
  })
  const page = enumerateEncryptedWalletBackupOwnerDescriptorPages({
    head: largeHead,
    bundles: largeBundles,
  })[0]!
  const pageBytes = encodeEncryptedWalletBackupOwnerDescriptorPage(page)
  assert.ok(pageBytes.length < 65536)
  assert.deepEqual(decodeEncryptedWalletBackupOwnerDescriptorPageWire(pageBytes), page)
  for (const [decode, limit] of [
    [decodeEncryptedWalletBackupOwnerCurrentInventory, 60000],
    [decodeEncryptedWalletBackupOwnerDescriptorPageWire, 65536],
    [decodeEncryptedWalletBackupOwnerSignedMutationWire, 65536],
  ] as const)
    assert.throws(() => decode(new Uint8Array(limit + 1)))
  assert.throws(() =>
    encodeEncryptedWalletBackupOwnerCurrentInventory({
      ...inventory,
      entries: [...inventory.entries, inventory.entries[0]],
    }),
  )
  for (const [decode, wire] of [
    [decodeEncryptedWalletBackupOwnerCurrentInventory, bytes(vectors.a.inventory)],
    [decodeEncryptedWalletBackupOwnerDescriptorPageWire, bytes(vectors.a.page)],
    [decodeEncryptedWalletBackupOwnerSignedMutationWire, bytes(vectors.a.mutation)],
    [decodeEncryptedWalletBackupOwnerCurrentHeadWire, bytes(vectors.a.head)],
  ] as const) {
    const old = wire.slice()
    old[1] = 2
    assert.throws(() => decode(old))
  }
  assert.throws(() =>
    decodeEncryptedWalletBackupOwnerCurrentInventory(
      encodeCanonicalBackupCbor([
        3,
        'current-inventory',
        bytes(context.ownerScopeId),
        context.realm,
        bytes(context.walletId),
        1,
        0,
        bytes(vectors.a.emptyDigest),
        new Array(257).fill(null),
      ]),
    ),
  )
})
