import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createEncryptedWalletBackupV2CurrentHead } from '../src/encryptedWalletBackupV2Head.ts'
import type { EncryptedWalletBackupV2BundleDescriptor } from '../src/encryptedWalletBackupV2Descriptor.ts'
import {
  digestEncryptedWalletBackupV2BundleSupersessionMutation,
  prepareEncryptedWalletBackupV2BundleSupersessionMutation,
  requireEncryptedWalletBackupV2VerifiedBundleSupersessionMutation,
  verifyEncryptedWalletBackupV2BundleSupersessionMutation,
} from '../src/encryptedWalletBackupV2Mutation.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'

const REALM = 'backup.production'
const VAULT = '5ed0beee7d22da58de93adb7ca2fd724849a052f2a9595577eb3fefc3bb48e4e'
const SEED = Uint8Array.from({ length: 64 }, (_value, index) => index)
const vector = JSON.parse(
  await readFile(
    new URL('../../test-vectors/encrypted-wallet-backup-v2-mutation.json', import.meta.url),
    'utf8',
  ),
) as {
  readonly inputs: {
    readonly realm: string
    readonly vaultId: string
    readonly enrollmentEpoch: number
    readonly headVersion: number
    readonly seedHex: string
    readonly mutationIdHex: string
    readonly auxiliaryRandomnessHex: string
    readonly existingBundle: EncryptedWalletBackupV2BundleDescriptor
    readonly addedBundle: EncryptedWalletBackupV2BundleDescriptor
  }
  readonly expected: {
    readonly requestAuthPublicKey: string
    readonly requestDigest: string
    readonly signature: string
  }
}

test('v2 bundle supersession supports add, replace, removal, and verified evidence', async () => {
  const fixture = await createFixture()
  const addition = await prepare(fixture, fixture.added, [], ['01', '02'])
  const replacement = await prepare(
    fixture,
    fixture.added,
    [fixture.existing.bundleId],
    ['03', '04'],
  )
  const removal = await prepare(fixture, null, [fixture.existing.bundleId], ['05', '06'])
  assert.equal(addition.mutation.supersededBundleIds.length, 0)
  assert.equal(replacement.mutation.supersededBundleIds[0], fixture.existing.bundleId)
  assert.equal(removal.mutation.addedBundle, null)
  const evidence = verify(fixture, replacement)
  assert.equal(requireEncryptedWalletBackupV2VerifiedBundleSupersessionMutation(evidence), evidence)
  assert.throws(
    () => requireEncryptedWalletBackupV2VerifiedBundleSupersessionMutation({ ...evidence }),
    /verified mutation/,
  )
  assert.throws(
    () =>
      requireEncryptedWalletBackupV2VerifiedBundleSupersessionMutation(structuredClone(evidence)),
    /verified mutation/,
  )
})

test('v2 bundle supersession matches the shared deterministic vector', async () => {
  const seed = fromHex(vector.inputs.seedHex)
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: vector.inputs.realm,
    runtime: webcrypto,
  })
  const existing = vector.inputs.existingBundle
  const added = vector.inputs.addedBundle
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: vector.inputs.realm,
    vaultId: vector.inputs.vaultId,
    enrollmentEpoch: vector.inputs.enrollmentEpoch,
    headVersion: vector.inputs.headVersion,
    bundles: [existing],
  })
  const envelope = await prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle,
    expectedHead: head,
    addedBundle: added,
    supersededBundleIds: [existing.bundleId],
    runtime: deterministicRuntime([
      fromHex(vector.inputs.mutationIdHex),
      fromHex(vector.inputs.auxiliaryRandomnessHex),
    ]),
  })
  assert.equal(envelope.requestAuthPublicKey, vector.expected.requestAuthPublicKey)
  assert.equal(envelope.requestDigest, vector.expected.requestDigest)
  assert.equal(envelope.signature, vector.expected.signature)
  assert.equal(verify({ keyHandle, head }, envelope).envelope.requestDigest, envelope.requestDigest)
})

