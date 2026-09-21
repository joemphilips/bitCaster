// @vitest-environment node
import "fake-indexeddb/auto";
import {
  Amount,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  hashToCurve,
  Keyset,
  OutputData,
  pointFromHex,
  type Wallet as CashuWallet,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/curves/utils.js";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2CurrentHead,
  createEncryptedWalletBackupV2KeyHandle,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  issueEncryptedWalletBackupV2TerminalSeal,
  prepareEncryptedWalletBackupV2ProofSetBundle,
  requireEncryptedWalletBackupV2CollectedHeadEvidence,
  deriveRootCtfOutcomeCollectionId,
  type EncryptedWalletBackupV2RemotePort,
} from "@bitcaster/client-sdk";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { afterEach, expect, it, vi } from "vitest";
import { BitcasterDB, storedProofFromCustodyRow } from "../../stores/proof-db";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import {
  advanceBrowserProofBackupAuthorityRowToPendingRemoval,
  classifyBrowserProofBackupAuthorityVerifiedLosing,
  createBrowserProofBackupAuthorityRow,
} from "../../stores/browser-proof-backup-authority";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../../stores/durable-custody-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import { commitBrowserCtfTerminalOperation } from "../../test/browserEncryptedWalletBackupV2CommittedTerminalFixture";
import {
  readBrowserEncryptedWalletBackupV2LocalAvailableAmount,
  restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset,
  restoreBrowserEncryptedWalletBackupV2TargetedAsset,
} from "../browserEncryptedWalletBackupV2Restore";

const SEED = new Uint8Array(64).fill(7);
const KEYSET = `01${"22".repeat(32)}`;
const CTF_CONDITION_ID = "aa".repeat(32);
const CTF_OUTCOME = "YES";
const CTF_OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CTF_CONDITION_ID,
  outcomeCollection: CTF_OUTCOME,
});
const CTF_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 1 : 0));
const CTF_PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const CTF_KEYSET = deriveConditionalKeysetId({
  keys: { "1": CTF_PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 100,
  final_expiry: 100,
  conditionId: CTF_CONDITION_ID,
  outcomeCollectionId: CTF_OUTCOME_COLLECTION_ID,
});
const openDatabases: BitcasterDB[] = [];
let fixtureSequence = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

it("restores one current bundle with fresh sequential object proofs", async () => {
  const fixture = await backupFixture();
  const result = await restoreBrowserEncryptedWalletBackupV2TargetedAsset(fixture.input);
  expect(result).toMatchObject({
    kind: "backup",
    assetLocator: fixture.bundle.descriptor.assetLocator,
    bundleId: fixture.bundle.descriptor.bundleId,
    custodyRevision: 1n,
    headVersion: 1,
  });
  if (result.kind !== "backup") throw new Error("test backup result is missing");
  const head = requireEncryptedWalletBackupV2CollectedHeadEvidence(result.collectedHeadEvidence);
  expect(head.head.headVersion).toBe(1);
  expect(head.bundles.map(({ bundleId }) => bundleId)).toEqual([
    fixture.bundle.descriptor.bundleId,
  ]);
  expect(fixture.remote.readObject).toHaveBeenCalledTimes(fixture.bundle.descriptor.objects.length);
  expect(fixture.remote.readObject.mock.calls.map(([call]) => call.objectId)).toEqual(
    fixture.bundle.descriptor.objects.map(({ objectId }) => objectId),
  );
  const proofs = [
    ...fixture.remote.readDescriptorPage.mock.calls.map(([call]) => call.requestProof.replayNonce),
    ...fixture.remote.readObject.mock.calls.map(([call]) => call.requestProof.replayNonce),
  ];
  expect(new Set(proofs).size).toBe(proofs.length);
});

it("rejects sat before backup network or local admission I/O", async () => {
  const fixture = await backupFixture();
  const satAsset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: fixture.input.asset.mintUrl,
    unit: "sat",
    asset: { kind: "ordinary" },
  });

  await expect(
    restoreBrowserEncryptedWalletBackupV2TargetedAsset({
      ...fixture.input,
      asset: satAsset,
    }),
  ).rejects.toThrow(/requires msat/);
  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...fixture.input,
      asset: satAsset,
      loadWallet: async () => ({ mint: { mintUrl: fixture.input.asset.mintUrl } }) as CashuWallet,
      lockManager: immediateLockManager(),
    }),
  ).rejects.toThrow(/requires msat/);
  expect(fixture.remote.readDescriptorPage).not.toHaveBeenCalled();
  expect(fixture.remote.readObject).not.toHaveBeenCalled();
  expect(await fixture.input.database.custodyProofs.count()).toBe(0);
  expect(await fixture.input.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
});

