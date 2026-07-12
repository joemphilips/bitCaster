import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DURABLE_WALLET_STORAGE_CLASSES,
  DURABLE_WALLET_STORAGE_PIN_REASONS,
  acknowledgeDurableWalletBackupSnapshot,
  authenticateDurableWalletEncryptedBackupReceipt,
  classifyDurableWalletStorage,
  decodeDurableWalletStorageClassification,
  decideDurableWalletStoragePurge,
  deriveDurableWalletBackupSnapshotId,
  isDurableCustodySafeAbortEligible,
  prepareDurableWalletAcknowledgedBackupSnapshot,
} from '../src/recoverableWalletStorage.ts'

const RECORD_ID = '01'.repeat(32)

test('wallet storage classes and pin reasons are exhaustive stable values', () => {
  assert.deepEqual(DURABLE_WALLET_STORAGE_CLASSES, [
    'pinned-local-recovery-state',
    'pinned-operation-bound-deterministic',
    'remotely-backed-deterministic-proof',
    'audit-retained-expired-ctf',
    'disposable-derived-data',
  ])
  assert.deepEqual(DURABLE_WALLET_STORAGE_PIN_REASONS, [
    'active-p2pk-or-htlc-material',
    'ephemeral-private-key',
    'adaptor-secret',
    'pre-signature',
    'exact-inbound-cipher',
    'exact-outbound-cipher',
    'external-token-unrotated',
    'ambiguous-mint-operation',
    'active-reservation',
    'open-order-collateral',
    'pending-outbox',
    'active-retry-cursor',
    'replay-tombstone',
    'nonterminal-operation-link',
    'unknown-operation-link',
    'unknown-proof-provenance',
    'unknown-proof-condition',
    'missing-derivation-locator',
    'unverified-proof-commitment',
    'missing-current-backup-receipt',
    'expired-ctf-metadata',
    'unknown-ctf-metadata',
  ])
})

test('non-derivable recovery artifacts are pinned with canonical reasons', () => {
  for (const artifactKind of [
    'active-p2pk-or-htlc-material',
    'ephemeral-private-key',
    'adaptor-secret',
    'pre-signature',
    'exact-inbound-cipher',
    'exact-outbound-cipher',
    'external-token-unrotated',
    'pending-outbox',
    'active-retry-cursor',
    'replay-tombstone',
  ] as const) {
    const classification = classifyDurableWalletStorage({
      schemaVersion: 1,
      recordId: `${RECORD_ID}-${artifactKind}`,
      kind: 'non-derivable-recovery-state',
      artifactKind,
    })
    assert.equal(classification.storageClass, 'pinned-local-recovery-state')
    assert.deepEqual(classification.pinReasons, [artifactKind])
    assert.deepEqual(decideDurableWalletStoragePurge(classification, {
      effectiveNowMs: 10_000,
      encryptedProofEvictionEnabled: true,
      preparedCurrentSnapshot: preparedSnapshot(),
    }), { kind: 'retain' })
  }
})

test('deterministic proofs are operation-pinned before backup eligibility is considered', () => {
  const classification = classifyDurableWalletStorage({
    ...coldProofInput(),
    operationBinding: 'nonterminal',
    reserved: true,
    ambiguousMintOperation: true,
  })
  assert.equal(classification.storageClass, 'pinned-operation-bound-deterministic')
  assert.deepEqual(classification.pinReasons, [
    'ambiguous-mint-operation',
    'active-reservation',
    'nonterminal-operation-link',
  ])
  assert.deepEqual(decideDurableWalletStoragePurge(classification, {
    effectiveNowMs: 10_000,
    encryptedProofEvictionEnabled: true,
    preparedCurrentSnapshot: preparedSnapshot(),
  }), { kind: 'retain' })
})

test('NUT-09/NUT-13 capability alone never authorizes browser proof eviction', () => {
  const local = classifyDurableWalletStorage(coldProofInput())
  assert.equal(local.storageClass, 'pinned-local-recovery-state')
  assert.deepEqual(local.pinReasons, ['missing-current-backup-receipt'])
  assert.deepEqual(decideDurableWalletStoragePurge(local, {
    effectiveNowMs: 10_000,
    encryptedProofEvictionEnabled: true,
    preparedCurrentSnapshot: preparedSnapshot(),
  }), { kind: 'retain' })
})

