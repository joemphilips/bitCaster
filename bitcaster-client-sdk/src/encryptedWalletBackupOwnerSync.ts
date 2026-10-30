import {
  decodeEncryptedWalletBackupOwnerContext,
  collectEncryptedWalletBackupOwnerDescriptorPages,
  createEncryptedWalletBackupOwnerCurrentHead,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
  requireEncryptedWalletBackupOwnerCollectedHeadEvidence,
  type EncryptedWalletBackupOwnerCollectedHeadEvidence,
  type EncryptedWalletBackupOwnerContext,
} from './encryptedWalletBackupOwnerHead.ts'
import { requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation } from './encryptedWalletBackupOwnerMutation.ts'
import {
  requireEncryptedWalletBackupOwnerReceiptMutation,
  type EncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt,
} from './encryptedWalletBackupOwnerReceipt.ts'
/** Derives receipt-result evidence locally. It never re-fetches the service head. */
export function applyEncryptedWalletBackupOwnerVerifiedReceipt(input: {
  readonly expectedContext: EncryptedWalletBackupOwnerContext
  readonly expectedHeadEvidence: EncryptedWalletBackupOwnerCollectedHeadEvidence
  readonly mutationEvidence: unknown
  readonly receiptEvidence: EncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt
}): EncryptedWalletBackupOwnerCollectedHeadEvidence {
  const context = decodeEncryptedWalletBackupOwnerContext(input.expectedContext)
  const mutationEvidence = input.mutationEvidence
  const receiptEvidence = input.receiptEvidence
  const head = requireEncryptedWalletBackupOwnerCollectedHeadEvidence(
    input.expectedHeadEvidence,
    context,
  )
  const mutation = requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation(
    mutationEvidence,
    context,
  ).envelope.mutation
  const receipt = requireEncryptedWalletBackupOwnerReceiptMutation({
    expectedContext: context,
    mutationEvidence,
    receiptEvidence,
  })
  if (
    receipt.previousHeadVersion !== head.head.headVersion ||
    receipt.previousActiveSetDigest !== head.head.activeSetDigest
  )
    throw new Error('encrypted backup owner receipt predecessor head is invalid')
  const superseded = new Set(mutation.supersededBundleIds)
  const bundles = head.bundles.filter((bundle) => !superseded.has(bundle.bundleId))
  if (mutation.addedBundle !== null) bundles.push(mutation.addedBundle)
  bundles.sort((left, right) => left.bundleId.localeCompare(right.bundleId))
  const resultHead = createEncryptedWalletBackupOwnerCurrentHead({
    ownerScopeId: head.head.ownerScopeId,
    realm: head.head.realm,
    walletId: head.head.walletId,
    enrollmentEpoch: head.head.enrollmentEpoch,
    headVersion: head.head.headVersion + 1,
    bundles,
  })
  if (!sameHead(resultHead, receipt.resultHead))
    throw new Error('encrypted backup owner receipt result evidence is invalid')
  return collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({ head: resultHead, bundles }),
    context,
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
