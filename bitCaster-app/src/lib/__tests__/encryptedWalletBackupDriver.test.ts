// @vitest-environment node
import "fake-indexeddb/auto";
import { createBrowserCompletedProofRemovalMarkerRow } from "../../stores/browser-proof-backup-authority";
import * as removeCoordinator from "../browserCtfRemoveCoordinator";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2CurrentHead,
  createEncryptedWalletBackupV2KeyHandle,
  EncryptedWalletBackupV2HttpAdapter,
  EncryptedWalletBackupV2HttpTransportError,
  encodeEncryptedWalletBackupV2CurrentHead,
  encodeEncryptedWalletBackupV2UploadGroup,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  prepareEncryptedWalletBackupV2BundleSupersessionMutation,
  prepareEncryptedWalletBackupV2RequestProof,
  prepareEncryptedWalletBackupV2TransportBundle,
  type EncryptedWalletBackupV2RemotePort,
} from "@bitcaster/client-sdk";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { BitcasterDB } from "../../stores/proof-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  createEncryptedWalletBackupV2RemovalIntent,
} from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { EncryptedWalletBackupV2DexieAuthorityStore } from "../../stores/encrypted-wallet-backup-v2-db";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import {
  createBrowserEncryptedWalletBackupV2RuntimeDriver,
  encryptedWalletBackupDriverFailureSite,
  encryptedWalletBackupV2CurrentInventoryUrl,
  encryptedWalletBackupV2WalletLockName,
  resolveEncryptedWalletBackupV2EnrollmentEpoch,
} from "../encryptedWalletBackupDriver";
import type {
  BrowserEncryptedWalletBackupV2RecoveryCallback,
  BrowserEncryptedWalletBackupV2RecoveryInput,
} from "../encryptedWalletBackupDriver";
import {
  beginBrowserWalletBackupAuthenticationSession,
  BrowserWalletRecoveryRequiredError,
  requireBrowserWalletNewWritePermission,
} from "../browserWalletNewWritePermission";
import {
  BrowserEncryptedWalletBackupV2SeedHandoffRefusal,
  handoffBrowserEncryptedWalletBackupV2Seed,
} from "../browserEncryptedWalletBackupV2SeedHandoff";
import { withWalletProfileLock } from "../walletProfileLock";

const configuration = {
  realm: "backup.example",
  signedOrigin: "https://backup.example",
  transportOrigin: "https://backup.example",
  pinnedReceiptKeys: [
    {
      keyId: "55".repeat(16),
      publicKey: "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
    },
  ],
} as const;

const databases: BitcasterDB[] = [];
let nextSeedByte = 8;

type TestLockRequest = {
  readonly name: string;
  readonly options: LockOptions;
  readonly callback: LockGrantedCallback<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  abort?: () => void;
};

class SharedTestLockManager implements Pick<LockManager, "request"> {
  readonly #held = new Set<string>();
  readonly #queued = new Map<string, TestLockRequest[]>();
  readonly #grantCounts = new Map<string, number>();
  readonly #queueCounts = new Map<string, number>();
  readonly #grantWaiters = new Map<
    string,
    { readonly count: number; readonly resolve: () => void }[]
  >();
  readonly #queueWaiters = new Map<
    string,
    { readonly count: number; readonly resolve: () => void }[]
  >();

  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    callback?: LockGrantedCallback<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const grant = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    if (grant === undefined) return Promise.reject(new Error("lock grant callback is required"));
    return new Promise<T>((resolve, reject) => {
      const request: TestLockRequest = {
        name,
        options,
        callback: async (lock) => grant(lock),
        resolve: (value) => resolve(value as T),
        reject,
      };
      if (options.signal?.aborted) {
        reject(new DOMException("Lock request was aborted", "AbortError"));
      } else if (options.ifAvailable && this.#held.has(name)) {
        void Promise.resolve(grant(null)).then(resolve, reject);
      } else if (this.#held.has(name)) {
        this.#enqueue(request);
      } else {
        this.#grant(request);
      }
    });
  }

  grantCount(name: string): number {
    return this.#grantCounts.get(name) ?? 0;
  }

  isHeld(name: string): boolean {
    return this.#held.has(name);
  }

  async waitForGrantWithin(name: string, count: number, timeoutMs: number): Promise<boolean> {
    if (this.grantCount(name) >= count) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<boolean>((resolve) => {
          const waiters = this.#grantWaiters.get(name) ?? [];
          waiters.push({ count, resolve: () => resolve(true) });
          this.#grantWaiters.set(name, waiters);
        }),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async waitForQueuedWithin(name: string, count: number, timeoutMs: number): Promise<boolean> {
    if ((this.#queueCounts.get(name) ?? 0) >= count) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<boolean>((resolve) => {
          const waiters = this.#queueWaiters.get(name) ?? [];
          waiters.push({ count, resolve: () => resolve(true) });
          this.#queueWaiters.set(name, waiters);
        }),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #enqueue(request: TestLockRequest): void {
    const queue = this.#queued.get(request.name) ?? [];
    queue.push(request);
    this.#queued.set(request.name, queue);
    const queueCount = (this.#queueCounts.get(request.name) ?? 0) + 1;
    this.#queueCounts.set(request.name, queueCount);
    const waiters = this.#queueWaiters.get(request.name) ?? [];
    for (const waiter of waiters.filter(({ count }) => count <= queueCount)) waiter.resolve();
    this.#queueWaiters.set(
      request.name,
      waiters.filter(({ count }) => count > queueCount),
    );
    if (request.options.signal !== undefined) {
      request.abort = () => {
        const pending = this.#queued.get(request.name);
        if (pending === undefined) return;
        const index = pending.indexOf(request);
        if (index >= 0) pending.splice(index, 1);
        request.reject(new DOMException("Lock request was aborted", "AbortError"));
      };
      request.options.signal.addEventListener("abort", request.abort, { once: true });
    }
  }

  #grant(request: TestLockRequest): void {
    if (request.options.signal?.aborted) {
      request.reject(new DOMException("Lock request was aborted", "AbortError"));
      return;
    }
    const { name, options } = request;
    this.#held.add(name);
    const grantCount = this.grantCount(name) + 1;
    this.#grantCounts.set(name, grantCount);
    const waiters = this.#grantWaiters.get(name) ?? [];
    for (const waiter of waiters.filter(({ count }) => count <= grantCount)) waiter.resolve();
    this.#grantWaiters.set(
      name,
      waiters.filter(({ count }) => count > grantCount),
    );
    if (request.abort !== undefined) {
      options.signal?.removeEventListener("abort", request.abort);
    }
    const lock = { name, mode: options.mode ?? "exclusive" } as Lock;
    void Promise.resolve()
      .then(() => request.callback(lock))
      .then(request.resolve, request.reject)
      .finally(() => {
        this.#held.delete(name);
        const queue = this.#queued.get(name);
        const next = queue?.shift();
        if (queue?.length === 0) this.#queued.delete(name);
        if (next !== undefined) this.#grant(next);
      });
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

it("quiesces an active backup leader before seed handoff requests its wallet lock", async () => {
  const fixture = await enrollmentFixture();
  await persistReadyHead(fixture);
  const lockManager = new SharedTestLockManager();
  const walletLockName = encryptedWalletBackupV2WalletLockName({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
  });
  const driver = createRuntime(
    fixture,
    vi.fn().mockResolvedValue({ kind: "idle" }),
    runtimeRemote(),
    () => true,
    undefined,
    {
      hold: async (name, signal, onLeader) =>
        lockManager.request(name, { mode: "exclusive", signal }, async () => {
          if (!signal.aborted) await onLeader();
        }),
    },
  );
  let handoff: Promise<void> | undefined;

  try {
    expect(await lockManager.waitForGrantWithin(walletLockName, 1, 1_000)).toBe(true);
    await driver.quiesceForSeedHandoff();
    expect(lockManager.isHeld(walletLockName)).toBe(false);
    handoff = handoffBrowserEncryptedWalletBackupV2Seed({
      database: fixture.database,
      scopeId: fixture.scopeId,
      isCurrentProfile: () => true,
      assertNoPendingOrders: () => undefined,
      lockManager,
      invalidateOldProfile: () => undefined,
      activateNewProfile: async () => undefined,
      restoreOldProfile: async () => undefined,
    });

    expect(await lockManager.waitForGrantWithin(walletLockName, 2, 250)).toBe(true);
    await expect(handoff).resolves.toBeUndefined();
  } finally {
    driver.stop();
    await handoff?.catch(() => undefined);
  }
});

it("cancels recovery waiting for the profile lock before releasing leadership", async () => {
  const fixture = await enrollmentFixture();
  await persistHead(fixture, "recovery-required", "genuine-conflict", 0);
  const lockManager = new SharedTestLockManager();
  const profileLockName = `bitcaster:wallet-profile:${fixture.scopeId}`;
  const walletLockName = encryptedWalletBackupV2WalletLockName({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
  });
  const releaseProfileLock = deferred<void>();
  const profileOperation = lockManager.request(
    profileLockName,
    { mode: "exclusive" },
    () => releaseProfileLock.promise,
  );
  const recoveryStarted = deferred<void>();
  const driver = createRuntime(
    fixture,
    vi.fn().mockResolvedValue({ kind: "idle" }),
    runtimeRemote(),
    () => true,
    undefined,
    {
      hold: async (name, signal, onLeader) =>
        lockManager.request(name, { mode: "exclusive", signal }, async () => {
          if (!signal.aborted) await onLeader();
        }),
    },
    undefined,
    async ({ signal }) => {
      recoveryStarted.resolve();
      await withWalletProfileLock(fixture.scopeId, async () => undefined, lockManager, signal);
    },
  );

  try {
    expect(await lockManager.waitForGrantWithin(profileLockName, 1, 1_000)).toBe(true);
    expect(await lockManager.waitForGrantWithin(walletLockName, 1, 1_000)).toBe(true);
    await recoveryStarted.promise;
    expect(await lockManager.waitForQueuedWithin(profileLockName, 1, 1_000)).toBe(true);

    await driver.quiesceForSeedHandoff();

    expect(lockManager.isHeld(walletLockName)).toBe(false);
    expect(lockManager.isHeld(profileLockName)).toBe(true);
  } finally {
    driver.stop();
    releaseProfileLock.resolve();
    await profileOperation;
  }
});

it("drains a queued removeManagedProofs call before releasing leadership", async () => {
  const fixture = await readyEnrolledFixture();
  const lockManager = new SharedTestLockManager();
  const profileLockName = `bitcaster:wallet-profile:${fixture.scopeId}`;
  const walletLockName = encryptedWalletBackupV2WalletLockName({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
  });
  const releaseProfileLock = deferred<void>();
  const profileOperation = lockManager.request(
    profileLockName,
    { mode: "exclusive" },
    () => releaseProfileLock.promise,
  );
  const removeQueued = deferred<void>();
  const removeStart = vi
    .spyOn(removeCoordinator, "startBrowserCtfRemove")
    .mockImplementation(async (input) => {
      removeQueued.resolve();
      await withWalletProfileLock(input.scopeId, async () => undefined, lockManager, input.signal);
      return { kind: "started", intentId: "test-remove" };
    });
  const driver = createRuntime(
    fixture,
    vi.fn().mockResolvedValue({ kind: "idle" }),
    runtimeRemote(),
    () => true,
    undefined,
    {
      hold: async (name, signal, onLeader) =>
        lockManager.request(name, { mode: "exclusive", signal }, async () => {
          if (!signal.aborted) await onLeader();
        }),
    },
    undefined,
    undefined,
    lockManager,
  );
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.example",
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: "11".repeat(32),
      outcomeLabel: "Alpha",
      outcomeCollectionId: "22".repeat(32),
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  const removal = driver.removeManagedProofs({
    asset,
    targets: [{ proofId: "33".repeat(32), proofFingerprint: "44".repeat(32), proofRevision: 1 }],
  });
  const removalResult = removal.then(
    () => undefined,
    (error: unknown) => error,
  );

  try {
    expect(await lockManager.waitForGrantWithin(profileLockName, 1, 1_000)).toBe(true);
    expect(await lockManager.waitForGrantWithin(walletLockName, 1, 1_000)).toBe(true);
    await removeQueued.promise;
    expect(await lockManager.waitForQueuedWithin(profileLockName, 1, 1_000)).toBe(true);

    await driver.quiesceForSeedHandoff();

    expect(lockManager.isHeld(walletLockName)).toBe(false);
    expect(lockManager.isHeld(profileLockName)).toBe(true);
    await expect(removalResult).resolves.toMatchObject({ name: "AbortError" });
    expect(removeStart).toHaveBeenCalledOnce();
  } finally {
    driver.stop();
    releaseProfileLock.resolve();
    await profileOperation;
    await removalResult;
  }
});

