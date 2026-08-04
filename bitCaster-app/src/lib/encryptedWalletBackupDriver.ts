import { NDKEvent } from "@nostr-dev-kit/ndk";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  EncryptedWalletBackupDeadlineError,
  EncryptedWalletBackupRemoteBackoffError,
  synchronizeEncryptedWalletBackupManifestHead,
  type EncryptedWalletBackupClock,
  type EncryptedWalletBackupKeyHandle,
} from "@bitcaster/client-sdk/encryptedWalletBackup";
import {
  executeEncryptedWalletBackupAccountOperation,
  prepareEncryptedWalletBackupAccountOperation,
  type EncryptedWalletBackupAccountOperationRemotePort,
} from "@bitcaster/client-sdk/encryptedWalletBackupEnrollment";
import {
  EncryptedWalletBackupHttpAdapter,
  EncryptedWalletBackupHttpTransportError,
} from "@bitcaster/client-sdk/encryptedWalletBackupHttpAdapter";
import { createEncryptedWalletBackupNip98AccountAuthorizationPort } from "@bitcaster/client-sdk/encryptedWalletBackupNip98AccountAuthorization";
import {
  cleanUpRejectedEncryptedWalletBackupFork,
  runBoundedEncryptedWalletBackupUploadCycle,
  type EncryptedWalletBackupUploadAttemptClaim,
  type EncryptedWalletBackupBoundedUploadObjectSource,
  type EncryptedWalletBackupObjectRemotePort,
} from "@bitcaster/client-sdk/encryptedWalletBackupSync";
import { browserWalletDatabaseName } from "./browserWalletProfile";
import {
  createEncryptedWalletBackupTransportFetch,
  type EncryptedWalletBackupConfiguration,
} from "./encryptedWalletBackupConfig";
import { getNdk } from "./nostr";
import { EncryptedWalletBackupEnrollmentDexieStore } from "../stores/encrypted-wallet-backup-enrollment-db";
import { EncryptedWalletBackupSnapshotManifestDexieStore } from "../stores/encrypted-wallet-backup-snapshot-manifest-db";
import { runEncryptedWalletBackupSnapshotCleanupPage } from "../stores/encrypted-wallet-backup-snapshot-cleanup-db";
import {
  clearEncryptedWalletBackupRetryScheduler,
  createEncryptedWalletBackupUploadCoordinatorDexieStore,
  findEncryptedWalletBackupUploadAttemptId,
  readEncryptedWalletBackupRetryScheduler,
  readEncryptedWalletBackupUploadAttemptSummary,
  scheduleEncryptedWalletBackupRetry,
} from "../stores/encrypted-wallet-backup-upload-coordinator-db";
import type { BitcasterDB } from "../stores/proof-db";

const LEASE_MILLISECONDS = 60_000;

type BackupRemote = EncryptedWalletBackupAccountOperationRemotePort &
  EncryptedWalletBackupObjectRemotePort & {
    compareAndSwapCurrentHead: EncryptedWalletBackupHttpAdapter["compareAndSwapCurrentHead"];
    readCurrentHead: EncryptedWalletBackupHttpAdapter["readCurrentHead"];
    abortUploadAttempt: EncryptedWalletBackupHttpAdapter["abortUploadAttempt"];
  };

export type EncryptedWalletBackupDriverCycleResult =
  | Readonly<{ state: "idle-needs-snapshot" }>
  | Readonly<{ state: "cleanup-pending" }>
  | Readonly<{ state: "lease-pending"; wakeAtUnixMilliseconds: number }>
  | Readonly<{ state: "upload-pending"; attemptId: string; vaultId: string }>
  | Readonly<{
      state: "cas-pending";
      attemptId: string;
      vaultId: string;
      retryStreak: number;
      retryNotBeforeUnixMilliseconds: number | null;
    }>
  | Readonly<{
      state: "retry-pending";
      attemptId: string;
      vaultId: string;
      retryNotBeforeUnixMilliseconds: number;
    }>
  | Readonly<{ state: "committed"; attemptId: string; vaultId: string }>;

