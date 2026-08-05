import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2CurrentHead,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  requireEncryptedWalletBackupV2CollectedHeadEvidence,
  type EncryptedWalletBackupV2CollectedHeadEvidence,
  type EncryptedWalletBackupV2DescriptorPage,
} from './encryptedWalletBackupV2Head.ts'
import {
  prepareEncryptedWalletBackupV2BundleSupersessionMutation,
  requireEncryptedWalletBackupV2VerifiedBundleSupersessionMutation,
  type EncryptedWalletBackupV2MutationRuntime,
  type EncryptedWalletBackupV2SignedBundleSupersessionMutation,
} from './encryptedWalletBackupV2Mutation.ts'
import {
  requireEncryptedWalletBackupV2VerifiedBundleSupersessionReceipt,
  type EncryptedWalletBackupV2VerifiedBundleSupersessionReceipt,
} from './encryptedWalletBackupV2Receipt.ts'
import type { EncryptedWalletBackupV2BundleDescriptor } from './encryptedWalletBackupV2Descriptor.ts'
import type { EncryptedWalletBackupV2KeyHandle } from './encryptedWalletBackupV2Keys.ts'
import type { EncryptedWalletBackupV2RequestProof } from './encryptedWalletBackupV2RequestProof.ts'

export async function collectAllEncryptedWalletBackupV2DescriptorPages(input: {
  readonly issueRequestProof: (
    afterBundleId: string | null,
  ) => Promise<EncryptedWalletBackupV2RequestProof>
  readonly readDescriptorPage: (input: {
    readonly requestProof: EncryptedWalletBackupV2RequestProof
    readonly afterBundleId: string | null
  }) => Promise<EncryptedWalletBackupV2DescriptorPage>
}): Promise<EncryptedWalletBackupV2CollectedHeadEvidence> {
  const pages: EncryptedWalletBackupV2DescriptorPage[] = []
  let cursor: string | null = null
  do {
    const requestProof = await input.issueRequestProof(cursor)
    const page = await input.readDescriptorPage({ requestProof, afterBundleId: cursor })
    pages.push(page)
    cursor = page.nextAfterBundleId
  } while (cursor !== null && pages.length < 18)
  return collectEncryptedWalletBackupV2DescriptorPages(pages)
}

export async function prepareEncryptedWalletBackupV2AssetMutation(input: {
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly expectedHeadEvidence: EncryptedWalletBackupV2CollectedHeadEvidence
  readonly assetLocator: string
  readonly desiredAction: 'replace' | 'remove'
  readonly addedBundle: EncryptedWalletBackupV2BundleDescriptor | null
  readonly runtime: EncryptedWalletBackupV2MutationRuntime
}): Promise<EncryptedWalletBackupV2SignedBundleSupersessionMutation> {
  const head = requireEncryptedWalletBackupV2CollectedHeadEvidence(input.expectedHeadEvidence)
  const predecessor = head.bundles.filter((bundle) => bundle.assetLocator === input.assetLocator)
  if (predecessor.length > 1) throw new Error('encrypted backup v2 asset predecessor is invalid')
  if (input.desiredAction === 'remove') {
    if (input.addedBundle !== null || predecessor.length !== 1)
      throw new Error('encrypted backup v2 removal predecessor is invalid')
  } else if (input.addedBundle === null || input.addedBundle.assetLocator !== input.assetLocator) {
    throw new Error('encrypted backup v2 replacement asset is invalid')
  }
  return prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle: input.keyHandle,
    expectedHeadEvidence: head,
    addedBundle: input.addedBundle,
    supersededBundleIds: predecessor.map((bundle) => bundle.bundleId),
    runtime: input.runtime,
  })
}

/** Derives receipt-result evidence locally. It never re-fetches the service head. */
export function applyEncryptedWalletBackupV2VerifiedReceipt(input: {
  readonly expectedHeadEvidence: EncryptedWalletBackupV2CollectedHeadEvidence
  readonly mutationEvidence: unknown
  readonly receiptEvidence: EncryptedWalletBackupV2VerifiedBundleSupersessionReceipt
}): EncryptedWalletBackupV2CollectedHeadEvidence {
  const head = requireEncryptedWalletBackupV2CollectedHeadEvidence(input.expectedHeadEvidence)
  const mutation = requireEncryptedWalletBackupV2VerifiedBundleSupersessionMutation(
    input.mutationEvidence,
  ).envelope.mutation
  const receipt = requireEncryptedWalletBackupV2VerifiedBundleSupersessionReceipt(
    input.receiptEvidence,
  ).receipt
  if (
    receipt.previousHeadVersion !== head.head.headVersion ||
    receipt.previousActiveSetDigest !== head.head.activeSetDigest
  )
    throw new Error('encrypted backup v2 receipt predecessor head is invalid')
  const superseded = new Set(mutation.supersededBundleIds)
  const bundles = head.bundles.filter((bundle) => !superseded.has(bundle.bundleId))
  if (mutation.addedBundle !== null) bundles.push(mutation.addedBundle)
  bundles.sort((left, right) => left.bundleId.localeCompare(right.bundleId))
  const resultHead = createEncryptedWalletBackupV2CurrentHead({
    realm: head.head.realm,
    vaultId: head.head.vaultId,
    enrollmentEpoch: head.head.enrollmentEpoch,
    headVersion: head.head.headVersion + 1,
    bundles,
  })
  if (!sameHead(resultHead, receipt.resultHead))
    throw new Error('encrypted backup v2 receipt result evidence is invalid')
  return collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({ head: resultHead, bundles }),
  )
}

function sameHead(left: object, right: object): boolean {
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  return (
    Object.keys(a).every((key) => a[key] === b[key]) &&
    Object.keys(b).length === Object.keys(a).length
  )
}
