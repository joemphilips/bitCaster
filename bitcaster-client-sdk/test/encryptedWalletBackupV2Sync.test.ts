import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  applyEncryptedWalletBackupV2VerifiedReceipt,
  collectAllEncryptedWalletBackupV2DescriptorPages,
  prepareEncryptedWalletBackupV2AssetMutation,
} from '../src/encryptedWalletBackupV2Sync.ts'
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2CurrentHead,
  enumerateEncryptedWalletBackupV2DescriptorPages,
} from '../src/encryptedWalletBackupV2Head.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'
import { verifyEncryptedWalletBackupV2BundleSupersessionMutation } from '../src/encryptedWalletBackupV2Mutation.ts'
import {
  issueEncryptedWalletBackupV2BundleSupersessionReceipt,
  verifyEncryptedWalletBackupV2BundleSupersessionReceipt,
} from '../src/encryptedWalletBackupV2Receipt.ts'
import { prepareEncryptedWalletBackupV2RequestProof } from '../src/encryptedWalletBackupV2RequestProof.ts'

const SEED = Uint8Array.from({ length: 64 }, (_value, index) => index)
const SIGNER = fromHex('03'.repeat(32))
const PIN = { keyId: '55'.repeat(16), publicKey: toHex(schnorr.getPublicKey(SIGNER)) }

test('collects every descriptor page with a fresh proof for each exact cursor', async () => {
  const fixture = await makeFixture(256)
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head: fixture.head,
    bundles: fixture.bundles,
  })
  const proofs = [] as Awaited<ReturnType<typeof prepareEncryptedWalletBackupV2RequestProof>>[]
  const evidence = await collectAllEncryptedWalletBackupV2DescriptorPages({
    issueRequestProof: async (cursor) => {
      const proof = await requestProof(fixture.keyHandle, cursor, proofs.length)
      proofs.push(proof)
      return proof
    },
    readDescriptorPage: async ({ requestProof, afterBundleId }) => {
      assert.equal(requestProof.url, pageUrl(afterBundleId))
      return pages.find((page) => page.afterBundleId === afterBundleId)!
    },
  })
  assert.equal(evidence.bundles.length, 256)
  assert.equal(proofs.length, 18)
  assert.equal(new Set(proofs.map(({ replayNonce }) => replayNonce)).size, 18)
})

test('rejects incomplete, cyclic, malformed, and over-limit page sequences', async () => {
  const fixture = await makeFixture(16)
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head: fixture.head,
    bundles: fixture.bundles,
  })
  await assert.rejects(() => collect(pages.slice(0, 1), fixture.keyHandle))
  await assert.rejects(() =>
    collect(
      [{ ...pages[0]!, nextAfterBundleId: pages[0]!.afterBundleId }, pages[1]!],
      fixture.keyHandle,
    ),
  )
  await assert.rejects(() => collect([{ ...pages[0]!, bundles: [] }, pages[1]!], fixture.keyHandle))
  const maximum = await makeFixture(256)
  const maximumPages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head: maximum.head,
    bundles: maximum.bundles,
  })
  await assert.rejects(() =>
    collect(
      [
        ...maximumPages.slice(0, -1),
        { ...maximumPages[maximumPages.length - 1]!, nextAfterBundleId: 'ff'.repeat(16) },
      ],
      maximum.keyHandle,
    ),
  )
})

test('prepares exact add, replacement, and removal mutations only for one asset', async () => {
  const initial = await makeFixture(1)
  const old = initial.bundles[0]!
  const added = descriptor(initial.keyHandle.vaultId, 2, old.assetLocator, 2n)
  const other = descriptor(initial.keyHandle.vaultId, 3, 'bb'.repeat(32), 1n)
  const head = evidence(initial.keyHandle, [old, other])
  const add = await prepare(
    initial.keyHandle,
    evidence(initial.keyHandle, [old]),
    'cc'.repeat(32),
    'replace',
    descriptor(initial.keyHandle.vaultId, 4, 'cc'.repeat(32), 1n),
    1,
  )
  const replace = await prepare(initial.keyHandle, head, old.assetLocator, 'replace', added, 2)
  const remove = await prepare(initial.keyHandle, head, old.assetLocator, 'remove', null, 3)
  assert.equal(add.mutation.supersededBundleIds.length, 0)
  assert.deepEqual(replace.mutation.supersededBundleIds, [old.bundleId])
  assert.deepEqual(remove.mutation.supersededBundleIds, [old.bundleId])
  await assert.rejects(() => prepare(initial.keyHandle, head, old.assetLocator, 'remove', added, 4))
  await assert.rejects(() =>
    prepare(initial.keyHandle, head, old.assetLocator, 'replace', other, 5),
  )
  await assert.rejects(() => prepare(initial.keyHandle, head, 'cc'.repeat(32), 'remove', null, 6))
})

