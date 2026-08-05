import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2CurrentHead,
  enumerateEncryptedWalletBackupV2DescriptorPages,
} from '../src/encryptedWalletBackupV2Head.ts'
import { digestEncryptedWalletBackupV2BundleDescriptor } from '../src/encryptedWalletBackupV2Descriptor.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'
import {
  prepareEncryptedWalletBackupV2BundleSupersessionMutation,
  verifyEncryptedWalletBackupV2BundleSupersessionMutation,
} from '../src/encryptedWalletBackupV2Mutation.ts'
import {
  digestEncryptedWalletBackupV2BundleSupersessionReceipt,
  issueEncryptedWalletBackupV2BackupReachabilityEvidence,
  requireEncryptedWalletBackupV2BackupReachabilityEvidence,
  requireEncryptedWalletBackupV2VerifiedBundleSupersessionReceipt,
  verifyEncryptedWalletBackupV2BundleSupersessionReceipt,
} from '../src/encryptedWalletBackupV2Receipt.ts'

const vector = JSON.parse(
  await readFile(
    new URL('../../test-vectors/encrypted-wallet-backup-v2-receipt.json', import.meta.url),
    'utf8',
  ),
) as ReceiptVector

test('v2 receipt matches the shared deterministic JSON vector in Node', async () => {
  const fixture = await replacementFixture()
  assert.deepEqual(fixture.envelope, vector.expected.signedMutation)
  assert.equal(
    digestEncryptedWalletBackupV2BundleSupersessionReceipt(vector.expected.receipt),
    vector.expected.receiptDigest,
  )
  const signer = receiptSigner()
  assert.equal(
    toHex(
      schnorr.sign(
        fromHex(vector.expected.receiptDigest),
        fromHex(signer.privateKeyHex),
        fromHex(signer.auxiliaryRandomnessHex),
      ),
    ),
    vector.expected.receipt.signature,
  )
  const receiptEvidence = verifyReceipt(vector.expected.receipt, fixture.mutationEvidence)
  const collected = collectEncryptedWalletBackupV2DescriptorPages(vector.inputs.reachability.pages)
  const reachability = issueEncryptedWalletBackupV2BackupReachabilityEvidence({
    receiptEvidence,
    collectedHeadEvidence: collected,
  })
  assert.equal(reachability.bundle.bundleId, vector.inputs.mutation.addedBundle.bundleId)
})

test('v2 receipt accepts add and replace reachability, but not a removal receipt', async () => {
  const replace = await replacementFixture()
  assertReachable(
    vector.expected.receipt,
    replace.mutationEvidence,
    vector.inputs.reachability.pages,
  )
  const addition = await mutationFixture({ supersededBundleIds: [] })
  const addedHead = head([addition.addedBundle, addition.existingBundle])
  const addReceipt = signReceipt(receiptClaims(addition, addedHead))
  assertReachable(
    addReceipt,
    addition.mutationEvidence,
    pages(addedHead, [addition.existingBundle, addition.addedBundle]),
  )
  const removal = await mutationFixture({
    addedBundle: null,
    supersededBundleIds: [vector.inputs.mutation.existingBundle.bundleId],
  })
  const emptyHead = head([])
  const removalReceipt = signReceipt(receiptClaims(removal, emptyHead))
  const evidence = verifyReceipt(removalReceipt, removal.mutationEvidence)
  assert.throws(
    () =>
      issueEncryptedWalletBackupV2BackupReachabilityEvidence({
        receiptEvidence: evidence,
        collectedHeadEvidence: collectEncryptedWalletBackupV2DescriptorPages(pages(emptyHead, [])),
      }),
    /does not add a bundle/,
  )
})

test('v2 receipt accepts one or two pinned keys and supports signing-key rotation', async () => {
  const fixture = await replacementFixture()
  verifyReceipt(vector.expected.receipt, fixture.mutationEvidence)
  const alternate = signer('05', '06', '55')
  const rotated = signReceipt(receiptClaims(fixture, vector.inputs.reachability.head), alternate)
  for (const pins of [[alternate.pin], [receiptSigner().pin, alternate.pin]])
    assert.equal(
      verifyReceipt(rotated, fixture.mutationEvidence, pins).receipt.signingKeyId,
      alternate.pin.keyId,
    )
})