test('v2 bundle supersession rejects invalid mutation fields and modes', async () => {
  const fixture = await createFixture()
  const envelope = await prepare(fixture, fixture.added, [fixture.existing.bundleId], ['07', '08'])
  const mutation = envelope.mutation
  const ids = [fixture.existing.bundleId, descriptor(3).bundleId]
  const cases: readonly unknown[] = [
    { ...mutation, addedBundle: null, supersededBundleIds: [] },
    { ...mutation, supersededBundleIds: [...ids].reverse() },
    { ...mutation, supersededBundleIds: [fixture.existing.bundleId, fixture.existing.bundleId] },
    { ...mutation, supersededBundleIds: ['aa'] },
    {
      ...mutation,
      supersededBundleIds: Array.from({ length: 257 }, () => fixture.existing.bundleId),
    },
    { ...mutation, addedBundle: { ...fixture.added, realm: 'backup.staging' } },
    { ...mutation, addedBundle: { ...fixture.added, vaultId: '22'.repeat(32) } },
    { ...mutation, supersededBundleIds: [fixture.added.bundleId] },
    { ...mutation, mutationId: 'AA'.repeat(16) },
    { ...mutation, unexpected: true },
  ]
  for (const invalid of cases)
    assert.throws(() =>
      digestEncryptedWalletBackupV2BundleSupersessionMutation({
        mutation: invalid,
        requestAuthPublicKey: fixture.keyHandle.requestAuthPublicKey,
      }),
    )
})

test('v2 bundle supersession rejects expected heads above the active limits', async () => {
  const fixture = await createFixture()
  for (const expectedHead of [
    { ...fixture.head, activeBundleCount: 257 },
    { ...fixture.head, activeObjectCount: 257 },
  ]) {
    await assert.rejects(
      () =>
        prepareEncryptedWalletBackupV2BundleSupersessionMutation({
          keyHandle: fixture.keyHandle,
          expectedHead,
          addedBundle: fixture.added,
          supersededBundleIds: [fixture.existing.bundleId],
          runtime: deterministicRuntime([fromHex('0d'.repeat(16)), fromHex('0e'.repeat(32))]),
        }),
      /active (bundle|object) count/,
    )
  }
})

test('v2 bundle supersession rejects wrong key, context, signature, digest, and envelope fields', async () => {
  const fixture = await createFixture()
  const envelope = await prepare(fixture, fixture.added, [fixture.existing.bundleId], ['09', '0a'])
  const wrongKey = await createEncryptedWalletBackupV2KeyHandle({
    seed: Uint8Array.from({ length: 64 }, (_value, index) => 255 - index),
    realm: REALM,
    runtime: webcrypto,
  })
  const cases: readonly [
    unknown,
    string,
    { realm: string; vaultId: string; enrollmentEpoch: number },
  ][] = [
    [envelope, wrongKey.requestAuthPublicKey, context(fixture.head)],
    [
      envelope,
      fixture.keyHandle.requestAuthPublicKey,
      { ...context(fixture.head), realm: 'backup.staging' },
    ],
    [
      { ...envelope, signature: 'ff'.repeat(64) },
      fixture.keyHandle.requestAuthPublicKey,
      context(fixture.head),
    ],
    [
      { ...envelope, requestDigest: 'ff'.repeat(32) },
      fixture.keyHandle.requestAuthPublicKey,
      context(fixture.head),
    ],
    [
      { ...envelope, mutation: { ...envelope.mutation, expectedHeadVersion: 9 } },
      fixture.keyHandle.requestAuthPublicKey,
      context(fixture.head),
    ],
    [
      { ...envelope, unexpected: true },
      fixture.keyHandle.requestAuthPublicKey,
      context(fixture.head),
    ],
  ]
  for (const [candidate, expectedRequestAuthPublicKey, expectedContext] of cases)
    assert.throws(() =>
      verifyEncryptedWalletBackupV2BundleSupersessionMutation({
        envelope: candidate,
        expectedRequestAuthPublicKey,
        expectedContext,
      }),
    )
})

