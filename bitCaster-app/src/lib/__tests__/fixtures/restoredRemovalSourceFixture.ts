import { vi, expect } from "vitest";
import { BitcasterDB } from "@/stores/proof-db";
import { decodeBrowserCustodyProofRow } from "@/stores/durable-custody-types";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "@/stores/encrypted-wallet-backup-owner-db";
import { recoverBrowserEncryptedWalletBackupOwnerConflict } from "@/lib/browserEncryptedWalletBackupOwnerConflictRecovery";
import { createBrowserEncryptedWalletBackupV2RuntimeDriver } from "@/lib/encryptedWalletBackupDriver";
import { requireBrowserWalletNewWritePermission } from "@/lib/browserWalletNewWritePermission";
import { ownerCtfRemovalFixture, removalSeed, removalLock } from "./ownerCtfRemovalProofs";

export async function restoredRemovalSourceFixture(count = 2) {
  const source = await ownerCtfRemovalFixture(count);
  const head = source.remote.readHead();
  const name = source.database.name;
  source.database.close();
  await source.database.delete();
  const database = new BitcasterDB(name);
  const controller = new AbortController();
  let current = true;
  let driver: ReturnType<typeof createBrowserEncryptedWalletBackupV2RuntimeDriver> | undefined;
  try {
    await database.open();
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.encryptedWalletBackupOwnerAssetReceipts.count()).toBe(0);
    const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId: source.scopeId,
      ...source.remote.context,
      requestAuthPublicKey: source.keyHandle.requestAuthPublicKey,
      isCurrent: () => current,
    });
    await store.markCompetingHeadRecoveryRequired({ evidence: head });
    const loadWallet = vi.fn(async () => {
      throw new Error("sealed restore must not call mint");
    });
    const restored = await recoverBrowserEncryptedWalletBackupOwnerConflict({
      database,
      scopeId: source.scopeId,
      seed: removalSeed,
      keyHandle: source.keyHandle,
      owner: source.owner,
      ownerContext: source.remote.context,
      ownerClient: source.remote.remote,
      ownerStore: store,
      runtime: crypto,
      signal: controller.signal,
      isCurrentProfile: () => current,
      loadWallet,
      lockManager: removalLock,
    });
    expect(restored.kind).toBe("completed");
    expect(loadWallet).not.toHaveBeenCalled();
    const proofs = (await database.custodyProofs.toArray()).map(decodeBrowserCustodyProofRow);
    expect(proofs.map((p) => p.proofId).sort()).toEqual(source.proofs.map((p) => p.proofId).sort());
    expect(proofs.every((p) => p.selectability === "verified-losing")).toBe(true);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.encryptedWalletBackupOwnerAssetReceipts.count()).toBe(0);
    expect(await store.captureBackupReceiptForLocalAsset(source.desired.localAssetKey)).toBeNull();
    const client = source.remote.client;
    vi.spyOn(client, "discover").mockResolvedValue([] as never);
    vi.spyOn(client, "resolveFirstAccount").mockReturnValue({
      kind: "active",
      owner: source.owner,
    });
    vi.spyOn(client, "readEnrollmentEpoch").mockResolvedValue({
      status: "active",
      enrollmentEpoch: 1,
    });
    vi.spyOn(client, "readCurrentHead").mockImplementation(source.remote.remote.readCurrentHead);
    vi.spyOn(client, "mutateHead").mockImplementation(source.remote.remote.mutateHead);
    vi.spyOn(client, "readObject").mockImplementation(source.remote.remote.readObject);
    vi.stubEnv("VITE_ENCRYPTED_BACKUP_REALM", source.keyHandle.realm);
    vi.stubEnv("VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN", "https://backup.example");
    vi.stubEnv("VITE_ENCRYPTED_BACKUP_RECEIPT_KEY_ID", "55".repeat(16));
    vi.stubEnv(
      "VITE_ENCRYPTED_BACKUP_RECEIPT_PUBLIC_KEY",
      "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
    );
    const errors: unknown[] = [];
    driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
      configuration: {
        realm: source.keyHandle.realm,
        signedOrigin: "https://backup.example",
        transportOrigin: "https://backup.example",
        pinnedReceiptKeys: [
          {
            keyId: "55".repeat(16),
            publicKey: "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
          },
        ],
      },
      database,
      scopeId: source.scopeId,
      seed: removalSeed,
      runtime: crypto,
      signal: controller.signal,
      isCurrentProfile: () => current,
      ownerClient: client,
      ownerSession: {
        authenticatedOwnerScope: source.owner,
        signal: controller.signal,
        isCurrent: () => current && !controller.signal.aborted,
        requireCurrent() {
          if (!current) throw new Error("fixture session stale");
          controller.signal.throwIfAborted();
        },
        requireLifecycleOwner(candidate) {
          if (
            typeof candidate !== "object" ||
            candidate === null ||
            !("ownerScopeId" in candidate) ||
            candidate.ownerScopeId !== source.owner.ownerScopeId
          )
            throw new Error("foreign owner");
          return source.owner;
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
    await vi.waitFor(
      () => requireBrowserWalletNewWritePermission({ database, scopeId: source.scopeId }),
      { timeout: 5000 },
    );
    expect(source.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
    const stop = async () => {
      controller.abort();
      driver?.stop();
      await driver?.quiesceForSeedHandoff();
    };
    const close = async () => {
      await stop();
      database.close();
      await database.delete();
    };
    return {
      ...source,
      database,
      store,
      proofs,
      driver,
      client,
      errors,
      stop,
      close,
      loseSession() {
        current = false;
      },
      targets: (selected = proofs) =>
        selected.map((p) => ({
          proofId: p.proofId,
          proofFingerprint: p.proofFingerprint,
          proofRevision: p.revision,
        })),
      final: () => ({ ...source.final(), database }),
      input: (selected = proofs) => ({ ...source.input(selected), database }),
    };
  } catch (error) {
    controller.abort();
    driver?.stop();
    await driver?.quiesceForSeedHandoff();
    database.close();
    await database.delete();
    throw error;
  }
}