test('only an exact supported receipt reachable from the current acknowledged snapshot permits eviction', () => {
  const backed = classifyDurableWalletStorage({
    ...coldProofInput(),
    backupReceiptEvidence: authenticatedReceipt(),
  })
  assert.equal(backed.storageClass, 'remotely-backed-deterministic-proof')
  assert.equal((backed as { recordKind?: string }).recordKind, 'deterministic-proof')
  assert.equal('backupReceipt' in backed, false)
  assert.deepEqual((backed as { backupBinding?: unknown }).backupBinding, {
    snapshotId: backupReceipt().snapshotId,
    chunkDigest: '44'.repeat(32),
    proofCommitment: '11'.repeat(32),
  })
  assert.deepEqual(backed.pinReasons, [])
  assert.deepEqual(decideDurableWalletStoragePurge(backed, {
    effectiveNowMs: 10_000,
    encryptedProofEvictionEnabled: true,
    preparedCurrentSnapshot: preparedSnapshot(),
  }), { kind: 'evict-proof-body' })

  for (const snapshot of [
    acknowledgedSnapshot({ generation: 1 }),
    acknowledgedSnapshot({ manifestDigest: '55'.repeat(32) }),
    { ...acknowledgedSnapshot(), reachableChunkDigests: ['66'.repeat(32)] },
  ]) {
    assert.deepEqual(decideDurableWalletStoragePurge(backed, {
      effectiveNowMs: 10_000,
      encryptedProofEvictionEnabled: true,
      preparedCurrentSnapshot: prepareSnapshot(snapshot),
    }), { kind: 'retain' })
  }
  assert.deepEqual(decideDurableWalletStoragePurge(backed, {
    effectiveNowMs: 10_000,
    encryptedProofEvictionEnabled: false,
    preparedCurrentSnapshot: preparedSnapshot(),
  }), { kind: 'retain' })

  const failClosedCases = [
    [{ provenance: 'unknown' }, 'unknown-proof-provenance'],
    [{ derivationLocator: 'missing' }, 'missing-derivation-locator'],
    [{ proofCommitment: { state: 'unverified' } }, 'unverified-proof-commitment'],
    [{ proofKind: 'ctf-expired' }, 'expired-ctf-metadata'],
    [{ proofKind: 'unknown' }, 'unknown-proof-condition'],
  ] as const
  for (const [override, expectedReason] of failClosedCases) {
    const classified = classifyDurableWalletStorage({ ...coldProofInput(), ...override } as Parameters<
      typeof classifyDurableWalletStorage
    >[0])
    assert.equal(classified.storageClass, 'pinned-local-recovery-state')
    assert.ok(classified.pinReasons.includes(expectedReason))
    assert.deepEqual(decideDurableWalletStoragePurge(classified, {
      effectiveNowMs: 10_000,
      encryptedProofEvictionEnabled: true,
      preparedCurrentSnapshot: preparedSnapshot(),
    }), { kind: 'retain' })
  }
})

test('proof condition and proof-level pins remain exhaustive and receipt cannot override them', () => {
  for (const proofKind of ['p2pk', 'htlc', 'unknown'] as const) {
    const classified = classifyDurableWalletStorage({
      ...coldProofInput(),
      proofKind,
      backupReceiptEvidence: authenticatedReceipt(),
    } as never)
    assert.equal(classified.storageClass, 'pinned-local-recovery-state')
  }
  for (const state of ['present', 'unknown'] as const) {
    for (const pin of ['openOrderCollateral', 'outbox', 'retryCursor', 'replayTombstone', 'dependentWork'] as const) {
      const classified = classifyDurableWalletStorage({
        ...coldProofInput(),
        proofKind: 'ordinary',
        proofPins: { ...absentProofPins(), [pin]: state },
        backupReceiptEvidence: authenticatedReceipt(),
      } as never)
      assert.notEqual(classified.storageClass, 'remotely-backed-deterministic-proof')
    }
  }
})

test('receipt encodings are canonical and persisted commitment mismatch fails closed', () => {
  assert.throws(
    () => authenticateDurableWalletEncryptedBackupReceipt(backupReceipt(), () => false),
    /receipt authentication failed/,
  )
  assert.throws(() => classifyDurableWalletStorage({
    ...coldProofInput(),
    recordId: 'AA'.repeat(32),
  }), /wallet proof id is invalid/)
  assert.throws(() => authenticateDurableWalletEncryptedBackupReceipt(
    { ...backupReceipt(), chunkDigest: 'AA'.repeat(32) },
    () => true,
  ), /backup chunk digest is invalid/)

  const valid = classifyDurableWalletStorage({
    ...coldProofInput(),
    backupReceiptEvidence: authenticatedReceipt(),
  })
  assert.throws(() => decodeDurableWalletStorageClassification({
    ...valid,
    backupBinding: { ...valid.backupBinding!, proofCommitment: '44'.repeat(32) },
  }), /backup receipt proof commitment does not match/)
})

