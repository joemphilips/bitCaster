// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { browserWalletDatabaseName } from "../../lib/browserWalletProfile";
import { createBrowserCustodyProofRow } from "../durable-custody-db";
import { decodeBrowserCustodyProofRow } from "../durable-custody-types";
import {
  advanceBrowserV2DesiredAssetsForCounter,
  advanceBrowserV2DesiredAssetsForProofChanges,
  createEncryptedWalletBackupV2DesiredAssetRow,
  createEncryptedWalletBackupV2RemovalIntent,
  decodeEncryptedWalletBackupV2DesiredAssetRow,
  decodeEncryptedWalletBackupV2RemovalIntent,
  digestEncryptedWalletBackupV2RemovalProofSet,
  sameEncryptedWalletBackupV2RemovalIntent,
} from "../browser-encrypted-wallet-backup-v2-desired-asset";
import { createEncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import {
  classifyBrowserProofBackupAuthorityVerifiedLosing,
  createBrowserRemoteProofBackupAuthorityRow,
  createBrowserProofBackupAuthorityRow,
} from "../browser-proof-backup-authority";
import { BitcasterDB } from "../proof-db";

const MINT = "https://mint.example";
const KEYSET = `01${"33".repeat(32)}`;
const PUBLIC_KEY = `02${"22".repeat(32)}`;
let database: BitcasterDB | null = null;

afterEach(async () => {
  database?.close();
  if (database) await database.delete();
  database = null;
});

describe("browser V2 desired asset eligibility", () => {
  it("retains locator-backed verified-losing proof material in the current asset", async () => {
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: "72".repeat(32),
    });
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const active = createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: { id: KEYSET, amount: 1 as never, secret: "22".repeat(32), C: PUBLIC_KEY },
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    const locator = {
      schemaVersion: 1 as const,
      kind: "nut13" as const,
      keysetId: KEYSET,
      counter: 1,
    };
    const losing = {
      ...active,
      assetKind: "conditional" as const,
      conditionId: "aa".repeat(32),
      outcomeCollection: "YES",
      selectability: "verified-losing" as const,
      revision: 1,
    };
    // The test supplies the exact conditional keyset fact required by the desired-asset reducer.
    await database.custodyConditionalKeysets.put({
      schemaVersion: 1,
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: KEYSET,
      denominationPublicKeys: { "1": PUBLIC_KEY },
      inputFeePpk: 0,
      conditionId: "aa".repeat(32),
      outcomeCollection: "YES",
      outcomeCollectionId: "bb".repeat(32),
      registeredAtUnixSeconds: 1,
      finalExpiryUnixSeconds: 2,
      curve: "secp256k1",
    });
    await advanceBrowserV2DesiredAssetsForProofChanges(database, scopeId, [
      {
        beforeProof: null,
        beforeLocator: null,
        afterProof: losing,
        afterLocator: locator,
        payloadChanged: true,
      },
    ]);
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      {
        custodyRevision: "1",
        activeProofCount: 1,
        desiredAction: "replace",
        terminalCtfContext: {
          conditionId: "aa".repeat(32),
          outcomeLabel: "YES",
          outcomeCollectionId: "bb".repeat(32),
          registeredAt: 1,
          finalExpiry: 2,
        },
      },
    ]);
    const locked = {
      ...losing,
      selectability: "locked" as const,
      reservationOperationId: "redeem",
      revision: 0,
    };
    await database.custodyProofs.put(losing);
    await database.custodyProofBackupAuthorities.put(
      classifyBrowserProofBackupAuthorityVerifiedLosing(
        createBrowserProofBackupAuthorityRow(locked, 1, locator, "admission"),
        losing,
        "redeem",
        2,
      ),
    );
    await advanceBrowserV2DesiredAssetsForCounter({
      database,
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: KEYSET,
    });
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      {
        custodyRevision: "2",
        activeProofCount: 1,
        desiredAction: "replace",
        terminalCtfContext: {
          conditionId: "aa".repeat(32),
          outcomeLabel: "YES",
          outcomeCollectionId: "bb".repeat(32),
          registeredAt: 1,
          finalExpiry: 2,
        },
      },
    ]);
  });
  it("tracks only active proofs with a deterministic locator", async () => {
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: "71".repeat(32),
    });
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const proof = createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: { id: KEYSET, amount: 1 as never, secret: "11".repeat(32), C: PUBLIC_KEY },
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    const locked = {
      ...proof,
      selectability: "locked" as const,
      reservationOperationId: "order:1",
    };
    const locator = {
      schemaVersion: 1 as const,
      kind: "nut13" as const,
      keysetId: KEYSET,
      counter: 1,
    };

    await advanceBrowserV2DesiredAssetsForProofChanges(database, scopeId, [
      {
        beforeProof: null,
        beforeLocator: null,
        afterProof: locked,
        afterLocator: null,
        payloadChanged: true,
      },
    ]);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);

    await advanceBrowserV2DesiredAssetsForProofChanges(database, scopeId, [
      {
        beforeProof: locked,
        beforeLocator: null,
        afterProof: locked,
        afterLocator: locator,
        payloadChanged: true,
      },
    ]);
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      { custodyRevision: "1", activeProofCount: 1, desiredAction: "replace" },
    ]);

    await advanceBrowserV2DesiredAssetsForProofChanges(database, scopeId, [
      {
        beforeProof: locked,
        beforeLocator: locator,
        afterProof: locked,
        afterLocator: null,
        payloadChanged: true,
      },
    ]);
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      { custodyRevision: "2", activeProofCount: 0, desiredAction: "remove" },
    ]);
  });
});