it("cancels queued CTF removal finalization before releasing leadership", async () => {
  const fixture = await readyEnrolledFixture();
  const desiredAsset = await putRemovalDesired(fixture, "acknowledged");
  const rawDesired = await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
    fixture.scopeId,
    desiredAsset.localAssetKey,
  ]);
  if (rawDesired === undefined) throw new Error("test desired asset is absent");
  await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
    ...rawDesired,
    removalIntent: createEncryptedWalletBackupV2RemovalIntent({
      intentId: "queued-finalization",
      createdAtMs: 1,
      realm: configuration.realm,
      walletId: fixture.keyHandle.walletId,
      enrollmentEpoch: 1,
      expectedHeadVersion: 0,
      expectedActiveSetDigest: "aa".repeat(32),
      targetCustodyRevision: rawDesired.custodyRevision,
      proofs: [
        {
          proofId: "55".repeat(32),
          proofFingerprint: "66".repeat(32),
          proofRevision: 1,
          proofCommitment: "77".repeat(32),
        },
      ],
      acknowledgedExclusionEvidence: {
        kind: "current-head",
        headVersion: 0,
        activeSetDigest: "aa".repeat(32),
        bundleId: null,
        bundleDescriptorDigest: null,
        acknowledgedAtMs: 1,
      },
    }),
  });
  const lockManager = new SharedTestLockManager();
  const profileLockName = `bitcaster:wallet-profile:${fixture.scopeId}`;
  const walletLockName = encryptedWalletBackupV2WalletLockName({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
  });
  const releaseProfileLock = deferred<void>();
  const profileOperation = lockManager.request(
    profileLockName,
    { mode: "exclusive" },
    () => releaseProfileLock.promise,
  );
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const driver = createRuntime(
    fixture,
    worker,
    runtimeRemote(),
    () => true,
    undefined,
    {
      hold: async (name, signal, onLeader) =>
        lockManager.request(name, { mode: "exclusive", signal }, async () => {
          if (!signal.aborted) await onLeader();
        }),
    },
    undefined,
    undefined,
    lockManager,
  );

  try {
    expect(await lockManager.waitForGrantWithin(profileLockName, 1, 1_000)).toBe(true);
    expect(await lockManager.waitForGrantWithin(walletLockName, 1, 1_000)).toBe(true);
    await vi.waitFor(() => expect(worker).toHaveBeenCalled());
    expect(await lockManager.waitForQueuedWithin(profileLockName, 1, 1_000)).toBe(true);

    await driver.quiesceForSeedHandoff();

    expect(lockManager.isHeld(walletLockName)).toBe(false);
    expect(lockManager.isHeld(profileLockName)).toBe(true);
  } finally {
    driver.stop();
    releaseProfileLock.resolve();
    await profileOperation;
  }
});

it("refuses a seed handoff when another tab holds a wallet lock", async () => {
  const fixture = await enrollmentFixture();
  await persistReadyHead(fixture);
  const lockManager = new SharedTestLockManager();
  const walletLockName = encryptedWalletBackupV2WalletLockName({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
  });
  const releaseOtherTab = deferred<void>();
  const otherTabWork = lockManager.request(
    walletLockName,
    { mode: "exclusive" },
    () => releaseOtherTab.promise,
  );
  expect(await lockManager.waitForGrantWithin(walletLockName, 1, 1_000)).toBe(true);
  const handoff = handoffBrowserEncryptedWalletBackupV2Seed({
    database: fixture.database,
    scopeId: fixture.scopeId,
    isCurrentProfile: () => true,
    assertNoPendingOrders: () => undefined,
    lockManager,
    invalidateOldProfile: () => undefined,
    activateNewProfile: async () => undefined,
    restoreOldProfile: async () => undefined,
  });

  try {
    const result = await Promise.race([
      handoff.then(
        () => null,
        (error: unknown) => error,
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    expect(result).toBeInstanceOf(BrowserEncryptedWalletBackupV2SeedHandoffRefusal);
    expect(result).toMatchObject({ code: "active-wallet-work" });
  } finally {
    releaseOtherTab.resolve();
    await otherTabWork;
    await handoff.catch(() => undefined);
  }
});

it.each([
  [
    "a Vite application frame",
    "Error: private headline\n    at worker (http://localhost:5273/src/lib/browserEncryptedWalletBackupV2Worker.ts:17:4)",
    "worker@17:4",
  ],
  [
    "the backup driver source",
    "Error: private headline\n    at http://localhost:5273/src/lib/encryptedWalletBackupDriver.ts:18:5",
    "driver@18:5",
  ],
  [
    "the asset source",
    "Error: private headline\n    at http://localhost:5273/src/stores/browser-encrypted-wallet-backup-v2-asset-source.ts:19:6",
    "asset-source@19:6",
  ],
  [
    "the CTF removal coordinator",
    "Error: private headline\n    at http://localhost:5273/src/lib/browserCtfRemoveCoordinator.ts:20:7",
    "ctf-removal@20:7",
  ],
  [
    "the backup authority store",
    "Error: private headline\n    at http://localhost:5273/src/stores/encrypted-wallet-backup-v2-db.ts:21:8",
    "authority-store@21:8",
  ],
  [
    "an allowlisted SDK source under Vite's filesystem route",
    "Error: private headline\n    at http://localhost:5273/@fs/home/dev/bitCaster/bitcaster-client-sdk/src/encryptedWalletBackupV2ProofSet.ts:22:9",
    "sdk-proof-set@22:9",
  ],
  [
    "an allowlisted SDK service codec source",
    "Error: private headline\n    at http://localhost:5273/@fs/home/dev/bitCaster/bitcaster-client-sdk/src/encryptedWalletBackupV2ServiceCodec.ts:23:10",
    "sdk-service-codec@23:10",
  ],
  [
    "a Vite SDK source frame with a query and fragment",
    "Error: private headline\n    at http://localhost:5273/@fs/home/dev/bitCaster/bitcaster-client-sdk/src/encryptedWalletBackupV2Sync.ts?import#source:18:7",
    "sdk-sync@18:7",
  ],
  [
    "an SDK suffix outside the filesystem route",
    "Error: private headline\n    at http://localhost:5273/bitCaster/bitcaster-client-sdk/src/encryptedWalletBackupV2Sync.ts:18:7",
    "unknown",
  ],
  [
    "a headline that spoofs a frame",
    "Error: at http://localhost:5273/src/lib/encryptedWalletBackupDriver.ts:1:1",
    "unknown",
  ],
  [
    "an unknown path whose query contains an allowed path",
    "Error: private headline\n    at http://unknown.example/module.ts?next=/src/lib/encryptedWalletBackupDriver.ts:20:3",
    "unknown",
  ],
  [
    "an unknown path whose fragment contains an allowed path",
    "Error: private headline\n    at http://unknown.example/module.ts#/src/lib/encryptedWalletBackupDriver.ts:20:3",
    "unknown",
  ],
  [
    "a path with a malformed zero coordinate",
    "Error: private headline\n    at http://localhost:5273/src/lib/encryptedWalletBackupDriver.ts:0:3",
    "unknown",
  ],
  [
    "a path with an out of range coordinate",
    "Error: private headline\n    at http://localhost:5273/src/lib/encryptedWalletBackupDriver.ts:1000000:3",
    "unknown",
  ],
  [
    "a path with a non-decimal coordinate",
    "Error: private headline\n    at http://localhost:5273/src/lib/encryptedWalletBackupDriver.ts:line:3",
    "unknown",
  ],
  [
    "a lookalike application path",
    "Error: private headline\n    at http://localhost:5273/src/lib/encryptedWalletBackupDriver.ts.evil:20:3",
    "unknown",
  ],
  [
    "a path inherited from an object property",
    "Error: private headline\n    at http://localhost:5273/toString:20:3",
    "unknown",
  ],
])("extracts only allowlisted source coordinates from %s", (_name, stack, expected) => {
  expect(encryptedWalletBackupDriverFailureSite({ stack })).toBe(expected);
});

it("stops after 32 frame lines and three known owners", () => {
  const afterFrameLimit = [
    "Error: private headline",
    ...Array.from({ length: 32 }, () => "    at http://unknown.example/module.ts:1:1"),
    "    at http://localhost:5273/src/lib/encryptedWalletBackupDriver.ts:10:2",
  ].join("\n");
  const beforeSiteLimit = [
    "Error: private headline",
    "    at http://localhost:5273/src/lib/encryptedWalletBackupDriver.ts:10:2",
    "    at http://localhost:5273/src/lib/browserEncryptedWalletBackupV2Worker.ts:11:3",
    "    at http://localhost:5273/src/stores/browser-encrypted-wallet-backup-v2-asset-source.ts:12:4",
    "    at http://localhost:5273/src/lib/browserCtfRemoveCoordinator.ts:13:5",
  ].join("\n");

  expect(encryptedWalletBackupDriverFailureSite({ stack: afterFrameLimit })).toBe("unknown");
  expect(encryptedWalletBackupDriverFailureSite({ stack: beforeSiteLimit })).toBe(
    "driver@10:2,worker@11:3,asset-source@12:4",
  );
});

it("bounds stack reads and maps inaccessible or missing stacks to unknown", () => {
  const oversizedStack = `Error: ${"x".repeat(9_000)}\n    at http://localhost:5273/src/lib/encryptedWalletBackupDriver.ts:10:2`;
  const inaccessibleStack = Object.defineProperty({}, "stack", {
    get() {
      throw new Error("private stack getter marker");
    },
  });

  expect(encryptedWalletBackupDriverFailureSite({ stack: oversizedStack })).toBe("unknown");
  expect(encryptedWalletBackupDriverFailureSite(inaccessibleStack)).toBe("unknown");
  expect(encryptedWalletBackupDriverFailureSite({})).toBe("unknown");
  expect(encryptedWalletBackupDriverFailureSite("private error marker")).toBe("unknown");
});

it("discovers the delegated epoch even when a local enrollment receipt exists", async () => {
  const fixture = await enrollmentFixture();
  await fixture.database.encryptedWalletBackupEnrollmentResults.put({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
    record: enrollmentRecord(fixture.keyHandle, 7),
  });
  const remote = {
    discoverEnrollmentEpoch: vi.fn().mockResolvedValue({ status: "active", enrollmentEpoch: 9 }),
    executeAccountOperation: vi.fn(),
  };
  await expect(resolveEpoch(fixture, remote)).resolves.toBe(9);
  expect(remote.discoverEnrollmentEpoch).toHaveBeenCalledOnce();
});

it("uses an epoch-zero V2 discovery proof without an enrollment mutation when the wallet is active", async () => {
  const fixture = await enrollmentFixture();
  const remote = {
    discoverEnrollmentEpoch: vi.fn().mockResolvedValue({ status: "active", enrollmentEpoch: 4 }),
    executeAccountOperation: vi.fn(),
  };

  await expect(resolveEpoch(fixture, remote)).resolves.toBe(4);
  expect(remote.discoverEnrollmentEpoch).toHaveBeenCalledOnce();
  expect(remote.discoverEnrollmentEpoch.mock.calls[0]?.[0].requestProof.enrollmentEpoch).toBe(0);
  expect(remote.executeAccountOperation).not.toHaveBeenCalled();
});

it("builds an adapter-valid current inventory URL", async () => {
  const fixture = await enrollmentFixture();
  const url = encryptedWalletBackupV2CurrentInventoryUrl(configuration, fixture.keyHandle);
  const requestProof = await prepareEncryptedWalletBackupV2RequestProof({
    keyHandle: fixture.keyHandle,
    enrollmentEpoch: 1,
    method: "GET",
    url,
    issuedAtUnixSeconds: 1_000,
    expiresAtUnixSeconds: 1_060,
    payload: new Uint8Array(),
    signal: new AbortController().signal,
    runtime: crypto,
  });
  const fetch = vi.fn().mockRejectedValue(new Error("test transport failure"));
  const adapter = new EncryptedWalletBackupV2HttpAdapter({
    origin: configuration.signedOrigin,
    fetch,
  });

  await expect(adapter.readCurrentInventory({ requestProof })).rejects.toBeInstanceOf(
    EncryptedWalletBackupV2HttpTransportError,
  );
  expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: "GET" }));
});

