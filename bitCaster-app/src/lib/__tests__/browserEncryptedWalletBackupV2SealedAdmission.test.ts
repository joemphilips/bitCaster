// @vitest-environment node
import "fake-indexeddb/auto";
import { Amount, deriveConditionalKeysetId } from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2KeyHandle,
  decryptEncryptedWalletBackupV2ProofSetBundle,
  digestEncryptedWalletBackupV2TerminalProofCommitment,
  encodeDurableWalletProofDerivationLocatorCbor,
  prepareEncryptedWalletBackupV2TransportBundle,
  verifyEncryptedWalletBackupV2RestoredProofSet,
  type EncryptedWalletBackupV2ProofSetAsset,
} from "@bitcaster/client-sdk";
import { deriveDurableCustodyProofId } from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { serializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../../stores/durable-custody-db";
import {
  activateBrowserWalletDatabase,
  BitcasterDB,
  db,
  getProofs,
  storedProofRow,
} from "../../stores/proof-db";
import { admitBrowserEncryptedWalletBackupV2SealedAsset } from "../browserEncryptedWalletBackupV2Admission";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import { browserWalletDatabaseName } from "../browserWalletProfile";

const SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
const MINT = "https://mint.example";
const PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const CONDITION_ID = "55".repeat(32);
const COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: "YES",
});
const KEYSET_ID = deriveConditionalKeysetId({
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

describe("browser V2 sealed proof admission", () => {
  let database: BitcasterDB | null = null;
  let globalDatabaseActive = false;

  afterEach(async () => {
    if (globalDatabaseActive) {
      db.close();
      globalDatabaseActive = false;
    }
    database?.close();
    if (database) await indexedDB.deleteDatabase(database.name);
    database = null;
  });

  it("restores sealed CTF proofs without mint calls or a keyset row", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await putLegacyCache(fixture);

    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);

    const proofRows = await database.custodyProofs.toArray();
    const authorityRows = await database.custodyProofBackupAuthorities.toArray();
    expect(proofRows).toHaveLength(2);
    expect(proofRows.every((row) => row.selectability === "verified-losing")).toBe(true);
    expect(authorityRows).toHaveLength(2);
    expect(authorityRows.every((row) => row.backupState === "remote-backed")).toBe(true);
    expect(authorityRows.every((row) => row.terminalAuthority?.kind === "remote-seal")).toBe(true);
    expect(authorityRows.map((row) => row.backupRecordId).sort()).toEqual(
      fixture.verified.proofs.map(({ proofId }) => proofId).sort(),
    );
    expect(authorityRows.map((row) => row.backupRecordCommitment).sort()).toEqual(
      fixture.verified.proofs.map(({ terminalSeal }) => terminalSeal!.proofCommitment).sort(),
    );
    expect(await database.custodyConditionalKeysets.count()).toBe(0);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.proofs.count()).toBe(0);
    expect(
      await database.walletCounterAssociations.get([fixture.scopeId, MINT, "msat", KEYSET_ID]),
    ).toMatchObject({ recoveryComplete: true });
    expect(await database.walletCounterCursors.get([fixture.scopeId, KEYSET_ID])).toEqual({
      scopeId: fixture.scopeId,
      keysetId: KEYSET_ID,
      next: 5,
    });
    const desired = await database.encryptedWalletBackupV2DesiredAssets.toArray();
    expect(desired).toHaveLength(1);
    expect(desired[0]).toMatchObject({
      custodyRevision: "7",
      activeProofCount: 2,
      desiredAction: "replace",
      syncState: "acknowledged",
      terminalCtfContext: {
        conditionId: CONDITION_ID,
        outcomeLabel: "YES",
        outcomeCollectionId: COLLECTION_ID,
        registeredAt: 10,
        finalExpiry: 20,
      },
    });

    const adapter = new BrowserDurableCustodyAdapter(database);
    await expect(
      adapter.readProof(fixture.scopeId, fixture.verified.proofs[0]!.proofId),
    ).resolves.toMatchObject({ selectability: "verified-losing" });
    await expect(
      adapter.claimScope(browserWalletScope(SEED), {
        incarnationId: "origin-loss-test",
        observedAtMs: 2_000,
        leaseExpiresAtMs: 3_000,
      }),
    ).resolves.toMatchObject({ incarnationId: "origin-loss-test" });
  });

  it("allows only an exact idempotent replay", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);
    const beforeProofs = await database.custodyProofs.toArray();
    const beforeAuthorities = await database.custodyProofBackupAuthorities.toArray();
    const beforeDesired = await database.encryptedWalletBackupV2DesiredAssets.toArray();

    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);

    expect(await database.custodyProofs.toArray()).toEqual(beforeProofs);
    expect(await database.custodyProofBackupAuthorities.toArray()).toEqual(beforeAuthorities);
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toEqual(beforeDesired);
  });

  it("admits a fresh asset when its keyset counter is shared with another asset", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await database.walletCounterAssociations.put({
      scopeId: fixture.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: KEYSET_ID,
      recoveryComplete: true,
    });
    await database.walletCounterCursors.put({
      scopeId: fixture.scopeId,
      keysetId: KEYSET_ID,
      next: 9,
    });

    await expect(
      admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input),
    ).resolves.toBeUndefined();
    expect(await database.custodyProofs.count()).toBe(2);
    expect(await database.walletCounterCursors.get([fixture.scopeId, KEYSET_ID])).toEqual({
      scopeId: fixture.scopeId,
      keysetId: KEYSET_ID,
      next: 9,
    });
  });

  it("rejects a full CTF tuple mismatch before writing any authority", async () => {
    const fixture = await sealedFixture({
      assets: [CTF_ASSET, { ...CTF_ASSET, finalExpiry: 21 }],
    });
    database = fixture.database;

    await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
      /CTF tuple conflicts/,
    );
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(await database.walletCounterAssociations.count()).toBe(0);
  });

  it.each(["selectable", "spent"] as const)(
    "rejects an existing canonical %s proof in the target asset",
    async (selectability) => {
      const fixture = await sealedFixture();
      database = fixture.database;
      const entry = fixture.verified.proofs[0]!;
      const row = createBrowserCustodyProofRow({
        scopeId: fixture.scopeId,
        normalizedMint: MINT,
        unit: "msat",
        proof: entry.proof,
        asset: { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: "YES" },
        receivedAtMs: 1_000,
      });
      await database.custodyProofs.put({ ...row, selectability, reservationOperationId: null });

      await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
        /local custody conflicts/,
      );
      expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
      expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    },
  );

  it("rolls back proof, authority, desired context, counters, and cache together", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await putLegacyCache(fixture);

    await expect(
      admitBrowserEncryptedWalletBackupV2SealedAsset({
        ...fixture.input,
        fault: "before-commit",
      }),
    ).rejects.toThrow(/injected commit fault/);
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(await database.walletCounterAssociations.count()).toBe(0);
    expect(await database.walletCounterCursors.count()).toBe(0);
    expect(await database.proofs.count()).toBe(2);
    expect(await database.custodyScopes.count()).toBe(0);
  });

  it("fails closed when the desired state loses exact proof authority", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);
    await database.custodyProofBackupAuthorities.delete([
      fixture.scopeId,
      fixture.verified.proofs[0]!.proofId,
    ]);

    await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
      /authority is incomplete/,
    );
    expect(await database.custodyProofBackupAuthorities.count()).toBe(1);
  });

  it("fails closed when exact proof authority remains but desired state is lost", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);
    const desired = (await database.encryptedWalletBackupV2DesiredAssets.toArray())[0]!;
    await database.encryptedWalletBackupV2DesiredAssets.delete([
      fixture.scopeId,
      desired.localAssetKey,
    ]);

    await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
      /state is incomplete/,
    );
  });

  it("rejects a foreign same-secret legacy cache row", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    const entry = fixture.verified.proofs[0]!;
    await database.proofs.put(
      storedProofRow({
        ...entry.proof,
        mintUrl: MINT,
        baseAsset: "sat",
        unit: "msat",
        conditionId: CONDITION_ID,
        outcomeCollection: "NO",
      }),
    );

    await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
      /legacy cache conflicts/,
    );
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.proofs.count()).toBe(1);
  });

  it("removes an exact stale cache row with an empty reservation marker", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    const entry = fixture.verified.proofs[0]!;
    await database.proofs.put(
      storedProofRow({
        ...entry.proof,
        mintUrl: MINT,
        baseAsset: "sat",
        unit: "msat",
        conditionId: CONDITION_ID,
        outcomeCollection: "YES",
        reservedBy: "",
      }),
    );

    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);
    expect(await database.proofs.get(entry.proof.secret)).toBeUndefined();

    activateBrowserWalletDatabase(fixture.scopeId);
    globalDatabaseActive = true;
    await expect(getProofs(MINT)).resolves.toHaveLength(0);
  });
});

