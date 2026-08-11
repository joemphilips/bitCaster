// @vitest-environment node
import "fake-indexeddb/auto";
import { Amount } from "@cashu/cashu-ts";
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2CurrentHead,
  createEncryptedWalletBackupV2KeyHandle,
  decodeEncryptedWalletBackupV2BundleDescriptorWire,
  decodeEncryptedWalletBackupV2UploadGroup,
  encodeEncryptedWalletBackupV2BundleSupersessionReceipt,
  encodeEncryptedWalletBackupV2BundleDescriptor,
  encodeEncryptedWalletBackupV2CurrentHead,
  encodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire,
  encodeEncryptedWalletBackupV2UploadGroup,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  issueEncryptedWalletBackupV2BundleSupersessionReceipt,
  prepareEncryptedWalletBackupV2BundleSupersessionMutation,
  prepareEncryptedWalletBackupV2TransportBundle,
  verifyEncryptedWalletBackupV2BundleSupersessionReceipt,
} from "@bitcaster/client-sdk";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { encodeCtfRangeOrderPreparationArtifact } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { BitcasterDB } from "../../stores/proof-db";
import { EncryptedWalletBackupV2DexieAuthorityStore } from "../../stores/encrypted-wallet-backup-v2-db";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import {
  handoffBrowserEncryptedWalletBackupV2Seed,
  listBrowserEncryptedWalletBackupV2CacheRemovalEligibleAssets,
} from "../browserEncryptedWalletBackupV2SeedHandoff";

const databases: BitcasterDB[] = [];
let sequence = 0;
const REALM = "backup.example";
const SIGNING_KEY_ID = "55".repeat(16);
const SIGNING_PRIVATE_KEY = fromHex("03".repeat(32));
const SIGNING_PUBLIC_KEY = toHex(schnorr.getPublicKey(SIGNING_PRIVATE_KEY));
const KEYSET = `01${"22".repeat(32)}`;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

it("accepts an empty, captured wallet without network I/O", async () => {
  const { database, scopeId } = fixture();
  await expect(
    listBrowserEncryptedWalletBackupV2CacheRemovalEligibleAssets({
      database,
      scopeId,
      isCurrentProfile: () => true,
    }),
  ).resolves.toEqual([]);
});

it("blocks seed handoff when an asset is not acknowledged", async () => {
  const { database, scopeId } = fixture();
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset: createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: "https://mint.example",
      unit: "sat",
      asset: { kind: "ordinary" },
    }),
    custodyRevision: 1n,
    activeProofCount: 1,
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(desired);

  await expect(
    handoffBrowserEncryptedWalletBackupV2Seed({
      database,
      scopeId,
      isCurrentProfile: () => true,
      lockManager: immediateLockManager(),
      invalidateOldProfile: vi.fn(),
      activateNewProfile: vi.fn(),
      restoreOldProfile: vi.fn(),
    }),
  ).rejects.toThrow(/uncovered desired assets/);
});

it("blocks seed handoff while a proof operation is prepared", async () => {
  const { database, scopeId } = fixture();
  await database.proofOperations.put({
    operationId: "prepared-operation",
    kind: "wallet-send",
    state: "prepared",
    mintUrl: "https://mint.example",
    inputs: [],
    outputs: {},
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  });

  await expect(
    handoffBrowserEncryptedWalletBackupV2Seed({
      database,
      scopeId,
      isCurrentProfile: () => true,
      lockManager: immediateLockManager(),
      invalidateOldProfile: vi.fn(),
      activateNewProfile: vi.fn(),
      restoreOldProfile: vi.fn(),
    }),
  ).rejects.toThrow(/prepared proof operation/);
});

it("returns a fully acknowledged non-empty asset and rejects a revision replacement", async () => {
  const covered = await coveredFixture();
  await expect(
    listBrowserEncryptedWalletBackupV2CacheRemovalEligibleAssets({
      database: covered.database,
      scopeId: covered.scopeId,
      isCurrentProfile: () => true,
    }),
  ).resolves.toHaveLength(1);
  await covered.database.encryptedWalletBackupV2DesiredAssets.put({
    ...covered.desired,
    custodyRevision: "2",
    syncState: "acknowledged",
  });
  await expect(
    listBrowserEncryptedWalletBackupV2CacheRemovalEligibleAssets({
      database: covered.database,
      scopeId: covered.scopeId,
      isCurrentProfile: () => true,
    }),
  ).resolves.toEqual([]);
});

