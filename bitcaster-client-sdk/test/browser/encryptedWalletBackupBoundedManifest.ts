import {
  createEncryptedWalletBackupKeyHandle,
  prepareEncryptedWalletBackupFrozenSnapshotControl,
  prepareEncryptedWalletBackupRequestProof,
  readAuthenticatedEncryptedWalletBackupHead,
  readPreparedEncryptedWalletBackupObject,
  type EncryptedWalletBackupKeyHandle,
  type EncryptedWalletBackupRuntime,
  type PreparedEncryptedWalletBackupObject,
  type PreparedEncryptedWalletBackupProof,
} from '../../src/encryptedWalletBackup.ts'
import {
  appendEncryptedWalletBackupPreparedRecordPage,
  freezeEncryptedWalletBackupPack,
  prepareEncryptedWalletBackupFrozenPackObject,
  rehydrateEncryptedWalletBackupStagedPackObject,
  serializeEncryptedWalletBackupPackBinding,
  serializeEncryptedWalletBackupPreparedBuildRecord,
  stageEncryptedWalletBackupPackObject,
  type EncryptedWalletBackupPackPersistenceStore,
  type EncryptedWalletBackupPackPersistenceTransaction,
  type PersistedEncryptedWalletBackupBuildCursor,
  type PersistedEncryptedWalletBackupPackBinding,
  type PersistedEncryptedWalletBackupPackControl,
  type PersistedEncryptedWalletBackupPreparedBuildRecord,
  type PersistedEncryptedWalletBackupStagedObject,
} from '../../src/encryptedWalletBackupPackPersistence.ts'
import {
  decodeEncryptedWalletBackupPreparedSourceDescriptor,
  encodeEncryptedWalletBackupPreparedSourceDescriptor,
  sealPreparedEncryptedWalletBackupRecord,
  type EncryptedWalletBackupPreparedRecordSnapshot,
  type EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from '../../src/encryptedWalletBackupPreparedRecordPersistence.ts'
import {
  appendEncryptedWalletBackupFrozenSnapshotProofPage,
  beginEncryptedWalletBackupFrozenSnapshot,
  decodeEncryptedWalletBackupSnapshotPin,
  encodeEncryptedWalletBackupSnapshotPin,
  type EncryptedWalletBackupSnapshotPersistenceStore,
  type EncryptedWalletBackupSnapshotPersistenceTransaction,
  type PersistedEncryptedWalletBackupFrozenSnapshot,
} from '../../src/encryptedWalletBackupSnapshotPersistence.ts'
import {
  sealEncryptedWalletBackupFrozenSnapshot,
  type EncryptedWalletBackupFrozenSnapshotSealStore,
} from '../../src/encryptedWalletBackupSnapshotSeal.ts'
import {
  planEncryptedWalletBackupManifestPassA,
  type EncryptedWalletBackupManifestPassAResultStore,
} from '../../src/encryptedWalletBackupManifestPassA.ts'
import {
  persistNextEncryptedWalletBackupManifestPage,
  type EncryptedWalletBackupManifestPagePersistenceStore,
  type EncryptedWalletBackupManifestPagePersistenceTransaction,
} from '../../src/encryptedWalletBackupManifestPagePersistence.ts'
import {
  finalizeBoundedEncryptedWalletBackupManifestTarget,
  type EncryptedWalletBackupManifestTargetFinalizationStore,
} from '../../src/encryptedWalletBackupManifestTargetFinalization.ts'
import {
  measureEncryptedWalletBackupManifestSourceJoinRow,
  type EncryptedWalletBackupManifestSourceJoinRow,
} from '../../src/encryptedWalletBackupManifestSourceJoin.ts'
import { encodeCanonicalBackupCbor } from '../../src/encryptedWalletBackupCbor.ts'

const SNAPSHOT_ID = 'browser-vector-snapshot'

export async function buildBoundedEncryptedWalletBackupManifestVector(input: {
  readonly seed: Uint8Array
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly proofs: readonly PreparedEncryptedWalletBackupProof[]
  readonly packRuntimes: readonly EncryptedWalletBackupRuntime[]
  readonly pageRuntime: EncryptedWalletBackupRuntime
}): Promise<{
  readonly head: Uint8Array
  readonly references: Uint8Array
  readonly page: PreparedEncryptedWalletBackupObject
}> {
  if (input.proofs.length !== 4 || input.packRuntimes.length !== 2)
    throw new Error('browser vector bounded manifest input is invalid')
  const snapshots = snapshotRows(input.proofs)
  const prepared = await sealRecords(input, snapshots)
  const packs = await stagePacks(input, prepared, snapshots)
  const request = await prepareEncryptedWalletBackupRequestProof({
    keyHandle: input.keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/vault/head',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    signal: AbortSignal.timeout(60_000),
    runtime: deterministicRuntime([new Uint8Array(16).fill(61), new Uint8Array(32).fill(62)]),
  })
  const parentEvidence = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle: input.keyHandle,
    enrollmentEpoch: 1,
    requestProof: request,
    remote: {
      async readCurrentHead() {
        return { status: 'not-found' as const }
      },
    },
  })
  const control = prepareEncryptedWalletBackupFrozenSnapshotControl({
    keyHandle: input.keyHandle,
    headEvidence: parentEvidence,
    snapshotNonce: '21'.repeat(16),
    snapshotId: SNAPSHOT_ID,
    snapshotRevision: 1,
  })
  const store = new BrowserManifestStore(snapshots, prepared, packs).bind(
    input.keyHandle,
    input.seed,
  )
  let current = await beginEncryptedWalletBackupFrozenSnapshot({ store, control })
  current = await appendEncryptedWalletBackupFrozenSnapshotProofPage({
    store,
    control,
    current,
    keyHandle: input.keyHandle,
    seed: input.seed,
    preparedRecords: prepared,
    preparedSnapshotStore: store,
  })
  const sealed = await sealEncryptedWalletBackupFrozenSnapshot({ store, control, current })
  await planEncryptedWalletBackupManifestPassA({ store, control, current: sealed })
  let page: PreparedEncryptedWalletBackupObject | null = null
  while (true) {
    const result = await persistNextEncryptedWalletBackupManifestPage({
      store,
      sourceStore: store,
      stagedPackProvider: store,
      snapshotStore: store,
      control,
      keyHandle: input.keyHandle,
      seed: input.seed,
      runtime: page === null ? input.pageRuntime : undefined,
    })
    if (result.state === 'completed') break
    page = result.page
  }
  if (page === null) throw new Error('browser vector bounded manifest page is missing')
  const target = await finalizeBoundedEncryptedWalletBackupManifestTarget({
    store,
    control,
    parentEvidence,
    keyHandle: input.keyHandle,
    seed: input.seed,
  })
  return Object.freeze({
    head: target.wire.canonicalHead,
    references: target.wire.canonicalReferenceSet,
    page,
  })
}

