// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { webcrypto } from "node:crypto";
import { createEncryptedWalletBackupV2KeyHandle } from "@bitcaster/client-sdk/encryptedWalletBackupV2Keys";
import {
  collectEncryptedWalletBackupOwnerDescriptorPages,
  createEncryptedWalletBackupOwnerCurrentHead,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import {
  Amount,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  hashToCurve,
  Keyset,
  OutputData,
  pointFromHex,
  type Proof,
  type Wallet,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/curves/utils.js";
import { createDurableBolt11MintQuote } from "@bitcaster/client-sdk/durableBolt11MintQuote";
import { createEncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { prepareEncryptedWalletBackupV2ProofSetBundle } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { deriveEncryptedWalletBackupOwnerScope } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerScope";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { createBrowserCustodyProofRow } from "@/stores/durable-custody-db";
import { createBrowserProofBackupAuthorityRow } from "@/stores/browser-proof-backup-authority";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "@/stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { BitcasterDB } from "@/stores/proof-db";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "@/stores/encrypted-wallet-backup-owner-db";
import { recoverBrowserEncryptedWalletBackupOwnerConflict } from "../browserEncryptedWalletBackupOwnerConflictRecovery";

const realm = "mainnet";
const owner = {
  ...deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: "test",
    ownerSubject: "owner-a",
  }),
  enrollmentEpoch: 1,
};
const seed = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
const restorePrivateKey = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 1 : 0));
const restorePublicKey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const restoreKeysetId = deriveKeysetId({ "1": restorePublicKey }, { unit: "msat", versionByte: 1 });
let database: BitcasterDB | undefined;

afterEach(async () => {
  database?.close();
  if (database !== undefined) await Dexie.delete(database.name);
  database = undefined;
});