test('v2 receipt rejects invalid receipt signing-key pins', async () => {
  const fixture = await replacementFixture()
  const pin = receiptSigner().pin
  const alternate = signer('05', '06', '55').pin
  const cases: readonly unknown[] = [
    [],
    [pin, alternate, signer('07', '08', '66').pin],
    [pin, { ...alternate, keyId: pin.keyId }],
    [pin, { ...alternate, publicKey: pin.publicKey }],
    [{ ...pin, publicKey: '00'.repeat(32) }],
    [{ ...pin, keyId: 'aa'.repeat(16) }],
    [{ ...pin, unexpected: true }],
  ]
  for (const pinnedSigningKeys of cases)
    assert.throws(
      () => verifyReceipt(vector.expected.receipt, fixture.mutationEvidence, pinnedSigningKeys),
      /receipt/,
    )
})

test('v2 receipt binds every mutation claim and its result-head scope', async () => {
  const fixture = await replacementFixture()
  const receipt = vector.expected.receipt
  const bindingCases: readonly Record<string, unknown>[] = [
    { realm: 'backup.staging' },
    { vaultId: '11'.repeat(32) },
    { enrollmentEpoch: 8 },
    { requestAuthPublicKey: signer('05', '06', '55').pin.publicKey },
    { mutationId: '12'.repeat(16) },
    { requestDigest: '13'.repeat(32) },
    { previousHeadVersion: 4 },
    { previousActiveSetDigest: '14'.repeat(32) },
    { supersededBundleIds: [] },
  ]
  for (const change of bindingCases)
    assert.throws(
      () => verifyReceipt(signReceipt({ ...receipt, ...change }), fixture.mutationEvidence),
      /mutation binding/,
    )
  for (const resultHead of [
    { ...receipt.resultHead, realm: 'backup.staging' },
    { ...receipt.resultHead, vaultId: '11'.repeat(32) },
    { ...receipt.resultHead, enrollmentEpoch: 8 },
    { ...receipt.resultHead, headVersion: 5 },
  ])
    assert.throws(
      () => verifyReceipt(signReceipt({ ...receipt, resultHead }), fixture.mutationEvidence),
      /result head/,
    )
})

test('v2 receipt enforces nullable addition mode and finalized objects', async () => {
  const removal = await mutationFixture({
    addedBundle: null,
    supersededBundleIds: [vector.inputs.mutation.existingBundle.bundleId],
  })
  const empty = head([])
  const validRemoval = receiptClaims(removal, empty)
  verifyReceipt(signReceipt(validRemoval), removal.mutationEvidence)
  for (const change of [
    { bundleId: '17'.repeat(16) },
    { bundleDescriptorDigest: '18'.repeat(32) },
    { finalizedObjects: [vector.inputs.mutation.addedBundle.objects[0]!] },
  ])
    assert.throws(
      () => verifyReceipt(signReceipt({ ...validRemoval, ...change }), removal.mutationEvidence),
      /removal receipt/,
    )
  const addition = await mutationFixture({
    addedBundle: vector.inputs.mutation.addedBundle,
    supersededBundleIds: [],
  })
  const result = head([addition.addedBundle])
  const valid = receiptClaims(addition, result)
  verifyReceipt(signReceipt(valid), addition.mutationEvidence)
  for (const change of [
    { bundleId: null, bundleDescriptorDigest: valid.bundleDescriptorDigest },
    { bundleId: valid.bundleId, bundleDescriptorDigest: null },
    { finalizedObjects: [] },
    { finalizedObjects: [{ ...valid.finalizedObjects[0]!, digest: '15'.repeat(32) }] },
    { finalizedObjects: [valid.finalizedObjects[0]!, valid.finalizedObjects[0]!] },
    { finalizedObjects: Array.from({ length: 16 }, () => valid.finalizedObjects[0]!) },
  ])
    assert.throws(
      () => verifyReceipt(signReceipt({ ...valid, ...change }), addition.mutationEvidence),
      /(addition receipt|receipt objects)/,
    )
})

