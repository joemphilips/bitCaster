// @vitest-environment node
import "fake-indexeddb/auto";
import { deriveConditionalKeysetId } from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2KeyHandle,
  decryptEncryptedWalletBackupV2ProofSetBundle,
  deriveDurableCustodyScopeId,
  deriveRootCtfOutcomeCollectionId,
} from "@bitcaster/client-sdk";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserWalletDatabaseName } from "../../lib/browserWalletProfile";
import { createBrowserProofBackupAuthorityRow } from "../browser-proof-backup-authority";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../browser-encrypted-wallet-backup-v2-desired-asset";
import {
  prepareBrowserEncryptedWalletBackupV2AssetBundle,
  readBrowserEncryptedWalletBackupV2AssetSnapshot,
} from "../browser-encrypted-wallet-backup-v2-asset-source";
import { createBrowserCustodyProofRow } from "../durable-custody-db";
import { BitcasterDB } from "../proof-db";

const MINT = "https://mint.example";
const PUBLIC_KEY = `02${"22".repeat(32)}`;
const REGULAR_KEYSET = `01${"33".repeat(32)}`;
const CONDITION_ID = "ab".repeat(32);
const OUTCOME = "YES";
const SEED = new Uint8Array(64).fill(17);
const OUTCOME_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME,
});
const CONDITIONAL_KEYSET = deriveConditionalKeysetId({
  keys: { "1": PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 100,
  final_expiry: 100,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_ID,
});
const CONDITIONAL_KEYSET_WITHOUT_FINAL_EXPIRY = deriveConditionalKeysetId({
  keys: { "1": PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 100,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_ID,
});
let database: BitcasterDB | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  database?.close();
  if (database) await database.delete();
  database = null;
});

