// @vitest-environment node
import "fake-indexeddb/auto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { deriveConditionalKeysetId, type Proof } from "@cashu/cashu-ts";
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2CurrentHead,
  createEncryptedWalletBackupV2KeyHandle,
  decodeEncryptedWalletBackupV2UploadGroup,
  decryptEncryptedWalletBackupV2ProofSetBundle,
  deriveDurableCustodyWalletId,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  issueEncryptedWalletBackupV2BundleSupersessionReceipt,
  prepareEncryptedWalletBackupV2ProofSetBundle,
  prepareEncryptedWalletBackupV2TransportBundle,
  deriveRootCtfOutcomeCollectionId,
  type EncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2BundleObjectWire,
  type EncryptedWalletBackupV2BundleSupersessionReceipt,
  type EncryptedWalletBackupV2DescriptorPage,
  type EncryptedWalletBackupV2RemotePort,
  type EncryptedWalletBackupV2RequestProof,
} from "@bitcaster/client-sdk";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { deserializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { EncryptedWalletBackupV2HttpTransportError } from "@bitcaster/client-sdk/encryptedWalletBackupV2HttpAdapter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { EncryptedWalletBackupV2DexieAuthorityStore } from "../../stores/encrypted-wallet-backup-v2-db";
import {
  createBrowserProofBackupAuthorityRow,
  createBrowserRemoteProofBackupAuthorityRow,
} from "../../stores/browser-proof-backup-authority";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../../stores/durable-custody-db";
import { decodeBrowserCustodyProofRow } from "../../stores/durable-custody-types";
import { BitcasterDB } from "../../stores/proof-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import {
  runBrowserEncryptedWalletBackupV2WorkerCycle,
  type BrowserEncryptedWalletBackupV2WorkerInput,
} from "../browserEncryptedWalletBackupV2Worker";
import { commitBrowserCtfTerminalOperation } from "../../test/browserEncryptedWalletBackupV2CommittedTerminalFixture";

