import Dexie, { type Transaction } from "dexie";
import type { CounterRange, CounterSource } from "@cashu/cashu-ts";
import {
  decodeDurableCustodyScopeId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { isCanonicalNut02V2KeysetId } from "@bitcaster/client-sdk/durableSeedDerivedOutputs";
import { parseCashuProofUnit, type CashuProofUnit } from "@bitcaster/client-sdk/marketUnits";
import {
  counterCtfRangePreparationIdentity,
  createCounterCtfRangePreparation,
  planCounterCtfRangePreparation,
  type CtfRangePreparationIntent,
  type PersistedCtfRangeOrderPreparationV2,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import { activeBrowserWalletScopeId, browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { normalizeUrl } from "@/lib/url";
import { advanceBrowserV2DesiredAssetsForCounter } from "./browser-encrypted-wallet-backup-v2-desired-asset";
import {
  insertCtfRangePreparationInTransaction,
  readCtfRangePreparationForIntentInTransaction,
} from "./ctf-range-order-db";
import type { BitcasterDB } from "./proof-db";

export const BROWSER_WALLET_COUNTER_ASSOCIATION_MAX = 256;
export const BROWSER_WALLET_COUNTER_SNAPSHOT_MAX = 256;

export type BrowserWalletCounterErrorCode =
  | "invalid_counter"
  | "invalid_keyset"
  | "invalid_unit"
  | "stale_profile"
  | "foreign_database"
  | "association_limit"
  | "snapshot_limit"
  | "recovery_incomplete";

export class BrowserWalletCounterError extends Error {
  constructor(
    readonly code: BrowserWalletCounterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserWalletCounterError";
  }
}

export class BrowserWalletCounterSnapshotConflictError extends Error {
  constructor() {
    super("browser wallet counter snapshot changed");
    this.name = "BrowserWalletCounterSnapshotConflictError";
  }
}

export interface BrowserWalletCounterAdvanceResult {
  readonly changed: boolean;
  readonly next: number;
}

export interface BrowserCtfPreparationReservationResult {
  readonly record: import("@bitcaster/client-sdk/ctfRangeOrderJournal").CtfRangeOrderPreparationRecord;
  readonly replayed: boolean;
}

export interface BrowserWalletCounterDexieProfile {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly isCurrentProfile?: () => boolean;
}

export interface BrowserWalletCounterContext {
  readonly mintUrl: string;
  readonly unit: CashuProofUnit | string;
}

interface NormalizedBrowserWalletCounterContext {
  readonly normalizedMint: string;
  readonly unit: CashuProofUnit;
}

type BrowserWalletCounterContextInput =
  | BrowserWalletCounterContext
  | NormalizedBrowserWalletCounterContext;

/** The seed-scoped authoritative NUT-13 cursor store. */
export class BrowserWalletCounterDexieStore {
  readonly #database: BitcasterDB;
  readonly #scopeId: string;
  readonly #isCurrentProfile: (() => boolean) | undefined;

  constructor(profile: BrowserWalletCounterDexieProfile) {
    this.#database = profile.database;
    this.#scopeId = requireScope(profile.scopeId);
    this.#isCurrentProfile = profile.isCurrentProfile;
    this.#requireBoundDatabase();
  }

  async reserveInContext(
    context: BrowserWalletCounterContextInput,
    keysetId: string,
    n: number,
    requireRecoveryComplete: boolean,
  ): Promise<CounterRange> {
    const id = requireKeysetId(keysetId);
    const count = requireCounter(n);
    const association = requireContext(context);
    this.#requireCurrentProfile();
    return this.#database.transaction(
      "rw",
      [
        this.#database.walletCounterAssociations,
        this.#database.walletCounterCursors,
        this.#database.custodyProofs,
        this.#database.custodyProofBackupAuthorities,
        this.#database.custodyConditionalKeysets,
        this.#database.encryptedWalletBackupV2DesiredAssets,
      ],
      async () => {
        const row = await this.#ensureAssociation(association, id);
        if (requireRecoveryComplete && !row.recoveryComplete) this.#throwRecoveryIncomplete();
        return this.#reserveInTransaction(association, id, count);
      },
    );
  }

  /** Atomically reserve both CTF output ranges and retain their replay receipt. */
  async reserveCtfPreparationInContext(input: {
    readonly context: BrowserWalletCounterContextInput;
    readonly preparation: PersistedCtfRangeOrderPreparationV2;
    readonly intent: CtfRangePreparationIntent;
    readonly seed: Uint8Array;
    readonly createdAtMs: number;
  }): Promise<BrowserCtfPreparationReservationResult> {
    const association = requireContext(input.context);
    const intentScopeId = input.intent.scopeId;
    if (intentScopeId !== this.#scopeId) {
      throw new BrowserWalletCounterError(
        "foreign_database",
        "CTF preparation intent belongs to another wallet profile",
      );
    }
    const seedScopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: deriveDurableCustodyWalletId(input.seed),
    });
    if (seedScopeId !== this.#scopeId) {
      throw new BrowserWalletCounterError(
        "foreign_database",
        "CTF preparation seed belongs to another wallet profile",
      );
    }
    const preparation = input.preparation;
    const offerKeysetId = requireKeysetId(preparation.offerKeyset.id);
    const receiveKeysetId = requireKeysetId(preparation.receiveKeyset.id);
    if (offerKeysetId === receiveKeysetId) {
      throw new BrowserWalletCounterError("invalid_keyset", "CTF keysets must be distinct");
    }
    if (
      association.normalizedMint !== normalizeUrl(preparation.mintUrl) ||
      association.unit !== parseCashuProofUnit(preparation.offerKeyset.unit) ||
      association.unit !== parseCashuProofUnit(preparation.receiveKeyset.unit)
    ) {
      throw new BrowserWalletCounterError("invalid_unit", "CTF counter context is inconsistent");
    }
    this.#requireCurrentProfile();
    return this.#database.transaction(
      "rw",
      [
        this.#database.walletCounterAssociations,
        this.#database.walletCounterCursors,
        this.#database.custodyProofs,
        this.#database.custodyProofBackupAuthorities,
        this.#database.custodyConditionalKeysets,
        this.#database.encryptedWalletBackupV2DesiredAssets,
        this.#database.ctfRangePreparations,
      ],
      async (transaction) => {
        this.#requireCurrentProfile();
        const replay = await readCtfRangePreparationForIntentInTransaction(
          transaction,
          input.intent,
          this.#database,
        );
        if (replay !== null) return { record: replay, replayed: true };

        const counts = planCounterCtfRangePreparation(preparation);
        const keysets = [offerKeysetId, receiveKeysetId] as const;
        const associationRows = await Promise.all(
          keysets.map((keysetId) =>
            this.#database.walletCounterAssociations.get([
              this.#scopeId,
              association.normalizedMint,
              association.unit,
              keysetId,
            ]),
          ),
        );
        if (associationRows.some((row) => row?.recoveryComplete !== true)) {
          this.#throwRecoveryIncomplete();
        }
        const currentValues = await Promise.all(
          keysets.map((keysetId) => this.#currentNext(keysetId)),
        );
        const offerStart = currentValues[0]!;
        const receiveStart = currentValues[1]!;
        const offerNext = offerStart + counts.offerCount;
        const receiveNext = receiveStart + counts.receiveCount;
        if (!Number.isSafeInteger(offerNext) || !Number.isSafeInteger(receiveNext)) {
          throw new BrowserWalletCounterError("invalid_counter", "CTF counter range is invalid");
        }

        // The SDK validates both bounded ranges and seed-derived receipt bindings
        // before any database row is written.
        const receipt = createCounterCtfRangePreparation({
          preparation,
          intent: input.intent,
          seed: input.seed,
          offerCounterStart: offerStart,
          receiveCounterStart: receiveStart,
        });
        const identity = counterCtfRangePreparationIdentity(receipt, input.createdAtMs);
        this.#requireCurrentProfile();
        const record = await insertCtfRangePreparationInTransaction(
          transaction,
          identity,
          this.#database,
        );
        await this.#database.walletCounterCursors.put({
          scopeId: this.#scopeId,
          keysetId: offerKeysetId,
          next: offerNext,
        });
        await this.#database.walletCounterCursors.put({
          scopeId: this.#scopeId,
          keysetId: receiveKeysetId,
          next: receiveNext,
        });
        await this.#advanceDesiredAssetAuthority(association, offerKeysetId);
        await this.#advanceDesiredAssetAuthority(association, receiveKeysetId);
        return { record, replayed: false };
      },
    );
  }

  async advanceToAtLeastInContext(
    context: BrowserWalletCounterContextInput,
    keysetId: string,
    minNext: number,
    requireRecoveryComplete: boolean,
  ): Promise<BrowserWalletCounterAdvanceResult> {
    const id = requireKeysetId(keysetId);
    const minimum = requireCounter(minNext);
    const association = requireContext(context);
    this.#requireCurrentProfile();
    return this.#database.transaction(
      "rw",
      [
        this.#database.walletCounterAssociations,
        this.#database.walletCounterCursors,
        this.#database.custodyProofs,
        this.#database.custodyProofBackupAuthorities,
        this.#database.custodyConditionalKeysets,
        this.#database.encryptedWalletBackupV2DesiredAssets,
      ],
      async () => {
        const row = await this.#ensureAssociation(association, id);
        if (requireRecoveryComplete && !row.recoveryComplete) this.#throwRecoveryIncomplete();
        return this.#advanceInTransaction(association, id, minimum);
      },
    );
  }

  async restoreInContext<T>(
    context: BrowserWalletCounterContextInput,
    keysetId: string,
    restoredNext: number,
    admissionChangesWallet: boolean,
    admit: () => T | Promise<T>,
  ): Promise<BrowserWalletCounterAdvanceResult> {
    const id = requireKeysetId(keysetId);
    const minimum = requireCounter(restoredNext);
    const association = requireContext(context);
    this.#requireCurrentProfile();
    return this.#database.transaction(
      "rw",
      [
        this.#database.walletCounterAssociations,
        this.#database.walletCounterCursors,
        this.#database.custodyProofs,
        this.#database.custodyProofBackupAuthorities,
        this.#database.custodyConditionalKeysets,
        this.#database.encryptedWalletBackupV2DesiredAssets,
        this.#database.proofs,
      ],
      () =>
        this.#restoreInOwnedTransaction(association, id, minimum, admissionChangesWallet, admit),
    );
  }

  /** Restore a counter inside a read-write transaction that the caller owns. */
  restoreInOwnedTransaction<T>(
    context: BrowserWalletCounterContextInput,
    keysetId: string,
    restoredNext: number,
    admissionChangesWallet: boolean,
    admit: () => T | Promise<T>,
  ): Promise<BrowserWalletCounterAdvanceResult> {
    this.#requireCurrentProfile();
    return this.#restoreInOwnedTransaction(
      requireContext(context),
      requireKeysetId(keysetId),
      requireCounter(restoredNext),
      admissionChangesWallet,
      admit,
    );
  }

  async #restoreInOwnedTransaction<T>(
    association: NormalizedBrowserWalletCounterContext,
    keysetId: string,
    minimum: number,
    admissionChangesWallet: boolean,
    admit: () => T | Promise<T>,
  ): Promise<BrowserWalletCounterAdvanceResult> {
    const row = await this.#ensureAssociation(association, keysetId);
    const current = await this.#currentNext(keysetId);
    const next = Math.max(current, minimum);
    const admission = admit();
    if (isPromiseLike(admission)) await admission;
    this.#requireCurrentProfile();
    const recoveryChanged = !row.recoveryComplete;
    if (recoveryChanged) {
      await this.#database.walletCounterAssociations.put({ ...row, recoveryComplete: true });
    }
    const counterChanged = next !== current;
    if (counterChanged) {
      await this.#database.walletCounterCursors.put({
        scopeId: this.#scopeId,
        keysetId,
        next,
      });
      await this.#advanceDesiredAssetAuthority(association, keysetId);
    }
    return { changed: counterChanged || recoveryChanged || admissionChangesWallet, next };
  }

  /** Observe one exact scoped authority without reserving a durable range. */
  async readSnapshotInContext(
    context: BrowserWalletCounterContextInput,
    keysetId: string,
  ): Promise<{ keysetId: string; nextCounter: number | null }> {
    const association = requireContext(context);
    const id = requireKeysetId(keysetId);
    this.#requireCurrentProfile();
    return this.#database.transaction(
      "r",
      [this.#database.walletCounterAssociations, this.#database.walletCounterCursors],
      async () => {
        this.#requireCurrentProfile();
        const row = await this.#database.walletCounterAssociations.get([
          this.#scopeId,
          association.normalizedMint,
          association.unit,
          id,
        ]);
        if (row?.recoveryComplete !== true) this.#throwRecoveryIncomplete();
        const cursor = await this.#database.walletCounterCursors.get([this.#scopeId, id]);
        this.#requireCurrentProfile();
        return {
          keysetId: id,
          nextCounter: cursor === undefined ? null : requireCounter(cursor.next),
        };
      },
    );
  }

  /** Compare and advance inside the caller's exact journal/custody transaction. */
  async compareAndAdvanceInCurrentTransaction(
    transaction: Transaction,
    context: BrowserWalletCounterContextInput,
    change: { keysetId: string; expectedNextCounter: number | null; nextCounter: number },
  ): Promise<void> {
    const required = [
      this.#database.walletCounterAssociations,
      this.#database.walletCounterCursors,
      this.#database.custodyProofs,
      this.#database.custodyProofBackupAuthorities,
      this.#database.custodyConditionalKeysets,
      this.#database.encryptedWalletBackupV2DesiredAssets,
    ];
    if (
      Dexie.currentTransaction !== transaction ||
      transaction.db !== this.#database ||
      !transaction.active ||
      transaction.mode !== "readwrite" ||
      required.some((table) => !transaction.storeNames.includes(table.name))
    )
      throw new Error("browser counter transaction is not exact current authority");
    try {
      this.#requireCurrentProfile();
      const association = requireContext(context);
      const id = requireKeysetId(change.keysetId);
      const expected =
        change.expectedNextCounter === null ? null : requireCounter(change.expectedNextCounter);
      const next = requireCounter(change.nextCounter);
      if (next <= (expected ?? 0))
        throw new BrowserWalletCounterError(
          "invalid_counter",
          "browser counter change does not advance",
        );
      const row = await this.#database.walletCounterAssociations.get([
        this.#scopeId,
        association.normalizedMint,
        association.unit,
        id,
      ]);
      if (row?.recoveryComplete !== true) this.#throwRecoveryIncomplete();
      const cursor = await this.#database.walletCounterCursors.get([this.#scopeId, id]);
      const current = cursor === undefined ? null : requireCounter(cursor.next);
      if (current !== expected) throw new BrowserWalletCounterSnapshotConflictError();
      await this.#database.walletCounterCursors.put({ scopeId: this.#scopeId, keysetId: id, next });
      await this.#advanceDesiredAssetAuthority(association, id);
      this.#requireCurrentProfile();
    } catch (error) {
      transaction.abort();
      throw error;
    }
  }

  async snapshot(): Promise<Record<string, number>> {
    this.#requireCurrentProfile();
    const rows = await this.#database.walletCounterCursors
      .where("scopeId")
      .equals(this.#scopeId)
      .limit(BROWSER_WALLET_COUNTER_SNAPSHOT_MAX + 1)
      .toArray();
    if (rows.length > BROWSER_WALLET_COUNTER_SNAPSHOT_MAX) {
      throw new BrowserWalletCounterError(
        "snapshot_limit",
        "wallet counter snapshot exceeds the limit",
      );
    }
    return Object.fromEntries(
      rows.map((row) => [requireKeysetId(row.keysetId), requireCounter(row.next)]),
    );
  }

  async isRecoveryComplete(
    context: BrowserWalletCounterContextInput,
    keysetId: string,
  ): Promise<boolean> {
    const association = requireContext(context);
    const id = requireKeysetId(keysetId);
    this.#requireCurrentProfile();
    const row = await this.#database.walletCounterAssociations.get([
      this.#scopeId,
      association.normalizedMint,
      association.unit,
      id,
    ]);
    return row?.recoveryComplete === true;
  }

  async #currentNext(keysetId: string): Promise<number> {
    const row = await this.#database.walletCounterCursors.get([this.#scopeId, keysetId]);
    if (row === undefined) return 0;
    if (row.scopeId !== this.#scopeId || row.keysetId !== keysetId) {
      throw new BrowserWalletCounterError("invalid_counter", "wallet counter row is invalid");
    }
    return requireCounter(row.next);
  }

  async #reserveInTransaction(
    context: NormalizedBrowserWalletCounterContext,
    keysetId: string,
    count: number,
  ): Promise<CounterRange> {
    const current = await this.#currentNext(keysetId);
    if (count === 0) return { start: current, count };
    const next = requireCounter(current + count);
    await this.#database.walletCounterCursors.put({ scopeId: this.#scopeId, keysetId, next });
    await this.#advanceDesiredAssetAuthority(context, keysetId);
    return { start: current, count };
  }

  async #advanceInTransaction(
    context: NormalizedBrowserWalletCounterContext,
    keysetId: string,
    minimum: number,
  ): Promise<BrowserWalletCounterAdvanceResult> {
    const current = await this.#currentNext(keysetId);
    const next = Math.max(current, minimum);
    if (next === current) return { changed: false, next };
    await this.#database.walletCounterCursors.put({ scopeId: this.#scopeId, keysetId, next });
    await this.#advanceDesiredAssetAuthority(context, keysetId);
    return { changed: true, next };
  }

  async #ensureAssociation(
    context: NormalizedBrowserWalletCounterContext,
    keysetId: string,
  ): Promise<import("./proof-db").BrowserWalletCounterAssociationRow> {
    const key: [string, string, CashuProofUnit, string] = [
      this.#scopeId,
      context.normalizedMint,
      context.unit,
      keysetId,
    ];
    const current = await this.#database.walletCounterAssociations.get(key);
    if (current !== undefined) return current;
    const count = await this.#database.walletCounterAssociations
      .where("scopeId")
      .equals(this.#scopeId)
      .count();
    if (count >= BROWSER_WALLET_COUNTER_ASSOCIATION_MAX) {
      throw new BrowserWalletCounterError(
        "association_limit",
        "wallet counter associations exceed the limit",
      );
    }
    const row = this.#associationRow(context.normalizedMint, context.unit, keysetId);
    await this.#database.walletCounterAssociations.add(row);
    return row;
  }

  #associationRow(
    normalizedMint: string,
    unit: CashuProofUnit,
    keysetId: string,
  ): import("./proof-db").BrowserWalletCounterAssociationRow {
    return { scopeId: this.#scopeId, normalizedMint, unit, keysetId, recoveryComplete: false };
  }

  #throwRecoveryIncomplete(): never {
    throw new BrowserWalletCounterError(
      "recovery_incomplete",
      "wallet counter recovery is incomplete",
    );
  }

  async #advanceDesiredAssetAuthority(
    context: NormalizedBrowserWalletCounterContext,
    keysetId: string,
  ): Promise<void> {
    await advanceBrowserV2DesiredAssetsForCounter({
      database: this.#database,
      scopeId: this.#scopeId,
      normalizedMint: context.normalizedMint,
      unit: context.unit,
      keysetId,
    });
  }

  #requireCurrentProfile(): void {
    this.#requireBoundDatabase();
    if (this.#isCurrentProfile && !this.#isCurrentProfile()) {
      throw new BrowserWalletCounterError(
        "stale_profile",
        "wallet profile changed during funded work",
      );
    }
  }

  #requireBoundDatabase(): void {
    if (this.#database.name !== browserWalletDatabaseName(this.#scopeId)) {
      throw new BrowserWalletCounterError("foreign_database", "wallet counter database is foreign");
    }
  }
}

