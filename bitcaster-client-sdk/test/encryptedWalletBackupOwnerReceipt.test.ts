import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'
import {
  createEncryptedWalletBackupOwnerCurrentHead,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
  collectEncryptedWalletBackupOwnerDescriptorPages,
  encodeEncryptedWalletBackupOwnerCurrentHead,
} from '../src/encryptedWalletBackupOwnerHead.ts'
import {
  prepareEncryptedWalletBackupOwnerBundleSupersessionMutation,
  verifyEncryptedWalletBackupOwnerBundleSupersessionMutation,
} from '../src/encryptedWalletBackupOwnerMutation.ts'
import {
  issueEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt,
  digestEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  issueEncryptedWalletBackupOwnerBackupReachabilityEvidence,
  requireEncryptedWalletBackupOwnerBackupReachabilityEvidence,
} from '../src/encryptedWalletBackupOwnerReceipt.ts'
import {
  requireEncryptedWalletBackupV2VerifiedBundleSupersessionReceipt,
  requireEncryptedWalletBackupV2BackupReachabilityEvidence,
} from '../src/encryptedWalletBackupV2Receipt.ts'
import {
  encodeEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  decodeEncryptedWalletBackupOwnerBundleSupersessionReceiptWire,
} from '../src/encryptedWalletBackupOwnerServiceCodec.ts'
import { applyEncryptedWalletBackupOwnerVerifiedReceipt } from '../src/encryptedWalletBackupOwnerSync.ts'
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/backup-owner/receipt-vectors.json', import.meta.url), 'utf8'),
)
const durable = JSON.parse(
  readFileSync(new URL('./fixtures/backup-owner/durable-vectors.json', import.meta.url), 'utf8'),
)
const bytes = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const id = (n: number, length: number) => n.toString(16).padStart(length * 2, '0')
const descriptor = {
  formatVersion: 2 as const,
  realm: durable.realm,
  walletId: durable.walletId,
  bundleId: id(1, 16),
  assetLocator: id(17, 32),
  declaredAmount: 1n,
  custodyRevision: 1n,
  payloadCommitment: id(33, 32),
  objects: [{ objectId: id(49, 16), digest: id(65, 32) }],
}
const scope = (ownerScopeId = fixture.a.owner) => ({
  ownerScopeId,
  realm: durable.realm,
  walletId: durable.walletId,
  enrollmentEpoch: 1,
})
const pins = [{ keyId: fixture.signingKeyId, publicKey: fixture.signingPublicKey }]
const signDigest = (digest: Uint8Array) =>
  schnorr.sign(digest, new Uint8Array(32).fill(0x33), new Uint8Array(32).fill(0x55))
function collected(
  context = scope(),
  bundles: readonly (typeof descriptor)[] = [],
  headVersion = 0,
) {
  const head = createEncryptedWalletBackupOwnerCurrentHead({ ...context, bundles, headVersion })
  return collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({ head, bundles }),
    context,
  )
}
async function setup(owner = fixture.a.owner, random = 0x11) {
  const context = scope(owner),
    head = collected(context),
    keyHandle = await createEncryptedWalletBackupV2KeyHandle({
      seed: Uint8Array.from({ length: 64 }, (_, i) => i),
      realm: durable.realm,
      runtime: webcrypto,
    })
  const envelope = await prepareEncryptedWalletBackupOwnerBundleSupersessionMutation({
    keyHandle,
    expectedContext: context,
    expectedHeadEvidence: head,
    addedBundle: descriptor,
    supersededBundleIds: [],
    runtime: {
      getRandomValues: (target) => {
        target.fill(random)
        return target
      },
    },
  })
  const mutation = verifyEncryptedWalletBackupOwnerBundleSupersessionMutation({
    envelope,
    expectedContext: context,
    expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
  })
  const result = collected(context, [descriptor], 1)
  const receipt = await issueEncryptedWalletBackupOwnerBundleSupersessionReceipt({
    mutationEvidence: mutation,
    expectedContext: context,
    resultHead: result.head,
    signingKeyId: fixture.signingKeyId,
    signingPublicKey: fixture.signingPublicKey,
    signDigest,
  })
  const receiptEvidence = verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
    receipt,
    mutationEvidence: mutation,
    expectedContext: context,
    pinnedSigningKeys: pins,
  })
  return { context, head, mutation, result, receipt, receiptEvidence }
}