const REALM = "backup.example";
const SIGNING_KEY_ID = "55".repeat(16);
const SIGNING_PRIVATE_KEY = fromHex("03".repeat(32));
const SIGNING_PUBLIC_KEY = toHex(schnorr.getPublicKey(SIGNING_PRIVATE_KEY));
const REGULAR_KEYSET = `01${"33".repeat(32)}`;
const PUBLIC_KEY = `02${"22".repeat(32)}`;
const CTF_CONDITION_ID = "aa".repeat(32);
const CTF_OUTCOME = "YES";
const CTF_OUTCOME_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CTF_CONDITION_ID,
  outcomeCollection: CTF_OUTCOME,
});
const CTF_PUBLIC_KEY = `02${"66".repeat(32)}`;
const CTF_KEYSET = deriveConditionalKeysetId({
  keys: { "1": CTF_PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 100,
  final_expiry: 100,
  conditionId: CTF_CONDITION_ID,
  outcomeCollectionId: CTF_OUTCOME_ID,
});
const openDatabases: BitcasterDB[] = [];
let sequence = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("browser V2 backup worker", () => {
  it("default worker seals committed local losing proof before upload", async () => {
    const fixture = await terminalWorkerFixture();

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.mutations).toHaveLength(1);
    const group = decodeEncryptedWalletBackupV2UploadGroup({
      bytes: fixture.remote.mutations[0]!.bytes,
      expectedRequestAuthPublicKey: fixture.input.keyHandle.requestAuthPublicKey,
      expectedContext: {
        realm: REALM,
        walletId: fixture.input.keyHandle.walletId,
        enrollmentEpoch: 1,
      },
    });
    const added = group.mutationEvidence.envelope.mutation.addedBundle;
    if (added === null) throw new Error("test worker bundle is missing");
    const restored = await decryptEncryptedWalletBackupV2ProofSetBundle({
      keyHandle: fixture.input.keyHandle,
      seed: fixture.input.seed,
      expectedAsset: fixture.asset,
      custodyRevision: BigInt(added.custodyRevision),
      runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
      descriptor: added,
      objects: group.objects,
    });
    expect(restored.proofs).toHaveLength(2);
    expect(restored.proofs.filter(({ terminalSeal }) => terminalSeal !== undefined)).toHaveLength(
      1,
    );
    expect(fixture.remote.appliedMutations).toBe(1);
  });

  it("reuses an authenticated remote seal with the predecessor revision", async () => {
    const fixture = await terminalWorkerFixture();
    await prepareRemoteSealReuse(fixture);

    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({
        ...fixture.input,
        remoteOrigin: "https://backup.example",
      }),
    ).resolves.toEqual({ kind: "committed" });
    expect(fixture.remote.mutations).toHaveLength(2);
    const group = decodeEncryptedWalletBackupV2UploadGroup({
      bytes: fixture.remote.mutations[1]!.bytes,
      expectedRequestAuthPublicKey: fixture.input.keyHandle.requestAuthPublicKey,
      expectedContext: {
        realm: REALM,
        walletId: fixture.input.keyHandle.walletId,
        enrollmentEpoch: 1,
      },
    });
    const added = group.mutationEvidence.envelope.mutation.addedBundle;
    if (added === null) throw new Error("test successor bundle is missing");
    const restored = await decryptEncryptedWalletBackupV2ProofSetBundle({
      keyHandle: fixture.input.keyHandle,
      seed: fixture.seed,
      expectedAsset: fixture.asset,
      custodyRevision: BigInt(added.custodyRevision),
      runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
      descriptor: added,
      objects: group.objects,
    });
    expect(restored.proofs.filter(({ terminalSeal }) => terminalSeal !== undefined)).toHaveLength(
      1,
    );
  });

  it("reuses the exact losing seal when a sibling became spent locally", async () => {
    const fixture = await terminalWorkerFixture();
    await prepareRemoteSealReuse(fixture);
    const rows = (await fixture.database.custodyProofs.toArray()).map(decodeBrowserCustodyProofRow);
    const sibling = rows.find(({ selectability }) => selectability === "selectable");
    if (sibling === undefined) throw new Error("test sibling is missing");
    await fixture.database.custodyProofs.put({
      ...sibling,
      selectability: "spent",
      reservationOperationId: null,
    });
    const desired = (await fixture.database.encryptedWalletBackupV2DesiredAssets.toArray())[0];
    if (desired === undefined) throw new Error("test desired asset is missing");
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...desired,
      custodyRevision: (BigInt(desired.custodyRevision) + 1n).toString(),
      activeProofCount: 1,
      syncState: "pending",
    });

    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({
        ...fixture.input,
        remoteOrigin: "https://backup.example",
      }),
    ).resolves.toEqual({ kind: "committed" });
    expect(fixture.remote.mutations).toHaveLength(2);
    const group = decodeEncryptedWalletBackupV2UploadGroup({
      bytes: fixture.remote.mutations[1]!.bytes,
      expectedRequestAuthPublicKey: fixture.input.keyHandle.requestAuthPublicKey,
      expectedContext: {
        realm: REALM,
        walletId: fixture.input.keyHandle.walletId,
        enrollmentEpoch: 1,
      },
    });
    const added = group.mutationEvidence.envelope.mutation.addedBundle;
    if (added === null) throw new Error("test successor bundle is missing");
    const restored = await decryptEncryptedWalletBackupV2ProofSetBundle({
      keyHandle: fixture.input.keyHandle,
      seed: fixture.seed,
      expectedAsset: fixture.asset,
      custodyRevision: BigInt(added.custodyRevision),
      runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
      descriptor: added,
      objects: group.objects,
    });
    expect(restored.proofs).toHaveLength(1);
    expect(restored.proofs.filter(({ terminalSeal }) => terminalSeal !== undefined)).toHaveLength(
      1,
    );
  });

  it("reuses remote and local terminal origins in one successor bundle", async () => {
    const fixture = await terminalWorkerFixture(2);
    await prepareRemoteSealReuse(fixture, 0);

    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({
        ...fixture.input,
        remoteOrigin: "https://backup.example",
      }),
    ).resolves.toEqual({ kind: "committed" });
    const mutation = decodeEncryptedWalletBackupV2UploadGroup({
      bytes: fixture.remote.mutations[1]!.bytes,
      expectedRequestAuthPublicKey: fixture.input.keyHandle.requestAuthPublicKey,
      expectedContext: {
        realm: REALM,
        walletId: fixture.input.keyHandle.walletId,
        enrollmentEpoch: 1,
      },
    });
    const added = mutation.mutationEvidence.envelope.mutation.addedBundle;
    if (added === null) throw new Error("test mixed-origin bundle is missing");
    const restored = await decryptEncryptedWalletBackupV2ProofSetBundle({
      keyHandle: fixture.input.keyHandle,
      seed: fixture.seed,
      expectedAsset: fixture.asset,
      custodyRevision: BigInt(added.custodyRevision),
      runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
      descriptor: added,
      objects: mutation.objects,
    });
    expect(restored.proofs).toHaveLength(3);
    expect(restored.proofs.filter(({ terminalSeal }) => terminalSeal !== undefined)).toHaveLength(
      2,
    );
  });

  it("requeues without mutation when the sealed predecessor is missing", async () => {
    const fixture = await terminalWorkerFixture();
    await prepareRemoteSealReuse(fixture);
    fixture.remote.replaceHead([]);
    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({
        ...fixture.input,
        remoteOrigin: "https://backup.example",
      }),
    ).resolves.toEqual({ kind: "head-accepted" });

    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({
        ...fixture.input,
        remoteOrigin: "https://backup.example",
      }),
    ).rejects.toThrow(/remote terminal predecessor bundle is missing/);
    expect(fixture.remote.mutations).toHaveLength(1);
    expect(await fixture.store.readPreparedMutation()).toBeNull();
    expect(await fixture.database.custodyProofs.count()).toBe(2);
    expect(
      (await fixture.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]?.syncState,
    ).toBe("pending");
  });

  it("requeues without mutation when the predecessor seal was removed", async () => {
    const fixture = await terminalWorkerFixture();
    await prepareRemoteSealReuse(fixture);
    const predecessor = fixture.remote.evidence().bundles[0];
    if (predecessor === undefined) throw new Error("test predecessor is missing");
    const restored = await decryptEncryptedWalletBackupV2ProofSetBundle({
      keyHandle: fixture.input.keyHandle,
      seed: fixture.seed,
      expectedAsset: fixture.asset,
      custodyRevision: BigInt(predecessor.custodyRevision),
      runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
      descriptor: predecessor,
      objects: fixture.remote.storedObjects(predecessor),
    });
    const withoutSeals = await prepareEncryptedWalletBackupV2ProofSetBundle({
      keyHandle: fixture.input.keyHandle,
      seed: fixture.seed,
      asset: fixture.asset,
      proofs: restored.proofs.map(({ terminalSeal: _terminalSeal, ...proof }) => proof),
      custodyRevision: BigInt(predecessor.custodyRevision),
      counterHighWaterMarks: restored.counterHighWaterMarks,
      runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
    });
    fixture.remote.replaceHead([withoutSeals.descriptor], withoutSeals.objects);
    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({
        ...fixture.input,
        remoteOrigin: "https://backup.example",
      }),
    ).resolves.toEqual({ kind: "head-accepted" });

    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({
        ...fixture.input,
        remoteOrigin: "https://backup.example",
      }),
    ).rejects.toThrow(/remote terminal seal is missing/);
    expect(fixture.remote.mutations).toHaveLength(1);
    expect(await fixture.store.readPreparedMutation()).toBeNull();
    expect(await fixture.database.custodyProofs.count()).toBe(2);
  });

  it("requeues when the authenticated head changes before remote reuse", async () => {
    const fixture = await terminalWorkerFixture();
    await prepareRemoteSealReuse(fixture);
    fixture.remote.beforeDescriptorPage = () => {
      fixture.remote.replaceHead(fixture.remote.evidence().bundles);
    };

    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({
        ...fixture.input,
        remoteOrigin: "https://backup.example",
      }),
    ).resolves.toEqual({ kind: "head-accepted" });
    expect(fixture.remote.mutations).toHaveLength(1);
    expect(await fixture.store.readPreparedMutation()).toBeNull();
    expect(
      (await fixture.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]?.syncState,
    ).toBe("pending");
  });

  it("replays the prepared remote-seal successor after restart", async () => {
    const fixture = await terminalWorkerFixture();
    await prepareRemoteSealReuse(fixture);
    fixture.remote.failures.push("transport-failure");
    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({
        ...fixture.input,
        remoteOrigin: "https://backup.example",
      }),
    ).resolves.toEqual({ kind: "retry-pending", minimumRetryDelayMilliseconds: 5_000 });
    const prepared = await fixture.store.readPreparedMutation();
    if (prepared === null) throw new Error("test prepared mutation is missing");
    const firstBytes = prepared.canonicalUploadGroup;
    fixture.database.close();
    const reopened = new BitcasterDB(browserWalletDatabaseName(fixture.scopeId));
    openDatabases.push(reopened);

    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({ ...fixture.input, database: reopened }),
    ).resolves.toEqual({ kind: "committed" });
    expect(fixture.remote.mutations).toHaveLength(3);
    expect(sameBytes(fixture.remote.mutations[2]?.bytes, firstBytes)).toBe(true);
    expect(await reopened.encryptedWalletBackupV2PreparedMutations.count()).toBe(0);
  });

  it("re-fetches the remote seal after restart before successor preparation", async () => {
    const fixture = await terminalWorkerFixture();
    await prepareRemoteSealReuse(fixture);
    await fixture.database.custodyOperations.clear();
    await fixture.database.custodyArtifacts.clear();
    expect(await fixture.database.custodyOperations.count()).toBe(0);
    fixture.database.close();
    const reopened = new BitcasterDB(browserWalletDatabaseName(fixture.scopeId));
    openDatabases.push(reopened);

    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({
        ...fixture.input,
        database: reopened,
        remoteOrigin: "https://backup.example",
      }),
    ).resolves.toEqual({ kind: "committed" });
    expect(fixture.remote.mutations).toHaveLength(2);
    expect(await reopened.custodyOperations.count()).toBe(0);
    const group = decodeEncryptedWalletBackupV2UploadGroup({
      bytes: fixture.remote.mutations[1]!.bytes,
      expectedRequestAuthPublicKey: fixture.input.keyHandle.requestAuthPublicKey,
      expectedContext: {
        realm: REALM,
        walletId: fixture.input.keyHandle.walletId,
        enrollmentEpoch: 1,
      },
    });
    const added = group.mutationEvidence.envelope.mutation.addedBundle;
    if (added === null) throw new Error("test successor bundle is missing");
    const restored = await decryptEncryptedWalletBackupV2ProofSetBundle({
      keyHandle: fixture.input.keyHandle,
      seed: fixture.seed,
      expectedAsset: fixture.asset,
      custodyRevision: BigInt(added.custodyRevision),
      runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
      descriptor: added,
      objects: group.objects,
    });
    expect(restored.proofs).toHaveLength(2);
    expect(restored.proofs.filter(({ terminalSeal }) => terminalSeal !== undefined)).toHaveLength(
      1,
    );
  });

  it("refuses a wrong enrollment epoch without custody mutation", async () => {
    const wrongEpoch = await terminalWorkerFixture();
    await prepareRemoteSealReuse(wrongEpoch);
    wrongEpoch.remote.replaceHead(wrongEpoch.remote.evidence().bundles, [], 2);
    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({
        ...wrongEpoch.input,
        remoteOrigin: "https://backup.example",
      }),
    ).rejects.toThrow(/accepted head is stale|authority artifact is foreign/);
    expect(wrongEpoch.remote.mutations).toHaveLength(1);
    expect(await wrongEpoch.database.custodyProofs.count()).toBe(2);
  });

  it("refuses a backup outage without custody mutation", async () => {
    const outage = await terminalWorkerFixture();
    await prepareRemoteSealReuse(outage);
    outage.remote.readObjectFailure = new EncryptedWalletBackupV2HttpTransportError(
      "transport-failure",
    );
    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({
        ...outage.input,
        remoteOrigin: "https://backup.example",
      }),
    ).rejects.toThrow(/transport-failure/);
    expect(outage.remote.mutations).toHaveLength(1);
    expect(await outage.store.readPreparedMutation()).toBeNull();
    expect(await outage.database.custodyProofs.count()).toBe(2);
  });

  it("backs up an eligible proof when a transient locked proof has no locator", async () => {
    const fixture = await workerFixture(0);
    const locator = {
      schemaVersion: 1 as const,
      kind: "nut13" as const,
      keysetId: REGULAR_KEYSET,
      counter: 1,
    };
    const selectable = createBrowserCustodyProofRow({
      scopeId: fixture.scopeId,
      normalizedMint: "https://mint.example",
      unit: "msat",
      proof: {
        id: REGULAR_KEYSET,
        amount: 1 as never,
        secret: deriveDurableWalletProofSecret({
          seed: fixture.input.seed,
          locator,
          proofKeysetId: REGULAR_KEYSET,
          proofAmount: 1,
        }),
        C: PUBLIC_KEY,
      },
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    const transient = {
      ...createBrowserCustodyProofRow({
        scopeId: fixture.scopeId,
        normalizedMint: "https://mint.example",
        unit: "msat",
        proof: { id: REGULAR_KEYSET, amount: 1 as never, secret: "11".repeat(32), C: PUBLIC_KEY },
        asset: { kind: "regular" },
        receivedAtMs: 1,
      }),
      selectability: "locked" as const,
      reservationOperationId: "order:preparation",
    };
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: "https://mint.example",
      unit: "msat",
      asset: { kind: "ordinary" },
    });
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    await fixture.database.custodyProofs.bulkPut([selectable, transient]);
    await fixture.database.custodyProofBackupAuthorities.bulkPut([
      createBrowserProofBackupAuthorityRow(selectable, 2, locator, "receive:1"),
      createBrowserProofBackupAuthorityRow(transient, 2, null, "order:preparation"),
    ]);
    await fixture.database.walletCounterAssociations.put({
      scopeId: fixture.scopeId,
      normalizedMint: "https://mint.example",
      unit: "msat",
      keysetId: REGULAR_KEYSET,
      recoveryComplete: true,
    });
    await fixture.database.walletCounterCursors.put({
      scopeId: fixture.scopeId,
      keysetId: REGULAR_KEYSET,
      next: 2,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);

    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle({ ...fixture.input, assetSource: undefined }),
    ).resolves.toEqual({ kind: "committed" });
    expect(fixture.remote.mutations).toHaveLength(1);
  });

  it("skips an acknowledged first asset and processes later assets one per cycle", async () => {
    const fixture = await workerFixture(2);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.mutations).toHaveLength(1);
    expect(await fixture.database.encryptedWalletBackupV2AssetReceipts.count()).toBe(1);
    expect(
      (await fixture.database.encryptedWalletBackupV2DesiredAssets.toArray()).map(
        ({ syncState }) => syncState,
      ),
    ).toEqual(["acknowledged", "pending"]);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.mutations).toHaveLength(2);
    expect(await fixture.database.encryptedWalletBackupV2AssetReceipts.count()).toBe(2);
    expect(
      (await fixture.database.encryptedWalletBackupV2DesiredAssets.toArray()).map(
        ({ syncState }) => syncState,
      ),
    ).toEqual(["acknowledged", "acknowledged"]);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "idle",
    });
    expect(fixture.remote.mutations).toHaveLength(2);
  });

  it("retries byte-identical prepared upload data with a fresh request proof", async () => {
    const fixture = await workerFixture(1);
    fixture.remote.failures.push("transport-failure");

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "retry-pending",
      minimumRetryDelayMilliseconds: 5_000,
    });
    const persisted = await fixture.store.readPreparedMutation();
    expect(persisted).not.toBeNull();

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.mutations[0]?.bytes).toEqual(fixture.remote.mutations[1]?.bytes);
    expect(fixture.remote.mutations[0]?.replayNonce).not.toBe(
      fixture.remote.mutations[1]?.replayNonce,
    );
    expect(await fixture.store.readPreparedMutation()).toBeNull();
  });

  it("returns the server Retry-After delay for a retryable mutation failure", async () => {
    const fixture = await workerFixture(1);
    fixture.remote.failures.push(new EncryptedWalletBackupV2HttpTransportError("rate-limited", 60));
    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "retry-pending",
      minimumRetryDelayMilliseconds: 60_000,
    });
  });

  it("retries the exact prepared upload after the IndexedDB handle reopens", async () => {
    const fixture = await workerFixture(1);
    fixture.remote.failures.push("transport-failure");
    await runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input);
    const firstBytes = fixture.remote.mutations[0]!.bytes;
    fixture.database.close();
    const reopened = new BitcasterDB(browserWalletDatabaseName(fixture.scopeId));
    openDatabases.push(reopened);
    const input = { ...fixture.input, database: reopened };

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.mutations[1]?.bytes).toEqual(firstBytes);
    expect(await reopened.encryptedWalletBackupV2PreparedMutations.count()).toBe(0);
  });

  it("continues with the next pending asset after the IndexedDB handle reopens", async () => {
    const fixture = await workerFixture(2);
    await runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input);
    fixture.database.close();
    const reopened = new BitcasterDB(browserWalletDatabaseName(fixture.scopeId));
    openDatabases.push(reopened);
    const source = fixture.input.assetSource!;
    const input = {
      ...fixture.input,
      database: reopened,
      assetSource: {
        prepare: source.prepare,
        read: async ({ localAssetKey }: { readonly localAssetKey: string }) => {
          const desired = await reopened.encryptedWalletBackupV2DesiredAssets.get([
            fixture.scopeId,
            localAssetKey,
          ]);
          const asset = fixture.assets.get(localAssetKey);
          if (!desired || !asset) throw new Error("test asset is absent");
          return { desired, asset, proofs: [], losingProofs: [], counterHighWaterMarks: [] };
        },
      },
    };

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.mutations).toHaveLength(2);
    expect(
      (await reopened.encryptedWalletBackupV2DesiredAssets.toArray()).map(
        ({ syncState }) => syncState,
      ),
    ).toEqual(["acknowledged", "acknowledged"]);
  });

  it("makes no service mutation on local quota failure and requeues definite service refusal", async () => {
    const local = await workerFixture(1);
    vi.spyOn(local.database.encryptedWalletBackupV2PreparedMutations, "add").mockRejectedValueOnce(
      new DOMException("quota", "QuotaExceededError"),
    );
    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(local.input)).rejects.toThrow(
      /quota/,
    );
    expect(local.remote.mutations).toHaveLength(0);
    expect(await local.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(1);

    const service = await workerFixture(1);
    service.remote.failures.push("quota-exceeded");
    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(service.input)).resolves.toEqual({
      kind: "service-quota-pending",
    });
    expect(await service.store.readPreparedMutation()).toBeNull();
    expect(await service.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(1);
    expect(
      await service.database.encryptedWalletBackupV2DesiredAssets.get([
        service.scopeId,
        service.desired[0]!.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "pending" });
  });

  it("replays a remotely committed mutation after local commit rollback", async () => {
    const fixture = await workerFixture(1);
    await runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input);
    const predecessor = (await fixture.store.listActiveDescriptors())[0]!;
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...fixture.desired[0]!,
      custodyRevision: "2",
      syncState: "pending",
    });
    vi.spyOn(
      fixture.database.encryptedWalletBackupV2ActiveDescriptors,
      "put",
    ).mockRejectedValueOnce(new Error("commit fault"));

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).rejects.toThrow(
      /commit fault/,
    );
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();
    expect(await fixture.database.encryptedWalletBackupV2AssetReceipts.count()).toBe(1);
    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(1);
    expect((await fixture.store.listActiveDescriptors())[0]?.bundleId).toBe(predecessor.bundleId);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.mutations).toHaveLength(3);
    expect(fixture.remote.mutations[1]?.bytes).toEqual(fixture.remote.mutations[2]?.bytes);
    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(2);
    expect((await fixture.store.listActiveDescriptors())[0]?.bundleId).not.toBe(
      predecessor.bundleId,
    );
  });

  it("replays an uncertain post-commit response without creating a second remote mutation", async () => {
    const fixture = await workerFixture(1);
    fixture.remote.failAfterCommit = true;

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "retry-pending",
      minimumRetryDelayMilliseconds: 5_000,
    });
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();
    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.appliedMutations).toBe(1);
    expect(fixture.remote.mutations).toHaveLength(2);
    expect(fixture.remote.mutations[0]?.bytes).toEqual(fixture.remote.mutations[1]?.bytes);
  });

  it("retains the prepared mutation when receipt signature verification fails", async () => {
    const fixture = await workerFixture(1);
    fixture.remote.tamperNextReceipt = true;

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).rejects.toThrow(
      /receipt signature is invalid/,
    );
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();
    expect(await fixture.database.encryptedWalletBackupV2AssetReceipts.count()).toBe(0);
  });

  it("accepts a complete conflict head and keeps the desired asset pending", async () => {
    const fixture = await workerFixture(1);
    fixture.remote.failures.push("conflict");

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "conflict-recovered",
    });
    expect(await fixture.store.readPreparedMutation()).toBeNull();
    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(1);
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(1);
  });

  it("retains a newer desired revision that arrives during service I/O", async () => {
    const fixture = await workerFixture(1);
    const current = fixture.desired[0]!;
    fixture.remote.afterCommit = async () => {
      await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
        ...current,
        custodyRevision: "2",
      });
    };

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(
      (
        await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
          fixture.scopeId,
          current.localAssetKey,
        ])
      )?.custodyRevision,
    ).toBe("2");
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        current.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "pending" });
    expect((await fixture.store.readAssetReceipt(current.localAssetKey))?.custodyRevision).toBe(
      "1",
    );
  });

  it("fails on a stale profile before persistence or after service success", async () => {
    const before = await workerFixture(1);
    const originalPrepare = before.input.assetSource!.prepare;
    const staleBeforePersistence = {
      ...before.input,
      assetSource: {
        ...before.input.assetSource!,
        prepare: async (input: Parameters<typeof originalPrepare>[0]) => {
          const bundle = await originalPrepare(input);
          before.current = false;
          return bundle;
        },
      },
    };
    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle(staleBeforePersistence),
    ).rejects.toThrow(/profile is stale/);
    expect(before.remote.mutations).toHaveLength(0);
    expect(await before.store.readPreparedMutation()).toBeNull();

    const after = await workerFixture(1);
    after.remote.afterCommit = () => {
      after.current = false;
    };
    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(after.input)).rejects.toThrow(
      /profile is stale/,
    );
    expect(await after.store.readPreparedMutation()).not.toBeNull();
    expect(await after.database.encryptedWalletBackupV2AssetReceipts.count()).toBe(0);
  });

  it("does not call the service when the profile changes during request proof creation", async () => {
    const fixture = await workerFixture(1);
    fixture.remote.failures.push("transport-failure");
    await runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input);

    let checks = 0;
    const input = {
      ...fixture.input,
      isCurrentProfile: () => {
        checks += 1;
        return checks < 4;
      },
    };
    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(input)).rejects.toThrow(
      /profile is stale/,
    );
    expect(fixture.remote.mutations).toHaveLength(1);
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();
  });

  it("cleans an already-absent removal locally without service mutation", async () => {
    const fixture = await workerFixture(0);
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: "https://removed.example",
      unit: "sat",
      asset: { kind: "ordinary" },
    });
    const removal = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset,
      custodyRevision: 4n,
      activeProofCount: 0,
    });
    fixture.assets.set(removal.localAssetKey, asset);
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(removal);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(fixture.remote.mutations).toHaveLength(0);
  });

  it("does not inspect receipts for 256 acknowledged assets", async () => {
    const fixture = await workerFixture(0);
    const rows = Array.from({ length: 256 }, (_value, index) => {
      const asset = createEncryptedWalletBackupV2AssetIdentity({
        mintUrl: `https://acknowledged-${index}.example`,
        unit: "sat",
        asset: { kind: "ordinary" },
      });
      return {
        ...createEncryptedWalletBackupV2DesiredAssetRow({
          scopeId: fixture.scopeId,
          asset,
          custodyRevision: 1n,
          activeProofCount: 1,
        }),
        syncState: "acknowledged" as const,
      };
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.bulkPut(rows);
    const receiptRead = vi.spyOn(fixture.database.encryptedWalletBackupV2AssetReceipts, "get");

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "idle",
    });
    expect(receiptRead).not.toHaveBeenCalled();
    expect(fixture.remote.mutations).toHaveLength(0);
  });

  it("removes a current bundle before an earlier-sorting add at the full head limit", async () => {
    const fixture = await workerFixture(0);
    const removalAsset = ordinaryAsset("https://z-removal.example");
    const addAsset = ordinaryAsset("https://a-add.example");
    const removalDescriptor = await descriptorForAsset(fixture, removalAsset);
    fixture.remote.replaceHead(fullHead(removalDescriptor));
    await acceptRemoteHead(fixture);
    const removal = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: removalAsset,
      custodyRevision: 1n,
      activeProofCount: 0,
    });
    const add = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: addAsset,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    expect(add.localAssetKey < removal.localAssetKey).toBe(true);
    fixture.assets.set(add.localAssetKey, addAsset);
    await fixture.database.encryptedWalletBackupV2DesiredAssets.bulkPut([add, removal]);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });

    const mutation = decodeEncryptedWalletBackupV2UploadGroup({
      bytes: fixture.remote.mutations[0]!.bytes,
      expectedRequestAuthPublicKey: fixture.input.keyHandle.requestAuthPublicKey,
      expectedContext: {
        realm: REALM,
        walletId: fixture.input.keyHandle.walletId,
        enrollmentEpoch: 1,
      },
    }).mutationEvidence.envelope.mutation;
    expect(mutation.addedBundle).toBeNull();
    expect(mutation.supersededBundleIds).toEqual([removalDescriptor.bundleId]);
  });

  it("lets a later removal pass a definitely quota-rejected prepared add", async () => {
    const fixture = await workerFixture(0);
    const removalAsset = ordinaryAsset("https://z-later-removal.example");
    const addAsset = ordinaryAsset("https://a-quota-add.example");
    const removalDescriptor = await descriptorForAsset(fixture, removalAsset);
    fixture.remote.replaceHead([removalDescriptor]);
    await acceptRemoteHead(fixture);
    const add = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: addAsset,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    fixture.assets.set(add.localAssetKey, addAsset);
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(add);
    fixture.remote.failures.push("quota-exceeded");

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "service-quota-pending",
    });
    expect(await fixture.store.readPreparedMutation()).toBeNull();
    const removal = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: removalAsset,
      custodyRevision: 1n,
      activeProofCount: 0,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(removal);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    const second = decodeEncryptedWalletBackupV2UploadGroup({
      bytes: fixture.remote.mutations[1]!.bytes,
      expectedRequestAuthPublicKey: fixture.input.keyHandle.requestAuthPublicKey,
      expectedContext: {
        realm: REALM,
        walletId: fixture.input.keyHandle.walletId,
        enrollmentEpoch: 1,
      },
    }).mutationEvidence.envelope.mutation;
    expect(second.addedBundle).toBeNull();
    expect(second.supersededBundleIds).toEqual([removalDescriptor.bundleId]);
  });
});

