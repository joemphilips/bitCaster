// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2KeyHandle,
  type EncryptedWalletBackupV2RemotePort,
} from "@bitcaster/client-sdk";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { BitcasterDB } from "../../stores/proof-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import {
  createBrowserEncryptedWalletBackupV2RuntimeDriver,
  resolveEncryptedWalletBackupV2EnrollmentEpoch,
} from "../encryptedWalletBackupDriver";

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

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

it("discovers the delegated epoch even when a local enrollment receipt exists", async () => {
  const fixture = await enrollmentFixture();
  await fixture.database.encryptedWalletBackupEnrollmentResults.put({
    realm: configuration.realm,
    vaultId: fixture.keyHandle.vaultId,
    record: enrollmentRecord(fixture.keyHandle, 7),
  });
  const remote = {
    discoverEnrollmentEpoch: vi.fn().mockResolvedValue({ status: "active", enrollmentEpoch: 9 }),
    executeAccountOperation: vi.fn(),
  };
  await expect(resolveEpoch(fixture, remote)).resolves.toBe(9);
  expect(remote.discoverEnrollmentEpoch).toHaveBeenCalledOnce();
});

it("uses an epoch-zero V2 discovery proof without an enrollment mutation when the vault is active", async () => {
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

it("enrolls once after V2 discovery reports an absent vault", async () => {
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
  finishFirst?.();
  await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(2));
  driver.stop();
});

it("waits before retry and stops at service quota until the pending count changes", async () => {
  const fixture = await runtimeFixture();
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
  expect(delays[0]).toBeGreaterThanOrEqual(5_000);
  retries.shift()?.();
  await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(2));
  expect(worker).toHaveBeenCalledTimes(2);
  expect(retries).toHaveLength(1);
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
    vaultId: string;
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
    vaultId: fixture.keyHandle.vaultId,
    attemptId: fixture.keyHandle.vaultId.slice(0, 32),
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
  const discovery = deferred<{ status: "active"; enrollmentEpoch: number }>();
  const remote = runtimeRemote(discovery.promise);
  const worker = vi.fn().mockResolvedValue({ kind: "idle" });
  const driver = createRuntime(fixture, worker, remote, () => current);
  current = false;
  discovery.resolve({ status: "active", enrollmentEpoch: 1 });
  await Promise.resolve();
  await Promise.resolve();
  expect(worker).not.toHaveBeenCalled();
  driver.stop();
});

it("allows one tab to write and transfers leadership after cleanup", async () => {
  const fixture = await runtimeFixture();
  const leadership = queuedLeadership();
  const firstWorker = vi.fn().mockResolvedValue({ kind: "idle" });
  const secondWorker = vi.fn().mockResolvedValue({ kind: "idle" });
  const first = createRuntime(
    fixture,
    firstWorker,
    runtimeRemote(),
    () => true,
    undefined,
    leadership,
  );
  const second = createRuntime(
    fixture,
    secondWorker,
    runtimeRemote(),
    () => true,
    undefined,
    leadership,
  );
  await vi.waitFor(() => expect(firstWorker).toHaveBeenCalledOnce());
  expect(secondWorker).not.toHaveBeenCalled();
  first.stop();
  await vi.waitFor(() => expect(secondWorker).toHaveBeenCalled());
  second.stop();
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
  const seed = new Uint8Array(64).fill(8);
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
    leadership,
  });
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
    vaultId: keyHandle.vaultId,
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

function queuedLeadership() {
  let active = false;
  const waiters: (() => void)[] = [];
  return {
    async hold(_name: string, signal: AbortSignal, task: () => Promise<void>) {
      while (active && !signal.aborted) await waitForTurn(waiters, signal);
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