describe("browser V2 asset source", () => {
  it("includes selectable and locked ordinary proofs but excludes spent and CTF proofs", async () => {
    const fixture = await fixtureFor("ordinary");
    database = fixture.database;
    const selectable = proofRow(fixture.scopeId, REGULAR_KEYSET, 1, "regular", "selectable");
    const locked = proofRow(fixture.scopeId, REGULAR_KEYSET, 2, "regular", "locked");
    const spent = proofRow(fixture.scopeId, REGULAR_KEYSET, 3, "regular", "spent");
    const ctf = proofRow(fixture.scopeId, CONDITIONAL_KEYSET, 4, "ctf", "selectable");
    await putProofs(fixture.database, [selectable, locked, spent, ctf]);
    await putCounter(fixture.database, fixture.scopeId, REGULAR_KEYSET, 4);
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 7n,
      activeProofCount: 2,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);

    const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
      database: fixture.database,
      scopeId: fixture.scopeId,
      localAssetKey: desired.localAssetKey,
    });

    expect(snapshot.proofs.map(({ proof }) => proof.secret).sort()).toEqual(
      [selectable, locked].map((row) => proofSecret(row)).sort(),
    );
    expect(snapshot.asset.assetIdentity).toBe("cashu:ordinary");
    expect(snapshot.counterHighWaterMarks).toEqual([
      { mintUrl: MINT, unit: "msat", keysetId: REGULAR_KEYSET, nextCounter: 4 },
    ]);
  });

  it("excludes a transient locked proof without stopping an ordinary asset snapshot", async () => {
    const fixture = await fixtureFor("ordinary");
    database = fixture.database;
    const selectable = proofRow(fixture.scopeId, REGULAR_KEYSET, 1, "regular", "selectable");
    const transient = proofRow(fixture.scopeId, REGULAR_KEYSET, 2, "regular", "locked");
    await fixture.database.custodyProofs.bulkPut([selectable, transient]);
    await fixture.database.custodyProofBackupAuthorities.bulkPut([
      authority(selectable),
      createBrowserProofBackupAuthorityRow(transient, 2, null, "order:preparation"),
    ]);
    await putCounter(fixture.database, fixture.scopeId, REGULAR_KEYSET, 3);
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 7n,
      activeProofCount: 1,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);

    const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
      database: fixture.database,
      scopeId: fixture.scopeId,
      localAssetKey: desired.localAssetKey,
    });

    expect(snapshot.proofs.map(({ proof }) => proof.secret)).toEqual([proofSecret(selectable)]);
  });

  it("binds a CTF snapshot to verified conditional keyset authority", async () => {
    const fixture = await fixtureFor("ctf");
    database = fixture.database;
    const proof = proofRow(fixture.scopeId, CONDITIONAL_KEYSET, 5, "ctf", "selectable");
    await putProofs(fixture.database, [proof]);
    await putConditionalKeyset(fixture.database, fixture.scopeId);
    await putCounter(fixture.database, fixture.scopeId, CONDITIONAL_KEYSET, 6);
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 9n,
      activeProofCount: 1,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);

    const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
      database: fixture.database,
      scopeId: fixture.scopeId,
      localAssetKey: desired.localAssetKey,
    });

    expect(snapshot.asset.assetIdentity).toBe(`ctf:${CONDITION_ID}:${OUTCOME_ID}`);
    expect(snapshot.proofs[0]?.asset).toMatchObject({
      kind: "ctf",
      conditionId: CONDITION_ID,
      outcomeCollectionId: OUTCOME_ID,
    });
  });

  it("backs up a CTF snapshot with an explicit missing final expiry", async () => {
    const fixture = await fixtureFor("ctf");
    database = fixture.database;
    const proof = proofRow(
      fixture.scopeId,
      CONDITIONAL_KEYSET_WITHOUT_FINAL_EXPIRY,
      5,
      "ctf",
      "selectable",
    );
    await putProofs(fixture.database, [proof]);
    await putConditionalKeyset(
      fixture.database,
      fixture.scopeId,
      CONDITIONAL_KEYSET_WITHOUT_FINAL_EXPIRY,
      null,
    );
    await putCounter(fixture.database, fixture.scopeId, CONDITIONAL_KEYSET_WITHOUT_FINAL_EXPIRY, 6);
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: MINT,
      unit: "msat",
      asset: {
        kind: "ctf",
        conditionId: CONDITION_ID,
        outcomeCollectionId: OUTCOME_ID,
        outcomeLabel: OUTCOME,
        registeredAt: 0,
        finalExpiry: null,
      },
    });
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset,
      custodyRevision: 9n,
      activeProofCount: 1,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);

    const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
      database: fixture.database,
      scopeId: fixture.scopeId,
      localAssetKey: desired.localAssetKey,
    });

    expect(snapshot.proofs[0]?.asset).toMatchObject({ kind: "ctf", finalExpiry: null });
  });

  it("backs up complete change and unspent siblings after a partial spend", async () => {
    const fixture = await fixtureFor("ordinary");
    database = fixture.database;
    const change = deterministicProofRow(fixture.scopeId, 0, "selectable");
    const sibling = deterministicProofRow(fixture.scopeId, 1, "locked");
    const spent = deterministicProofRow(fixture.scopeId, 2, "spent");
    await fixture.database.custodyProofs.bulkPut([change, sibling, spent]);
    await fixture.database.custodyProofBackupAuthorities.bulkPut(
      [change, sibling, spent].map((row, counter) =>
        createBrowserProofBackupAuthorityRow(
          row,
          2,
          { schemaVersion: 1, kind: "nut13", keysetId: REGULAR_KEYSET, counter },
          `partial:${counter}`,
        ),
      ),
    );
    await putCounter(fixture.database, fixture.scopeId, REGULAR_KEYSET, 3);
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 4n,
      activeProofCount: 2,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);
    const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
      database: fixture.database,
      scopeId: fixture.scopeId,
      localAssetKey: desired.localAssetKey,
    });
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
      seed: SEED,
      realm: "backup.example",
      runtime: { subtle: crypto.subtle },
    });

    const prepared = await prepareBrowserEncryptedWalletBackupV2AssetBundle({
      snapshot,
      keyHandle,
      seed: SEED,
      runtime: { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto) },
    });
    const restored = await decryptEncryptedWalletBackupV2ProofSetBundle({
      keyHandle,
      seed: SEED,
      expectedAsset: snapshot.asset,
      custodyRevision: 4n,
      runtime: { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto) },
      ...prepared,
    });

    expect(restored.proofs.map(({ proof }) => proof.secret).sort()).toEqual(
      [proofSecret(change), proofSecret(sibling)].sort(),
    );
    expect(restored.proofs.map(({ proof }) => proof.secret)).not.toContain(proofSecret(spent));
  });

  it("fails closed when exact proof derivation or counter authority is missing", async () => {
    const fixture = await fixtureFor("ordinary");
    database = fixture.database;
    const proof = proofRow(fixture.scopeId, REGULAR_KEYSET, 1, "regular", "selectable");
    await fixture.database.custodyProofs.put(proof);
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);

    await expect(
      readBrowserEncryptedWalletBackupV2AssetSnapshot({
        database: fixture.database,
        scopeId: fixture.scopeId,
        localAssetKey: desired.localAssetKey,
      }),
    ).rejects.toThrow(/backup authority is missing/);

    await fixture.database.custodyProofBackupAuthorities.put(authority(proof));
    await expect(
      readBrowserEncryptedWalletBackupV2AssetSnapshot({
        database: fixture.database,
        scopeId: fixture.scopeId,
        localAssetKey: desired.localAssetKey,
      }),
    ).rejects.toThrow(/counter authority is missing/);
  });

  it("fails closed when an eligible proof has foreign backup authority", async () => {
    const fixture = await fixtureFor("ordinary");
    database = fixture.database;
    const proof = proofRow(fixture.scopeId, REGULAR_KEYSET, 1, "regular", "locked");
    await fixture.database.custodyProofs.put(proof);
    await fixture.database.custodyProofBackupAuthorities.put({
      ...authority(proof),
      proofFingerprint: "ff".repeat(32),
    });
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);

    await expect(
      readBrowserEncryptedWalletBackupV2AssetSnapshot({
        database: fixture.database,
        scopeId: fixture.scopeId,
        localAssetKey: desired.localAssetKey,
      }),
    ).rejects.toThrow(/backup authority is foreign/);
  });

  it("reads the 512-proof limit with a fixed number of Dexie requests", async () => {
    const fixture = await fixtureFor("ordinary");
    database = fixture.database;
    const rows = Array.from({ length: 512 }, (_value, index) =>
      largeProofRow(fixture.scopeId, index + 1),
    );
    await fixture.database.custodyProofs.bulkPut(rows);
    await fixture.database.custodyProofBackupAuthorities.bulkPut(
      rows.map((row, index) =>
        createBrowserProofBackupAuthorityRow(
          row,
          2,
          {
            schemaVersion: 1,
            kind: "nut13",
            keysetId: row.keysetId,
            counter: index + 1,
          },
          `receive:${index + 1}`,
        ),
      ),
    );
    await putCounter(fixture.database, fixture.scopeId, REGULAR_KEYSET, 513);
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 1n,
      activeProofCount: 512,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);
    const authorityBulkGet = vi.spyOn(fixture.database.custodyProofBackupAuthorities, "bulkGet");
    const authorityGet = vi.spyOn(fixture.database.custodyProofBackupAuthorities, "get");
    const associationBulkGet = vi.spyOn(fixture.database.walletCounterAssociations, "bulkGet");
    const associationGet = vi.spyOn(fixture.database.walletCounterAssociations, "get");
    const cursorBulkGet = vi.spyOn(fixture.database.walletCounterCursors, "bulkGet");
    const cursorGet = vi.spyOn(fixture.database.walletCounterCursors, "get");

    const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
      database: fixture.database,
      scopeId: fixture.scopeId,
      localAssetKey: desired.localAssetKey,
    });

    expect(snapshot.proofs).toHaveLength(512);
    expect(authorityBulkGet).toHaveBeenCalledTimes(1);
    expect(associationBulkGet).toHaveBeenCalledTimes(1);
    expect(cursorBulkGet).toHaveBeenCalledTimes(1);
    expect(authorityGet).not.toHaveBeenCalled();
    expect(associationGet).not.toHaveBeenCalled();
    expect(cursorGet).not.toHaveBeenCalled();
  });

  it("reads 512 CTF proofs across 16 keysets with one keyset query", async () => {
    const fixture = await fixtureFor("ctf");
    database = fixture.database;
    const keysets = Array.from({ length: 16 }, (_value, index) => conditionalKeyset(index));
    const rows = keysets.flatMap((keyset, keysetIndex) =>
      Array.from({ length: 32 }, (_value, counter) =>
        largeCtfProofRow(fixture.scopeId, keyset.keysetId, keysetIndex * 32 + counter + 1),
      ),
    );
    await fixture.database.custodyConditionalKeysets.bulkPut(
      keysets.map((keyset) => ({ ...keyset, scopeId: fixture.scopeId })),
    );
    await fixture.database.custodyProofs.bulkPut(rows);
    await fixture.database.custodyProofBackupAuthorities.bulkPut(
      rows.map((row, index) =>
        createBrowserProofBackupAuthorityRow(
          row,
          2,
          {
            schemaVersion: 1,
            kind: "nut13",
            keysetId: row.keysetId,
            counter: index % 32,
          },
          `receive:${index + 1}`,
        ),
      ),
    );
    await fixture.database.walletCounterAssociations.bulkPut(
      keysets.map(({ keysetId }) => ({
        scopeId: fixture.scopeId,
        normalizedMint: MINT,
        unit: "msat" as const,
        keysetId,
        recoveryComplete: true,
      })),
    );
    await fixture.database.walletCounterCursors.bulkPut(
      keysets.map(({ keysetId }) => ({ scopeId: fixture.scopeId, keysetId, next: 32 })),
    );
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 1n,
      activeProofCount: 512,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);
    const keysetWhere = vi.spyOn(fixture.database.custodyConditionalKeysets, "where");
    const keysetGet = vi.spyOn(fixture.database.custodyConditionalKeysets, "get");
    const authorityBulkGet = vi.spyOn(fixture.database.custodyProofBackupAuthorities, "bulkGet");

    const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
      database: fixture.database,
      scopeId: fixture.scopeId,
      localAssetKey: desired.localAssetKey,
    });

    expect(snapshot.proofs).toHaveLength(512);
    expect(snapshot.counterHighWaterMarks).toHaveLength(16);
    expect(keysetWhere).toHaveBeenCalledTimes(1);
    expect(keysetGet).not.toHaveBeenCalled();
    expect(authorityBulkGet).toHaveBeenCalledTimes(1);
  });
});