it("blocks a seed handoff when active custody has an untracked proof", async () => {
  const covered = await coveredFixture();
  await covered.database.custodyProofs.put(
    proofRow(covered.scopeId, 2, "https://other-mint.example"),
  );
  await expect(
    handoffBrowserEncryptedWalletBackupV2Seed({
      database: covered.database,
      scopeId: covered.scopeId,
      isCurrentProfile: () => true,
      lockManager: immediateLockManager(),
      invalidateOldProfile: vi.fn(),
      activateNewProfile: vi.fn(),
      restoreOldProfile: vi.fn(),
    }),
  ).rejects.toThrow(/untracked active custody rows/);
});

it("keeps an eligible asset selectable when another asset is pending", async () => {
  const covered = await coveredFixture();
  await covered.database.encryptedWalletBackupV2DesiredAssets.put(
    createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: covered.scopeId,
      asset: createEncryptedWalletBackupV2AssetIdentity({
        mintUrl: "https://other-mint.example",
        unit: "sat",
        asset: { kind: "ordinary" },
      }),
      custodyRevision: 1n,
      activeProofCount: 1,
    }),
  );
  await expect(
    listBrowserEncryptedWalletBackupV2CacheRemovalEligibleAssets({
      database: covered.database,
      scopeId: covered.scopeId,
      isCurrentProfile: () => true,
    }),
  ).resolves.toHaveLength(1);
});

it("keeps a signed receipt eligible when a later head retains its descriptor", async () => {
  const covered = await coveredFixture();
  const first = await covered.database.encryptedWalletBackupV2ActiveDescriptors.toArray();
  const firstDescriptor = decodeEncryptedWalletBackupV2BundleDescriptorWire(
    first[0]!.canonicalDescriptor,
    { realm: REALM, walletId: covered.keyHandle.walletId },
  );
  const secondAsset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://other-mint.example",
    unit: "sat",
    asset: { kind: "ordinary" },
  });
  const second = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle: covered.keyHandle,
    asset: secondAsset,
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: encodeCanonicalBackupCbor(["second-proof"]),
    runtime: { subtle: crypto.subtle, getRandomValues: queuedRandom([hex(5, 16), hex(6, 12)]) },
  });
  const laterHead = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: covered.keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 2,
    bundles: [firstDescriptor, second.descriptor],
  });
  const previousHead = await covered.database.encryptedWalletBackupV2AcceptedHeads.toArray();
  await covered.database.encryptedWalletBackupV2AcceptedHeads.put({
    ...previousHead[0]!,
    headVersion: laterHead.headVersion,
    activeBundleCount: laterHead.activeBundleCount,
    activeObjectCount: laterHead.activeObjectCount,
    activeSetDigest: laterHead.activeSetDigest,
    canonicalCurrentHead: encodeEncryptedWalletBackupV2CurrentHead(laterHead),
  });
  await covered.database.encryptedWalletBackupV2ActiveDescriptors.put({
    scopeId: covered.scopeId,
    realm: REALM,
    walletId: covered.keyHandle.walletId,
    enrollmentEpoch: 1,
    bundleId: second.descriptor.bundleId,
    assetLocator: second.descriptor.assetLocator,
    declaredAmount: second.descriptor.declaredAmount.toString(),
    custodyRevision: second.descriptor.custodyRevision.toString(),
    payloadCommitment: second.descriptor.payloadCommitment,
    objectCount: second.descriptor.objects.length,
    canonicalDescriptor: encodeEncryptedWalletBackupV2BundleDescriptor(second.descriptor),
  });

  await expect(
    listBrowserEncryptedWalletBackupV2CacheRemovalEligibleAssets({
      database: covered.database,
      scopeId: covered.scopeId,
      isCurrentProfile: () => true,
    }),
  ).resolves.toHaveLength(1);
});

it("excludes locked local proof custody from cache removal", async () => {
  const covered = await coveredFixture();
  const proof = proofRow(covered.scopeId, 1);
  await covered.database.custodyProofs.put({
    ...proof,
    selectability: "locked",
    reservationOperationId: "reservation",
  });
  await expect(
    listBrowserEncryptedWalletBackupV2CacheRemovalEligibleAssets({
      database: covered.database,
      scopeId: covered.scopeId,
      isCurrentProfile: () => true,
    }),
  ).resolves.toEqual([]);
});

