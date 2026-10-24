// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { BitcasterDB } from "@/stores/proof-db";
import { createBrowserCustodyProofRow } from "@/stores/durable-custody-db";
import { decodeEncryptedWalletBackupV2DesiredAssetRow } from "@/stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { decodeEncryptedWalletBackupOwnerUploadGroup } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerUpload";
import { decryptEncryptedWalletBackupV2ProofSetBundle } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { runBrowserEncryptedWalletBackupOwnerWorkerCycle } from "../browserEncryptedWalletBackupOwnerWorker";
import { createBrowserEncryptedWalletBackupV2RuntimeDriver } from "../encryptedWalletBackupDriver";
import { requireBrowserWalletNewWritePermission } from "../browserWalletNewWritePermission";
import {
  startBrowserCtfRemove,
  cancelDefinitivelyRejectedBrowserCtfRemove,
  finalizeBrowserCtfRemove,
  readBrowserCtfRemoveCompletion,
  discoverBrowserCtfRemovals,
} from "../browserCtfRemoveCoordinator";
import { createOwnerRemovalRemote } from "./fixtures/ownerRemovalFixture";
import {
  ownerCtfRemovalFixture,
  addLocalCompanion,
  removalOwnerB,
  removalSeed,
  removalLock,
} from "./fixtures/ownerCtfRemovalProofs";

