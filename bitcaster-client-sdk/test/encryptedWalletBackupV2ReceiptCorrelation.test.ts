import assert from 'node:assert/strict'
import { deriveKeysetId } from '@cashu/cashu-ts'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  createEncryptedWalletBackupV2AssetIdentity,
  decryptEncryptedWalletBackupV2ProofSetBundle,
  issueEncryptedWalletBackupV2TerminalSeal,
  prepareEncryptedWalletBackupV2ProofSetBundle,
  authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse,
  verifyEncryptedWalletBackupV2RestoredProofSet,
  type EncryptedWalletBackupV2ProofSetProof,
  type EncryptedWalletBackupV2RestoreVerificationPort,
} from '../src/encryptedWalletBackupV2ProofSet.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'
import type { EncryptedWalletBackupV2PreparedTransportBundle } from '../src/encryptedWalletBackupV2Bundle.ts'
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2CurrentHead,
  enumerateEncryptedWalletBackupV2DescriptorPages,
} from '../src/encryptedWalletBackupV2Head.ts'
import {
  prepareEncryptedWalletBackupV2BundleSupersessionMutation,
  verifyEncryptedWalletBackupV2BundleSupersessionMutation,
} from '../src/encryptedWalletBackupV2Mutation.ts'
import {
  authorizeEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof,
  issueEncryptedWalletBackupV2BundleSupersessionReceipt,
  verifyEncryptedWalletBackupV2BundleSupersessionReceipt,
  requireEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof,
} from '../src/encryptedWalletBackupV2Receipt.ts'
import {
  createDurableCustodyArtifactReference,
  createDurableProofOperationFacts,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyRecord,
} from '../src/durableCustody.ts'
import { createDurableCustodyProofOperation } from '../src/durableCustodyProofOperationRecord.ts'
import { serializeDurableCustodyProofInput } from '../src/durableCustodyProofOperation.ts'
import { deriveDurableWalletProofSecret } from '../src/durableWalletProofDerivationLocator.ts'
import type { EncryptedWalletBackupV2RemotePort } from '../src/encryptedWalletBackupV2HttpAdapter.ts'

const SEED = Uint8Array.from({ length: 64 }, (_value, index) => index)
const MINT = 'https://mint.example'
const KEYSET = deriveKeysetId(
  { '1': '02194603ffa36356f4a56b7df9371fc3192472351453ec7398b8da8117e7c3e104' },
  { unit: 'sat', versionByte: 1 },
)

test('receipt gate promotes only the exact local active proof from an authenticated sealed bundle', async () => {
  const fixture = await fixtureFor('22'.repeat(32))
  const promoted = authorizeEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof(fixture)

  assert.equal(promoted.kind, 'ctf-terminal-restore')
  assert.equal(promoted.proof.selectionAuthority, 'terminal-sealed-non-selectable')
  assert.equal(promoted.proof.terminalSeal?.code, 13015)
  assert.equal(requireEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof(promoted), promoted)
})