it("enrolls once after V2 discovery reports an absent wallet", async () => {
  const fixture = await enrollmentFixture();
  const remote = {
    discoverEnrollmentEpoch: vi.fn().mockResolvedValue({ status: "not-enrolled" }),
    executeAccountOperation: vi.fn(async ({ operation }) => ({
      status: "committed" as const,
      operationId: operation.operationId,
      intentDigest: operation.intentDigest,
      enrollmentEpoch: 1,
      lifecycle: "active" as const,
    })),
  };
  const authorizationPort = {
    authorizeBackupAccountOperation: vi.fn().mockResolvedValue({
      scheme: "nip98-backup-intent-v1",
      authorization: new Uint8Array([1]),
    }),
  };
  await expect(resolveEpoch(fixture, remote, authorizationPort)).resolves.toBe(1);
  expect(remote.executeAccountOperation).toHaveBeenCalledOnce();
  expect(await fixture.database.encryptedWalletBackupEnrollmentResults.count()).toBe(1);
});

it("serializes wake cycles and immediately follows a head acceptance", async () => {
  const fixture = await runtimeFixture();
  let finishFirst: (() => void) | undefined;
  const worker = vi
    .fn()
    .mockImplementationOnce(
      () => new Promise((resolve) => (finishFirst = () => resolve({ kind: "head-accepted" }))),
    )
    .mockResolvedValue({ kind: "idle" });
  const driver = createRuntime(fixture, worker);
  await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(1));
  expect(worker.mock.calls[0]?.[0].remoteOrigin).toBe(configuration.signedOrigin);
  finishFirst?.();
  await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(2));
  driver.stop();
});

it("passes the authenticated object URL to the production worker entry point", async () => {
  const fixture = await runtimeFixture();
  const objectId = "11".repeat(16);
  const worker = vi
    .fn()
    .mockImplementation(
      (input: { readonly requestUrl: (kind: "object", value: string) => string }) => {
        expect(input.requestUrl("object", objectId)).toBe(
          `${configuration.signedOrigin}/v1/encrypted-wallet-backup/realms/${configuration.realm}/wallets/${fixture.keyHandle.walletId}/objects/${objectId}`,
        );
        return { kind: "idle" };
      },
    );
  const driver = createRuntime(fixture, worker);

  await vi.waitFor(() => expect(worker).toHaveBeenCalled());
  driver.stop();
});

it("keeps a zero-pending enrolled wallet blocked until its unchanged head is authenticated", async () => {
  enableBackupGate();
  const fixture = await readyEnrolledFixture();
  const result = deferred<{ kind: "idle" }>();
  const worker = vi.fn().mockReturnValue(result.promise);
  const driver = createRuntime(fixture, worker);

  await expect(newWritePermission(fixture)).rejects.toBeInstanceOf(
    BrowserWalletRecoveryRequiredError,
  );
  await vi.waitFor(() => expect(worker).toHaveBeenCalled());
  result.resolve({ kind: "idle" });
  await vi.waitFor(() => expect(newWritePermission(fixture)).resolves.toBeUndefined());

  const replacementResult = deferred<{ kind: "idle" }>();
  const replacement = createRuntime(fixture, vi.fn().mockReturnValue(replacementResult.promise));
  await expect(newWritePermission(fixture)).rejects.toBeInstanceOf(
    BrowserWalletRecoveryRequiredError,
  );
  driver.stop();
  await expect(newWritePermission(fixture)).rejects.toBeInstanceOf(
    BrowserWalletRecoveryRequiredError,
  );
  replacementResult.resolve({ kind: "idle" });
  await vi.waitFor(() => expect(newWritePermission(fixture)).resolves.toBeUndefined());
  replacement.stop();
  await expect(newWritePermission(fixture)).rejects.toBeInstanceOf(
    BrowserWalletRecoveryRequiredError,
  );
});

it("blocks an origin-loss wallet until its remote active head is authenticated", async () => {
  enableBackupGate();
  const fixture = await enrollmentFixture();
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: remoteWithEmptyHead(fixture, 4),
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
  });

  await expect(newWritePermission(fixture)).rejects.toBeInstanceOf(
    BrowserWalletRecoveryRequiredError,
  );
  await vi.waitFor(() => expect(newWritePermission(fixture)).resolves.toBeUndefined());
  expect(
    await fixture.database.encryptedWalletBackupV2AcceptedHeads.get([
      fixture.scopeId,
      configuration.realm,
      fixture.keyHandle.walletId,
      4,
    ]),
  ).toBeDefined();
  driver.stop();
});

it("does not enable writes when an authenticated session lacks its exact accepted head", async () => {
  enableBackupGate();
  const fixture = await enrollmentFixture();
  const session = beginBrowserWalletBackupAuthenticationSession({
    database: fixture.database,
    scopeId: fixture.scopeId,
    realm: configuration.realm,
  });
  expect(session.markAuthenticated(4, fixture.keyHandle.requestAuthPublicKey)).toBe(true);

  await expect(newWritePermission(fixture)).rejects.toBeInstanceOf(
    BrowserWalletRecoveryRequiredError,
  );
  session.stop();
});

it("keeps fresh-browser writes blocked while the real worker requests baseline recovery", async () => {
  enableBackupGate();
  const fixture = await enrollmentFixture();
  const bundle = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle: fixture.keyHandle,
    asset: createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: "https://mint.example",
      unit: "msat",
      asset: { kind: "ordinary" },
    }),
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: encodeCanonicalBackupCbor({ pending: true }),
    runtime: crypto,
  });
  const bundles = [bundle.descriptor];
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles,
  });
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles });
  const pending = deferred<void>();
  const recovery = vi.fn(() => pending.promise);
  const remote = {
    ...runtimeRemote(),
    readDescriptorPage: vi.fn(async () => pages[0]!),
  };
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote,
    recovery,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
  });
  try {
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledOnce());
    await expect(newWritePermission(fixture)).rejects.toBeInstanceOf(
      BrowserWalletRecoveryRequiredError,
    );
    expect(await readRecoveryStatus(fixture)).toMatchObject({
      localRecoveryStatus: "recovery-required",
    });
    expect(remote.mutateHeadOnce).not.toHaveBeenCalled();
  } finally {
    driver.stop();
    pending.resolve();
  }
});

it("uses the authenticated remote epoch instead of a stale local enrollment", async () => {
  enableBackupGate();
  const fixture = await enrollmentFixture();
  await fixture.database.encryptedWalletBackupEnrollmentResults.put({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
    record: enrollmentRecord(fixture.keyHandle, 7),
  });
  await persistHead(fixture, "ready", "none", 0, 7);
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: remoteWithEmptyHead(fixture, 9),
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
  });

  await expect(newWritePermission(fixture)).rejects.toBeInstanceOf(
    BrowserWalletRecoveryRequiredError,
  );
  await vi.waitFor(() => expect(newWritePermission(fixture)).resolves.toBeUndefined());
  expect(
    await fixture.database.encryptedWalletBackupV2AcceptedHeads.get([
      fixture.scopeId,
      configuration.realm,
      fixture.keyHandle.walletId,
      9,
    ]),
  ).toBeDefined();
  driver.stop();
});

it("does not authenticate startup from a retry outcome", async () => {
  enableBackupGate();
  const fixture = await readyEnrolledFixture();
  const worker = vi
    .fn()
    .mockResolvedValue({ kind: "retry-pending", minimumRetryDelayMilliseconds: 5_000 });
  const driver = createRuntime(
    fixture,
    worker,
    runtimeRemote(),
    () => true,
    () => () => undefined,
  );

  await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
  await expect(newWritePermission(fixture)).rejects.toBeInstanceOf(
    BrowserWalletRecoveryRequiredError,
  );
  driver.stop();
});

it("presents preparing until the real startup authentication finishes", async () => {
  enableBackupGate();
  const fixture = await readyEnrolledFixture();
  const startup = deferred<{ kind: "idle" }>();
  const worker = vi.fn().mockReturnValue(startup.promise);
  const statuses = vi.fn();
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: runtimeRemote(),
    runWorkerCycle: worker as never,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
    onRecoveryStatusChange: statuses,
  });
  try {
    await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
    expect(statuses).toHaveBeenLastCalledWith({ kind: "preparing", reason: "authentication" });
    expect(statuses).not.toHaveBeenCalledWith({ kind: "ready" });
    await expect(requireBrowserWalletNewWritePermission(fixture)).rejects.toMatchObject({
      reason: "startup-authentication-pending",
    });
    startup.resolve({ kind: "idle" });
    await vi.waitFor(() => expect(statuses).toHaveBeenLastCalledWith({ kind: "ready" }));
    await expect(requireBrowserWalletNewWritePermission(fixture)).resolves.toBeUndefined();
  } finally {
    startup.resolve({ kind: "idle" });
    driver.stop();
  }
});

it.each(["leadership", "startup"] as const)(
  "presents terminal %s failure without inventing a conflict or clearing durable work",
  async (stage) => {
    enableBackupGate();
    const fixture = await readyEnrolledFixture();
    const desired = await putRemovalDesired(fixture, "pending");
    const statuses = vi.fn(),
      reportError = vi.fn();
    const failure = new Error("private proof token marker");
    const worker =
      stage === "startup"
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue({ kind: "idle" });
    const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
      configuration,
      ...fixture,
      remote: runtimeRemote(),
      runWorkerCycle: worker as never,
      runtime: crypto,
      signal: new AbortController().signal,
      isCurrentProfile: () => true,
      leadership:
        stage === "leadership"
          ? {
              hold: async () => {
                throw failure;
              },
            }
          : immediateLeadership,
      onRecoveryStatusChange: statuses,
      reportError,
    });
    try {
      await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce());
      expect(statuses).toHaveBeenLastCalledWith({ kind: "failed" });
      expect(statuses.mock.calls.flat().some((status) => status.kind === "recovering")).toBe(false);
      expect(JSON.stringify(statuses.mock.calls)).not.toContain("private proof token marker");
      await expect(readRecoveryStatus(fixture)).resolves.toMatchObject({
        localRecoveryStatus: "ready",
        localRecoveryVersion: 0,
      });
      expect(
        await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
          fixture.scopeId,
          desired.localAssetKey,
        ]),
      ).toMatchObject({ syncState: "pending" });
      await expect(requireBrowserWalletNewWritePermission(fixture)).rejects.toMatchObject({
        reason: "startup-authentication-pending",
      });
      driver.resumeAfterRecovery();
      expect(statuses).toHaveBeenLastCalledWith({ kind: "failed" });
    } finally {
      driver.stop();
    }
  },
);