async function workerFixture(assetCount: number) {
  sequence += 1;
  const seed = new Uint8Array(64).fill(sequence);
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: sequence.toString(16).padStart(64, "6"),
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  openDatabases.push(database);
  const store = new EncryptedWalletBackupV2DexieAuthorityStore({
    database,
    scopeId,
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
  });
  const remote = new FakeRemote(keyHandle.walletId, keyHandle.requestAuthPublicKey);
  await store.acceptCompetingHead({
    collectedHeadEvidence: remote.evidence(),
    stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
  });
  const assets = new Map<string, ReturnType<typeof createEncryptedWalletBackupV2AssetIdentity>>();
  const desired = Array.from({ length: assetCount }, (_value, index) => {
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: `https://mint-${sequence}-${index}.example`,
      unit: "sat",
      asset: { kind: "ordinary" },
    });
    const row = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId,
      asset,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    assets.set(row.localAssetKey, asset);
    return row;
  });
  await database.encryptedWalletBackupV2DesiredAssets.bulkPut(desired);
  let current = true;
  const assetSource: NonNullable<BrowserEncryptedWalletBackupV2WorkerInput["assetSource"]> = {
    read: async ({ localAssetKey }) => {
      const row = await database.encryptedWalletBackupV2DesiredAssets.get([scopeId, localAssetKey]);
      const asset = assets.get(localAssetKey);
      if (!row || !asset) throw new Error("test asset is absent");
      return { desired: row, asset, proofs: [], losingProofs: [], counterHighWaterMarks: [] };
    },
    prepare: async ({ snapshot, keyHandle: handle }) =>
      prepareEncryptedWalletBackupV2TransportBundle({
        keyHandle: handle,
        asset: snapshot.asset,
        declaredAmount: 1n,
        custodyRevision: BigInt(snapshot.desired.custodyRevision),
        canonicalPayload: encodeCanonicalBackupCbor([snapshot.desired.localAssetKey]),
        runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
      }),
  };
  const input: BrowserEncryptedWalletBackupV2WorkerInput = {
    database,
    scopeId,
    seed,
    keyHandle,
    enrollmentEpoch: 1,
    pinnedReceiptKeys: [{ keyId: SIGNING_KEY_ID, publicKey: SIGNING_PUBLIC_KEY }],
    remote,
    requestUrl: (kind, cursor) =>
      `https://backup.example/v2/${kind}${cursor === null ? "" : `?after=${cursor}`}`,
    nowUnixSeconds: () => 1_000,
    runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
    signal: new AbortController().signal,
    isCurrentProfile: () => current,
    assetSource,
  };
  return {
    database,
    store,
    scopeId,
    remote,
    desired,
    assets,
    input,
    get current() {
      return current;
    },
    set current(value: boolean) {
      current = value;
    },
  };
}

