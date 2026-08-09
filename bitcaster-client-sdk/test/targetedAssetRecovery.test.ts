import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveDurableCustodyScopeId } from '../src/durableCustody.ts'
import { deriveRootCtfOutcomeCollectionId } from '../src/durableCtfRangeOperation.ts'
import { createEncryptedWalletBackupV2AssetIdentity } from '../src/encryptedWalletBackupV2ProofSet.ts'
import {
  buildTargetedAssetRecoveryMintRequests,
  createTargetedAssetRecoveryAttemptKey,
  recoverTargetedAsset,
  TARGETED_ASSET_RECOVERY_NUT07_BATCH_PROOF_MAX,
  TARGETED_ASSET_RECOVERY_TOTAL_MINT_HTTP_REQUESTS_MAX,
  type TargetedAssetRecoveryCompletedOutcome,
  type TargetedAssetRecoveryInput,
  type TargetedAssetRecoveryPorts,
} from '../src/targetedAssetRecovery.ts'

const scopeId = deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId: '11'.repeat(32) })
const monitoringAsset = {
  canonicalMintUrl: 'https://mint.example',
  kind: 'collateral' as const,
  cashuUnit: 'sat' as const,
  displayBaseAsset: 'sat' as const,
}

function input(overrides: Partial<TargetedAssetRecoveryInput> = {}): TargetedAssetRecoveryInput {
  return {
    scopeId,
    assetLocator: 'aa'.repeat(32),
    asset: createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: 'https://mint.example',
      unit: 'sat',
      asset: { kind: 'ordinary' },
    }),
    monitoringAsset,
    monitoringFactVersion: 'fact-1',
    ...overrides,
  }
}

function fact(overrides: Record<string, unknown> = {}) {
  return {
    asset: monitoringAsset,
    factVersion: 'fact-1',
    availableSubunits: 1,
    recoveryHint: {
      keysetIds: ['00' + 'a'.repeat(14)],
      counterIntervals: [{ start: 0, count: 1 }],
    },
    ...overrides,
  }
}

function ports(overrides: Partial<TargetedAssetRecoveryPorts<string>> = {}) {
  const calls = {
    local: 0,
    backup: 0,
    restore: 0,
    monitoring: 0,
    readAttempt: 0,
    record: 0,
    mint: 0,
  }
  const completed = new Map<string, TargetedAssetRecoveryCompletedOutcome>()
  const base: TargetedAssetRecoveryPorts<string> = {
    hasLocalCustody: () => {
      calls.local += 1
      return false
    },
    readAuthenticatedCurrentBackupInventory: () => {
      calls.backup += 1
      return { kind: 'available', headVersion: 4, exactEntry: null }
    },
    restoreAndAdmitBackup: () => {
      calls.restore += 1
    },
    readExactMonitoringFact: () => {
      calls.monitoring += 1
      return fact()
    },
    readCompletedAttempt: (key) => {
      calls.readAttempt += 1
      return completed.get(JSON.stringify(key)) ?? null
    },
    recordCompletedAttempt: (key, outcome) => {
      calls.record += 1
      completed.set(JSON.stringify(key), outcome)
    },
    recoverFromMint: () => {
      calls.mint += 1
      return 'restored'
    },
    ...overrides,
  }
  return { calls, completed, ports: base }
}

test('targeted recovery returns local before it reads another authority', async () => {
  let localCalls = 0
  const fake = ports({
    hasLocalCustody: () => {
      localCalls += 1
      return true
    },
  })
  assert.deepEqual(await recoverTargetedAsset(input(), fake.ports), { kind: 'local' })
  assert.equal(localCalls, 1)
  assert.equal(fake.calls.backup, 0)
  assert.equal(fake.calls.monitoring, 0)
  assert.equal(fake.calls.mint, 0)
})

test('targeted recovery preserves a backup read failure as a persistent error', async () => {
  const fake = ports({
    readAuthenticatedCurrentBackupInventory: () => {
      throw new Error('offline')
    },
  })
  assert.deepEqual(await recoverTargetedAsset(input(), fake.ports), { kind: 'persistent-error' })
  assert.equal(fake.calls.monitoring, 0)
  assert.equal(fake.calls.mint, 0)
})

