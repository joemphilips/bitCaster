import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import { prepareEncryptedWalletBackupManifestPage } from '../src/encryptedWalletBackup.ts'
import {
  readEncryptedWalletBackupManifestEntryCapability,
  type EncryptedWalletBackupManifestEntryCapability,
} from '../src/encryptedWalletBackupManifestPageAuthority.ts'
import {
  joinEncryptedWalletBackupManifestSourcePage,
  measureEncryptedWalletBackupManifestSourceJoinRow,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_PHYSICAL_MAX_BYTES,
  type EncryptedWalletBackupManifestSourceJoinRow,
} from '../src/encryptedWalletBackupManifestSourceJoin.ts'
import {
  boundaryFor,
  bytesEqual,
  copyRow,
  sourceBytes,
  sourceFixture,
  sourcePageFixture,
  stagedPackFixture,
} from './helpers/encryptedWalletBackupManifestFixture.ts'

test('source join rejects a 256-row source page before authentication', async () => {
  const fixture = await sourceFixture()
  const rows = Array.from({ length: 256 }, () => copyRow(fixture.row))
  let requested = 0
  await assert.rejects(
    joinEncryptedWalletBackupManifestSourcePage({
      store: {
        async readSourcePage(_after, limit, maxBytes) {
          requested = limit
          assert.equal(maxBytes, ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_PHYSICAL_MAX_BYTES)
          return { rows, serializedBytes: sourceBytes(rows) }
        },
      },
      stagedPackProvider: {
        async rehydrateStagedPack() {
          throw new Error('pack provider reached')
        },
      },
      boundary: boundaryFor(fixture, 64, 64 * fixture.entryBytes),
      keyHandle: fixture.keyHandle,
      seed: fixture.seed,
      snapshotStore: fixture.snapshotStore,
      exclusiveAfter: null,
    }),
    /source page is invalid/,
  )
  assert.equal(requested, 64)
})

test('source join rejects byte-limit and keyset-order failures before staged-pack access', async () => {
  const fixture = await sourceFixture()
  for (const fault of ['bytes', 'order'] as const) {
    let packCalls = 0
    await assert.rejects(
      joinEncryptedWalletBackupManifestSourcePage({
        store: {
          async readSourcePage() {
            if (fault === 'bytes') {
              return {
                rows: [copyRow(fixture.row)],
                serializedBytes:
                  ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_PHYSICAL_MAX_BYTES + 1,
              }
            }
            return {
              rows: [copyRow(fixture.row), copyRow(fixture.row)],
              serializedBytes: sourceBytes([copyRow(fixture.row), copyRow(fixture.row)]),
            }
          },
        },
        stagedPackProvider: {
          async rehydrateStagedPack() {
            packCalls += 1
            throw new Error('pack provider reached')
          },
        },
        boundary: boundaryFor(
          fixture,
          fault === 'bytes' ? 1 : 2,
          (fault === 'bytes' ? 1 : 2) * fixture.entryBytes,
        ),
        keyHandle: fixture.keyHandle,
        seed: fixture.seed,
        snapshotStore: fixture.snapshotStore,
        exclusiveAfter: null,
      }),
      /source page is invalid|keyset order is invalid/,
    )
    assert.equal(packCalls, 0)
  }
})

test('source join rejects under-reported, over-reported, and oversized application bytes', async () => {
  const fixture = await sourceFixture()
  const exact = sourceBytes([fixture.row])
  for (const bytes of [exact - 1, exact + 1, 1_048_577]) {
    await assert.rejects(
      joinEncryptedWalletBackupManifestSourcePage({
        store: {
          async readSourcePage() {
            return { rows: [copyRow(fixture.row)], serializedBytes: bytes }
          },
        },
        stagedPackProvider: {
          async rehydrateStagedPack() {
            throw new Error('reached')
          },
        },
        boundary: boundaryFor(fixture, 1, fixture.entryBytes),
        keyHandle: fixture.keyHandle,
        seed: fixture.seed,
        snapshotStore: fixture.snapshotStore,
        exclusiveAfter: null,
      }),
      /source page is invalid/,
    )
  }
})

test('source join rejects one measured source row above 1 MiB before authentication', async () => {
  const fixture = await sourceFixture()
  const row = copyRow(fixture.row)
  ;(row.prepared as { canonicalRecord: Uint8Array }).canonicalRecord = new Uint8Array(1_048_576)
  assert.ok(measureEncryptedWalletBackupManifestSourceJoinRow(row) > 1_048_576)
  let snapshotCalls = 0
  let packCalls = 0
  await assert.rejects(
    joinEncryptedWalletBackupManifestSourcePage({
      store: {
        async readSourcePage() {
          return { rows: [row], serializedBytes: 1_048_576 }
        },
      },
      stagedPackProvider: {
        async rehydrateStagedPack() {
          packCalls += 1
          throw new Error('reached')
        },
      },
      boundary: boundaryFor(fixture, 1, fixture.entryBytes),
      keyHandle: fixture.keyHandle,
      seed: fixture.seed,
      snapshotStore: {
        async withCommittedPreparedRecordSnapshotBatch(ids, read) {
          snapshotCalls += 1
          return fixture.snapshotStore.withCommittedPreparedRecordSnapshotBatch(ids, read)
        },
      },
      exclusiveAfter: null,
    }),
    /source page is invalid/,
  )
  assert.equal(snapshotCalls, 0)
  assert.equal(packCalls, 0)
})

