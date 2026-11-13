import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  deriveRecoveryIndexKeys,
  unlistedRecoveryIndexEntries,
  recoveryIndexEntryKey,
  recoveryIndexEntryMatchesKeyset,
  type RecoveryIndexEntry,
  type RecoveryIndexKeysetAuthority,
} from "@bitcaster/client-sdk/recoveryIndexDocument";
import {
  createRecoveryIndexEngineStore,
  isRecoveryIndexRealm,
  RECOVERY_INDEX_REALMS,
  type RecoveryIndexRealm,
  type RecoveryIndexStore,
} from "@bitcaster/client-sdk/recoveryIndexEngine";
import {
  listedRecoveryIndexEntriesWithoutCursor,
  planRecoveryIndexRetryDelayMs,
  RECOVERY_INDEX_READ_MINT_REFUSAL_CODES,
  RecoveryIndexSync,
  type RecoveryIndexKnownDocument,
  type RecoveryIndexReadOutcome,
  type RecoveryIndexReadTrigger,
  type RecoveryIndexUploadOutcome,
} from "@bitcaster/client-sdk/recoveryIndexSync";
import { canonicalizeMintIdentityUrl } from "@bitcaster/client-sdk/tokenImportValidation";
import { BROWSER_WALLET_COUNTER_SNAPSHOT_MAX } from "../stores/browser-wallet-counter-db";
import { decodeBrowserCustodyConditionalKeysetRow } from "../stores/durable-custody-types";
import type { BitcasterDB } from "../stores/proof-db";

/**
 * The browser client of the recovery index (ADR-051, ADR-034 recovery index
 * amendment). The backup is always on. A funded operation never waits for
 * an upload: a counter write only asks for an upload, and the local counter
 * cursors are the retry queue. The only timer is the retry that the SDK asks
 * for with `retryAtMs`.
 */

export type BrowserRecoveryIndexStatus =
  | { readonly kind: "starting" }
  /** The engine acknowledged an index that lists every local keyset. */
  | { readonly kind: "current" }
  /** An upload waits for its retry. Trading continues. */
  | { readonly kind: "pending" }
  /** A persistent error. The client writes nothing until a later read changes the document. */
  | {
      readonly kind: "blocked";
      readonly reason: "undecodable" | "unsupported-version" | "over-cap";
    };

/** The state of the index for a seed handoff (ADR-034 recovery index amendment, "Seed handoff"). */
export type BrowserRecoveryIndexHandoff =
  /** The engine acknowledged an index that lists these keysets. */
  | { readonly kind: "acknowledged"; readonly listed: readonly RecoveryIndexEntry[] }
  /** A limit, a budget refusal, or a local over-cap merge refused a growing write. */
  | { readonly kind: "growing-write-refused" }
  /** The engine is unreachable or failed otherwise, or the document cannot be decoded. */
  | { readonly kind: "unavailable" };

/** The realm of this build. A development build without one uses the local realm. */
export function browserRecoveryIndexRealm(
  env: { readonly VITE_RECOVERY_INDEX_REALM?: string; readonly DEV?: boolean } = import.meta.env,
): RecoveryIndexRealm | null {
  const value = env.VITE_RECOVERY_INDEX_REALM;
  if (value === undefined || value === "")
    return env.DEV === true ? RECOVERY_INDEX_REALMS.local : null;
  return isRecoveryIndexRealm(value) ? value : null;
}

/**
 * The local keysets: each keyset with a counter cursor, in the form of its
 * index entry (ADR-051 "Upload"). A conditional keyset takes its identity
 * from the counter association that an order recorded, or else from the
 * conditional keyset authority of an admitted proof.
 */