const databases: BitcasterDB[] = [];
afterEach(async () => {
  for (const database of databases) database.close();
  for (const database of databases.splice(0)) await database.delete();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fixture(count = 2) {
  const value = await ownerCtfRemovalFixture(count);
  databases.push(value.database);
  return value;
}
async function assertNoLegacy(database: BitcasterDB) {
  expect(await database.encryptedWalletBackupV2AcceptedHeads.count()).toBe(0);
  expect(await database.encryptedWalletBackupV2ActiveDescriptors.count()).toBe(0);
  expect(await database.encryptedWalletBackupV2PreparedMutations.count()).toBe(0);
  expect(await database.encryptedWalletBackupV2AssetReceipts.count()).toBe(0);
}

it("commits exact Owner removal-only receipt, preserves ordinary balance and replays after reopen", async () => {
  const f = await fixture();
  const ordinary = createBrowserCustodyProofRow({
    scopeId: f.scopeId,
    normalizedMint: "https://mint.example",
    unit: "msat",
    proof: {
      id: "01" + "66".repeat(32),
      amount: 7 as never,
      secret: "public ordinary sentinel",
      C: "02" + "22".repeat(32),
    },
    asset: { kind: "regular" },
    receivedAtMs: 500,
  });
  await f.database.custodyProofs.put(ordinary);
  const result = await startBrowserCtfRemove(f.input());
  if (result.kind !== "started") throw new Error("fixture did not start");
  expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
  expect((await f.cycle()).kind).toBe("committed");
  expect(f.remote.readHead().bundles).toHaveLength(0);
  const raw = await f.database.encryptedWalletBackupV2DesiredAssets.get([
    f.scopeId,
    f.desired.localAssetKey,
  ]);
  expect(raw?.removalIntent).toMatchObject({
    schemaVersion: 2,
    ownerScopeId: f.owner.ownerScopeId,
    state: "exclusion-acknowledged",
  });
  f.database.close();
  const reopened = new BitcasterDB(f.database.name);
  databases.push(reopened);
  await reopened.open();
  expect((await finalizeBrowserCtfRemove({ ...f.final(), database: reopened })).kind).toBe(
    "completed",
  );
  expect(await reopened.custodyProofs.get([f.scopeId, ordinary.proofId])).toEqual(ordinary);
  expect(
    await readBrowserCtfRemoveCompletion({
      ...f.input(),
      database: reopened,
      intentId: result.intentId,
    }),
  ).toBe(true);
  expect((await startBrowserCtfRemove({ ...f.input(), database: reopened })).kind).toBe(
    "completed",
  );
  expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(2);
  await assertNoLegacy(reopened);
});

it("replacement ciphertext contains the exact surviving proof and excludes captured targets", async () => {
  const f = await fixture(3);
  const target = f.proofs.slice(0, 2);
  expect((await startBrowserCtfRemove(f.input(target))).kind).toBe("started");
  expect((await f.cycle()).kind).toBe("committed");
  const request = f.remote.remote.mutateHead.mock.calls.at(-1)![0];
  const group = decodeEncryptedWalletBackupOwnerUploadGroup({
    bytes: request.canonicalUploadGroup,
    expectedContext: f.remote.context,
    expectedRequestAuthPublicKey: f.keyHandle.requestAuthPublicKey,
  });
  const descriptor = group.mutationEvidence.envelope.mutation.addedBundle;
  if (descriptor === null) throw new Error("replacement missing");
  const recovered = await decryptEncryptedWalletBackupV2ProofSetBundle({
    keyHandle: f.keyHandle,
    seed: removalSeed,
    expectedAsset: f.asset,
    custodyRevision: 2n,
    runtime: crypto,
    descriptor,
    objects: group.objects,
  });
  expect(recovered.proofs.map((p) => p.proofId)).toEqual([f.proofs[2]!.proofId]);
  expect((await finalizeBrowserCtfRemove(f.final())).kind).toBe("completed");
  expect(await f.database.custodyProofs.count()).toBe(1);
  expect(
    (await f.database.custodyProofs.get([f.scopeId, f.proofs[2]!.proofId])) !== undefined,
  ).toBe(true);
  await assertNoLegacy(f.database);
});

it.each([1, 2])(
  "foreign Owner makes zero preparation/uploads for %s target(s), original Owner resumes",
  async (count) => {
    const f = await fixture(2);
    await startBrowserCtfRemove(f.input(f.proofs.slice(0, count)));
    const before = await f.database.encryptedWalletBackupV2DesiredAssets.get([
      f.scopeId,
      f.desired.localAssetKey,
    ]);
    const other = await createOwnerRemovalRemote({
      database: f.database,
      scopeId: f.scopeId,
      keyHandle: f.keyHandle,
      owner: removalOwnerB,
      enrollmentEpoch: 1,
    });
    const result = await runBrowserEncryptedWalletBackupOwnerWorkerCycle({
      database: f.database,
      scopeId: f.scopeId,
      keyHandle: f.keyHandle,
      owner: removalOwnerB,
      enrollmentEpoch: 1,
      seed: removalSeed,
      remote: other.remote,
      runtime: crypto,
      signal: new AbortController().signal,
      isCurrentProfile: () => true,
    });
    expect(result.kind).toBe("idle");
    expect(other.remote.mutateHead).not.toHaveBeenCalled();
    expect(await other.store.readPreparedMutation()).toBeNull();
    expect(
      await f.database.encryptedWalletBackupV2DesiredAssets.get([
        f.scopeId,
        f.desired.localAssetKey,
      ]),
    ).toEqual(before);
    expect(await f.database.custodyProofs.count()).toBe(2);
    expect((await f.cycle()).kind).toBe("committed");
    expect((await finalizeBrowserCtfRemove(f.final())).kind).toBe("completed");
  },
);

it("pending intent commit rollback retains all source authority and proof rows", async () => {
  const f = await fixture();
  const before = await f.database.custodyProofs.toArray();
  const head = f.remote.readHead().head;
  await expect(startBrowserCtfRemove({ ...f.input(), fault: "before-commit" })).rejects.toThrow(
    "commit fault",
  );
  expect(await f.database.custodyProofs.toArray()).toEqual(before);
  expect(
    (
      await f.database.encryptedWalletBackupV2DesiredAssets.get([
        f.scopeId,
        f.desired.localAssetKey,
      ])
    )?.removalIntent,
  ).toBeNull();
  expect(f.remote.readHead().head).toEqual(head);
  expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
});

it("lost successful CAS reply retains pending work and retries exact prepared bytes before final deletion", async () => {
  const f = await fixture();
  await startBrowserCtfRemove(f.input());
  f.remote.loseNextSuccessfulReply();
  await expect(f.cycle()).rejects.toThrow("lost successful reply");
  const prepared = await f.remote.store.readPreparedMutation();
  expect(prepared).not.toBeNull();
  expect(await f.database.custodyProofs.count()).toBe(2);
  expect((await f.cycle()).kind).toBe("committed");
  const calls = f.remote.remote.mutateHead.mock.calls;
  expect(calls.at(-1)![0].canonicalUploadGroup).toEqual(calls.at(-2)![0].canonicalUploadGroup);
  expect((await finalizeBrowserCtfRemove(f.final())).kind).toBe("completed");
});

it("changed canonical revision or lost owner after acknowledgment retains proofs", async () => {
  const f = await fixture();
  await startBrowserCtfRemove(f.input());
  await f.cycle();
  await expect(
    finalizeBrowserCtfRemove({ ...f.final(), isCurrentProfile: () => false }),
  ).rejects.toThrow();
  const raw = decodeEncryptedWalletBackupV2DesiredAssetRow(
    await f.database.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, f.desired.localAssetKey]),
  );
  await f.database.encryptedWalletBackupV2DesiredAssets.put({ ...raw, custodyRevision: "3" });
  await expect(finalizeBrowserCtfRemove(f.final())).rejects.toThrow();
  expect(await f.database.custodyProofs.count()).toBe(2);
});