it("a replacement driver reauthenticates after terminal failure without discarding pending work", async () => {
  enableBackupGate();
  const fixture = await readyEnrolledFixture();
  const desired = await putRemovalDesired(fixture, "pending");
  const statuses = vi.fn();
  const first = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: runtimeRemote(),
    runWorkerCycle: vi.fn().mockRejectedValue(new Error("bounded failure")) as never,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
    onRecoveryStatusChange: statuses,
    reportError: vi.fn(),
  });
  try {
    await vi.waitFor(() => expect(statuses).toHaveBeenLastCalledWith({ kind: "failed" }));
  } finally {
    first.stop();
  }
  const startup = deferred<{ kind: "idle" }>();
  const worker = vi.fn().mockReturnValue(startup.promise);
  const second = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: runtimeRemote(),
    runWorkerCycle: worker as never,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
    onRecoveryStatusChange: statuses,
  });
  try {
    await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
    await expect(requireBrowserWalletNewWritePermission(fixture)).rejects.toMatchObject({
      reason: "startup-authentication-pending",
    });
    startup.resolve({ kind: "idle" });
    await vi.waitFor(() => expect(statuses).toHaveBeenLastCalledWith({ kind: "ready" }));
    await expect(requireBrowserWalletNewWritePermission(fixture)).resolves.toBeUndefined();
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        desired.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "pending" });
    await expect(readRecoveryStatus(fixture)).resolves.toMatchObject({
      localRecoveryStatus: "ready",
      localRecoveryVersion: 0,
    });
  } finally {
    startup.resolve({ kind: "idle" });
    second.stop();
  }
});

it("keeps genuine conflict presentation while an explicit recovery retry reads its authority", async () => {
  const fixture = await runtimeFixture();
  await persistRecoveryRequiredHead(fixture);
  const blocked = deferred<void>();
  const statuses = vi.fn();
  let calls = 0;
  const recovery = vi.fn(async () => {
    if (++calls === 2) await blocked.promise;
  });
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: runtimeRemote(),
    runWorkerCycle: vi.fn().mockResolvedValue({ kind: "idle" }) as never,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
    onRecoveryStatusChange: statuses,
    recovery,
  });
  try {
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledOnce());
    expect(statuses).toHaveBeenLastCalledWith({ kind: "recovering", reason: null });
    statuses.mockClear();
    driver.resumeAfterRecovery();
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledTimes(2));
    expect(statuses.mock.calls.every(([status]) => status.kind === "recovering")).toBe(true);
    await expect(readRecoveryStatus(fixture)).resolves.toMatchObject({
      localRecoveryStatus: "recovery-required",
    });
  } finally {
    blocked.resolve();
    driver.stop();
  }
});

it("reports the bounded lifecycle through retry and authentication without repeating healthy state", async () => {
  enableBackupGate();
  const fixture = await readyEnrolledFixture();
  const messages: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...values: unknown[]) => {
    messages.push(values.join(" "));
  });
  const retries: (() => void)[] = [];
  const worker = vi
    .fn()
    .mockResolvedValueOnce({ kind: "retry-pending", minimumRetryDelayMilliseconds: 5_000 })
    .mockResolvedValueOnce({ kind: "head-accepted" })
    .mockResolvedValue({ kind: "idle" });
  const driver = createRuntime(
    fixture,
    worker,
    runtimeRemote(),
    () => true,
    (task) => {
      retries.push(task);
      return () => undefined;
    },
  );

  try {
    await vi.waitFor(() => expect(retries).toHaveLength(1));
    await expect(newWritePermission(fixture)).rejects.toBeInstanceOf(
      BrowserWalletRecoveryRequiredError,
    );
    retries.shift()?.();
    await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(3));
    await expect(newWritePermission(fixture)).resolves.toBeUndefined();

    const states = messages
      .filter((message) => message.startsWith("encrypted-backup-driver-state="))
      .map((message) => message.slice("encrypted-backup-driver-state=".length));
    expect(states).toEqual([
      "key-handle",
      "leadership-wait",
      "leadership-active",
      "enrollment",
      "startup",
      "retry",
      "startup",
      "authenticated",
    ]);
  } finally {
    driver.stop();
  }
});

it("distinguishes leadership failure from waiting and preserves the injected error", async () => {
  const fixture = await readyEnrolledFixture();
  const failure = new Error("private leadership failure marker");
  const reportError = vi.fn();
  const messages: string[] = [];
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation((...values: unknown[]) => {
    messages.push(values.join(" "));
  });
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: runtimeRemote(),
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: { hold: async () => Promise.reject(failure) },
    reportError,
  });

  try {
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce());
    expect(reportError.mock.calls[0]?.[0]).toBe(failure);
    expect(warning).not.toHaveBeenCalled();
    expect(messages).toContain("encrypted-backup-driver-state=key-handle");
    expect(messages).toContain("encrypted-backup-driver-state=leadership-wait");
    expect(messages).toContain("encrypted-backup-driver-failure-stage=leadership");
    expect(messages).toContain("encrypted-backup-driver-state=terminal");
    expect(messages.join(" ")).not.toContain("private leadership failure marker");
  } finally {
    driver.stop();
  }
});

it("reports key-handle failure before leadership wait", async () => {
  const fixture = await readyEnrolledFixture();
  const failure = new Error("private key-handle failure marker");
  const reportError = vi.fn();
  const messages: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...values: unknown[]) => {
    messages.push(values.join(" "));
  });
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: runtimeRemote(),
    runtime: {
      subtle: { importKey: vi.fn().mockRejectedValue(failure) },
    } as never,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
    reportError,
  });

  try {
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce());
    expect(reportError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(messages).toContain("encrypted-backup-driver-state=key-handle");
    expect(messages).toContain("encrypted-backup-driver-failure-stage=key-handle");
    expect(messages).toContain("encrypted-backup-driver-state=terminal");
    expect(messages).not.toContain("encrypted-backup-driver-state=leadership-wait");
  } finally {
    driver.stop();
  }
});

it.each([
  { code: "unknown", createFailure: () => new Error("private terminal error marker") },
  {
    code: "unauthorized",
    createFailure: () => new EncryptedWalletBackupV2HttpTransportError("unauthorized"),
  },
])("reports only an allowlisted terminal error label: $code", async ({ code, createFailure }) => {
  const fixture = await readyEnrolledFixture();
  const failure = createFailure();
  failure.message = "private terminal error marker";
  const messages: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...values: unknown[]) => {
    messages.push(values.join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...values: unknown[]) => {
    messages.push(values.join(" "));
  });
  const driver = createRuntime(fixture, vi.fn().mockRejectedValue(failure));

  try {
    await vi.waitFor(() => expect(messages).toContain(`encrypted-backup-driver-error=${code}`));
    expect(messages).toContain("encrypted-backup-driver-state=terminal");
    expect(messages.join(" ")).not.toContain("private terminal error marker");
  } finally {
    driver.stop();
  }
});

it("adds a bounded source label to the default error report", async () => {
  const fixture = await readyEnrolledFixture();
  const failure = new Error("private terminal message marker");
  failure.stack =
    "Error: private terminal stack marker\n    at worker (http://localhost:5273/src/lib/browserEncryptedWalletBackupV2Worker.ts:24:6)";
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...values: unknown[]) => {
    warnings.push(values.join(" "));
  });
  const driver = createRuntime(fixture, vi.fn().mockRejectedValue(failure));

  try {
    await vi.waitFor(() =>
      expect(warnings).toContain("encrypted-backup-driver-failure-site=worker@24:6"),
    );
    expect(warnings).toContain("encrypted-backup-driver-error=unknown");
    expect(warnings.join(" ")).not.toContain("private terminal");
  } finally {
    driver.stop();
  }
});

it("reports a persisted retry after its timer is armed", async () => {
  const fixture = await readyEnrolledFixture();
  await fixture.database.encryptedWalletBackupRetrySchedulers.put({
    scopeId: fixture.scopeId,
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
    attemptId: fixture.keyHandle.walletId.slice(0, 32),
    retryStreak: 1,
    retryNotBeforeUnixMilliseconds: Date.now() + 5_000,
  });
  const messages: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...values: unknown[]) => {
    messages.push(values.join(" "));
  });
  const timers: (() => void)[] = [];
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const driver = createRuntime(
    fixture,
    worker,
    runtimeRemote(),
    () => true,
    (task) => {
      timers.push(task);
      return () => undefined;
    },
  );

  try {
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(worker).not.toHaveBeenCalled();
    expect(messages).toContain("encrypted-backup-driver-state=retry");
    timers.shift()?.();
    await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
    expect(messages).toContain("encrypted-backup-driver-state=authenticated");
  } finally {
    driver.stop();
  }
});

it("does not authenticate startup from a quota outcome", async () => {
  enableBackupGate();
  const fixture = await readyEnrolledFixture();
  const worker = vi.fn().mockResolvedValue({ kind: "service-quota-pending" });
  const driver = createRuntime(
    fixture,
    worker,
    runtimeRemote(),
    () => true,
    () => () => undefined,
  );

  await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
  await expect(newWritePermission(fixture)).rejects.toBeInstanceOf(
    BrowserWalletRecoveryRequiredError,
  );
  driver.stop();
});

it("preserves permission when backup is disabled, unenrolled, or has no accepted head", async () => {
  enableBackupGate();
  const fixture = await enrollmentFixture();
  await expect(newWritePermission(fixture)).resolves.toBeUndefined();

  await fixture.database.encryptedWalletBackupEnrollmentResults.put({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
    record: enrollmentRecord(fixture.keyHandle, 1),
  });
  await expect(newWritePermission(fixture)).resolves.toBeUndefined();

  await persistRecoveryRequiredHead(fixture);
  disableBackupGate();
  await expect(newWritePermission(fixture)).resolves.toBeUndefined();
});

it("uses the production worker at startup and durably blocks a changed head", async () => {
  enableBackupGate();
  const fixture = await readyEnrolledFixture();
  const remoteHead = createEncryptedWalletBackupV2CurrentHead({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [],
  });
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head: remoteHead,
    bundles: [],
  });
  const remote = {
    ...runtimeRemote(),
    readDescriptorPage: vi.fn(async ({ afterBundleId }: { afterBundleId: string | null }) => {
      const page = pages.find((candidate) => candidate.afterBundleId === afterBundleId);
      if (page === undefined) throw new Error("test descriptor page is absent");
      return page;
    }),
  };
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: remote as never,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
  });

  await vi.waitFor(async () =>
    expect(readRecoveryStatus(fixture)).resolves.toMatchObject({
      localRecoveryStatus: "recovery-required",
      localRecoveryVersion: 1,
    }),
  );
  await expect(newWritePermission(fixture)).rejects.toBeInstanceOf(
    BrowserWalletRecoveryRequiredError,
  );
  driver.stop();

  const databaseName = fixture.database.name;
  fixture.database.close();
  const reopened = new BitcasterDB(databaseName);
  databases.push(reopened);
  await expect(
    requireBrowserWalletNewWritePermission({ database: reopened, scopeId: fixture.scopeId }),
  ).rejects.toThrow(/Another browser changed/);
});

it("refuses startup and later cycles after a persisted conflict, including reopen", async () => {
  const fixture = await runtimeFixture();
  await persistRecoveryRequiredHead(fixture);
  const databaseName = fixture.database.name;
  fixture.database.close();
  const reopened = new BitcasterDB(databaseName);
  databases.push(reopened);
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const driver = createRuntime({ ...fixture, database: reopened }, worker);

  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expect(worker).not.toHaveBeenCalled();
  await changeDesiredToRemoval(reopened, fixture.scopeId);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expect(worker).not.toHaveBeenCalled();
  driver.stop();
});

it("uses only an injected recovery callback to return to ordinary publication", async () => {
  const fixture = await runtimeFixture();
  await persistRecoveryRequiredHead(fixture);
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const recovered = vi.fn(async (input: BrowserEncryptedWalletBackupV2RecoveryInput) => {
    await completeInjectedRecovery(input);
  });
  const statusChanges = vi.fn();
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: runtimeRemote(),
    runWorkerCycle: worker as never,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
    recovery: recovered,
    onRecoveryStatusChange: statusChanges,
  });

  await vi.waitFor(() => expect(worker).toHaveBeenCalled());
  expect(recovered).toHaveBeenCalledOnce();
  expect(statusChanges).toHaveBeenCalledWith({ kind: "recovering", reason: null });
  expect(statusChanges).toHaveBeenCalledWith({ kind: "ready" });
  driver.stop();
});