async function terminalWorkerFixture(losingCount = 1) {
  const seed = new Uint8Array(64).fill(19);
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const walletId = deriveDurableCustodyWalletId(seed);
  const scope = {
    scopeKind: "wallet" as const,
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
  };
  const database = new BitcasterDB(browserWalletDatabaseName(scope.scopeId));
  openDatabases.push(database);
  await database.open();
  const store = new EncryptedWalletBackupV2DexieAuthorityStore({
    database,
    scopeId: scope.scopeId,
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
  });
  const remote = new FakeRemote(keyHandle.walletId, keyHandle.requestAuthPublicKey);
  await store.acceptCompetingHead({
    collectedHeadEvidence: remote.evidence(),
    stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
  });
  const custody = new BrowserDurableCustodyAdapter(database);
  const owner = await custody.claimScope(scope, {
    incarnationId: "worker-terminal",
    observedAtMs: 10,
    leaseExpiresAtMs: 10_000,
  });
  const locators = Array.from({ length: losingCount }, (_value, index) => ({
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: CTF_KEYSET,
    counter: index + 1,
  }));
  const predecessors = locators.map((locator) =>
    createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: "https://mint.example",
      unit: "msat",
      proof: {
        id: CTF_KEYSET,
        amount: 1 as never,
        secret: deriveDurableWalletProofSecret({
          seed,
          locator,
          proofKeysetId: CTF_KEYSET,
          proofAmount: 1,
        }),
        C: CTF_PUBLIC_KEY,
      },
      asset: {
        kind: "conditional",
        conditionId: CTF_CONDITION_ID,
        outcomeCollection: CTF_OUTCOME,
      },
      receivedAtMs: 1,
    }),
  );
  await database.custodyProofs.bulkPut(predecessors);
  await database.custodyProofBackupAuthorities.bulkPut(
    predecessors.map((predecessor, index) =>
      createBrowserProofBackupAuthorityRow(
        predecessor,
        10,
        locators[index]!,
        `admission:worker-${index}`,
      ),
    ),
  );
  await database.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId: scope.scopeId,
    normalizedMint: "https://mint.example",
    unit: "msat",
    keysetId: CTF_KEYSET,
    denominationPublicKeys: { "1": CTF_PUBLIC_KEY },
    inputFeePpk: 100,
    conditionId: CTF_CONDITION_ID,
    outcomeCollection: CTF_OUTCOME,
    outcomeCollectionId: CTF_OUTCOME_ID,
    registeredAtUnixSeconds: 0,
    finalExpiryUnixSeconds: 100,
    curve: "secp256k1",
  });
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.example",
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: CTF_CONDITION_ID,
      outcomeCollectionId: CTF_OUTCOME_ID,
      outcomeLabel: CTF_OUTCOME,
      registeredAt: 0,
      finalExpiry: 100,
    },
  });
  const initialDesired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: scope.scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount: losingCount,
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(initialDesired);
  for (const [index, predecessor] of predecessors.entries()) {
    await commitBrowserCtfTerminalOperation({
      adapter: custody,
      scope,
      owner: { ...owner, observedAtMs: 10 + index * 10 },
      operationId: `ctf-redeem-worker-${index}`,
      mintUrl: "https://mint.example",
      proofs: [proofFromWorkerRow(predecessor)],
      predecessorProofs: [predecessor],
      publicKey: CTF_PUBLIC_KEY,
    });
  }
  const siblingLocator = { ...locators[locators.length - 1]!, counter: losingCount + 1 };
  const sibling = createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: "https://mint.example",
    unit: "msat",
    proof: {
      id: CTF_KEYSET,
      amount: 1 as never,
      secret: deriveDurableWalletProofSecret({
        seed,
        locator: siblingLocator,
        proofKeysetId: CTF_KEYSET,
        proofAmount: 1,
      }),
      C: CTF_PUBLIC_KEY,
    },
    asset: { kind: "conditional", conditionId: CTF_CONDITION_ID, outcomeCollection: CTF_OUTCOME },
    receivedAtMs: 1,
  });
  await database.custodyProofs.put(sibling);
  await database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(sibling, 20, siblingLocator, "receive:sibling"),
  );
  await database.walletCounterAssociations.put({
    scopeId: scope.scopeId,
    normalizedMint: "https://mint.example",
    unit: "msat",
    keysetId: CTF_KEYSET,
    recoveryComplete: true,
  });
  await database.walletCounterCursors.put({
    scopeId: scope.scopeId,
    keysetId: CTF_KEYSET,
    next: losingCount + 2,
  });
  const currentDesired = await database.encryptedWalletBackupV2DesiredAssets.get([
    scope.scopeId,
    initialDesired.localAssetKey,
  ]);
  if (currentDesired === undefined) throw new Error("test desired asset is missing");
  await database.encryptedWalletBackupV2DesiredAssets.put({
    ...createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: scope.scopeId,
      asset,
      custodyRevision: BigInt(currentDesired.custodyRevision) + 1n,
      activeProofCount: losingCount + 1,
    }),
    syncState: "pending",
  });
  let current = true;
  const input: BrowserEncryptedWalletBackupV2WorkerInput = {
    database,
    scopeId: scope.scopeId,
    seed,
    keyHandle,
    enrollmentEpoch: 1,
    pinnedReceiptKeys: [{ keyId: SIGNING_KEY_ID, publicKey: SIGNING_PUBLIC_KEY }],
    remote,
    requestUrl: (kind, cursor) =>
      `https://backup.example/v2/${kind}${cursor === null ? "" : `?after=${cursor}`}`,
    nowUnixSeconds: () => 1_000,
    runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
    signal: new AbortController().signal,
    isCurrentProfile: () => current,
  };
  return { database, store, scopeId: scope.scopeId, seed, input, asset, remote };
}