it("uses complete current local custody without backup network I/O", async () => {
  const fixture = await backupFixture();
  const locator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: KEYSET,
    counter: 4,
  };
  const selectableProof = createBrowserCustodyProofRow({
    scopeId: fixture.input.scopeId,
    normalizedMint: fixture.input.asset.mintUrl,
    unit: "msat",
    proof: {
      id: KEYSET,
      amount: Amount.from(1),
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator,
        proofKeysetId: KEYSET,
        proofAmount: 1,
      }),
      C: `02${"44".repeat(32)}`,
    },
    asset: { kind: "regular" },
    receivedAtMs: 1,
  });
  const proof = {
    ...selectableProof,
    selectability: "locked" as const,
    reservationOperationId: "pending-operation",
  };
  await fixture.input.database.custodyProofs.put(proof);
  await fixture.input.database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(proof, 1, locator, "local"),
  );
  await fixture.input.database.walletCounterAssociations.put({
    scopeId: fixture.input.scopeId,
    normalizedMint: fixture.input.asset.mintUrl,
    unit: "msat",
    keysetId: KEYSET,
    recoveryComplete: true,
  });
  await fixture.input.database.walletCounterCursors.put({
    scopeId: fixture.input.scopeId,
    keysetId: KEYSET,
    next: 5,
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: fixture.input.scopeId,
    asset: fixture.input.asset,
    custodyRevision: 1n,
    activeProofCount: 1,
  });
  await fixture.input.database.encryptedWalletBackupV2DesiredAssets.put({
    ...desired,
    syncState: "acknowledged",
  });
  await expect(readBrowserEncryptedWalletBackupV2LocalAvailableAmount(fixture.input)).resolves.toBe(
    0n,
  );
  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...fixture.input,
      loadWallet: async () => ({ mint: { mintUrl: fixture.input.asset.mintUrl } }) as CashuWallet,
      lockManager: immediateLockManager(),
    }),
  ).resolves.toEqual({ kind: "local-custody" });
  expect((await fixture.input.database.proofs.toArray())[0]).toMatchObject({
    reservedBy: "pending-operation",
  });
  expect(fixture.remote.readDescriptorPage).not.toHaveBeenCalled();
  expect(fixture.remote.readObject).not.toHaveBeenCalled();
  await fixture.input.database.encryptedWalletBackupV2DesiredAssets.put({
    ...desired,
    syncState: "acknowledged",
    activeProofCount: 2,
  });
  await expect(restoreBrowserEncryptedWalletBackupV2TargetedAsset(fixture.input)).rejects.toEqual(
    expect.objectContaining({
      code: "partial",
      message: "browser V2 local custody asset is partial",
    }),
  );
  expect(fixture.remote.readDescriptorPage).not.toHaveBeenCalled();
});

it("repairs only selectable legacy cache rows when CTF custody retains losing evidence", async () => {
  const fixture = await backupFixture();
  const selectableLocator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: CTF_KEYSET,
    counter: 8,
  };
  const losingLocator = { ...selectableLocator, counter: 7 };
  const selectable = createBrowserCustodyProofRow({
    scopeId: fixture.input.scopeId,
    normalizedMint: fixture.input.asset.mintUrl,
    unit: "msat",
    proof: {
      id: CTF_KEYSET,
      amount: Amount.from(1),
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator: selectableLocator,
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
  });
  const losingPredecessor = createBrowserCustodyProofRow({
    scopeId: fixture.input.scopeId,
    normalizedMint: fixture.input.asset.mintUrl,
    unit: "msat",
    proof: {
      id: CTF_KEYSET,
      amount: Amount.from(1),
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator: losingLocator,
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
  });
  const lockedLosing = {
    ...losingPredecessor,
    selectability: "locked" as const,
    reservationOperationId: "redeem:losing",
  };
  const losing = {
    ...lockedLosing,
    revision: lockedLosing.revision + 1,
    selectability: "verified-losing" as const,
    reservationOperationId: null,
  };
  const ctfAsset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: fixture.input.asset.mintUrl,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: CTF_CONDITION_ID,
      outcomeCollectionId: CTF_OUTCOME_COLLECTION_ID,
      outcomeLabel: CTF_OUTCOME,
      registeredAt: 0,
      finalExpiry: 100,
    },
  });
  const input = { ...fixture.input, asset: ctfAsset };
  await input.database.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId: input.scopeId,
    normalizedMint: input.asset.mintUrl,
    unit: "msat",
    keysetId: CTF_KEYSET,
    denominationPublicKeys: { "1": CTF_PUBLIC_KEY },
    inputFeePpk: 100,
    conditionId: CTF_CONDITION_ID,
    outcomeCollection: CTF_OUTCOME,
    outcomeCollectionId: CTF_OUTCOME_COLLECTION_ID,
    registeredAtUnixSeconds: 0,
    finalExpiryUnixSeconds: 100,
    curve: "secp256k1",
  });
  await input.database.custodyProofs.bulkPut([selectable, losing]);
  await input.database.custodyProofBackupAuthorities.bulkPut([
    createBrowserProofBackupAuthorityRow(selectable, 2, selectableLocator, "admission:selectable"),
    classifyBrowserProofBackupAuthorityVerifiedLosing(
      createBrowserProofBackupAuthorityRow(lockedLosing, 2, losingLocator, "admission:losing"),
      losing,
      "redeem:losing",
      3,
    ),
  ]);
  await input.database.walletCounterAssociations.put({
    scopeId: input.scopeId,
    normalizedMint: input.asset.mintUrl,
    unit: "msat",
    keysetId: CTF_KEYSET,
    recoveryComplete: true,
  });
  await input.database.walletCounterCursors.put({
    scopeId: input.scopeId,
    keysetId: CTF_KEYSET,
    next: 9,
  });
  await input.database.encryptedWalletBackupV2DesiredAssets.put({
    ...createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: input.scopeId,
      asset: input.asset,
      custodyRevision: 1n,
      activeProofCount: 2,
    }),
    syncState: "acknowledged",
  });

  await expect(readBrowserEncryptedWalletBackupV2LocalAvailableAmount(input)).resolves.toBe(1n);
  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...input,
      loadWallet: async () => ({ mint: { mintUrl: input.asset.mintUrl } }) as CashuWallet,
      lockManager: immediateLockManager(),
    }),
  ).resolves.toEqual({ kind: "local-custody" });

  const legacyProofs = await input.database.proofs.toArray();
  expect(legacyProofs).toHaveLength(1);
  expect(legacyProofs[0]?.secret).toBe(
    deriveDurableWalletProofSecret({
      seed: SEED,
      locator: selectableLocator,
      proofKeysetId: CTF_KEYSET,
      proofAmount: 1,
    }),
  );
  expect(legacyProofs[0]?.secret).not.toBe(
    deriveDurableWalletProofSecret({
      seed: SEED,
      locator: losingLocator,
      proofKeysetId: CTF_KEYSET,
      proofAmount: 1,
    }),
  );

  const losingSecret = deriveDurableWalletProofSecret({
    seed: SEED,
    locator: losingLocator,
    proofKeysetId: CTF_KEYSET,
    proofAmount: 1,
  });
  await input.database.proofs.delete(legacyProofs[0]!.secret);
  await input.database.proofs.put({
    ...legacyProofs[0]!,
    secret: losingSecret,
    conditionId: CTF_CONDITION_ID,
    outcomeCollection: CTF_OUTCOME,
  });
  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...input,
      loadWallet: async () => ({ mint: { mintUrl: input.asset.mintUrl } }) as CashuWallet,
      lockManager: immediateLockManager(),
    }),
  ).resolves.toEqual({ kind: "local-custody" });
  expect(await input.database.proofs.count()).toBe(1);
  expect((await input.database.proofs.toArray())[0]?.secret).toBe(legacyProofs[0]?.secret);

  await input.database.custodyProofs.delete([input.scopeId, selectable.proofId]);
  await input.database.custodyProofBackupAuthorities.delete([input.scopeId, selectable.proofId]);
  await input.database.proofs.clear();
  await input.database.proofs.put({
    ...legacyProofs[0]!,
    secret: losingSecret,
    conditionId: CTF_CONDITION_ID,
    outcomeCollection: CTF_OUTCOME,
  });
  await input.database.encryptedWalletBackupV2DesiredAssets.put({
    ...createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: input.scopeId,
      asset: input.asset,
      custodyRevision: 2n,
      activeProofCount: 1,
    }),
    syncState: "acknowledged",
  });
  await expect(readBrowserEncryptedWalletBackupV2LocalAvailableAmount(input)).resolves.toBe(0n);
  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...input,
      loadWallet: async () => ({ mint: { mintUrl: input.asset.mintUrl } }) as CashuWallet,
      lockManager: immediateLockManager(),
    }),
  ).resolves.toEqual({ kind: "local-custody" });
  expect(await input.database.proofs.count()).toBe(0);
  expect(input.remote.readDescriptorPage).not.toHaveBeenCalled();

  await input.database.proofs.put({
    ...legacyProofs[0]!,
    secret: losingSecret,
    conditionId: CTF_CONDITION_ID,
    outcomeCollection: "OTHER",
  });
  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...input,
      loadWallet: async () => ({ mint: { mintUrl: input.asset.mintUrl } }) as CashuWallet,
      lockManager: immediateLockManager(),
    }),
  ).rejects.toThrow("browser V2 losing legacy proof cache conflicts");
  expect(await input.database.proofs.count()).toBe(1);

  await input.database.proofs.put({
    ...legacyProofs[0]!,
    secret: losingSecret,
    conditionId: CTF_CONDITION_ID,
    outcomeCollection: "OTHER",
    reservedBy: "",
  });
  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...input,
      loadWallet: async () => ({ mint: { mintUrl: input.asset.mintUrl } }) as CashuWallet,
      lockManager: immediateLockManager(),
    }),
  ).rejects.toThrow("browser V2 losing legacy proof cache conflicts");
  expect(await input.database.proofs.count()).toBe(1);

  await input.database.proofs.put({
    ...legacyProofs[0]!,
    secret: losingSecret,
    conditionId: CTF_CONDITION_ID,
    outcomeCollection: "OTHER",
    reservedBy: "operation:reserved",
  });
  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...input,
      loadWallet: async () => ({ mint: { mintUrl: input.asset.mintUrl } }) as CashuWallet,
      lockManager: immediateLockManager(),
    }),
  ).resolves.toEqual({ kind: "local-custody" });
  expect(await input.database.proofs.count()).toBe(1);

  await input.database.proofs.put({
    ...legacyProofs[0]!,
    secret: losingSecret,
    conditionId: CTF_CONDITION_ID,
    outcomeCollection: "OTHER",
    reservedBy: undefined,
    terminalOperationId: "operation:terminal",
  });
  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...input,
      loadWallet: async () => ({ mint: { mintUrl: input.asset.mintUrl } }) as CashuWallet,
      lockManager: immediateLockManager(),
    }),
  ).resolves.toEqual({ kind: "local-custody" });
  expect(await input.database.proofs.count()).toBe(1);
});