async function sealedFixture(
  options: { readonly assets?: readonly EncryptedWalletBackupV2ProofSetAsset[] } = {},
) {
  const assets = options.assets ?? [CTF_ASSET, CTF_ASSET];
  const ctfAssets = assets.map((asset) => {
    if (asset.kind !== "ctf") throw new Error("test asset is not CTF");
    return asset;
  });
  const entries = ctfAssets.map((asset, index) => {
    const locator = {
      schemaVersion: 1 as const,
      kind: "ctf-range-manifest" as const,
      rangeOperationId: "range-operation",
      manifestIndex: index,
    };
    const proof = {
      id: KEYSET_ID,
      amount: Amount.from(1),
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator,
        proofKeysetId: KEYSET_ID,
        proofAmount: 1,
      }),
      C: PUBLIC_KEY,
    };
    const entry = {
      mintUrl: MINT,
      unit: "msat" as const,
      asset,
      proof,
      locator,
      proofId: deriveDurableCustodyProofId({
        scopeId: browserWalletScope(SEED).scopeId,
        normalizedMint: MINT,
        unit: "msat",
        keysetId: KEYSET_ID,
        secret: proof.secret,
      }),
    };
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
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset: CTF_ASSET,
  });
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: "backup.production",
    runtime: { subtle: crypto.subtle },
  });
  const payload = encodeCanonicalBackupCbor([
    2,
    "encrypted-wallet-backup-v2-proof-set",
    entries.map((entry) => [
      entry.mintUrl,
      entry.unit,
      [
        1,
        entry.asset.conditionId,
        entry.asset.outcomeLabel,
        entry.asset.outcomeCollectionId,
        entry.asset.registeredAt,
        entry.asset.finalExpiry,
      ],
      serializeDurableCustodyProofArtifact(entry.proof),
      encodeDurableWalletProofDerivationLocatorCbor(entry.locator),
      [
        entry.terminalSeal.schemaVersion,
        entry.terminalSeal.kind,
        entry.terminalSeal.operationIdDigest,
        entry.terminalSeal.requestDigest,
        entry.terminalSeal.code,
        entry.terminalSeal.classifiedAtMs,
        entry.terminalSeal.proofCommitment,
      ],
    ]),
    [[MINT, "msat", KEYSET_ID, 5]],
  ]);
  const runtime = {
    subtle: crypto.subtle,
    getRandomValues: (target: Uint8Array) => crypto.getRandomValues(target),
  };
  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset,
    declaredAmount: BigInt(entries.length),
    custodyRevision: 7n,
    canonicalPayload: payload,
    runtime,
  });
  const unverified = await decryptEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    expectedAsset: asset,
    custodyRevision: 7n,
    runtime,
    ...prepared,
  });
  const verified = await verifyEncryptedWalletBackupV2RestoredProofSet({
    seed: SEED,
    expectedAsset: asset,
    unverified,
    port: {
      resolveKeyset: async () => {
        throw new Error("mint keyset must not be requested");
      },
      verifyProofs: () => {
        throw new Error("mint proof verification must not be requested");
      },
      checkProofStates: async () => {
        throw new Error("NUT-07 must not be requested");
      },
    },
  });
  const scopeId = browserWalletScope(SEED).scopeId;
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  return {
    database,
    scopeId,
    verified,
    input: {
      seed: SEED,
      verified,
      asset,
      custodyRevision: 7n,
      sourceOperationId: "origin-loss-restore",
      database,
      scopeId,
      isCurrentProfile: () => true,
      lockManager: immediateLockManager(),
    },
  };
}

async function putLegacyCache(fixture: Awaited<ReturnType<typeof sealedFixture>>): Promise<void> {
  for (const entry of fixture.verified.proofs) {
    await fixture.database.proofs.put(
      storedProofRow({
        ...entry.proof,
        mintUrl: MINT,
        baseAsset: "sat",
        unit: "msat",
        conditionId: CONDITION_ID,
        outcomeCollection: "YES",
      }),
    );
  }
}

function immediateLockManager(): Pick<LockManager, "request"> {
  return {
    request: async <T>(_name: string, _options: LockOptions, callback: LockGrantedCallback<T>) =>
      callback(null),
  } as Pick<LockManager, "request">;
}