async function prepareRemoteSealReuse(
  fixture: Awaited<ReturnType<typeof terminalWorkerFixture>>,
  losingIndex = 0,
): Promise<void> {
  await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
    kind: "committed",
  });
  const currentDesired = (await fixture.database.encryptedWalletBackupV2DesiredAssets.toArray())[0];
  if (currentDesired === undefined) throw new Error("test desired asset is missing");
  const expectedLocator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: CTF_KEYSET,
    counter: losingIndex + 1,
  };
  const expectedSecret = deriveDurableWalletProofSecret({
    seed: fixture.seed,
    locator: expectedLocator,
    proofKeysetId: CTF_KEYSET,
    proofAmount: 1,
  });
  const losing = (await fixture.database.custodyProofs.toArray())
    .map(decodeBrowserCustodyProofRow)
    .filter(({ selectability }) => selectability === "verified-losing")
    .find((candidate) => proofFromWorkerRow(candidate).secret === expectedSecret);
  if (losing === undefined) throw new Error("test losing proof is missing");
  await fixture.database.custodyProofBackupAuthorities.put(
    createBrowserRemoteProofBackupAuthorityRow({
      proof: losing,
      observedAtMs: 30,
      derivationLocator: expectedLocator,
      restoreProofId: losing.proofId,
      restoreProofCommitment: `${(losingIndex + 11).toString(16).padStart(2, "0")}`.repeat(32),
    }),
  );
  await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
    ...createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: BigInt(currentDesired.custodyRevision) + 1n,
      activeProofCount: currentDesired.activeProofCount,
    }),
    syncState: "pending",
  });

  fixture.remote.replaceHead(fixture.remote.evidence().bundles);
  await expect(
    runBrowserEncryptedWalletBackupV2WorkerCycle({
      ...fixture.input,
      remoteOrigin: "https://backup.example",
    }),
  ).resolves.toEqual({ kind: "head-accepted" });
}