it("removes a matching pending-removal cache body without projecting it", async () => {
  const fixture = await backupFixture();
  const ctfAsset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: fixture.input.asset.mintUrl,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: CTF_CONDITION_ID,
      outcomeCollectionId: CTF_OUTCOME_COLLECTION_ID,
      outcomeLabel: CTF_OUTCOME,
      registeredAt: 0,
      finalExpiry: 100,
    },
  });
  const input = { ...fixture.input, asset: ctfAsset };
  const selectableLocator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: CTF_KEYSET,
    counter: 1,
  };
  const pendingLocator = { ...selectableLocator, counter: 2 };
  const selectable = createBrowserCustodyProofRow({
    scopeId: input.scopeId,
    normalizedMint: input.asset.mintUrl,
    unit: "msat",
    proof: {
      id: CTF_KEYSET,
      amount: Amount.from(1),
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator: selectableLocator,
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
  });
  const pendingPredecessor = createBrowserCustodyProofRow({
    scopeId: input.scopeId,
    normalizedMint: input.asset.mintUrl,
    unit: "msat",
    proof: {
      id: CTF_KEYSET,
      amount: Amount.from(1),
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator: pendingLocator,
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
  });
  const pending = {
    ...pendingPredecessor,
    revision: pendingPredecessor.revision + 1,
    selectability: "pending-removal" as const,
    reservationOperationId: null,
  };
  await input.database.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId: input.scopeId,
    normalizedMint: input.asset.mintUrl,
    unit: "msat",
    keysetId: CTF_KEYSET,
    denominationPublicKeys: { "1": CTF_PUBLIC_KEY },
    inputFeePpk: 100,
    conditionId: CTF_CONDITION_ID,
    outcomeCollection: CTF_OUTCOME,
    outcomeCollectionId: CTF_OUTCOME_COLLECTION_ID,
    registeredAtUnixSeconds: 0,
    finalExpiryUnixSeconds: 100,
    curve: "secp256k1",
  });
  await input.database.custodyProofs.bulkPut([selectable, pending]);
  await input.database.custodyProofBackupAuthorities.bulkPut([
    createBrowserProofBackupAuthorityRow(selectable, 2, selectableLocator, "selectable"),
    advanceBrowserProofBackupAuthorityRowToPendingRemoval(
      createBrowserProofBackupAuthorityRow(
        pendingPredecessor,
        2,
        pendingLocator,
        "pending-predecessor",
      ),
      pending,
      3,
    ),
  ]);
  await input.database.walletCounterAssociations.put({
    scopeId: input.scopeId,
    normalizedMint: input.asset.mintUrl,
    unit: "msat",
    keysetId: CTF_KEYSET,
    recoveryComplete: true,
  });
  await input.database.walletCounterCursors.put({
    scopeId: input.scopeId,
    keysetId: CTF_KEYSET,
    next: 3,
  });
  await input.database.encryptedWalletBackupV2DesiredAssets.put(
    createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: input.scopeId,
      asset: input.asset,
      custodyRevision: 1n,
      activeProofCount: 1,
    }),
  );
  const pendingMaterial = storedProofFromCustodyRow(pending);
  const pendingCached = { ...pendingMaterial, amount: Number(pendingMaterial.amount) };
  const unrelatedCached = {
    id: CTF_KEYSET,
    amount: 1,
    secret: "unrelated-cache-secret",
    C: CTF_PUBLIC_KEY,
    mintUrl: "https://unrelated.example",
    baseAsset: "sat",
    unit: "msat" as const,
  };
  await input.database.proofs.bulkPut([pendingCached, unrelatedCached]);

  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...input,
      loadWallet: async () => {
        throw new Error("local repair must not load the mint wallet");
      },
      lockManager: immediateLockManager(),
    }),
  ).resolves.toEqual({ kind: "local-custody" });

  const cachedSecrets = (await input.database.proofs.toArray()).map(({ secret }) => secret);
  expect(cachedSecrets).toContain(storedProofFromCustodyRow(selectable).secret);
  expect(cachedSecrets).toContain(unrelatedCached.secret);
  expect(cachedSecrets).not.toContain(pendingCached.secret);
});