it("real driver and Owner worker wake, acknowledge and finalize with legacy authority empty", async () => {
  const f = await fixture();
  const client = f.remote.client;
  vi.stubEnv("VITE_ENCRYPTED_BACKUP_REALM", f.keyHandle.realm);
  vi.stubEnv("VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN", "https://backup.example");
  vi.stubEnv("VITE_ENCRYPTED_BACKUP_RECEIPT_KEY_ID", "55".repeat(16));
  vi.stubEnv(
    "VITE_ENCRYPTED_BACKUP_RECEIPT_PUBLIC_KEY",
    "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
  );
  vi.spyOn(client, "discover").mockResolvedValue([] as never);
  vi.spyOn(client, "resolveFirstAccount").mockReturnValue({ kind: "active", owner: f.owner });
  vi.spyOn(client, "readEnrollmentEpoch").mockResolvedValue({
    status: "active",
    enrollmentEpoch: 1,
  });
  vi.spyOn(client, "readCurrentHead").mockImplementation(f.remote.remote.readCurrentHead);
  vi.spyOn(client, "mutateHead").mockImplementation(f.remote.remote.mutateHead);
  const controller = new AbortController();
  const errors: unknown[] = [];
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration: {
      realm: f.keyHandle.realm,
      signedOrigin: "https://backup.example",
      transportOrigin: "https://backup.example",
      pinnedReceiptKeys: [
        {
          keyId: "55".repeat(16),
          publicKey: "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
        },
      ],
    },
    database: f.database,
    scopeId: f.scopeId,
    seed: removalSeed,
    runtime: crypto,
    signal: controller.signal,
    isCurrentProfile: () => true,
    ownerClient: client,
    ownerSession: {
      authenticatedOwnerScope: f.owner,
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
      requireCurrent() {
        controller.signal.throwIfAborted();
      },
      requireLifecycleOwner(candidate) {
        if (
          typeof candidate !== "object" ||
          candidate === null ||
          !("ownerScopeId" in candidate) ||
          candidate.ownerScopeId !== f.owner.ownerScopeId
        )
          throw new Error("foreign owner");
        return f.owner;
      },
      dispose() {},
    },
    leadership: {
      hold: async (_name, signal, task) => {
        if (!signal.aborted) await task();
      },
    },
    lockManager: removalLock,
    reportError: (error) => errors.push(error),
  });
  try {
    await vi.waitFor(
      () => requireBrowserWalletNewWritePermission({ database: f.database, scopeId: f.scopeId }),
      { timeout: 5000 },
    );
    const result = await driver.removeManagedProofs({ asset: f.asset, targets: f.input().targets });
    expect(result.kind).toBe("completed");
    expect(errors).toHaveLength(0);
    expect(await f.database.custodyProofs.count()).toBe(0);
    expect(await discoverBrowserCtfRemovals(f.final())).toBe(0);
    await assertNoLegacy(f.database);
  } finally {
    controller.abort();
    driver.stop();
    await driver.quiesceForSeedHandoff();
  }
});