test('owner receipt signature and full canonical wire match independent vectors, then produce exact result and scoped reachability', async () => {
  for (const vector of [fixture.a, fixture.b]) {
    const f = await setup(vector.owner)
    assert.equal(
      digestEncryptedWalletBackupOwnerBundleSupersessionReceipt(f.receipt),
      vector.digest,
    )
    assert.equal(f.receipt.signature, vector.signature)
    assert.equal(
      hex(encodeEncryptedWalletBackupOwnerBundleSupersessionReceipt(f.receipt)),
      vector.wire,
    )
    assert.deepEqual(
      decodeEncryptedWalletBackupOwnerBundleSupersessionReceiptWire(bytes(vector.wire)),
      f.receipt,
    )
    assert.equal(
      hex(encodeEncryptedWalletBackupOwnerCurrentHead(f.receipt.resultHead)),
      vector.resultHead,
    )
    const result = applyEncryptedWalletBackupOwnerVerifiedReceipt({
      expectedContext: f.context,
      expectedHeadEvidence: f.head,
      mutationEvidence: f.mutation,
      receiptEvidence: f.receiptEvidence,
    })
    assert.deepEqual(result, f.result)
    const reachability = issueEncryptedWalletBackupOwnerBackupReachabilityEvidence({
      expectedContext: f.context,
      receiptEvidence: f.receiptEvidence,
      collectedHeadEvidence: result,
    })
    assert.deepEqual(reachability, { context: f.context, bundle: descriptor })
    assert.equal(
      requireEncryptedWalletBackupOwnerBackupReachabilityEvidence(reachability, f.context),
      reachability,
    )
    assert.ok(Object.isFrozen(reachability.context))
    assert.ok(Object.isFrozen(reachability.bundle.objects))
  }
  assert.notEqual(fixture.a.digest, fixture.b.digest)
})

test('identical descriptors and same wallet cannot substitute owners at receipt, head, reachability or consumption', async () => {
  const a = await setup(),
    b = await setup(fixture.b.owner)
  const verify = (
    receipt: unknown,
    mutationEvidence: unknown = a.mutation,
    expectedContext = a.context,
  ) =>
    verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
      receipt,
      mutationEvidence,
      expectedContext,
      pinnedSigningKeys: pins,
    })
  assert.throws(() => verify(a.receipt, b.mutation, b.context))
  assert.throws(() =>
    verify({ ...a.receipt, ownerScopeId: b.context.ownerScopeId }, b.mutation, b.context),
  )
  assert.throws(() => verify({ ...a.receipt, resultHead: b.result.head }))
  assert.throws(
    () =>
      requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt(
        a.receiptEvidence,
        b.context,
      ),
    /context/,
  )
  assert.throws(
    () =>
      applyEncryptedWalletBackupOwnerVerifiedReceipt({
        expectedContext: b.context,
        expectedHeadEvidence: a.head,
        mutationEvidence: a.mutation,
        receiptEvidence: a.receiptEvidence,
      }),
    /context/,
  )
  assert.throws(
    () =>
      issueEncryptedWalletBackupOwnerBackupReachabilityEvidence({
        expectedContext: a.context,
        receiptEvidence: a.receiptEvidence,
        collectedHeadEvidence: b.result,
      }),
    /context/,
  )
  const reachable = issueEncryptedWalletBackupOwnerBackupReachabilityEvidence({
    expectedContext: a.context,
    receiptEvidence: a.receiptEvidence,
    collectedHeadEvidence: a.result,
  })
  assert.throws(
    () => requireEncryptedWalletBackupOwnerBackupReachabilityEvidence(reachable, b.context),
    /context/,
  )
  for (const changed of [
    { enrollmentEpoch: 2 },
    { realm: 'backup.other' },
    { walletId: '11'.repeat(32) },
  ])
    assert.throws(
      () =>
        requireEncryptedWalletBackupOwnerBackupReachabilityEvidence(reachable, {
          ...a.context,
          ...changed,
        }),
      /context/,
    )
  assert.throws(
    () => requireEncryptedWalletBackupOwnerBackupReachabilityEvidence({ ...reachable }, a.context),
    /evidence/,
  )
  assert.throws(
    () => requireEncryptedWalletBackupV2BackupReachabilityEvidence(reachable),
    /evidence/,
  )
  assert.throws(
    () =>
      requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt(
        { ...a.receiptEvidence },
        a.context,
      ),
    /receipt/,
  )
  assert.throws(
    () => requireEncryptedWalletBackupV2VerifiedBundleSupersessionReceipt(a.receiptEvidence),
    /receipt/,
  )
  assert.throws(() => verify(a.receipt, { ...a.mutation }), /mutation/)
})

