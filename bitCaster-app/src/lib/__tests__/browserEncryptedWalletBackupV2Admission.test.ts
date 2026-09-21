// @vitest-environment node
import "fake-indexeddb/auto";
import {
  Amount,
  deriveConditionalKeysetId,
  deriveKeysetId,
  Keyset,
  type Wallet as CashuWallet,
} from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2KeyHandle,
  createEncryptedWalletBackupV2AssetIdentity,
  decryptEncryptedWalletBackupV2ProofSetBundle,
  digestEncryptedWalletBackupV2TerminalProofCommitment,
  encodeDurableWalletProofDerivationLocatorCbor,
  prepareEncryptedWalletBackupV2TransportBundle,
  verifyEncryptedWalletBackupV2RestoredProofSet,
  type EncryptedWalletBackupV2ProofSetAsset,
  type EncryptedWalletBackupV2UnverifiedProofSet,
  type EncryptedWalletBackupV2VerifiedProofSet,
} from "@bitcaster/client-sdk";
import { deriveDurableCustodyProofId } from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  deriveDurableWalletProofSecret,
  type DurableWalletProofDerivationLocator,
} from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { serializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { afterEach, describe, expect, it } from "vitest";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { BitcasterDB } from "../../stores/proof-db";
import {
  admitBrowserEncryptedWalletBackupV2Asset,
  admitBrowserEncryptedWalletBackupV2MixedAsset,
  admitBrowserEncryptedWalletBackupV2SealedAsset,
} from "../browserEncryptedWalletBackupV2Admission";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import { browserWalletDatabaseName } from "../browserWalletProfile";

const SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
const MINT = "https://mint.example";
const PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const KEYSET_ID = deriveKeysetId({ 1: PUBLIC_KEY }, { unit: "msat", versionByte: 1 });
const CONDITION_ID = "55".repeat(32);
const COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: "YES",
});
const CONDITIONAL_KEYSET_ID = deriveConditionalKeysetId({
  keys: { 1: PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 0,
  final_expiry: 20,
  conditionId: CONDITION_ID,
  outcomeCollectionId: COLLECTION_ID,
});
const CTF_ASSET = {
  kind: "ctf",
  conditionId: CONDITION_ID,
  outcomeLabel: "YES",
  outcomeCollectionId: COLLECTION_ID,
  registeredAt: 10,
  finalExpiry: 20,
} as const;

describe("browser encrypted wallet backup V2 admission", () => {
  let database: BitcasterDB | null = null;

  afterEach(async () => {
    database?.close();
    if (database) await indexedDB.deleteDatabase(database.name);
    database = null;
  });

  it("admits paged ordinary proofs, counters, and the exact acknowledged revision atomically", async () => {
    const fixture = await createFixture(65);
    database = fixture.database;

    await admitBrowserEncryptedWalletBackupV2Asset(fixture.input);

    expect(await database.custodyProofs.count()).toBe(65);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(65);
    expect(await database.custodyOperations.count()).toBe(3);
    expect(await database.proofs.count()).toBe(65);
    expect(
      await database.walletCounterAssociations.get([fixture.scopeId, MINT, "msat", KEYSET_ID]),
    ).toMatchObject({ recoveryComplete: true });
    expect(await database.walletCounterCursors.get([fixture.scopeId, KEYSET_ID])).toEqual({
      scopeId: fixture.scopeId,
      keysetId: KEYSET_ID,
      next: 65,
    });
    await expectDesired(database, fixture, 65);
  });

  it("rejects sat before backup, custody, counter, or cache writes", async () => {
    const fixture = await createFixture(1);
    database = fixture.database;
    const satAsset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: MINT,
      unit: "sat",
      asset: { kind: "ordinary" },
    });

    await expect(
      admitBrowserEncryptedWalletBackupV2Asset({ ...fixture.input, asset: satAsset }),
    ).rejects.toThrow(/requires msat/);
    expect(await database.custodyScopes.count()).toBe(0);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.walletCounterAssociations.count()).toBe(0);
    expect(await database.walletCounterCursors.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(await database.proofs.count()).toBe(0);
  });

  it("reports only fixed admission stage transitions", async () => {
    const fixture = await createFixture(1);
    database = fixture.database;
    const stages: string[] = [];

    await admitBrowserEncryptedWalletBackupV2Asset({
      ...fixture.input,
      setTargetedRecoveryAdmissionStage: (stage) => stages.push(stage),
    });

    expect(stages).toEqual([
      "backup-admit-lock",
      "backup-admit-authority",
      "backup-admit-state",
      "backup-admit-custody",
      "backup-admit-counter",
      "backup-admit-desired",
      "backup-admit-desired-write",
      "backup-admit-current-profile",
      "backup-admit-transaction-commit",
      "backup-admit-cache",
    ]);
  });

  it("admits an exact CTF range-manifest locator and conditional keyset authority", async () => {
    const fixture = await createFixture(1, CTF_ASSET);
    database = fixture.database;

    await admitBrowserEncryptedWalletBackupV2Asset(fixture.input);
    await admitBrowserEncryptedWalletBackupV2Asset(fixture.input);

    expect(await database.custodyConditionalKeysets.count()).toBe(1);
    expect((await database.custodyProofBackupAuthorities.toArray())[0]).toMatchObject({
      derivationLocator: {
        schemaVersion: 1,
        kind: "ctf-range-manifest",
        rangeOperationId: "range-operation",
        manifestIndex: 0,
      },
    });
    expect((await database.custodyProofs.toArray())[0]).toMatchObject({
      assetKind: "conditional",
      conditionId: CONDITION_ID,
      outcomeCollection: "YES",
    });
    expect((await database.encryptedWalletBackupV2DesiredAssets.toArray())[0]).toMatchObject({
      terminalCtfContext: {
        conditionId: CONDITION_ID,
        outcomeLabel: "YES",
        outcomeCollectionId: COLLECTION_ID,
        registeredAt: 10,
        finalExpiry: 20,
      },
    });
  });

  it.each([
    { name: "all-live", sealedIndices: [] },
    { name: "mixed", sealedIndices: [1] },
  ])("rejects $name CTF metadata that conflicts with live keyset authority", async (testCase) => {
    const fixture = await createFixture(2, CTF_ASSET, {
      sealedIndices: testCase.sealedIndices,
    });
    database = fixture.database;
    const input = {
      ...fixture.input,
      wallet: wallet({ ...CTF_ASSET, registeredAt: 11 }, "msat"),
    };

    await expect(
      testCase.sealedIndices.length === 0
        ? admitBrowserEncryptedWalletBackupV2Asset(input)
        : admitBrowserEncryptedWalletBackupV2MixedAsset(input),
    ).rejects.toThrow(/conflicts with keyset/);
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(await database.proofs.count()).toBe(0);
  });

  it("admits mixed selectable and sealed CTF siblings without caching the losing proof", async () => {
    const fixture = await createFixture(2, CTF_ASSET, { sealedIndices: [1] });
    database = fixture.database;

    await admitBrowserEncryptedWalletBackupV2MixedAsset(fixture.input);

    expect(
      (await database.custodyProofs.toArray()).map(({ selectability }) => selectability).sort(),
    ).toEqual(["selectable", "verified-losing"]);
    expect(await database.proofs.count()).toBe(1);
    expect(await database.custodyProofBackupAuthorities.toArray()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ backupState: "local-only" }),
        expect.objectContaining({
          backupState: "remote-backed",
          terminalAuthority: expect.objectContaining({ kind: "remote-seal" }),
        }),
      ]),
    );
    expect((await database.encryptedWalletBackupV2DesiredAssets.toArray())[0]).toMatchObject({
      custodyRevision: "7",
      activeProofCount: 2,
      syncState: "acknowledged",
      terminalCtfContext: {
        conditionId: CONDITION_ID,
        outcomeLabel: "YES",
        outcomeCollectionId: COLLECTION_ID,
        registeredAt: 10,
        finalExpiry: 20,
      },
    });
  });

  it("allows only an exact mixed replay and refuses active-to-sealed promotion", async () => {
    const mixed = await createFixture(2, CTF_ASSET, { sealedIndices: [1] });
    database = mixed.database;
    await admitBrowserEncryptedWalletBackupV2MixedAsset(mixed.input);
    const before = await database.custodyProofs.toArray();

    await admitBrowserEncryptedWalletBackupV2MixedAsset(mixed.input);
    expect(await database.custodyProofs.toArray()).toEqual(before);

    const promoted = await createVerified(2, { asset: CTF_ASSET, sealedIndices: [0, 1] });
    await expect(
      admitBrowserEncryptedWalletBackupV2SealedAsset({
        ...mixed.input,
        verified: promoted,
      }),
    ).rejects.toThrow(/local custody conflicts/);
    expect(await database.custodyProofs.toArray()).toEqual(before);
  });

  it("refuses a mixed bundle that would promote a local active sibling to losing", async () => {
    const fixture = await createFixture(2, CTF_ASSET);
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2Asset(fixture.input);
    const before = await database.custodyProofs.toArray();
    const promoted = await createVerified(2, { asset: CTF_ASSET, sealedIndices: [1] });

    await expect(
      admitBrowserEncryptedWalletBackupV2MixedAsset({
        ...fixture.input,
        verified: promoted,
      }),
    ).rejects.toThrow(/local custody is partial/);
    expect(await database.custodyProofs.toArray()).toEqual(before);
  });

  it("rejects a mixed sibling whose full CTF tuple differs before writing custody", async () => {
    const fixture = await createFixture(2, CTF_ASSET, {
      sealedIndices: [1],
      proofAssets: [CTF_ASSET, { ...CTF_ASSET, registeredAt: 11 }],
    });
    database = fixture.database;

    await expect(admitBrowserEncryptedWalletBackupV2MixedAsset(fixture.input)).rejects.toThrow(
      /CTF tuple conflicts/,
    );
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(await database.proofs.count()).toBe(0);
  });

  it("repairs live cache while adding only sealed siblings from a newer mixed revision", async () => {
    const fixture = await createFixture(1, CTF_ASSET);
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2Asset({ ...fixture.input, custodyRevision: 6n });
    await database.proofs.clear();
    const expanded = await createVerified(2, { asset: CTF_ASSET, sealedIndices: [1] });

    await admitBrowserEncryptedWalletBackupV2MixedAsset({
      ...fixture.input,
      verified: expanded,
      custodyRevision: 7n,
      sourceOperationId: "backup-v2-restore:mixed-newer-bundle",
    });

    expect(await database.custodyProofs.count()).toBe(2);
    expect(await database.proofs.count()).toBe(1);
  });

  it("rejects a newer mixed revision that changes the persisted CTF tuple", async () => {
    const fixture = await createFixture(1, CTF_ASSET);
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2Asset({ ...fixture.input, custodyRevision: 6n });
    const changedAsset = { ...CTF_ASSET, registeredAt: 11 };
    const changed = await createVerified(2, {
      asset: CTF_ASSET,
      sealedIndices: [1],
      proofAssets: [changedAsset, changedAsset],
    });

    await expect(
      admitBrowserEncryptedWalletBackupV2MixedAsset({
        ...fixture.input,
        verified: changed,
        custodyRevision: 7n,
      }),
    ).rejects.toThrow(/desired authority conflicts/);
    expect(await database.custodyProofs.count()).toBe(1);
  });

  it("rolls back mixed proofs, authorities, counters, desired state, and cache together", async () => {
    const fixture = await createFixture(2, CTF_ASSET, { sealedIndices: [1] });
    database = fixture.database;

    await expect(
      admitBrowserEncryptedWalletBackupV2MixedAsset({
        ...fixture.input,
        fault: "before-commit",
      }),
    ).rejects.toThrow(/injected commit fault/);

    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.walletCounterAssociations.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(await database.proofs.count()).toBe(0);
  });

  it("rejects initial CTF admission when an orphan local proof is present", async () => {
    const fixture = await createFixture(1, CTF_ASSET);
    database = fixture.database;
    const verified = fixture.input.verified.proofs[0];
    if (verified === undefined) throw new Error("test proof is missing");
    await database.custodyProofs.put(
      createBrowserCustodyProofRow({
        scopeId: fixture.scopeId,
        normalizedMint: MINT,
        unit: "msat",
        proof: verified.proof,
        asset: {
          kind: "conditional",
          conditionId: CONDITION_ID,
          outcomeCollection: "YES",
        },
        receivedAtMs: 1,
      }),
    );

    await expect(admitBrowserEncryptedWalletBackupV2Asset(fixture.input)).rejects.toThrow(
      /local custody is untracked/,
    );
    expect(await database.custodyProofs.count()).toBe(1);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
  });

  it("rolls back every authority when the commit boundary fails", async () => {
    const fixture = await createFixture(2);
    database = fixture.database;

    await expect(
      admitBrowserEncryptedWalletBackupV2Asset({ ...fixture.input, fault: "before-commit" }),
    ).rejects.toThrow(/injected commit fault/);

    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.walletCounterAssociations.count()).toBe(0);
    expect(await database.walletCounterCursors.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(await database.proofs.count()).toBe(0);
  });

  it("repairs the legacy cache after an exact authority-only retry", async () => {
    const fixture = await createFixture(2);
    database = fixture.database;

    await expect(
      admitBrowserEncryptedWalletBackupV2Asset({
        ...fixture.input,
        fault: "after-authority-before-cache",
      }),
    ).rejects.toThrow(/injected cache fault/);
    expect(await database.custodyProofs.count()).toBe(2);
    expect(await database.proofs.count()).toBe(0);
    const operationCount = await database.custodyOperations.count();

    await admitBrowserEncryptedWalletBackupV2Asset(fixture.input);

    expect(await database.custodyOperations.count()).toBe(operationCount);
    expect(await database.proofs.count()).toBe(2);
    await expectDesired(database, fixture, 2);
  });

  it("uses a fresh local operation when an evicted cache is restored with different proofs", async () => {
    const fixture = await createFixture(1);
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2Asset(fixture.input);
    await database.custodyProofs.clear();
    await database.custodyProofBackupAuthorities.clear();
    const conflicting = await createVerified(1, { counterOffset: 10 });

    await admitBrowserEncryptedWalletBackupV2Asset({
      ...fixture.input,
      verified: conflicting,
      randomId: () => "different-proofs",
    });
    expect(await database.custodyProofs.count()).toBe(1);
    expect(await database.custodyOperations.count()).toBe(2);
    await expectDesired(database, fixture, 1);
  });

  it("reimports an evicted acknowledged asset with a fresh local operation", async () => {
    const fixture = await createFixture(1);
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2Asset(fixture.input);
    await database.custodyProofs.clear();
    await database.custodyProofBackupAuthorities.clear();
    await database.proofs.clear();

    await admitBrowserEncryptedWalletBackupV2Asset({
      ...fixture.input,
      randomId: () => "reimport-1",
    });

    expect(await database.custodyProofs.count()).toBe(1);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(1);
    expect(await database.proofs.count()).toBe(1);
    expect(await database.custodyOperations.count()).toBe(2);
    await expectDesired(database, fixture, 1);
  });

  it("rejects a partial or same-count foreign local proof set", async () => {
    const fixture = await createFixture(2);
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2Asset(fixture.input);
    const rows = await database.custodyProofs.toArray();
    await database.custodyProofs.delete([fixture.scopeId, rows[0]!.proofId]);

    await expect(admitBrowserEncryptedWalletBackupV2Asset(fixture.input)).rejects.toThrow(
      /local custody is partial/,
    );

    const replacement = (await createVerified(1, { counterOffset: 10 })).proofs[0]!;
    await database.custodyProofs.put(
      createBrowserCustodyProofRow({
        scopeId: fixture.scopeId,
        normalizedMint: MINT,
        unit: "msat",
        proof: replacement.proof,
        asset: { kind: "regular" },
        receivedAtMs: 1,
      }),
    );
    await expect(admitBrowserEncryptedWalletBackupV2Asset(fixture.input)).rejects.toThrow(
      /local custody is partial/,
    );
  });

  it("merges only missing proofs from a verified newer backup revision", async () => {
    const fixture = await createFixture(1);
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2Asset({
      ...fixture.input,
      custodyRevision: 6n,
    });
    const expanded = await createVerified(2);

    await admitBrowserEncryptedWalletBackupV2Asset({
      ...fixture.input,
      verified: expanded,
      custodyRevision: 7n,
      sourceOperationId: "backup-v2-restore:newer-bundle",
    });

    expect(await database.custodyProofs.count()).toBe(2);
    expect(await database.custodyOperations.count()).toBe(2);
    await expectDesired(database, fixture, 2);
  });

  it("rejects a newer backup that does not contain current local custody", async () => {
    const fixture = await createFixture(1);
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2Asset({
      ...fixture.input,
      custodyRevision: 6n,
    });
    const foreign = await createVerified(2, { counterOffset: 10 });

    await expect(
      admitBrowserEncryptedWalletBackupV2Asset({
        ...fixture.input,
        verified: foreign,
        custodyRevision: 7n,
        sourceOperationId: "backup-v2-restore:foreign-bundle",
      }),
    ).rejects.toThrow(/desired authority conflicts/);

    expect(await database.custodyProofs.count()).toBe(1);
  });

  it("rejects foreign mint and BLS counter authority at direct admission", async () => {
    const fixture = await createFixture(1);
    database = fixture.database;
    await expect(
      admitBrowserEncryptedWalletBackupV2Asset({
        ...fixture.input,
        wallet: {
          ...fixture.input.wallet,
          mint: { mintUrl: "https://other-mint.example" },
        } as CashuWallet,
      }),
    ).rejects.toThrow(/restore mint is foreign/);

    const withBlsCounter = await createVerified(1, {
      extraCounterKeysetId: `02${"33".repeat(32)}`,
    });
    await expect(
      admitBrowserEncryptedWalletBackupV2Asset({
        ...fixture.input,
        verified: withBlsCounter,
      }),
    ).rejects.toThrow(/BLS keyset is unsupported/);
    expect(await database.custodyProofs.count()).toBe(0);
  });

  it("restores an evicted maximum-size acknowledged asset without count overflow", async () => {
    const fixture = await createFixture(512);
    database = fixture.database;
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.input.asset,
      custodyRevision: fixture.input.custodyRevision,
      activeProofCount: 512,
    });
    await database.encryptedWalletBackupV2DesiredAssets.put({
      ...desired,
      syncState: "acknowledged",
    });

    await admitBrowserEncryptedWalletBackupV2Asset(fixture.input);

    expect(await database.custodyProofs.count()).toBe(512);
    expect(await database.custodyOperations.count()).toBe(16);
    await expectDesired(database, fixture, 512);
  }, 30_000);

  it("rejects a stale profile before writing authority", async () => {
    const fixture = await createFixture(1);
    database = fixture.database;

    await expect(
      admitBrowserEncryptedWalletBackupV2Asset({
        ...fixture.input,
        isCurrentProfile: () => false,
      }),
    ).rejects.toThrow(/profile is stale/);
    expect(await database.custodyProofs.count()).toBe(0);
  });

  it("rejects structurally forged verification evidence", async () => {
    const fixture = await createFixture(1);
    database = fixture.database;

    await expect(
      admitBrowserEncryptedWalletBackupV2Asset({
        ...fixture.input,
        verified: { ...fixture.input.verified },
      }),
    ).rejects.toThrow(/verified proof set is invalid/);
    expect(await database.custodyProofs.count()).toBe(0);
  });
});