export class BrowserWalletCounterSource implements CounterSource {
  readonly #counters: BrowserWalletCounterDexieStore;
  readonly #context: NormalizedBrowserWalletCounterContext;
  readonly #requireRecoveryComplete: boolean;

  constructor(
    profile: BrowserWalletCounterDexieProfile,
    context: { mintUrl: string; unit: string; requireRecoveryComplete?: boolean },
  ) {
    this.#counters = new BrowserWalletCounterDexieStore(profile);
    this.#context = requireContext(context);
    this.#requireRecoveryComplete = context.requireRecoveryComplete ?? true;
  }

  async reserve(keysetId: string, n: number): Promise<CounterRange> {
    return this.#counters.reserveInContext(
      this.#context,
      keysetId,
      n,
      this.#requireRecoveryComplete,
    );
  }

  async advanceToAtLeast(keysetId: string, minNext: number): Promise<void> {
    await this.#counters.advanceToAtLeastInContext(
      this.#context,
      keysetId,
      minNext,
      this.#requireRecoveryComplete,
    );
  }

  snapshot(): Promise<Record<string, number>> {
    return this.#counters.snapshot();
  }
}

export function createActiveBrowserWalletCounterSource(
  database: BitcasterDB,
  scopeId: string,
  context: { mintUrl: string; unit: string; requireRecoveryComplete?: boolean },
): CounterSource {
  return new BrowserWalletCounterSource(
    {
      database,
      scopeId,
      isCurrentProfile: () => activeBrowserWalletScopeId() === scopeId,
    },
    context,
  );
}

function requireScope(scopeId: string): string {
  decodeDurableCustodyScopeId(scopeId);
  return scopeId;
}

function requireKeysetId(value: string): string {
  if (!isCanonicalNut02V2KeysetId(value)) {
    throw new BrowserWalletCounterError("invalid_keyset", "wallet counter keyset is invalid");
  }
  return value;
}

function requireUnit(value: string): CashuProofUnit {
  const unit = parseCashuProofUnit(value);
  if (!unit) throw new BrowserWalletCounterError("invalid_unit", "wallet counter unit is invalid");
  return unit;
}

function requireContext(
  context: BrowserWalletCounterContextInput,
): NormalizedBrowserWalletCounterContext {
  if ("normalizedMint" in context) {
    return {
      normalizedMint: normalizeUrl(context.normalizedMint),
      unit: requireUnit(context.unit),
    };
  }
  return { normalizedMint: normalizeUrl(context.mintUrl), unit: requireUnit(context.unit) };
}

function requireCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BrowserWalletCounterError("invalid_counter", "wallet counter is invalid");
  }
  return value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