export async function readBrowserRecoveryIndexLocalEntries(
  database: BitcasterDB,
  scopeId: string,
): Promise<readonly RecoveryIndexEntry[]> {
  return database.transaction(
    "r",
    [
      database.walletCounterCursors,
      database.walletCounterAssociations,
      database.custodyConditionalKeysets,
    ],
    async () => {
      const cursors = await database.walletCounterCursors
        .where("scopeId")
        .equals(scopeId)
        .limit(BROWSER_WALLET_COUNTER_SNAPSHOT_MAX + 1)
        .toArray();
      if (cursors.length > BROWSER_WALLET_COUNTER_SNAPSHOT_MAX) {
        throw new Error("browser recovery index local keysets exceed the limit");
      }
      const entries = new Map<string, RecoveryIndexEntry>();
      for (const cursor of cursors) {
        const associations = await database.walletCounterAssociations
          .where("[scopeId+keysetId]")
          .equals([scopeId, cursor.keysetId])
          .toArray();
        for (const association of associations) {
          const entry = await localEntry(database, scopeId, association);
          entries.set(recoveryIndexEntryKey(entry), entry);
        }
      }
      return [...entries.values()];
    },
  );
}

async function localEntry(
  database: BitcasterDB,
  scopeId: string,
  association: import("../stores/proof-db").BrowserWalletCounterAssociationRow,
): Promise<RecoveryIndexEntry> {
  const mintUrl = canonicalizeMintIdentityUrl(association.normalizedMint);
  const keysetId = association.keysetId;
  if (association.conditional !== undefined) {
    const { conditionId, outcomeCollection } = association.conditional;
    return {
      kind: "conditional",
      mintUrl,
      keysetId,
      conditionId,
      outcomeCollectionId: deriveRootCtfOutcomeCollectionId({ conditionId, outcomeCollection }),
    };
  }
  const raw = await database.custodyConditionalKeysets.get([
    scopeId,
    association.normalizedMint,
    association.unit,
    keysetId,
  ]);
  if (raw === undefined) return { kind: "regular", mintUrl, keysetId };
  const keyset = decodeBrowserCustodyConditionalKeysetRow(raw);
  return {
    kind: "conditional",
    mintUrl,
    keysetId,
    conditionId: keyset.conditionId,
    outcomeCollectionId: keyset.outcomeCollectionId,
  };
}

/**
 * Whether the acknowledged index lists every local keyset. The upload before
 * this check wrote the local form of each keyset that this browser can check.
 * A listed form that this browser cannot check stays, and a restore scans it.
 */
export async function browserRecoveryIndexListsEveryLocalKeyset(
  database: BitcasterDB,
  scopeId: string,
  listed: readonly RecoveryIndexEntry[],
): Promise<boolean> {
  const local = await readBrowserRecoveryIndexLocalEntries(database, scopeId);
  return unlistedRecoveryIndexEntries(local, listed).length === 0;
}

export interface BrowserRecoveryIndexInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  /** The 64-byte BIP-39 seed. */
  readonly seed: Uint8Array;
  readonly realm: RecoveryIndexRealm;
  /** The canonical URLs of the wallet mints. */
  readonly walletMints: () => readonly string[];
  /** The mint keys of a regular keyset that the client already holds, for a merge conflict. */
  readonly regularKeysetAuthority: (
    mintUrl: string,
    keysetId: string,
  ) => RecoveryIndexKeysetAuthority | null;
  /** The engine store. The default calls the engine through the same-origin `/api` proxy. */
  readonly store?: RecoveryIndexStore;
  readonly fetchImpl?: typeof fetch;
  readonly engineBaseUrl?: string;
  readonly lockManager?: Pick<LockManager, "request"> | null;
  readonly nowMs?: () => number;
  readonly random?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  /**
   * Called after each index read and each upload with the document and the
   * listed keysets that have no local cursor. ADR-033: after a read, the
   * browser scans only those keysets. A read that failed reports `failed`.
   */
  readonly onIndexRead?: (read: BrowserRecoveryIndexRead) => Promise<void>;
}

/** One index read for the scan rule of ADR-033. */
export type BrowserRecoveryIndexRead =
  | {
      readonly status: "read";
      readonly document: RecoveryIndexKnownDocument;
      readonly scan: readonly RecoveryIndexEntry[];
    }
  | { readonly status: "failed" };

/** The recovery index of one active wallet. Create one runtime for each wallet activation. */
type BrowserRecoveryIndexConditionalAuthority =
  | { readonly kind: "keys"; readonly authority: RecoveryIndexKeysetAuthority }
  | {
      readonly kind: "identity";
      readonly conditionId: string;
      readonly outcomeCollectionId: string;
    };