test('active CTF can be remotely backed and prepared snapshot state is byte bounded', () => {
  const activeCtf = classifyDurableWalletStorage({
    ...coldProofInput(),
    proofKind: 'ctf-active',
    backupReceiptEvidence: authenticatedReceipt(),
  })
  assert.equal(activeCtf.storageClass, 'remotely-backed-deterministic-proof')
  assert.throws(() => acknowledgeDurableWalletBackupSnapshot({
    ...acknowledgedSnapshot(),
    reachableChunkDigests: Array.from({ length: 1_024 }, (_, index) =>
      index.toString(16).padStart(64, '0')),
  }, () => true), /snapshot exceeds the byte limit/)
})

test('snapshot identity binds every canonical head field', () => {
  const snapshot = acknowledgedSnapshot()
  for (const override of [
    { formatVersion: 2 },
    { realm: 'different-realm' },
    { backupPublicKey: 'aa'.repeat(32) },
    { generation: 3 },
    { manifestDigest: 'bb'.repeat(32) },
  ]) {
    assert.throws(
      () => acknowledgeDurableWalletBackupSnapshot({ ...snapshot, ...override } as never, () => true),
      /snapshot id|format version/,
    )
  }
})

test('authenticated receipt and prepared snapshot evidence cannot be mutated after verification', () => {
  const receiptEvidence = authenticatedReceipt()
  const originalChunkDigest = receiptEvidence.receipt.chunkDigest
  assert.throws(() => {
    ;(receiptEvidence.receipt as { chunkDigest: string }).chunkDigest = 'aa'.repeat(32)
  }, TypeError)
  assert.equal(receiptEvidence.receipt.chunkDigest, originalChunkDigest)

  const prepared = preparedSnapshot()
  assert.equal(Object.isFrozen(prepared), true)
  assert.equal(Object.isFrozen(prepared.snapshot), true)
  assert.equal('reachableChunkDigests' in prepared, false)
  assert.throws(() => {
    ;(prepared.snapshot as { snapshotId: string }).snapshotId = 'aa'.repeat(32)
  }, TypeError)
})

test('expired CTF is audit-retained until its explicit purge boundary', () => {
  const expired = classifyDurableWalletStorage({
    ...coldProofInput(),
    proofKind: 'ctf-expired',
    expiredAuditPurgeAfterMs: 20_000,
  } as never)
  assert.deepEqual(decideDurableWalletStoragePurge(expired, {
    effectiveNowMs: 19_999,
    encryptedProofEvictionEnabled: true,
    preparedCurrentSnapshot: preparedSnapshot(),
  } as never), { kind: 'retain' })
  assert.deepEqual(decideDurableWalletStoragePurge(expired, {
    effectiveNowMs: 20_000,
    encryptedProofEvictionEnabled: true,
    preparedCurrentSnapshot: preparedSnapshot(),
  } as never), { kind: 'delete-record' })
})

test('authoritative expired CTF audit retention ignores legacy provenance and recovery metadata defects', () => {
  for (const override of [
    { provenance: 'external' as const },
    { derivationLocator: 'missing' as const },
    { proofCommitment: { state: 'unverified' as const } },
  ]) {
    const expired = classifyDurableWalletStorage({
      ...coldProofInput(),
      ...override,
      proofKind: 'ctf-expired',
      expiredAuditPurgeAfterMs: 20_000,
    })
    assert.equal(expired.storageClass, 'audit-retained-expired-ctf')
  }
})

test('disposable derived data purges only after its retention boundary', () => {
  const classified = classifyDurableWalletStorage({
    schemaVersion: 1,
    recordId: RECORD_ID,
    kind: 'disposable-derived-data',
    purgeAfterMs: 5_000,
  })
  assert.equal(classified.storageClass, 'disposable-derived-data')
  assert.deepEqual(decideDurableWalletStoragePurge(classified, {
    effectiveNowMs: 4_999,
    encryptedProofEvictionEnabled: false,
    preparedCurrentSnapshot: null,
  }), { kind: 'retain' })
  assert.deepEqual(decideDurableWalletStoragePurge(classified, {
    effectiveNowMs: 5_000,
    encryptedProofEvictionEnabled: false,
    preparedCurrentSnapshot: null,
  }), { kind: 'delete-record' })
})