test('v2 receipt enforces finalized-object order and supersession order', async () => {
  const twoObjects = {
    ...vector.inputs.mutation.addedBundle,
    objects: [
      ...vector.inputs.mutation.addedBundle.objects,
      {
        objectId: '00000000000000000000000000000033',
        digest: '0000000000000000000000000000000000000000000000000000000000000043',
      },
    ],
  }
  const addition = await mutationFixture({ addedBundle: twoObjects, supersededBundleIds: [] })
  const valid = receiptClaims(addition, head([twoObjects]))
  assert.throws(
    () =>
      verifyReceipt(
        signReceipt({ ...valid, finalizedObjects: [...valid.finalizedObjects].reverse() }),
        addition.mutationEvidence,
      ),
    /addition receipt/,
  )
  const replace = await replacementFixture()
  for (const supersededBundleIds of [
    [],
    [
      vector.inputs.mutation.existingBundle.bundleId,
      vector.inputs.mutation.existingBundle.bundleId,
    ],
    ['ff'.repeat(16), vector.inputs.mutation.existingBundle.bundleId],
  ])
    assert.throws(
      () =>
        verifyReceipt(
          signReceipt({ ...vector.expected.receipt, supersededBundleIds }),
          replace.mutationEvidence,
        ),
      /receipt (mutation binding|superseded bundles)/,
    )
})

test('v2 receipt rejects signature, digest, and unknown receipt fields', async () => {
  const fixture = await replacementFixture()
  assert.throws(
    () =>
      verifyReceipt(
        { ...vector.expected.receipt, signature: 'ff'.repeat(64) },
        fixture.mutationEvidence,
      ),
    /signature/,
  )
  assert.throws(
    () =>
      verifyReceipt(
        signReceipt({ ...vector.expected.receipt, requestDigest: 'ff'.repeat(32) }),
        fixture.mutationEvidence,
      ),
    /mutation binding/,
  )
  assert.throws(
    () =>
      digestEncryptedWalletBackupV2BundleSupersessionReceipt({
        ...vector.expected.receipt,
        extra: true,
      }),
    /receipt is invalid/,
  )
  assert.throws(
    () => verifyReceipt({ ...vector.expected.receipt, extra: true }, fixture.mutationEvidence),
    /receipt is invalid/,
  )
})

test('v2 receipt snapshots accessors and detaches frozen evidence', async () => {
  const fixture = await replacementFixture()
  const receipt = accessorReceipt(vector.expected.receipt)
  const evidence = verifyReceipt(receipt.value, fixture.mutationEvidence)
  assert.equal(receipt.reads(), 17)
  assert.equal(Object.isFrozen(evidence), true)
  assert.equal(Object.isFrozen(evidence.receipt), true)
  assert.equal(Object.isFrozen(evidence.receipt.finalizedObjects), true)
  receipt.source.realm = 'backup.staging'
  assert.equal(evidence.receipt.realm, vector.expected.receipt.realm)
  assert.throws(
    () => requireEncryptedWalletBackupV2VerifiedBundleSupersessionReceipt({ ...evidence }),
    /verified receipt/,
  )
  assert.throws(
    () =>
      requireEncryptedWalletBackupV2VerifiedBundleSupersessionReceipt(structuredClone(evidence)),
    /verified receipt/,
  )
  const reachability = assertReachable(
    vector.expected.receipt,
    fixture.mutationEvidence,
    vector.inputs.reachability.pages,
  )
  assert.equal(Object.isFrozen(reachability), true)
  assert.equal(Object.isFrozen(reachability.bundle), true)
  assert.throws(
    () => requireEncryptedWalletBackupV2BackupReachabilityEvidence({ ...reachability }),
    /reachability evidence/,
  )
  assert.throws(
    () => requireEncryptedWalletBackupV2BackupReachabilityEvidence(structuredClone(reachability)),
    /reachability evidence/,
  )
})

test('v2 receipt reachability rejects a current-head mismatch', async () => {
  const fixture = await replacementFixture()
  const receiptEvidence = verifyReceipt(vector.expected.receipt, fixture.mutationEvidence)
  rejectReachability(
    receiptEvidence,
    pages(vector.inputs.mutation.initialHead, [vector.inputs.mutation.existingBundle]),
    /head/,
  )
})

test('v2 receipt reachability rejects a missing bundle', async () => {
  const fixture = await replacementFixture()
  const missing = {
    ...vector.inputs.mutation.addedBundle,
    bundleId: '00000000000000000000000000000003',
  }
  const missingHead = head([missing])
  const missingReceipt = verifyReceipt(
    signReceipt({ ...vector.expected.receipt, resultHead: missingHead }),
    fixture.mutationEvidence,
  )
  rejectReachability(missingReceipt, pages(missingHead, [missing]), /bundle/)
})

test('v2 receipt reachability rejects a wrong descriptor', async () => {
  const fixture = await replacementFixture()
  const wrong = { ...vector.inputs.mutation.addedBundle, payloadCommitment: '16'.repeat(32) }
  const wrongHead = head([wrong])
  const wrongReceipt = verifyReceipt(
    signReceipt({ ...vector.expected.receipt, resultHead: wrongHead }),
    fixture.mutationEvidence,
  )
  rejectReachability(wrongReceipt, pages(wrongHead, [wrong]), /bundle/)
})

