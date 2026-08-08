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
  createEncryptedWalletBackupV2AssetIdentity,
  verifyEncryptedWalletBackupV2RestoredProofSet,
  type EncryptedWalletBackupV2ProofSetAsset,
  type EncryptedWalletBackupV2VerifiedProofSet,
} from "@bitcaster/client-sdk";
import { deriveDurableCustodyProofId } from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  deriveDurableWalletProofSecret,
  type DurableWalletProofDerivationLocator,
} from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { afterEach, describe, expect, it } from "vitest";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { BitcasterDB } from "../../stores/proof-db";
import { admitBrowserEncryptedWalletBackupV2Asset } from "../browserEncryptedWalletBackupV2Admission";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import { browserWalletDatabaseName } from "../browserWalletProfile";

const SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
const MINT = "https://mint.example";
const PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const KEYSET_ID = deriveKeysetId({ 1: PUBLIC_KEY }, { unit: "sat", versionByte: 1 });
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
      await database.walletCounterAssociations.get([fixture.scopeId, MINT, "sat", KEYSET_ID]),
    ).toMatchObject({ recoveryComplete: true });
    expect(await database.walletCounterCursors.get([fixture.scopeId, KEYSET_ID])).toEqual({
      scopeId: fixture.scopeId,
      keysetId: KEYSET_ID,
      next: 65,
    });
    await expectDesired(database, fixture, 65);
  });

  it("admits an exact CTF range-manifest locator and conditional keyset authority", async () => {
    const fixture = await createFixture(1, CTF_ASSET);
    database = fixture.database;

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
        unit: "sat",
        proof: replacement.proof,
        asset: { kind: "regular" },
        receivedAtMs: 1,
      }),
    );
    await expect(admitBrowserEncryptedWalletBackupV2Asset(fixture.input)).rejects.toThrow(
      /local custody is partial/,
    );
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
) {
  const scopeId = browserWalletScope(SEED).scopeId;
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  const unit: "sat" | "msat" = asset.kind === "ctf" ? "msat" : "sat";
  const verified = await createVerified(count, { asset });
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
  } = {},
): Promise<EncryptedWalletBackupV2VerifiedProofSet> {
  const asset = options.asset ?? { kind: "ordinary" };
  const unit: "sat" | "msat" = asset.kind === "ctf" ? "msat" : "sat";
  const keysetId = asset.kind === "ctf" ? CONDITIONAL_KEYSET_ID : KEYSET_ID;
  const counterOffset = options.counterOffset ?? 0;
  const proofs = Array.from({ length: count }, (_, index) => {
    const locator = locatorFor(asset, keysetId, index + counterOffset);
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
    return {
      mintUrl: MINT,
      unit,
      asset,
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
  });
  const unverified = {
    proofs,
    counterHighWaterMarks:
      asset.kind === "ordinary"
        ? [{ mintUrl: MINT, unit, keysetId: KEYSET_ID, nextCounter: count + counterOffset }]
        : [],
  };
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

function wallet(asset: EncryptedWalletBackupV2ProofSetAsset, unit: "sat" | "msat"): CashuWallet {
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