export class BrowserRecoveryIndex {
  readonly #input: BrowserRecoveryIndexInput;
  readonly #sync: RecoveryIndexSync;
  readonly #nowMs: () => number;
  readonly #listeners = new Set<() => void>();
  #status: BrowserRecoveryIndexStatus = { kind: "starting" };
  #uploading: Promise<void> | null = null;
  #uploadRequested = false;
  #retryTimer: unknown = undefined;
  #localFailureStreak = 0;
  #stopped = false;
  #lastRead: Promise<RecoveryIndexReadOutcome> | null = null;

  constructor(input: BrowserRecoveryIndexInput) {
    this.#input = input;
    this.#nowMs = input.nowMs ?? Date.now;
    const keys = deriveRecoveryIndexKeys(input.seed, input.realm);
    const store =
      input.store ??
      createRecoveryIndexEngineStore({
        // A browser reads the version header only from a same-origin response.
        engineBaseUrl: input.engineBaseUrl ?? globalThis.location.origin,
        realm: input.realm,
        keys,
        fetchImpl: input.fetchImpl ?? globalThis.fetch,
        nowMs: this.#nowMs,
      });
    this.#sync = new RecoveryIndexSync({
      store,
      keys,
      localEntries: () => readBrowserRecoveryIndexLocalEntries(input.database, input.scopeId),
      verifyEntry: (entry) => this.#verifyEntry(entry),
      walletMints: input.walletMints,
      nowMs: this.#nowMs,
      ...(input.random === undefined ? {} : { random: input.random }),
    });
  }

  get status(): BrowserRecoveryIndexStatus {
    return this.#status;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Read the index on one of the ADR-033 events, report the keysets that the
   * read lets the browser scan, then upload the pending keysets.
   */
  read(trigger: RecoveryIndexReadTrigger): Promise<RecoveryIndexReadOutcome> {
    const read = (async () => {
      const outcome = await this.#sync.read(trigger);
      await this.#report(
        outcome.status === "failed"
          ? { status: "failed" }
          : { status: "read", document: outcome.document, scan: outcome.scan },
      );
      this.requestUpload();
      return outcome;
    })();
    this.#lastRead = read;
    return read;
  }

  /**
   * The outcome of the latest read, for the restore of a seed entry. It
   * resolves after the read reported its scans. Null before a read.
   */
  lastRead(): Promise<RecoveryIndexReadOutcome> | null {
    return this.#lastRead;
  }

  async #report(read: BrowserRecoveryIndexRead): Promise<void> {
    if (this.#stopped || this.#input.onIndexRead === undefined) return;
    await this.#input.onIndexRead(read).catch(() => undefined);
  }

  /**
   * An upload can read the document again, for example after a 409 (ADR-034
   * "Client upload"). That read is an index read for the scan rule too.
   */
  async #reportDocument(): Promise<void> {
    const document = this.#sync.document;
    if (document.status !== "listed" || this.#input.onIndexRead === undefined) return;
    let local: readonly RecoveryIndexEntry[];
    try {
      local = await readBrowserRecoveryIndexLocalEntries(this.#input.database, this.#input.scopeId);
    } catch {
      return;
    }
    const scan = listedRecoveryIndexEntriesWithoutCursor(
      document.entries,
      local,
      this.#input.walletMints(),
    );
    if (scan.length > 0) await this.#report({ status: "read", document, scan });
  }

  /**
   * Ask for an upload of the pending keysets. The caller never awaits the
   * upload: a funded operation continues while the engine is unreachable.
   */
  requestUpload(): void {
    if (this.#stopped) return;
    if (this.#uploading !== null) {
      this.#uploadRequested = true;
      return;
    }
    const running = this.#runUploads();
    this.#uploading = running;
    void running.finally(() => {
      if (this.#uploading === running) this.#uploading = null;
    });
  }

  /** Wait for the running upload, for a test or a seed handoff. */
  async settled(): Promise<void> {
    while (this.#uploading !== null) await this.#uploading;
  }

  /** Read the index again, upload the pending keysets, and report the handoff gate. */
  async prepareSeedHandoff(): Promise<BrowserRecoveryIndexHandoff> {
    const read = await this.#sync.read("seed-handoff");
    if (read.status !== "read") return { kind: "unavailable" };
    await this.settled();
    let outcome: RecoveryIndexUploadOutcome;
    try {
      outcome = await this.#withSeedLock(() => this.#sync.upload());
    } catch {
      return { kind: "unavailable" };
    }
    this.#apply(outcome);
    switch (outcome.status) {
      case "current":
      case "written": {
        const document = this.#sync.document;
        return {
          kind: "acknowledged",
          listed: document.status === "listed" ? document.entries : [],
        };
      }
      case "blocked":
        return outcome.reason === "over-cap"
          ? { kind: "growing-write-refused" }
          : { kind: "unavailable" };
      case "retry":
        return outcome.reason === "limited"
          ? { kind: "growing-write-refused" }
          : { kind: "unavailable" };
      default:
        return assertNever(outcome);
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#clearRetry();
    this.#listeners.clear();
  }

  async #runUploads(): Promise<void> {
    do {
      this.#uploadRequested = false;
      this.#clearRetry();
      let outcome: RecoveryIndexUploadOutcome | null;
      try {
        outcome = await this.#withSeedLock(() => this.#sync.upload());
        this.#localFailureStreak = 0;
      } catch {
        // A local read failed. The next event or the retry below tries again.
        outcome = null;
      }
      if (this.#stopped) return;
      this.#apply(outcome);
      if (outcome?.status === "written" || outcome?.status === "current") {
        await this.#reportDocument();
      }
    } while (this.#uploadRequested && !this.#stopped);
  }

  #apply(outcome: RecoveryIndexUploadOutcome | null): void {
    if (this.#stopped) return;
    if (outcome === null) {
      this.#localFailureStreak += 1;
      this.#setStatus({ kind: "pending" });
      this.#scheduleRetry(
        this.#nowMs() +
          planRecoveryIndexRetryDelayMs({
            streak: this.#localFailureStreak,
            minimumDelayMs: 0,
            random: this.#input.random ?? Math.random,
          }),
      );
      return;
    }
    switch (outcome.status) {
      case "current":
      case "written":
        this.#setStatus({ kind: "current" });
        return;
      case "retry":
        this.#setStatus({ kind: "pending" });
        this.#scheduleRetry(outcome.retryAtMs);
        return;
      case "blocked":
        this.#setStatus({ kind: "blocked", reason: outcome.reason });
        return;
      default:
        assertNever(outcome);
    }
  }

  /** The one timer: the retry that the SDK asks for. */
  #scheduleRetry(atMs: number): void {
    this.#clearRetry();
    const setTimer = this.#input.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#retryTimer = setTimer(
      () => {
        this.#retryTimer = undefined;
        this.requestUpload();
      },
      Math.max(0, atMs - this.#nowMs()),
    );
  }

  #clearRetry(): void {
    if (this.#retryTimer === undefined) return;
    const clearTimer =
      this.#input.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    clearTimer(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  #setStatus(status: BrowserRecoveryIndexStatus): void {
    const unchanged =
      status.kind === this.#status.kind &&
      (status.kind !== "blocked" ||
        (this.#status.kind === "blocked" && status.reason === this.#status.reason));
    this.#status = status;
    if (!unchanged) for (const listener of this.#listeners) listener();
  }

  /** At most one upload of a seed runs at a time, also across tabs of this browser. */
  #withSeedLock<T>(work: () => Promise<T>): Promise<T> {
    const lockManager =
      this.#input.lockManager === undefined ? globalThis.navigator?.locks : this.#input.lockManager;
    if (lockManager == null) return work();
    return lockManager.request(
      `bitcaster:recovery-index:${this.#input.scopeId}`,
      { mode: "exclusive" },
      work,
    ) as Promise<T>;
  }

  /**
   * Verify one entry of a merge conflict with the keyset authority that this
   * browser already holds. It makes no mint request. Without an authority the
   * check throws, so the merge keeps the stored value (ADR-051 "Merge").
   *
   * A conditional authority is the custody keyset row, whose mint keys derive
   * the keyset id, or else the NUT-CTF identity that a counter association
   * recorded after the mint keys derived the keyset id with it. A keyset with
   * a conditional authority is not a regular keyset.
   */
  async #verifyEntry(entry: RecoveryIndexEntry): Promise<boolean> {
    const conditional = await this.#conditionalKeysetAuthority(entry);
    if (entry.kind === "regular") {
      if (conditional !== null) return false;
      const authority = this.#input.regularKeysetAuthority(entry.mintUrl, entry.keysetId);
      if (authority === null) throw new Error("recovery index keyset authority is unavailable");
      return recoveryIndexEntryMatchesKeyset(entry, authority);
    }
    switch (conditional?.kind) {
      case "keys":
        return recoveryIndexEntryMatchesKeyset(entry, conditional.authority);
      case "identity":
        return (
          entry.conditionId === conditional.conditionId &&
          entry.outcomeCollectionId === conditional.outcomeCollectionId
        );
      case undefined:
        throw new Error("recovery index keyset authority is unavailable");
      default:
        return assertNever(conditional);
    }
  }

  async #conditionalKeysetAuthority(
    entry: RecoveryIndexEntry,
  ): Promise<BrowserRecoveryIndexConditionalAuthority | null> {
    const { database, scopeId } = this.#input;
    const associations = (
      await database.walletCounterAssociations
        .where("[scopeId+keysetId]")
        .equals([scopeId, entry.keysetId])
        .toArray()
    ).filter(
      (association) => canonicalizeMintIdentityUrl(association.normalizedMint) === entry.mintUrl,
    );
    for (const association of associations) {
      const raw = await database.custodyConditionalKeysets.get([
        scopeId,
        association.normalizedMint,
        association.unit,
        entry.keysetId,
      ]);
      if (raw === undefined) continue;
      const keyset = decodeBrowserCustodyConditionalKeysetRow(raw);
      return {
        kind: "keys",
        authority: {
          id: keyset.keysetId,
          unit: keyset.unit,
          keys: keyset.denominationPublicKeys,
          inputFeePpk: keyset.inputFeePpk,
          finalExpiry: keyset.finalExpiryUnixSeconds,
        },
      };
    }
    const identity = associations.find(({ conditional }) => conditional !== undefined)?.conditional;
    if (identity === undefined) return null;
    return {
      kind: "identity",
      conditionId: identity.conditionId,
      outcomeCollectionId: deriveRootCtfOutcomeCollectionId(identity),
    };
  }
}

const runtimes = new Map<string, BrowserRecoveryIndex>();
const registryListeners = new Set<() => void>();

export function registerBrowserRecoveryIndex(
  scopeId: string,
  runtime: BrowserRecoveryIndex,
): () => void {
  runtimes.set(scopeId, runtime);
  registryListeners.forEach((listener) => listener());
  return () => {
    if (runtimes.get(scopeId) !== runtime) return;
    runtimes.delete(scopeId);
    registryListeners.forEach((listener) => listener());
  };
}

export function activeBrowserRecoveryIndex(scopeId: string): BrowserRecoveryIndex | null {
  return runtimes.get(scopeId) ?? null;
}

export function subscribeBrowserRecoveryIndexRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

/** The seed handoff gate of the active wallet. Without a recovery index the handoff waits. */
export function prepareBrowserRecoveryIndexHandoff(
  scopeId: string,
): Promise<BrowserRecoveryIndexHandoff> {
  return (
    activeBrowserRecoveryIndex(scopeId)?.prepareSeedHandoff() ??
    Promise.resolve({ kind: "unavailable" })
  );
}

/**
 * After a recovery pass, upload the keysets that the pass found and that the
 * index does not list (ADR-039 "Restore order"). The request coalesces with
 * the upload that a new counter cursor asked for.
 */
export function uploadBrowserRecoveryIndexAfterRecovery(scopeId: string): void {
  activeBrowserRecoveryIndex(scopeId)?.requestUpload();
}

/** A mint refusal 11001, 11003, or 11008 reads the index again (ADR-033). */
export function readBrowserRecoveryIndexAfterMintRefusal(scopeId: string, code: number): void {
  if (!RECOVERY_INDEX_READ_MINT_REFUSAL_CODES.has(code)) return;
  void activeBrowserRecoveryIndex(scopeId)
    ?.read("mint-refusal")
    .catch(() => undefined);
}

function assertNever(value: never): never {
  throw new Error(`unexpected browser recovery index value: ${JSON.stringify(value)}`);
}