it("returns zero local availability for a removal with retained operation proofs", async () => {
  const fixture = await backupFixture();
  const removal = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: fixture.input.scopeId,
    asset: fixture.input.asset,
    custodyRevision: 2n,
    activeProofCount: 0,
  });
  await fixture.input.database.encryptedWalletBackupV2DesiredAssets.put(removal);
  const pending = await putLocalProofWithoutAuthority(fixture);
  const locked = {
    ...pending,
    selectability: "locked" as const,
    reservationOperationId: "pending-operation",
  };
  await fixture.input.database.custodyProofs.put(locked);
  await fixture.input.database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(locked, 1, null, "pending-operation"),
  );

  await expect(readBrowserEncryptedWalletBackupV2LocalAvailableAmount(fixture.input)).resolves.toBe(
    0n,
  );
  await expect(restoreBrowserEncryptedWalletBackupV2TargetedAsset(fixture.input)).resolves.toEqual({
    kind: "local-custody",
  });
  expect(fixture.remote.readDescriptorPage).not.toHaveBeenCalled();
});

it("tags missing local custody authority without backup network I/O", async () => {
  const fixture = await backupFixture();
  await putLocalProofWithoutAuthority(fixture);

  await expect(
    readBrowserEncryptedWalletBackupV2LocalAvailableAmount(fixture.input),
  ).rejects.toEqual(expect.objectContaining({ code: "missing-authority" }));
});

it("tags an invalid desired action without backup network I/O", async () => {
  const fixture = await backupFixture();
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: fixture.input.scopeId,
    asset: fixture.input.asset,
    custodyRevision: 2n,
    activeProofCount: 0,
  });
  await fixture.input.database.encryptedWalletBackupV2DesiredAssets.put({
    ...desired,
    // Deliberately corrupt the persisted discriminator to exercise the
    // fail-closed branch that typed rows cannot produce.
    desiredAction: "corrupt" as never,
    syncState: "acknowledged",
  });

  await expect(
    readBrowserEncryptedWalletBackupV2LocalAvailableAmount(fixture.input),
  ).rejects.toEqual(expect.objectContaining({ code: "invalid-action" }));
});

it("tags stale profile, local proof read, partial, and snapshot read guards", async () => {
  const staleFixture = await backupFixture();
  await expect(
    readBrowserEncryptedWalletBackupV2LocalAvailableAmount({
      ...staleFixture.input,
      isCurrentProfile: () => false,
    }),
  ).rejects.toEqual(expect.objectContaining({ code: "stale-profile" }));

  const staleDuringProofFixture = await backupFixture();
  let profileChecks = 0;
  await expect(
    readBrowserEncryptedWalletBackupV2LocalAvailableAmount({
      ...staleDuringProofFixture.input,
      isCurrentProfile: () => profileChecks++ < 1,
    }),
  ).rejects.toEqual(expect.objectContaining({ code: "stale-profile" }));

  const proofReadFixture = await backupFixture();
  proofReadFixture.input.database.close();
  await expect(
    readBrowserEncryptedWalletBackupV2LocalAvailableAmount(proofReadFixture.input),
  ).rejects.toEqual(expect.objectContaining({ code: "proof-read" }));

  const partialFixture = await backupFixture();
  const partialDesired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: partialFixture.input.scopeId,
    asset: partialFixture.input.asset,
    custodyRevision: 2n,
    activeProofCount: 2,
  });
  await partialFixture.input.database.encryptedWalletBackupV2DesiredAssets.put(partialDesired);
  await putLocalProofWithAuthority(partialFixture);
  await expect(
    readBrowserEncryptedWalletBackupV2LocalAvailableAmount(partialFixture.input),
  ).rejects.toEqual(expect.objectContaining({ code: "partial" }));

  const snapshotFixture = await backupFixture();
  const proofWithStaleAuthority = await putLocalProofWithAuthority(snapshotFixture, false);
  await snapshotFixture.input.database.custodyProofs.put({
    ...proofWithStaleAuthority,
    revision: proofWithStaleAuthority.revision + 1,
  });
  const snapshotDesired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: snapshotFixture.input.scopeId,
    asset: snapshotFixture.input.asset,
    custodyRevision: 2n,
    activeProofCount: 1,
  });
  await snapshotFixture.input.database.encryptedWalletBackupV2DesiredAssets.put(snapshotDesired);
  await expect(
    readBrowserEncryptedWalletBackupV2LocalAvailableAmount(snapshotFixture.input),
  ).rejects.toEqual(expect.objectContaining({ code: "snapshot-read" }));
});