describe("selected-owner conflict recovery", () => {
  it("accepts a stable empty competing head and keeps a local-only desired asset pending", async () => {
    const runtime = createRuntime();
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed, realm, runtime });
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: keyHandle.walletId,
    });
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const store = makeStore(database, scopeId, keyHandle);
    const oldHead = evidence(keyHandle.walletId, 0);
    const remoteHead = evidence(keyHandle.walletId, 1);
    await store.acceptCurrentHead({ expectedHeadVersion: null, evidence: oldHead });
    await store.markCompetingHeadRecoveryRequired({ evidence: remoteHead });
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId,
      asset: { mintUrl: "https://mint.example", unit: "sat", assetIdentity: "cashu:ordinary" },
      custodyRevision: 1n,
      activeProofCount: 0,
    });
    await database.encryptedWalletBackupV2DesiredAssets.put(desired);
    const readCurrentHead = vi.fn(async () => remoteHead);

    await expect(
      recoverBrowserEncryptedWalletBackupOwnerConflict({
        database,
        scopeId,
        seed,
        keyHandle,
        owner,
        ownerContext: {
          ownerScopeId: owner.ownerScopeId,
          realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        ownerClient: { readCurrentHead, readObject: vi.fn() },
        ownerStore: store,
        runtime,
        signal: new AbortController().signal,
        isCurrentProfile: () => true,
        lockManager: testLockManager(),
        loadWallet: async () => {
          throw new Error("empty head must not load a mint");
        },
      }),
    ).resolves.toEqual({ kind: "completed", headVersion: 1, recoveryVersion: 2 });
    expect(readCurrentHead).toHaveBeenCalledTimes(2);
    expect(await store.readNewWritePermission()).toMatchObject({ canWrite: true });
    expect(
      await database.encryptedWalletBackupOwnerDesiredAssets.get([
        scopeId,
        owner.ownerScopeId,
        desired.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "pending", receiptDigest: null, activeProofCount: 0 });
  });

  it.each(["unspent", "unknown"] as const)(
    "refuses to erase a local-only predecessor whose NUT-07 state is %s",
    async (nut07Result) => {
      const runtime = createRuntime();
      const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed, realm, runtime });
      const scopeId = deriveDurableCustodyScopeId({
        scopeKind: "wallet",
        walletId: keyHandle.walletId,
      });
      database = new BitcasterDB(browserWalletDatabaseName(scopeId));
      await database.open();
      const store = makeStore(database, scopeId, keyHandle);
      const asset = createEncryptedWalletBackupV2AssetIdentity({
        mintUrl: "https://mint.example",
        unit: "msat",
        asset: { kind: "ordinary" },
      });
      const locator = {
        schemaVersion: 1 as const,
        kind: "nut13" as const,
        keysetId: restoreKeysetId,
        counter: 0,
      };
      const proof = signedProof(0);
      const localProof = createBrowserCustodyProofRow({
        scopeId,
        normalizedMint: asset.mintUrl,
        unit: "msat",
        proof,
        asset: { kind: "regular" },
        receivedAtMs: 1,
      });
      await database.custodyProofs.put(localProof);
      await database.custodyProofBackupAuthorities.put(
        createBrowserProofBackupAuthorityRow(localProof, 1, locator, "owner-conflict-local-only"),
      );
      await database.encryptedWalletBackupV2DesiredAssets.put(
        createEncryptedWalletBackupV2DesiredAssetRow({
          scopeId,
          asset,
          custodyRevision: 1n,
          activeProofCount: 1,
        }),
      );
      const oldHead = evidence(keyHandle.walletId, 0);
      const emptyCompetingHead = evidence(keyHandle.walletId, 1);
      await store.acceptCurrentHead({ expectedHeadVersion: null, evidence: oldHead });
      await store.markCompetingHeadRecoveryRequired({ evidence: emptyCompetingHead });
      const wallet = {
        mint: { mintUrl: asset.mintUrl },
        getKeyset: () => {
          const keyset = new Keyset(restoreKeysetId, "msat", true, 0, 0);
          keyset.keys = { "1": restorePublicKey };
          return keyset;
        },
        checkProofsStates: async () =>
          nut07Result === "unspent"
            ? [
                {
                  Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
                  state: "UNSPENT" as const,
                  witness: null,
                },
              ]
            : [],
      } as unknown as Wallet;

      await expect(
        recoverBrowserEncryptedWalletBackupOwnerConflict({
          database,
          scopeId,
          seed,
          keyHandle,
          owner,
          ownerContext: {
            ownerScopeId: owner.ownerScopeId,
            realm,
            walletId: keyHandle.walletId,
            enrollmentEpoch: 1,
          },
          ownerClient: {
            readCurrentHead: vi.fn(async () => emptyCompetingHead),
            readObject: vi.fn(),
          },
          ownerStore: store,
          runtime,
          signal: new AbortController().signal,
          isCurrentProfile: () => true,
          lockManager: testLockManager(),
          loadWallet: async () => wallet,
        }),
      ).resolves.toEqual({
        kind: "incomplete",
        reason:
          nut07Result === "unspent" ? "local-predecessor-unspent" : "local-predecessor-unknown",
      });
      expect(await database.custodyProofs.get([scopeId, localProof.proofId])).toBeDefined();
      expect(await store.readNewWritePermission()).toMatchObject({
        canWrite: false,
        localRecoveryStatus: "recovery-required",
      });
    },
  );

  it("records same-proof-set restore coverage inside the custody transaction", async () => {
    const runtime = createRuntime();
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed, realm, runtime });
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: keyHandle.walletId,
    });
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const store = makeStore(database, scopeId, keyHandle);
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: "https://mint.example",
      unit: "msat",
      asset: { kind: "ordinary" },
    });
    const locator = {
      schemaVersion: 1 as const,
      kind: "nut13" as const,
      keysetId: restoreKeysetId,
      counter: 0,
    };
    const proof = signedProof(0);
    const bundle = await prepareEncryptedWalletBackupV2ProofSetBundle({
      keyHandle,
      seed,
      asset,
      custodyRevision: 1n,
      counterHighWaterMarks: [
        { mintUrl: asset.mintUrl, unit: "msat", keysetId: restoreKeysetId, nextCounter: 1 },
      ],
      proofs: [
        { mintUrl: asset.mintUrl, unit: "msat", asset: { kind: "ordinary" }, locator, proof },
      ],
      runtime,
    });
    const localProof = createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: asset.mintUrl,
      unit: "msat",
      proof,
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    await database.custodyProofs.put(localProof);
    await database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(localProof, 1, locator, "conflict-local-proof"),
    );
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId,
      asset,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    await database.encryptedWalletBackupV2DesiredAssets.put(desired);
    const emptyHead = evidence(keyHandle.walletId, 0);
    const competingHead = evidence(keyHandle.walletId, 1, [bundle.descriptor]);
    await store.acceptCurrentHead({ expectedHeadVersion: null, evidence: emptyHead });
    await store.markCompetingHeadRecoveryRequired({ evidence: competingHead });
    const objects = new Map(bundle.objects.map((object) => [object.objectId, object]));
    let headReads = 0;
    let changeLocalRowAfterSnapshot = true;
    const readCurrentHead = vi.fn(async () => {
      headReads += 1;
      if (headReads === 2 && changeLocalRowAfterSnapshot) {
        changeLocalRowAfterSnapshot = false;
        const current = await database!.custodyProofs.get([scopeId, localProof.proofId]);
        const authority = await database!.custodyProofBackupAuthorities.get([
          scopeId,
          localProof.proofId,
        ]);
        if (current === undefined || authority === undefined)
          throw new Error("same-proof local fixture disappeared");
        await database!.custodyProofs.put({ ...current, revision: current.revision + 1 });
        await database!.custodyProofBackupAuthorities.put({
          ...authority,
          proofRevision: current.revision + 1,
        });
      }
      return competingHead;
    });

    await expect(
      recoverBrowserEncryptedWalletBackupOwnerConflict({
        database,
        scopeId,
        seed,
        keyHandle,
        owner,
        ownerContext: {
          ownerScopeId: owner.ownerScopeId,
          realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        ownerClient: {
          readCurrentHead,
          readObject: vi.fn(async ({ objectId }: { objectId: string }) => {
            const object = objects.get(objectId);
            if (object === undefined) throw new Error("owner object is absent");
            return object;
          }),
        },
        ownerStore: store,
        runtime,
        signal: new AbortController().signal,
        isCurrentProfile: () => true,
        lockManager: testLockManager(),
        loadWallet: async (mintUrl: string) => testWallet(mintUrl),
      }),
    ).resolves.toEqual({ kind: "incomplete", reason: "local-state-changed" });

    expect(await store.readNewWritePermission()).toMatchObject({
      canWrite: false,
      localRecoveryStatus: "recovery-required",
    });
    expect(await database.custodyProofs.get([scopeId, localProof.proofId])).toMatchObject({
      revision: 1,
    });

    await expect(
      recoverBrowserEncryptedWalletBackupOwnerConflict({
        database,
        scopeId,
        seed,
        keyHandle,
        owner,
        ownerContext: {
          ownerScopeId: owner.ownerScopeId,
          realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        ownerClient: {
          readCurrentHead,
          readObject: vi.fn(async ({ objectId }: { objectId: string }) => {
            const object = objects.get(objectId);
            if (object === undefined) throw new Error("owner object is absent");
            return object;
          }),
        },
        ownerStore: store,
        runtime,
        signal: new AbortController().signal,
        isCurrentProfile: () => true,
        lockManager: testLockManager(),
        loadWallet: async (mintUrl: string) => testWallet(mintUrl),
      }),
    ).resolves.toEqual({ kind: "completed", headVersion: 1, recoveryVersion: 2 });

    expect(readCurrentHead).toHaveBeenCalledTimes(4);
    expect(await database.custodyProofs.count()).toBe(1);
    expect(await database.encryptedWalletBackupOwnerProofCoverage.toArray()).toMatchObject([
      {
        sourceKind: "head-restore",
        receiptDigest: null,
        headVersion: 1,
        bundleId: bundle.descriptor.bundleId,
        proofId: localProof.proofId,
      },
    ]);
  });

  it("does not clear recovery when the owner head changes between reads", async () => {
    const runtime = createRuntime();
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed, realm, runtime });
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: keyHandle.walletId,
    });
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const store = makeStore(database, scopeId, keyHandle);
    const oldHead = evidence(keyHandle.walletId, 0);
    const firstHead = evidence(keyHandle.walletId, 1);
    const secondHead = evidence(keyHandle.walletId, 2);
    await store.acceptCurrentHead({ expectedHeadVersion: null, evidence: oldHead });
    await store.markCompetingHeadRecoveryRequired({ evidence: firstHead });
    const readCurrentHead = vi
      .fn()
      .mockResolvedValueOnce(firstHead)
      .mockResolvedValueOnce(secondHead);

    await expect(
      recoverBrowserEncryptedWalletBackupOwnerConflict({
        database,
        scopeId,
        seed,
        keyHandle,
        owner,
        ownerContext: {
          ownerScopeId: owner.ownerScopeId,
          realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        ownerClient: { readCurrentHead, readObject: vi.fn() },
        ownerStore: store,
        runtime,
        signal: new AbortController().signal,
        isCurrentProfile: () => true,
        lockManager: testLockManager(),
        loadWallet: async () => {
          throw new Error("empty head must not load a mint");
        },
      }),
    ).resolves.toEqual({ kind: "incomplete", reason: "remote-head-changed" });
    expect(await store.readNewWritePermission()).toMatchObject({
      canWrite: false,
      localRecoveryStatus: "recovery-required",
      localRecoveryVersion: 1,
    });
  });

  it("refuses owner-head reconciliation while submitted proof work is unresolved", async () => {
    const runtime = createRuntime();
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed, realm, runtime });
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: keyHandle.walletId,
    });
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const store = makeStore(database, scopeId, keyHandle);
    const oldHead = evidence(keyHandle.walletId, 0);
    const competingHead = evidence(keyHandle.walletId, 1);
    await store.acceptCurrentHead({ expectedHeadVersion: null, evidence: oldHead });
    await store.markCompetingHeadRecoveryRequired({ evidence: competingHead });
    await database.proofOperations.put({
      operationId: "prepared-owner-conflict-proof-op",
      kind: "wallet-mint",
      state: "prepared",
      mintUrl: "https://mint.example",
      inputs: [],
      outputs: {},
      metadata: { unit: "sat" },
      createdAt: 1,
      updatedAt: 1,
    });
    const readCurrentHead = vi.fn(async () => competingHead);

    await expect(
      recoverBrowserEncryptedWalletBackupOwnerConflict({
        database,
        scopeId,
        seed,
        keyHandle,
        owner,
        ownerContext: {
          ownerScopeId: owner.ownerScopeId,
          realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        ownerClient: { readCurrentHead, readObject: vi.fn() },
        ownerStore: store,
        runtime,
        signal: new AbortController().signal,
        isCurrentProfile: () => true,
        lockManager: testLockManager(),
        loadWallet: async () => {
          throw new Error("unresolved work must prevent recovery");
        },
      }),
    ).resolves.toEqual({ kind: "incomplete", reason: "submitted-work-unresolved" });
    expect(readCurrentHead).toHaveBeenCalledOnce();
    await expect(store.readCurrentHead()).resolves.toMatchObject({
      head: { headVersion: 0 },
    });
    expect(await database.proofOperations.get("prepared-owner-conflict-proof-op")).toMatchObject({
      state: "prepared",
    });
    await expect(store.readNewWritePermission()).resolves.toMatchObject({
      canWrite: false,
      localRecoveryStatus: "recovery-required",
    });
  });

  it("fails closed when a pending quote page overflows its bound", async () => {
    const runtime = createRuntime();
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed, realm, runtime });
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: keyHandle.walletId,
    });
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const store = makeStore(database, scopeId, keyHandle);
    const oldHead = evidence(keyHandle.walletId, 0);
    const competingHead = evidence(keyHandle.walletId, 1);
    await store.acceptCurrentHead({ expectedHeadVersion: null, evidence: oldHead });
    await store.markCompetingHeadRecoveryRequired({ evidence: competingHead });
    const rows = Array.from({ length: 258 }, (_, index) => {
      const quote = createDurableBolt11MintQuote({
        mintUrl: "https://mint.example",
        unit: "sat",
        requestedAmount: "1",
        quoteId: `bounded-recovery-quote-${index.toString().padStart(3, "0")}`,
        invoiceRequest: `lnbc1bounded${index}`,
        observedState: "UNPAID",
      });
      return {
        scopeId,
        paymentMethod: "bolt11" as const,
        quoteRecordId: quote.quoteRecordId,
        observedState: quote.observedState,
        recoveryState: "pending" as const,
        lastRecoveryAttemptAtMs: 0,
        quote,
      };
    });
    rows.sort((left, right) => left.quoteRecordId.localeCompare(right.quoteRecordId));
    const lastQuote = rows.at(-1)!;
    lastQuote.observedState = "PAID";
    lastQuote.quote = { ...lastQuote.quote, observedState: "PAID", revision: 1 };
    await database.mintQuotes.bulkPut(rows);
    const readCurrentHead = vi.fn(async () => competingHead);

    await expect(
      recoverBrowserEncryptedWalletBackupOwnerConflict({
        database,
        scopeId,
        seed,
        keyHandle,
        owner,
        ownerContext: {
          ownerScopeId: owner.ownerScopeId,
          realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        ownerClient: { readCurrentHead, readObject: vi.fn() },
        ownerStore: store,
        runtime,
        signal: new AbortController().signal,
        isCurrentProfile: () => true,
        lockManager: testLockManager(),
        loadWallet: async () => {
          throw new Error("unresolved quote must prevent recovery");
        },
      }),
    ).resolves.toEqual({ kind: "incomplete", reason: "submitted-work-unresolved" });
    expect(readCurrentHead).toHaveBeenCalledOnce();
    await expect(store.readCurrentHead()).resolves.toMatchObject({ head: { headVersion: 0 } });
    expect(await database.mintQuotes.count()).toBe(258);
  });
});

