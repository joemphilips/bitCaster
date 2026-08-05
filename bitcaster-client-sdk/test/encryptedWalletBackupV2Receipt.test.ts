import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2CurrentHead,
  enumerateEncryptedWalletBackupV2DescriptorPages,
} from '../src/encryptedWalletBackupV2Head.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'
import {
  prepareEncryptedWalletBackupV2BundleSupersessionMutation,
  verifyEncryptedWalletBackupV2BundleSupersessionMutation,
} from '../src/encryptedWalletBackupV2Mutation.ts'
import {
  issueEncryptedWalletBackupV2BackupReachabilityEvidence,
  issueEncryptedWalletBackupV2BundleSupersessionReceipt,
  verifyEncryptedWalletBackupV2BundleSupersessionReceipt,
} from '../src/encryptedWalletBackupV2Receipt.ts'

const SEED = Uint8Array.from({ length: 64 }, (_value, index) => index)
const SIGNER = '03'.repeat(32)
const KEY_ID = '55'.repeat(16)

test('v2 receipt binds the same-asset replacement and finalized objects', async () => {
  const fixture = await replacementFixture()
  const receipt = await issueReceipt(fixture)
  const verified = verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
    receipt,
    mutationEvidence: fixture.mutationEvidence,
    pinnedSigningKeys: [pin()],
  })
  assert.equal(verified.receipt.bundleId, fixture.added.bundleId)
  assert.equal(verified.receipt.bundleDescriptorDigest?.length, 64)
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head: fixture.resultHead,
    bundles: [fixture.added],
  })
  const evidence = issueEncryptedWalletBackupV2BackupReachabilityEvidence({
    receiptEvidence: verified,
    collectedHeadEvidence: collectEncryptedWalletBackupV2DescriptorPages(pages),
  })
  assert.equal(evidence.bundle.custodyRevision, 2n)
  assert.equal(evidence.bundle.declaredAmount, 17n)
})

test('v2 receipt rejects mismatched result metadata and active predecessors', async () => {
  const fixture = await replacementFixture()
  const receipt = await issueReceipt(fixture)
  const verified = verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
    receipt,
    mutationEvidence: fixture.mutationEvidence,
    pinnedSigningKeys: [pin()],
  })
  const mismatchedHead = createEncryptedWalletBackupV2CurrentHead({
    realm: fixture.resultHead.realm,
    vaultId: fixture.resultHead.vaultId,
    enrollmentEpoch: fixture.resultHead.enrollmentEpoch,
    headVersion: fixture.resultHead.headVersion,
    bundles: [fixture.existing],
  })
  assert.throws(
    () =>
      issueEncryptedWalletBackupV2BackupReachabilityEvidence({
        receiptEvidence: verified,
        collectedHeadEvidence: collectEncryptedWalletBackupV2DescriptorPages(
          enumerateEncryptedWalletBackupV2DescriptorPages({
            head: mismatchedHead,
            bundles: [fixture.existing],
          }),
        ),
      }),
    /head|bundle/,
  )
})

test('v2 receipt rejects signature and receipt-field substitution', async () => {
  const fixture = await replacementFixture()
  const receipt = await issueReceipt(fixture)
  for (const value of [
    { ...receipt, signature: '00'.repeat(64) },
    { ...receipt, bundleDescriptorDigest: '00'.repeat(32) },
    { ...receipt, unexpected: true },
  ])
    assert.throws(
      () =>
        verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
          receipt: value,
          mutationEvidence: fixture.mutationEvidence,
          pinnedSigningKeys: [pin()],
        }),
      /receipt/,
    )
})