it("falls through from an acknowledged evicted cache to its current bundle", async () => {
  const fixture = await backupFixture();
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: fixture.input.scopeId,
    asset: fixture.input.asset,
    custodyRevision: 1n,
    activeProofCount: 1,
  });
  await fixture.input.database.encryptedWalletBackupV2DesiredAssets.put({
    ...desired,
    syncState: "acknowledged",
  });
  await expect(
    restoreBrowserEncryptedWalletBackupV2TargetedAsset(fixture.input),
  ).resolves.toMatchObject({
    kind: "backup",
  });
});

it("rejects a foreign wallet mint after backup object but before mint I/O", async () => {
  const fixture = await backupFixture();

  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...fixture.input,
      loadWallet: async () => ({ mint: { mintUrl: "https://other-mint.example" } }) as CashuWallet,
      lockManager: immediateLockManager(),
    }),
  ).rejects.toThrow(/restore mint is foreign/);

  expect(fixture.remote.readDescriptorPage).toHaveBeenCalledOnce();
  expect(fixture.remote.readObject).toHaveBeenCalledOnce();
});

it("admits an all-sealed bundle without loading the mint wallet", async () => {
  const fixture = await sealedBackupFixture();
  const loadWallet = vi.fn(async () => {
    throw new Error("mint is unavailable");
  });

  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...fixture.input,
      loadWallet,
      lockManager: immediateLockManager(),
    }),
  ).resolves.toEqual({
    kind: "restored",
    bundleId: fixture.bundleId,
    headVersion: 1,
  });

  expect(loadWallet).not.toHaveBeenCalled();
  expect(fixture.remote.readObject).toHaveBeenCalledOnce();
  const proofRows = await fixture.input.database.custodyProofs.toArray();
  expect(proofRows).toHaveLength(1);
  expect(proofRows[0]).toMatchObject({
    selectability: "verified-losing",
    reservationOperationId: null,
  });
  const authorityRows = await fixture.input.database.custodyProofBackupAuthorities.toArray();
  expect(authorityRows).toHaveLength(1);
  expect(authorityRows[0]?.terminalAuthority).toEqual({ kind: "remote-seal" });
  expect(await fixture.input.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(1);
  expect(await fixture.input.database.proofs.count()).toBe(0);
  expect(await fixture.input.database.custodyConditionalKeysets.count()).toBe(0);
  await expect(readBrowserEncryptedWalletBackupV2LocalAvailableAmount(fixture.input)).resolves.toBe(
    0n,
  );
});

it("admits mixed CTF siblings through the live mint gate and keeps losing proof out of cache", async () => {
  const fixture = await sealedBackupFixture(true);

  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...fixture.input,
      loadWallet: async () => ctfRestoreWallet(fixture.input.asset.mintUrl),
      lockManager: immediateLockManager(),
    }),
  ).resolves.toEqual({
    kind: "restored",
    bundleId: fixture.bundleId,
    headVersion: 1,
  });

  expect(
    (await fixture.input.database.custodyProofs.toArray())
      .map(({ selectability }) => selectability)
      .sort(),
  ).toEqual(["selectable", "verified-losing"]);
  expect(await fixture.input.database.proofs.count()).toBe(1);
  expect(
    await fixture.input.database.walletCounterAssociations.get([
      fixture.input.scopeId,
      fixture.input.asset.mintUrl,
      "msat",
      CTF_KEYSET,
    ]),
  ).toMatchObject({ recoveryComplete: true });
  expect(
    await fixture.input.database.walletCounterCursors.get([fixture.input.scopeId, CTF_KEYSET]),
  ).toMatchObject({ next: 2 });
  await expect(readBrowserEncryptedWalletBackupV2LocalAvailableAmount(fixture.input)).resolves.toBe(
    1n,
  );
});

it("does not admit a sealed sibling when its mixed live proof fails the mint gate", async () => {
  const fixture = await sealedBackupFixture(true);
  const wallet = ctfRestoreWallet(fixture.input.asset.mintUrl) as unknown as {
    getKeyset: () => { verify: () => boolean };
  };
  wallet.getKeyset = () => ({ verify: () => false });

  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...fixture.input,
      loadWallet: async () => wallet as unknown as CashuWallet,
      lockManager: immediateLockManager(),
    }),
  ).rejects.toThrow(/keyset|verify|invalid/i);

  expect(await fixture.input.database.custodyProofs.count()).toBe(0);
  expect(await fixture.input.database.custodyProofBackupAuthorities.count()).toBe(0);
  expect(await fixture.input.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
  expect(await fixture.input.database.proofs.count()).toBe(0);
});

it("rejects a corrupt object before returning material", async () => {
  const fixture = await backupFixture();
  const stages: string[] = [];
  const object = fixture.bundle.objects[0]!;
  fixture.remote.readObject.mockResolvedValueOnce({
    ...object,
    body: object.body.slice().reverse(),
  });
  await expect(
    restoreBrowserEncryptedWalletBackupV2TargetedAsset({
      ...fixture.input,
      reportTargetedRecoveryStage: (stage) => stages.push(stage),
    }),
  ).rejects.toThrow(
    /corrupt encrypted wallet backup v2 bundle|encrypted backup bundle object|encrypted backup V2|authentication/i,
  );
  expect(stages).toEqual(["backup-decrypt"]);
});

