// @vitest-environment node
import "fake-indexeddb/auto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveDurableCustodyScopeId,
  createEncryptedWalletBackupV2KeyHandle,
  createEncryptedWalletBackupV2CurrentHead,
  collectEncryptedWalletBackupV2DescriptorPages,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  encodeEncryptedWalletBackupV2BundleDescriptor,
  encodeEncryptedWalletBackupV2BundleSupersessionReceipt,
  encodeEncryptedWalletBackupV2UploadGroup,
  decodeEncryptedWalletBackupV2UploadGroup,
  issueEncryptedWalletBackupV2BundleSupersessionReceipt,
  prepareEncryptedWalletBackupV2BundleSupersessionMutation,
  prepareEncryptedWalletBackupV2TransportBundle,
  verifyEncryptedWalletBackupV2BundleSupersessionReceipt,
} from "@bitcaster/client-sdk";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { EncryptedWalletBackupV2DexieAuthorityStore } from "../encrypted-wallet-backup-v2-db";
import { BitcasterDB } from "../proof-db";
import { browserWalletDatabaseName } from "../../lib/browserWalletProfile";

const REALM = "backup.example";
const VAULT_ID = "11".repeat(32);
const REQUEST_AUTH_PUBLIC_KEY = "22".repeat(32);
const openDatabases: BitcasterDB[] = [];
let fixtureSequence = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("encrypted wallet backup V2 Dexie authority store", () => {
  it("rejects an authority profile for a different seed database", () => {
    const { identity } = fixture();
    const database = new BitcasterDB(`foreign-${crypto.randomUUID()}`);
    openDatabases.push(database);
    expect(
      () =>
        new EncryptedWalletBackupV2DexieAuthorityStore({
          database,
          scopeId: identity.scopeId,
          realm: REALM,
          vaultId: VAULT_ID,
          enrollmentEpoch: 1,
          requestAuthPublicKey: REQUEST_AUTH_PUBLIC_KEY,
        }),
    ).toThrow(/authority profile is invalid/);
  });

  it("keeps one exact accepted head and rejects a mismatched canonical mirror", async () => {
    const { store, database } = fixture();
    const head = emptyHead();

    await store.acceptCompetingHead({
      collectedHeadEvidence: collectedEvidence(head, []),
      stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
    });
    await store.acceptCompetingHead({
      collectedHeadEvidence: collectedEvidence(head, []),
      stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
    });

    expect(await database.encryptedWalletBackupV2AcceptedHeads.count()).toBe(1);
    expect((await store.readAcceptedHead())?.headVersion).toBe(0);
    await database.encryptedWalletBackupV2AcceptedHeads.put({
      ...(await database.encryptedWalletBackupV2AcceptedHeads.toCollection().first())!,
      activeSetDigest: "33".repeat(32),
    });
    await expect(store.readAcceptedHead()).rejects.toThrow(/accepted head wire is invalid/);
  });

  it("fails closed for malformed, foreign, and invalid dirty-revision rows", async () => {
    const { store, database, identity } = fixture();
    await database.encryptedWalletBackupV2DirtyRevisions.put({
      scopeId: identity.scopeId,
      revision: -1,
    });
    await expect(store.readDirtyRevision()).rejects.toThrow(/dirty revision row is invalid/);
    await database.encryptedWalletBackupV2DirtyRevisions.put({
      scopeId: identity.scopeId,
      revision: 0,
    });
    await database.encryptedWalletBackupV2PreparedMutations.put({
      scopeId: identity.scopeId,
      realm: REALM,
      vaultId: VAULT_ID,
      enrollmentEpoch: 1,
      mutationId: "66".repeat(16),
      requestDigest: "77".repeat(32),
      localRevision: 0,
      canonicalUploadGroup: Uint8Array.of(0),
      createdAtUnixMilliseconds: 1,
    });
    await expect(store.readPreparedMutation()).rejects.toThrow(/encrypted backup v2/);
  });

  it("adds one prepared mutation idempotently and deletes only its exact authority", async () => {
    const prepared = await preparedFixture();
    const input = {
      mutationId: prepared.envelope.mutation.mutationId,
      requestDigest: prepared.envelope.requestDigest,
      localRevision: 7,
      canonicalUploadGroup: prepared.group,
      createdAtUnixMilliseconds: 1,
    };

    await expect(prepared.store.insertPreparedMutation(input)).resolves.toBe("inserted");
    await expect(prepared.store.insertPreparedMutation(input)).resolves.toBe("existing");
    await expect(
      prepared.store.insertPreparedMutation({ ...input, localRevision: input.localRevision + 1 }),
    ).rejects.toThrow(/prepared mutation conflicts/);
    expect(await prepared.database.encryptedWalletBackupV2PreparedMutations.count()).toBe(1);
    expect((await prepared.store.readPreparedMutation())?.localRevision).toBe(input.localRevision);
    await prepared.store.acceptCompetingHead({
      collectedHeadEvidence: prepared.collectedHeadEvidence,
      stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
    });
    await expect(prepared.store.insertPreparedMutation(input)).rejects.toThrow(/head is stale/);
    expect(await prepared.database.encryptedWalletBackupV2PreparedMutations.count()).toBe(1);
  });

  it("atomically accepts a competing head and deletes only its exact prepared mutation", async () => {
    const prepared = await preparedFixture();
    const preparedInput = {
      mutationId: prepared.envelope.mutation.mutationId,
      requestDigest: prepared.envelope.requestDigest,
      localRevision: 7,
      canonicalUploadGroup: prepared.group,
      createdAtUnixMilliseconds: 1,
    };
    await prepared.store.insertPreparedMutation(preparedInput);

    await expect(
      prepared.store.acceptCompetingHead({
        collectedHeadEvidence: prepared.collectedHeadEvidence,
        stalePreparedMutation: {
          mutationId: preparedInput.mutationId,
          requestDigest: "aa".repeat(32),
        },
      }),
    ).resolves.toEqual({ deletedStalePreparedMutation: false });
    expect(await prepared.store.readPreparedMutation()).not.toBeNull();
    await expect(
      prepared.store.acceptCompetingHead({
        collectedHeadEvidence: prepared.collectedHeadEvidence,
        stalePreparedMutation: {
          mutationId: preparedInput.mutationId,
          requestDigest: preparedInput.requestDigest,
        },
      }),
    ).resolves.toEqual({ deletedStalePreparedMutation: true });
    expect(await prepared.store.readPreparedMutation()).toBeNull();
    expect((await prepared.store.readAcceptedHead())?.headVersion).toBe(1);
    expect((await prepared.store.listActiveDescriptors()).length).toBe(1);
    await expect(
      prepared.store.acceptCompetingHead({
        collectedHeadEvidence: prepared.emptyCollectedHeadEvidence,
        stalePreparedMutation: {
          mutationId: preparedInput.mutationId,
          requestDigest: preparedInput.requestDigest,
        },
      }),
    ).rejects.toThrow(/accepted head is stale/);

    const equalVersionConflict = await preparedFixture(2);
    const before = await prepared.store.readAcceptedHead();
    const beforeDescriptors = await prepared.store.listActiveDescriptors();
    await expect(
      prepared.store.acceptCompetingHead({
        collectedHeadEvidence: equalVersionConflict.collectedHeadEvidence,
        stalePreparedMutation: {
          mutationId: preparedInput.mutationId,
          requestDigest: preparedInput.requestDigest,
        },
      }),
    ).rejects.toThrow(/accepted head conflicts/);
    expect((await prepared.store.readAcceptedHead())?.activeSetDigest).toBe(
      before?.activeSetDigest,
    );
    expect((await prepared.store.listActiveDescriptors())[0]?.bundleId).toBe(
      beforeDescriptors[0]?.bundleId,
    );
  });

  it("atomically commits a verified receipt and rolls back all authority rows on failure", async () => {
    const committed = await preparedFixture();
    const committedInput = preparedInput(committed);
    await committed.store.insertPreparedMutation(committedInput);
    const receipt = await verifiedReceiptFixture(committed);

    await expect(
      committed.store.commitVerifiedReceipt({
        receipt: { ...receipt, acknowledgedLocalRevision: committedInput.localRevision },
        collectedHeadEvidence: committed.collectedHeadEvidence,
        preparedMutation: {
          mutationId: committedInput.mutationId,
          requestDigest: committedInput.requestDigest,
        },
      }),
    ).resolves.toBeUndefined();
    expect(await committed.store.readPreparedMutation()).toBeNull();
    expect(await committed.store.readReceipt()).not.toBeNull();
    expect((await committed.store.readAcceptedHead())?.headVersion).toBe(1);
    expect((await committed.store.listActiveDescriptors()).length).toBe(1);

    const missing = await preparedFixture();
    const missingReceipt = await verifiedReceiptFixture(missing);
    await expect(
      missing.store.commitVerifiedReceipt({
        receipt: { ...missingReceipt, acknowledgedLocalRevision: 7 },
        collectedHeadEvidence: missing.collectedHeadEvidence,
        preparedMutation: {
          mutationId: missing.envelope.mutation.mutationId,
          requestDigest: missing.envelope.requestDigest,
        },
      }),
    ).rejects.toThrow(/prepared mutation is absent/);
    expect(await missing.store.readReceipt()).toBeNull();
    expect((await missing.store.readAcceptedHead())?.headVersion).toBe(0);

    const mismatchedPrepared = await preparedFixture();
    const mismatchedPreparedInput = preparedInput(mismatchedPrepared);
    await mismatchedPrepared.store.insertPreparedMutation(mismatchedPreparedInput);
    const mismatchedPreparedReceipt = await verifiedReceiptFixture(mismatchedPrepared);
    await expect(
      mismatchedPrepared.store.commitVerifiedReceipt({
        receipt: {
          ...mismatchedPreparedReceipt,
          acknowledgedLocalRevision: mismatchedPreparedInput.localRevision,
        },
        collectedHeadEvidence: mismatchedPrepared.collectedHeadEvidence,
        preparedMutation: {
          mutationId: mismatchedPreparedInput.mutationId,
          requestDigest: "aa".repeat(32),
        },
      }),
    ).rejects.toThrow(/prepared receipt binding is invalid/);
    expect(await mismatchedPrepared.store.readPreparedMutation()).not.toBeNull();
    expect(await mismatchedPrepared.store.readReceipt()).toBeNull();

    const mismatchedHead = await preparedFixture();
    const mismatchedInput = preparedInput(mismatchedHead);
    await mismatchedHead.store.insertPreparedMutation(mismatchedInput);
    const mismatchedReceipt = await verifiedReceiptFixture(mismatchedHead);
    await expect(
      mismatchedHead.store.commitVerifiedReceipt({
        receipt: { ...mismatchedReceipt, acknowledgedLocalRevision: mismatchedInput.localRevision },
        collectedHeadEvidence: mismatchedHead.emptyCollectedHeadEvidence,
        preparedMutation: {
          mutationId: mismatchedInput.mutationId,
          requestDigest: mismatchedInput.requestDigest,
        },
      }),
    ).rejects.toThrow(/receipt result head is invalid/);
    expect(await mismatchedHead.store.readPreparedMutation()).not.toBeNull();
    expect(await mismatchedHead.store.readReceipt()).toBeNull();

    const rolledBack = await preparedFixture();
    const rollbackInput = preparedInput(rolledBack);
    await rolledBack.store.insertPreparedMutation(rollbackInput);
    const rollbackReceipt = await verifiedReceiptFixture(rolledBack);
    vi.spyOn(
      rolledBack.database.encryptedWalletBackupV2ActiveDescriptors,
      "bulkAdd",
    ).mockRejectedValueOnce(new Error("quota exceeded"));
    await expect(
      rolledBack.store.commitVerifiedReceipt({
        receipt: { ...rollbackReceipt, acknowledgedLocalRevision: rollbackInput.localRevision },
        collectedHeadEvidence: rolledBack.collectedHeadEvidence,
        preparedMutation: {
          mutationId: rollbackInput.mutationId,
          requestDigest: rollbackInput.requestDigest,
        },
      }),
    ).rejects.toThrow(/quota exceeded/);
    expect(await rolledBack.store.readPreparedMutation()).not.toBeNull();
    expect(await rolledBack.store.readReceipt()).toBeNull();
    expect((await rolledBack.store.readAcceptedHead())?.headVersion).toBe(0);
    expect((await rolledBack.store.listActiveDescriptors()).length).toBe(0);
  });

  it("rolls back a delayed stale receipt and retains its defensive prepared row", async () => {
    const older = await preparedFixture();
    const olderInput = preparedInput(older);
    await older.store.insertPreparedMutation(olderInput);
    const olderReceipt = await verifiedReceiptFixture(older);
    await older.store.commitVerifiedReceipt({
      receipt: { ...olderReceipt, acknowledgedLocalRevision: olderInput.localRevision },
      collectedHeadEvidence: older.collectedHeadEvidence,
      preparedMutation: {
        mutationId: olderInput.mutationId,
        requestDigest: olderInput.requestDigest,
      },
    });

    const newer = await nextPreparedFixture(older);
    const newerInput = preparedInput(newer);
    await older.store.insertPreparedMutation(newerInput);
    const newerReceipt = await verifiedReceiptFixture(newer);
    await older.store.commitVerifiedReceipt({
      receipt: { ...newerReceipt, acknowledgedLocalRevision: newerInput.localRevision },
      collectedHeadEvidence: newer.collectedHeadEvidence,
      preparedMutation: {
        mutationId: newerInput.mutationId,
        requestDigest: newerInput.requestDigest,
      },
    });
    const beforeHead = await older.store.readAcceptedHead();
    const beforeReceipt = await older.store.readReceipt();
    const beforeDescriptors = await older.store.listActiveDescriptors();
    await older.database.encryptedWalletBackupV2PreparedMutations.put({
      scopeId: older.scopeId,
      realm: REALM,
      vaultId: older.keyHandle.vaultId,
      enrollmentEpoch: 1,
      ...olderInput,
    });

    await expect(
      older.store.commitVerifiedReceipt({
        receipt: { ...olderReceipt, acknowledgedLocalRevision: olderInput.localRevision },
        collectedHeadEvidence: older.collectedHeadEvidence,
        preparedMutation: {
          mutationId: olderInput.mutationId,
          requestDigest: olderInput.requestDigest,
        },
      }),
    ).rejects.toThrow(/accepted head is stale/);
    expect((await older.store.readAcceptedHead())?.activeSetDigest).toBe(
      beforeHead?.activeSetDigest,
    );
    expect((await older.store.readReceipt())?.requestDigest).toBe(beforeReceipt?.requestDigest);
    expect((await older.store.listActiveDescriptors()).length).toBe(beforeDescriptors.length);
    expect((await older.store.readPreparedMutation())?.mutationId).toBe(olderInput.mutationId);
  });
});

