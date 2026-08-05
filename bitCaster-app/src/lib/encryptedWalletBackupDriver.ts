import Dexie, { liveQuery, type Subscription } from "dexie";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  EncryptedWalletBackupRemoteBackoffError,
  EncryptedWalletBackupV2HttpAdapter,
  EncryptedWalletBackupV2HttpTransportError,
  createEncryptedWalletBackupNip98AccountAuthorizationPort,
  createEncryptedWalletBackupV2KeyHandle,
  executeEncryptedWalletBackupAccountOperation,
  prepareEncryptedWalletBackupAccountOperation,
  prepareEncryptedWalletBackupV2EnrollmentEpochDiscoveryProof,
  type EncryptedWalletBackupV2BundleRuntime,
  type EncryptedWalletBackupV2KeyHandle,
  type EncryptedWalletBackupAccountAuthorizationPort,
  type EncryptedWalletBackupAccountOperationRemotePort,
  type EncryptedWalletBackupV2RemotePort,
} from "@bitcaster/client-sdk";
import { runBrowserEncryptedWalletBackupV2WorkerCycle } from "./browserEncryptedWalletBackupV2Worker";
import {
  createEncryptedWalletBackupTransportFetch,
  type EncryptedWalletBackupConfiguration,
} from "./encryptedWalletBackupConfig";
import { getNdk } from "./nostr";
import { EncryptedWalletBackupEnrollmentDexieStore } from "../stores/encrypted-wallet-backup-enrollment-db";
import {
  clearEncryptedWalletBackupRetryScheduler,
  readEncryptedWalletBackupRetryScheduler,
  scheduleEncryptedWalletBackupRetry,
} from "../stores/encrypted-wallet-backup-retry-db";
import type { BitcasterDB } from "../stores/proof-db";

export const ENCRYPTED_WALLET_BACKUP_BACKGROUND_CYCLE_DEADLINE_MILLISECONDS = 300_000;
export const ENCRYPTED_WALLET_BACKUP_RETRY_DELAY_MILLISECONDS = 5_000;
export const ENCRYPTED_WALLET_BACKUP_SERVICE_QUOTA_RECHECK_MILLISECONDS = 3_600_000;

export interface BrowserEncryptedWalletBackupV2RuntimeDriver {
  stop(): void;
}

export interface BrowserEncryptedWalletBackupV2RuntimeDriverInput {
  readonly configuration: EncryptedWalletBackupConfiguration;
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly seed: Uint8Array;
  readonly signal: AbortSignal;
  readonly isCurrentProfile: () => boolean;
  readonly remote?: BackupRemote;
  readonly runtime?: EncryptedWalletBackupV2BundleRuntime;
  readonly runWorkerCycle?: typeof runBrowserEncryptedWalletBackupV2WorkerCycle;
  readonly authorizationPort?: EncryptedWalletBackupAccountAuthorizationPort;
  /** Test seam. Production holds a vault-scoped Web Lock until cleanup. */
  readonly leadership?: BrowserEncryptedWalletBackupLeadership;
  /** Test seam. Production uses one cancellable browser timer. */
  readonly scheduleRetry?: (task: () => void, delayMilliseconds: number) => () => void;
  /** Test seam. Production persists one retry schedule for the vault. */
  readonly scheduleDurableRetry?: typeof scheduleEncryptedWalletBackupRetry;
  /** Test seam. Production reports terminal background failures to the console. */
  readonly reportError?: (error: unknown) => void;
}

type BackupRemote = EncryptedWalletBackupV2RemotePort &
  EncryptedWalletBackupAccountOperationRemotePort;

export interface BrowserEncryptedWalletBackupLeadership {
  hold(lockName: string, signal: AbortSignal, onLeader: () => Promise<void>): Promise<void>;
}

export function createEncryptedWalletBackupBackgroundCycleSignal(
  cleanupSignal: AbortSignal,
  timeoutMilliseconds = ENCRYPTED_WALLET_BACKUP_BACKGROUND_CYCLE_DEADLINE_MILLISECONDS,
): AbortSignal {
  return AbortSignal.any([cleanupSignal, AbortSignal.timeout(timeoutMilliseconds)]);
}

/** Runs V2-only background backup work for one captured browser wallet profile. */
export function createBrowserEncryptedWalletBackupV2RuntimeDriver(
  input: BrowserEncryptedWalletBackupV2RuntimeDriverInput,
): BrowserEncryptedWalletBackupV2RuntimeDriver {
  return new BrowserEncryptedWalletBackupV2RuntimeDriverImpl(input).start();
}