test('two genuine same-owner mutations with identical result descriptors cannot exchange receipts', async () => {
  const first = await setup(),
    second = await setup(fixture.a.owner, 0x22)
  assert.deepEqual(first.result.head, second.result.head)
  assert.notEqual(first.receipt.requestDigest, second.receipt.requestDigest)
  assert.throws(
    () =>
      applyEncryptedWalletBackupOwnerVerifiedReceipt({
        expectedContext: first.context,
        expectedHeadEvidence: first.head,
        mutationEvidence: second.mutation,
        receiptEvidence: first.receiptEvidence,
      }),
    /mutation binding/,
  )
  assert.throws(
    () =>
      verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
        receipt: first.receipt,
        mutationEvidence: second.mutation,
        expectedContext: first.context,
        pinnedSigningKeys: pins,
      }),
    /mutation binding/,
  )
  const wrongHead = collected(first.context, [], 1)
  assert.throws(
    () =>
      applyEncryptedWalletBackupOwnerVerifiedReceipt({
        expectedContext: first.context,
        expectedHeadEvidence: wrongHead,
        mutationEvidence: first.mutation,
        receiptEvidence: first.receiptEvidence,
      }),
    /predecessor/,
  )
})

test('receipt verification rejects signature, pin, version, object and result substitution; malformed wire is bounded', async () => {
  const f = await setup()
  const verify = (receipt: unknown, pinnedSigningKeys = pins) =>
    verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
      receipt,
      mutationEvidence: f.mutation,
      expectedContext: f.context,
      pinnedSigningKeys,
    })
  for (const changed of [
    { formatVersion: 2 },
    { signature: '00'.repeat(64) },
    { requestDigest: '00'.repeat(32) },
    { bundleDescriptorDigest: '00'.repeat(32) },
    { finalizedObjects: [] },
    { resultHead: { ...f.result.head, headVersion: 2 } },
  ])
    assert.throws(() => verify({ ...f.receipt, ...changed }))
  assert.throws(() => verify(f.receipt, []))
  assert.throws(() => verify(f.receipt, [...pins, ...pins]))
  const old = bytes(fixture.a.wire)
  old[1] = 2
  assert.throws(() => decodeEncryptedWalletBackupOwnerBundleSupersessionReceiptWire(old))
  assert.throws(() =>
    decodeEncryptedWalletBackupOwnerBundleSupersessionReceiptWire(new Uint8Array(65537)),
  )
  await assert.rejects(
    issueEncryptedWalletBackupOwnerBundleSupersessionReceipt({
      mutationEvidence: f.mutation,
      expectedContext: f.context,
      resultHead: f.result.head,
      signingKeyId: fixture.signingKeyId,
      signingPublicKey: fixture.signingPublicKey,
      signDigest: () => new Uint8Array(64),
    }),
    /signer/,
  )
})