it("recognizes reopened legacy-unbound intent without adopting its owner or deleting proofs", async () => {
  const f = await fixture();
  await startBrowserCtfRemove(f.input());
  const row = (await f.database.encryptedWalletBackupV2DesiredAssets.get([
    f.scopeId,
    f.desired.localAssetKey,
  ]))!;
  const { schemaVersion: _version, ownerScopeId: _owner, ...legacy } = row.removalIntent!;
  await f.database.encryptedWalletBackupV2DesiredAssets.put({ ...row, removalIntent: legacy });
  f.database.close();
  const reopened = new BitcasterDB(f.database.name);
  databases.push(reopened);
  await reopened.open();
  await expect(startBrowserCtfRemove({ ...f.input(), database: reopened })).rejects.toThrow(
    "original Owner",
  );
  expect(await reopened.custodyProofs.count()).toBe(2);
  const retained = await reopened.encryptedWalletBackupV2DesiredAssets.get([
    f.scopeId,
    f.desired.localAssetKey,
  ]);
  expect(retained?.removalIntent).toEqual(legacy);
  expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
});

it("legacy rejection cancellation refuses an Owner-bound pending intent before changing state", async () => {
  const f = await fixture();
  await startBrowserCtfRemove(f.input());
  const before = await f.database.encryptedWalletBackupV2DesiredAssets.get([
    f.scopeId,
    f.desired.localAssetKey,
  ]);
  await expect(
    cancelDefinitivelyRejectedBrowserCtfRemove({
      ...f.final(),
      rejectedPreparedMutation: { mutationId: "11".repeat(16), requestDigest: "22".repeat(32) },
    }),
  ).rejects.toThrow("legacy cancellation");
  expect(
    await f.database.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, f.desired.localAssetKey]),
  ).toEqual(before);
  expect(await f.database.custodyProofs.count()).toBe(2);
});

it("recovery-required state blocks finalization even when the unchanged head excludes the asset", async () => {
  const f = await fixture();
  await startBrowserCtfRemove(f.input());
  await f.cycle();
  const before = await f.database.encryptedWalletBackupV2DesiredAssets.get([
    f.scopeId,
    f.desired.localAssetKey,
  ]);
  await f.remote.store.markCompetingHeadRecoveryRequired({ evidence: f.remote.readHead() });
  expect((await f.remote.store.readNewWritePermission()).canWrite).toBe(false);
  await expect(finalizeBrowserCtfRemove(f.final())).rejects.toThrow();
  expect(await f.database.custodyProofs.count()).toBe(2);
  expect(
    await f.database.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, f.desired.localAssetKey]),
  ).toEqual(before);
  for (const proof of f.proofs)
    expect(
      await f.database.custodyProofBackupAuthorities.get([f.scopeId, proof.proofId]),
    ).not.toMatchObject({ recordKind: "completed-removal" });
});

it("recognized missing-Owner finalization and completion callers refuse before any storage read", async () => {
  const database = new BitcasterDB("unused-missing-owner");
  databases.push(database);
  const read = vi.spyOn(database.encryptedWalletBackupV2DesiredAssets, "get");
  const malformed = {
    database,
    scopeId: "invalid-before-storage",
    keyHandle: {} as never,
    enrollmentEpoch: 1,
    localAssetKey: "x",
    assetLocator: "x",
  };
  await expect(finalizeBrowserCtfRemove(malformed)).rejects.toThrow("original Owner identity");
  await expect(discoverBrowserCtfRemovals(malformed)).rejects.toThrow("original Owner identity");
  await expect(
    readBrowserCtfRemoveCompletion({
      ...malformed,
      asset: {} as never,
      targets: [],
      intentId: "x",
    }),
  ).rejects.toThrow("original Owner identity");
  expect(read).not.toHaveBeenCalled();
});