it("blocks seed handoff for each active local work category", async () => {
  const activeWork = fixture();
  await activeWork.database.custodyActiveWork.put({
    scopeId: activeWork.scopeId,
    operationId: "active-work",
    nextAttemptAtMs: 1,
    estimatedBytes: 1,
  });
  await expect(handoff(activeWork)).rejects.toThrow(/active custody work/);

  const activeRange = fixture();
  await activeRange.database.ctfRangePreparations.put(rangeRecord(activeRange.scopeId, "prepared"));
  await expect(handoff(activeRange)).rejects.toThrow(/active CTF range work/);

  const mutation = fixture();
  await mutation.database.encryptedWalletBackupV2PreparedMutations.put({
    scopeId: mutation.scopeId,
    realm: REALM,
    walletId: "11".repeat(32),
    enrollmentEpoch: 1,
    mutationId: "22".repeat(16),
    requestDigest: "33".repeat(32),
    canonicalUploadGroup: new Uint8Array([1]),
    createdAtUnixMilliseconds: 1,
    localAssetKey: "asset",
    assetLocator: "44".repeat(32),
    custodyRevision: "1",
    desiredAction: "replace",
    activeProofCount: 1,
  });
  await expect(handoff(mutation)).rejects.toThrow(/prepared backup mutation/);
});

it("blocks seed handoff for nonterminal outgoing Cashu authority without deleting the old database", async () => {
  const current = fixture();
  await current.database.outgoingCashuTransfers.put({
    scopeId: current.scopeId,
    mintUrl: "https://mint.example",
    mintRecoveryState: "complete",
    localAuthorityState: "nonterminal",
    bearerMintUrl: null,
    dueAtMs: 1,
    transferId: "outgoing-nonterminal",
    recipientBinding: null,
    admissionState: "consumed",
    transfer: {} as never,
  });
  const remove = vi.spyOn(current.database, "delete");

  await expect(handoff(current)).rejects.toThrow(/nonterminal outgoing Cashu authority/);
  expect(remove).not.toHaveBeenCalled();
});

it("does not block seed handoff for more than 256 terminal CTF preparations", async () => {
  const current = fixture();
  await current.database.ctfRangePreparations.bulkPut(
    Array.from({ length: 257 }, (_, index) => rangeRecord(current.scopeId, "terminal", index)),
  );
  await expect(handoff(current)).resolves.toBeUndefined();
});

it("deletes the captured database before activating the new profile", async () => {
  const { database, scopeId } = fixture();
  const events: string[] = [];
  const close = database.close.bind(database);
  vi.spyOn(database, "close").mockImplementation(() => {
    events.push("close");
    close();
  });

  await handoffBrowserEncryptedWalletBackupV2Seed({
    database,
    scopeId,
    isCurrentProfile: () => true,
    lockManager: immediateLockManager(),
    invalidateOldProfile: () => events.push("invalidate"),
    activateNewProfile: async () => {
      events.push("activate");
    },
    restoreOldProfile: async () => {
      events.push("restore");
    },
  });

  expect(events[0]).toBe("invalidate");
  expect(events).toContain("close");
  expect(events.at(-1)).toBe("activate");
});

it("rechecks custody after the wallet lock admits a competing update", async () => {
  const covered = await coveredFixture();
  const locks: string[] = [];
  let competingUpdate = false;
  const lockManager = {
    request: async <T>(name: string, _options: LockOptions, callback: LockGrantedCallback<T>) => {
      locks.push(name);
      if (name.includes("encrypted-wallet-backup/v2") && !competingUpdate) {
        competingUpdate = true;
        await covered.database.encryptedWalletBackupV2DesiredAssets.put({
          ...covered.desired,
          custodyRevision: "2",
          syncState: "pending",
        });
      }
      return callback(null);
    },
  } as Pick<LockManager, "request">;

  await expect(
    handoffBrowserEncryptedWalletBackupV2Seed({
      database: covered.database,
      scopeId: covered.scopeId,
      isCurrentProfile: () => true,
      lockManager,
      invalidateOldProfile: vi.fn(),
      activateNewProfile: vi.fn(),
      restoreOldProfile: vi.fn(),
    }),
  ).rejects.toThrow(/uncovered desired assets/);
  expect(locks[0]).toContain("wallet-profile");
  expect(locks[1]).toContain("encrypted-wallet-backup/v2");
  expect(covered.database.isOpen()).toBe(true);
});