function fixture() {
  const identity = {
    scopeKind: "wallet" as const,
    walletId: "88".repeat(32),
  };
  const scopeId = deriveDurableCustodyScopeId(identity);
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  openDatabases.push(database);
  return {
    database,
    scopeId,
    identity: { ...identity, scopeId },
    store: new EncryptedWalletBackupV2DexieAuthorityStore({
      database,
      scopeId,
      realm: REALM,
      vaultId: VAULT_ID,
      enrollmentEpoch: 1,
      requestAuthPublicKey: REQUEST_AUTH_PUBLIC_KEY,
    }),
  };
}

async function nextPreparedFixture(previous: Awaited<ReturnType<typeof preparedFixture>>) {
  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle: previous.keyHandle,
    asset: { mintUrl: "https://mint.example", unit: "sat", assetIdentity: "cashu:newer" },
    declaredAmount: 1n,
    custodyRevision: 2n,
    canonicalPayload: encodeCanonicalBackupCbor(["newer"]),
    runtime: {
      subtle: crypto.subtle,
      getRandomValues: queuedRandom([hex(10, 16), hex(11, 12)]),
    },
  });
  const envelope = await prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle: previous.keyHandle,
    expectedHeadEvidence: previous.collectedHeadEvidence,
    addedBundle: prepared.descriptor,
    supersededBundleIds: [],
    runtime: { getRandomValues: queuedRandom([hex(12, 16), hex(13, 32)]) },
  });
  const resultHead = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: previous.keyHandle.vaultId,
    enrollmentEpoch: 1,
    headVersion: 2,
    bundles: [previous.prepared.descriptor, prepared.descriptor],
  });
  return {
    ...previous,
    prepared,
    envelope,
    resultHead,
    collectedHeadEvidence: collectedEvidence(resultHead, [
      previous.prepared.descriptor,
      prepared.descriptor,
    ]),
    group: encodeEncryptedWalletBackupV2UploadGroup({ envelope, objects: prepared.objects }),
  };
}