function proofFromWorkerRow(row: ReturnType<typeof createBrowserCustodyProofRow>): Proof {
  const proof = deserializeDurableCustodyProofArtifact(
    JSON.parse(new TextDecoder().decode(row.proofBody)),
  );
  return {
    id: proof.id,
    amount: Number(proof.amount),
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq === undefined ? {} : { dleq: structuredClone(proof.dleq) }),
  } as unknown as Proof;
}

function ordinaryAsset(mintUrl: string) {
  return createEncryptedWalletBackupV2AssetIdentity({
    mintUrl,
    unit: "sat",
    asset: { kind: "ordinary" },
  });
}

async function descriptorForAsset(
  fixture: Awaited<ReturnType<typeof workerFixture>>,
  asset: ReturnType<typeof ordinaryAsset>,
) {
  return (
    await prepareEncryptedWalletBackupV2TransportBundle({
      keyHandle: fixture.input.keyHandle,
      asset,
      declaredAmount: 1n,
      custodyRevision: 1n,
      canonicalPayload: encodeCanonicalBackupCbor(["head"]),
      runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
    })
  ).descriptor;
}

function fullHead(removal: EncryptedWalletBackupV2BundleDescriptor) {
  const bundles: EncryptedWalletBackupV2BundleDescriptor[] = [removal];
  for (let candidate = 1; bundles.length < 256; candidate += 1) {
    const bundleId = fixedHex(candidate, 16);
    const assetLocator = fixedHex(candidate, 32);
    const objectId = fixedHex(candidate * 16, 16);
    if (
      bundleId === removal.bundleId ||
      assetLocator === removal.assetLocator ||
      removal.objects.some((object) => object.objectId === objectId)
    )
      continue;
    bundles.push({
      ...removal,
      bundleId,
      assetLocator,
      objects: removal.objects.map((object, index) => ({
        ...object,
        objectId: fixedHex(candidate * 16 + index, 16),
      })),
    });
  }
  return bundles;
}