test('v2 receipt supports add and replace reachability but rejects removals', async () => {
  const replacement = await replacementFixture()
  const addition = await mutationFixture({ mode: 'add' })
  const removal = await mutationFixture({ mode: 'remove' })
  for (const fixture of [replacement, addition]) {
    const receipt = await issueReceipt(fixture)
    const evidence = verifiedReceipt(receipt, fixture)
    const pages = enumerateEncryptedWalletBackupV2DescriptorPages({
      head: fixture.resultHead,
      bundles: fixture.resultBundles,
    })
    assert.equal(
      issueEncryptedWalletBackupV2BackupReachabilityEvidence({
        receiptEvidence: evidence,
        collectedHeadEvidence: collectEncryptedWalletBackupV2DescriptorPages(pages),
      }).bundle.bundleId,
      fixture.added!.bundleId,
    )
  }
  const receipt = await issueReceipt(removal)
  assert.throws(
    () =>
      issueEncryptedWalletBackupV2BackupReachabilityEvidence({
        receiptEvidence: verifiedReceipt(receipt, removal),
        collectedHeadEvidence: collectEncryptedWalletBackupV2DescriptorPages(
          enumerateEncryptedWalletBackupV2DescriptorPages({
            head: removal.resultHead,
            bundles: [],
          }),
        ),
      }),
    /does not add a bundle/,
  )
})

test('v2 receipt accepts pinned-key rotation and rejects invalid pins', async () => {
  const fixture = await replacementFixture()
  const rotated = await issueReceipt(fixture, alternateSigner())
  for (const pins of [[alternateSigner().pin], [pin(), alternateSigner().pin]])
    assert.equal(
      verifiedReceipt(rotated, fixture, pins).receipt.signingKeyId,
      alternateSigner().pin.keyId,
    )
  for (const pins of [
    [],
    [pin(), alternateSigner().pin, thirdSigner().pin],
    [{ ...pin(), keyId: alternateSigner().pin.keyId }],
  ])
    assert.throws(
      () =>
        verifiedReceipt(rotated, fixture, pins as readonly { keyId: string; publicKey: string }[]),
      /receipt/,
    )
})

test('v2 receipt binds every mutation claim and finalized object rule', async () => {
  const fixture = await replacementFixture()
  const receipt = await issueReceipt(fixture)
  for (const value of [
    { ...receipt, requestDigest: '00'.repeat(32) },
    { ...receipt, previousHeadVersion: receipt.previousHeadVersion + 1 },
    {
      ...receipt,
      resultHead: { ...receipt.resultHead, headVersion: receipt.resultHead.headVersion + 1 },
    },
    { ...receipt, bundleId: null },
    { ...receipt, finalizedObjects: [] },
    { ...receipt, supersededBundleIds: ['ff'.repeat(16), ...receipt.supersededBundleIds] },
  ])
    assert.throws(() => verifiedReceipt(value, fixture), /receipt/)
})

test('v2 receipt reachability rejects missing, wrong, and active predecessor bundles', async () => {
  const fixture = await replacementFixture()
  const evidence = verifiedReceipt(await issueReceipt(fixture), fixture)
  const wrong = { ...fixture.added, payloadCommitment: '00'.repeat(32) }
  const cases = [
    { head: fixture.resultHead, bundles: [] },
    {
      head: createEncryptedWalletBackupV2CurrentHead({
        ...scope(fixture.resultHead),
        headVersion: fixture.resultHead.headVersion,
        bundles: [wrong],
      }),
      bundles: [wrong],
    },
  ]
  for (const value of cases)
    assert.throws(
      () =>
        issueEncryptedWalletBackupV2BackupReachabilityEvidence({
          receiptEvidence: evidence,
          collectedHeadEvidence: collectEncryptedWalletBackupV2DescriptorPages(
            enumerateEncryptedWalletBackupV2DescriptorPages(value),
          ),
        }),
      /reachability|head authority/,
    )
  assert.throws(
    () =>
      createEncryptedWalletBackupV2CurrentHead({
        ...scope(fixture.resultHead),
        headVersion: fixture.resultHead.headVersion,
        bundles: [fixture.existing, fixture.added],
      }),
    /asset locator/,
  )
})

test('v2 receipt snapshots accessor evidence and retains frozen verified authority', async () => {
  const fixture = await replacementFixture()
  const receipt = await issueReceipt(fixture)
  let reads = 0
  const accessor = Object.defineProperties(
    {},
    Object.fromEntries(
      Object.entries(receipt).map(([key, value]) => [
        key,
        {
          enumerable: true,
          get: () => {
            reads += 1
            return value
          },
        },
      ]),
    ),
  )
  const verified = verifiedReceipt(accessor, fixture)
  assert.equal(reads, Object.keys(receipt).length)
  assert.equal(Object.isFrozen(verified), true)
  assert.equal(Object.isFrozen(verified.receipt), true)
  assert.throws(() => verifiedReceipt(structuredClone(verified), fixture), /mutation|receipt/)
})