it("reports fixed object and verification stages without error detail", async () => {
  const objectFailure = await backupFixture();
  const objectStages: string[] = [];
  const absent = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://absent.example",
    unit: "msat",
    asset: { kind: "ordinary" },
  });
  await expect(
    restoreBrowserEncryptedWalletBackupV2TargetedAsset({
      ...objectFailure.input,
      asset: absent,
      reportTargetedRecoveryStage: (stage) => objectStages.push(stage),
    }),
  ).rejects.toThrow(/current asset is absent/);
  expect(objectStages).toEqual(["backup-object"]);

  const verificationFailure = await backupFixture();
  const verificationStages: string[] = [];
  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...verificationFailure.input,
      loadWallet: async () => ({ mint: { mintUrl: "https://other-mint.example" } }) as CashuWallet,
      lockManager: immediateLockManager(),
      reportTargetedRecoveryStage: (stage) => verificationStages.push(stage),
    }),
  ).rejects.toThrow(/restore mint is foreign/);
  expect(verificationStages).toEqual(["backup-verify"]);
});

it("rejects a foreign current head", async () => {
  const fixture = await backupFixture();
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head: createEncryptedWalletBackupV2CurrentHead({
      realm: fixture.input.keyHandle.realm,
      walletId: fixture.input.keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 1,
      bundles: [fixture.bundle.descriptor],
    }),
    bundles: [fixture.bundle.descriptor],
  });
  fixture.remote.readDescriptorPage.mockImplementation(async ({ afterBundleId }) => {
    const page = pages.find((candidate) => candidate.afterBundleId === afterBundleId);
    if (!page) throw new Error("test head page is absent");
    return { ...page, head: { ...page.head, realm: "foreign.example" } };
  });
  await expect(restoreBrowserEncryptedWalletBackupV2TargetedAsset(fixture.input)).rejects.toThrow(
    /descriptor is foreign|current head is foreign/,
  );
});

it("rejects a descriptor whose custody revision does not authenticate its objects", async () => {
  const fixture = await backupFixture();
  const descriptor = { ...fixture.bundle.descriptor, custodyRevision: 2n };
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: fixture.input.keyHandle.realm,
    walletId: fixture.input.keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 2,
    bundles: [descriptor],
  });
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles: [descriptor] });
  fixture.remote.readDescriptorPage.mockImplementation(async ({ afterBundleId }) => {
    const page = pages.find((candidate) => candidate.afterBundleId === afterBundleId);
    if (!page) throw new Error("test head page is absent");
    return page;
  });
  await expect(restoreBrowserEncryptedWalletBackupV2TargetedAsset(fixture.input)).rejects.toThrow(
    /corrupt encrypted wallet backup v2 bundle|custody metadata is foreign/,
  );
});

it("does not let another asset at the same mint and unit block a CTF request", async () => {
  const fixture = await backupFixture();
  await fixture.input.database.custodyProofs.put(
    createBrowserCustodyProofRow({
      scopeId: fixture.input.scopeId,
      normalizedMint: fixture.input.asset.mintUrl,
      unit: "msat",
      proof: {
        id: KEYSET,
        amount: Amount.from(1),
        secret: "55".repeat(32),
        C: `02${"66".repeat(32)}`,
      },
      asset: { kind: "regular" },
      receivedAtMs: 1,
    }),
  );
  const ctf = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: fixture.input.asset.mintUrl,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: "aa".repeat(32),
      outcomeCollectionId: "bb".repeat(32),
      outcomeLabel: "YES",
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  await expect(
    restoreBrowserEncryptedWalletBackupV2TargetedAsset({ ...fixture.input, asset: ctf }),
  ).rejects.toThrow(/current asset is absent/);
});

it("rejects a stale profile after decrypting the current bundle", async () => {
  const fixture = await backupFixture();
  let current = true;
  fixture.remote.readObject.mockImplementationOnce(async (request) => {
    current = false;
    return fixture.objects.get(request.objectId)!;
  });
  await expect(
    restoreBrowserEncryptedWalletBackupV2TargetedAsset({
      ...fixture.input,
      isCurrentProfile: () => current,
    }),
  ).rejects.toThrow(/profile is stale/);
});

it("fails closed for an absent asset without broad mint recovery", async () => {
  const fixture = await backupFixture();
  const absent = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://absent.example",
    unit: "msat",
    asset: { kind: "ordinary" },
  });
  await expect(
    restoreBrowserEncryptedWalletBackupV2TargetedAsset({ ...fixture.input, asset: absent }),
  ).rejects.toThrow(/current asset is absent/);
  expect(fixture.remote.readObject).not.toHaveBeenCalled();
});

it("does not admit a decrypted bundle before mint proof verification", async () => {
  const fixture = await backupFixture();
  const checkProofsStates = vi.fn();
  const wallet = {
    mint: { mintUrl: fixture.input.asset.mintUrl },
    getKeyset: () => ({
      id: KEYSET,
      unit: "msat",
      keys: { 1: `02${"44".repeat(32)}` },
      verify: () => true,
    }),
    checkProofsStates,
  } as unknown as CashuWallet;
  const loadWallet = vi.fn(async () => wallet);

  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...fixture.input,
      loadWallet,
      lockManager: immediateLockManager(),
    }),
  ).rejects.toThrow(/DLEQ|proof|signature/i);
  expect(loadWallet).toHaveBeenCalledOnce();
  expect(checkProofsStates).not.toHaveBeenCalled();
  expect(await fixture.input.database.custodyProofs.count()).toBe(0);
  expect(await fixture.input.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
});