test('targeted recovery preserves unavailable backup inventory as a persistent error', async () => {
  const fake = ports({ readAuthenticatedCurrentBackupInventory: () => ({ kind: 'unavailable' }) })
  assert.deepEqual(await recoverTargetedAsset(input(), fake.ports), { kind: 'persistent-error' })
  assert.equal(fake.calls.monitoring, 0)
  assert.equal(fake.calls.mint, 0)
})

test('targeted recovery restores a present backup and never calls monitoring or mint', async () => {
  const fake = ports({
    readAuthenticatedCurrentBackupInventory: () => ({
      kind: 'available',
      headVersion: 4,
      exactEntry: 'backup',
    }),
  })
  assert.deepEqual(await recoverTargetedAsset(input(), fake.ports), { kind: 'restored-backup' })
  assert.equal(fake.calls.restore, 1)
  assert.equal(fake.calls.monitoring, 0)
  assert.equal(fake.calls.mint, 0)
})

test('targeted recovery does not fall through when backup restore fails', async () => {
  const fake = ports({
    readAuthenticatedCurrentBackupInventory: () => ({
      kind: 'available',
      headVersion: 4,
      exactEntry: 'backup',
    }),
    restoreAndAdmitBackup: () => {
      throw new Error('invalid proof')
    },
  })
  assert.deepEqual(await recoverTargetedAsset(input(), fake.ports), { kind: 'persistent-error' })
  assert.equal(fake.calls.monitoring, 0)
  assert.equal(fake.calls.mint, 0)
})

test('targeted recovery returns unavailable for no fact, zero amount, or no hint', async () => {
  for (const monitoring of [null, fact({ availableSubunits: 0 }), fact({ recoveryHint: null })]) {
    const fake = ports({ readExactMonitoringFact: () => monitoring })
    assert.deepEqual(await recoverTargetedAsset(input(), fake.ports), { kind: 'unavailable' })
    assert.equal(fake.calls.mint, 0)
  }
})

test('targeted recovery persists an automatic mint result and does not repeat the same tuple', async () => {
  const fake = ports()
  assert.deepEqual(await recoverTargetedAsset(input(), fake.ports), { kind: 'restored-mint' })
  assert.deepEqual(await recoverTargetedAsset(input(), fake.ports), {
    kind: 'already-attempted',
    completedOutcome: 'restored-mint',
  })
  assert.equal(fake.calls.mint, 1)
  assert.equal(fake.calls.record, 1)
})

test('targeted recovery retries only when the head or exact fact version changes', async () => {
  let headVersion = 4
  const fake = ports({
    readAuthenticatedCurrentBackupInventory: () => ({
      kind: 'available',
      headVersion,
      exactEntry: null,
    }),
    readExactMonitoringFact: (recovery) => fact({ factVersion: recovery.monitoringFactVersion }),
  })
  await recoverTargetedAsset(input(), fake.ports)
  headVersion = 5
  await recoverTargetedAsset(input(), fake.ports)
  await recoverTargetedAsset(input({ monitoringFactVersion: 'fact-2' }), fake.ports)
  assert.equal(fake.calls.mint, 3)
})

test('targeted recovery records an unavailable or failed automatic mint attempt', async () => {
  const unavailable = ports({ recoverFromMint: () => 'unavailable' })
  assert.deepEqual(await recoverTargetedAsset(input(), unavailable.ports), { kind: 'unavailable' })
  assert.equal(
    unavailable.completed.get(JSON.stringify(createTargetedAssetRecoveryAttemptKey(input(), 4))),
    'unavailable',
  )

  const failed = ports({
    recoverFromMint: () => {
      throw new Error('mint failed')
    },
  })
  assert.deepEqual(await recoverTargetedAsset(input(), failed.ports), { kind: 'persistent-error' })
  assert.equal(
    failed.completed.get(JSON.stringify(createTargetedAssetRecoveryAttemptKey(input(), 4))),
    'persistent-error',
  )
})

test('targeted recovery rejects a foreign or stale monitoring fact before mint recovery', async () => {
  const fake = ports({ readExactMonitoringFact: () => fact({ factVersion: 'fact-2' }) })
  assert.deepEqual(await recoverTargetedAsset(input(), fake.ports), { kind: 'persistent-error' })
  assert.equal(fake.calls.mint, 0)
})