test('unknown storage schema, class, reason, or contradictory class fails closed', () => {
  const valid = classifyDurableWalletStorage(coldProofInput())
  assert.throws(
    () => decodeDurableWalletStorageClassification({ ...valid, schemaVersion: 2 }),
    /unsupported durable wallet storage schema version/,
  )
  const backed = classifyDurableWalletStorage({
    ...coldProofInput(),
    backupReceiptEvidence: authenticatedReceipt(),
  })
  assert.throws(
    () => decodeDurableWalletStorageClassification({ ...backed, recordId: 'AA'.repeat(32) }),
    /wallet proof id is invalid/,
  )
  assert.throws(
    () => decodeDurableWalletStorageClassification({ ...valid, storageClass: 'future-class' }),
    /storage class is invalid/,
  )
  assert.throws(
    () => decodeDurableWalletStorageClassification({ ...valid, pinReasons: ['future-reason'] }),
    /pin reason is invalid/,
  )
  assert.throws(
    () => decodeDurableWalletStorageClassification({
      ...valid,
      storageClass: 'pinned-local-recovery-state',
      pinReasons: [],
    }),
    /pinned storage requires a reason/,
  )
})

test('safe abort requires all-unspent deterministic rejection before submission and no dependency or delivery', () => {
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
    { submissionState: 'unknown' as const },
    { exactInputStates: ['unspent', 'spent'] as const },
    { exactInputStates: [] as const },
    { exactRequestDisposition: 'unknown' as const },
    { hasDependentJournaledIntent: true },
    { hasStagedResult: true },
    { deliveryState: 'pending' as const },
    { deliveryState: 'acknowledged' as const },
  ]) {
    assert.equal(isDurableCustodySafeAbortEligible({ ...eligible, ...override }), false)
  }
  assert.equal(isDurableCustodySafeAbortEligible({} as never), false)
})

function coldProofInput() {
  return {
    schemaVersion: 1 as const,
    recordId: RECORD_ID,
    kind: 'deterministic-proof' as const,
    provenance: 'wallet-seed' as const,
    proofKind: 'ordinary' as const,
    operationBinding: 'terminally-unlinked' as const,
    reserved: false,
    ambiguousMintOperation: false,
    proofPins: absentProofPins(),
    derivationLocator: 'committed' as const,
    proofCommitment: { state: 'verified' as const, digest: '11'.repeat(32) },
    backupReceiptEvidence: null,
    expiredAuditPurgeAfterMs: null,
  }
}

function absentProofPins() {
  return {
    openOrderCollateral: 'absent' as const,
    outbox: 'absent' as const,
    retryCursor: 'absent' as const,
    replayTombstone: 'absent' as const,
    dependentWork: 'absent' as const,
  }
}

function backupReceipt() {
  const head = backupHead()
  return {
    formatVersion: 1 as const,
    ...head,
    snapshotId: deriveDurableWalletBackupSnapshotId(head),
    chunkDigest: '44'.repeat(32),
    proofCommitment: '11'.repeat(32),
  }
}

function acknowledgedSnapshot(overrides: Partial<ReturnType<typeof backupHead>> = {}) {
  const head = { ...backupHead(), ...overrides }
  return {
    formatVersion: 1 as const,
    ...head,
    snapshotId: deriveDurableWalletBackupSnapshotId(head),
    reachableChunkDigests: ['44'.repeat(32)],
  }
}

function backupHead() {
  return {
    formatVersion: 1 as const,
    realm: 'production-backup-v1',
    backupPublicKey: '22'.repeat(32),
    generation: 2,
    manifestDigest: '33'.repeat(32),
  }
}

function authenticatedReceipt() {
  return authenticateDurableWalletEncryptedBackupReceipt(backupReceipt(), () => true)
}

function preparedSnapshot() {
  return prepareSnapshot(acknowledgedSnapshot())
}

function prepareSnapshot(snapshot: ReturnType<typeof acknowledgedSnapshot>) {
  return prepareDurableWalletAcknowledgedBackupSnapshot(
    acknowledgeDurableWalletBackupSnapshot(snapshot, () => true),
  )
}