it("reuses genuine Owner-restored survivor seal without replacing remote origin or legacy authority", async () => {
  const f = await ownerCtfRemovalFixture(2, true);
  databases.push(f.database);
  const survivor = f.proofs[1]!;
  const before = await f.database.custodyProofBackupAuthorities.get([f.scopeId, survivor.proofId]);
  expect(before).toMatchObject({ terminalAuthority: { kind: "remote-seal" } });
  expect((await startBrowserCtfRemove(f.input([f.proofs[0]!]))).kind).toBe("started");
  expect((await f.cycle()).kind).toBe("committed");
  const request = f.remote.remote.mutateHead.mock.calls.at(-1)![0];
  const group = decodeEncryptedWalletBackupOwnerUploadGroup({
    bytes: request.canonicalUploadGroup,
    expectedContext: f.remote.context,
    expectedRequestAuthPublicKey: f.keyHandle.requestAuthPublicKey,
  });
  const descriptor = group.mutationEvidence.envelope.mutation.addedBundle;
  if (descriptor === null) throw new Error("replacement missing");
  const recovered = await decryptEncryptedWalletBackupV2ProofSetBundle({
    keyHandle: f.keyHandle,
    seed: removalSeed,
    expectedAsset: f.asset,
    custodyRevision: 2n,
    runtime: crypto,
    descriptor,
    objects: group.objects,
  });
  expect(recovered.proofs.map((row) => row.proofId)).toEqual([survivor.proofId]);
  expect(recovered.proofs[0]!.terminalSeal).toBeDefined();
  expect((await finalizeBrowserCtfRemove(f.final())).kind).toBe("completed");
  expect(await f.database.custodyProofBackupAuthorities.get([f.scopeId, survivor.proofId])).toEqual(
    before,
  );
  await assertNoLegacy(f.database);
});

it("real Owner mixed removal atomically removes selected local companion without decrementing retained count twice", async () => {
  const f = await fixture(1);
  const local = await addLocalCompanion(f);
  const input = { ...f.input(), localTargets: [local], observedAtMs: 23_000 };
  expect((await startBrowserCtfRemove(input)).kind).toBe("started");
  expect(await f.database.custodyProofs.get([f.scopeId, local.proofId])).toBeUndefined();
  const desired = (await f.database.encryptedWalletBackupV2DesiredAssets.get([
    f.scopeId,
    f.desired.localAssetKey,
  ]))!;
  expect(desired.activeProofCount).toBe(0);
  expect(desired.removalIntent?.proofs.map((proof) => proof.proofId)).toEqual([
    f.proofs[0]!.proofId,
  ]);
  expect((await startBrowserCtfRemove(input)).kind).toBe("resumed");
  expect((await f.cycle()).kind).toBe("committed");
  expect((await finalizeBrowserCtfRemove(f.final())).kind).toBe("completed");
  expect(
    await readBrowserCtfRemoveCompletion({ ...input, intentId: desired.removalIntent!.intentId }),
  ).toBe(true);
  await assertNoLegacy(f.database);
});

it.each([
  "unselected-local",
  "managed-labeled-local",
  "local-labeled-managed",
  "stale-count",
  "rollback",
] as const)("mixed Owner refusal preserves exact rows and intent: %s", async (mode) => {
  const f = await fixture(1);
  const local = await addLocalCompanion(f);
  if (mode === "stale-count")
    await f.database.encryptedWalletBackupV2DesiredAssets.update(
      [f.scopeId, f.desired.localAssetKey],
      { activeProofCount: 2 },
    );
  const before = await f.database.custodyProofs.toArray();
  const desired = await f.database.encryptedWalletBackupV2DesiredAssets.get([
    f.scopeId,
    f.desired.localAssetKey,
  ]);
  const input = { ...f.input(), localTargets: [local], observedAtMs: 23_000 };
  const altered =
    mode === "unselected-local"
      ? { ...input, localTargets: [] }
      : mode === "managed-labeled-local"
        ? { ...input, targets: [local], localTargets: f.input().targets }
        : mode === "local-labeled-managed"
          ? { ...input, targets: [...f.input().targets, local], localTargets: [] }
          : mode === "rollback"
            ? { ...input, fault: "before-commit" as const }
            : input;
  await expect(startBrowserCtfRemove(altered)).rejects.toThrow();
  expect(await f.database.custodyProofs.toArray()).toEqual(before);
  expect(
    await f.database.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, f.desired.localAssetKey]),
  ).toEqual(desired);
  expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
});