it("uses the production conflict coordinator and resumes ordinary startup", async () => {
  const fixture = await enrollmentFixture();
  await persistRecoveryRequiredHead(fixture);
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const loadWallet = vi.fn();
  const reportError = vi.fn();
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: remoteWithEmptyHead(fixture, 1),
    runWorkerCycle: worker as never,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
    lockManager: immediateLockManager,
    loadWallet,
    reportError,
  });

  await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
  await expect(readRecoveryStatus(fixture)).resolves.toMatchObject({
    localRecoveryStatus: "ready",
    localRecoveryVersion: 2,
  });
  expect(loadWallet).not.toHaveBeenCalled();
  expect(reportError).not.toHaveBeenCalled();
  driver.stop();
});

it.each([true, false])("retries incomplete recovery with a queued wake: %s", async (queuedWake) => {
  const fixture = await enrollmentFixture();
  await persistRecoveryRequiredHead(fixture);
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const reportError = vi.fn();
  const remote = remoteWithEmptyHead(fixture, 1) as unknown as EncryptedWalletBackupV2RemotePort & {
    readDescriptorPage: ReturnType<typeof vi.fn>;
  };
  const firstRead = deferred<never>();
  remote.readDescriptorPage.mockImplementationOnce(() => firstRead.promise);
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: remote as never,
    runWorkerCycle: worker as never,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
    lockManager: immediateLockManager,
    loadWallet: vi.fn(),
    reportError,
  });

  await vi.waitFor(() => expect(remote.readDescriptorPage).toHaveBeenCalledOnce());
  expect(worker).not.toHaveBeenCalled();
  expect(reportError).not.toHaveBeenCalled();
  if (queuedWake) driver.resumeAfterRecovery();
  firstRead.reject(new EncryptedWalletBackupV2HttpTransportError("unavailable"));
  if (!queuedWake) {
    await vi.waitFor(() => expect(driver.recoveryReason).toBe("remote-unavailable"));
    expect(worker).not.toHaveBeenCalled();
    driver.resumeAfterRecovery();
  }
  await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
  await expect(readRecoveryStatus(fixture)).resolves.toMatchObject({
    localRecoveryStatus: "ready",
  });
  expect(reportError).not.toHaveBeenCalled();
  expect(driver.recoveryReason).toBeNull();
  driver.stop();
});

it.each([
  { kind: "retry", delay: 5_000 },
  { kind: "quota", delay: 3_600_000 },
  { kind: "timeout", delay: 5_000 },
])("retries prepared backup $kind autonomously and cancels on stop", async ({ kind, delay }) => {
  const fixture = await fixtureWithPreparedRecovery();
  const worker = vi.fn(async () => {
    if (kind === "timeout")
      throw new EncryptedWalletBackupV2HttpTransportError("deadline-exceeded");
    return kind === "quota"
      ? { kind: "service-quota-pending" }
      : { kind: "retry-pending", minimumRetryDelayMilliseconds: 5_000 };
  });
  const remote = remoteWithEmptyHead(fixture, 1) as unknown as EncryptedWalletBackupV2RemotePort & {
    readDescriptorPage: ReturnType<typeof vi.fn>;
  };
  const reportError = vi.fn();
  const lifetime = new AbortController();
  const retries: { task: () => void; delay: number }[] = [];
  const cancel = vi.fn();
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: remote as never,
    runWorkerCycle: worker as never,
    runtime: crypto,
    signal: lifetime.signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
    lockManager: immediateLockManager,
    loadWallet: vi.fn(),
    reportError,
    scheduleRetry: (task, delay) => {
      retries.push({ task, delay });
      return cancel;
    },
  });

  await vi.waitFor(() => expect(retries).toHaveLength(1));
  expect(retries[0]!.delay).toBeGreaterThanOrEqual(delay - 100);
  const firstSignal = (worker.mock.calls[0] as unknown as [{ signal: AbortSignal }])[0].signal;
  expect(firstSignal).not.toBe(lifetime.signal);
  retries.shift()!.task();
  await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(retries).toHaveLength(1));
  expect(remote.readDescriptorPage).not.toHaveBeenCalled();
  expect(reportError).not.toHaveBeenCalled();
  await expect(readRecoveryStatus(fixture)).resolves.toMatchObject({
    localRecoveryStatus: "recovery-required",
  });
  driver.stop();
  expect(cancel).toHaveBeenCalledOnce();
  expect(firstSignal.aborted).toBe(true);
  retries.shift()!.task();
  expect(worker).toHaveBeenCalledTimes(2);
});

it("reinitializes after conflict recovery without requiring another owner to wake it", async () => {
  const fixture = await readyEnrolledFixture();
  const messages: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...values: unknown[]) => {
    messages.push(values.join(" "));
  });
  await addDesired(fixture.database, fixture.scopeId, "https://mint.one.example");
  let startFirstCycle!: () => void;
  const firstCycleStarted = new Promise<void>((resolve) => {
    startFirstCycle = resolve;
  });
  let finishFirstCycle!: () => void;
  const firstCycleFinished = new Promise<void>((resolve) => {
    finishFirstCycle = resolve;
  });
  const worker = vi
    .fn()
    .mockImplementationOnce(async () => {
      startFirstCycle();
      await firstCycleFinished;
      return { kind: "idle" } as const;
    })
    .mockImplementationOnce(async () => {
      await persistRecoveryRequiredHead(fixture);
      return { kind: "conflict-recovered" };
    })
    .mockResolvedValue({ kind: "idle" });
  const recovered = vi.fn(async (input: BrowserEncryptedWalletBackupV2RecoveryInput) => {
    await completeInjectedRecovery(input);
  });
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: runtimeRemote(),
    runWorkerCycle: worker as never,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
    recovery: recovered,
  });

  await firstCycleStarted;
  await changeDesiredToRemoval(fixture.database, fixture.scopeId);
  finishFirstCycle();
  await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(3));
  expect(messages).toContain("encrypted-backup-driver-state=recovery-paused");
  driver.stop();
});

it("recovers two later conflicts after startup recovery with the production coordinator", async () => {
  enableBackupGate();
  const fixture = await readyEnrolledFixture();
  await persistRecoveryRequiredHead(fixture);
  const conflict = async () => {
    const row = await readRecoveryStatus(fixture);
    await persistHead(
      fixture,
      "recovery-required",
      "genuine-conflict",
      row!.localRecoveryVersion + 1,
    );
    return { kind: "conflict-recovered" };
  };
  const worker = vi
    .fn()
    .mockResolvedValueOnce({ kind: "head-accepted" })
    .mockImplementationOnce(conflict)
    .mockResolvedValueOnce({ kind: "head-accepted" })
    .mockImplementationOnce(conflict)
    .mockResolvedValue({ kind: "idle" });
  const reportError = vi.fn();
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: remoteWithEmptyHead(fixture, 1),
    runWorkerCycle: worker as never,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
    lockManager: immediateLockManager,
    loadWallet: vi.fn(),
    reportError,
  });
  try {
    await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(5));
    await vi.waitFor(() => expect(newWritePermission(fixture)).resolves.toBeUndefined());
    await expect(readRecoveryStatus(fixture)).resolves.toMatchObject({
      localRecoveryStatus: "ready",
      localRecoveryVersion: 6,
    });
    expect(reportError).not.toHaveBeenCalled();
  } finally {
    driver.stop();
  }
});

it("waits before retry and stops at service quota until the pending count changes", async () => {
  const fixture = await runtimeFixture();
  const messages: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...values: unknown[]) => {
    messages.push(values.join(" "));
  });
  const retries: (() => void)[] = [];
  const delays: number[] = [];
  const worker = vi
    .fn()
    .mockResolvedValueOnce({ kind: "retry-pending", minimumRetryDelayMilliseconds: 5_000 })
    .mockResolvedValueOnce({ kind: "service-quota-pending" })
    .mockResolvedValue({ kind: "idle" });
  const driver = createRuntime(
    fixture,
    worker,
    runtimeRemote(),
    () => true,
    (task, delay) => {
      delays.push(delay);
      expect(delay).toBeGreaterThanOrEqual(5_000);
      retries.push(task);
      return () => {
        const index = retries.indexOf(task);
        if (index >= 0) retries.splice(index, 1);
      };
    },
  );
  await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(1));
  expect(worker).toHaveBeenCalledTimes(1);
  expect(retries).toHaveLength(1);
  expect(messages).toContain("encrypted-backup-driver-state=retry");
  expect(delays[0]).toBeGreaterThanOrEqual(5_000);
  retries.shift()?.();
  await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(2));
  expect(worker).toHaveBeenCalledTimes(2);
  expect(retries).toHaveLength(1);
  expect(messages).toContain("encrypted-backup-driver-state=service-quota");
  expect(delays[1]).toBe(3_600_000);
  await changeDesiredToRemoval(fixture.database, fixture.scopeId);
  await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(3));
  driver.stop();
});

it("honors Retry-After and increases the durable retry backoff", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-08-06T00:00:00.000Z"));
    const fixture = await runtimeFixture();
    const retries: { task: () => void; delay: number }[] = [];
    const worker = vi
      .fn()
      .mockResolvedValueOnce({ kind: "retry-pending", minimumRetryDelayMilliseconds: 60_000 })
      .mockResolvedValueOnce({ kind: "retry-pending", minimumRetryDelayMilliseconds: 5_000 });
    const driver = createRuntime(
      fixture,
      worker,
      runtimeRemote(),
      () => true,
      (task, delay) => {
        retries.push({ task, delay });
        return () => undefined;
      },
    );
    await vi.waitFor(() => expect(retries).toHaveLength(1));
    expect(retries[0]?.delay).toBeGreaterThanOrEqual(60_000);
    vi.setSystemTime(new Date(Date.now() + (retries[0]?.delay ?? 0)));
    retries.shift()?.task();
    await vi.waitFor(() => expect(retries).toHaveLength(1));
    expect(retries[0]?.delay).toBeGreaterThan(5_000);
    driver.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("does not run another cycle while durable retry persistence is pending", async () => {
  const fixture = await runtimeFixture();
  const persisted = deferred<{
    scopeId: string;
    realm: string;
    walletId: string;
    attemptId: string;
    retryStreak: number;
    retryNotBeforeUnixMilliseconds: number;
  }>();
  const timers: (() => void)[] = [];
  const worker = vi
    .fn()
    .mockResolvedValueOnce({ kind: "retry-pending", minimumRetryDelayMilliseconds: 5_000 })
    .mockResolvedValue({ kind: "idle" });
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: runtimeRemote(),
    runWorkerCycle: worker as never,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
    scheduleDurableRetry: vi.fn().mockReturnValue(persisted.promise),
    scheduleRetry: (task) => {
      timers.push(task);
      return () => undefined;
    },
  });
  await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
  await changeDesiredToRemoval(fixture.database, fixture.scopeId);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(worker).toHaveBeenCalledOnce();
  persisted.resolve({
    scopeId: fixture.scopeId,
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
    attemptId: fixture.keyHandle.walletId.slice(0, 32),
    retryStreak: 1,
    retryNotBeforeUnixMilliseconds: Date.now() + 5_000,
  });
  await vi.waitFor(() => expect(timers).toHaveLength(1));
  expect(worker).toHaveBeenCalledOnce();
  timers.shift()?.();
  await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(2));
  driver.stop();
});

it("stops after durable retry persistence fails during a concurrent custody wake", async () => {
  const fixture = await runtimeFixture();
  const reportError = vi.fn();
  const persistence = deferred<never>();
  const worker = vi
    .fn()
    .mockResolvedValue({ kind: "retry-pending", minimumRetryDelayMilliseconds: 5_000 });
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote: runtimeRemote(),
    runWorkerCycle: worker as never,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: immediateLeadership,
    scheduleDurableRetry: vi.fn().mockReturnValue(persistence.promise),
    scheduleRetry: vi.fn(() => () => undefined),
    reportError,
  });
  await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
  await changeDesiredToRemoval(fixture.database, fixture.scopeId);
  persistence.reject(new Error("retry store failed"));
  await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce());
  expect(reportError.mock.calls[0]?.[0]).toEqual(new Error("retry store failed"));
  expect(worker).toHaveBeenCalledOnce();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(worker).toHaveBeenCalledOnce();
  driver.stop();
});

