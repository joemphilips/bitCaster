import Dexie, { liveQuery, type Subscription } from "dexie";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  encryptedWalletBackupV2LocalAssetKey,
  EncryptedWalletBackupRemoteBackoffError,
  EncryptedWalletBackupV2HttpAdapter,
  EncryptedWalletBackupV2HttpTransportError,
  createEncryptedWalletBackupNip98AccountAuthorizationPort,
  createEncryptedWalletBackupV2KeyHandle,
  deriveEncryptedWalletBackupV2AssetLocator,
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
  discoverBrowserCtfRemovals,
  startBrowserCtfRemove,
  type BrowserCtfRemoveResult,
  type BrowserCtfRemoveTarget,
} from "./browserCtfRemoveCoordinator";
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
import {
  EncryptedWalletBackupV2DexieAuthorityStore,
  type EncryptedWalletBackupV2LocalRecoveryStatus,
} from "../stores/encrypted-wallet-backup-v2-db";
import { decodeEncryptedWalletBackupV2DesiredAssetRow } from "../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import {
  recoverBrowserTargetedAsset,
  type BrowserTargetedAssetRecoveryMonitoring,
} from "./browserTargetedAssetRecovery";
import type {
  EncryptedWalletBackupV2AssetIdentity,
  TargetedAssetRecoveryOutcome,
} from "@bitcaster/client-sdk";
import type { Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  beginBrowserWalletBackupAuthenticationSession,
  type BrowserWalletBackupAuthenticationSession,
} from "./browserWalletNewWritePermission";
import {
  recoverBrowserEncryptedWalletBackupV2Conflict,
  type BrowserEncryptedWalletBackupV2ConflictRecoveryIncompleteReason,
} from "./browserEncryptedWalletBackupV2ConflictRecovery";

export const ENCRYPTED_WALLET_BACKUP_BACKGROUND_CYCLE_DEADLINE_MILLISECONDS = 300_000;
export const ENCRYPTED_WALLET_BACKUP_RETRY_DELAY_MILLISECONDS = 5_000;
export const ENCRYPTED_WALLET_BACKUP_SERVICE_QUOTA_RECHECK_MILLISECONDS = 3_600_000;
export const BROWSER_CTF_REMOVE_ACKNOWLEDGEMENT_DEADLINE_MILLISECONDS = 10_000;

export interface BrowserEncryptedWalletBackupV2RuntimeDriver {
  readonly recoveryReason: BrowserEncryptedWalletBackupV2ConflictRecoveryIncompleteReason | null;
  stop(): void;
  /** Rechecks durable refusal after an explicit recovery completion. */
  resumeAfterRecovery(): void;
  removeManagedProofs(input: {
    readonly asset: EncryptedWalletBackupV2AssetIdentity;
    readonly targets: readonly BrowserCtfRemoveTarget[];
  }): Promise<BrowserCtfRemoveResult>;
  recoverTargetedAsset(input: {
    readonly asset: EncryptedWalletBackupV2AssetIdentity;
    readonly requiredAmount: bigint;
    readonly loadWallet: () => Promise<CashuWallet>;
    readonly readExactMonitoringRecovery: () => Promise<BrowserTargetedAssetRecoveryMonitoring | null>;
    readonly lockManager?: Pick<LockManager, "request">;
  }): Promise<TargetedAssetRecoveryOutcome>;
}

export type BrowserEncryptedWalletBackupV2RecoveryStatus =
  | { readonly kind: "ready" }
  | {
      readonly kind: "recovering";
      readonly reason: BrowserEncryptedWalletBackupV2ConflictRecoveryIncompleteReason | null;
    };

export interface BrowserEncryptedWalletBackupV2RecoveryInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly seed: Uint8Array;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly enrollmentEpoch: number;
  readonly status: EncryptedWalletBackupV2LocalRecoveryStatus;
  readonly signal: AbortSignal;
  readonly isCurrentProfile: () => boolean;
  readonly authority: EncryptedWalletBackupV2DexieAuthorityStore;
}

/** Test recovery seam. A successful callback must clear durable refusal explicitly. */
export type BrowserEncryptedWalletBackupV2RecoveryCallback = (
  input: BrowserEncryptedWalletBackupV2RecoveryInput,
) => Promise<void>;

const targetedDrivers = new Map<string, BrowserEncryptedWalletBackupV2RuntimeDriver>();

/** Registers the exact live driver for one browser wallet profile. */
export function registerBrowserEncryptedWalletBackupV2RuntimeDriver(
  scopeId: string,
  driver: BrowserEncryptedWalletBackupV2RuntimeDriver,
): () => void {
  targetedDrivers.set(scopeId, driver);
  return () => {
    if (targetedDrivers.get(scopeId) === driver) targetedDrivers.delete(scopeId);
  };
}

export function activeBrowserEncryptedWalletBackupV2RuntimeDriver(
  scopeId: string,
): BrowserEncryptedWalletBackupV2RuntimeDriver | null {
  return targetedDrivers.get(scopeId) ?? null;
}