test('targeted recovery rejects different backup and monitoring asset authorities', async () => {
  const fake = ports()
  await assert.rejects(() =>
    recoverTargetedAsset(
      input({
        monitoringAsset: {
          ...monitoringAsset,
          canonicalMintUrl: 'https://other-mint.example',
        },
      }),
      fake.ports,
    ),
  )
  assert.equal(fake.calls.local, 0)

  const conditionId = '33'.repeat(32)
  const conditionalMonitoring = {
    canonicalMintUrl: 'https://mint.example',
    kind: 'conditional' as const,
    cashuUnit: 'sat' as const,
    displayBaseAsset: 'sat' as const,
    conditionId,
    parentConditionId: '00'.repeat(32),
    outcomeUniverseDigest: '44'.repeat(32),
    internalOutcomeSetId: 'NO',
  }
  await assert.rejects(() =>
    recoverTargetedAsset(
      input({
        asset: createEncryptedWalletBackupV2AssetIdentity({
          mintUrl: 'https://mint.example',
          unit: 'sat',
          asset: {
            kind: 'ctf',
            conditionId,
            outcomeLabel: 'YES',
            outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
              conditionId,
              outcomeCollection: 'YES',
            }),
            registeredAt: 1,
            finalExpiry: null,
          },
        }),
        monitoringAsset: conditionalMonitoring,
      }),
      fake.ports,
    ),
  )
})

test('targeted recovery coalesces concurrent calls for one exact tuple', async () => {
  let mintCalls = 0
  let resolveMint!: (value: 'restored') => void
  const mintResult = new Promise<'restored'>((resolve) => {
    resolveMint = resolve
  })
  const fake = ports({
    recoverFromMint: () => {
      mintCalls += 1
      return mintResult
    },
  })
  const first = recoverTargetedAsset(input(), fake.ports)
  const second = recoverTargetedAsset(input(), fake.ports)
  await waitFor(() => mintCalls === 1)
  resolveMint('restored')
  assert.deepEqual(await Promise.all([first, second]), [
    { kind: 'restored-mint' },
    { kind: 'restored-mint' },
  ])
  assert.equal(mintCalls, 1)
  assert.equal(fake.calls.record, 1)
})

test('targeted recovery bounds candidates and total mint HTTP requests', () => {
  assert.throws(() =>
    buildTargetedAssetRecoveryMintRequests({ keysetIds: [], counterIntervals: [] }),
  )
  const requests = buildTargetedAssetRecoveryMintRequests({
    keysetIds: Array.from({ length: 8 }, (_, index) => `00${index.toString(16).padStart(14, '0')}`),
    counterIntervals: Array.from({ length: 4 }, (_, index) => ({
      start: index * 64,
      count: 64,
    })),
  })
  assert.equal(requests.length, 32)
  const maximumShapeRequestCount =
    requests.length + Math.ceil((8 * 4 * 64) / TARGETED_ASSET_RECOVERY_NUT07_BATCH_PROOF_MAX) + 8
  assert.equal(maximumShapeRequestCount, 61)
  assert.equal(
    maximumShapeRequestCount <= TARGETED_ASSET_RECOVERY_TOTAL_MINT_HTTP_REQUESTS_MAX,
    true,
  )
  assert.equal(
    requests.every((request) => request.counterCount === 64),
    true,
  )
  assert.equal(
    buildTargetedAssetRecoveryMintRequests({
      keysetIds: ['0011223344556677'],
      counterIntervals: [{ start: 0, count: 4096 }],
    }).length,
    1,
  )
  assert.throws(() =>
    buildTargetedAssetRecoveryMintRequests({
      keysetIds: Array.from(
        { length: 16 },
        (_, index) => `00${index.toString(16).padStart(14, '0')}`,
      ),
      counterIntervals: Array.from({ length: 2 }, (_, index) => ({
        start: index * 64,
        count: 64,
      })),
    }),
  )
  assert.throws(() =>
    buildTargetedAssetRecoveryMintRequests({
      keysetIds: Array.from(
        { length: 16 },
        (_, index) => `00${index.toString(16).padStart(14, '0')}`,
      ),
      counterIntervals: Array.from({ length: 4 }, (_, index) => ({
        start: index * 65,
        count: 65,
      })),
    }),
  )
  assert.throws(() =>
    buildTargetedAssetRecoveryMintRequests({
      keysetIds: Array.from(
        { length: 16 },
        (_, index) => `00${index.toString(16).padStart(14, '0')}`,
      ),
      counterIntervals: Array.from({ length: 5 }, (_, index) => ({
        start: index,
        count: 1,
      })),
    }),
  )
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition did not become true')
}