export interface EncryptedWalletBackupDriverInput {
  readonly configuration: EncryptedWalletBackupConfiguration;
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly signal: AbortSignal;
  readonly ownerId: string;
  readonly fetch?: typeof fetch;
  readonly clock?: EncryptedWalletBackupClock;
  readonly remote?: BackupRemote;
  /** Test seam. Production calls use the active Dexie-backed source. */
  readonly source?: EncryptedWalletBackupBoundedUploadObjectSource;
  /** Test seam. Production uses the browser wallet-profile lock. */
  readonly lockManager?: Pick<LockManager, "request">;
}

/**
 * Runs one bounded background cycle. It resumes only durable coordinator work.
 * D4b2 supplies first-snapshot construction before this seam receives new work.
 */
export async function runEncryptedWalletBackupDriverCycle(
  input: EncryptedWalletBackupDriverInput,
): Promise<EncryptedWalletBackupDriverCycleResult> {
  requireInput(input);
  const keyHandle = input.keyHandle;
  const attemptId = await findEncryptedWalletBackupUploadAttemptId(input.database, {
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
  });
  if (attemptId === null) {
    const cleanup = await runEncryptedWalletBackupSnapshotCleanupPage({
      database: input.database,
      scopeId: input.scopeId,
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
      lockManager: input.lockManager,
    });
    return cleanup.state === "progress" && cleanup.job !== null
      ? Object.freeze({ state: "cleanup-pending" })
      : Object.freeze({ state: "idle-needs-snapshot" });
  }
  const attempt = await readEncryptedWalletBackupUploadAttemptSummary(input.database, {
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
    attemptId,
  });
  const now = Date.now();
  const wakeAtUnixMilliseconds = Math.max(
    attempt.ownerId === input.ownerId ? 0 : attempt.leaseExpiresAtUnixMilliseconds,
    attempt.executionLeaseExpiresAtUnixMilliseconds ?? 0,
  );
  if (wakeAtUnixMilliseconds > now) {
    return Object.freeze({
      state: "lease-pending",
      wakeAtUnixMilliseconds,
    });
  }
  const retryScheduler = await readEncryptedWalletBackupRetryScheduler(input.database, {
    scopeId: input.scopeId,
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
  });
  if (retryScheduler !== null && retryScheduler.attemptId !== attemptId) {
    await clearEncryptedWalletBackupRetryScheduler(input.database, {
      scopeId: input.scopeId,
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
      attemptId: retryScheduler.attemptId,
    });
  }
  if (
    retryScheduler?.attemptId === attemptId &&
    now < retryScheduler.retryNotBeforeUnixMilliseconds
  ) {
    return Object.freeze({
      state: "retry-pending",
      attemptId,
      vaultId: keyHandle.vaultId,
      retryNotBeforeUnixMilliseconds: retryScheduler.retryNotBeforeUnixMilliseconds,
    });
  }

  try {
    const remote = input.remote ?? createRemote(input.configuration, input.fetch);
    const clock = input.clock ?? systemClock();
    const enrollment = new EncryptedWalletBackupEnrollmentDexieStore({
      database: input.database,
      scopeId: input.scopeId,
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
      requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    });
    const enrollmentEpoch = await ensureEnrollment({
      keyHandle,
      enrollment,
      remote,
      configuration: input.configuration,
      signal: input.signal,
    });
    const coordinator = createEncryptedWalletBackupUploadCoordinatorDexieStore(input.database);
    const source =
      input.source ??
      new EncryptedWalletBackupSnapshotManifestDexieStore({
        database: input.database,
        scopeId: input.scopeId,
        realm: keyHandle.realm,
        vaultId: keyHandle.vaultId,
      });
    const cycle = await runBoundedEncryptedWalletBackupUploadCycle({
      initialAttempt: null,
      ownerId: input.ownerId,
      leaseDurationMilliseconds: LEASE_MILLISECONDS,
      keyHandle,
      store: coordinator,
      source,
      enrollmentEpoch,
      clock,
      objectUrl: (objectId) => objectUrl(input.configuration, keyHandle.vaultId, objectId),
      remote,
      signal: input.signal,
    });
    if (cycle.state === "fork-cleanup-pending") {
      return await cleanUpRejectedFork({
        input,
        keyHandle,
        coordinator,
        remote,
        clock,
        enrollmentEpoch,
        claim: cycle.claim,
      });
    }
    if (cycle.state === "upload-pending") {
      return Object.freeze({ state: "upload-pending", attemptId, vaultId: keyHandle.vaultId });
    }
    const synchronized = await synchronizeEncryptedWalletBackupManifestHead({
      attempt: cycle.attempt,
      keyHandle,
      enrollmentEpoch,
      casUrl: vaultUrl(input.configuration, keyHandle.vaultId, "head:compare-and-swap"),
      headUrl: vaultUrl(input.configuration, keyHandle.vaultId, "head"),
      clock,
      remote,
      signal: input.signal,
    });
    switch (synchronized.record.state) {
      case "fork-rejected":
        return await cleanUpRejectedFork({
          input,
          keyHandle,
          coordinator,
          remote,
          clock,
          enrollmentEpoch,
          claim: cycle.claim,
        });
      case "acknowledged":
        await clearRetryScheduler(input, attemptId);
        await runEncryptedWalletBackupSnapshotCleanupPage({
          database: input.database,
          scopeId: input.scopeId,
          realm: keyHandle.realm,
          vaultId: keyHandle.vaultId,
          acknowledgedAttempt: synchronized,
          lockManager: input.lockManager,
        });
        return Object.freeze({ state: "committed", attemptId, vaultId: keyHandle.vaultId });
      case "sealed":
      case "cas-uncertain":
      case "retry-cas":
      case "retry-exhausted":
      case "reconcile-before-retry":
        await clearRetryScheduler(input, attemptId);
        return Object.freeze({
          state: "cas-pending",
          attemptId,
          vaultId: keyHandle.vaultId,
          retryStreak: synchronized.record.retryStreak,
          retryNotBeforeUnixMilliseconds: synchronized.record.retryNotBeforeUnixMilliseconds,
        });
      default:
        return assertNeverSyncState(synchronized.record.state);
    }
  } catch (error) {
    const minimumDelayMilliseconds = retryMinimumDelayMilliseconds(error);
    if (minimumDelayMilliseconds === null) throw error;
    const scheduled = await scheduleEncryptedWalletBackupRetry(input.database, {
      scopeId: input.scopeId,
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
      attemptId,
      minimumDelayMilliseconds,
    });
    return Object.freeze({
      state: "retry-pending",
      attemptId,
      vaultId: keyHandle.vaultId,
      retryNotBeforeUnixMilliseconds: scheduled.retryNotBeforeUnixMilliseconds,
    });
  }
}