test('source join rejects exact pin and prepared-body substitutions before capability issue', async () => {
  const fixture = await sourceFixture()
  for (const fault of ['pin', 'body', 'revision'] as const) {
    const row = copyRow(fixture.row)
    if (fault === 'pin') row.pin[row.pin.byteLength - 1]! ^= 1
    if (fault === 'body') row.prepared.canonicalRecord[0]! ^= 1
    if (fault === 'revision') row.prepared.snapshotRevision += 1
    await assert.rejects(
      joinEncryptedWalletBackupManifestSourcePage({
        store: {
          async readSourcePage() {
            return { rows: [row], serializedBytes: sourceBytes([row]) }
          },
        },
        stagedPackProvider: {
          async rehydrateStagedPack() {
            throw new Error('pack provider reached')
          },
        },
        boundary: boundaryFor(fixture, 1, fixture.entryBytes),
        keyHandle: fixture.keyHandle,
        seed: fixture.seed,
        snapshotStore: fixture.snapshotStore,
        exclusiveAfter: null,
      }),
      /binding is invalid|capability|snapshot/,
    )
  }
})

test('source join issues ordered capabilities from an SDK-rehydrated staged pack', async () => {
  const fixture = await sourceFixture()
  const staged = await stagedPackFixture(fixture, [fixture.row], 'build-a', 'pack-a')
  let packCalls = 0
  const result = await joinEncryptedWalletBackupManifestSourcePage({
    store: {
      async readSourcePage(after, limit) {
        assert.equal(after, null)
        assert.equal(limit, 1)
        const rows = [copyRow(fixture.row)]
        return { rows, serializedBytes: sourceBytes(rows) }
      },
    },
    stagedPackProvider: {
      async rehydrateStagedPack(input) {
        assert.equal(input.buildId, 'build-a')
        assert.equal(input.packId, 'pack-a')
        packCalls += 1
        return staged.rehydrate()
      },
    },
    boundary: boundaryFor(fixture, 1, fixture.entryBytes),
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    snapshotStore: fixture.snapshotStore,
    exclusiveAfter: null,
  })
  assert.equal(packCalls, 1)
  assert.equal(result.entries.length, 1)
  assert.equal(result.evidence.firstPinKey?.byteLength, result.evidence.lastPinKey?.byteLength)
  assert.equal(
    bytesEqual(
      readEncryptedWalletBackupManifestEntryCapability(result.entries[0]!),
      staged.expectedEntry(fixture.row),
    ),
    true,
    'source join capability bytes changed',
  )
})

test('source join capabilities prepare their exact manifest page', async () => {
  const fixture = await sourceFixture()
  const staged = await stagedPackFixture(fixture, [fixture.row], 'build-a', 'pack-a')
  const boundary = boundaryFor(fixture, 1, fixture.entryBytes)
  const joined = await joinEncryptedWalletBackupManifestSourcePage({
    store: {
      async readSourcePage() {
        const rows = [copyRow(fixture.row)]
        return { rows, serializedBytes: sourceBytes(rows) }
      },
    },
    stagedPackProvider: { rehydrateStagedPack: () => staged.rehydrate() },
    boundary,
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    snapshotStore: fixture.snapshotStore,
    exclusiveAfter: null,
  })
  const page = await prepareEncryptedWalletBackupManifestPage({
    keyHandle: fixture.keyHandle,
    boundary,
    entries: joined.entries,
    runtime: { subtle: webcrypto.subtle, getRandomValues: (target) => target.fill(7) },
  })
  assert.equal(page.kindCode, 2)
  assert.equal(page.generation, 1)
})

test('source join streams one bounded 64-row logical page and preserves output pin-key order', async () => {
  const fixture = await sourcePageFixture(64)
  const staged = await stagedPackFixture(fixture, fixture.rows, 'build-a', 'pack-a')
  const limits: number[] = []
  const cursors: Array<Uint8Array | null> = []
  const result = await joinEncryptedWalletBackupManifestSourcePage({
    store: {
      async readSourcePage(after, limit) {
        limits.push(limit)
        cursors.push(after?.slice() ?? null)
        const start =
          after === null ? 0 : fixture.pinKeys.findIndex((key) => bytesEqual(key, after)) + 1
        const rows = fixture.rows.slice(start, start + limit).map(copyRow)
        return { rows, serializedBytes: sourceBytes(rows) }
      },
    },
    stagedPackProvider: { rehydrateStagedPack: () => staged.rehydrate() },
    boundary: boundaryFor(fixture, fixture.rows.length, fixture.rows.length * fixture.entryBytes),
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    snapshotStore: fixture.snapshotStore,
    exclusiveAfter: null,
  })
  assert.deepEqual(limits, [64])
  assert.equal(cursors[0], null)
  assert.equal(
    bytesEqual(result.evidence.firstPinKey!, fixture.pinKeys[0]!),
    true,
    'first pin key changed',
  )
  assert.equal(
    bytesEqual(result.evidence.lastPinKey!, fixture.pinKeys[63]!),
    true,
    'last pin key changed',
  )
  assert.equal(result.entries.length, 64)
  for (let index = 0; index < result.entries.length; index += 1) {
    assert.equal(
      bytesEqual(
        readEncryptedWalletBackupManifestEntryCapability(result.entries[index]!),
        staged.expectedEntry(fixture.rows[index]!),
      ),
      true,
      'source join output order changed',
    )
  }
})