/** Wakes a paused backup driver after an existing recovery owner finishes one pass. */
export function resumeBrowserEncryptedWalletBackupV2AfterRecovery(scopeId: string): void {
  activeBrowserEncryptedWalletBackupV2RuntimeDriver(scopeId)?.resumeAfterRecovery();
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
  /** Test seam. Production holds a wallet-scoped Web Lock until cleanup. */
  readonly leadership?: BrowserEncryptedWalletBackupLeadership;
  /** Test seam. Production uses one cancellable browser timer. */
  readonly scheduleRetry?: (task: () => void, delayMilliseconds: number) => () => void;
  /** Test seam. Production uses the browser wallet-profile lock. */
  readonly lockManager?: Pick<LockManager, "request">;
  /** Test seam. Production persists one retry schedule for the wallet. */
  readonly scheduleDurableRetry?: typeof scheduleEncryptedWalletBackupRetry;
  /** Test seam. Production uses one cancellable acknowledgement deadline. */
  readonly scheduleManagedRemoveTimeout?: (
    task: () => void,
    delayMilliseconds: number,
  ) => () => void;
  /** Test seam. Production reports terminal background failures to the console. */
  readonly reportError?: (error: unknown) => void;
  /** Loads the deterministic msat wallet for one mint during conflict recovery. */
  readonly loadWallet?: (mintUrl: string) => Promise<CashuWallet>;
  /** Narrow test seam. Production uses the conflict-recovery coordinator. */
  readonly recovery?: BrowserEncryptedWalletBackupV2RecoveryCallback;
  /** Reports the captured profile's durable recovery state to the shell. */
  readonly onRecoveryStatusChange?: (status: BrowserEncryptedWalletBackupV2RecoveryStatus) => void;
}

type BackupRemote = EncryptedWalletBackupV2RemotePort &
  EncryptedWalletBackupAccountOperationRemotePort;