it("session loss while awaiting exact predecessor object refuses preparation and publication", async () => {
  const f = await ownerCtfRemovalFixture(2, true);
  databases.push(f.database);
  await startBrowserCtfRemove(f.input([f.proofs[0]!]));
  let announce!: () => void;
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = f.remote.remote.readObject!;
  let current = true;
  vi.spyOn(f.remote.remote, "readObject").mockImplementation(async (input) => {
    announce();
    await held;
    return read(input);
  });
  const running = runBrowserEncryptedWalletBackupOwnerWorkerCycle({
    database: f.database,
    scopeId: f.scopeId,
    keyHandle: f.keyHandle,
    owner: f.owner,
    enrollmentEpoch: 1,
    seed: removalSeed,
    remote: f.remote.remote,
    runtime: crypto,
    signal: new AbortController().signal,
    isCurrentProfile: () => current,
  });
  const refusal = expect(running).rejects.toThrow("profile is stale");
  await entered;
  current = false;
  release();
  await refusal;
  expect(await f.remote.store.readPreparedMutation()).toBeNull();
  expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
  expect(await f.database.custodyProofs.count()).toBe(2);
  expect(
    (
      await f.database.encryptedWalletBackupV2DesiredAssets.get([
        f.scopeId,
        f.desired.localAssetKey,
      ])
    )?.removalIntent?.state,
  ).toBe("pending");
});

it("unavailable predecessor object retains exact pending intent and all proofs without preparation", async () => {
  const f = await ownerCtfRemovalFixture(2, true);
  databases.push(f.database);
  await startBrowserCtfRemove(f.input([f.proofs[0]!]));
  const before = await f.database.encryptedWalletBackupV2DesiredAssets.get([
    f.scopeId,
    f.desired.localAssetKey,
  ]);
  vi.spyOn(f.remote.remote, "readObject").mockRejectedValue(
    new Error("controlled predecessor unavailable"),
  );
  await expect(f.cycle()).rejects.toThrow("controlled predecessor unavailable");
  expect(await f.remote.store.readPreparedMutation()).toBeNull();
  expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
  expect(await f.database.custodyProofs.count()).toBe(2);
  expect(
    await f.database.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, f.desired.localAssetKey]),
  ).toEqual(before);
});

it("stored restored-survivor request replays exact bytes without predecessor object refetch", async () => {
  const f = await ownerCtfRemovalFixture(2, true);
  databases.push(f.database);
  await startBrowserCtfRemove(f.input([f.proofs[0]!]));
  f.remote.loseNextSuccessfulReply();
  await expect(f.cycle()).rejects.toThrow("lost successful reply");
  expect(await f.remote.store.readPreparedMutation()).not.toBeNull();
  const previous = f.remote.remote.mutateHead.mock.calls.at(-1)![0];
  const read = vi
    .spyOn(f.remote.remote, "readObject")
    .mockRejectedValue(new Error("must not refetch"));
  expect((await f.cycle()).kind).toBe("committed");
  expect(read).not.toHaveBeenCalled();
  expect(f.remote.remote.mutateHead.mock.calls.at(-1)![0].canonicalUploadGroup).toEqual(
    previous.canonicalUploadGroup,
  );
  expect((await finalizeBrowserCtfRemove(f.final())).kind).toBe("completed");
  expect(await f.database.custodyProofs.count()).toBe(1);
});