function createRuntime() {
  return {
    subtle: webcrypto.subtle as unknown as Pick<
      SubtleCrypto,
      "deriveBits" | "importKey" | "encrypt" | "decrypt"
    >,
    getRandomValues(target: Uint8Array) {
      return target.fill(7);
    },
  };
}

function testLockManager(): Pick<LockManager, "request"> {
  return {
    request: async <T>(_name: string, _options: LockOptions, callback: LockGrantedCallback<T>) =>
      callback(null as never),
  } as Pick<LockManager, "request">;
}

function makeStore(
  database: BitcasterDB,
  scopeId: string,
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>,
) {
  return new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database,
    scopeId,
    ownerScopeId: owner.ownerScopeId,
    realm,
    walletId: keyHandle.walletId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    enrollmentEpoch: owner.enrollmentEpoch,
    isCurrent: () => true,
  });
}

function evidence(
  wallet: string,
  headVersion: number,
  bundles: Parameters<typeof createEncryptedWalletBackupOwnerCurrentHead>[0]["bundles"] = [],
) {
  const head = createEncryptedWalletBackupOwnerCurrentHead({
    ownerScopeId: owner.ownerScopeId,
    realm,
    walletId: wallet,
    enrollmentEpoch: owner.enrollmentEpoch,
    headVersion,
    bundles,
  });
  return collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({ head, bundles }),
    {
      ownerScopeId: owner.ownerScopeId,
      realm,
      walletId: wallet,
      enrollmentEpoch: owner.enrollmentEpoch,
    },
  );
}

function signedProof(counter: number): Proof {
  const output = OutputData.createSingleDeterministicData(1, seed, counter, restoreKeysetId);
  const blindedMessage = pointFromHex(output.blindedMessage.B_);
  const signature = createBlindSignature(blindedMessage, restorePrivateKey, restoreKeysetId);
  const dleq = createDLEQProof(blindedMessage, restorePrivateKey);
  return output.toProof(
    {
      id: restoreKeysetId,
      amount: Amount.from(1),
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: restoreKeysetId, keys: { "1": restorePublicKey } },
  );
}

function testWallet(mintUrl: string): Wallet {
  const keyset = new Keyset(restoreKeysetId, "msat", true, 0, 0);
  keyset.keys = { "1": restorePublicKey };
  return {
    mint: { mintUrl },
    getKeyset: () => keyset,
    checkProofsStates: async (proofs: readonly { readonly secret: string }[]) =>
      proofs.map(({ secret }) => ({
        Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
        state: "UNSPENT" as const,
        witness: null,
      })),
  } as unknown as Wallet;
}