async function acceptRemoteHead(fixture: Awaited<ReturnType<typeof workerFixture>>): Promise<void> {
  await fixture.store.acceptCompetingHead({
    collectedHeadEvidence: fixture.remote.evidence(),
    stalePreparedMutation: {
      mutationId: "00".repeat(16),
      requestDigest: "00".repeat(32),
    },
  });
}

class FakeRemote implements EncryptedWalletBackupV2RemotePort {
  readonly failures: Array<
    "transport-failure" | "quota-exceeded" | "conflict" | EncryptedWalletBackupV2HttpTransportError
  > = [];
  readonly mutations: Array<{ bytes: Uint8Array; replayNonce: string }> = [];
  afterCommit: (() => void | Promise<void>) | null = null;
  beforeDescriptorPage: (() => void | Promise<void>) | null = null;
  readObjectFailure: EncryptedWalletBackupV2HttpTransportError | null = null;
  failAfterCommit = false;
  tamperNextReceipt = false;
  appliedMutations = 0;
  #enrollmentEpoch = 1;
  #head;
  #bundles: EncryptedWalletBackupV2BundleDescriptor[] = [];
  readonly #receipts = new Map<string, EncryptedWalletBackupV2BundleSupersessionReceipt>();
  readonly #objects = new Map<string, EncryptedWalletBackupV2BundleObjectWire>();
  readonly #requestAuthPublicKey: string;