async function clearRetryScheduler(
  input: EncryptedWalletBackupDriverInput,
  attemptId: string,
): Promise<void> {
  await clearEncryptedWalletBackupRetryScheduler(input.database, {
    scopeId: input.scopeId,
    realm: input.keyHandle.realm,
    vaultId: input.keyHandle.vaultId,
    attemptId,
  });
}

function assertNeverSyncState(value: never): never {
  throw new Error(`unsupported encrypted backup sync state: ${String(value)}`);
}

export function retryMinimumDelayMilliseconds(error: unknown): number | null {
  if (error instanceof EncryptedWalletBackupRemoteBackoffError) {
    return error.status === "quota-exceeded" ? null : error.delayMilliseconds();
  }
  if (error instanceof EncryptedWalletBackupDeadlineError) return 5_000;
  if (
    error instanceof EncryptedWalletBackupHttpTransportError &&
    (error.code === "transport-failure" ||
      error.code === "deadline-exceeded" ||
      error.code === "concurrency-exhausted")
  ) {
    return 5_000;
  }
  return null;
}

function createRemote(
  configuration: EncryptedWalletBackupConfiguration,
  fetchPort: typeof fetch | undefined,
): EncryptedWalletBackupHttpAdapter {
  return new EncryptedWalletBackupHttpAdapter({
    origin: configuration.signedOrigin,
    fetch: createEncryptedWalletBackupTransportFetch({
      signedOrigin: configuration.signedOrigin,
      transportOrigin: configuration.transportOrigin,
      fetch: fetchPort,
    }),
  });
}