test('v2 bundle supersession snapshots accessors and detaches its mutation output', async () => {
  const fixture = await createFixture()
  const sourceIds = [fixture.existing.bundleId]
  const accessorHead = { ...fixture.head }
  let epochReads = 0
  Object.defineProperty(accessorHead, 'enrollmentEpoch', {
    enumerable: true,
    get: () => (epochReads++ === 0 ? fixture.head.enrollmentEpoch : 2),
  })
  let keyReads = 0
  let addedReads = 0
  let idsReads = 0
  let runtimeReads = 0
  const input = {
    get keyHandle() {
      keyReads += 1
      return fixture.keyHandle
    },
    get expectedHead() {
      return accessorHead
    },
    get addedBundle() {
      addedReads += 1
      return fixture.added
    },
    get supersededBundleIds() {
      return idsReads++ === 0 ? sourceIds : []
    },
    get runtime() {
      runtimeReads += 1
      return deterministicRuntime([fromHex('0b'.repeat(16)), fromHex('0c'.repeat(32))])
    },
  }
  const envelope = await prepareEncryptedWalletBackupV2BundleSupersessionMutation(input)
  sourceIds[0] = 'ff'.repeat(16)
  fixture.added.assetLocators[0] = 'ff'.repeat(32)
  assert.equal(epochReads, 1)
  assert.equal(keyReads, 1)
  assert.equal(addedReads, 1)
  assert.equal(idsReads, 1)
  assert.equal(runtimeReads, 1)
  assert.equal(envelope.mutation.supersededBundleIds[0], fixture.existing.bundleId)
  assert.equal(envelope.mutation.addedBundle?.assetLocators[0], '21'.repeat(32))
  assert.equal(Object.isFrozen(envelope), true)
  assert.equal(Object.isFrozen(envelope.mutation), true)
})

test('v2 bundle supersession rejects a random runtime that returns another array', async () => {
  const fixture = await createFixture()
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupV2BundleSupersessionMutation({
        keyHandle: fixture.keyHandle,
        expectedHead: fixture.head,
        addedBundle: fixture.added,
        supersededBundleIds: [fixture.existing.bundleId],
        runtime: { getRandomValues: (target) => new Uint8Array(target.byteLength) },
      }),
    /randomness/,
  )
})

async function createFixture() {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: REALM,
    runtime: webcrypto,
  })
  const existing = descriptor(1)
  const added = descriptor(2)
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: VAULT,
    enrollmentEpoch: 7,
    headVersion: 3,
    bundles: [existing],
  })
  return { keyHandle, existing, added, head }
}

async function prepare(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  addedBundle: ReturnType<typeof descriptor> | null,
  supersededBundleIds: readonly string[],
  random: readonly string[],
) {
  return prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle: fixture.keyHandle,
    expectedHead: fixture.head,
    addedBundle,
    supersededBundleIds,
    runtime: deterministicRuntime(random.map(fromRepeatedHex)),
  })
}

function verify(fixture: Awaited<ReturnType<typeof createFixture>>, envelope: unknown) {
  return verifyEncryptedWalletBackupV2BundleSupersessionMutation({
    envelope,
    expectedRequestAuthPublicKey: fixture.keyHandle.requestAuthPublicKey,
    expectedContext: context(fixture.head),
  })
}

function context(head: ReturnType<typeof createEncryptedWalletBackupV2CurrentHead>) {
  return { realm: head.realm, vaultId: head.vaultId, enrollmentEpoch: head.enrollmentEpoch }
}

function descriptor(index: number, realm = REALM, vaultId = VAULT) {
  return {
    formatVersion: 2 as const,
    realm,
    vaultId,
    bundleId: index.toString(16).padStart(32, '0'),
    operationLocator: (index + 16).toString(16).padStart(64, '0'),
    assetLocators: ['21'.repeat(32)],
    payloadCommitment: (index + 32).toString(16).padStart(64, '0'),
    objects: [
      {
        objectId: (index + 48).toString(16).padStart(32, '0'),
        digest: (index + 64).toString(16).padStart(64, '0'),
      },
    ],
  }
}

function deterministicRuntime(values: readonly Uint8Array[]) {
  const queue = values.map((value) => value.slice())
  return {
    getRandomValues(target: Uint8Array): Uint8Array {
      const value = queue.shift()
      if (value === undefined || value.byteLength !== target.byteLength)
        throw new Error('random vector')
      target.set(value)
      return target
    },
  }
}

function fromRepeatedHex(value: string): Uint8Array {
  return fromHex(
    value.repeat(
      value === '01' || value === '03' || value === '05' || value === '07' || value === '09'
        ? 16
        : 32,
    ),
  )
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  )
}