it("stops before work when the captured profile becomes stale", async () => {
  const fixture = await runtimeFixture();
  let current = true;
  const messages: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...values: unknown[]) => {
    messages.push(values.join(" "));
  });
  const discovery = deferred<{ status: "active"; enrollmentEpoch: number }>();
  const remote = runtimeRemote(discovery.promise);
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const driver = createRuntime(fixture, worker, remote, () => current);
  current = false;
  discovery.resolve({ status: "active", enrollmentEpoch: 1 });
  await Promise.resolve();
  await Promise.resolve();
  expect(worker).not.toHaveBeenCalled();
  expect(messages).toContain("encrypted-backup-driver-state=key-handle");
  expect(messages).not.toContain("encrypted-backup-driver-state=leadership-wait");
  expect(messages).not.toContain("encrypted-backup-driver-state=terminal");
  expect(messages).not.toContain("encrypted-backup-driver-error=unknown");
  driver.stop();
});

it("allows one tab to write and transfers leadership after cleanup", async () => {
  const fixture = await runtimeFixture();
  const leadership = queuedLeadership();
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const firstWorker = vi.fn(async () => {
    firstStarted.resolve();
    return { kind: "idle" };
  });
  const secondWorker = vi.fn(async () => {
    secondStarted.resolve();
    return { kind: "idle" };
  });
  const first = createRuntime(
    fixture,
    firstWorker,
    runtimeRemote(),
    () => true,
    undefined,
    leadership,
  );
  let second: ReturnType<typeof createRuntime> | undefined;
  try {
    await firstStarted.promise;
    second = createRuntime(
      fixture,
      secondWorker,
      runtimeRemote(),
      () => true,
      undefined,
      leadership,
    );
    await leadership.contenderQueued;
    expect(firstWorker).toHaveBeenCalled();
    expect(secondWorker).not.toHaveBeenCalled();
    first.stop();
    await secondStarted.promise;
    expect(secondWorker).toHaveBeenCalled();
  } finally {
    first.stop();
    second?.stop();
  }
});

it("does not authorize or store enrollment after the profile becomes stale", async () => {
  const fixture = await enrollmentFixture();
  let current = true;
  const remote = {
    discoverEnrollmentEpoch: vi.fn().mockResolvedValue({ status: "not-enrolled" }),
    executeAccountOperation: vi.fn(async ({ operation }) => {
      current = false;
      return {
        status: "committed" as const,
        operationId: operation.operationId,
        intentDigest: operation.intentDigest,
        enrollmentEpoch: 1,
        lifecycle: "active" as const,
      };
    }),
  };
  const authorizationPort = {
    authorizeBackupAccountOperation: vi.fn().mockResolvedValue({
      scheme: "nip98-backup-intent-v1",
      authorization: new Uint8Array([1]),
    }),
  };
  await expect(
    resolveEncryptedWalletBackupV2EnrollmentEpoch({
      configuration,
      ...fixture,
      remote: remote as never,
      runtime: crypto,
      signal: new AbortController().signal,
      authorizationPort,
      isCurrentProfile: () => current,
    }),
  ).rejects.toThrow(/profile is stale/);
  expect(await fixture.database.encryptedWalletBackupEnrollmentResults.count()).toBe(0);
});

it("does not authorize enrollment after discovery becomes stale", async () => {
  const fixture = await enrollmentFixture();
  let current = true;
  const discovery = deferred<{ status: "not-enrolled" }>();
  const authorizationPort = {
    authorizeBackupAccountOperation: vi.fn(),
  };
  const promise = resolveEncryptedWalletBackupV2EnrollmentEpoch({
    configuration,
    ...fixture,
    remote: {
      discoverEnrollmentEpoch: vi.fn().mockReturnValue(discovery.promise),
      executeAccountOperation: vi.fn(),
    } as never,
    runtime: crypto,
    signal: new AbortController().signal,
    authorizationPort: authorizationPort as never,
    isCurrentProfile: () => current,
  });
  current = false;
  discovery.resolve({ status: "not-enrolled" });
  await expect(promise).rejects.toThrow(/profile is stale/);
  expect(authorizationPort.authorizeBackupAccountOperation).not.toHaveBeenCalled();
});

it("cancels a pending retry when cleanup stops the driver", async () => {
  const fixture = await runtimeFixture();
  const cancel = vi.fn();
  const driver = createRuntime(
    fixture,
    vi.fn().mockResolvedValue({ kind: "retry-pending", minimumRetryDelayMilliseconds: 5_000 }),
    runtimeRemote(),
    () => true,
    () => cancel,
  );
  await vi.waitFor(() => expect(cancel).not.toHaveBeenCalled());
  await vi.waitFor(() =>
    expect(fixture.database.encryptedWalletBackupRetrySchedulers.count()).resolves.toBe(1),
  );
  driver.stop();
  expect(cancel).toHaveBeenCalledOnce();
});

async function enrollmentFixture() {
  const seed = new Uint8Array(64).fill(nextSeedByte++);
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: deriveDurableCustodyWalletId(seed),
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  databases.push(database);
  await database.open();
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: configuration.realm,
    runtime: { subtle: crypto.subtle },
  });
  return { seed, scopeId, database, keyHandle };
}

async function runtimeFixture() {
  const fixture = await enrollmentFixture();
  await addDesired(fixture.database, fixture.scopeId, "https://mint.one.example");
  return fixture;
}

async function readyEnrolledFixture() {
  const fixture = await enrollmentFixture();
  await fixture.database.encryptedWalletBackupEnrollmentResults.put({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
    record: enrollmentRecord(fixture.keyHandle, 1),
  });
  await persistReadyHead(fixture);
  return fixture;
}

it.each(["started", "resumed"] as const)(
  "waits for exact managed completion after %s",
  async (kind) => {
    const fixture = await readyEnrolledFixture();
    const { asset, localAssetKey } = await putRemovalDesired(fixture, "acknowledged");
    const worker = vi.fn().mockResolvedValue({ kind: "idle" });
    const cancel = vi.fn();
    let expire: (() => void) | undefined;
    const driver = createRuntime(
      fixture,
      worker,
      runtimeRemote(),
      () => true,
      undefined,
      undefined,
      (task, delay) => {
        expect(delay).toBe(10_000);
        expire = task;
        return cancel;
      },
    );
    const targets = [
      { proofId: "31".repeat(32), proofFingerprint: "41".repeat(32), proofRevision: 7 },
    ];
    const start = vi
      .spyOn(removeCoordinator, "startBrowserCtfRemove")
      .mockResolvedValue({ kind, intentId: "exact-intent" });
    let settled = false;
    const removal = driver.removeManagedProofs({ asset, targets }).finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      await vi.waitFor(() => expect(expire).toBeTypeOf("function"));
      // A foreign marker wakes the exact-key query but cannot complete this call.
      const marker = createBrowserCompletedProofRemovalMarkerRow({
        scopeId: fixture.scopeId,
        ...targets[0]!,
        proofRevision: 8,
        proofCommitment: "51".repeat(32),
        localAssetKey,
        removalIntentId: "foreign-intent",
        proofSetCommitment: "61".repeat(32),
        completionCustodyRevision: "4",
        realm: fixture.keyHandle.realm,
        walletId: fixture.keyHandle.walletId,
        enrollmentEpoch: 1,
        acknowledgedHeadVersion: 2,
        acknowledgedActiveSetDigest: "71".repeat(32),
        acknowledgementKind: "current-head",
        receiptDigest: null,
        acknowledgedAtMs: 2,
        completedAtMs: 3,
      });
      await fixture.database.custodyProofBackupAuthorities.put(marker);
      expect(settled).toBe(false);
      await fixture.database.custodyProofBackupAuthorities.put({
        ...marker,
        removalIntentId: "exact-intent",
      });
      await expect(removal).resolves.toEqual({ kind: "completed", intentId: "exact-intent" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
    } finally {
      driver.stop();
      await removal;
    }
  },
);

it("keeps one deadline across readiness and completion and returns genuine pending", async () => {
  const fixture = await readyEnrolledFixture();
  const { asset } = await putRemovalDesired(fixture, "acknowledged");
  let expire: (() => void) | undefined;
  const cancel = vi.fn();
  const schedule = vi.fn((task: () => void, _delay: number) => {
    expire = task;
    return cancel;
  });
  const driver = createRuntime(
    fixture,
    vi.fn().mockResolvedValue({ kind: "idle" }),
    runtimeRemote(),
    () => true,
    undefined,
    undefined,
    schedule,
  );
  const start = vi
    .spyOn(removeCoordinator, "startBrowserCtfRemove")
    .mockResolvedValueOnce({ kind: "pending", reason: "backup-not-ready" })
    .mockResolvedValueOnce({ kind: "started", intentId: "exact-intent" });
  const removal = driver.removeManagedProofs({
    asset,
    targets: [{ proofId: "31".repeat(32), proofFingerprint: "41".repeat(32), proofRevision: 7 }],
  });
  try {
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule.mock.calls[0]?.[1]).toBe(10_000);
    expire!();
    await expect(removal).resolves.toEqual({ kind: "started", intentId: "exact-intent" });
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    driver.stop();
    await removal;
  }
});

it.each(["stop", "storage-error"] as const)(
  "cleans an active completion observer after %s",
  async (ending) => {
    const fixture = await readyEnrolledFixture();
    const { asset } = await putRemovalDesired(fixture, "acknowledged");
    const cancel = vi.fn();
    const driver = createRuntime(
      fixture,
      vi.fn().mockResolvedValue({ kind: "idle" }),
      runtimeRemote(),
      () => true,
      undefined,
      undefined,
      () => cancel,
    );
    let detach: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(removeCoordinator, "startBrowserCtfRemove").mockImplementation(async (input) => {
      detach = vi.spyOn(input.signal!, "removeEventListener");
      return { kind: "started", intentId: "observed-intent" };
    });
    const observe = vi.spyOn(removeCoordinator, "readBrowserCtfRemoveCompletion");
    const target = {
      proofId: "31".repeat(32),
      proofFingerprint: "41".repeat(32),
      proofRevision: 7,
    };
    const removal = driver.removeManagedProofs({ asset, targets: [target] });
    const outcome = removal.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await vi.waitFor(() => expect(observe).toHaveBeenCalled());
      if (ending === "stop") driver.stop();
      else
        await fixture.database.custodyProofBackupAuthorities.put({
          scopeId: fixture.scopeId,
          proofId: target.proofId,
        } as never);
      const result = await outcome;
      if (ending === "stop")
        expect(result).toEqual({ value: { kind: "started", intentId: "observed-intent" } });
      else expect(result).toMatchObject({ error: expect.any(Error) });
      expect(cancel).toHaveBeenCalledOnce();
      expect(detach).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      driver.stop();
      await outcome;
    }
  },
);

it("keeps coordinator reentry owned until it drains after the deadline", async () => {
  const fixture = await readyEnrolledFixture();
  const { asset } = await putRemovalDesired(fixture, "acknowledged");
  const entered = deferred<void>();
  const release = deferred<void>();
  let expire: (() => void) | undefined;
  const cancel = vi.fn();
  const driver = createRuntime(
    fixture,
    vi.fn().mockResolvedValue({ kind: "idle" }),
    runtimeRemote(),
    () => true,
    undefined,
    undefined,
    (task) => {
      expire = task;
      return cancel;
    },
  );
  const start = vi
    .spyOn(removeCoordinator, "startBrowserCtfRemove")
    .mockResolvedValueOnce({ kind: "pending", reason: "backup-not-ready" })
    .mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { kind: "started", intentId: "drained-intent" };
    });
  let settled = false;
  const removal = driver
    .removeManagedProofs({
      asset,
      targets: [{ proofId: "31".repeat(32), proofFingerprint: "41".repeat(32), proofRevision: 7 }],
    })
    .finally(() => {
      settled = true;
    });
  try {
    await entered.promise;
    expire!();
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await expect(removal).resolves.toEqual({ kind: "started", intentId: "drained-intent" });
    expect(start).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    driver.stop();
    await removal;
  }
});