async function cleanUpRejectedFork(input: {
  readonly input: EncryptedWalletBackupDriverInput;
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly coordinator: ReturnType<typeof createEncryptedWalletBackupUploadCoordinatorDexieStore>;
  readonly remote: BackupRemote;
  readonly clock: EncryptedWalletBackupClock;
  readonly enrollmentEpoch: number;
  readonly claim: EncryptedWalletBackupUploadAttemptClaim;
}): Promise<EncryptedWalletBackupDriverCycleResult> {
  await cleanUpRejectedEncryptedWalletBackupFork({
    claim: input.claim,
    store: input.coordinator,
    keyHandle: input.keyHandle,
    enrollmentEpoch: input.enrollmentEpoch,
    url: uploadAttemptUrl(
      input.input.configuration,
      input.keyHandle.vaultId,
      input.claim.record.attemptId,
    ),
    clock: input.clock,
    remote: input.remote,
    signal: input.input.signal,
  });
  await clearEncryptedWalletBackupRetryScheduler(input.input.database, {
    scopeId: input.input.scopeId,
    realm: input.keyHandle.realm,
    vaultId: input.keyHandle.vaultId,
    attemptId: input.claim.record.attemptId,
  });
  return Object.freeze({ state: "idle-needs-snapshot" });
}

async function ensureEnrollment(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly enrollment: EncryptedWalletBackupEnrollmentDexieStore;
  readonly remote: BackupRemote;
  readonly configuration: EncryptedWalletBackupConfiguration;
  readonly signal: AbortSignal;
}): Promise<number> {
  const persisted = await input.enrollment.read();
  if (persisted !== null) return persisted.observedEnrollmentEpoch;
  const operation = await prepareEncryptedWalletBackupAccountOperation({
    keyHandle: input.keyHandle,
    action: "enroll",
    url: accountUrl(input.configuration),
    operationId: randomOperationId(),
    expectedEnrollmentEpoch: 0,
    authorizationPort: createEncryptedWalletBackupNip98AccountAuthorizationPort({
      signer: currentNostrSigner(),
    }),
    signal: input.signal,
  });
  const committed = await executeEncryptedWalletBackupAccountOperation({
    operation,
    remote: input.remote,
    store: input.enrollment,
  });
  if (committed.record.lifecycle !== "active") throw new Error("backup enrollment is not active");
  return committed.record.observedEnrollmentEpoch;
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
        id: requireText(raw.id, "Nostr event id"),
        pubkey: requireText(raw.pubkey, "Nostr event pubkey"),
        createdAtUnixSeconds: requireInteger(raw.created_at, "Nostr event time"),
        kind: requireInteger(raw.kind, "Nostr event kind"),
        tags: raw.tags.map((tag) => [...tag]),
        content: raw.content,
        signature: requireText(raw.sig, "Nostr event signature"),
      };
    },
  };
}

function accountUrl(configuration: EncryptedWalletBackupConfiguration): string {
  return `${configuration.signedOrigin}/v1/encrypted-wallet-backup/realms/${configuration.realm}/vaults:enroll`;
}

function vaultUrl(
  configuration: EncryptedWalletBackupConfiguration,
  vaultId: string,
  endpoint: "head" | "head:compare-and-swap",
): string {
  return `${configuration.signedOrigin}/v1/encrypted-wallet-backup/realms/${configuration.realm}/vaults/${vaultId}/${endpoint}`;
}

function objectUrl(
  configuration: EncryptedWalletBackupConfiguration,
  vaultId: string,
  objectId: string,
): string {
  return `${configuration.signedOrigin}/v1/encrypted-wallet-backup/realms/${configuration.realm}/vaults/${vaultId}/objects/${objectId}`;
}

function uploadAttemptUrl(
  configuration: EncryptedWalletBackupConfiguration,
  vaultId: string,
  attemptId: string,
): string {
  return `${configuration.signedOrigin}/v1/encrypted-wallet-backup/realms/${configuration.realm}/vaults/${vaultId}/upload-attempts/${attemptId}`;
}

function systemClock(): EncryptedWalletBackupClock {
  return Object.freeze({ nowUnixSeconds: () => Math.floor(Date.now() / 1_000) });
}

function randomOperationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function requireInput(input: EncryptedWalletBackupDriverInput): void {
  if (
    typeof input.keyHandle !== "object" ||
    input.keyHandle === null ||
    input.database.name !== browserWalletDatabaseName(input.scopeId) ||
    !/^[^\s]{1,128}$/.test(input.ownerId)
  ) {
    throw new Error("encrypted wallet backup driver input is invalid");
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1) throw new Error(`${label} is invalid`);
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`);
  return value as number;
}
