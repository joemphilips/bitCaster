import Dexie from "dexie";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { decodeEncryptedWalletBackupPreparedSourceDescriptor } from "@bitcaster/client-sdk/encryptedWalletBackupPreparedRecordPersistence";
import {
  serializeEncryptedWalletBackupPackBinding,
  serializeEncryptedWalletBackupPreparedBuildRecord,
} from "@bitcaster/client-sdk/encryptedWalletBackupPackPersistence";
import {
  decodeEncryptedWalletBackupFrozenSnapshot,
  decodeEncryptedWalletBackupFrozenSnapshotScope,
  decodeEncryptedWalletBackupSnapshotPin,
  decodeEncryptedWalletBackupSnapshotPinOrderKey,
  encodeEncryptedWalletBackupSnapshotPin,
  validateEncryptedWalletBackupSnapshotSourcePinBinding,
  type EncryptedWalletBackupSnapshotPersistenceStore,
  type EncryptedWalletBackupSnapshotPersistenceTransaction,
} from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotPersistence";
import {
  decodeEncryptedWalletBackupManifestPageCursor,
  decodeEncryptedWalletBackupManifestPageRow,
  type EncryptedWalletBackupManifestPagePersistenceStore,
  type EncryptedWalletBackupManifestPagePersistenceTransaction,
  type EncryptedWalletBackupManifestPageState,
} from "@bitcaster/client-sdk/encryptedWalletBackupManifestPagePersistence";
import {
  measureEncryptedWalletBackupManifestSourceJoinRow,
  type EncryptedWalletBackupFrozenSnapshotSealStore,
  type EncryptedWalletBackupFrozenSnapshotSealTransaction,
  type EncryptedWalletBackupManifestPassAResultStore,
  type EncryptedWalletBackupManifestPassAResultTransaction,
  type EncryptedWalletBackupManifestSourceJoinStore,
  type EncryptedWalletBackupManifestTargetFinalizationStore,
} from "@bitcaster/client-sdk";
import type { EncryptedWalletBackupBoundedUploadObjectSource } from "@bitcaster/client-sdk/encryptedWalletBackupSync";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import type {
  BitcasterDB,
  EncryptedWalletBackupDexieControlRow,
  EncryptedWalletBackupDexiePackBindingRow,
  EncryptedWalletBackupDexieManifestPageRow,
  EncryptedWalletBackupDexiePreparedRecordRow,
  EncryptedWalletBackupDexiePreparedSourceRow,
  EncryptedWalletBackupDexieSnapshotPinRow,
} from "./proof-db";

const MAX_PAGE_ROWS = 256;
const MAX_PAGE_BYTES = 1_048_576;
const SNAPSHOT_PIN_PAGE_ROWS = 127;
const SOURCE_JOIN_PAGE_ROWS = 64;
const MAX_FINGERPRINT = "f".repeat(64);

export interface EncryptedWalletBackupSnapshotManifestDatabaseProfile {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly realm: string;
  readonly vaultId: string;
  readonly snapshotId?: string;
  readonly snapshotRevision?: number;
}

interface BoundSnapshotProfile {
  readonly realm: string;
  readonly vaultId: string;
  readonly snapshotId: string | undefined;
  readonly snapshotRevision: number | undefined;
}