class BrowserEncryptedWalletBackupV2RuntimeDriverImpl implements BrowserEncryptedWalletBackupV2RuntimeDriver {
  readonly #input: BrowserEncryptedWalletBackupV2RuntimeDriverInput;
  readonly #runtime: EncryptedWalletBackupV2BundleRuntime;
  readonly #remote: BackupRemote;
  readonly #runWorkerCycle: typeof runBrowserEncryptedWalletBackupV2WorkerCycle;
  readonly #lifetimeSignal: AbortSignal;
  #subscription: Subscription | undefined;
  readonly #cleanup = new AbortController();
  #keyHandle: EncryptedWalletBackupV2KeyHandle | undefined;
  #enrollmentEpoch: number | undefined;
  #pendingDesiredAssetCount = 0;
  #pendingDesiredAssetFingerprint = "";
  #serviceQuotaPendingFingerprint: string | null = null;
  #initialized = false;
  #leader = false;
  #terminal = false;
  #running = false;
  #cycleQueued = false;
  #cancelTimer: (() => void) | undefined;
  #timerKind: "retry" | "quota" | undefined;
  #timerScheduling = false;

  constructor(input: BrowserEncryptedWalletBackupV2RuntimeDriverInput) {
    this.#input = input;
    this.#runtime = input.runtime ?? browserRuntime();
    this.#remote = input.remote ?? createRemote(input.configuration);
    this.#runWorkerCycle = input.runWorkerCycle ?? runBrowserEncryptedWalletBackupV2WorkerCycle;
    this.#lifetimeSignal = AbortSignal.any([input.signal, this.#cleanup.signal]);
  }

  start(): this {
    void this.#acquireLeadership();
    return this;
  }

  stop(): void {
    this.#cleanup.abort();
    this.#stopLeader();
  }