it("does not revive an aborted removal when the same profile resumes", async () => {
  const fixture = await readyEnrolledFixture();
  const { asset } = await putRemovalDesired(fixture, "acknowledged");
  const schedule = vi.fn(() => vi.fn());
  const driver = createRuntime(
    fixture,
    vi.fn().mockResolvedValue({ kind: "idle" }),
    runtimeRemote(),
    () => true,
    undefined,
    undefined,
    schedule,
  );
  const entered = deferred<void>();
  const release = deferred<void>();
  const start = vi
    .spyOn(removeCoordinator, "startBrowserCtfRemove")
    .mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { kind: "started", intentId: "old-intent" };
    });
  const removal = driver.removeManagedProofs({
    asset,
    targets: [{ proofId: "31".repeat(32), proofFingerprint: "41".repeat(32), proofRevision: 7 }],
  });
  try {
    await entered.promise;
    const handoff = driver.quiesceForSeedHandoff();
    release.resolve();
    await expect(removal).resolves.toEqual({ kind: "started", intentId: "old-intent" });
    await handoff;
    driver.resumeAfterSeedHandoff();
    expect(schedule).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
  } finally {
    driver.stop();
    release.resolve();
    await removal;
  }
});

it("starts managed removal with the driver's existing enrollment and rejects a stale profile", async () => {
  const fixture = await readyEnrolledFixture();
  let current = true;
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const driver = createRuntime(fixture, worker, runtimeRemote(), () => current);
  const start = vi
    .spyOn(removeCoordinator, "startBrowserCtfRemove")
    .mockResolvedValue({ kind: "completed", intentId: "removal" });
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.example",
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: "11".repeat(32),
      outcomeLabel: "Alpha",
      outcomeCollectionId: "22".repeat(32),
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  const targets = [
    { proofId: "11".repeat(32), proofFingerprint: "22".repeat(32), proofRevision: 7 },
  ];
  try {
    await vi.waitFor(() => expect(worker).toHaveBeenCalled());
    const before = worker.mock.calls.length;
    await expect(driver.removeManagedProofs({ asset, targets })).resolves.toEqual({
      kind: "completed",
      intentId: "removal",
    });
    const input = start.mock.calls[0]![0];
    expect(input.scopeId).toBe(fixture.scopeId);
    expect(input.enrollmentEpoch).toBe(1);
    expect(input.keyHandle?.walletId).toBe(fixture.keyHandle.walletId);
    expect(input.targets).toEqual(targets);
    expect(input.assetLocator?.length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(worker.mock.calls.length).toBeGreaterThan(before));

    current = false;
    await expect(driver.removeManagedProofs({ asset, targets })).rejects.toThrow(
      "profile is unavailable",
    );
    expect(start).toHaveBeenCalledOnce();
  } finally {
    driver.stop();
  }
});

it("reenters managed removal when the desired revision is already acknowledged", async () => {
  const fixture = await readyEnrolledFixture();
  const { asset } = await putRemovalDesired(fixture, "acknowledged");
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const cancelTimeout = vi.fn();
  let timeoutMilliseconds = 0;
  const driver = createRuntime(
    fixture,
    worker,
    runtimeRemote(),
    () => true,
    undefined,
    undefined,
    (_task, delay) => {
      timeoutMilliseconds = delay;
      return cancelTimeout;
    },
  );
  const targets = [
    { proofId: "33".repeat(32), proofFingerprint: "44".repeat(32), proofRevision: 12 },
  ];
  const start = vi
    .spyOn(removeCoordinator, "startBrowserCtfRemove")
    .mockResolvedValueOnce({ kind: "pending", reason: "backup-not-ready" })
    .mockResolvedValueOnce({ kind: "completed", intentId: "after-ack" });
  try {
    await vi.waitFor(() => expect(worker).toHaveBeenCalled());
    await expect(driver.removeManagedProofs({ asset, targets })).resolves.toEqual({
      kind: "completed",
      intentId: "after-ack",
    });
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[0]?.[0].targets).toEqual(targets);
    expect(start.mock.calls[1]?.[0].targets).toEqual(targets);
    expect(timeoutMilliseconds).toBe(10_000);
    expect(cancelTimeout).toHaveBeenCalledOnce();
  } finally {
    driver.stop();
  }
});

it("waits for a pending desired revision to be acknowledged", async () => {
  const fixture = await readyEnrolledFixture();
  const desired = await putRemovalDesired(fixture, "pending");
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const cancelTimeout = vi.fn();
  const driver = createRuntime(
    fixture,
    worker,
    runtimeRemote(),
    () => true,
    undefined,
    undefined,
    () => cancelTimeout,
  );
  const targets = [
    { proofId: "55".repeat(32), proofFingerprint: "66".repeat(32), proofRevision: 13 },
  ];
  const start = vi
    .spyOn(removeCoordinator, "startBrowserCtfRemove")
    .mockResolvedValueOnce({ kind: "pending", reason: "backup-not-ready" })
    .mockResolvedValueOnce({ kind: "completed", intentId: "after-ack" });
  try {
    await vi.waitFor(() => expect(worker).toHaveBeenCalled());
    const removal = driver.removeManagedProofs({ asset: desired.asset, targets });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const current = await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
      fixture.scopeId,
      desired.localAssetKey,
    ]);
    if (current === undefined) throw new Error("test desired asset is absent");
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...current,
      syncState: "acknowledged",
    });
    await expect(removal).resolves.toEqual({ kind: "completed", intentId: "after-ack" });
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[0]?.[0].targets).toEqual(targets);
    expect(start.mock.calls[1]?.[0].targets).toEqual(targets);
    expect(cancelTimeout).toHaveBeenCalledOnce();
  } finally {
    driver.stop();
  }
});

it("returns typed pending when backup readiness times out", async () => {
  const fixture = await readyEnrolledFixture();
  const { asset } = await putRemovalDesired(fixture, "pending");
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const cancelTimeout = vi.fn();
  let expire: (() => void) | undefined;
  const driver = createRuntime(
    fixture,
    worker,
    runtimeRemote(),
    () => true,
    undefined,
    undefined,
    (task, delay) => {
      expect(delay).toBe(10_000);
      expire = task;
      return cancelTimeout;
    },
  );
  const start = vi
    .spyOn(removeCoordinator, "startBrowserCtfRemove")
    .mockResolvedValue({ kind: "pending", reason: "backup-not-ready" });
  try {
    await vi.waitFor(() => expect(worker).toHaveBeenCalled());
    const removal = driver.removeManagedProofs({
      asset,
      targets: [{ proofId: "77".repeat(32), proofFingerprint: "88".repeat(32), proofRevision: 14 }],
    });
    await vi.waitFor(() => expect(expire).toBeTypeOf("function"));
    expire!();
    await expect(removal).resolves.toEqual({
      kind: "pending",
      reason: "backup-not-ready",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(cancelTimeout).toHaveBeenCalledOnce();
  } finally {
    driver.stop();
  }
});

it("returns typed pending when the readiness stream is unavailable", async () => {
  const fixture = await readyEnrolledFixture();
  const desired = await putRemovalDesired(fixture, "pending");
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const cancelTimeout = vi.fn();
  const driver = createRuntime(
    fixture,
    worker,
    runtimeRemote(),
    () => true,
    undefined,
    undefined,
    () => cancelTimeout,
  );
  const start = vi
    .spyOn(removeCoordinator, "startBrowserCtfRemove")
    .mockResolvedValue({ kind: "pending", reason: "backup-not-ready" });
  try {
    await vi.waitFor(() => expect(worker).toHaveBeenCalled());
    const current = await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
      fixture.scopeId,
      desired.localAssetKey,
    ]);
    if (current === undefined) throw new Error("test desired asset is absent");
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...current,
      syncState: "unavailable" as never,
    });
    await expect(
      driver.removeManagedProofs({
        asset: desired.asset,
        targets: [
          { proofId: "99".repeat(32), proofFingerprint: "aa".repeat(32), proofRevision: 15 },
        ],
      }),
    ).resolves.toEqual({ kind: "pending", reason: "backup-not-ready" });
    expect(start).toHaveBeenCalledOnce();
    expect(cancelTimeout).toHaveBeenCalledOnce();
  } finally {
    driver.stop();
  }
});

it("cleans the readiness subscription and deadline when the driver stops", async () => {
  const fixture = await readyEnrolledFixture();
  const desired = await putRemovalDesired(fixture, "pending");
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const cancelTimeout = vi.fn();
  let waitScheduled = false;
  const driver = createRuntime(
    fixture,
    worker,
    runtimeRemote(),
    () => true,
    undefined,
    undefined,
    () => {
      waitScheduled = true;
      return cancelTimeout;
    },
  );
  const start = vi
    .spyOn(removeCoordinator, "startBrowserCtfRemove")
    .mockResolvedValue({ kind: "pending", reason: "backup-not-ready" });
  try {
    await vi.waitFor(() => expect(worker).toHaveBeenCalled());
    const removal = driver.removeManagedProofs({
      asset: desired.asset,
      targets: [{ proofId: "bb".repeat(32), proofFingerprint: "cc".repeat(32), proofRevision: 16 }],
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(waitScheduled).toBe(true));
    expect(cancelTimeout).not.toHaveBeenCalled();
    driver.stop();
    await expect(removal).resolves.toEqual({
      kind: "pending",
      reason: "backup-not-ready",
    });
    expect(cancelTimeout).toHaveBeenCalledOnce();
    const current = await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
      fixture.scopeId,
      desired.localAssetKey,
    ]);
    if (current === undefined) throw new Error("test desired asset is absent");
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...current,
      syncState: "acknowledged",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(start).toHaveBeenCalledOnce();
  } finally {
    driver.stop();
  }
});

it("stops the readiness wait after a profile change", async () => {
  const fixture = await readyEnrolledFixture();
  const desired = await putRemovalDesired(fixture, "pending");
  let currentProfile = true;
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const cancelTimeout = vi.fn();
  const driver = createRuntime(
    fixture,
    worker,
    runtimeRemote(),
    () => currentProfile,
    undefined,
    undefined,
    () => cancelTimeout,
  );
  const start = vi
    .spyOn(removeCoordinator, "startBrowserCtfRemove")
    .mockResolvedValue({ kind: "pending", reason: "backup-not-ready" });
  try {
    await vi.waitFor(() => expect(worker).toHaveBeenCalled());
    const removal = driver.removeManagedProofs({
      asset: desired.asset,
      targets: [{ proofId: "dd".repeat(32), proofFingerprint: "ee".repeat(32), proofRevision: 17 }],
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    currentProfile = false;
    const current = await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
      fixture.scopeId,
      desired.localAssetKey,
    ]);
    if (current === undefined) throw new Error("test desired asset is absent");
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...current,
      syncState: "acknowledged",
    });
    await expect(removal).resolves.toEqual({
      kind: "pending",
      reason: "backup-not-ready",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(cancelTimeout).toHaveBeenCalledOnce();
  } finally {
    driver.stop();
  }
});