/** Dexie mechanics for codec-owned snapshot and manifest state. */
export class EncryptedWalletBackupSnapshotManifestDexieStore
  implements
    EncryptedWalletBackupSnapshotPersistenceStore,
    EncryptedWalletBackupFrozenSnapshotSealStore,
    EncryptedWalletBackupManifestPassAResultStore,
    EncryptedWalletBackupManifestPagePersistenceStore,
    EncryptedWalletBackupManifestTargetFinalizationStore,
    EncryptedWalletBackupManifestSourceJoinStore,
    EncryptedWalletBackupBoundedUploadObjectSource
{
  readonly #database: BitcasterDB;
  readonly #realm: string;
  readonly #vaultId: string;
  readonly #snapshotId: string | undefined;
  readonly #snapshotRevision: number | undefined;

  constructor(profile: EncryptedWalletBackupSnapshotManifestDatabaseProfile) {
    requireProfile(profile);
    this.#database = profile.database;
    this.#realm = profile.realm;
    this.#vaultId = profile.vaultId;
    this.#snapshotId = profile.snapshotId;
    this.#snapshotRevision = profile.snapshotRevision;
  }

  async withExactVersionTransaction<T>(
    expected: Parameters<
      EncryptedWalletBackupSnapshotPersistenceStore["withExactVersionTransaction"]
    >[0],
    use: (transaction: EncryptedWalletBackupSnapshotPersistenceTransaction) => Promise<T>,
  ): Promise<unknown> {
    requireSnapshotReservation(expected);
    requireScopeProfile(expected.scope, this.#profile());
    const key = scopeKey(expected.scope);
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupSnapshotControls,
      this.#database.encryptedWalletBackupPreparedSources,
      this.#database.encryptedWalletBackupSnapshotPins,
      async () => {
        const control = await this.#database.encryptedWalletBackupSnapshotControls.get(key);
        requireStoredControlProfile(control, this.#profile());
        requireExpectedSnapshotVersion(control, expected.expectedVersion);
        const ledger = new SnapshotReservationLedger(expected, key);
        const result = await use(
          new SnapshotTransaction(this.#database, ledger, this.#profile(), control),
        );
        ledger.finish();
        return result;
      },
    );
  }

  async withSnapshotSealTransaction<T>(
    expected: Parameters<
      EncryptedWalletBackupFrozenSnapshotSealStore["withSnapshotSealTransaction"]
    >[0],
    use: (transaction: EncryptedWalletBackupFrozenSnapshotSealTransaction) => Promise<T>,
  ): Promise<unknown> {
    requireSealReservation(expected);
    requireScopeProfile(expected.scope, this.#profile());
    const key = scopeKey(expected.scope);
    const current = decodeEncryptedWalletBackupFrozenSnapshot(expected.expectedControl);
    requireSnapshotProfile(current, this.#profile());
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupSnapshotControls,
      this.#database.encryptedWalletBackupSnapshotPins,
      async () => {
        const control = await this.#database.encryptedWalletBackupSnapshotControls.get(key);
        requireStoredControlProfile(control, this.#profile());
        requireExactSnapshotControl(control, expected.expectedControl, expected.expectedVersion);
        const pins = await this.#readPinsAfter(
          current,
          expected.exclusiveAfter,
          expected.reservedPinRows,
        );
        requireUpperByteLimit(pins, expected.reservedPinBytes, "backup snapshot pin reservation");
        const result = await use({ control: control.canonical.slice(), pins: cloneBytes(pins) });
        if (expected.nextControl !== null) {
          requireSnapshotProfile(
            decodeEncryptedWalletBackupFrozenSnapshot(expected.nextControl),
            this.#profile(),
          );
          await this.#database.encryptedWalletBackupSnapshotControls.put(
            controlRow(key, expected.nextControl),
          );
        }
        return result;
      },
    );
  }

  async withManifestPassAResultTransaction<T>(
    expected: Parameters<
      EncryptedWalletBackupManifestPassAResultStore["withManifestPassAResultTransaction"]
    >[0],
    use: (transaction: EncryptedWalletBackupManifestPassAResultTransaction) => Promise<T>,
  ): Promise<unknown> {
    requirePassAReservation(expected);
    requireScopeProfile(expected.scope, this.#profile());
    const key = scopeKey(expected.scope);
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupSnapshotControls,
      this.#database.encryptedWalletBackupManifestPassAResults,
      async () => {
        const control = await this.#database.encryptedWalletBackupSnapshotControls.get(key);
        requireStoredControlProfile(control, this.#profile());
        const prior = await this.#database.encryptedWalletBackupManifestPassAResults.get(key);
        requireExactSnapshotControl(control, expected.expectedControl, expected.expectedVersion);
        requirePassAReadBytes(expected, control.canonical, prior?.canonical ?? null);
        const transaction = new PassAResultTransaction(
          this.#database,
          key,
          prior?.canonical ?? null,
          control.canonical,
          expected,
        );
        const result = await use({
          control: control.canonical.slice(),
          result: transaction.result,
          insertResult: transaction.insert,
        });
        transaction.finish();
        return result;
      },
    );
  }

  async readManifestPageState(
    input: Parameters<
      EncryptedWalletBackupManifestPagePersistenceStore["readManifestPageState"]
    >[0],
  ): Promise<EncryptedWalletBackupManifestPageState> {
    requireReadLimit(input.maximumRows, input.maximumBytes, 5);
    requireScopeProfile(input.scope, this.#profile());
    const key = scopeKey(input.scope);
    return this.#database.transaction(
      "r",
      this.#database.encryptedWalletBackupSnapshotControls,
      this.#database.encryptedWalletBackupManifestPassAResults,
      this.#database.encryptedWalletBackupManifestCursors,
      this.#database.encryptedWalletBackupManifestPages,
      async () =>
        readManifestState(
          this.#database,
          key,
          input.maximumRows,
          input.maximumBytes,
          this.#profile(),
        ),
    );
  }

  async withManifestPageTransaction<T>(
    expected: Parameters<
      EncryptedWalletBackupManifestPagePersistenceStore["withManifestPageTransaction"]
    >[0],
    use: (transaction: EncryptedWalletBackupManifestPagePersistenceTransaction) => Promise<T>,
  ): Promise<unknown> {
    requireManifestReservation(expected);
    requireScopeProfile(expected.scope, this.#profile());
    const key = scopeKey(expected.scope);
    return this.#database.transaction(
      "rw",
      this.#database.encryptedWalletBackupSnapshotControls,
      this.#database.encryptedWalletBackupManifestPassAResults,
      this.#database.encryptedWalletBackupManifestCursors,
      this.#database.encryptedWalletBackupManifestPages,
      async () => {
        const state = await readManifestState(
          this.#database,
          key,
          expected.reservedReadRows,
          expected.reservedReadBytes,
          this.#profile(),
        );
        requireExpectedManifestState(state, expected);
        const transaction = new ManifestPageTransaction(
          this.#database,
          key,
          state,
          expected,
          this.#profile(),
        );
        const result = await use(transaction);
        transaction.finish();
        return result;
      },
    );
  }

  async readManifestFinalizationState(
    input: Parameters<
      EncryptedWalletBackupManifestTargetFinalizationStore["readManifestFinalizationState"]
    >[0],
  ) {
    requireReadLimit(input.maximumRows, input.maximumBytes, 3);
    requireScopeProfile(input.scope, this.#profile());
    const key = scopeKey(input.scope);
    return this.#database.transaction(
      "r",
      this.#database.encryptedWalletBackupSnapshotControls,
      this.#database.encryptedWalletBackupManifestPassAResults,
      this.#database.encryptedWalletBackupManifestCursors,
      async () => {
        const [control, result, cursor] = await Promise.all([
          this.#database.encryptedWalletBackupSnapshotControls.get(key),
          this.#database.encryptedWalletBackupManifestPassAResults.get(key),
          this.#database.encryptedWalletBackupManifestCursors.get(key),
        ]);
        if (control === undefined || result === undefined || cursor === undefined)
          throw new Error("backup manifest finalization state is incomplete");
        requireSnapshotProfile(
          decodeEncryptedWalletBackupFrozenSnapshot(control.canonical),
          this.#profile(),
        );
        requireUpperByteLimit(
          [control.canonical, result.canonical, cursor.canonical],
          input.maximumBytes,
          "backup manifest finalization state",
        );
        return {
          control: control.canonical.slice(),
          passAResult: result.canonical.slice(),
          cursor: cursor.canonical.slice(),
        };
      },
    );
  }

  async readManifestFinalizationRows(
    input: Parameters<
      EncryptedWalletBackupManifestTargetFinalizationStore["readManifestFinalizationRows"]
    >[0],
  ): Promise<readonly Uint8Array[]> {
    requireReadLimit(input.maximumRows, input.maximumBytes, MAX_PAGE_ROWS);
    requireScopeProfile(input.scope, this.#profile());
    const control = await this.#database.encryptedWalletBackupSnapshotControls.get(
      scopeKey(input.scope),
    );
    if (control === undefined) throw new Error("backup snapshot control is absent");
    const snapshot = decodeEncryptedWalletBackupFrozenSnapshot(control.canonical);
    requireSnapshotProfile(snapshot, this.#profile());
    const rows: Uint8Array[] = [];
    let bytes = 0;
    await this.#database.encryptedWalletBackupManifestPages
      .where("[realm+vaultId+snapshotId+snapshotRevision+pageIndex]")
      .between(
        [
          snapshot.realm,
          snapshot.vaultId,
          snapshot.snapshotId,
          snapshot.snapshotRevision,
          input.exclusivePageIndex,
        ],
        [
          snapshot.realm,
          snapshot.vaultId,
          snapshot.snapshotId,
          snapshot.snapshotRevision,
          Dexie.maxKey,
        ],
        false,
        true,
      )
      .limit(input.maximumRows)
      .until((row) => {
        const decoded = decodeEncryptedWalletBackupManifestPageRow(row.canonical);
        requireManifestPageProfile(decoded, this.#profile());
        return bytes + row.canonical.byteLength > input.maximumBytes;
      })
      .each((row) => {
        const decoded = decodeEncryptedWalletBackupManifestPageRow(row.canonical);
        requireManifestPageProfile(decoded, this.#profile());
        bytes += row.canonical.byteLength;
        rows.push(row.canonical.slice());
      });
    return Object.freeze(rows);
  }

  async readSourcePage(exclusiveAfter: Uint8Array | null, limit: number, maxBytes: number) {
    const profile = this.#requireSnapshotProfile();
    requireReadLimit(limit, maxBytes, SOURCE_JOIN_PAGE_ROWS);
    return this.#database.transaction(
      "r",
      this.#database.encryptedWalletBackupSnapshotPins,
      this.#database.encryptedWalletBackupPreparedSources,
      this.#database.encryptedWalletBackupPackBindings,
      this.#database.encryptedWalletBackupPreparedRecords,
      async () => this.#readSourceRows(profile, exclusiveAfter, limit, maxBytes),
    );
  }

  async readManifestPageObject(
    input: Parameters<EncryptedWalletBackupBoundedUploadObjectSource["readManifestPageObject"]>[0],
  ) {
    return this.#readManifestPageObject(input);
  }

  async readProofChunkObject(
    input: Parameters<EncryptedWalletBackupBoundedUploadObjectSource["readProofChunkObject"]>[0],
  ) {
    return this.#readProofChunkObject(input);
  }

  async #readPinsAfter(
    current: ReturnType<typeof decodeEncryptedWalletBackupFrozenSnapshot>,
    exclusiveAfter: Uint8Array | null,
    limit: number,
  ): Promise<readonly Uint8Array[]> {
    const after = pinCursor(exclusiveAfter);
    const rows: EncryptedWalletBackupDexieSnapshotPinRow[] = [];
    await this.#database.encryptedWalletBackupSnapshotPins
      .where("[realm+vaultId+snapshotId+snapshotRevision+recordKindCode+recordId+commitment]")
      .between(
        [
          current.realm,
          current.vaultId,
          current.snapshotId,
          current.snapshotRevision,
          0,
          after.recordId,
          after.commitment ?? "",
        ],
        [
          current.realm,
          current.vaultId,
          current.snapshotId,
          current.snapshotRevision,
          0,
          MAX_FINGERPRINT,
          MAX_FINGERPRINT,
        ],
        after.commitment === null,
        false,
      )
      .limit(limit)
      .each((row) => rows.push(row));
    return rows.map((row) => row.canonical.slice());
  }

  #requireSnapshotProfile(): { snapshotId: string; snapshotRevision: number } {
    if (this.#snapshotId === undefined || this.#snapshotRevision === undefined)
      throw new Error("backup source snapshot profile is required");
    return { snapshotId: this.#snapshotId, snapshotRevision: this.#snapshotRevision };
  }

  #profile(): BoundSnapshotProfile {
    return {
      realm: this.#realm,
      vaultId: this.#vaultId,
      snapshotId: this.#snapshotId,
      snapshotRevision: this.#snapshotRevision,
    };
  }

  async #readSourceRows(
    profile: { snapshotId: string; snapshotRevision: number },
    exclusiveAfter: Uint8Array | null,
    limit: number,
    maxBytes: number,
  ) {
    const after = pinCursor(exclusiveAfter);
    const pins = await this.#database.encryptedWalletBackupSnapshotPins
      .where("[realm+vaultId+snapshotId+snapshotRevision+recordKindCode+recordId+commitment]")
      .between(
        [
          this.#realm,
          this.#vaultId,
          profile.snapshotId,
          profile.snapshotRevision,
          0,
          after.recordId,
          after.commitment ?? "",
        ],
        [
          this.#realm,
          this.#vaultId,
          profile.snapshotId,
          profile.snapshotRevision,
          0,
          MAX_FINGERPRINT,
          MAX_FINGERPRINT,
        ],
        after.commitment === null,
        false,
      )
      .limit(limit)
      .toArray();
    if (pins.length === 0) return { rows: [], serializedBytes: 0 };
    const rows = await this.#joinSourcePins(profile, pins, maxBytes);
    const serializedBytes = rows.reduce(
      (total, row) => total + measureEncryptedWalletBackupManifestSourceJoinRow(row),
      0,
    );
    if (serializedBytes > maxBytes) throw new Error("backup source page reservation is exceeded");
    return { rows, serializedBytes };
  }

  async #joinSourcePins(
    profile: { snapshotId: string; snapshotRevision: number },
    pins: readonly EncryptedWalletBackupDexieSnapshotPinRow[],
    maxBytes: number,
  ) {
    const decodedPins = pins.map((pin) => {
      const decoded = decodeEncryptedWalletBackupSnapshotPin(pin.canonical);
      requireSnapshotProfile(decoded, this.#profile());
      return decoded;
    });
    const sources = await this.#database.encryptedWalletBackupPreparedSources.bulkGet(
      pins.map((pin, index) => [
        this.#realm,
        this.#vaultId,
        0,
        pin.recordId,
        decodedPins[index]!.sourceRevision,
        decodedPins[index]!.sourceBodyReference,
      ]),
    );
    const bindingRows = await this.#database.encryptedWalletBackupPackBindings
      .where("[realm+vaultId+snapshotId+snapshotRevision+recordId]")
      .anyOf(
        pins.map(
          (pin) =>
            [
              this.#realm,
              this.#vaultId,
              profile.snapshotId,
              profile.snapshotRevision,
              pin.recordId,
            ] as never,
        ),
      )
      .limit(pins.length)
      .toArray();
    const bindings = new Map<string, EncryptedWalletBackupDexiePackBindingRow>();
    for (const binding of bindingRows) {
      if (bindings.has(binding.recordId))
        throw new Error("backup source pack binding is ambiguous");
      bindings.set(binding.recordId, binding);
    }
    const exactBindings = pins.map((pin) => {
      const binding = bindings.get(pin.recordId);
      if (binding === undefined) throw new Error("backup source pack binding is absent");
      return binding;
    });
    const readBytes = pins.reduce((total, pin, index) => {
      const source = sources[index];
      if (source === undefined) throw new Error("backup source changed");
      validateEncryptedWalletBackupSnapshotSourcePinBinding({
        sourceDescriptor: preparedSourceDescriptor(source),
        pin: pin.canonical,
      });
      return (
        total + pinBytes(pin) + preparedSourceBytes(source) + bindingBytes(exactBindings[index]!)
      );
    }, 0);
    if (readBytes > maxBytes) throw new Error("backup source page reservation is exceeded");
    const selected = largestPreparedPrefix(exactBindings, readBytes, maxBytes);
    if (selected === 0) throw new Error("backup source page cannot fit its first prepared record");
    const preparedRows = await this.#database.encryptedWalletBackupPreparedRecords.bulkGet(
      exactBindings
        .slice(0, selected)
        .map((binding, index) => [binding.buildId, pins[index]!.recordId]),
    );
    const preparedBytes = preparedRows.reduce((total, prepared, index) => {
      if (prepared === undefined) throw new Error("backup source prepared record is absent");
      const actual = preparedRecordBytes(prepared);
      if (
        prepared.preparedRecordSerializedBytes !==
        exactBindings[index]!.preparedRecordSerializedBytes
      )
        throw new Error("backup source prepared record size metadata is invalid");
      return total + actual;
    }, readBytes);
    if (preparedBytes > maxBytes) throw new Error("backup source page reservation is exceeded");
    return pins.slice(0, selected).map((pin, index) => {
      const source = sources[index];
      if (source === undefined) throw new Error("backup source changed");
      const prepared = preparedRows[index];
      if (prepared === undefined) throw new Error("backup source prepared record is absent");
      const binding = exactBindings[index]!;
      return {
        pin: pin.canonical.slice(),
        prepared: structuredClone(prepared.prepared),
        buildId: binding.buildId,
        packId: binding.packId,
      };
    });
  }

  async #readManifestPageObject(
    input: Parameters<EncryptedWalletBackupBoundedUploadObjectSource["readManifestPageObject"]>[0],
  ) {
    requireExactObjectRequest(input, this.#realm, this.#vaultId);
    const row = await this.#database.encryptedWalletBackupManifestPages
      .where("[realm+vaultId+generation+objectId+digest]")
      .equals([input.realm, input.vaultId, input.generation, input.objectId, input.digest])
      .first();
    if (row === undefined || row.canonical.byteLength > MAX_PAGE_BYTES)
      throw new Error("backup manifest object is absent");
    const decoded = decodeEncryptedWalletBackupManifestPageRow(row.canonical);
    requireManifestPageProfile(decoded, this.#profile());
    if (!sameObjectIdentity(decoded.object, input))
      throw new Error("backup manifest object identity is invalid");
    return structuredClone(decoded.object);
  }

  async #readProofChunkObject(
    input: Parameters<EncryptedWalletBackupBoundedUploadObjectSource["readProofChunkObject"]>[0],
  ) {
    requireExactObjectRequest(input, this.#realm, this.#vaultId);
    const row = await this.#database.encryptedWalletBackupStagedObjects
      .where("[realm+vaultId+generation+objectId+digest]")
      .equals([input.realm, input.vaultId, input.generation, input.objectId, input.digest] as never)
      .first();
    if (row === undefined || row.aad.byteLength + row.body.byteLength > MAX_PAGE_BYTES)
      throw new Error("backup proof object is absent");
    if (!sameObjectIdentity(row, input)) throw new Error("backup proof object identity is invalid");
    return {
      formatVersion: row.formatVersion,
      kindCode: row.kindCode,
      realm: row.realm,
      vaultId: row.vaultId,
      objectId: row.objectId,
      generation: row.generation,
      paddedLength: row.paddedLength,
      digest: row.digest,
      aad: row.aad.slice(),
      body: row.body.slice(),
    };
  }
}

class SnapshotTransaction implements EncryptedWalletBackupSnapshotPersistenceTransaction {
  readonly #database: BitcasterDB;
  readonly #ledger: SnapshotReservationLedger;
  readonly #profile: BoundSnapshotProfile;
  #currentControl: EncryptedWalletBackupDexieControlRow | undefined;

  constructor(
    database: BitcasterDB,
    ledger: SnapshotReservationLedger,
    profile: BoundSnapshotProfile,
    currentControl: EncryptedWalletBackupDexieControlRow | undefined,
  ) {
    this.#database = database;
    this.#ledger = ledger;
    this.#profile = profile;
    this.#currentControl = currentControl;
  }

  async readSnapshotControl(scope: Uint8Array): Promise<Uint8Array | null> {
    this.#ledger.readControl(scope);
    const canonical = this.#currentControl?.canonical ?? null;
    this.#ledger.readControlValue(canonical);
    return canonical?.slice() ?? null;
  }

  async insertSnapshotControl(canonical: Uint8Array): Promise<void> {
    requireSnapshotProfile(decodeEncryptedWalletBackupFrozenSnapshot(canonical), this.#profile);
    this.#ledger.writeControl(canonical, "insert");
    if (this.#currentControl !== undefined) throw new Error("backup snapshot control exists");
    const next = controlRow(this.#ledger.key, canonical);
    await this.#database.encryptedWalletBackupSnapshotControls.add(next);
    this.#currentControl = next;
  }

  async writeSnapshotControl(canonical: Uint8Array): Promise<void> {
    requireSnapshotProfile(decodeEncryptedWalletBackupFrozenSnapshot(canonical), this.#profile);
    this.#ledger.writeControl(canonical, "write");
    if (this.#currentControl === undefined) throw new Error("backup snapshot control is absent");
    const next = controlRow(this.#ledger.key, canonical);
    await this.#database.encryptedWalletBackupSnapshotControls.put(next);
    this.#currentControl = next;
  }

  async insertSnapshotPins(
    input: Readonly<{ sourceDescriptors: readonly Uint8Array[]; pins: readonly Uint8Array[] }>,
  ): Promise<void> {
    if (
      input.sourceDescriptors.length !== input.pins.length ||
      input.pins.length > SNAPSHOT_PIN_PAGE_ROWS
    )
      throw new Error("backup snapshot pins are invalid");
    this.#ledger.writePins(input.sourceDescriptors, input.pins);
    const entries = input.pins.map((canonicalPin, index) => {
      const sourceDescriptor = input.sourceDescriptors[index]!;
      const descriptor = decodeEncryptedWalletBackupPreparedSourceDescriptor(sourceDescriptor);
      const pin = decodeEncryptedWalletBackupSnapshotPin(canonicalPin);
      if (descriptor.realm !== this.#profile.realm || descriptor.vaultId !== this.#profile.vaultId)
        throw new Error("backup source is foreign");
      requireSnapshotProfile(pin, this.#profile);
      return { sourceDescriptor, descriptor, canonicalPin, pin };
    });
    const sources = await this.#database.encryptedWalletBackupPreparedSources.bulkGet(
      entries.map((entry) => [
        this.#profile.realm,
        this.#profile.vaultId,
        0,
        entry.descriptor.recordId,
        entry.descriptor.revision,
        entry.descriptor.bodyReference,
      ]),
    );
    const rows = entries.map((entry, index) => {
      const source = sources[index];
      if (
        source === undefined ||
        !equalBytes(preparedSourceDescriptor(source), entry.sourceDescriptor)
      )
        throw new Error("backup source changed before pin insertion");
      validateEncryptedWalletBackupSnapshotSourcePinBinding({
        sourceDescriptor: entry.sourceDescriptor,
        pin: entry.canonicalPin,
      });
      const control = this.#currentControl;
      if (control === undefined) throw new Error("backup snapshot control is absent");
      return pinRow(entry.pin, control.generation);
    });
    await this.#database.encryptedWalletBackupSnapshotPins.bulkAdd(rows);
  }
}

class SnapshotReservationLedger {
  readonly key: string;
  readonly #expected: Parameters<
    EncryptedWalletBackupSnapshotPersistenceStore["withExactVersionTransaction"]
  >[0];
  #readRows = 0;
  #readBytes = 0;
  #writeRows = 0;
  #writeBytes = 0;
  #controlRead = false;
  #controlReadValue = false;
  #controlWrite = false;
  #pinWrite = false;

  constructor(
    expected: Parameters<
      EncryptedWalletBackupSnapshotPersistenceStore["withExactVersionTransaction"]
    >[0],
    key: string,
  ) {
    this.#expected = expected;
    this.key = key;
  }

  readControl(scope: Uint8Array): void {
    if (this.#controlRead || scopeKey(scope) !== this.key)
      throw new Error("backup snapshot control read is invalid");
    this.#controlRead = true;
    this.#readRows += 1;
    this.#readBytes += scope.byteLength;
  }

  readControlValue(canonical: Uint8Array | null): void {
    if (this.#controlReadValue) throw new Error("backup snapshot control read is repeated");
    this.#controlReadValue = true;
    this.#readBytes += canonical?.byteLength ?? 0;
  }

  writeControl(canonical: Uint8Array, operation: "insert" | "write"): void {
    if (this.#controlWrite) throw new Error("backup snapshot control mutation is repeated");
    if (!(canonical instanceof Uint8Array) || canonical.byteLength < 1)
      throw new Error("backup snapshot control mutation is invalid");
    this.#controlWrite = true;
    this.#writeRows += 1;
    this.#writeBytes += canonical.byteLength;
    if (operation === "insert" && this.#expected.expectedVersion !== 0)
      throw new Error("backup snapshot control insertion is stale");
    if (operation === "write" && this.#expected.expectedVersion === 0)
      throw new Error("backup snapshot control update is stale");
  }

  writePins(sources: readonly Uint8Array[], pins: readonly Uint8Array[]): void {
    if (this.#pinWrite) throw new Error("backup snapshot pin mutation is repeated");
    this.#pinWrite = true;
    for (let index = 0; index < pins.length; index += 1) {
      if (!(sources[index] instanceof Uint8Array) || !(pins[index] instanceof Uint8Array))
        throw new Error("backup snapshot pins are invalid");
      this.#readRows += 1;
      this.#readBytes += sources[index]!.byteLength;
      this.#writeRows += 1;
      this.#writeBytes += pins[index]!.byteLength;
    }
  }

  finish(): void {
    if (!this.#controlRead || !this.#controlReadValue || !this.#controlWrite)
      throw new Error("backup snapshot transaction omitted a control operation");
    if (
      this.#readRows !== this.#expected.reservedReadRows ||
      this.#readBytes !== this.#expected.reservedReadBytes ||
      this.#writeRows !== this.#expected.reservedWriteRows ||
      this.#writeBytes !== this.#expected.reservedWriteBytes
    ) {
      throw new Error("backup snapshot transaction reservation does not match its operations");
    }
  }
}

class PassAResultTransaction {
  readonly result: Uint8Array | null;
  readonly insert: (canonical: Uint8Array) => Promise<void>;
  #inserted = false;
  readonly #database: BitcasterDB;
  readonly #key: string;
  readonly #prior: Uint8Array | null;
  readonly #control: Uint8Array;
  readonly #expected: Parameters<
    EncryptedWalletBackupManifestPassAResultStore["withManifestPassAResultTransaction"]
  >[0];

  constructor(
    database: BitcasterDB,
    key: string,
    prior: Uint8Array | null,
    control: Uint8Array,
    expected: Parameters<
      EncryptedWalletBackupManifestPassAResultStore["withManifestPassAResultTransaction"]
    >[0],
  ) {
    this.#database = database;
    this.#key = key;
    this.#prior = prior;
    this.#control = control;
    this.#expected = expected;
    this.result = prior?.slice() ?? null;
    this.insert = (canonical) => this.#insert(canonical);
  }

  async #insert(canonical: Uint8Array): Promise<void> {
    if (this.#inserted || this.#prior !== null)
      throw new Error("backup manifest Pass-A result conflicts");
    if (
      !(canonical instanceof Uint8Array) ||
      canonical.byteLength > this.#expected.reservedWriteBytes
    )
      throw new Error("backup manifest Pass-A result exceeds its reservation");
    this.#inserted = true;
    await this.#database.encryptedWalletBackupManifestPassAResults.add(
      scopedCanonicalRow(this.#key, this.#control, canonical),
    );
  }

  finish(): void {
    if (this.#inserted && this.#expected.reservedWriteRows < 1)
      throw new Error("backup manifest Pass-A result exceeds its reservation");
  }
}

class ManifestPageTransaction implements EncryptedWalletBackupManifestPagePersistenceTransaction {
  readonly control: Uint8Array | null;
  readonly passAResult: Uint8Array | null;
  readonly cursor: Uint8Array | null;
  readonly currentPage: Uint8Array | null;
  readonly priorPage: Uint8Array | null;
  #wrote = false;
  readonly #database: BitcasterDB;
  readonly #key: string;
  readonly #expected: Parameters<
    EncryptedWalletBackupManifestPagePersistenceStore["withManifestPageTransaction"]
  >[0];
  readonly #profile: BoundSnapshotProfile;

  constructor(
    database: BitcasterDB,
    key: string,
    state: EncryptedWalletBackupManifestPageState,
    expected: Parameters<
      EncryptedWalletBackupManifestPagePersistenceStore["withManifestPageTransaction"]
    >[0],
    profile: BoundSnapshotProfile,
  ) {
    this.#database = database;
    this.#key = key;
    this.#expected = expected;
    this.#profile = profile;
    this.control = state.control?.slice() ?? null;
    this.passAResult = state.passAResult?.slice() ?? null;
    this.cursor = state.cursor?.slice() ?? null;
    this.currentPage = state.currentPage?.slice() ?? null;
    this.priorPage = state.priorPage?.slice() ?? null;
  }

  async insertPageAndAdvance(
    input: Readonly<{ page: Uint8Array; cursor: Uint8Array }>,
  ): Promise<void> {
    this.#requireWrite([input.page, input.cursor]);
    const decoded = decodeEncryptedWalletBackupManifestPageRow(input.page);
    requireManifestPageProfile(decoded, this.#profile);
    requireSnapshotProfile(
      decodeEncryptedWalletBackupManifestPageCursor(input.cursor),
      this.#profile,
    );
    await this.#database.encryptedWalletBackupManifestPages.add(pageRow(decoded, input.page));
    await this.#database.encryptedWalletBackupManifestCursors.put(
      scopedCanonicalRow(this.#key, this.control!, input.cursor),
    );
  }

  async completeEmptyCursor(cursor: Uint8Array): Promise<void> {
    this.#requireWrite([cursor]);
    requireSnapshotProfile(decodeEncryptedWalletBackupManifestPageCursor(cursor), this.#profile);
    await this.#database.encryptedWalletBackupManifestCursors.put(
      scopedCanonicalRow(this.#key, this.control!, cursor),
    );
  }

  #requireWrite(values: readonly Uint8Array[]): void {
    if (this.#wrote) throw new Error("backup manifest page mutation is repeated");
    if (
      values.length !== this.#expected.reservedWriteRows ||
      sumBytes(values) !== this.#expected.reservedWriteBytes
    )
      throw new Error("backup manifest page write reservation is invalid");
    this.#wrote = true;
  }

  finish(): void {
    if (!this.#wrote) throw new Error("backup manifest page transaction omitted its mutation");
  }
}

async function readManifestState(
  database: BitcasterDB,
  key: string,
  maximumRows: number,
  maximumBytes: number,
  profile: BoundSnapshotProfile,
): Promise<EncryptedWalletBackupManifestPageState> {
  const [control, result, cursor] = await Promise.all([
    database.encryptedWalletBackupSnapshotControls.get(key),
    database.encryptedWalletBackupManifestPassAResults.get(key),
    database.encryptedWalletBackupManifestCursors.get(key),
  ]);
  requireStoredControlProfile(control, profile);
  const pageIndex =
    cursor === undefined
      ? 0
      : decodeEncryptedWalletBackupManifestPageCursor(cursor.canonical).nextPageIndex;
  const snapshot =
    control === undefined ? null : decodeEncryptedWalletBackupFrozenSnapshot(control.canonical);
  const [current, prior] =
    snapshot === null
      ? [undefined, undefined]
      : await Promise.all([
          database.encryptedWalletBackupManifestPages.get([
            snapshot.realm,
            snapshot.vaultId,
            snapshot.snapshotId,
            snapshot.snapshotRevision,
            pageIndex,
          ]),
          pageIndex > 0
            ? database.encryptedWalletBackupManifestPages.get([
                snapshot.realm,
                snapshot.vaultId,
                snapshot.snapshotId,
                snapshot.snapshotRevision,
                pageIndex - 1,
              ])
            : undefined,
        ]);
  const values = [
    control?.canonical,
    result?.canonical,
    cursor?.canonical,
    current?.canonical,
    prior?.canonical,
  ].filter((value): value is Uint8Array => value !== undefined);
  if (values.length > maximumRows || sumBytes(values) > maximumBytes)
    throw new Error("backup manifest state exceeds its capacity");
  return {
    control: control?.canonical.slice() ?? null,
    passAResult: result?.canonical.slice() ?? null,
    cursor: cursor?.canonical.slice() ?? null,
    currentPage: current?.canonical.slice() ?? null,
    priorPage: prior?.canonical.slice() ?? null,
  };
}

function requireProfile(profile: EncryptedWalletBackupSnapshotManifestDatabaseProfile): void {
  if (
    typeof profile !== "object" ||
    profile === null ||
    !(profile.database instanceof Dexie) ||
    typeof profile.realm !== "string" ||
    profile.realm.length < 1 ||
    profile.realm.length > 64 ||
    !/^[0-9a-f]{64}$/.test(profile.vaultId) ||
    profile.database.name !== browserWalletDatabaseName(profile.scopeId)
  ) {
    throw new Error("encrypted wallet backup snapshot database profile is invalid");
  }
  if ((profile.snapshotId === undefined) !== (profile.snapshotRevision === undefined))
    throw new Error("backup source snapshot profile is invalid");
}

function requireScopeProfile(scope: Uint8Array, profile: BoundSnapshotProfile): void {
  requireSnapshotProfile(decodeEncryptedWalletBackupFrozenSnapshotScope(scope), profile);
}

function requireStoredControlProfile(
  control: EncryptedWalletBackupDexieControlRow | undefined,
  profile: BoundSnapshotProfile,
): void {
  if (control !== undefined)
    requireSnapshotProfile(decodeEncryptedWalletBackupFrozenSnapshot(control.canonical), profile);
}

function requireSnapshotProfile(
  snapshot: {
    readonly realm: string;
    readonly vaultId: string;
    readonly snapshotId: string;
    readonly snapshotRevision: number;
  },
  profile: BoundSnapshotProfile,
): void {
  if (
    snapshot.realm !== profile.realm ||
    snapshot.vaultId !== profile.vaultId ||
    (profile.snapshotId !== undefined && snapshot.snapshotId !== profile.snapshotId) ||
    (profile.snapshotRevision !== undefined &&
      snapshot.snapshotRevision !== profile.snapshotRevision)
  ) {
    throw new Error("backup snapshot does not match the bound wallet profile");
  }
}

function requireManifestPageProfile(
  page: ReturnType<typeof decodeEncryptedWalletBackupManifestPageRow>,
  profile: BoundSnapshotProfile,
): void {
  requireSnapshotProfile(page, profile);
}

function requireSnapshotReservation(
  expected: Parameters<
    EncryptedWalletBackupSnapshotPersistenceStore["withExactVersionTransaction"]
  >[0],
): void {
  requireReservation(
    expected.reservedReadRows,
    expected.reservedReadBytes,
    expected.reservedWriteRows,
    expected.reservedWriteBytes,
  );
}

function requireSealReservation(
  expected: Parameters<
    EncryptedWalletBackupFrozenSnapshotSealStore["withSnapshotSealTransaction"]
  >[0],
): void {
  if (expected.reservedPinRows < 0 || expected.reservedPinRows > 255)
    throw new Error("backup snapshot seal reservation is invalid");
  requireReadLimit(expected.reservedPinRows, expected.reservedPinBytes, 255);
}

function requirePassAReservation(
  expected: Parameters<
    EncryptedWalletBackupManifestPassAResultStore["withManifestPassAResultTransaction"]
  >[0],
): void {
  requireReservation(
    expected.reservedReadRows,
    expected.reservedReadBytes,
    expected.reservedWriteRows,
    expected.reservedWriteBytes,
  );
  if (expected.reservedReadRows !== 2 || expected.reservedWriteRows > 1)
    throw new Error("backup manifest Pass-A reservation is invalid");
}

function requireManifestReservation(
  expected: Parameters<
    EncryptedWalletBackupManifestPagePersistenceStore["withManifestPageTransaction"]
  >[0],
): void {
  requireReservation(
    expected.reservedReadRows,
    expected.reservedReadBytes,
    expected.reservedWriteRows,
    expected.reservedWriteBytes,
  );
  if (
    expected.reservedReadRows > 5 ||
    expected.reservedWriteRows < 1 ||
    expected.reservedWriteRows > 2
  )
    throw new Error("backup manifest page reservation is invalid");
  const state = [
    expected.expectedControl,
    expected.expectedPassAResult,
    expected.expectedCursor,
    expected.expectedCurrentPage,
    expected.expectedPriorPage,
  ].filter((value): value is Uint8Array => value !== null);
  if (
    expected.reservedReadRows !== state.length + 1 ||
    expected.reservedReadBytes !== expected.scope.byteLength + sumBytes(state)
  ) {
    throw new Error("backup manifest page reservation is invalid");
  }
}

function requireExpectedSnapshotVersion(
  control: EncryptedWalletBackupDexieControlRow | undefined,
  expectedVersion: number,
): void {
  if (
    control === undefined
      ? expectedVersion !== 0
      : decodeEncryptedWalletBackupFrozenSnapshot(control.canonical).version !== expectedVersion
  )
    throw new Error("backup snapshot version is stale");
}

function requireExactSnapshotControl(
  control: EncryptedWalletBackupDexieControlRow | undefined,
  expectedControl: Uint8Array,
  expectedVersion: number,
): asserts control is EncryptedWalletBackupDexieControlRow {
  if (
    control === undefined ||
    !equalBytes(control.canonical, expectedControl) ||
    decodeEncryptedWalletBackupFrozenSnapshot(control.canonical).version !== expectedVersion
  ) {
    throw new Error("backup snapshot control is stale");
  }
}

function requirePassAReadBytes(
  expected: Parameters<
    EncryptedWalletBackupManifestPassAResultStore["withManifestPassAResultTransaction"]
  >[0],
  control: Uint8Array,
  prior: Uint8Array | null,
): void {
  const bytes = expected.scope.byteLength + control.byteLength + (prior?.byteLength ?? 0);
  if (bytes > expected.reservedReadBytes)
    throw new Error("backup manifest Pass-A read reservation is exceeded");
}

function requireExpectedManifestState(
  state: EncryptedWalletBackupManifestPageState,
  expected: Parameters<
    EncryptedWalletBackupManifestPagePersistenceStore["withManifestPageTransaction"]
  >[0],
): void {
  if (
    !equalNullable(state.control, expected.expectedControl) ||
    !equalNullable(state.passAResult, expected.expectedPassAResult) ||
    !equalNullable(state.cursor, expected.expectedCursor) ||
    !equalNullable(state.currentPage, expected.expectedCurrentPage) ||
    !equalNullable(state.priorPage, expected.expectedPriorPage)
  ) {
    throw new Error("backup manifest state is stale");
  }
}

function requireExactObjectRequest(
  input: { realm: string; vaultId: string; maximumRows: number; maximumBytes: number },
  realm: string,
  vaultId: string,
): void {
  if (
    input.realm !== realm ||
    input.vaultId !== vaultId ||
    input.maximumRows !== 1 ||
    input.maximumBytes !== MAX_PAGE_BYTES
  ) {
    throw new Error("backup object read is outside its profile");
  }
}

function sameObjectIdentity(
  value: { realm: string; vaultId: string; generation: number; objectId: string; digest: string },
  expected: {
    realm: string;
    vaultId: string;
    generation: number;
    objectId: string;
    digest: string;
  },
): boolean {
  return (
    value.realm === expected.realm &&
    value.vaultId === expected.vaultId &&
    value.generation === expected.generation &&
    value.objectId === expected.objectId &&
    value.digest === expected.digest
  );
}

function scopeKey(scope: Uint8Array): string {
  if (!(scope instanceof Uint8Array)) throw new Error("backup snapshot scope is invalid");
  return bytesToHex(scope);
}

function controlRow(scope: string, canonical: Uint8Array): EncryptedWalletBackupDexieControlRow {
  return scopedCanonicalRow(scope, canonical, canonical);
}

function scopedCanonicalRow(
  scope: string,
  snapshotControl: Uint8Array,
  canonical: Uint8Array,
): EncryptedWalletBackupDexieControlRow {
  const value = decodeEncryptedWalletBackupFrozenSnapshot(snapshotControl);
  return {
    scopeKey: scope,
    realm: value.realm,
    vaultId: value.vaultId,
    snapshotId: value.snapshotId,
    snapshotRevision: value.snapshotRevision,
    generation: value.generation,
    canonical: canonical.slice(),
  };
}

function pinRow(
  value: ReturnType<typeof decodeEncryptedWalletBackupSnapshotPin>,
  generation: number,
): EncryptedWalletBackupDexieSnapshotPinRow {
  return {
    realm: value.realm,
    vaultId: value.vaultId,
    snapshotId: value.snapshotId,
    snapshotRevision: value.snapshotRevision,
    generation,
    recordKindCode: 0,
    recordId: value.recordId,
    commitment: value.commitment,
    sourceRevision: value.sourceRevision,
    sourceBodyReference: value.sourceBodyReference,
    canonical: encodeEncryptedWalletBackupSnapshotPin(value),
  };
}

function pageRow(
  value: ReturnType<typeof decodeEncryptedWalletBackupManifestPageRow>,
  canonical: Uint8Array,
): EncryptedWalletBackupDexieManifestPageRow {
  return {
    realm: value.realm,
    vaultId: value.vaultId,
    snapshotId: value.snapshotId,
    snapshotRevision: value.snapshotRevision,
    pageIndex: value.pageIndex,
    generation: value.generation,
    objectId: value.object.objectId,
    digest: value.object.digest,
    canonical: canonical.slice(),
  };
}

function requireReservation(
  readRows: number,
  readBytes: number,
  writeRows: number,
  writeBytes: number,
): void {
  if (
    ![readRows, readBytes, writeRows, writeBytes].every(Number.isSafeInteger) ||
    readRows < 0 ||
    writeRows < 0 ||
    readBytes < 0 ||
    writeBytes < 0 ||
    readRows + writeRows > MAX_PAGE_ROWS ||
    readBytes + writeBytes > MAX_PAGE_BYTES
  ) {
    throw new Error("backup transaction reservation is invalid");
  }
}

function requireReadLimit(rows: number, bytes: number, maximumRows: number): void {
  if (
    !Number.isSafeInteger(rows) ||
    !Number.isSafeInteger(bytes) ||
    rows < 0 ||
    rows > maximumRows ||
    bytes < 0 ||
    bytes > MAX_PAGE_BYTES
  ) {
    throw new Error("backup read reservation is invalid");
  }
}

function requireUpperByteLimit(
  values: readonly Uint8Array[],
  maximumBytes: number,
  name: string,
): void {
  if (sumBytes(values) > maximumBytes) throw new Error(`${name} is exceeded`);
}

function sumBytes(values: readonly Uint8Array[]): number {
  return values.reduce((total, value) => total + value.byteLength, 0);
}

function cloneBytes(values: readonly Uint8Array[]): readonly Uint8Array[] {
  return values.map((value) => value.slice());
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function equalNullable(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null || right === null ? left === right : equalBytes(left, right);
}

function pinCursor(value: Uint8Array | null): { recordId: string; commitment: string | null } {
  // Identifiers are fixed non-empty lower-case hex. An empty string is a
  // portable IndexedDB lower bound for the first exclusive keyset page.
  if (value === null) return { recordId: "", commitment: null };
  const decoded = decodeEncryptedWalletBackupSnapshotPinOrderKey(value);
  return { recordId: decoded.recordId, commitment: decoded.commitment };
}

function preparedSourceDescriptor(row: EncryptedWalletBackupDexiePreparedSourceRow): Uint8Array {
  const descriptor = decodeEncryptedWalletBackupPreparedSourceDescriptor(row.canonicalDescriptor);
  if (
    descriptor.realm !== row.realm ||
    descriptor.vaultId !== row.vaultId ||
    descriptor.recordId !== row.recordId ||
    descriptor.commitment !== row.commitment ||
    descriptor.bodyReference !== row.bodyReference ||
    descriptor.revision !== row.revision
  ) {
    throw new Error("backup source changed");
  }
  return row.canonicalDescriptor.slice();
}

function bindingBytes(row: EncryptedWalletBackupDexiePackBindingRow): number {
  if (
    !Number.isSafeInteger(row.preparedRecordSerializedBytes) ||
    row.preparedRecordSerializedBytes < 1
  ) {
    throw new Error("backup source prepared record size metadata is invalid");
  }
  const { preparedRecordSerializedBytes, ...binding } = row;
  return physicalMetadataRowBytes(
    "dexie-encrypted-wallet-backup-pack-binding",
    serializeEncryptedWalletBackupPackBinding(binding).byteLength,
    preparedRecordSerializedBytes,
  );
}

function largestPreparedPrefix(
  bindings: readonly EncryptedWalletBackupDexiePackBindingRow[],
  initialBytes: number,
  maxBytes: number,
): number {
  let total = initialBytes;
  let count = 0;
  for (const binding of bindings) {
    const next = total + preparedRecordPhysicalBytes(binding.preparedRecordSerializedBytes);
    if (next > maxBytes) break;
    total = next;
    count += 1;
  }
  return count;
}

function preparedRecordBytes(row: EncryptedWalletBackupDexiePreparedRecordRow): number {
  const { preparedRecordSerializedBytes, ...prepared } = row;
  const actual = serializeEncryptedWalletBackupPreparedBuildRecord(prepared).byteLength;
  if (row.preparedRecordSerializedBytes !== actual)
    throw new Error("backup source prepared record size metadata is invalid");
  return physicalMetadataRowBytes(
    "dexie-encrypted-wallet-backup-prepared-record",
    actual,
    preparedRecordSerializedBytes,
  );
}

function preparedRecordPhysicalBytes(preparedRecordSerializedBytes: number): number {
  if (!Number.isSafeInteger(preparedRecordSerializedBytes) || preparedRecordSerializedBytes < 1)
    throw new Error("backup source prepared record size metadata is invalid");
  return physicalMetadataRowBytes(
    "dexie-encrypted-wallet-backup-prepared-record",
    preparedRecordSerializedBytes,
    preparedRecordSerializedBytes,
  );
}

function physicalMetadataRowBytes(label: string, canonicalBytes: number, metadata: number): number {
  return (
    canonicalCborHeadBytes(4) +
    canonicalCborHeadBytes(1) +
    canonicalCborTextBytes(label) +
    canonicalCborByteStringBytes(canonicalBytes) +
    canonicalCborHeadBytes(metadata)
  );
}

function canonicalCborTextBytes(value: string): number {
  return canonicalCborByteStringBytes(new TextEncoder().encode(value).byteLength);
}

function canonicalCborByteStringBytes(length: number): number {
  return canonicalCborHeadBytes(length) + length;
}

function canonicalCborHeadBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("backup source row byte length is invalid");
  if (value < 24) return 1;
  if (value <= 0xff) return 2;
  if (value <= 0xffff) return 3;
  if (value <= 0xffffffff) return 5;
  return 9;
}

function pinBytes(row: EncryptedWalletBackupDexieSnapshotPinRow): number {
  return encodeCanonicalBackupCbor([
    1,
    "dexie-encrypted-wallet-backup-snapshot-pin",
    row.realm,
    row.vaultId,
    row.snapshotId,
    row.snapshotRevision,
    row.recordKindCode,
    row.recordId,
    row.commitment,
    row.canonical,
  ]).byteLength;
}

function preparedSourceBytes(row: EncryptedWalletBackupDexiePreparedSourceRow): number {
  return encodeCanonicalBackupCbor([
    1,
    "dexie-encrypted-wallet-backup-prepared-source",
    row.realm,
    row.vaultId,
    row.recordKindCode,
    row.recordId,
    row.commitment,
    row.bodyReference,
    row.revision,
    row.snapshotId,
    row.snapshotRevision,
    row.canonicalDescriptor,
  ]).byteLength;
}