  constructor(walletId: string, requestAuthPublicKey: string) {
    this.#requestAuthPublicKey = requestAuthPublicKey;
    this.#head = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      walletId,
      enrollmentEpoch: 1,
      headVersion: 0,
      bundles: [],
    });
  }

  evidence() {
    return collectEncryptedWalletBackupV2DescriptorPages(
      enumerateEncryptedWalletBackupV2DescriptorPages({
        head: this.#head,
        bundles: this.#bundles,
      }),
    );
  }

  replaceHead(
    bundles: readonly EncryptedWalletBackupV2BundleDescriptor[],
    objects: readonly EncryptedWalletBackupV2BundleObjectWire[] = [],
    enrollmentEpoch = this.#enrollmentEpoch,
  ): void {
    this.#enrollmentEpoch = enrollmentEpoch;
    for (const object of objects) this.#objects.set(object.objectId, object);
    this.#bundles = [...bundles].sort((left, right) => left.bundleId.localeCompare(right.bundleId));
    this.#head = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      walletId: this.#head.walletId,
      enrollmentEpoch: this.#enrollmentEpoch,
      headVersion: this.#head.headVersion + 1,
      bundles: this.#bundles,
    });
  }

  async readDescriptorPage(input: {
    readonly requestProof: EncryptedWalletBackupV2RequestProof;
    readonly afterBundleId: string | null;
  }): Promise<EncryptedWalletBackupV2DescriptorPage> {
    const page = enumerateEncryptedWalletBackupV2DescriptorPages({
      head: this.#head,
      bundles: this.#bundles,
    }).find(({ afterBundleId }) => afterBundleId === input.afterBundleId);
    if (!page) throw new Error("test page is absent");
    const beforeRead = this.beforeDescriptorPage;
    this.beforeDescriptorPage = null;
    await beforeRead?.();
    return page;
  }

  async mutateHeadOnce(input: {
    readonly requestProof: EncryptedWalletBackupV2RequestProof;
    readonly canonicalUploadGroup: Uint8Array;
  }): Promise<EncryptedWalletBackupV2BundleSupersessionReceipt> {
    this.mutations.push({
      bytes: input.canonicalUploadGroup.slice(),
      replayNonce: input.requestProof.replayNonce,
    });
    const failure = this.failures.shift();
    if (failure === "conflict") {
      this.#head = createEncryptedWalletBackupV2CurrentHead({
        realm: REALM,
        walletId: this.#head.walletId,
        enrollmentEpoch: this.#enrollmentEpoch,
        headVersion: this.#head.headVersion + 1,
        bundles: this.#bundles,
      });
      throw new EncryptedWalletBackupV2HttpTransportError("conflict");
    }
    if (failure instanceof EncryptedWalletBackupV2HttpTransportError) throw failure;
    if (failure) throw new EncryptedWalletBackupV2HttpTransportError(failure);
    const group = decodeEncryptedWalletBackupV2UploadGroup({
      bytes: input.canonicalUploadGroup,
      expectedRequestAuthPublicKey: this.#requestAuthPublicKey,
      expectedContext: {
        realm: REALM,
        walletId: this.#head.walletId,
        enrollmentEpoch: this.#enrollmentEpoch,
      },
    });
    const digest = group.mutationEvidence.envelope.requestDigest;
    const replay = this.#receipts.get(digest);
    if (replay) return replay;
    const mutation = group.mutationEvidence.envelope.mutation;
    for (const object of group.objects) this.#objects.set(object.objectId, object);
    const superseded = new Set(mutation.supersededBundleIds);
    this.#bundles = this.#bundles.filter(({ bundleId }) => !superseded.has(bundleId));
    if (mutation.addedBundle) this.#bundles.push(mutation.addedBundle);
    this.#bundles.sort((left, right) => left.bundleId.localeCompare(right.bundleId));
    this.#head = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      walletId: this.#head.walletId,
      enrollmentEpoch: this.#enrollmentEpoch,
      headVersion: this.#head.headVersion + 1,
      bundles: this.#bundles,
    });
    const receipt = await issueEncryptedWalletBackupV2BundleSupersessionReceipt({
      mutationEvidence: group.mutationEvidence,
      resultHead: this.#head,
      signingKeyId: SIGNING_KEY_ID,
      signingPublicKey: SIGNING_PUBLIC_KEY,
      signDigest: (value) => schnorr.sign(value, SIGNING_PRIVATE_KEY),
    });
    this.appliedMutations += 1;
    this.#receipts.set(digest, receipt);
    await this.afterCommit?.();
    if (this.failAfterCommit) {
      this.failAfterCommit = false;
      throw new EncryptedWalletBackupV2HttpTransportError("transport-failure");
    }
    if (this.tamperNextReceipt) {
      this.tamperNextReceipt = false;
      return { ...receipt, signature: "00".repeat(64) };
    }
    return receipt;
  }

  async discoverEnrollmentEpoch(): Promise<never> {
    throw new Error("not used");
  }

  async readCurrentInventory(): Promise<never> {
    throw new Error("not used");
  }

  storedObjects(
    descriptor: EncryptedWalletBackupV2BundleDescriptor,
  ): readonly EncryptedWalletBackupV2BundleObjectWire[] {
    return descriptor.objects.map((reference) => {
      const object = this.#objects.get(reference.objectId);
      if (object === undefined) throw new Error("test object is absent");
      return structuredClone(object);
    });
  }

  async readObject(input: {
    readonly objectId: string;
    readonly requestProof: EncryptedWalletBackupV2RequestProof;
    readonly expectedDescriptor: EncryptedWalletBackupV2BundleDescriptor;
  }): Promise<EncryptedWalletBackupV2BundleObjectWire> {
    const failure = this.readObjectFailure;
    this.readObjectFailure = null;
    if (failure) throw failure;
    const object = this.#objects.get(input.objectId);
    if (object === undefined) throw new Error("test object is absent");
    return structuredClone(object);
  }
}

function randomValues(target: Uint8Array): Uint8Array {
  return crypto.getRandomValues(target);
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_item, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, "0")).join("");
}

function fixedHex(value: number, bytes: number): string {
  return value.toString(16).padStart(bytes * 2, "0");
}