function ctfRestoreWallet(mintUrl: string): CashuWallet {
  const keyset = new Keyset(CTF_KEYSET, "msat", true, 100, 100, {
    conditionId: CTF_CONDITION_ID,
    outcomeCollection: CTF_OUTCOME,
    outcomeCollectionId: CTF_OUTCOME_COLLECTION_ID,
    registeredAt: 0,
  });
  keyset.keys = { 1: CTF_PUBLIC_KEY };
  return {
    mint: { mintUrl },
    getKeyset: () => keyset,
    checkProofsStates: async (proofs: readonly { readonly secret: string }[]) =>
      proofs.map(({ secret }) => ({
        Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
        state: "UNSPENT" as const,
        witness: null,
      })),
  } as unknown as CashuWallet;
}

async function sealedBackupFixture(includeSelectableSibling = false) {
  const { scopeId, walletId } = browserWalletScope(SEED);
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  openDatabases.push(database);
  await database.open();
  const scope = { scopeKind: "wallet" as const, walletId, scopeId };
  const custody = new BrowserDurableCustodyAdapter(database);
  const owner = await custody.claimScope(scope, {
    incarnationId: "sealed-restore",
    observedAtMs: 10,
    leaseExpiresAtMs: 10_000,
  });
  const ctfAsset = {
    kind: "ctf" as const,
    conditionId: CTF_CONDITION_ID,
    outcomeCollectionId: CTF_OUTCOME_COLLECTION_ID,
    outcomeLabel: CTF_OUTCOME,
    registeredAt: 0,
    finalExpiry: 100,
  };
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.example",
    unit: "msat",
    asset: ctfAsset,
  });
  const locator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: CTF_KEYSET,
    counter: 0,
  };
  const proof = {
    id: CTF_KEYSET,
    amount: 1 as never,
    secret: deriveDurableWalletProofSecret({
      seed: SEED,
      locator,
      proofKeysetId: CTF_KEYSET,
      proofAmount: 1,
    }),
    C: CTF_PUBLIC_KEY,
  };
  const predecessor = createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: asset.mintUrl,
    unit: "msat",
    proof,
    asset: {
      kind: "conditional",
      conditionId: CTF_CONDITION_ID,
      outcomeCollection: CTF_OUTCOME,
    },
    receivedAtMs: 1,
  });
  await database.custodyProofs.put(predecessor);
  await database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(predecessor, 10, locator, "admission:sealed"),
  );
  await database.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId,
    normalizedMint: asset.mintUrl,
    unit: "msat",
    keysetId: CTF_KEYSET,
    denominationPublicKeys: { "1": CTF_PUBLIC_KEY },
    inputFeePpk: 100,
    conditionId: CTF_CONDITION_ID,
    outcomeCollection: CTF_OUTCOME,
    outcomeCollectionId: CTF_OUTCOME_COLLECTION_ID,
    registeredAtUnixSeconds: 0,
    finalExpiryUnixSeconds: 100,
    curve: "secp256k1",
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(
    createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId,
      asset,
      custodyRevision: 1n,
      activeProofCount: 1,
    }),
  );
  const committed = await commitBrowserCtfTerminalOperation({
    adapter: custody,
    scope,
    owner,
    operationId: "ctf-redeem-sealed-restore",
    mintUrl: asset.mintUrl,
    proofs: [proof],
    predecessorProofs: [predecessor],
    publicKey: CTF_PUBLIC_KEY,
  });
  const record = await custody.readOperation(scope, committed.operationId);
  if (record === null) throw new Error("test terminal operation is absent");
  const terminalSeal = await issueEncryptedWalletBackupV2TerminalSeal({
    seed: SEED,
    proof: {
      mintUrl: asset.mintUrl,
      unit: "msat",
      asset: ctfAsset,
      locator,
      proof,
    },
    operationId: committed.operationId,
    store: {
      withCommittedTerminalRejection: async (_operationId, read) =>
        read({ record, exactRejection: committed.rejection, classifiedAtMs: 20 }),
    },
  });
  const liveOutput = OutputData.createSingleDeterministicData(1, SEED, 1, CTF_KEYSET);
  const liveBlindSignature = createBlindSignature(
    pointFromHex(liveOutput.blindedMessage.B_),
    CTF_PRIVATE_KEY,
    CTF_KEYSET,
  );
  const liveDleq = createDLEQProof(pointFromHex(liveOutput.blindedMessage.B_), CTF_PRIVATE_KEY);
  const liveProof = liveOutput.toProof(
    {
      id: CTF_KEYSET,
      amount: Amount.from(1),
      C_: liveBlindSignature.C_.toHex(true),
      dleq: { e: bytesToHex(liveDleq.e), s: bytesToHex(liveDleq.s) },
    },
    { id: CTF_KEYSET, keys: { 1: CTF_PUBLIC_KEY } },
  );
  const liveLocator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: CTF_KEYSET,
    counter: 1,
  };
  await database.custodyProofs.clear();
  await database.custodyProofBackupAuthorities.clear();
  await database.encryptedWalletBackupV2DesiredAssets.clear();
  await database.custodyConditionalKeysets.clear();
  await database.custodyOperations.clear();
  await database.custodyArtifacts.clear();
  await database.custodyReservations.clear();
  await database.custodyActiveWork.clear();
  await database.custodyScopes.clear();
  await database.walletCounterCursors.clear();
  await database.walletCounterAssociations.clear();
  await database.proofs.clear();
  expect(await database.custodyConditionalKeysets.count()).toBe(0);
  expect(await database.custodyOperations.count()).toBe(0);
  expect(await database.custodyScopes.count()).toBe(0);
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: "backup.example",
    runtime: { subtle: crypto.subtle },
  });
  const bundle = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset,
    custodyRevision: 1n,
    counterHighWaterMarks: [
      {
        mintUrl: asset.mintUrl,
        unit: "msat",
        keysetId: CTF_KEYSET,
        nextCounter: includeSelectableSibling ? 2 : 1,
      },
    ],
    proofs: [
      {
        mintUrl: asset.mintUrl,
        unit: "msat",
        asset: ctfAsset,
        locator,
        proof,
        terminalSeal,
      },
      ...(includeSelectableSibling
        ? [
            {
              mintUrl: asset.mintUrl,
              unit: "msat" as const,
              asset: ctfAsset,
              locator: liveLocator,
              proof: liveProof,
            },
          ]
        : []),
    ],
    runtime: { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto) },
  });
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: keyHandle.realm,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [bundle.descriptor],
  });
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head,
    bundles: [bundle.descriptor],
  });
  const objects = new Map(bundle.objects.map((object) => [object.objectId, object]));
  const remote = {
    discoverEnrollmentEpoch: vi.fn(),
    mutateHeadOnce: vi.fn(),
    readCurrentInventory: vi.fn(),
    readDescriptorPage: vi.fn(async ({ afterBundleId }) => {
      const page = pages.find((candidate) => candidate.afterBundleId === afterBundleId);
      if (!page) throw new Error("test head page is absent");
      return page;
    }),
    readObject: vi.fn(async ({ objectId }) => {
      const object = objects.get(objectId);
      if (!object) throw new Error("test object is absent");
      return object;
    }),
  } satisfies EncryptedWalletBackupV2RemotePort;
  return {
    remote,
    bundleId: bundle.descriptor.bundleId,
    input: {
      database,
      scopeId,
      seed: SEED,
      keyHandle,
      enrollmentEpoch: 1,
      asset,
      remote,
      requestUrl: (kind: "head" | "object", value: string | null) =>
        `https://backup.example/${kind}/${value ?? "current"}`,
      nowUnixSeconds: () => 1_000,
      runtime: { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto) },
      signal: new AbortController().signal,
      isCurrentProfile: () => true,
    },
  };
}