test('receipt gate fails closed for missing, stale, copied, and foreign correlation evidence', async () => {
  const fixture = await fixtureFor('22'.repeat(32))
  const foreign = await fixtureFor('33'.repeat(32))
  const sealedPredecessor = await fixtureFor('22'.repeat(32), { predecessorSealed: true })

  assert.throws(
    () =>
      authorizeEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof({
        ...fixture,
        receiptEvidence: undefined,
      }),
    /verified receipt/,
  )
  assert.throws(
    () =>
      authorizeEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof({
        ...fixture,
        authenticatedCurrentHeadEvidence: fixture.locallyAcceptedPredecessorEvidence,
      }),
    /current head/,
  )
  const predecessor = fixture.locallyAcceptedPredecessorEvidence.head
  const stalePredecessor = collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({
      head: createEncryptedWalletBackupV2CurrentHead({
        realm: predecessor.realm,
        walletId: predecessor.walletId,
        enrollmentEpoch: predecessor.enrollmentEpoch,
        headVersion: predecessor.headVersion - 1,
        bundles: fixture.locallyAcceptedPredecessorEvidence.bundles,
      }),
      bundles: fixture.locallyAcceptedPredecessorEvidence.bundles,
    }),
  )
  assert.throws(
    () =>
      authorizeEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof({
        ...fixture,
        locallyAcceptedPredecessorEvidence: stalePredecessor,
      }),
    /predecessor/,
  )
  assert.throws(
    () =>
      authorizeEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof({
        ...fixture,
        candidateProofSet: { ...fixture.candidateProofSet },
      }),
    /verified proof set/,
  )
  assert.throws(
    () =>
      authorizeEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof({
        ...fixture,
        predecessorProofSet: { ...fixture.predecessorProofSet },
      }),
    /decrypted proof set/,
  )
  assert.throws(
    () =>
      authorizeEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof({
        ...fixture,
        remoteTerminalSealReuseAuthority: undefined,
      }),
    /remote terminal seal authority/,
  )
  assert.throws(
    () => authorizeEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof(sealedPredecessor),
    /predecessor proof/,
  )
  assert.throws(
    () =>
      authorizeEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof({
        ...foreign,
        localActiveProof: fixture.localActiveProof,
      }),
    /predecessor|correlation/,
  )
  assert.throws(
    () =>
      authorizeEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof({
        ...fixture,
        localActiveProof: {
          ...fixture.localActiveProof,
          proofId: '00'.repeat(32),
        },
      }),
    /predecessor|correlation/,
  )
  const nestedPredecessorProof = fixture.predecessorProofSet.proofs[0]!.proof as { C: string }
  assert.equal(Object.isFrozen(nestedPredecessorProof), true)
  assert.throws(() => {
    nestedPredecessorProof.C = `02${'22'.repeat(32)}`
  }, TypeError)
  assert.throws(() => {
    let reads = 0
    Object.defineProperty(nestedPredecessorProof, 'C', {
      configurable: true,
      get: () => `02${String(reads++)}`,
    })
  }, TypeError)
  assert.doesNotThrow(() => authorizeEncryptedWalletBackupV2ReceiptCorrelatedTerminalProof(fixture))
})