async function createFixture(
  count: number,
  asset: EncryptedWalletBackupV2ProofSetAsset = { kind: "ordinary" },
  options: {
    readonly sealedIndices?: readonly number[];
    readonly proofAssets?: readonly EncryptedWalletBackupV2ProofSetAsset[];
  } = {},
) {
  const scopeId = browserWalletScope(SEED).scopeId;
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  const unit: "msat" = "msat";
  const verified = await createVerified(count, { asset, ...options });
  const identity = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit,
    asset,
  });
  return {
    database,
    scopeId,
    input: {
      seed: SEED,
      verified,
      asset: identity,
      custodyRevision: 7n,
      sourceOperationId: "backup-v2-restore:bundle",
      wallet: wallet(asset, unit),
      database,
      scopeId,
      isCurrentProfile: () => true,
      lockManager: immediateLockManager(),
    },
  };
}

async function createVerified(
  count: number,
  options: {
    readonly asset?: EncryptedWalletBackupV2ProofSetAsset;
    readonly counterOffset?: number;
    readonly extraCounterKeysetId?: string;
    readonly sealedIndices?: readonly number[];
    readonly proofAssets?: readonly EncryptedWalletBackupV2ProofSetAsset[];
  } = {},
): Promise<EncryptedWalletBackupV2VerifiedProofSet> {
  const asset = options.asset ?? { kind: "ordinary" };
  const unit: "msat" = "msat";
  const keysetId = asset.kind === "ctf" ? CONDITIONAL_KEYSET_ID : KEYSET_ID;
  const counterOffset = options.counterOffset ?? 0;
  const sealedIndices = new Set(options.sealedIndices ?? []);
  const proofs = Array.from({ length: count }, (_, index) => {
    const proofAsset = options.proofAssets?.[index] ?? asset;
    const locator = locatorFor(proofAsset, keysetId, index + counterOffset);
    const proof = {
      id: keysetId,
      amount: Amount.from(1),
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator,
        proofKeysetId: keysetId,
        proofAmount: 1,
      }),
      C: PUBLIC_KEY,
    };
    const entry = {
      mintUrl: MINT,
      unit,
      asset: proofAsset,
      proof,
      locator,
      proofId: deriveDurableCustodyProofId({
        scopeId: browserWalletScope(SEED).scopeId,
        normalizedMint: MINT,
        unit,
        keysetId,
        secret: proof.secret,
      }),
    };
    if (!sealedIndices.has(index)) return entry;
    return {
      ...entry,
      terminalSeal: {
        schemaVersion: 1 as const,
        kind: "ctf-verified-losing" as const,
        operationIdDigest: `${String(index + 1).padStart(2, "0")}`.repeat(32),
        requestDigest: `${String(index + 3).padStart(2, "0")}`.repeat(32),
        code: 13015 as const,
        classifiedAtMs: 1_000 + index,
        proofCommitment: digestEncryptedWalletBackupV2TerminalProofCommitment(entry),
      },
    };
  });
  const counterHighWaterMarks = [
    ...(asset.kind === "ordinary"
      ? [{ mintUrl: MINT, unit, keysetId: KEYSET_ID, nextCounter: count + counterOffset }]
      : []),
    ...(options.extraCounterKeysetId === undefined
      ? []
      : [
          {
            mintUrl: MINT,
            unit,
            keysetId: options.extraCounterKeysetId,
            nextCounter: 1,
          },
        ]),
  ];
  let unverified: EncryptedWalletBackupV2UnverifiedProofSet = {
    proofs,
    counterHighWaterMarks,
  };
  if (sealedIndices.size > 0) {
    const identity = createEncryptedWalletBackupV2AssetIdentity({ mintUrl: MINT, unit, asset });
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
      seed: SEED,
      realm: "backup.production",
      runtime: { subtle: crypto.subtle },
    });
    const payload = encodeCanonicalBackupCbor([
      2,
      "encrypted-wallet-backup-v2-proof-set",
      proofs.map((entry) => [
        entry.mintUrl,
        entry.unit,
        entry.asset.kind === "ordinary"
          ? [0]
          : [
              1,
              entry.asset.conditionId,
              entry.asset.outcomeLabel,
              entry.asset.outcomeCollectionId,
              entry.asset.registeredAt,
              entry.asset.finalExpiry,
            ],
        serializeDurableCustodyProofArtifact(entry.proof),
        encodeDurableWalletProofDerivationLocatorCbor(entry.locator),
        "terminalSeal" in entry
          ? [
              entry.terminalSeal.schemaVersion,
              entry.terminalSeal.kind,
              entry.terminalSeal.operationIdDigest,
              entry.terminalSeal.requestDigest,
              entry.terminalSeal.code,
              entry.terminalSeal.classifiedAtMs,
              entry.terminalSeal.proofCommitment,
            ]
          : null,
      ]),
      counterHighWaterMarks.map((mark) => [
        mark.mintUrl,
        mark.unit,
        mark.keysetId,
        mark.nextCounter,
      ]),
    ]);
    const runtime = {
      subtle: crypto.subtle,
      getRandomValues: (target: Uint8Array) => crypto.getRandomValues(target),
    };
    const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
      keyHandle,
      asset: identity,
      declaredAmount: BigInt(count),
      custodyRevision: 7n,
      canonicalPayload: payload,
      runtime,
    });
    unverified = await decryptEncryptedWalletBackupV2ProofSetBundle({
      keyHandle,
      seed: SEED,
      expectedAsset: identity,
      custodyRevision: 7n,
      runtime,
      ...prepared,
    });
  }
  return verifyEncryptedWalletBackupV2RestoredProofSet({
    seed: SEED,
    expectedAsset: createEncryptedWalletBackupV2AssetIdentity({ mintUrl: MINT, unit, asset }),
    unverified,
    port: {
      async resolveKeyset({ mintUrl, unit: keysetUnit, keysetId }) {
        return {
          mintUrl,
          unit: keysetUnit,
          keysetId,
          keyset: {},
          requireDleq: true,
          verify: () => true,
        };
      },
      verifyProofs: () => undefined,
      checkProofStates: async ({ proofs: checked }) =>
        checked.map(({ proofId }) => ({ proofId, state: "UNSPENT" })),
    },
  });
}