async function sealRecords(
  input: Parameters<typeof buildBoundedEncryptedWalletBackupManifestVector>[0],
  snapshots: ReadonlyMap<string, EncryptedWalletBackupPreparedRecordSnapshot>,
): Promise<readonly PersistedPreparedEncryptedWalletBackupRecord[]> {
  const snapshotStore = exactSnapshotStore(snapshots)
  return Object.freeze(
    await Promise.all(
      input.proofs.map((record) =>
        sealPreparedEncryptedWalletBackupRecord({
          keyHandle: input.keyHandle,
          seed: input.seed,
          record,
          snapshotStore,
        }),
      ),
    ),
  )
}

async function stagePacks(
  input: Parameters<typeof buildBoundedEncryptedWalletBackupManifestVector>[0],
  records: readonly PersistedPreparedEncryptedWalletBackupRecord[],
  snapshots: ReadonlyMap<string, EncryptedWalletBackupPreparedRecordSnapshot>,
): Promise<readonly StagedPack[]> {
  const ordered = records.slice().sort((left, right) => left.recordId.localeCompare(right.recordId))
  return Object.freeze(
    await Promise.all([
      stagePack(
        input,
        ordered.filter((_, index) => index % 2 === 0),
        snapshots,
        'build-a',
        'pack-a',
        0,
      ),
      stagePack(
        input,
        ordered.filter((_, index) => index % 2 === 1),
        snapshots,
        'build-b',
        'pack-b',
        1,
      ),
    ]),
  )
}