it("uses the scoped active-proof index without reading spent history", async () => {
  const covered = await coveredFixture();
  await covered.database.custodyProofs.bulkPut(
    Array.from({ length: 1_024 }, (_, index) => ({
      ...proofRow(covered.scopeId, index + 10, "https://spent-mint.example"),
      revision: 1,
      selectability: "spent" as const,
    })),
  );
  expect(covered.database.custodyProofs.schema.idxByName["[scopeId+selectability]"]).toBeDefined();
  await expect(handoff(covered)).resolves.toBeUndefined();
});

it("restores the old activation when deletion or activation fails", async () => {
  const { database, scopeId } = fixture();
  const restoreOldProfile = vi.fn(async () => undefined);
  vi.spyOn(database, "delete").mockRejectedValueOnce(new Error("delete failed"));

  await expect(
    handoffBrowserEncryptedWalletBackupV2Seed({
      database,
      scopeId,
      isCurrentProfile: () => true,
      lockManager: immediateLockManager(),
      invalidateOldProfile: vi.fn(),
      activateNewProfile: vi.fn(),
      restoreOldProfile,
    }),
  ).rejects.toThrow(/delete failed/);
  expect(restoreOldProfile).toHaveBeenCalledOnce();
});

it("restores the old activation when new-profile activation fails", async () => {
  const { database, scopeId } = fixture();
  const restoreOldProfile = vi.fn(async () => undefined);
  await expect(
    handoffBrowserEncryptedWalletBackupV2Seed({
      database,
      scopeId,
      isCurrentProfile: () => true,
      lockManager: immediateLockManager(),
      invalidateOldProfile: vi.fn(),
      activateNewProfile: vi.fn(async () => {
        throw new Error("activation failed");
      }),
      restoreOldProfile,
    }),
  ).rejects.toThrow(/activation failed/);
  expect(restoreOldProfile).toHaveBeenCalledOnce();
});

it("rejects a stale profile or a database from another scope", async () => {
  const { database, scopeId } = fixture();
  await expect(
    listBrowserEncryptedWalletBackupV2CacheRemovalEligibleAssets({
      database,
      scopeId,
      isCurrentProfile: () => false,
    }),
  ).rejects.toThrow(/profile is stale/);
});

function fixture() {
  sequence += 1;
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: sequence.toString(16).padStart(64, "0"),
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  databases.push(database);
  return { database, scopeId };
}

function immediateLockManager(): Pick<LockManager, "request"> {
  return {
    request: async <T>(_name: string, _options: LockOptions, callback: LockGrantedCallback<T>) =>
      callback(null),
  } as Pick<LockManager, "request">;
}

function handoff(input: { readonly database: BitcasterDB; readonly scopeId: string }) {
  return handoffBrowserEncryptedWalletBackupV2Seed({
    ...input,
    isCurrentProfile: () => true,
    lockManager: immediateLockManager(),
    invalidateOldProfile: vi.fn(),
    activateNewProfile: vi.fn(),
    restoreOldProfile: vi.fn(),
  });
}

function rangeRecord(scopeId: string, lifecycleState: "prepared" | "terminal", ordinal = 0) {
  const id = `range-${ordinal}`;
  return {
    scopeId,
    rangeOperationId: id,
    sourceOperationId: `${id}-source`,
    sourceKind: "wallet-prepared" as const,
    predecessorRangeOperationId: null,
    authorizationId: `${id}-authorization`,
    clientOrderId: `${id}-client`,
    orderRouteId: "condition-a-YES",
    normalizedMint: "https://mint.example",
    conditionId: "condition-a",
    unit: "msat" as const,
    tokenSide: "Outcome" as const,
    side: "Buy" as const,
    priceSubunits: 5_000,
    amountSubunits: 10_000,
    minimumFillAmountSubunits: 10_000,
    continueAfterPartialFill: false,
    continuation: null,
    divisibility: 10_000 as const,
    authorizationExpiresAtUnixSeconds: 1_000,
    preparationBytes: encodeCtfRangeOrderPreparationArtifact({ version: 1 }),
    createdAtMs: ordinal + 1,
    lifecycleState,
    revision: 0,
    capability: null,
    updatedAtMs: ordinal + 1,
  };
}