test('v2 receipt reachability rejects an active superseded bundle', async () => {
  const fixture = await replacementFixture()
  const activeHead = head([
    vector.inputs.mutation.existingBundle,
    vector.inputs.mutation.addedBundle,
  ])
  const activeReceipt = verifyReceipt(
    signReceipt({ ...vector.expected.receipt, resultHead: activeHead }),
    fixture.mutationEvidence,
  )
  rejectReachability(
    activeReceipt,
    pages(activeHead, [vector.inputs.mutation.existingBundle, vector.inputs.mutation.addedBundle]),
    /superseded bundle is active/,
  )
})

function rejectReachability(receiptEvidence: unknown, pageValues: unknown, error: RegExp) {
  assert.throws(
    () =>
      issueEncryptedWalletBackupV2BackupReachabilityEvidence({
        receiptEvidence,
        collectedHeadEvidence: collectEncryptedWalletBackupV2DescriptorPages(pageValues),
      }),
    error,
  )
}

async function replacementFixture() {
  return mutationFixture({ supersededBundleIds: [vector.inputs.mutation.existingBundle.bundleId] })
}

async function mutationFixture(options: {
  readonly addedBundle?: Bundle | null
  readonly supersededBundleIds: readonly string[]
}) {
  const input = vector.inputs.mutation
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: fromHex(input.seedHex),
    realm: input.initialHead.realm,
    runtime: webcrypto,
  })
  const envelope = await prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle,
    expectedHead: input.initialHead,
    addedBundle: options.addedBundle === undefined ? input.addedBundle : options.addedBundle,
    supersededBundleIds: options.supersededBundleIds,
    runtime: random([input.mutationIdHex, input.auxiliaryRandomnessHex]),
  })
  const mutationEvidence = verifyEncryptedWalletBackupV2BundleSupersessionMutation({
    envelope,
    expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
    expectedContext: scope(input.initialHead),
  })
  return {
    envelope,
    mutationEvidence,
    existingBundle: input.existingBundle,
    addedBundle: envelope.mutation.addedBundle!,
  }
}

function receiptClaims(
  fixture: Awaited<ReturnType<typeof mutationFixture>>,
  resultHead: Head,
): Receipt {
  const added = fixture.envelope.mutation.addedBundle
  return {
    ...vector.expected.receipt,
    realm: fixture.envelope.mutation.realm,
    vaultId: fixture.envelope.mutation.vaultId,
    enrollmentEpoch: fixture.envelope.mutation.enrollmentEpoch,
    requestAuthPublicKey: fixture.envelope.requestAuthPublicKey,
    mutationId: fixture.envelope.mutation.mutationId,
    requestDigest: fixture.envelope.requestDigest,
    previousHeadVersion: fixture.envelope.mutation.expectedHeadVersion,
    previousActiveSetDigest: fixture.envelope.mutation.expectedActiveSetDigest,
    resultHead,
    bundleId: added?.bundleId ?? null,
    bundleDescriptorDigest: added === null ? null : digestDescriptor(added),
    finalizedObjects: added?.objects ?? [],
    supersededBundleIds: fixture.envelope.mutation.supersededBundleIds,
    signingKeyId: receiptSigner().pin.keyId,
    signature: '00'.repeat(64),
  }
}

function signReceipt(claims: Receipt, value = receiptSigner()): Receipt {
  const unsigned = { ...claims, signingKeyId: value.pin.keyId, signature: '00'.repeat(64) }
  return {
    ...unsigned,
    signature: toHex(
      schnorr.sign(
        fromHex(digestEncryptedWalletBackupV2BundleSupersessionReceipt(unsigned)),
        fromHex(value.privateKeyHex),
        fromHex(value.auxiliaryRandomnessHex),
      ),
    ),
  }
}

function verifyReceipt(
  receipt: unknown,
  mutationEvidence: unknown,
  pinnedSigningKeys: unknown = [receiptSigner().pin],
) {
  return verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
    receipt,
    mutationEvidence,
    pinnedSigningKeys: pinnedSigningKeys as readonly {
      readonly keyId: string
      readonly publicKey: string
    }[],
  })
}