async function stagePack(
  input: Parameters<typeof buildBoundedEncryptedWalletBackupManifestVector>[0],
  records: readonly PersistedPreparedEncryptedWalletBackupRecord[],
  snapshots: ReadonlyMap<string, EncryptedWalletBackupPreparedRecordSnapshot>,
  buildId: string,
  packId: string,
  runtimeIndex: number,
): Promise<StagedPack> {
  const store = new BrowserPackStore()
  const base = {
    store,
    keyHandle: input.keyHandle,
    seed: input.seed,
    snapshotStore: exactSnapshotStore(snapshots),
    buildId,
    packId,
    snapshotId: SNAPSHOT_ID,
    snapshotRevision: 1,
  }
  const appended = await appendEncryptedWalletBackupPreparedRecordPage({
    ...base,
    expectedBuildVersion: 0,
    expectedPackVersion: 0,
    records,
  })
  const frozen = await freezeEncryptedWalletBackupPack({
    ...base,
    expectedBuildVersion: appended.buildCursor.version,
    expectedPackVersion: appended.packControl.version,
  })
  const prepared = await prepareEncryptedWalletBackupFrozenPackObject({
    ...base,
    expectedBuildVersion: frozen.buildCursor.version,
    expectedPackVersion: frozen.packControl.version,
    generation: 1,
    runtime: input.packRuntimes[runtimeIndex]!,
  })
  const staged = await stageEncryptedWalletBackupPackObject({
    store,
    prepared,
    expectedBuildVersion: frozen.buildCursor.version,
    expectedPackVersion: frozen.packControl.version,
  })
  return Object.freeze({
    buildId,
    packId,
    store,
    buildVersion: staged.buildCursor.version,
    packVersion: staged.packControl.version,
  })
}

function snapshotRows(proofs: readonly PreparedEncryptedWalletBackupProof[]) {
  return new Map(
    proofs.map((proof) => [
      proof.proofId,
      Object.freeze({
        schemaVersion: 1 as const,
        snapshotId: SNAPSHOT_ID,
        snapshotRevision: 1,
        recordId: proof.proofId,
        commitment: proof.commitment,
        recordKindCode: 0 as const,
      }),
    ]),
  )
}

function exactSnapshotStore(
  rows: ReadonlyMap<string, EncryptedWalletBackupPreparedRecordSnapshot>,
): EncryptedWalletBackupPreparedRecordSnapshotBatchStore & {
  withCommittedPreparedRecordSnapshot<T>(
    recordId: string,
    read: (row: EncryptedWalletBackupPreparedRecordSnapshot) => T,
  ): Promise<T>
} {
  return {
    async withCommittedPreparedRecordSnapshot(recordId, read) {
      const row = rows.get(recordId)
      if (row === undefined) throw new Error('browser vector prepared snapshot is missing')
      return read(structuredClone(row))
    },
    async withCommittedPreparedRecordSnapshotBatch(recordIds, read) {
      const values = recordIds.map((recordId) => {
        const row = rows.get(recordId)
        if (row === undefined) throw new Error('browser vector prepared snapshot is missing')
        return structuredClone(row)
      })
      return read(values)
    },
  }
}

type StagedPack = Readonly<{
  buildId: string
  packId: string
  store: BrowserPackStore
  buildVersion: number
  packVersion: number
}>