function locatorFor(
  asset: EncryptedWalletBackupV2ProofSetAsset,
  keysetId: string,
  index: number,
): DurableWalletProofDerivationLocator {
  return asset.kind === "ordinary"
    ? { schemaVersion: 1, kind: "nut13", keysetId, counter: index }
    : {
        schemaVersion: 1,
        kind: "ctf-range-manifest",
        rangeOperationId: "range-operation",
        manifestIndex: index,
      };
}

function wallet(asset: EncryptedWalletBackupV2ProofSetAsset, unit: "msat"): CashuWallet {
  const conditional =
    asset.kind === "ctf"
      ? {
          conditionId: asset.conditionId,
          outcomeCollection: asset.outcomeLabel,
          outcomeCollectionId: asset.outcomeCollectionId,
          registeredAt: asset.registeredAt,
        }
      : undefined;
  const keyset = new Keyset(
    asset.kind === "ctf" ? CONDITIONAL_KEYSET_ID : KEYSET_ID,
    unit,
    true,
    0,
    asset.kind === "ctf" && asset.finalExpiry !== null ? asset.finalExpiry : undefined,
    conditional,
  );
  keyset.keys = { 1: PUBLIC_KEY };
  return {
    mint: { mintUrl: MINT },
    getKeyset: () => keyset,
  } as unknown as CashuWallet;
}

function immediateLockManager(): Pick<LockManager, "request"> {
  return {
    request: async <T>(_name: string, _options: LockOptions, callback: LockGrantedCallback<T>) =>
      callback(null),
  } as Pick<LockManager, "request">;
}

async function expectDesired(
  database: BitcasterDB,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  activeProofCount: number,
): Promise<void> {
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: fixture.scopeId,
    asset: fixture.input.asset,
    custodyRevision: fixture.input.custodyRevision,
    activeProofCount,
  });
  await expect(
    database.encryptedWalletBackupV2DesiredAssets.get([fixture.scopeId, desired.localAssetKey]),
  ).resolves.toEqual({ ...desired, syncState: "acknowledged" });
}