async function replacementFixture() {
  return mutationFixture({ mode: 'replace' })
}

async function mutationFixture(input: { mode: 'add' | 'replace' | 'remove' }) {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: 'backup.production',
    runtime: webcrypto,
  })
  const existing = descriptor(keyHandle.vaultId, 1, 1n, 1n)
  const initialHead = createEncryptedWalletBackupV2CurrentHead({
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [existing],
  })
  const added =
    input.mode === 'remove'
      ? null
      : descriptor(
          keyHandle.vaultId,
          2,
          17n,
          2n,
          input.mode === 'add' ? 'bb'.repeat(32) : 'aa'.repeat(32),
        )
  const envelope = await prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle,
    expectedHeadEvidence: collectEncryptedWalletBackupV2DescriptorPages(
      enumerateEncryptedWalletBackupV2DescriptorPages({ head: initialHead, bundles: [existing] }),
    ),
    addedBundle: added,
    supersededBundleIds: input.mode === 'add' ? [] : [existing.bundleId],
    runtime: random(['11'.repeat(16), '12'.repeat(32)]),
  })
  const mutationEvidence = verifyEncryptedWalletBackupV2BundleSupersessionMutation({
    envelope,
    expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
    expectedContext: { realm: keyHandle.realm, vaultId: keyHandle.vaultId, enrollmentEpoch: 1 },
  })
  const resultBundles = input.mode === 'add' ? [existing, added!] : added === null ? [] : [added]
  const resultHead = createEncryptedWalletBackupV2CurrentHead({
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
    enrollmentEpoch: 1,
    headVersion: 2,
    bundles: resultBundles,
  })
  return { existing, added, mutationEvidence, resultHead, resultBundles }
}

async function issueReceipt(
  fixture: Awaited<ReturnType<typeof replacementFixture>>,
  signer = primarySigner(),
) {
  return issueEncryptedWalletBackupV2BundleSupersessionReceipt({
    mutationEvidence: fixture.mutationEvidence,
    resultHead: fixture.resultHead,
    signingKeyId: signer.pin.keyId,
    signingPublicKey: signer.pin.publicKey,
    signDigest: (digest) => schnorr.sign(digest, signer.privateKey),
  })
}

function verifiedReceipt(
  receipt: unknown,
  fixture: Awaited<ReturnType<typeof replacementFixture>>,
  pins = [pin()],
) {
  return verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
    receipt,
    mutationEvidence: fixture.mutationEvidence,
    pinnedSigningKeys: pins,
  })
}

function descriptor(
  vaultId: string,
  index: number,
  declaredAmount: bigint,
  custodyRevision: bigint,
  assetLocator = 'aa'.repeat(32),
) {
  return {
    formatVersion: 2 as const,
    realm: 'backup.production',
    vaultId,
    bundleId: index.toString(16).padStart(32, '0'),
    assetLocator,
    declaredAmount,
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

function pin() {
  return primarySigner().pin
}

function primarySigner() {
  return signer(SIGNER, KEY_ID)
}
function alternateSigner() {
  return signer('05'.repeat(32), '66'.repeat(16))
}
function thirdSigner() {
  return signer('07'.repeat(32), '77'.repeat(16))
}
function signer(privateKeyHex: string, keyId: string) {
  const privateKey = fromHex(privateKeyHex)
  return { privateKey, pin: { keyId, publicKey: toHex(schnorr.getPublicKey(privateKey)) } }
}

function scope(head: { realm: string; vaultId: string; enrollmentEpoch: number }) {
  return { realm: head.realm, vaultId: head.vaultId, enrollmentEpoch: head.enrollmentEpoch }
}

function random(values: readonly string[]) {
  const queue = values.map(fromHex)
  return {
    getRandomValues(target: Uint8Array) {
      const value = queue.shift()
      if (value === undefined || value.byteLength !== target.byteLength) throw new Error('random')
      target.set(value)
      return target
    },
  }
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (item) => Number.parseInt(item, 16))
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, '0')).join('')
}