class BrowserManifestStore
  implements
    EncryptedWalletBackupSnapshotPersistenceStore,
    EncryptedWalletBackupFrozenSnapshotSealStore,
    EncryptedWalletBackupManifestPassAResultStore,
    EncryptedWalletBackupManifestPagePersistenceStore,
    EncryptedWalletBackupManifestTargetFinalizationStore,
    EncryptedWalletBackupPreparedRecordSnapshotBatchStore
{
  #control: Uint8Array | null = null
  #pins: Uint8Array[] = []
  #passA: Uint8Array | null = null
  #cursor: Uint8Array | null = null
  #prior: Uint8Array | null = null
  #pages: Uint8Array[] = []
  readonly #snapshots: ReadonlyMap<string, EncryptedWalletBackupPreparedRecordSnapshot>
  readonly #prepared: readonly PersistedPreparedEncryptedWalletBackupRecord[]
  readonly #packs: readonly StagedPack[]
  constructor(
    snapshots: ReadonlyMap<string, EncryptedWalletBackupPreparedRecordSnapshot>,
    prepared: readonly PersistedPreparedEncryptedWalletBackupRecord[],
    packs: readonly StagedPack[],
  ) {
    this.#snapshots = snapshots
    this.#prepared = prepared
    this.#packs = packs
  }
  async withExactVersionTransaction<T>(
    _expected: Parameters<
      EncryptedWalletBackupSnapshotPersistenceStore['withExactVersionTransaction']
    >[0],
    use: (transaction: EncryptedWalletBackupSnapshotPersistenceTransaction) => Promise<T>,
  ): Promise<unknown> {
    const control = this.#control?.slice() ?? null
    let next = control
    const pins: Uint8Array[] = []
    const value = await use({
      readSnapshotControl: async () => control?.slice() ?? null,
      insertSnapshotControl: async (row) => {
        if (control !== null) throw new Error('browser vector snapshot already exists')
        next = row.slice()
      },
      writeSnapshotControl: async (row) => {
        if (control === null) throw new Error('browser vector snapshot is missing')
        next = row.slice()
      },
      insertSnapshotPins: async ({ sourceDescriptors, pins: values }) => {
        if (sourceDescriptors.length !== values.length)
          throw new Error('browser vector snapshot pin count is invalid')
        pins.push(...values.map((value) => value.slice()))
      },
    })
    this.#control = next
    this.#pins.push(...pins)
    return value
  }
  async withSnapshotSealTransaction<T>(
    expected: Parameters<
      EncryptedWalletBackupFrozenSnapshotSealStore['withSnapshotSealTransaction']
    >[0],
    use: Parameters<EncryptedWalletBackupFrozenSnapshotSealStore['withSnapshotSealTransaction']>[1],
  ): Promise<unknown> {
    if (!bytesEqual(this.#control, expected.expectedControl))
      throw new Error('browser vector seal control is stale')
    const pins = this.pinsAfter(expected.exclusiveAfter)
      .slice(0, expected.reservedPinRows)
      .map((pin) => pin.slice())
    const value = await use({ control: this.#control!.slice(), pins })
    this.#control = expected.nextControl?.slice() ?? this.#control
    return value
  }
  async withManifestPassAResultTransaction<T>(
    _expected: Parameters<
      EncryptedWalletBackupManifestPassAResultStore['withManifestPassAResultTransaction']
    >[0],
    use: Parameters<
      EncryptedWalletBackupManifestPassAResultStore['withManifestPassAResultTransaction']
    >[1],
  ): Promise<unknown> {
    let next: Uint8Array | null = null
    const value = await use({
      control: this.#control?.slice() ?? null,
      result: this.#passA?.slice() ?? null,
      insertResult: async (result) => {
        next = result.slice()
      },
    })
    if (next !== null) this.#passA = next
    return value
  }
  async readManifestPageState() {
    return {
      control: this.#control?.slice() ?? null,
      passAResult: this.#passA?.slice() ?? null,
      cursor: this.#cursor?.slice() ?? null,
      currentPage: null,
      priorPage: this.#prior?.slice() ?? null,
    }
  }
  async withManifestPageTransaction<T>(
    _expected: Parameters<
      EncryptedWalletBackupManifestPagePersistenceStore['withManifestPageTransaction']
    >[0],
    use: (transaction: EncryptedWalletBackupManifestPagePersistenceTransaction) => Promise<T>,
  ): Promise<unknown> {
    let page: Uint8Array | null = null
    let cursor: Uint8Array | null = null
    const state = await this.readManifestPageState()
    const value = await use({
      ...state,
      insertPageAndAdvance: async (input) => {
        page = input.page.slice()
        cursor = input.cursor.slice()
      },
      completeEmptyCursor: async (input) => {
        cursor = input.slice()
      },
    })
    if (page !== null) {
      this.#pages.push(page)
      this.#prior = page.slice()
    }
    if (cursor !== null) this.#cursor = cursor
    return value
  }
  async withCommittedPreparedRecordSnapshotBatch<T>(
    recordIds: readonly string[],
    read: (rows: readonly EncryptedWalletBackupPreparedRecordSnapshot[]) => T,
  ): Promise<T> {
    return exactSnapshotStore(this.#snapshots).withCommittedPreparedRecordSnapshotBatch(
      recordIds,
      read,
    )
  }
  async readSourcePage(exclusiveAfter: Uint8Array | null, limit: number, maxBytes: number) {
    const rows = this.sourceRows()
      .filter((row) => exclusiveAfter === null || compareBytes(pinKey(row.pin), exclusiveAfter) > 0)
      .slice(0, limit)
    const serializedBytes = rows.reduce(
      (total, row) => total + measureEncryptedWalletBackupManifestSourceJoinRow(row),
      0,
    )
    if (serializedBytes > maxBytes)
      throw new Error('browser vector source page exceeds its capacity')
    return { rows: rows.map(copySourceRow), serializedBytes }
  }
  async rehydrateStagedPack(input: { readonly buildId: string; readonly packId: string }) {
    const pack = this.#packs.find(
      (candidate) => candidate.buildId === input.buildId && candidate.packId === input.packId,
    )
    if (pack === undefined) throw new Error('browser vector staged pack is missing')
    return rehydrateEncryptedWalletBackupStagedPackObject({
      store: pack.store,
      keyHandle: this.#keyHandle,
      seed: this.#seed,
      snapshotStore: this,
      buildId: pack.buildId,
      packId: pack.packId,
      snapshotId: SNAPSHOT_ID,
      snapshotRevision: 1,
      expectedBuildVersion: pack.buildVersion,
      expectedPackVersion: pack.packVersion,
    })
  }
  async readManifestFinalizationState() {
    if (this.#control === null || this.#passA === null || this.#cursor === null)
      throw new Error('browser vector finalization state is incomplete')
    return {
      control: this.#control.slice(),
      passAResult: this.#passA.slice(),
      cursor: this.#cursor.slice(),
    }
  }
  async readManifestFinalizationRows(input: {
    readonly exclusivePageIndex: number
    readonly maximumRows: number
    readonly maximumBytes: number
    readonly scope: Uint8Array
  }) {
    const rows: Uint8Array[] = []
    let bytes = 0
    for (const row of this.#pages.slice(input.exclusivePageIndex + 1)) {
      if (rows.length === input.maximumRows || bytes + row.byteLength > input.maximumBytes) break
      rows.push(row.slice())
      bytes += row.byteLength
    }
    return rows
  }
  #keyHandle!: EncryptedWalletBackupKeyHandle
  #seed!: Uint8Array
  bind(keyHandle: EncryptedWalletBackupKeyHandle, seed: Uint8Array): this {
    this.#keyHandle = keyHandle
    this.#seed = seed.slice()
    return this
  }
  private sourceRows(): readonly EncryptedWalletBackupManifestSourceJoinRow[] {
    return this.#prepared
      .map((prepared) => {
        const source = decodeEncryptedWalletBackupPreparedSourceDescriptor(
          encodeEncryptedWalletBackupPreparedSourceDescriptor(prepared),
        )
        const pin = encodeEncryptedWalletBackupSnapshotPin({
          schemaVersion: 1,
          realm: source.realm,
          vaultId: source.vaultId,
          snapshotId: SNAPSHOT_ID,
          snapshotRevision: 1,
          recordKindCode: 0,
          recordId: source.recordId,
          commitment: source.commitment,
          sourceBodyReference: source.bodyReference,
          sourceRevision: source.revision,
          canonicalManifestEntryBytes: source.canonicalManifestEntryBytes,
        })
        const index = this.#packs.findIndex(
          (pack) =>
            pack.packId === (this.#prepared.indexOf(prepared) % 2 === 0 ? 'pack-a' : 'pack-b'),
        )
        return Object.freeze({
          pin,
          prepared,
          buildId: this.#packs[index]!.buildId,
          packId: this.#packs[index]!.packId,
        })
      })
      .sort((left, right) => compareBytes(pinKey(left.pin), pinKey(right.pin)))
  }
  private pinsAfter(after: Uint8Array | null): readonly Uint8Array[] {
    return this.#pins
      .slice()
      .sort((left, right) => compareBytes(pinKey(left), pinKey(right)))
      .filter((pin) => after === null || compareBytes(pinKey(pin), after) > 0)
  }
}

class BrowserPackStore implements EncryptedWalletBackupPackPersistenceStore {
  build: PersistedEncryptedWalletBackupBuildCursor | null = null
  pack: PersistedEncryptedWalletBackupPackControl | null = null
  readonly prepared = new Map<string, PersistedEncryptedWalletBackupPreparedBuildRecord>()
  readonly bindings = new Map<string, PersistedEncryptedWalletBackupPackBinding>()
  readonly staged = new Map<string, PersistedEncryptedWalletBackupStagedObject>()
  async withExactVersionTransaction<T>(
    expected: Parameters<
      EncryptedWalletBackupPackPersistenceStore['withExactVersionTransaction']
    >[0],
    use: (transaction: EncryptedWalletBackupPackPersistenceTransaction) => Promise<T>,
  ): Promise<unknown> {
    if (
      (this.build?.version ?? 0) !== expected.buildVersion ||
      (this.pack?.version ?? 0) !== expected.packVersion
    )
      throw new Error('browser vector pack version is stale')
    return use({
      readBuildCursor: async (buildId) =>
        this.build?.buildId === buildId ? structuredClone(this.build) : null,
      readPackControl: async (buildId, packId) =>
        this.pack?.buildId === buildId && this.pack.packId === packId
          ? structuredClone(this.pack)
          : null,
      readPackRecordPage: async (buildId, packId, after, limit, maxBytes) =>
        this.readPage(buildId, packId, after, limit, maxBytes),
      readStagedObject: async (buildId, packId) => {
        const row = this.staged.get(`${buildId}:${packId}`)
        return row === undefined ? null : structuredClone(row)
      },
      insertPreparedRecord: async (row) => {
        this.prepared.set(`${row.buildId}:${row.recordId}`, structuredClone(row))
      },
      insertPackBinding: async (row) => {
        this.bindings.set(`${row.buildId}:${row.packId}:${row.recordId}`, structuredClone(row))
      },
      writeBuildCursor: async (row) => {
        this.build = structuredClone(row)
      },
      writePackControl: async (row) => {
        this.pack = structuredClone(row)
      },
      insertStagedObject: async (row) => {
        this.staged.set(`${row.buildId}:${row.packId}`, structuredClone(row))
      },
    })
  }
  private async readPage(
    buildId: string,
    packId: string,
    after: string | null,
    limit: number,
    maxBytes: number,
  ) {
    const rows = [...this.bindings.values()]
      .filter(
        (row) =>
          row.buildId === buildId &&
          row.packId === packId &&
          (after === null || row.recordId > after),
      )
      .sort((left, right) => left.recordId.localeCompare(right.recordId))
      .slice(0, limit)
      .map((binding) => ({
        binding: serializeEncryptedWalletBackupPackBinding(binding),
        prepared: serializeEncryptedWalletBackupPreparedBuildRecord(
          this.prepared.get(`${binding.buildId}:${binding.recordId}`)!,
        ),
      }))
    const serializedBytes = rows.reduce(
      (total, row) => total + row.binding.byteLength + row.prepared.byteLength,
      0,
    )
    if (serializedBytes > maxBytes) throw new Error('browser vector pack page exceeds its capacity')
    return { rows, serializedBytes }
  }
}

function deterministicRuntime(values: readonly Uint8Array[]): EncryptedWalletBackupRuntime {
  let offset = 0
  return {
    subtle: crypto.subtle,
    getRandomValues(target) {
      const value = values[offset++]
      if (value === undefined || value.byteLength !== target.byteLength)
        throw new Error('browser vector randomness is invalid')
      target.set(value)
      return target
    },
  }
}
function pinKey(pin: Uint8Array): Uint8Array {
  const value = decodeEncryptedWalletBackupSnapshotPin(pin)
  return encodeCanonicalBackupCbor([
    value.recordKindCode,
    hex(value.recordId),
    hex(value.commitment),
  ])
}
function hex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  return bytes
}
function copySourceRow(
  row: EncryptedWalletBackupManifestSourceJoinRow,
): EncryptedWalletBackupManifestSourceJoinRow {
  return { ...row, pin: row.pin.slice(), prepared: structuredClone(row.prepared) }
}
function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return left.byteLength - right.byteLength
}
function bytesEqual(left: Uint8Array | null, right: Uint8Array): boolean {
  return (
    left !== null &&
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  )
}