test('removal receipts cannot issue backup reachability and independently signed false result heads cannot pass application', async () => {
  const f = await setup()
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: Uint8Array.from({ length: 64 }, (_, i) => i),
    realm: durable.realm,
    runtime: webcrypto,
  })
  const envelope = await prepareEncryptedWalletBackupOwnerBundleSupersessionMutation({
    keyHandle,
    expectedContext: f.context,
    expectedHeadEvidence: f.result,
    addedBundle: null,
    supersededBundleIds: [descriptor.bundleId],
    runtime: {
      getRandomValues: (target) => {
        target.fill(0x22)
        return target
      },
    },
  })
  const mutation = verifyEncryptedWalletBackupOwnerBundleSupersessionMutation({
    envelope,
    expectedContext: f.context,
    expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
  })
  const result = collected(f.context, [], 2)
  const receipt = await issueEncryptedWalletBackupOwnerBundleSupersessionReceipt({
    mutationEvidence: mutation,
    expectedContext: f.context,
    resultHead: result.head,
    signingKeyId: fixture.signingKeyId,
    signingPublicKey: fixture.signingPublicKey,
    signDigest,
  })
  const receiptEvidence = verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
    receipt,
    mutationEvidence: mutation,
    expectedContext: f.context,
    pinnedSigningKeys: pins,
  })
  assert.deepEqual(
    applyEncryptedWalletBackupOwnerVerifiedReceipt({
      expectedContext: f.context,
      expectedHeadEvidence: f.result,
      mutationEvidence: mutation,
      receiptEvidence,
    }),
    result,
  )
  assert.throws(
    () =>
      issueEncryptedWalletBackupOwnerBackupReachabilityEvidence({
        expectedContext: f.context,
        receiptEvidence,
        collectedHeadEvidence: result,
      }),
    /does not add/,
  )
  // A trusted signature does not bypass complete result-head reconstruction.
  const bad = await issueEncryptedWalletBackupOwnerBundleSupersessionReceipt({
    mutationEvidence: f.mutation,
    expectedContext: f.context,
    resultHead: { ...f.result.head, activeSetDigest: '00'.repeat(32) },
    signingKeyId: fixture.signingKeyId,
    signingPublicKey: fixture.signingPublicKey,
    signDigest,
  })
  const badEvidence = verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
    receipt: bad,
    mutationEvidence: f.mutation,
    expectedContext: f.context,
    pinnedSigningKeys: pins,
  })
  assert.throws(
    () =>
      applyEncryptedWalletBackupOwnerVerifiedReceipt({
        expectedContext: f.context,
        expectedHeadEvidence: f.head,
        mutationEvidence: f.mutation,
        receiptEvidence: badEvidence,
      }),
    /result evidence/,
  )
  assert.throws(
    () =>
      issueEncryptedWalletBackupOwnerBackupReachabilityEvidence({
        expectedContext: f.context,
        receiptEvidence: badEvidence,
        collectedHeadEvidence: f.result,
      }),
    /reachability head/,
  )
})

test('reachability snapshots selected owner before consuming caller accessors', async () => {
  const f = await setup()
  let reads = 0
  const reachability = issueEncryptedWalletBackupOwnerBackupReachabilityEvidence({
    receiptEvidence: f.receiptEvidence,
    collectedHeadEvidence: f.result,
    get expectedContext() {
      reads += 1
      return reads < 3 ? f.context : scope(fixture.b.owner)
    },
  })
  assert.deepEqual(reachability.context, f.context)
  assert.throws(
    () =>
      requireEncryptedWalletBackupOwnerBackupReachabilityEvidence(
        reachability,
        scope(fixture.b.owner),
      ),
    /context/,
  )
})