async function fixtureFor(kind: "ordinary" | "ctf") {
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: (kind === "ordinary" ? "71" : "72").repeat(32),
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset:
      kind === "ordinary"
        ? { kind: "ordinary" }
        : {
            kind: "ctf",
            conditionId: CONDITION_ID,
            outcomeCollectionId: OUTCOME_ID,
            outcomeLabel: OUTCOME,
            registeredAt: 0,
            finalExpiry: 100,
          },
  });
  await database.open();
  return { database, scopeId, asset };
}

function proofRow(
  scopeId: string,
  keysetId: string,
  counter: number,
  kind: "regular" | "ctf",
  state: "selectable" | "locked" | "spent",
) {
  const row = createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: {
      id: keysetId,
      amount: 1 as never,
      secret: counter.toString(16).padStart(2, "0").repeat(32),
      C: PUBLIC_KEY,
      dleq: { e: "44".repeat(32), s: "55".repeat(32), r: "66".repeat(32) },
    },
    asset:
      kind === "regular"
        ? { kind: "regular" }
        : { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: OUTCOME },
    receivedAtMs: 1,
  });
  return {
    ...row,
    selectability: state,
    reservationOperationId: state === "locked" ? `lock:${counter}` : null,
  } as const;
}

function largeProofRow(scopeId: string, counter: number) {
  return createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: {
      id: REGULAR_KEYSET,
      amount: 1 as never,
      secret: counter.toString(16).padStart(64, "0"),
      C: PUBLIC_KEY,
      dleq: { e: "44".repeat(32), s: "55".repeat(32), r: "66".repeat(32) },
    },
    asset: { kind: "regular" },
    receivedAtMs: 1,
  });
}