function emptyHead() {
  return createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: VAULT_ID,
    enrollmentEpoch: 1,
    headVersion: 0,
    bundles: [],
  });
}

function preparedInput(prepared: Awaited<ReturnType<typeof preparedFixture>>) {
  return {
    mutationId: prepared.envelope.mutation.mutationId,
    requestDigest: prepared.envelope.requestDigest,
    localRevision: 7,
    canonicalUploadGroup: prepared.group,
    createdAtUnixMilliseconds: 1,
  };
}

async function verifiedReceiptFixture(prepared: Awaited<ReturnType<typeof preparedFixture>>) {
  const mutationEvidence = decodeEncryptedWalletBackupV2UploadGroup({
    bytes: prepared.group,
    expectedRequestAuthPublicKey: prepared.keyHandle.requestAuthPublicKey,
    expectedContext: { realm: REALM, vaultId: prepared.keyHandle.vaultId, enrollmentEpoch: 1 },
  }).mutationEvidence;
  const receipt = await issueEncryptedWalletBackupV2BundleSupersessionReceipt({
    mutationEvidence,
    resultHead: prepared.resultHead,
    signingKeyId: "55".repeat(16),
    signingPublicKey: toHex(schnorr.getPublicKey(fromHex("03".repeat(32)))),
    signDigest: (digest) => schnorr.sign(digest, fromHex("03".repeat(32))),
  });
  return {
    canonicalSignedReceipt: encodeEncryptedWalletBackupV2BundleSupersessionReceipt(receipt),
    verifiedReceipt: verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
      receipt,
      mutationEvidence,
      pinnedSigningKeys: [
        {
          keyId: "55".repeat(16),
          publicKey: toHex(schnorr.getPublicKey(fromHex("03".repeat(32)))),
        },
      ],
    }),
  };
}