  async #acquireLeadership(): Promise<void> {
    try {
      this.#keyHandle = await createEncryptedWalletBackupV2KeyHandle({
        seed: this.#input.seed,
        realm: this.#input.configuration.realm,
        runtime: this.#runtime,
      });
      if (!this.#isActive()) return;
      await (this.#input.leadership ?? browserLeadership()).hold(
        encryptedWalletBackupV2VaultLockName(requireKeyHandle(this.#keyHandle)),
        this.#lifetimeSignal,
        async () => {
          if (!this.#isActive()) return;
          this.#leader = true;
          this.#startLeader();
          await this.#resumeOrInitialize();
          await waitForAbort(this.#lifetimeSignal);
        },
      );
    } catch (error) {
      if (this.#isActive()) this.#reportError(error);
    } finally {
      this.#stopLeader();
    }
  }

  #startLeader(): void {
    this.#subscription = liveQuery(() => this.#pendingDesiredAssetCountQuery()).subscribe({
      next: (rows) => this.#onPendingDesiredAssets(rows),
      error: (error) => this.#fail(error),
    });
  }

  #stopLeader(): void {
    this.#leader = false;
    this.#initialized = false;
    this.#subscription?.unsubscribe();
    this.#subscription = undefined;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#timerKind = undefined;
  }

  async #resumeOrInitialize(): Promise<void> {
    const keyHandle = requireKeyHandle(this.#keyHandle);
    const schedule = await readEncryptedWalletBackupRetryScheduler(this.#input.database, {
      scopeId: this.#input.scopeId,
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
    });
    if (!this.#isLeaderActive()) return;
    if (schedule !== null && schedule.retryNotBeforeUnixMilliseconds > Date.now()) {
      this.#armTimer(
        () => void this.#initialize(),
        schedule.retryNotBeforeUnixMilliseconds - Date.now(),
        "retry",
      );
      return;
    }
    void this.#initialize();
  }

  async #pendingDesiredAssetCountQuery(): Promise<readonly PendingDesiredAssetWake[]> {
    const rows = await this.#input.database.encryptedWalletBackupV2DesiredAssets
      .where("[scopeId+syncState+localAssetKey]")
      .between(
        [this.#input.scopeId, "pending", Dexie.minKey],
        [this.#input.scopeId, "pending", Dexie.maxKey],
      )
      .limit(257)
      .toArray();
    if (rows.length > 256)
      throw new Error("encrypted wallet backup pending assets exceed the limit");
    return rows
      .map(({ localAssetKey, custodyRevision, desiredAction }) => ({
        localAssetKey,
        custodyRevision,
        desiredAction,
      }))
      .sort((left, right) => left.localAssetKey.localeCompare(right.localAssetKey));
  }

  #onPendingDesiredAssets(rows: readonly PendingDesiredAssetWake[]): void {
    const fingerprint = JSON.stringify(rows);
    const changed = fingerprint !== this.#pendingDesiredAssetFingerprint;
    this.#pendingDesiredAssetCount = rows.length;
    this.#pendingDesiredAssetFingerprint = fingerprint;
    if (this.#serviceQuotaPendingFingerprint !== null) {
      if (!changed) return;
      this.#serviceQuotaPendingFingerprint = null;
      if (this.#timerKind === "quota") this.#clearTimer();
    }
    if (rows.length > 0 && (changed || !this.#initialized)) this.#requestCycle();
  }

  #requestCycle(): void {
    if (!this.#initialized || !this.#isLeaderActive()) return;
    this.#cycleQueued = true;
    if (!this.#running && !this.#timerScheduling && this.#cancelTimer === undefined)
      void this.#runCycles();
  }

  async #initialize(): Promise<void> {
    try {
      if (!this.#isLeaderActive()) return;
      this.#enrollmentEpoch = await resolveEncryptedWalletBackupV2EnrollmentEpoch({
        configuration: this.#input.configuration,
        database: this.#input.database,
        scopeId: this.#input.scopeId,
        keyHandle: requireKeyHandle(this.#keyHandle),
        remote: this.#remote,
        runtime: this.#runtime,
        signal: this.#lifetimeSignal,
        authorizationPort: this.#input.authorizationPort,
        isCurrentProfile: () => this.#isLeaderActive(),
      });
      if (!this.#isLeaderActive()) return;
      await this.#clearRetrySchedule();
      if (!this.#isLeaderActive()) return;
      this.#initialized = true;
      if (this.#pendingDesiredAssetCount > 0) this.#requestCycle();
    } catch (error) {
      if (!this.#isLeaderActive()) return;
      if (isRetryable(error))
        await this.#scheduleRetrySafely(() => void this.#initialize(), retryDelay(error));
      else this.#fail(error);
    }
  }

  async #runCycles(): Promise<void> {
    if (this.#running || !this.#isLeaderActive()) return;
    this.#running = true;
    try {
      while (
        this.#cycleQueued &&
        !this.#timerScheduling &&
        this.#cancelTimer === undefined &&
        this.#isLeaderActive()
      ) {
        this.#cycleQueued = false;
        await this.#runOneCycle();
      }
    } catch (error) {
      if (!this.#isLeaderActive()) return;
      if (isRetryable(error)) await this.#scheduleRetrySafely(undefined, retryDelay(error));
      else this.#fail(error);
    } finally {
      this.#running = false;
      if (
        this.#cycleQueued &&
        !this.#timerScheduling &&
        this.#cancelTimer === undefined &&
        this.#isLeaderActive()
      )
        void this.#runCycles();
    }
  }

  async #runOneCycle(): Promise<void> {
    const signal = createEncryptedWalletBackupBackgroundCycleSignal(this.#lifetimeSignal);
    try {
      const result = await this.#runWorkerCycle({
        database: this.#input.database,
        scopeId: this.#input.scopeId,
        seed: this.#input.seed,
        keyHandle: requireKeyHandle(this.#keyHandle),
        enrollmentEpoch: requireEnrollmentEpoch(this.#enrollmentEpoch),
        pinnedReceiptKeys: this.#input.configuration.pinnedReceiptKeys,
        remote: this.#remote,
        requestUrl: (kind, afterBundleId) =>
          requestUrl(
            this.#input.configuration,
            requireKeyHandle(this.#keyHandle),
            kind,
            afterBundleId,
          ),
        nowUnixSeconds: () => Math.floor(Date.now() / 1_000),
        runtime: this.#runtime,
        signal,
        isCurrentProfile: () => this.#isLeaderActive(),
      });
      if (result.kind === "retry-pending") {
        await this.#scheduleRetry(undefined, result.minimumRetryDelayMilliseconds);
        return;
      }
      if (result.kind === "service-quota-pending") {
        this.#serviceQuotaPendingFingerprint = this.#pendingDesiredAssetFingerprint;
        this.#armTimer(
          () => this.#requestCycle(),
          ENCRYPTED_WALLET_BACKUP_SERVICE_QUOTA_RECHECK_MILLISECONDS,
          "quota",
        );
        return;
      }
      if (
        result.kind === "head-accepted" ||
        result.kind === "committed" ||
        result.kind === "conflict-recovered"
      ) {
        await this.#clearRetrySchedule();
        this.#cycleQueued = true;
      } else if (result.kind === "idle") {
        await this.#clearRetrySchedule();
      }
    } catch (error) {
      if (signal.aborted && !this.#lifetimeSignal.aborted) {
        throw new EncryptedWalletBackupV2HttpTransportError("deadline-exceeded");
      }
      throw error;
    }
  }

  async #scheduleRetry(
    task: (() => void) | undefined,
    minimumDelayMilliseconds = ENCRYPTED_WALLET_BACKUP_RETRY_DELAY_MILLISECONDS,
  ): Promise<void> {
    if (this.#timerScheduling || this.#cancelTimer !== undefined || !this.#isLeaderActive()) return;
    this.#timerScheduling = true;
    try {
      const keyHandle = requireKeyHandle(this.#keyHandle);
      const persist = this.#input.scheduleDurableRetry ?? scheduleEncryptedWalletBackupRetry;
      const schedule = await persist(this.#input.database, {
        scopeId: this.#input.scopeId,
        realm: keyHandle.realm,
        vaultId: keyHandle.vaultId,
        attemptId: retryAttemptId(keyHandle),
        minimumDelayMilliseconds,
      });
      if (!this.#isLeaderActive()) return;
      this.#armTimer(
        task ?? (() => this.#requestCycle()),
        Math.max(0, schedule.retryNotBeforeUnixMilliseconds - Date.now()),
        "retry",
      );
    } finally {
      this.#timerScheduling = false;
    }
  }

  async #scheduleRetrySafely(
    task: (() => void) | undefined,
    minimumDelayMilliseconds: number,
  ): Promise<void> {
    try {
      await this.#scheduleRetry(task, minimumDelayMilliseconds);
    } catch (error) {
      if (this.#isLeaderActive()) this.#fail(error);
    }
  }

  #armTimer(task: () => void, delayMilliseconds: number, kind: "retry" | "quota"): void {
    if (this.#cancelTimer !== undefined || !this.#isLeaderActive()) return;
    const schedule = this.#input.scheduleRetry ?? scheduleBrowserRetry;
    this.#timerKind = kind;
    this.#cancelTimer = schedule(() => {
      this.#cancelTimer = undefined;
      this.#timerKind = undefined;
      if (this.#isLeaderActive()) task();
    }, delayMilliseconds);
  }

  #clearTimer(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#timerKind = undefined;
  }

  async #clearRetrySchedule(): Promise<void> {
    const keyHandle = this.#keyHandle;
    if (keyHandle === undefined || !this.#isLeaderActive()) return;
    await clearEncryptedWalletBackupRetryScheduler(this.#input.database, {
      scopeId: this.#input.scopeId,
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
      attemptId: retryAttemptId(keyHandle),
    });
  }

  #isActive(): boolean {
    return !this.#lifetimeSignal.aborted && this.#input.isCurrentProfile();
  }

  #isLeaderActive(): boolean {
    return this.#leader && !this.#terminal && this.#isActive();
  }

  #fail(error: unknown): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#initialized = false;
    this.#cycleQueued = false;
    this.#subscription?.unsubscribe();
    this.#subscription = undefined;
    this.#clearTimer();
    this.#reportError(error);
  }

  #reportError(error: unknown): void {
    (this.#input.reportError ?? reportBrowserBackupError)(error);
  }
}

type PendingDesiredAssetWake = Readonly<{
  localAssetKey: string;
  custodyRevision: string;
  desiredAction: "replace" | "remove";
}>;

type ResolveEncryptedWalletBackupV2EnrollmentInput = {
  readonly configuration: EncryptedWalletBackupConfiguration;
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly remote: Pick<
    EncryptedWalletBackupV2HttpAdapter,
    "discoverEnrollmentEpoch" | "executeAccountOperation"
  >;
  readonly runtime: EncryptedWalletBackupV2BundleRuntime;
  readonly signal: AbortSignal;
  readonly nowUnixSeconds?: () => number;
  readonly authorizationPort?: EncryptedWalletBackupAccountAuthorizationPort;
  readonly isCurrentProfile?: () => boolean;
};

export async function resolveEncryptedWalletBackupV2EnrollmentEpoch(
  input: ResolveEncryptedWalletBackupV2EnrollmentInput,
): Promise<number> {
  const enrollment = new EncryptedWalletBackupEnrollmentDexieStore({
    database: input.database,
    scopeId: input.scopeId,
    realm: input.keyHandle.realm,
    vaultId: input.keyHandle.vaultId,
    requestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
    beforeCommit: () => requireCurrentProfile(input),
  });
  requireCurrentProfile(input);
  const issuedAtUnixSeconds = (input.nowUnixSeconds ?? nowUnixSeconds)();
  const discovery = await prepareEncryptedWalletBackupV2EnrollmentEpochDiscoveryProof({
    keyHandle: input.keyHandle,
    url: enrollmentEpochUrl(input.configuration, input.keyHandle.vaultId),
    issuedAtUnixSeconds,
    expiresAtUnixSeconds: issuedAtUnixSeconds + 60,
    signal: input.signal,
    runtime: input.runtime,
  });
  requireCurrentProfile(input);
  const discovered = await input.remote.discoverEnrollmentEpoch({
    requestProof: discovery,
    signal: input.signal,
  });
  requireCurrentProfile(input);
  if (discovered.status === "active") return discovered.enrollmentEpoch;
  return enrollAbsentWalletBackupV2(input, enrollment);
}

async function enrollAbsentWalletBackupV2(
  input: ResolveEncryptedWalletBackupV2EnrollmentInput,
  enrollment: EncryptedWalletBackupEnrollmentDexieStore,
): Promise<number> {
  requireCurrentProfile(input);
  const operation = await prepareEncryptedWalletBackupAccountOperation({
    keyHandle: input.keyHandle,
    action: "enroll",
    url: accountUrl(input.configuration),
    operationId: randomOperationId(input.runtime),
    expectedEnrollmentEpoch: 0,
    authorizationPort:
      input.authorizationPort ??
      createEncryptedWalletBackupNip98AccountAuthorizationPort({ signer: currentNostrSigner() }),
    signal: input.signal,
  });
  requireCurrentProfile(input);
  const enrolled = await executeEncryptedWalletBackupAccountOperation({
    operation,
    remote: {
      executeAccountOperation: (request) => {
        requireCurrentProfile(input);
        return input.remote.executeAccountOperation(request);
      },
    },
    store: enrollment,
  });
  if (enrolled.record.lifecycle !== "active") throw new Error("backup enrollment is not active");
  return enrolled.record.observedEnrollmentEpoch;
}

function requestUrl(
  configuration: EncryptedWalletBackupConfiguration,
  keyHandle: EncryptedWalletBackupV2KeyHandle,
  kind: "head" | "mutation",
  afterBundleId: string | null,
): string {
  const base = `${configuration.signedOrigin}/v1/encrypted-wallet-backup/realms/${configuration.realm}/vaults/${keyHandle.vaultId}`;
  if (kind === "mutation") return `${base}/head:compare-and-swap`;
  return afterBundleId === null ? `${base}/head` : `${base}/head/after/${afterBundleId}`;
}

function enrollmentEpochUrl(
  configuration: EncryptedWalletBackupConfiguration,
  vaultId: string,
): string {
  return `${configuration.signedOrigin}/v1/encrypted-wallet-backup/realms/${configuration.realm}/vaults/${vaultId}/enrollment-epoch`;
}

function accountUrl(configuration: EncryptedWalletBackupConfiguration): string {
  return `${configuration.signedOrigin}/v1/encrypted-wallet-backup/realms/${configuration.realm}/vaults:enroll`;
}

function createRemote(configuration: EncryptedWalletBackupConfiguration): BackupRemote {
  return new EncryptedWalletBackupV2HttpAdapter({
    origin: configuration.signedOrigin,
    fetch: createEncryptedWalletBackupTransportFetch({
      signedOrigin: configuration.signedOrigin,
      transportOrigin: configuration.transportOrigin,
    }),
  });
}

function currentNostrSigner() {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error("encrypted backup requires a Nostr signer");
  return {
    async signEvent(template: {
      readonly kind: 27235;
      readonly createdAtUnixSeconds: number;
      readonly tags: readonly (readonly string[])[];
      readonly content: "";
    }) {
      const event = new NDKEvent(ndk);
      event.kind = template.kind;
      event.created_at = template.createdAtUnixSeconds;
      event.tags = template.tags.map((tag) => [...tag]);
      event.content = template.content;
      await event.sign();
      const raw = event.rawEvent();
      return {
        id: requireText(raw.id),
        pubkey: requireText(raw.pubkey),
        createdAtUnixSeconds: requireInteger(raw.created_at),
        kind: requireInteger(raw.kind),
        tags: raw.tags.map((tag) => [...tag]),
        content: raw.content,
        signature: requireText(raw.sig),
      };
    },
  };
}

function browserRuntime(): EncryptedWalletBackupV2BundleRuntime {
  const runtime = globalThis.crypto;
  if (runtime === undefined || typeof runtime.getRandomValues !== "function") {
    throw new Error("encrypted wallet backup browser runtime is unavailable");
  }
  return {
    subtle: runtime.subtle,
    getRandomValues: (target) => runtime.getRandomValues(target) as Uint8Array,
  };
}

function randomOperationId(
  runtime: Pick<EncryptedWalletBackupV2BundleRuntime, "getRandomValues">,
): string {
  const bytes = new Uint8Array(16);
  runtime.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof EncryptedWalletBackupRemoteBackoffError) return true;
  return (
    error instanceof EncryptedWalletBackupV2HttpTransportError &&
    (error.code === "concurrency-exhausted" ||
      error.code === "deadline-exceeded" ||
      error.code === "transport-failure" ||
      error.code === "rate-limited" ||
      error.code === "overloaded" ||
      error.code === "unavailable")
  );
}

function retryDelay(error: unknown): number {
  if (error instanceof EncryptedWalletBackupRemoteBackoffError)
    return error.delayMilliseconds(ENCRYPTED_WALLET_BACKUP_RETRY_DELAY_MILLISECONDS);
  if (error instanceof EncryptedWalletBackupV2HttpTransportError) {
    return Math.max(
      ENCRYPTED_WALLET_BACKUP_RETRY_DELAY_MILLISECONDS,
      (error.retryAfterSeconds ?? 0) * 1_000,
    );
  }
  return ENCRYPTED_WALLET_BACKUP_RETRY_DELAY_MILLISECONDS;
}

function requireCurrentProfile(input: {
  readonly signal: AbortSignal;
  readonly isCurrentProfile?: () => boolean;
}): void {
  if (input.signal.aborted || input.isCurrentProfile?.() === false)
    throw new Error("encrypted wallet backup profile is stale");
}

function requireKeyHandle(
  value: EncryptedWalletBackupV2KeyHandle | undefined,
): EncryptedWalletBackupV2KeyHandle {
  if (value === undefined) throw new Error("encrypted wallet backup key handle is unavailable");
  return value;
}

function requireEnrollmentEpoch(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
    throw new Error("encrypted wallet backup enrollment epoch is unavailable");
  }
  return value;
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function scheduleBrowserRetry(task: () => void, delayMilliseconds: number): () => void {
  const timer = setTimeout(task, delayMilliseconds);
  return () => clearTimeout(timer);
}

function browserLeadership(): BrowserEncryptedWalletBackupLeadership {
  const locks = globalThis.navigator?.locks;
  if (locks === undefined || typeof locks.request !== "function")
    throw new Error("encrypted wallet backup Web Locks are unavailable");
  return {
    async hold(lockName, signal, onLeader) {
      await locks.request(lockName, { mode: "exclusive", signal }, async () => {
        if (signal.aborted) return;
        await onLeader();
      });
    },
  };
}

/** Returns the canonical Web Lock name for one encrypted-backup vault. */
export function encryptedWalletBackupV2VaultLockName(input: {
  readonly realm: string;
  readonly vaultId: string;
}): string {
  return `bitcaster/encrypted-wallet-backup/v2/${input.realm}/${input.vaultId}`;
}

function retryAttemptId(keyHandle: EncryptedWalletBackupV2KeyHandle): string {
  return keyHandle.vaultId.slice(0, 32);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function reportBrowserBackupError(error: unknown): void {
  console.error("Encrypted wallet backup stopped.", error);
}

function requireText(value: unknown): string {
  if (typeof value !== "string") throw new Error("encrypted backup Nostr event is invalid");
  return value;
}

function requireInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error("encrypted backup Nostr event is invalid");
  return value as number;
}