function deterministicProofRow(
  scopeId: string,
  counter: number,
  state: "selectable" | "locked" | "spent",
) {
  const locator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: REGULAR_KEYSET,
    counter,
  };
  const row = createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: {
      id: REGULAR_KEYSET,
      amount: 1 as never,
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator,
        proofKeysetId: REGULAR_KEYSET,
        proofAmount: 1,
      }),
      C: PUBLIC_KEY,
      dleq: { e: "44".repeat(32), s: "55".repeat(32), r: "66".repeat(32) },
    },
    asset: { kind: "regular" },
    receivedAtMs: 1,
  });
  return {
    ...row,
    selectability: state,
    reservationOperationId: state === "locked" ? `partial:${counter}` : null,
  } as const;
}

function largeCtfProofRow(scopeId: string, keysetId: string, proofNumber: number) {
  return createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: {
      id: keysetId,
      amount: 1 as never,
      secret: proofNumber.toString(16).padStart(64, "0"),
      C: PUBLIC_KEY,
      dleq: { e: "44".repeat(32), s: "55".repeat(32), r: "66".repeat(32) },
    },
    asset: { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: OUTCOME },
    receivedAtMs: 1,
  });
}

function conditionalKeyset(index: number) {
  const inputFeePpk = 100 + index;
  return {
    schemaVersion: 1 as const,
    normalizedMint: MINT,
    unit: "msat" as const,
    keysetId: deriveConditionalKeysetId({
      keys: { "1": PUBLIC_KEY },
      unit: "msat",
      input_fee_ppk: inputFeePpk,
      final_expiry: 100,
      conditionId: CONDITION_ID,
      outcomeCollectionId: OUTCOME_ID,
    }),
    denominationPublicKeys: { "1": PUBLIC_KEY },
    inputFeePpk,
    conditionId: CONDITION_ID,
    outcomeCollection: OUTCOME,
    outcomeCollectionId: OUTCOME_ID,
    registeredAtUnixSeconds: 0,
    finalExpiryUnixSeconds: 100,
    curve: "secp256k1" as const,
  };
}