test('source join rejects SDK-issued wrong build or pack before entry issue', async () => {
  const fixture = await sourceFixture()
  for (const [buildId, packId] of [
    ['build-b', 'pack-a'],
    ['build-a', 'pack-b'],
  ]) {
    const staged = await stagedPackFixture(fixture, [fixture.row], buildId, packId)
    await assert.rejects(
      joinEncryptedWalletBackupManifestSourcePage({
        store: {
          async readSourcePage() {
            const rows = [copyRow(fixture.row)]
            return { rows, serializedBytes: sourceBytes(rows) }
          },
        },
        stagedPackProvider: { rehydrateStagedPack: () => staged.rehydrate() },
        boundary: boundaryFor(fixture, 1, fixture.entryBytes),
        keyHandle: fixture.keyHandle,
        seed: fixture.seed,
        snapshotStore: fixture.snapshotStore,
        exclusiveAfter: null,
      }),
      /staged pack identity is invalid/,
    )
  }
})

test('source join rejects a substituted Pass-A scope before pack access', async () => {
  const fixture = await sourceFixture()
  let packCalls = 0
  await assert.rejects(
    joinEncryptedWalletBackupManifestSourcePage({
      store: {
        async readSourcePage() {
          const rows = [copyRow(fixture.row)]
          return { rows, serializedBytes: sourceBytes(rows) }
        },
      },
      stagedPackProvider: {
        async rehydrateStagedPack() {
          packCalls += 1
          throw new Error('reached')
        },
      },
      boundary: boundaryFor({ ...fixture, vaultId: '00'.repeat(32) }, 1, fixture.entryBytes),
      keyHandle: fixture.keyHandle,
      seed: fixture.seed,
      snapshotStore: fixture.snapshotStore,
      exclusiveAfter: null,
    }),
    /source scope is invalid/,
  )
  assert.equal(packCalls, 0)
})

test('source join processes distinct real staged packs sequentially in source order', async () => {
  const fixture = await sourcePageFixture(2)
  const first = { ...fixture.rows[0]!, buildId: 'build-a', packId: 'pack-a' }
  const second = { ...fixture.rows[1]!, buildId: 'build-b', packId: 'pack-b' }
  const stages = new Map([
    ['build-a:pack-a', await stagedPackFixture(fixture, [first], first.buildId, first.packId)],
    ['build-b:pack-b', await stagedPackFixture(fixture, [second], second.buildId, second.packId)],
  ])
  let inFlight = 0
  let maximumInFlight = 0
  const result = await joinEncryptedWalletBackupManifestSourcePage({
    store: {
      async readSourcePage() {
        const rows = [copyRow(first), copyRow(second)]
        return { rows, serializedBytes: sourceBytes(rows) }
      },
    },
    stagedPackProvider: {
      async rehydrateStagedPack(input) {
        inFlight += 1
        maximumInFlight = Math.max(maximumInFlight, inFlight)
        try {
          return await stages.get(`${input.buildId}:${input.packId}`)!.rehydrate()
        } finally {
          inFlight -= 1
        }
      },
    },
    boundary: boundaryFor(fixture, 2, 2 * fixture.entryBytes),
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    snapshotStore: fixture.snapshotStore,
    exclusiveAfter: null,
  })
  assert.equal(maximumInFlight, 1)
  assertJoinedSourceOrder(result.entries, stages, first, second)
})

function assertJoinedSourceOrder(
  entries: readonly EncryptedWalletBackupManifestEntryCapability[],
  stages: ReadonlyMap<string, Awaited<ReturnType<typeof stagedPackFixture>>>,
  first: EncryptedWalletBackupManifestSourceJoinRow,
  second: EncryptedWalletBackupManifestSourceJoinRow,
): void {
  for (const [index, key, row, message] of [
    [0, 'build-a:pack-a', first, 'first source entry changed'],
    [1, 'build-b:pack-b', second, 'second source entry changed'],
  ] as const) {
    assert.equal(
      bytesEqual(
        readEncryptedWalletBackupManifestEntryCapability(entries[index]!),
        stages.get(key)!.expectedEntry(row),
      ),
      true,
      message,
    )
  }
}