test('derives the verified receipt result head locally and rejects mismatches', async () => {
  const initial = await makeFixture(1)
  const old = initial.bundles[0]!
  const prior = evidence(initial.keyHandle, [old])
  const added = descriptor(initial.keyHandle.vaultId, 2, old.assetLocator, 2n)
  const envelope = await prepare(initial.keyHandle, prior, old.assetLocator, 'replace', added, 7)
  const mutationEvidence = verifyEncryptedWalletBackupV2BundleSupersessionMutation({
    envelope,
    expectedRequestAuthPublicKey: initial.keyHandle.requestAuthPublicKey,
    expectedContext: scope(initial.keyHandle),
  })
  const resultHead = createEncryptedWalletBackupV2CurrentHead({
    ...scope(initial.keyHandle),
    headVersion: prior.head.headVersion + 1,
    bundles: [added],
  })
  const receipt = await issueEncryptedWalletBackupV2BundleSupersessionReceipt({
    mutationEvidence,
    resultHead,
    signingKeyId: PIN.keyId,
    signingPublicKey: PIN.publicKey,
    signDigest: (digest) => schnorr.sign(digest, SIGNER),
  })
  const receiptEvidence = verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
    receipt,
    mutationEvidence,
    pinnedSigningKeys: [PIN],
  })
  assert.equal(
    applyEncryptedWalletBackupV2VerifiedReceipt({
      expectedHeadEvidence: prior,
      mutationEvidence,
      receiptEvidence,
    }).bundles[0]!.bundleId,
    added.bundleId,
  )
  const wrongHead = createEncryptedWalletBackupV2CurrentHead({
    ...scope(initial.keyHandle),
    headVersion: resultHead.headVersion,
    bundles: [old],
  })
  const wrongReceipt = await issueEncryptedWalletBackupV2BundleSupersessionReceipt({
    mutationEvidence,
    resultHead: wrongHead,
    signingKeyId: PIN.keyId,
    signingPublicKey: PIN.publicKey,
    signDigest: (digest) => schnorr.sign(digest, SIGNER),
  })
  const wrongEvidence = verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
    receipt: wrongReceipt,
    mutationEvidence,
    pinnedSigningKeys: [PIN],
  })
  assert.throws(() =>
    applyEncryptedWalletBackupV2VerifiedReceipt({
      expectedHeadEvidence: prior,
      mutationEvidence,
      receiptEvidence: wrongEvidence,
    }),
  )
  assert.throws(() =>
    applyEncryptedWalletBackupV2VerifiedReceipt({
      expectedHeadEvidence: evidence(initial.keyHandle, [otherBundle(initial.keyHandle.vaultId)]),
      mutationEvidence,
      receiptEvidence,
    }),
  )
})

async function collect(
  pages: readonly ReturnType<typeof enumerateEncryptedWalletBackupV2DescriptorPages>[number][],
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>,
) {
  return collectAllEncryptedWalletBackupV2DescriptorPages({
    issueRequestProof: (cursor) => requestProof(keyHandle, cursor, 40),
    readDescriptorPage: async ({ afterBundleId }) =>
      pages.find((page) => page.afterBundleId === afterBundleId) ?? pages[0]!,
  })
}

async function prepare(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>,
  expectedHeadEvidence: ReturnType<typeof evidence>,
  assetLocator: string,
  desiredAction: 'replace' | 'remove',
  addedBundle: ReturnType<typeof descriptor> | null,
  nonce: number,
) {
  return prepareEncryptedWalletBackupV2AssetMutation({
    keyHandle,
    expectedHeadEvidence,
    assetLocator,
    desiredAction,
    addedBundle,
    runtime: random(nonce),
  })
}

async function makeFixture(count: number) {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: 'backup.example',
    runtime: webcrypto,
  })
  const bundles = Array.from({ length: count }, (_value, index) =>
    descriptor(keyHandle.vaultId, index + 1, (index + 16).toString(16).padStart(64, '0'), 1n),
  )
  return {
    keyHandle,
    bundles,
    head: createEncryptedWalletBackupV2CurrentHead({
      ...scope(keyHandle),
      headVersion: 1,
      bundles,
    }),
  }
}

function evidence(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>,
  bundles: readonly ReturnType<typeof descriptor>[],
) {
  const head = createEncryptedWalletBackupV2CurrentHead({
    ...scope(keyHandle),
    headVersion: 1,
    bundles,
  })
  return collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles }),
  )
}
function descriptor(vaultId: string, index: number, assetLocator: string, custodyRevision: bigint) {
  return {
    formatVersion: 2 as const,
    realm: 'backup.example',
    vaultId,
    bundleId: index.toString(16).padStart(32, '0'),
    assetLocator,
    declaredAmount: 1n,
    custodyRevision,
    payloadCommitment: (index + 32).toString(16).padStart(64, '0'),
    objects: [
      {
        objectId: (index + 48).toString(16).padStart(32, '0'),
        digest: (index + 64).toString(16).padStart(64, '0'),
      },
    ],
  }
}
function otherBundle(vaultId: string) {
  return descriptor(vaultId, 9, 'dd'.repeat(32), 1n)
}
function scope(keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>) {
  return { realm: keyHandle.realm, vaultId: keyHandle.vaultId, enrollmentEpoch: 1 }
}
async function requestProof(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>,
  cursor: string | null,
  nonce: number,
) {
  return prepareEncryptedWalletBackupV2RequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: pageUrl(cursor),
    issuedAtUnixSeconds: 100,
    expiresAtUnixSeconds: 160,
    payload: new Uint8Array(),
    signal: new AbortController().signal,
    runtime: random(nonce),
  })
}
function pageUrl(cursor: string | null) {
  return `https://backup.example/v2/head${cursor === null ? '' : `?after=${cursor}`}`
}
function random(seed: number) {
  let next = seed
  return {
    getRandomValues(target: Uint8Array) {
      for (let index = 0; index < target.length; index += 1) target[index] = (next + index) & 0xff
      next += target.length
      return target
    },
  }
}
function fromHex(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (item) => Number.parseInt(item, 16))
}
function toHex(value: Uint8Array) {
  return Array.from(value, (item) => item.toString(16).padStart(2, '0')).join('')
}