async function putProofs(
  target: BitcasterDB,
  rows: readonly ReturnType<typeof proofRow>[],
): Promise<void> {
  await target.custodyProofs.bulkPut(rows);
  await target.custodyProofBackupAuthorities.bulkPut(rows.map(authority));
}

function authority(row: ReturnType<typeof proofRow>) {
  return createBrowserProofBackupAuthorityRow(
    row,
    2,
    { schemaVersion: 1, kind: "nut13", keysetId: row.keysetId, counter: secretCounter(row) },
    `receive:${secretCounter(row)}`,
  );
}

async function putCounter(
  target: BitcasterDB,
  scopeId: string,
  keysetId: string,
  next: number,
): Promise<void> {
  await target.walletCounterAssociations.put({
    scopeId,
    normalizedMint: MINT,
    unit: "msat",
    keysetId,
    recoveryComplete: true,
  });
  await target.walletCounterCursors.put({ scopeId, keysetId, next });
}

async function putConditionalKeyset(
  target: BitcasterDB,
  scopeId: string,
  keysetId = CONDITIONAL_KEYSET,
  finalExpiryUnixSeconds: number | null = 100,
): Promise<void> {
  await target.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId,
    normalizedMint: MINT,
    unit: "msat",
    keysetId,
    denominationPublicKeys: { "1": PUBLIC_KEY },
    inputFeePpk: 100,
    conditionId: CONDITION_ID,
    outcomeCollection: OUTCOME,
    outcomeCollectionId: OUTCOME_ID,
    registeredAtUnixSeconds: 0,
    finalExpiryUnixSeconds,
    curve: "secp256k1",
  });
}

function proofSecret(row: ReturnType<typeof proofRow>): string {
  return JSON.parse(new TextDecoder().decode(row.proofBody)).secret as string;
}

function secretCounter(row: ReturnType<typeof proofRow>): number {
  return Number.parseInt(proofSecret(row).slice(0, 2), 16);
}