describe("browser V2 explicit removal foundation", () => {
  const removalProofs = [
    {
      proofId: "11".repeat(32),
      proofFingerprint: "22".repeat(32),
      proofRevision: 4,
      proofCommitment: "33".repeat(32),
    },
    {
      proofId: "44".repeat(32),
      proofFingerprint: "55".repeat(32),
      proofRevision: 9,
      proofCommitment: "66".repeat(32),
    },
  ] as const;

  it("round-trips an exact ordered proof set and its exclusion evidence", () => {
    const intent = createEncryptedWalletBackupV2RemovalIntent({
      intentId: "remove-intent-1",
      createdAtMs: 10,
      realm: "development",
      walletId: "77".repeat(32),
      enrollmentEpoch: 2,
      expectedHeadVersion: 8,
      expectedActiveSetDigest: "88".repeat(32),
      targetCustodyRevision: 12n,
      proofs: removalProofs,
    });
    expect(decodeEncryptedWalletBackupV2RemovalIntent(intent)).toStrictEqual(intent);
    expect(digestEncryptedWalletBackupV2RemovalProofSet(removalProofs)).toBe(
      "7beda456d9ee7e50b22a10eaa644a3d2ce86186a2c71e4bac76b7fc0885dd074",
    );
    expect(
      digestEncryptedWalletBackupV2RemovalProofSet([
        removalProofs[0],
        { ...removalProofs[1], proofCommitment: "67".repeat(32) },
      ]),
    ).not.toBe("7beda456d9ee7e50b22a10eaa644a3d2ce86186a2c71e4bac76b7fc0885dd074");
    const evidence = {
      kind: "receipt",
      headVersion: 9,
      activeSetDigest: "99".repeat(32),
      receiptDigest: "aa".repeat(32),
      bundleId: null,
      bundleDescriptorDigest: null,
      supersededBundleIds: ["bb".repeat(16)],
      acknowledgedAtMs: 20,
    } as const;
    const acknowledged = createEncryptedWalletBackupV2RemovalIntent({
      ...intent,
      state: "exclusion-acknowledged",
      acknowledgedExclusionEvidence: evidence,
    });
    expect(sameEncryptedWalletBackupV2RemovalIntent(acknowledged, acknowledged)).toBe(true);
    expect(sameEncryptedWalletBackupV2RemovalIntent(intent, acknowledged)).toBe(false);

    const currentHead = createEncryptedWalletBackupV2RemovalIntent({
      ...intent,
      state: "exclusion-acknowledged",
      acknowledgedExclusionEvidence: {
        kind: "current-head",
        headVersion: 9,
        activeSetDigest: "99".repeat(32),
        bundleId: null,
        bundleDescriptorDigest: null,
        acknowledgedAtMs: 20,
      },
    });
    expect(decodeEncryptedWalletBackupV2RemovalIntent(currentHead)).toStrictEqual(currentHead);
    expect(() =>
      decodeEncryptedWalletBackupV2RemovalIntent({
        ...currentHead,
        acknowledgedExclusionEvidence: {
          ...currentHead.acknowledgedExclusionEvidence!,
          receiptDigest: "aa".repeat(32),
        },
      }),
    ).toThrow(/exclusion evidence is invalid/);
    expect(() =>
      decodeEncryptedWalletBackupV2RemovalIntent({
        ...currentHead,
        acknowledgedExclusionEvidence: {
          ...currentHead.acknowledgedExclusionEvidence!,
          bundleId: "bb".repeat(16),
        },
      }),
    ).toThrow(/exclusion evidence is invalid/);
  });

  it("binds the removal intent target revision to the desired row revision", () => {
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: "78".repeat(32),
    });
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: MINT,
      unit: "msat",
      asset: {
        kind: "ctf",
        conditionId: "aa".repeat(32),
        outcomeLabel: "YES",
        outcomeCollectionId: "bb".repeat(32),
        registeredAt: 1,
        finalExpiry: 2,
      },
    });
    const intent = createEncryptedWalletBackupV2RemovalIntent({
      intentId: "remove-intent-revision",
      createdAtMs: 10,
      realm: "development",
      walletId: "78".repeat(32),
      enrollmentEpoch: 2,
      expectedHeadVersion: 8,
      expectedActiveSetDigest: "88".repeat(32),
      targetCustodyRevision: 12n,
      proofs: removalProofs,
    });
    const row = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId,
      asset,
      custodyRevision: 12n,
      activeProofCount: 1,
      removalIntent: intent,
    });
    expect(() =>
      decodeEncryptedWalletBackupV2DesiredAssetRow({ ...row, custodyRevision: "13" }),
    ).toThrow(/target revision is stale/);
    expect(() =>
      decodeEncryptedWalletBackupV2DesiredAssetRow({
        ...row,
        scopeId: deriveDurableCustodyScopeId({
          scopeKind: "wallet",
          walletId: "79".repeat(32),
        }),
      }),
    ).toThrow(/wallet scope is foreign/);
  });

  it("rejects unordered tuples, duplicate tuples, and a forged set commitment", () => {
    const intent = createEncryptedWalletBackupV2RemovalIntent({
      intentId: "remove-intent-2",
      createdAtMs: 10,
      realm: "development",
      walletId: "77".repeat(32),
      enrollmentEpoch: 2,
      expectedHeadVersion: 8,
      expectedActiveSetDigest: "88".repeat(32),
      targetCustodyRevision: 12n,
      proofs: removalProofs,
    });
    expect(() =>
      decodeEncryptedWalletBackupV2RemovalIntent({
        ...intent,
        proofs: [...removalProofs].reverse(),
      }),
    ).toThrow(/unordered or duplicated/);
    expect(() =>
      decodeEncryptedWalletBackupV2RemovalIntent({
        ...intent,
        proofs: [removalProofs[0], removalProofs[0]],
      }),
    ).toThrow(/unordered or duplicated/);
    expect(() =>
      decodeEncryptedWalletBackupV2RemovalIntent({
        ...intent,
        proofSetCommitment: "dd".repeat(32),
      }),
    ).toThrow(/proof set commitment is invalid/);
    expect(() =>
      decodeEncryptedWalletBackupV2RemovalIntent({ ...intent, enrollmentEpoch: 0 }),
    ).toThrow(/enrollment epoch is invalid/);
  });

  it("allows pending-removal only for an unreserved conditional proof", () => {
    const regular = createBrowserCustodyProofRow({
      scopeId: deriveDurableCustodyScopeId({
        scopeKind: "wallet",
        walletId: "77".repeat(32),
      }),
      normalizedMint: MINT,
      unit: "sat",
      proof: { id: KEYSET, amount: 1 as never, secret: "31".repeat(32), C: PUBLIC_KEY },
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    expect(() =>
      decodeBrowserCustodyProofRow({
        ...regular,
        selectability: "pending-removal",
      }),
    ).toThrow(/browser custody proof row is invalid/);
    const conditional = createBrowserCustodyProofRow({
      scopeId: regular.scopeId,
      normalizedMint: regular.normalizedMint,
      unit: "msat",
      proof: { id: KEYSET, amount: 1 as never, secret: "32".repeat(32), C: PUBLIC_KEY },
      asset: { kind: "conditional", conditionId: "aa".repeat(32), outcomeCollection: "YES" },
      receivedAtMs: regular.receivedAtMs,
    });
    expect(
      decodeBrowserCustodyProofRow({
        ...conditional,
        selectability: "pending-removal",
        reservationOperationId: null,
      }).selectability,
    ).toBe("pending-removal");
    expect(() =>
      decodeBrowserCustodyProofRow({
        ...conditional,
        selectability: "pending-removal",
        reservationOperationId: "reserved",
      }),
    ).toThrow(/browser custody proof row is invalid/);
  });
});