function assertReachable(receipt: Receipt, mutationEvidence: unknown, pageValues: unknown) {
  return issueEncryptedWalletBackupV2BackupReachabilityEvidence({
    receiptEvidence: verifyReceipt(receipt, mutationEvidence),
    collectedHeadEvidence: collectEncryptedWalletBackupV2DescriptorPages(pageValues),
  })
}

function head(bundles: readonly Bundle[]) {
  const initial = vector.inputs.mutation.initialHead
  return createEncryptedWalletBackupV2CurrentHead({
    ...scope(initial),
    headVersion: initial.headVersion + 1,
    bundles: [...bundles].sort((left, right) => left.bundleId.localeCompare(right.bundleId)),
  })
}
function pages(value: Head, bundles: readonly Bundle[]) {
  return enumerateEncryptedWalletBackupV2DescriptorPages({
    head: value,
    bundles: [...bundles].sort((left, right) => left.bundleId.localeCompare(right.bundleId)),
  })
}
function scope(value: Head) {
  return { realm: value.realm, vaultId: value.vaultId, enrollmentEpoch: value.enrollmentEpoch }
}
function digestDescriptor(value: Bundle) {
  return digestEncryptedWalletBackupV2BundleDescriptor(value)
}
function receiptSigner() {
  const value = vector.inputs.receiptSigner
  return {
    privateKeyHex: value.privateKeyHex,
    auxiliaryRandomnessHex: value.auxiliaryRandomnessHex,
    pin: { keyId: value.keyId, publicKey: value.publicKey },
  }
}
function signer(privateByte: string, auxiliaryByte: string, keyByte: string) {
  const privateKeyHex = privateByte.repeat(32)
  return {
    privateKeyHex,
    auxiliaryRandomnessHex: auxiliaryByte.repeat(32),
    pin: {
      keyId: keyByte.repeat(16),
      publicKey: toHex(schnorr.getPublicKey(fromHex(privateKeyHex))),
    },
  }
}
function random(values: readonly string[]) {
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
function accessorReceipt(receipt: Receipt) {
  let count = 0
  const source = structuredClone(receipt)
  const value = Object.defineProperties(
    {},
    Object.fromEntries(
      Object.entries(source).map(([key, field]) => [
        key,
        {
          enumerable: true,
          get: () => {
            count += 1
            return field
          },
        },
      ]),
    ),
  ) as Receipt
  return { value, source, reads: () => count }
}
function fromHex(value: string) {
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  )
}
function toHex(value: Uint8Array) {
  return Array.from(value, (item) => item.toString(16).padStart(2, '0')).join('')
}

type ObjectReference = { readonly objectId: string; readonly digest: string }
type Bundle = {
  readonly formatVersion: 2
  readonly realm: string
  readonly vaultId: string
  readonly bundleId: string
  readonly operationLocator: string
  readonly assetLocators: readonly string[]
  readonly payloadCommitment: string
  readonly objects: readonly ObjectReference[]
}
type Head = {
  readonly formatVersion: 2
  readonly realm: string
  readonly vaultId: string
  readonly enrollmentEpoch: number
  readonly headVersion: number
  readonly activeBundleCount: number
  readonly activeObjectCount: number
  readonly activeSetDigest: string
}
type Receipt = {
  readonly formatVersion: 2
  readonly kind: 'bundle-supersession-receipt'
  readonly realm: string
  readonly vaultId: string
  readonly enrollmentEpoch: number
  readonly requestAuthPublicKey: string
  readonly mutationId: string
  readonly requestDigest: string
  readonly previousHeadVersion: number
  readonly previousActiveSetDigest: string
  readonly resultHead: Head
  readonly bundleId: string | null
  readonly bundleDescriptorDigest: string | null
  readonly finalizedObjects: readonly ObjectReference[]
  readonly supersededBundleIds: readonly string[]
  readonly signingKeyId: string
  readonly signature: string
}
type ReceiptVector = {
  readonly inputs: {
    readonly mutation: {
      readonly seedHex: string
      readonly mutationIdHex: string
      readonly auxiliaryRandomnessHex: string
      readonly initialHead: Head
      readonly existingBundle: Bundle
      readonly addedBundle: Bundle
    }
    readonly receiptSigner: {
      readonly privateKeyHex: string
      readonly auxiliaryRandomnessHex: string
      readonly keyId: string
      readonly publicKey: string
    }
    readonly reachability: { readonly head: Head; readonly pages: unknown }
  }
  readonly expected: {
    readonly signedMutation: unknown
    readonly receiptDigest: string
    readonly receipt: Receipt
  }
}