async function fixtureFor(
  collectionId: string,
  options: { readonly predecessorSealed?: boolean } = {},
) {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: 'backup.production',
    runtime: { subtle: webcrypto.subtle },
  })
  const active = proof(collectionId)
  const committed = committedTerminalStore(active, `redeem:${collectionId.slice(0, 4)}`)
  const terminalSeal = await issueEncryptedWalletBackupV2TerminalSeal({
    seed: SEED,
    proof: active,
    operationId: committed.operationId,
    store: committed.store,
  })
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: 'sat',
    asset: active.asset,
  })
  const candidatePrepared = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset,
    proofs: [{ ...active, terminalSeal }],
    custodyRevision: 2n,
    counterHighWaterMarks: [{ mintUrl: MINT, unit: 'sat', keysetId: KEYSET, nextCounter: 1 }],
    runtime: webcrypto,
  })
  const remote = await authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse({
    keyHandle,
    seed: SEED,
    expectedAsset: asset,
    custodyRevision: 2n,
    expectedEnrollmentEpoch: 1,
    remote: remotePort(candidatePrepared),
    remoteRequest: {
      origin: 'https://backup.example',
      issuedAtUnixSeconds: 100,
      expiresAtUnixSeconds: 130,
      signal: new AbortController().signal,
      runtime: webcrypto,
    },
    runtime: webcrypto,
  })
  const candidateProofSet = await verifyEncryptedWalletBackupV2RestoredProofSet({
    seed: SEED,
    expectedAsset: asset,
    unverified: remote.decrypted,
    port: unavailableMint(),
  })
  const predecessorPrepared = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset,
    proofs: [options.predecessorSealed === true ? { ...active, terminalSeal } : active],
    custodyRevision: 1n,
    counterHighWaterMarks: [{ mintUrl: MINT, unit: 'sat', keysetId: KEYSET, nextCounter: 1 }],
    runtime: webcrypto,
  })
  const predecessorProofSet = await decryptEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    expectedAsset: asset,
    custodyRevision: 1n,
    runtime: webcrypto,
    ...predecessorPrepared,
  })
  const predecessorBundle = predecessorPrepared.descriptor
  const predecessorHead = createEncryptedWalletBackupV2CurrentHead({
    realm: keyHandle.realm,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 6,
    bundles: [predecessorBundle],
  })
  const locallyAcceptedPredecessorEvidence = collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({
      head: predecessorHead,
      bundles: [predecessorBundle],
    }),
  )
  const mutation = await prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle,
    expectedHeadEvidence: locallyAcceptedPredecessorEvidence,
    addedBundle: candidatePrepared.descriptor,
    supersededBundleIds: [predecessorBundle.bundleId],
    runtime: { getRandomValues: (target) => target.fill(7) },
  })
  const mutationEvidence = verifyEncryptedWalletBackupV2BundleSupersessionMutation({
    envelope: mutation,
    expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
    expectedContext: { realm: keyHandle.realm, walletId: keyHandle.walletId, enrollmentEpoch: 1 },
  })
  const currentHead = remote.currentHeadEvidence.head
  const authenticatedCurrentHeadEvidence = remote.currentHeadEvidence
  const signer = Uint8Array.from({ length: 32 }, () => 3)
  const receipt = await issueEncryptedWalletBackupV2BundleSupersessionReceipt({
    mutationEvidence,
    resultHead: currentHead,
    signingKeyId: '55'.repeat(16),
    signingPublicKey: toHex(schnorr.getPublicKey(signer)),
    signDigest: (digest) => schnorr.sign(digest, signer),
  })
  const receiptEvidence = verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
    receipt,
    mutationEvidence,
    pinnedSigningKeys: [{ keyId: '55'.repeat(16), publicKey: toHex(schnorr.getPublicKey(signer)) }],
  })
  const localActiveProof = {
    ...active,
    proofId: candidateProofSet.proofs[0]!.proofId,
  }
  return {
    mutationEvidence,
    receiptEvidence,
    locallyAcceptedPredecessorEvidence,
    authenticatedCurrentHeadEvidence,
    predecessorProofSet,
    candidateProofSet,
    remoteTerminalSealReuseAuthority: remote.authorities[0],
    localActiveProof,
  }
}

function proof(collectionId: string): EncryptedWalletBackupV2ProofSetProof {
  const locator = {
    schemaVersion: 1 as const,
    kind: 'nut13' as const,
    keysetId: KEYSET,
    counter: 0,
  }
  return {
    mintUrl: MINT,
    unit: 'sat',
    asset: {
      kind: 'ctf',
      conditionId: '11'.repeat(32),
      outcomeLabel: 'YES',
      outcomeCollectionId: collectionId,
      registeredAt: 1_700_000_000,
      finalExpiry: 1_800_000_000,
    },
    locator,
    proof: {
      id: KEYSET,
      amount: 1,
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator,
        proofKeysetId: KEYSET,
        proofAmount: 1,
      }),
      C: `02${'11'.repeat(32)}`,
    },
  }
}

function remotePort(
  prepared: EncryptedWalletBackupV2PreparedTransportBundle,
): Pick<EncryptedWalletBackupV2RemotePort, 'readDescriptorPage' | 'readObject'> {
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: prepared.descriptor.realm,
    walletId: prepared.descriptor.walletId,
    enrollmentEpoch: 1,
    headVersion: 7,
    bundles: [prepared.descriptor],
  })
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head,
    bundles: [prepared.descriptor],
  })
  return {
    readDescriptorPage: async ({ afterBundleId }) => {
      const page = pages.find((candidate) => candidate.afterBundleId === afterBundleId)
      if (page === undefined) throw new Error('descriptor page not found')
      return page
    },
    readObject: async ({ objectId }) => {
      const object = prepared.objects.find((candidate) => candidate.objectId === objectId)
      if (object === undefined) throw new Error('object not found')
      return object
    },
  }
}