describe("browser V2 desired asset terminal CTF context", () => {
  const ctfAsset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: "aa".repeat(32),
      outcomeLabel: "YES",
      outcomeCollectionId: "bb".repeat(32),
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  const ctfContext = {
    conditionId: "aa".repeat(32),
    outcomeLabel: "YES",
    outcomeCollectionId: "bb".repeat(32),
    registeredAt: 1,
    finalExpiry: 2,
  } as const;

  it("requires the terminal CTF context field and checks its asset identity", () => {
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: "75".repeat(32),
    });
    const ordinary = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId,
      asset: createEncryptedWalletBackupV2AssetIdentity({
        mintUrl: MINT,
        unit: "msat",
        asset: { kind: "ordinary" },
      }),
      custodyRevision: 1n,
      activeProofCount: 0,
    });
    const { terminalCtfContext: _missing, ...withoutContext } = ordinary;
    expect(() => decodeEncryptedWalletBackupV2DesiredAssetRow(withoutContext)).toThrow(
      /desired asset row is invalid/,
    );

    const ctf = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId,
      asset: ctfAsset,
      terminalCtfContext: ctfContext,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    expect(() =>
      decodeEncryptedWalletBackupV2DesiredAssetRow({
        ...ctf,
        terminalCtfContext: { ...ctfContext, conditionId: "cc".repeat(32) },
      }),
    ).toThrow(/CTF context is foreign/);
  });

  it("rejects a full-tuple mismatch on a same-asset proof update", async () => {
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: "73".repeat(32),
    });
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const proof = createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: { id: KEYSET, amount: 1 as never, secret: "23".repeat(32), C: PUBLIC_KEY },
      asset: { kind: "conditional", conditionId: "aa".repeat(32), outcomeCollection: "YES" },
      receivedAtMs: 1,
    });
    const locator = {
      schemaVersion: 1 as const,
      kind: "nut13" as const,
      keysetId: KEYSET,
      counter: 1,
    };
    const keyset = {
      schemaVersion: 1 as const,
      scopeId,
      normalizedMint: MINT,
      unit: "msat" as const,
      keysetId: KEYSET,
      denominationPublicKeys: { "1": PUBLIC_KEY },
      inputFeePpk: 0,
      conditionId: "aa".repeat(32),
      outcomeCollection: "YES",
      outcomeCollectionId: "bb".repeat(32),
      registeredAtUnixSeconds: 1,
      finalExpiryUnixSeconds: 2,
      curve: "secp256k1" as const,
    };
    await database.custodyConditionalKeysets.put(keyset);
    await advanceBrowserV2DesiredAssetsForProofChanges(database, scopeId, [
      {
        beforeProof: null,
        beforeLocator: null,
        afterProof: proof,
        afterLocator: locator,
        payloadChanged: true,
      },
    ]);
    await database.custodyConditionalKeysets.put({
      ...keyset,
      registeredAtUnixSeconds: 3,
      finalExpiryUnixSeconds: 4,
    });
    await expect(
      advanceBrowserV2DesiredAssetsForProofChanges(database, scopeId, [
        {
          beforeProof: proof,
          beforeLocator: locator,
          afterProof: proof,
          afterLocator: locator,
          payloadChanged: true,
        },
      ]),
    ).rejects.toThrow(/CTF context conflicts/);
  });

  it("fails closed when a conditional proof has no verified local keyset", async () => {
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: "74".repeat(32),
    });
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const proof = createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: { id: KEYSET, amount: 1 as never, secret: "24".repeat(32), C: PUBLIC_KEY },
      asset: { kind: "conditional", conditionId: "aa".repeat(32), outcomeCollection: "YES" },
      receivedAtMs: 1,
    });
    await expect(
      advanceBrowserV2DesiredAssetsForProofChanges(database, scopeId, [
        {
          beforeProof: null,
          beforeLocator: {
            schemaVersion: 1,
            kind: "nut13",
            keysetId: KEYSET,
            counter: 1,
          },
          afterProof: proof,
          afterLocator: {
            schemaVersion: 1,
            kind: "nut13",
            keysetId: KEYSET,
            counter: 1,
          },
          payloadChanged: true,
        },
      ]),
    ).rejects.toThrow(/conditional authority is missing/);

    const locked = {
      ...proof,
      selectability: "locked" as const,
      reservationOperationId: "operation:locked",
    };
    await expect(
      advanceBrowserV2DesiredAssetsForProofChanges(database, scopeId, [
        {
          beforeProof: null,
          beforeLocator: null,
          afterProof: locked,
          afterLocator: {
            schemaVersion: 1,
            kind: "nut13",
            keysetId: KEYSET,
            counter: 1,
          },
          payloadChanged: true,
        },
      ]),
    ).rejects.toThrow(/conditional authority is missing/);
  });

  it("uses an authenticated remote terminal context without a keyset", async () => {
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: "76".repeat(32),
    });
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const conditionId = "aa".repeat(32);
    const outcomeLabel = "YES";
    const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
      conditionId,
      outcomeCollection: outcomeLabel,
    });
    const proof = {
      ...createBrowserCustodyProofRow({
        scopeId,
        normalizedMint: MINT,
        unit: "msat",
        proof: { id: KEYSET, amount: 1 as never, secret: "26".repeat(32), C: PUBLIC_KEY },
        asset: { kind: "conditional", conditionId, outcomeCollection: outcomeLabel },
        receivedAtMs: 1,
      }),
      selectability: "verified-losing" as const,
    };
    const locator = {
      schemaVersion: 1 as const,
      kind: "nut13" as const,
      keysetId: KEYSET,
      counter: 1,
    };
    await database.custodyProofs.put(proof);
    await database.custodyProofBackupAuthorities.put(
      createBrowserRemoteProofBackupAuthorityRow({
        proof,
        observedAtMs: 1,
        derivationLocator: locator,
        restoreProofId: proof.proofId,
        restoreProofCommitment: "aa".repeat(32),
      }),
    );
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: MINT,
      unit: "msat",
      asset: {
        kind: "ctf",
        conditionId,
        outcomeLabel,
        outcomeCollectionId,
        registeredAt: 1,
        finalExpiry: 2,
      },
    });
    const context = {
      conditionId,
      outcomeLabel,
      outcomeCollectionId,
      registeredAt: 1,
      finalExpiry: 2,
    } as const;
    await database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId,
        asset,
        terminalCtfContext: context,
        custodyRevision: 1n,
        activeProofCount: 1,
      }),
    );

    await advanceBrowserV2DesiredAssetsForProofChanges(database, scopeId, [
      {
        beforeProof: proof,
        beforeLocator: locator,
        afterProof: proof,
        afterLocator: locator,
        payloadChanged: true,
      },
    ]);
    await advanceBrowserV2DesiredAssetsForCounter({
      database,
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: KEYSET,
    });
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      {
        custodyRevision: "3",
        activeProofCount: 1,
        terminalCtfContext: context,
      },
    ]);
  });

  it("rejects a foreign remote authority or terminal context without a keyset", async () => {
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: "77".repeat(32),
    });
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const conditionId = "aa".repeat(32);
    const outcomeLabel = "YES";
    const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
      conditionId,
      outcomeCollection: outcomeLabel,
    });
    const proof = {
      ...createBrowserCustodyProofRow({
        scopeId,
        normalizedMint: MINT,
        unit: "msat",
        proof: { id: KEYSET, amount: 1 as never, secret: "27".repeat(32), C: PUBLIC_KEY },
        asset: { kind: "conditional", conditionId, outcomeCollection: outcomeLabel },
        receivedAtMs: 1,
      }),
      selectability: "verified-losing" as const,
    };
    const foreignProof = {
      ...createBrowserCustodyProofRow({
        scopeId,
        normalizedMint: MINT,
        unit: "msat",
        proof: { id: KEYSET, amount: 1 as never, secret: "28".repeat(32), C: PUBLIC_KEY },
        asset: { kind: "conditional", conditionId, outcomeCollection: outcomeLabel },
        receivedAtMs: 1,
      }),
      selectability: "verified-losing" as const,
    };
    const locator = {
      schemaVersion: 1 as const,
      kind: "nut13" as const,
      keysetId: KEYSET,
      counter: 1,
    };
    await database.custodyProofs.put(proof);
    const foreignAuthority = createBrowserRemoteProofBackupAuthorityRow({
      proof: foreignProof,
      observedAtMs: 1,
      derivationLocator: locator,
      restoreProofId: foreignProof.proofId,
      restoreProofCommitment: "bb".repeat(32),
    });
    await database.custodyProofBackupAuthorities.put({
      ...foreignAuthority,
      proofId: proof.proofId,
      backupRecordId: proof.proofId,
    });
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: MINT,
      unit: "msat",
      asset: {
        kind: "ctf",
        conditionId,
        outcomeLabel,
        outcomeCollectionId,
        registeredAt: 1,
        finalExpiry: 2,
      },
    });
    await database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId,
        asset,
        terminalCtfContext: {
          conditionId,
          outcomeLabel,
          outcomeCollectionId,
          registeredAt: 1,
          finalExpiry: 2,
        },
        custodyRevision: 1n,
        activeProofCount: 1,
      }),
    );
    await expect(
      advanceBrowserV2DesiredAssetsForCounter({
        database,
        scopeId,
        normalizedMint: MINT,
        unit: "msat",
        keysetId: KEYSET,
      }),
    ).rejects.toThrow(/backup authority is foreign/);

    await database.custodyProofBackupAuthorities.put(
      createBrowserRemoteProofBackupAuthorityRow({
        proof,
        observedAtMs: 1,
        derivationLocator: locator,
        restoreProofId: proof.proofId,
        restoreProofCommitment: "cc".repeat(32),
      }),
    );
    await database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId,
        asset,
        custodyRevision: 1n,
        activeProofCount: 1,
      }),
    );
    await expect(
      advanceBrowserV2DesiredAssetsForCounter({
        database,
        scopeId,
        normalizedMint: MINT,
        unit: "msat",
        keysetId: KEYSET,
      }),
    ).rejects.toThrow(/terminal context is missing/);
    await database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId,
        asset,
        terminalCtfContext: {
          conditionId,
          outcomeLabel: "NO",
          outcomeCollectionId,
          registeredAt: 1,
          finalExpiry: 2,
        },
        custodyRevision: 1n,
        activeProofCount: 1,
      }),
    );
    await expect(
      advanceBrowserV2DesiredAssetsForCounter({
        database,
        scopeId,
        normalizedMint: MINT,
        unit: "msat",
        keysetId: KEYSET,
      }),
    ).rejects.toThrow(/terminal context is foreign/);
  });
});