async function preparedFixture(variant = 1) {
  fixtureSequence += 1;
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: new Uint8Array(64).fill(9),
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: fixtureSequence.toString(16).padStart(64, "9"),
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  openDatabases.push(database);
  const store = new EncryptedWalletBackupV2DexieAuthorityStore({
    database,
    scopeId,
    realm: REALM,
    vaultId: keyHandle.vaultId,
    enrollmentEpoch: 1,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
  });
  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset: { mintUrl: "https://mint.example", unit: "sat", assetIdentity: "cashu:ordinary" },
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: encodeCanonicalBackupCbor(["test"]),
    runtime: {
      subtle: crypto.subtle,
      getRandomValues: queuedRandom([hex(variant, 16), hex(variant + 1, 12)]),
    },
  });
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: keyHandle.vaultId,
    enrollmentEpoch: 1,
    headVersion: 0,
    bundles: [],
  });
  await store.acceptCompetingHead({
    collectedHeadEvidence: collectedEvidence(head, []),
    stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
  });
  const envelope = await prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle,
    expectedHeadEvidence: collectedEvidence(head, []),
    addedBundle: prepared.descriptor,
    supersededBundleIds: [],
    runtime: { getRandomValues: queuedRandom([hex(variant + 2, 16), hex(variant + 3, 32)]) },
  });
  const resultHead = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: keyHandle.vaultId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [prepared.descriptor],
  });
  return {
    store,
    database,
    scopeId,
    keyHandle,
    prepared,
    envelope,
    canonicalDescriptor: encodeEncryptedWalletBackupV2BundleDescriptor(prepared.descriptor),
    resultHead,
    emptyCollectedHeadEvidence: collectedEvidence(head, []),
    collectedHeadEvidence: collectedEvidence(resultHead, [prepared.descriptor]),
    group: encodeEncryptedWalletBackupV2UploadGroup({ envelope, objects: prepared.objects }),
  };
}

function collectedEvidence(
  head: ReturnType<typeof createEncryptedWalletBackupV2CurrentHead>,
  bundles: Parameters<typeof enumerateEncryptedWalletBackupV2DescriptorPages>[0]["bundles"],
) {
  return collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles }),
  );
}

function queuedRandom(values: readonly string[]): (target: Uint8Array) => Uint8Array {
  const queue = values.map(fromHex);
  return (target) => {
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