async function coveredFixture() {
  const { database, scopeId } = fixture();
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: new Uint8Array(64).fill(sequence),
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.example",
    unit: "sat",
    asset: { kind: "ordinary" },
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount: 1,
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(desired);
  await database.custodyProofs.put(proofRow(scopeId, 1));
  const store = new EncryptedWalletBackupV2DexieAuthorityStore({
    database,
    scopeId,
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
  });
  const emptyHead = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 0,
    bundles: [],
  });
  await store.acceptCompetingHead({
    collectedHeadEvidence: evidence(emptyHead, []),
    stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
  });
  const bundle = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset,
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: encodeCanonicalBackupCbor(["proof"]),
    runtime: { subtle: crypto.subtle, getRandomValues: queuedRandom([hex(1, 16), hex(2, 12)]) },
  });
  const envelope = await prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle,
    expectedHeadEvidence: evidence(emptyHead, []),
    addedBundle: bundle.descriptor,
    supersededBundleIds: [],
    runtime: { getRandomValues: queuedRandom([hex(3, 16), hex(4, 32)]) },
  });
  const group = encodeEncryptedWalletBackupV2UploadGroup({ envelope, objects: bundle.objects });
  const resultHead = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [bundle.descriptor],
  });
  const binding = {
    localAssetKey: desired.localAssetKey,
    assetLocator: bundle.descriptor.assetLocator,
    custodyRevision: desired.custodyRevision,
    desiredAction: "replace" as const,
    activeProofCount: 1,
  };
  const prepared = {
    mutationId: envelope.mutation.mutationId,
    requestDigest: envelope.requestDigest,
    canonicalUploadGroup: group,
    createdAtUnixMilliseconds: 1,
    ...binding,
  };
  await store.insertPreparedMutationForDesired({ prepared, desired: binding });
  const mutationEvidence = decodeEncryptedWalletBackupV2UploadGroup({
    bytes: group,
    expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
    expectedContext: { realm: REALM, walletId: keyHandle.walletId, enrollmentEpoch: 1 },
  }).mutationEvidence;
  const receipt = await issueEncryptedWalletBackupV2BundleSupersessionReceipt({
    mutationEvidence,
    resultHead,
    signingKeyId: SIGNING_KEY_ID,
    signingPublicKey: SIGNING_PUBLIC_KEY,
    signDigest: (digest) => schnorr.sign(digest, SIGNING_PRIVATE_KEY),
  });
  await store.commitVerifiedAssetReceipt({
    binding: {
      ...binding,
      bundleId: bundle.descriptor.bundleId,
      bundleDescriptorDigest: receipt.bundleDescriptorDigest,
    },
    canonicalSignedMutation:
      encodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire(envelope),
    canonicalSignedReceipt: encodeEncryptedWalletBackupV2BundleSupersessionReceipt(receipt),
    verifiedReceipt: verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
      receipt,
      mutationEvidence,
      pinnedSigningKeys: [{ keyId: SIGNING_KEY_ID, publicKey: SIGNING_PUBLIC_KEY }],
    }),
    collectedHeadEvidence: evidence(resultHead, [bundle.descriptor]),
    preparedMutation: prepared,
  });
  return { database, scopeId, desired, keyHandle };
}

function proofRow(scopeId: string, amount: number, normalizedMint = "https://mint.example") {
  return createBrowserCustodyProofRow({
    scopeId,
    normalizedMint,
    unit: "sat",
    proof: {
      id: KEYSET,
      amount: Amount.from(amount),
      secret: `secret-${sequence}-${amount}`,
      C: `02${amount.toString(16).padStart(64, "0")}`,
    },
    asset: { kind: "regular" },
    receivedAtMs: 1,
  });
}

function evidence(
  head: ReturnType<typeof createEncryptedWalletBackupV2CurrentHead>,
  bundles: Parameters<typeof enumerateEncryptedWalletBackupV2DescriptorPages>[0]["bundles"],
) {
  return collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles }),
  );
}

function queuedRandom(values: readonly string[]) {
  const queue = values.map(fromHex);
  return (target: Uint8Array): Uint8Array => {
    const next = queue.shift();
    if (next === undefined || next.byteLength !== target.byteLength) throw new Error("test random");
    target.set(next);
    return target;
  };
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_item, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, "0")).join("");
}

function hex(value: number, bytes: number): string {
  return value.toString(16).padStart(2, "0").repeat(bytes);
}