function unavailableMint(): EncryptedWalletBackupV2RestoreVerificationPort {
  return {
    resolveKeyset: async () => {
      throw new Error('mint unavailable')
    },
    verifyProofs: () => {
      throw new Error('mint unavailable')
    },
    checkProofStates: async () => {
      throw new Error('mint unavailable')
    },
  }
}

function committedTerminalStore(entry: EncryptedWalletBackupV2ProofSetProof, operationId: string) {
  const scopeInput = { scopeKind: 'wallet' as const, walletId: deriveDurableCustodyWalletId(SEED) }
  const scope = { ...scopeInput, scopeId: deriveDurableCustodyScopeId(scopeInput) }
  const operation = {
    operationId,
    kind: 'ctf-redeem' as const,
    mintUrl: MINT,
    inputs: [serializeDurableCustodyProofInput(entry.proof)],
    outputs: {},
    metadata: { unit: 'sat' },
  }
  const requestBody = prepareDurableCustodyExactArtifact(operation)
  const output = prepareDurableCustodyExactArtifact(operation.outputs)
  const privateMaterial = prepareDurableCustodyExactArtifact(operation)
  const facts = createDurableProofOperationFacts({
    unit: 'sat',
    binding: { kind: 'wallet', activityId: operationId, stage: 'ctf-redeem' },
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: false,
    inputKeysetRequirement: 'required',
    keysets: [
      {
        keysetId: KEYSET,
        unit: 'sat',
        curve: 'secp256k1',
        publicKeys: { '1': '02194603ffa36356f4a56b7df9371fc3192472351453ec7398b8da8117e7c3e104' },
        keysetExpiryMs: null,
        requireDleq: true,
        usedByInputs: true,
        usedByOutputs: false,
      },
    ],
  })
  const initial = createDurableCustodyProofOperation({
    scope,
    operation,
    facts,
    inventoryAccountId: null,
    exactBoundary: {
      method: 'POST',
      path: '/v1/redeem_outcome',
      idempotencyKey: operationId,
      requestBody,
      output,
      privateMaterial,
    },
  })
  const authority = {
    schemaVersion: 1,
    kind: 'authenticated-terminal-mint-rejection',
    operationId: initial.operation.operationId,
    semanticKind: 'ctf-redeem',
    normalizedMint: MINT,
    requestFingerprint: initial.operation.exactRequest.requestFingerprint,
    code: 13015,
    transportProvenance: 'authenticated-mint-transport',
    transportOperationId: operationId,
    rejectionBody: { code: 13015 },
    predecessorDisposition: 'retain',
    selectedSuccessorProofIds: [],
  }
  const exactRejection = prepareDurableCustodyExactArtifact(authority)
  const record: DurableCustodyRecord = {
    ...initial,
    operation: {
      ...initial.operation,
      state: 'aborted',
      terminalMintRejection: {
        kind: 'authenticated-terminal-mint-rejection',
        code: 13015,
        rejectionHandle: `mint-terminal-rejection:${exactRejection.fingerprint}`,
        rejectionFingerprint: exactRejection.fingerprint,
        exactRejection: createDurableCustodyArtifactReference(
          `artifact:${operationId}:terminal-mint-rejection`,
          exactRejection,
        ),
        predecessorDisposition: 'retain',
        selectedSuccessorProofIds: [],
      },
    },
  }
  return {
    operationId: initial.operation.operationId,
    store: {
      async withCommittedTerminalRejection<T>(
        requestedId: string,
        read: (value: {
          record: DurableCustodyRecord
          exactRejection: typeof exactRejection
          classifiedAtMs: number
        }) => T,
      ): Promise<T> {
        assert.equal(requestedId, initial.operation.operationId)
        return read({ record, exactRejection, classifiedAtMs: 1_700_000_000_000 })
      },
    },
  }
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, '0')).join('')
}