type EncryptedWalletBackupDriverState =
  | "key-handle"
  | "leadership-wait"
  | "leadership-active"
  | "enrollment"
  | "startup"
  | "retry"
  | "service-quota"
  | "authenticated"
  | "recovery-paused"
  | "terminal";

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
  readonly #keyHandlePromise: Promise<EncryptedWalletBackupV2KeyHandle>;
  #enrollmentEpoch: number | undefined;
  #enrollmentEpochPromise: Promise<number> | undefined;
  #pendingDesiredAssetFingerprint = "";
  #serviceQuotaPendingFingerprint: string | null = null;
  #initialized = false;
  #initializing = false;
  #leader = false;
  #terminal = false;
  #running = false;
  #cycleQueued = false;
  #cancelTimer: (() => void) | undefined;
  #timerKind: "retry" | "quota" | undefined;
  #timerScheduling = false;
  #recoveryAttempted = false;
  #recoveryPaused = false;
  #recoveryWakeQueued = false;
  #recoveryReason: BrowserEncryptedWalletBackupV2ConflictRecoveryIncompleteReason | null = null;
  #authenticationSession: BrowserWalletBackupAuthenticationSession | undefined;
  #sessionAuthenticated = false;
  #diagnosticState: EncryptedWalletBackupDriverState | undefined;
  readonly #removeReadinessWaiters = new Set<() => void>();

  constructor(input: BrowserEncryptedWalletBackupV2RuntimeDriverInput) {
    this.#input = input;
    this.#runtime = input.runtime ?? browserRuntime();
    this.#remote = input.remote ?? createRemote(input.configuration);
    this.#runWorkerCycle = input.runWorkerCycle ?? runBrowserEncryptedWalletBackupV2WorkerCycle;
    this.#lifetimeSignal = AbortSignal.any([input.signal, this.#cleanup.signal]);
    this.#keyHandlePromise = createEncryptedWalletBackupV2KeyHandle({
      seed: input.seed,
      realm: input.configuration.realm,
      runtime: this.#runtime,
    });
  }

  start(): this {
    this.#authenticationSession = beginBrowserWalletBackupAuthenticationSession({
      database: this.#input.database,
      scopeId: this.#input.scopeId,
      realm: this.#input.configuration.realm,
    });
    void this.#acquireLeadership();
    return this;
  }

  stop(): void {
    this.#cleanup.abort();
    this.#stopLeader();
  }

  get recoveryReason(): BrowserEncryptedWalletBackupV2ConflictRecoveryIncompleteReason | null {
    return this.#recoveryReason;
  }

  async removeManagedProofs(input: {
    readonly asset: EncryptedWalletBackupV2AssetIdentity;
    readonly targets: readonly BrowserCtfRemoveTarget[];
  }): Promise<BrowserCtfRemoveResult> {
    if (!this.#isActive()) throw new Error("The wallet backup profile is unavailable");
    const keyHandle = await this.#keyHandlePromise;
    const enrollmentEpoch = await this.#resolveEnrollmentEpoch(keyHandle);
    if (!this.#isActive()) throw new Error("The wallet backup profile changed");
    const assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
      keyHandle,
      mintUrl: input.asset.mintUrl,
      unit: input.asset.unit,
      assetIdentity: input.asset.assetIdentity,
    });
    const removalInput = {
      database: this.#input.database,
      scopeId: this.#input.scopeId,
      keyHandle,
      enrollmentEpoch,
      asset: input.asset,
      assetLocator,
      targets: input.targets,
      isCurrentProfile: () => this.#isActive(),
      lockManager: this.#input.lockManager,
    };
    let result = await startBrowserCtfRemove(removalInput);
    if (result.kind === "pending") {
      const localAssetKey = encryptedWalletBackupV2LocalAssetKey(input.asset);
      const ready = await this.#waitForManagedRemovalReadiness({
        asset: input.asset,
        localAssetKey,
        keyHandle,
        enrollmentEpoch,
      });
      if (!ready || !this.#isActive() || this.#recoveryPaused || this.#terminal) {
        this.#requestCycle();
        return result;
      }
      result = await startBrowserCtfRemove(removalInput);
    }
    this.#requestCycle();
    return result;
  }

  async #waitForManagedRemovalReadiness(input: {
    readonly asset: EncryptedWalletBackupV2AssetIdentity;
    readonly localAssetKey: string;
    readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
    readonly enrollmentEpoch: number;
  }): Promise<boolean> {
    if (!this.#isActive() || this.#recoveryPaused || this.#terminal) return false;
    const authority = new EncryptedWalletBackupV2DexieAuthorityStore({
      database: this.#input.database,
      scopeId: this.#input.scopeId,
      realm: input.keyHandle.realm,
      walletId: input.keyHandle.walletId,
      enrollmentEpoch: input.enrollmentEpoch,
      requestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
    });

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let subscription: Subscription | undefined;
      let cancelTimeout: (() => void) | undefined;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        cancelTimeout?.();
        subscription?.unsubscribe();
        this.#lifetimeSignal.removeEventListener("abort", onAbort);
        this.#removeReadinessWaiters.delete(onRefusal);
        resolve(ready);
      };
      const onAbort = () => finish(false);
      const onRefusal = () => finish(false);
      this.#removeReadinessWaiters.add(onRefusal);
      this.#lifetimeSignal.addEventListener("abort", onAbort, { once: true });
      cancelTimeout = (this.#input.scheduleManagedRemoveTimeout ?? scheduleTimeout)(
        () => finish(false),
        BROWSER_CTF_REMOVE_ACKNOWLEDGEMENT_DEADLINE_MILLISECONDS,
      );

      try {
        subscription = liveQuery(async () => {
          const [rawDesired, prepared, permission] = await Promise.all([
            this.#input.database.encryptedWalletBackupV2DesiredAssets.get([
              this.#input.scopeId,
              input.localAssetKey,
            ]),
            authority.readPreparedMutation(),
            authority.readNewWritePermission(),
          ]);
          const desired =
            rawDesired === undefined
              ? null
              : decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
          return { desired, prepared, permission };
        }).subscribe({
          next: ({ desired, prepared, permission }) => {
            if (
              !this.#isActive() ||
              this.#recoveryPaused ||
              this.#terminal ||
              !permission.canWrite
            ) {
              finish(false);
              return;
            }
            if (
              desired !== null &&
              desired.scopeId === this.#input.scopeId &&
              desired.localAssetKey === input.localAssetKey &&
              desired.mintUrl === input.asset.mintUrl &&
              desired.unit === input.asset.unit &&
              desired.assetIdentity === input.asset.assetIdentity &&
              desired.syncState === "acknowledged" &&
              prepared === null
            ) {
              finish(true);
            }
          },
          error: () => finish(false),
        });
        this.#requestCycle();
      } catch {
        finish(false);
      }
    });
  }

  resumeAfterRecovery(): void {
    if (!this.#isLeaderActive() || !this.#recoveryPaused) return;
    this.#recoveryAttempted = false;
    if (this.#initializing || this.#running) {
      this.#recoveryWakeQueued = true;
      return;
    }
    this.#recoveryPaused = false;
    this.#initialized = false;
    void this.#initialize();
  }

  async recoverTargetedAsset(input: {
    readonly asset: EncryptedWalletBackupV2AssetIdentity;
    readonly requiredAmount: bigint;
    readonly loadWallet: () => Promise<CashuWallet>;
    readonly readExactMonitoringRecovery: () => Promise<BrowserTargetedAssetRecoveryMonitoring | null>;
    readonly lockManager?: Pick<LockManager, "request">;
  }): Promise<TargetedAssetRecoveryOutcome> {
    try {
      if (!this.#isActive()) return { kind: "persistent-error" };
      const keyHandle = await this.#keyHandlePromise;
      if (!this.#isActive()) return { kind: "persistent-error" };
      const enrollmentEpoch = await this.#resolveEnrollmentEpoch(keyHandle);
      if (!this.#isActive()) return { kind: "persistent-error" };
      return await recoverBrowserTargetedAsset({
        database: this.#input.database,
        scopeId: this.#input.scopeId,
        seed: this.#input.seed,
        keyHandle,
        enrollmentEpoch,
        asset: input.asset,
        requiredAmount: input.requiredAmount,
        loadWallet: input.loadWallet,
        readExactMonitoringRecovery: input.readExactMonitoringRecovery,
        remote: this.#remote,
        requestUrl: (kind, value) =>
          kind === "head"
            ? requestUrl(this.#input.configuration, keyHandle, "head", value)
            : objectUrl(this.#input.configuration, keyHandle, requireObjectId(value)),
        currentInventoryUrl: encryptedWalletBackupV2CurrentInventoryUrl(
          this.#input.configuration,
          keyHandle,
        ),
        nowUnixSeconds,
        completedAtUnixMilliseconds: Date.now,
        runtime: this.#runtime,
        signal: this.#lifetimeSignal,
        isCurrentProfile: () => this.#isActive(),
        lockManager: input.lockManager,
      });
    } catch {
      return { kind: "persistent-error" };
    }
  }

  async #acquireLeadership(): Promise<void> {
    try {
      this.#setDiagnosticState("key-handle");
      this.#keyHandle = await this.#keyHandlePromise;
      if (!this.#isActive()) return;
      this.#setDiagnosticState("leadership-wait");
      await (this.#input.leadership ?? browserLeadership()).hold(
        encryptedWalletBackupV2WalletLockName(requireKeyHandle(this.#keyHandle)),
        this.#lifetimeSignal,
        async () => {
          if (!this.#isActive()) return;
          this.#leader = true;
          this.#setDiagnosticState("leadership-active");
          this.#startLeader();
          await this.#resumeOrInitialize();
          await waitForAbort(this.#lifetimeSignal);
        },
      );
    } catch (error) {
      if (this.#isActive()) {
        this.#reportTerminal();
        this.#reportError(error);
      }
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
    this.#notifyRemoveReadinessWaiters();
    this.#initialized = false;
    this.#initializing = false;
    this.#sessionAuthenticated = false;
    this.#authenticationSession?.stop();
    this.#subscription?.unsubscribe();
    this.#subscription = undefined;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#timerKind = undefined;
    this.#recoveryAttempted = false;
    this.#recoveryPaused = false;
    this.#recoveryWakeQueued = false;
    this.#recoveryReason = null;
  }

  async #resumeOrInitialize(): Promise<void> {
    const keyHandle = requireKeyHandle(this.#keyHandle);
    const schedule = await readEncryptedWalletBackupRetryScheduler(this.#input.database, {
      scopeId: this.#input.scopeId,
      realm: keyHandle.realm,
      walletId: keyHandle.walletId,
    });
    if (!this.#isLeaderActive()) return;
    if (schedule !== null && schedule.retryNotBeforeUnixMilliseconds > Date.now()) {
      if (
        this.#armTimer(
          () => void this.#initialize(),
          schedule.retryNotBeforeUnixMilliseconds - Date.now(),
          "retry",
        )
      )
        this.#setDiagnosticState("retry");
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
    this.#pendingDesiredAssetFingerprint = fingerprint;
    if (this.#serviceQuotaPendingFingerprint !== null) {
      if (!changed) return;
      this.#serviceQuotaPendingFingerprint = null;
      if (this.#timerKind === "quota") this.#clearTimer();
    }
    if (rows.length > 0 && (changed || !this.#initialized)) this.#requestCycle();
  }

  #requestCycle(): void {
    if (!this.#initialized || this.#recoveryPaused || !this.#isLeaderActive()) return;
    this.#cycleQueued = true;
    if (!this.#running && !this.#timerScheduling && this.#cancelTimer === undefined)
      void this.#runCycles();
  }

  async #initialize(): Promise<void> {
    if (this.#initializing) return;
    this.#initializing = true;
    try {
      if (!this.#isLeaderActive()) return;
      this.#setDiagnosticState("enrollment");
      const keyHandle = requireKeyHandle(this.#keyHandle);
      this.#enrollmentEpoch = await this.#resolveEnrollmentEpoch(keyHandle);
      if (!this.#isLeaderActive()) return;
      if (!(await this.#allowOrdinaryWrites(keyHandle))) return;
      await this.#clearRetrySchedule();
      if (!this.#isLeaderActive()) return;
      this.#initialized = true;
      this.#requestCycle();
    } catch (error) {
      if (!this.#isLeaderActive()) return;
      if (this.#recoveryPaused) {
        this.#fail(error);
        return;
      }
      if (isRetryable(error))
        await this.#scheduleRetrySafely(() => void this.#initialize(), retryDelay(error));
      else this.#fail(error);
    } finally {
      this.#initializing = false;
      if (this.#recoveryWakeQueued && !this.#running) {
        this.#recoveryWakeQueued = false;
        this.resumeAfterRecovery();
      }
    }
  }

  async #resolveEnrollmentEpoch(keyHandle: EncryptedWalletBackupV2KeyHandle): Promise<number> {
    if (this.#enrollmentEpoch !== undefined) return this.#enrollmentEpoch;
    if (this.#enrollmentEpochPromise !== undefined) return this.#enrollmentEpochPromise;
    const resolving = resolveEncryptedWalletBackupV2EnrollmentEpoch({
      configuration: this.#input.configuration,
      database: this.#input.database,
      scopeId: this.#input.scopeId,
      keyHandle,
      remote: this.#remote,
      runtime: this.#runtime,
      signal: this.#lifetimeSignal,
      authorizationPort: this.#input.authorizationPort,
      isCurrentProfile: () => this.#isActive(),
    }).then((epoch) => {
      if (!this.#isActive()) throw new Error("encrypted backup profile is stale");
      this.#enrollmentEpoch = epoch;
      return epoch;
    });
    this.#enrollmentEpochPromise = resolving;
    try {
      return await resolving;
    } catch (error) {
      if (this.#enrollmentEpochPromise === resolving) this.#enrollmentEpochPromise = undefined;
      throw error;
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
      if (this.#recoveryPaused) {
        this.#fail(error);
        return;
      }
      if (isRetryable(error)) await this.#scheduleRetrySafely(undefined, retryDelay(error));
      else this.#fail(error);
    } finally {
      this.#running = false;
      if (this.#recoveryWakeQueued) {
        this.#recoveryWakeQueued = false;
        this.resumeAfterRecovery();
        return;
      }
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
    const keyHandle = requireKeyHandle(this.#keyHandle);
    if (!(await this.#allowOrdinaryWrites(keyHandle))) return;
    const signal = createEncryptedWalletBackupBackgroundCycleSignal(this.#lifetimeSignal);
    const authenticatingStartup = !this.#sessionAuthenticated;
    this.#setDiagnosticState(authenticatingStartup ? "startup" : "authenticated");
    try {
      if (!authenticatingStartup) {
        await this.#discoverCtfRemovals();
        if (!this.#isLeaderActive()) return;
        if (!(await this.#allowOrdinaryWrites(keyHandle))) return;
      }
      const result = await this.#runWorkerCycle({
        ...this.#workerInput(keyHandle),
        signal,
      });
      if (
        authenticatingStartup &&
        (result.kind === "idle" || result.kind === "head-accepted" || result.kind === "committed")
      ) {
        if (!this.#isLeaderActive()) return;
        const authenticated = this.#authenticationSession?.markAuthenticated(
          requireEnrollmentEpoch(this.#enrollmentEpoch),
          keyHandle.requestAuthPublicKey,
        );
        if (authenticated !== true) return;
        this.#sessionAuthenticated = true;
        this.#setDiagnosticState("authenticated");
        await this.#discoverCtfRemovals();
        if (!this.#isLeaderActive()) return;
        if (!(await this.#allowOrdinaryWrites(keyHandle))) return;
      }
      if (result.kind === "retry-pending") {
        await this.#scheduleRetry(undefined, result.minimumRetryDelayMilliseconds);
        return;
      }
      if (result.kind === "service-quota-pending") {
        this.#serviceQuotaPendingFingerprint = this.#pendingDesiredAssetFingerprint;
        if (
          this.#armTimer(
            () => this.#requestCycle(),
            ENCRYPTED_WALLET_BACKUP_SERVICE_QUOTA_RECHECK_MILLISECONDS,
            "quota",
          )
        )
          this.#setDiagnosticState("service-quota");
        return;
      }
      if (result.kind === "head-accepted" || result.kind === "committed") {
        await this.#clearRetrySchedule();
        this.#cycleQueued = true;
      } else if (result.kind === "conflict-recovered") {
        this.#authenticationSession?.markPending();
        this.#sessionAuthenticated = false;
        if (!(await this.#allowOrdinaryWrites(keyHandle))) return;
        await this.#clearRetrySchedule();
        this.#initialized = false;
        this.#recoveryPaused = true;
        this.#cycleQueued = false;
        this.#setDiagnosticState("recovery-paused");
        // Reauthenticate after this loop exits; no unrelated owner may have work to wake us.
        this.#recoveryWakeQueued = true;
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
        walletId: keyHandle.walletId,
        attemptId: retryAttemptId(keyHandle),
        minimumDelayMilliseconds,
      });
      if (!this.#isLeaderActive()) return;
      if (
        this.#armTimer(
          task ?? (() => this.#requestCycle()),
          Math.max(0, schedule.retryNotBeforeUnixMilliseconds - Date.now()),
          "retry",
        )
      )
        this.#setDiagnosticState("retry");
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

  #armTimer(task: () => void, delayMilliseconds: number, kind: "retry" | "quota"): boolean {
    if (this.#cancelTimer !== undefined || !this.#isLeaderActive()) return false;
    const schedule = this.#input.scheduleRetry ?? scheduleBrowserRetry;
    this.#timerKind = kind;
    this.#cancelTimer = schedule(() => {
      this.#cancelTimer = undefined;
      this.#timerKind = undefined;
      if (this.#isLeaderActive()) task();
    }, delayMilliseconds);
    return true;
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
      walletId: keyHandle.walletId,
      attemptId: retryAttemptId(keyHandle),
    });
  }

  #isActive(): boolean {
    return !this.#lifetimeSignal.aborted && this.#input.isCurrentProfile();
  }

  #isLeaderActive(): boolean {
    return this.#leader && !this.#terminal && this.#isActive();
  }

  async #allowOrdinaryWrites(keyHandle: EncryptedWalletBackupV2KeyHandle): Promise<boolean> {
    const enrollmentEpoch = requireEnrollmentEpoch(this.#enrollmentEpoch);
    const authority = new EncryptedWalletBackupV2DexieAuthorityStore({
      database: this.#input.database,
      scopeId: this.#input.scopeId,
      realm: keyHandle.realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch,
      requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    });
    const permission = await authority.readNewWritePermission();
    if (permission.canWrite) {
      this.#setRecoveryReason(null);
      this.#recoveryPaused = false;
      this.#recoveryAttempted = false;
      return true;
    }
    this.#recoveryPaused = true;
    this.#setDiagnosticState("recovery-paused");
    this.#notifyRemoveReadinessWaiters();
    this.#cycleQueued = false;
    this.#notifyRecoveryStatus({ kind: "recovering", reason: this.#recoveryReason });
    if (this.#recoveryAttempted) return false;
    this.#recoveryAttempted = true;
    const recover = this.#input.recovery ?? ((input) => this.#recoverConflict(input));
    if (!this.#isLeaderActive()) return false;
    await recover({
      database: this.#input.database,
      scopeId: this.#input.scopeId,
      seed: this.#input.seed,
      keyHandle,
      enrollmentEpoch,
      status: {
        localRecoveryStatus: permission.localRecoveryStatus,
        localRecoveryReason: permission.localRecoveryReason,
        localRecoveryVersion: permission.localRecoveryVersion,
      },
      signal: this.#lifetimeSignal,
      isCurrentProfile: () => this.#isLeaderActive(),
      authority,
    });
    if (!this.#isLeaderActive()) return false;
    const completed = await authority.readNewWritePermission();
    if (!completed.canWrite) return false;
    this.#setRecoveryReason(null);
    this.#recoveryPaused = false;
    this.#recoveryAttempted = false;
    return true;
  }

  async #recoverConflict(input: BrowserEncryptedWalletBackupV2RecoveryInput): Promise<void> {
    if (this.#input.loadWallet === undefined) return;
    if ((await input.authority.readPreparedMutation()) !== null) {
      if (!(await this.#recoverPreparedBackup(input.keyHandle))) return;
      if ((await input.authority.readPreparedMutation()) !== null) return;
    }
    const result = await recoverBrowserEncryptedWalletBackupV2Conflict({
      database: input.database,
      scopeId: input.scopeId,
      seed: input.seed,
      keyHandle: input.keyHandle,
      enrollmentEpoch: input.enrollmentEpoch,
      remote: this.#remote,
      requestUrl: (kind, value) =>
        kind === "head"
          ? requestUrl(this.#input.configuration, input.keyHandle, "head", value)
          : objectUrl(this.#input.configuration, input.keyHandle, requireObjectId(value)),
      nowUnixSeconds,
      runtime: this.#runtime,
      signal: input.signal,
      isCurrentProfile: input.isCurrentProfile,
      loadWallet: this.#input.loadWallet,
      lockManager: this.#input.lockManager,
    });
    if (!this.#isLeaderActive()) return;
    switch (result.kind) {
      case "completed":
        break;
      case "incomplete":
        this.#setRecoveryReason(result.reason);
        break;
    }
  }

  #setRecoveryReason(
    reason: BrowserEncryptedWalletBackupV2ConflictRecoveryIncompleteReason | null,
  ): void {
    this.#recoveryReason = reason;
    if (reason !== null) this.#notifyRemoveReadinessWaiters();
    this.#notifyRecoveryStatus(
      reason === null ? { kind: "ready" } : { kind: "recovering", reason },
    );
  }

  #notifyRecoveryStatus(status: BrowserEncryptedWalletBackupV2RecoveryStatus): void {
    if (!this.#isActive()) return;
    this.#input.onRecoveryStatusChange?.(status);
  }

  async #recoverPreparedBackup(keyHandle: EncryptedWalletBackupV2KeyHandle): Promise<boolean> {
    const signal = createEncryptedWalletBackupBackgroundCycleSignal(this.#lifetimeSignal);
    try {
      const result = await this.#runWorkerCycle({ ...this.#workerInput(keyHandle), signal });
      if (!this.#isLeaderActive()) return false;
      if (result.kind === "retry-pending") {
        await this.#scheduleRetry(
          () => this.resumeAfterRecovery(),
          result.minimumRetryDelayMilliseconds,
        );
        return false;
      }
      if (result.kind === "service-quota-pending") {
        if (
          this.#armTimer(
            () => this.resumeAfterRecovery(),
            ENCRYPTED_WALLET_BACKUP_SERVICE_QUOTA_RECHECK_MILLISECONDS,
            "quota",
          )
        )
          this.#setDiagnosticState("service-quota");
        return false;
      }
      return true;
    } catch (error) {
      if (!this.#isLeaderActive()) return false;
      const failure = signal.aborted
        ? new EncryptedWalletBackupV2HttpTransportError("deadline-exceeded")
        : error;
      if (!isRetryable(failure)) throw failure;
      await this.#scheduleRetry(() => this.resumeAfterRecovery(), retryDelay(failure));
      return false;
    }
  }

  #workerInput(
    keyHandle: EncryptedWalletBackupV2KeyHandle,
  ): Parameters<typeof runBrowserEncryptedWalletBackupV2WorkerCycle>[0] {
    return {
      database: this.#input.database,
      scopeId: this.#input.scopeId,
      seed: this.#input.seed,
      keyHandle,
      enrollmentEpoch: requireEnrollmentEpoch(this.#enrollmentEpoch),
      pinnedReceiptKeys: this.#input.configuration.pinnedReceiptKeys,
      remote: this.#remote,
      remoteOrigin: this.#input.configuration.signedOrigin,
      requestUrl: (kind, value) =>
        kind === "object"
          ? objectUrl(this.#input.configuration, keyHandle, requireObjectId(value))
          : requestUrl(this.#input.configuration, keyHandle, kind, value),
      nowUnixSeconds,
      runtime: this.#runtime,
      signal: this.#lifetimeSignal,
      isCurrentProfile: () => this.#isLeaderActive(),
      lockManager: this.#input.lockManager,
    };
  }

  async #discoverCtfRemovals(): Promise<void> {
    await discoverBrowserCtfRemovals({
      database: this.#input.database,
      scopeId: this.#input.scopeId,
      keyHandle: requireKeyHandle(this.#keyHandle),
      enrollmentEpoch: requireEnrollmentEpoch(this.#enrollmentEpoch),
      isCurrentProfile: () => this.#isLeaderActive(),
    });
  }

  #fail(error: unknown): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#notifyRemoveReadinessWaiters();
    this.#initialized = false;
    this.#sessionAuthenticated = false;
    this.#authenticationSession?.markPending();
    this.#cycleQueued = false;
    this.#subscription?.unsubscribe();
    this.#subscription = undefined;
    this.#clearTimer();
    this.#reportTerminal();
    this.#reportError(error);
  }

  #setDiagnosticState(state: EncryptedWalletBackupDriverState): void {
    if (!this.#isActive() || this.#diagnosticState === state) return;
    this.#diagnosticState = state;
    console.info(`encrypted-backup-driver-state=${state}`);
  }

  #reportTerminal(): void {
    if (!this.#isActive()) return;
    console.info(
      `encrypted-backup-driver-failure-stage=${encryptedWalletBackupDriverFailureStage(this.#diagnosticState)}`,
    );
    this.#setDiagnosticState("terminal");
  }

  #reportError(error: unknown): void {
    (this.#input.reportError ?? reportBrowserBackupError)(error);
  }

  #notifyRemoveReadinessWaiters(): void {
    for (const notify of [...this.#removeReadinessWaiters]) notify();
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
    walletId: input.keyHandle.walletId,
    requestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
    beforeCommit: () => requireCurrentProfile(input),
  });
  requireCurrentProfile(input);
  const issuedAtUnixSeconds = (input.nowUnixSeconds ?? nowUnixSeconds)();
  const discovery = await prepareEncryptedWalletBackupV2EnrollmentEpochDiscoveryProof({
    keyHandle: input.keyHandle,
    url: enrollmentEpochUrl(input.configuration, input.keyHandle.walletId),
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
  const base = `${configuration.signedOrigin}/v1/encrypted-wallet-backup/realms/${configuration.realm}/wallets/${keyHandle.walletId}`;
  if (kind === "mutation") return `${base}/head:compare-and-swap`;
  return afterBundleId === null ? `${base}/head` : `${base}/head/after/${afterBundleId}`;
}

function enrollmentEpochUrl(
  configuration: EncryptedWalletBackupConfiguration,
  walletId: string,
): string {
  return `${configuration.signedOrigin}/v1/encrypted-wallet-backup/realms/${configuration.realm}/wallets/${walletId}/enrollment-epoch`;
}

function accountUrl(configuration: EncryptedWalletBackupConfiguration): string {
  return `${configuration.signedOrigin}/v1/encrypted-wallet-backup/realms/${configuration.realm}/wallets:enroll`;
}

export function encryptedWalletBackupV2CurrentInventoryUrl(
  configuration: EncryptedWalletBackupConfiguration,
  keyHandle: EncryptedWalletBackupV2KeyHandle,
): string {
  return `${configuration.signedOrigin}/v1/encrypted-wallet-backup/realms/${configuration.realm}/wallets/${keyHandle.walletId}/current-inventory`;
}

function objectUrl(
  configuration: EncryptedWalletBackupConfiguration,
  keyHandle: EncryptedWalletBackupV2KeyHandle,
  objectId: string,
): string {
  return `${configuration.signedOrigin}/v1/encrypted-wallet-backup/realms/${configuration.realm}/wallets/${keyHandle.walletId}/objects/${objectId}`;
}

function requireObjectId(value: string | null): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) {
    throw new Error("encrypted backup object id is invalid");
  }
  return value;
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

function scheduleTimeout(task: () => void, delayMilliseconds: number): () => void {
  const timer = setTimeout(task, delayMilliseconds);
  return () => clearTimeout(timer);
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

/** Returns the canonical Web Lock name for one encrypted-backup wallet. */
export function encryptedWalletBackupV2WalletLockName(input: {
  readonly realm: string;
  readonly walletId: string;
}): string {
  return `bitcaster/encrypted-wallet-backup/v2/${input.realm}/${input.walletId}`;
}

function retryAttemptId(keyHandle: EncryptedWalletBackupV2KeyHandle): string {
  return keyHandle.walletId.slice(0, 32);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function reportBrowserBackupError(error: unknown): void {
  console.warn(`encrypted-backup-driver-error=${encryptedWalletBackupDriverErrorCode(error)}`);
  console.warn(
    `encrypted-backup-driver-failure-site=${encryptedWalletBackupDriverFailureSite(error)}`,
  );
}

type EncryptedWalletBackupDriverFailureSiteOwner =
  | "driver"
  | "worker"
  | "asset-source"
  | "ctf-removal"
  | "authority-store"
  | "sdk-proof-set"
  | "sdk-service-codec"
  | "sdk-sync";

const maximumEncryptedWalletBackupStackBytes = 16 * 1024;
const maximumEncryptedWalletBackupStackCodeUnits = maximumEncryptedWalletBackupStackBytes / 2;
const maximumEncryptedWalletBackupFrameLines = 32;
const maximumEncryptedWalletBackupFailureSites = 3;
const maximumEncryptedWalletBackupFrameCoordinate = 999_999;

const encryptedWalletBackupAppFailureSiteOwners: Readonly<
  Record<string, EncryptedWalletBackupDriverFailureSiteOwner>
> = {
  "/src/lib/encryptedWalletBackupDriver.ts": "driver",
  "/src/lib/browserEncryptedWalletBackupV2Worker.ts": "worker",
  "/src/lib/browserCtfRemoveCoordinator.ts": "ctf-removal",
  "/src/stores/browser-encrypted-wallet-backup-v2-asset-source.ts": "asset-source",
  "/src/stores/encrypted-wallet-backup-v2-db.ts": "authority-store",
};

const encryptedWalletBackupSdkFailureSiteSuffixes: readonly [
  suffix: string,
  owner: EncryptedWalletBackupDriverFailureSiteOwner,
][] = [
  ["/bitCaster/bitcaster-client-sdk/src/encryptedWalletBackupV2ProofSet.ts", "sdk-proof-set"],
  [
    "/bitCaster/bitcaster-client-sdk/src/encryptedWalletBackupV2ServiceCodec.ts",
    "sdk-service-codec",
  ],
  ["/bitCaster/bitcaster-client-sdk/src/encryptedWalletBackupV2Sync.ts", "sdk-sync"],
];

/** Returns only fixed source owners and bounded coordinates from valid stack frames. */
export function encryptedWalletBackupDriverFailureSite(error: unknown): string {
  try {
    if ((typeof error !== "object" && typeof error !== "function") || error === null) {
      return "unknown";
    }

    const stack = (error as { readonly stack?: unknown }).stack;
    if (typeof stack !== "string") return "unknown";

    // JavaScript stores strings as UTF-16. Half the byte limit bounds this read even for ASCII.
    const boundedStack = stack.slice(0, maximumEncryptedWalletBackupStackCodeUnits);
    const headlineEnd = boundedStack.indexOf("\n");
    if (headlineEnd < 0) return "unknown";

    const sites: string[] = [];
    let lineStart = headlineEnd + 1;
    for (
      let frameIndex = 0;
      frameIndex < maximumEncryptedWalletBackupFrameLines &&
      lineStart <= boundedStack.length &&
      sites.length < maximumEncryptedWalletBackupFailureSites;
      frameIndex += 1
    ) {
      const lineEnd = boundedStack.indexOf("\n", lineStart);
      const frameLine = boundedStack.slice(lineStart, lineEnd < 0 ? boundedStack.length : lineEnd);
      const location = parseEncryptedWalletBackupStackFrame(frameLine);
      if (location !== null) {
        const owner = encryptedWalletBackupFailureSiteOwner(location.pathname);
        if (owner !== undefined) sites.push(`${owner}@${location.line}:${location.column}`);
      }
      if (lineEnd < 0) break;
      lineStart = lineEnd + 1;
    }

    return sites.length === 0 ? "unknown" : sites.join(",");
  } catch {
    return "unknown";
  }
}

function parseEncryptedWalletBackupStackFrame(
  frameLine: string,
): { readonly pathname: string; readonly line: number; readonly column: number } | null {
  const frame = /^\s*at\s+(.+?)\s*$/.exec(frameLine);
  if (frame?.[1] === undefined) return null;

  let location = frame[1];
  if (location.endsWith(")")) {
    const functionSeparator = location.lastIndexOf(" (");
    if (functionSeparator >= 0) location = location.slice(functionSeparator + 2, -1);
  }

  const coordinates = /^(.*):([0-9]{1,6}):([0-9]{1,6})$/.exec(location);
  if (
    coordinates?.[1] === undefined ||
    coordinates[2] === undefined ||
    coordinates[3] === undefined
  ) {
    return null;
  }
  const line = Number(coordinates[2]);
  const column = Number(coordinates[3]);
  if (
    line < 1 ||
    line > maximumEncryptedWalletBackupFrameCoordinate ||
    column < 1 ||
    column > maximumEncryptedWalletBackupFrameCoordinate
  ) {
    return null;
  }

  try {
    const locationUrl = new URL(coordinates[1], "http://localhost");
    return { pathname: locationUrl.pathname, line, column };
  } catch {
    return null;
  }
}

function encryptedWalletBackupFailureSiteOwner(
  pathname: string,
): EncryptedWalletBackupDriverFailureSiteOwner | undefined {
  const appOwner = Object.hasOwn(encryptedWalletBackupAppFailureSiteOwners, pathname)
    ? encryptedWalletBackupAppFailureSiteOwners[pathname]
    : undefined;
  if (appOwner !== undefined) return appOwner;
  if (!pathname.startsWith("/@fs/")) return undefined;

  return encryptedWalletBackupSdkFailureSiteSuffixes.find(([suffix]) =>
    pathname.endsWith(suffix),
  )?.[1];
}

const safeEncryptedWalletBackupTransportErrorCodes = new Set<string>([
  "concurrency-exhausted",
  "deadline-exceeded",
  "invalid-request",
  "invalid-response",
  "transport-failure",
  "unauthorized",
  "replay-rejected",
  "conflict",
  "not-found",
  "quota-exceeded",
  "rate-limited",
  "overloaded",
  "unavailable",
]);

function encryptedWalletBackupDriverErrorCode(error: unknown): string {
  if (error instanceof EncryptedWalletBackupRemoteBackoffError) return "remote-backoff";
  if (error instanceof EncryptedWalletBackupV2HttpTransportError) {
    return safeEncryptedWalletBackupTransportErrorCodes.has(error.code) ? error.code : "unknown";
  }
  return "unknown";
}

function encryptedWalletBackupDriverFailureStage(
  state: EncryptedWalletBackupDriverState | undefined,
): string {
  switch (state) {
    case "key-handle":
      return "key-handle";
    case "leadership-wait":
    case "leadership-active":
      return "leadership";
    case "enrollment":
      return "enrollment";
    case "startup":
      return "startup";
    case "retry":
      return "retry";
    case "service-quota":
      return "service-quota";
    case "authenticated":
      return "authenticated";
    case "recovery-paused":
      return "recovery";
    case "terminal":
    case undefined:
      return "unknown";
  }
}

function requireText(value: unknown): string {
  if (typeof value !== "string") throw new Error("encrypted backup Nostr event is invalid");
  return value;
}

function requireInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error("encrypted backup Nostr event is invalid");
  return value as number;
}
