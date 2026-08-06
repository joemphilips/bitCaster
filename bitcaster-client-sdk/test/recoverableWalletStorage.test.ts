import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isDurableCustodySafeAbortEligible,
  requireDurableWalletLosingCtfClassification,
  verifyDurableWalletConditionalKeyset,
} from '../src/recoverableWalletStorage.ts'
import { issueDurableWalletVerifiedLosingCtfClassification } from '../src/walletStorageAuthority.ts'

test('safe abort requires an unsubmitted deterministic rejection with no dependent state', () => {
  const eligible = {
    operationState: 'dispatch-intent' as const,
    submissionState: 'not-submitted' as const,
    exactInputStates: ['unspent', 'unspent'] as const,
    exactRequestDisposition: 'deterministically-rejected' as const,
    hasDependentJournaledIntent: false,
    hasStagedResult: false,
    deliveryState: 'none' as const,
  }
  assert.equal(isDurableCustodySafeAbortEligible(eligible), true)
  for (const override of [
    { operationState: 'transport-attempted' as const },
    { submissionState: 'submitted' as const },
    { exactInputStates: ['unspent', 'spent'] as const },
    { exactInputStates: [] as const },
    { exactRequestDisposition: 'unknown' as const },
    { hasDependentJournaledIntent: true },
    { hasStagedResult: true },
    { deliveryState: 'pending' as const },
  ])
    assert.equal(isDurableCustodySafeAbortEligible({ ...eligible, ...override }), false)
})

test('losing CTF classification remains SDK-issued authority', () => {
  const issued = issueDurableWalletVerifiedLosingCtfClassification()
  assert.equal(requireDurableWalletLosingCtfClassification(issued), issued)
  assert.throws(
    () => requireDurableWalletLosingCtfClassification({ ...issued }),
    /terminal evidence is invalid/,
  )
})

test('conditional keyset verification rejects malformed or foreign recovery metadata', () => {
  const input = {
    mint: 'https://mint.example',
    unit: 'sat',
    outcomeLabel: 'yes',
    registeredAtUnixSeconds: 1,
    mintKeys: {
      id: '02'.repeat(33),
      unit: 'sat',
      keys: { '1': `02${'11'.repeat(32)}` },
      final_expiry: 2,
      conditional: {
        conditionId: '11'.repeat(32),
        outcomeCollection: 'yes',
        outcomeCollectionId: '22'.repeat(32),
        registeredAt: 1,
      },
    },
    conditionalMetadata: {
      conditionId: '11'.repeat(32),
      outcomeCollection: 'yes',
      outcomeCollectionId: '22'.repeat(32),
      registeredAt: 1,
    },
  }
  assert.throws(
    () => verifyDurableWalletConditionalKeyset(input),
    /conditional keyset id is invalid/,
  )
  assert.throws(
    () =>
      verifyDurableWalletConditionalKeyset({
        ...input,
        outcomeLabel: 'no',
        mintKeys: { ...input.mintKeys, id: `01${'00'.repeat(32)}` },
      }),
    /does not match context/,
  )
})