async function backupFixture() {
  fixtureSequence += 1;
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: fixtureSequence.toString(16).padStart(64, "0"),
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  openDatabases.push(database);
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: "backup.example",
    runtime: { subtle: crypto.subtle },
  });
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.example",
    unit: "msat",
    asset: { kind: "ordinary" },
  });
  const locator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: KEYSET,
    counter: 0,
  };
  const bundle = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset,
    custodyRevision: 1n,
    counterHighWaterMarks: [
      { mintUrl: asset.mintUrl, unit: "msat", keysetId: KEYSET, nextCounter: 1 },
    ],
    proofs: [
      {
        mintUrl: asset.mintUrl,
        unit: "msat",
        asset: { kind: "ordinary" },
        locator,
        proof: {
          id: KEYSET,
          amount: Amount.from(1),
          secret: deriveDurableWalletProofSecret({
            seed: SEED,
            locator,
            proofKeysetId: KEYSET,
            proofAmount: 1,
          }),
          C: `02${"33".repeat(32)}`,
        },
      },
    ],
    runtime: { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto) },
  });
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: keyHandle.realm,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [bundle.descriptor],
  });
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head,
    bundles: [bundle.descriptor],
  });
  const objects = new Map(bundle.objects.map((object) => [object.objectId, object]));
  const remote = {
    discoverEnrollmentEpoch: vi.fn(),
    mutateHeadOnce: vi.fn(),
    readCurrentInventory: vi.fn(async (): Promise<never> => {
      throw new Error("current inventory is not used by this fixture");
    }),
    readDescriptorPage: vi.fn(async ({ afterBundleId }) => {
      const page = pages.find((candidate) => candidate.afterBundleId === afterBundleId);
      if (!page) throw new Error("test head page is absent");
      return page;
    }),
    readObject: vi.fn(async ({ objectId }) => {
      const object = objects.get(objectId);
      if (!object) throw new Error("test object is absent");
      return object;
    }),
  } satisfies EncryptedWalletBackupV2RemotePort;
  return {
    bundle,
    objects,
    remote,
    input: {
      database,
      scopeId,
      seed: SEED,
      keyHandle,
      enrollmentEpoch: 1,
      asset,
      remote,
      requestUrl: (kind: "head" | "object", value: string | null) =>
        `https://backup.example/${kind}/${value ?? "current"}`,
      nowUnixSeconds: () => 1_000,
      runtime: { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto) },
      signal: new AbortController().signal,
      isCurrentProfile: () => true,
    },
  };
}

async function putLocalProofWithoutAuthority(fixture: Awaited<ReturnType<typeof backupFixture>>) {
  const locator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: KEYSET,
    counter: 8,
  };
  const proof = createBrowserCustodyProofRow({
    scopeId: fixture.input.scopeId,
    normalizedMint: fixture.input.asset.mintUrl,
    unit: "msat",
    proof: {
      id: KEYSET,
      amount: Amount.from(1),
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator,
        proofKeysetId: KEYSET,
        proofAmount: 1,
      }),
      C: `02${"55".repeat(32)}`,
    },
    asset: { kind: "regular" },
    receivedAtMs: 1,
  });
  await fixture.input.database.custodyProofs.put(proof);
  return proof;
}

async function putLocalProofWithAuthority(
  fixture: Awaited<ReturnType<typeof backupFixture>>,
  withCounters = true,
) {
  const proof = await putLocalProofWithoutAuthority(fixture);
  const locator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: KEYSET,
    counter: 8,
  };
  await fixture.input.database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(proof, 1, locator, "local"),
  );
  if (withCounters) {
    await fixture.input.database.walletCounterAssociations.put({
      scopeId: fixture.input.scopeId,
      normalizedMint: fixture.input.asset.mintUrl,
      unit: "msat",
      keysetId: KEYSET,
      recoveryComplete: true,
    });
    await fixture.input.database.walletCounterCursors.put({
      scopeId: fixture.input.scopeId,
      keysetId: KEYSET,
      next: 9,
    });
  }
  return proof;
}

function immediateLockManager(): Pick<LockManager, "request"> {
  return {
    request: async <T>(_name: string, _options: LockOptions, callback: LockGrantedCallback<T>) =>
      callback(null),
  } as Pick<LockManager, "request">;
}