it("keeps the pending result when readiness races with coordinator reentry", async () => {
  const fixture = await readyEnrolledFixture();
  const desired = await putRemovalDesired(fixture, "pending");
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const driver = createRuntime(fixture, worker);
  const targets = [
    { proofId: "ff".repeat(32), proofFingerprint: "00".repeat(32), proofRevision: 18 },
  ];
  const start = vi
    .spyOn(removeCoordinator, "startBrowserCtfRemove")
    .mockResolvedValueOnce({ kind: "pending", reason: "backup-not-ready" })
    .mockImplementationOnce(async () => {
      const current = await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        desired.localAssetKey,
      ]);
      if (current === undefined) throw new Error("test desired asset is absent");
      await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
        ...current,
        syncState: "pending",
      });
      return { kind: "pending", reason: "backup-not-ready" };
    });
  try {
    await vi.waitFor(() => expect(worker).toHaveBeenCalled());
    const removal = driver.removeManagedProofs({ asset: desired.asset, targets });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const current = await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
      fixture.scopeId,
      desired.localAssetKey,
    ]);
    if (current === undefined) throw new Error("test desired asset is absent");
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...current,
      syncState: "acknowledged",
    });
    await expect(removal).resolves.toEqual({
      kind: "pending",
      reason: "backup-not-ready",
    });
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[0]?.[0].targets).toEqual(targets);
    expect(start.mock.calls[1]?.[0].targets).toEqual(targets);
  } finally {
    driver.stop();
  }
});

async function fixtureWithPreparedRecovery() {
  const fixture = await enrollmentFixture();
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.one.example",
    unit: "msat",
    asset: { kind: "ordinary" },
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: fixture.scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount: 1,
  });
  await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 0,
    bundles: [],
  });
  const headEvidence = collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles: [] }),
  );
  const store = new EncryptedWalletBackupV2DexieAuthorityStore({
    database: fixture.database,
    scopeId: fixture.scopeId,
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
    enrollmentEpoch: 1,
    requestAuthPublicKey: fixture.keyHandle.requestAuthPublicKey,
  });
  await store.acceptCompetingHead({
    collectedHeadEvidence: headEvidence,
    stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
  });
  const bundle = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle: fixture.keyHandle,
    asset,
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: encodeCanonicalBackupCbor(["prepared-proof"]),
    runtime: crypto,
  });
  const envelope = await prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle: fixture.keyHandle,
    expectedHeadEvidence: headEvidence,
    addedBundle: bundle.descriptor,
    supersededBundleIds: [],
    runtime: crypto,
  });
  const binding = {
    localAssetKey: desired.localAssetKey,
    assetLocator: bundle.descriptor.assetLocator,
    custodyRevision: desired.custodyRevision,
    desiredAction: "replace" as const,
    activeProofCount: 1,
  };
  await store.insertPreparedMutationForDesired({
    prepared: {
      mutationId: envelope.mutation.mutationId,
      requestDigest: envelope.requestDigest,
      canonicalUploadGroup: encodeEncryptedWalletBackupV2UploadGroup({
        envelope,
        objects: bundle.objects,
      }),
      createdAtUnixMilliseconds: 1,
      ...binding,
    },
    desired: binding,
  });
  await store.markCompetingHeadRecoveryRequired({ collectedHeadEvidence: headEvidence });
  return fixture;
}

function newWritePermission(fixture: Awaited<ReturnType<typeof enrollmentFixture>>) {
  return requireBrowserWalletNewWritePermission({
    database: fixture.database,
    scopeId: fixture.scopeId,
  });
}

async function readRecoveryStatus(fixture: Awaited<ReturnType<typeof enrollmentFixture>>) {
  return fixture.database.encryptedWalletBackupV2AcceptedHeads.get([
    fixture.scopeId,
    configuration.realm,
    fixture.keyHandle.walletId,
    1,
  ]);
}

function enableBackupGate(): void {
  vi.stubEnv("VITE_ENCRYPTED_BACKUP_REALM", configuration.realm);
  vi.stubEnv("VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN", configuration.signedOrigin);
  vi.stubEnv("VITE_ENCRYPTED_BACKUP_RECEIPT_KEY_ID", configuration.pinnedReceiptKeys[0]!.keyId);
  vi.stubEnv(
    "VITE_ENCRYPTED_BACKUP_RECEIPT_PUBLIC_KEY",
    configuration.pinnedReceiptKeys[0]!.publicKey,
  );
}

function disableBackupGate(): void {
  vi.stubEnv("VITE_ENCRYPTED_BACKUP_REALM", "");
  vi.stubEnv("VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN", "");
  vi.stubEnv("VITE_ENCRYPTED_BACKUP_TRANSPORT_ORIGIN", "");
  vi.stubEnv("VITE_ENCRYPTED_BACKUP_RECEIPT_KEY_ID", "");
  vi.stubEnv("VITE_ENCRYPTED_BACKUP_RECEIPT_PUBLIC_KEY", "");
  vi.stubEnv("VITE_ENCRYPTED_BACKUP_RECEIPT_NEXT_KEY_ID", "");
  vi.stubEnv("VITE_ENCRYPTED_BACKUP_RECEIPT_NEXT_PUBLIC_KEY", "");
}

function resolveEpoch(
  fixture: Awaited<ReturnType<typeof enrollmentFixture>>,
  remote: object,
  authorizationPort?: object,
) {
  return resolveEncryptedWalletBackupV2EnrollmentEpoch({
    configuration,
    ...fixture,
    remote: remote as never,
    runtime: crypto,
    signal: new AbortController().signal,
    nowUnixSeconds: () => 1_000,
    authorizationPort: authorizationPort as never,
  });
}

function createRuntime(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  worker: ReturnType<typeof vi.fn>,
  remote = runtimeRemote(),
  isCurrentProfile = () => true,
  scheduleRetry?: (task: () => void, delayMilliseconds: number) => () => void,
  leadership: {
    hold: (name: string, signal: AbortSignal, task: () => Promise<void>) => Promise<void>;
  } = immediateLeadership,
  scheduleManagedRemoveTimeout?: (task: () => void, delayMilliseconds: number) => () => void,
  recovery?: BrowserEncryptedWalletBackupV2RecoveryCallback,
  lockManager?: Pick<LockManager, "request">,
) {
  return createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    ...fixture,
    remote,
    runWorkerCycle: worker as never,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile,
    scheduleRetry,
    scheduleManagedRemoveTimeout,
    leadership,
    recovery,
    lockManager,
  });
}

async function putRemovalDesired(
  fixture: Awaited<ReturnType<typeof readyEnrolledFixture>>,
  syncState: "pending" | "acknowledged",
) {
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.example",
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: "11".repeat(32),
      outcomeLabel: "Alpha",
      outcomeCollectionId: "22".repeat(32),
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: fixture.scopeId,
    asset,
    custodyRevision: 3n,
    activeProofCount: 1,
  });
  await fixture.database.encryptedWalletBackupV2DesiredAssets.put({ ...desired, syncState });
  return { asset, localAssetKey: desired.localAssetKey };
}

function runtimeRemote(
  discovery: Promise<{ status: "active"; enrollmentEpoch: number }> = Promise.resolve({
    status: "active",
    enrollmentEpoch: 1,
  }),
) {
  return {
    discoverEnrollmentEpoch: vi.fn().mockReturnValue(discovery),
    executeAccountOperation: vi.fn(),
    readDescriptorPage: vi.fn(),
    mutateHeadOnce: vi.fn(),
    readObject: vi.fn(),
  } as unknown as EncryptedWalletBackupV2RemotePort & { executeAccountOperation: () => never };
}

function remoteWithEmptyHead(
  fixture: Awaited<ReturnType<typeof enrollmentFixture>>,
  enrollmentEpoch: number,
) {
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
    enrollmentEpoch,
    headVersion: 0,
    bundles: [],
  });
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles: [] });
  return {
    ...runtimeRemote(Promise.resolve({ status: "active", enrollmentEpoch })),
    readDescriptorPage: vi.fn(async ({ afterBundleId }: { afterBundleId: string | null }) => {
      const page = pages.find((candidate) => candidate.afterBundleId === afterBundleId);
      if (page === undefined) throw new Error("test descriptor page is absent");
      return page;
    }),
  } as never;
}

async function addDesired(database: BitcasterDB, scopeId: string, mintUrl: string) {
  await database.encryptedWalletBackupV2DesiredAssets.put(
    createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId,
      asset: createEncryptedWalletBackupV2AssetIdentity({
        mintUrl,
        unit: "sat",
        asset: { kind: "ordinary" },
      }),
      custodyRevision: 1n,
      activeProofCount: 1,
    }),
  );
}

async function persistRecoveryRequiredHead(
  fixture: Awaited<ReturnType<typeof enrollmentFixture>>,
): Promise<void> {
  await persistHead(fixture, "recovery-required", "genuine-conflict", 1);
}

async function completeInjectedRecovery(
  input: BrowserEncryptedWalletBackupV2RecoveryInput,
): Promise<void> {
  const key = [
    input.scopeId,
    input.keyHandle.realm,
    input.keyHandle.walletId,
    input.enrollmentEpoch,
  ] as const;
  const row = await input.database.encryptedWalletBackupV2AcceptedHeads.get(key);
  if (row === undefined || row.localRecoveryVersion !== input.status.localRecoveryVersion) {
    throw new Error("test recovery status is stale");
  }
  await input.database.encryptedWalletBackupV2AcceptedHeads.put({
    ...row,
    localRecoveryStatus: "ready",
    localRecoveryReason: "none",
    localRecoveryVersion: row.localRecoveryVersion + 1,
  });
}

async function persistReadyHead(
  fixture: Awaited<ReturnType<typeof enrollmentFixture>>,
): Promise<void> {
  await persistHead(fixture, "ready", "none", 0);
}

async function persistHead(
  fixture: Awaited<ReturnType<typeof enrollmentFixture>>,
  localRecoveryStatus: "ready" | "recovery-required",
  localRecoveryReason: "none" | "genuine-conflict",
  localRecoveryVersion: number,
  enrollmentEpoch = 1,
): Promise<void> {
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
    enrollmentEpoch,
    headVersion: 0,
    bundles: [],
  });
  await fixture.database.encryptedWalletBackupV2AcceptedHeads.put({
    scopeId: fixture.scopeId,
    realm: configuration.realm,
    walletId: fixture.keyHandle.walletId,
    enrollmentEpoch,
    headVersion: head.headVersion,
    activeBundleCount: head.activeBundleCount,
    activeObjectCount: head.activeObjectCount,
    activeSetDigest: head.activeSetDigest,
    canonicalCurrentHead: encodeEncryptedWalletBackupV2CurrentHead(head),
    localRecoveryStatus,
    localRecoveryReason,
    localRecoveryVersion,
  });
}

async function changeDesiredToRemoval(database: BitcasterDB, scopeId: string) {
  const row = await database.encryptedWalletBackupV2DesiredAssets
    .where("scopeId")
    .equals(scopeId)
    .first();
  if (row === undefined) throw new Error("missing desired asset");
  await database.encryptedWalletBackupV2DesiredAssets.put({
    ...row,
    custodyRevision: "2",
    activeProofCount: 0,
    desiredAction: "remove",
  });
}

function enrollmentRecord(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>,
  epoch: number,
) {
  return {
    schemaVersion: 1 as const,
    operationId: "11".repeat(16),
    intentDigest: "22".repeat(32),
    action: "enroll" as const,
    realm: configuration.realm,
    walletId: keyHandle.walletId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    expectedEnrollmentEpoch: 0,
    observedEnrollmentEpoch: epoch,
    lifecycle: "active" as const,
    result: "committed" as const,
  };
}

const immediateLeadership = {
  async hold(_name: string, signal: AbortSignal, task: () => Promise<void>) {
    if (!signal.aborted) await task();
  },
};

const immediateLockManager = {
  request: async <T>(_name: string, _options: LockOptions, action: LockGrantedCallback<T>) =>
    action(null),
} as Pick<LockManager, "request">;

function queuedLeadership() {
  let active = false;
  const waiters: (() => void)[] = [];
  const contenderQueued = deferred<void>();
  return {
    contenderQueued: contenderQueued.promise,
    async hold(_name: string, signal: AbortSignal, task: () => Promise<void>) {
      while (active && !signal.aborted) {
        const turn = waitForTurn(waiters, signal);
        contenderQueued.resolve();
        await turn;
      }
      if (signal.aborted) return;
      active = true;
      try {
        await task();
      } finally {
        active = false;
        waiters.shift()?.();
      }
    },
  };
}

function waitForTurn(waiters: (() => void)[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    waiters.push(done);
    signal.addEventListener("abort", done, { once: true });
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
