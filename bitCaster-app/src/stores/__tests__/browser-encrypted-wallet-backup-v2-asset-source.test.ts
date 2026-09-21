// @vitest-environment node
import "fake-indexeddb/auto";
import { deriveConditionalKeysetId, type Proof } from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2KeyHandle,
  decryptEncryptedWalletBackupV2ProofSetBundle,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  deriveRootCtfOutcomeCollectionId,
  deserializeDurableCustodyProofArtifact,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserWalletDatabaseName } from "../../lib/browserWalletProfile";
import {
  classifyBrowserProofBackupAuthorityVerifiedLosing,
  createBrowserProofBackupAuthorityRow,
  createBrowserRemoteProofBackupAuthorityRow,
} from "../browser-proof-backup-authority";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../browser-encrypted-wallet-backup-v2-desired-asset";
import {
  prepareBrowserEncryptedWalletBackupV2AssetBundle,
  readBrowserEncryptedWalletBackupV2AssetSnapshot,
  readBrowserEncryptedWalletBackupV2ExactLocalProofRows,
  readBrowserEncryptedWalletBackupV2LocalAssetRead,
} from "../browser-encrypted-wallet-backup-v2-asset-source";
import { createBrowserCustodyProofRow } from "../durable-custody-db";
import { BrowserDurableCustodyAdapter } from "../durable-custody-db";
import { BrowserEncryptedWalletBackupV2TerminalSealStore } from "../browser-encrypted-wallet-backup-v2-terminal-seal-store";
import {
  decodeBrowserCustodyProofRow,
  type BrowserCustodyProofRow,
} from "../durable-custody-types";
import { BitcasterDB } from "../proof-db";
import { commitBrowserCtfTerminalOperation } from "../../test/browserEncryptedWalletBackupV2CommittedTerminalFixture";

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

  it("validates retained null-locator proof authority before excluding it", async () => {
    const fixture = await fixtureFor("ordinary");
    database = fixture.database;
    const selectable = proofRow(fixture.scopeId, REGULAR_KEYSET, 1, "regular", "selectable");
    const retained = proofRow(fixture.scopeId, REGULAR_KEYSET, 2, "regular", "locked");
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 7n,
      activeProofCount: 1,
    });
    await fixture.database.custodyProofs.bulkPut([selectable, retained]);
    await putCounter(fixture.database, fixture.scopeId, REGULAR_KEYSET, 3);
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);

    for (const invalid of [
      {
        ...createBrowserProofBackupAuthorityRow(retained, 2, null, "order:preparation"),
        proofFingerprint: "ff".repeat(32),
      },
      {
        ...createBrowserProofBackupAuthorityRow(retained, 2, null, "order:preparation"),
        proofRevision: retained.revision + 1,
      },
    ]) {
      await fixture.database.custodyProofBackupAuthorities.bulkPut([
        authority(selectable),
        invalid,
      ]);
      await expect(
        readBrowserEncryptedWalletBackupV2AssetSnapshot({
          database: fixture.database,
          scopeId: fixture.scopeId,
          localAssetKey: desired.localAssetKey,
        }),
      ).rejects.toThrow(/backup authority/);
    }
  });

  it("refuses a selectable null-locator proof", async () => {
    const fixture = await fixtureFor("ordinary");
    database = fixture.database;
    const selectable = proofRow(fixture.scopeId, REGULAR_KEYSET, 1, "regular", "selectable");
    await fixture.database.custodyProofs.put(selectable);
    await fixture.database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(selectable, 2, null, "order:preparation"),
    );

    await expect(
      readBrowserEncryptedWalletBackupV2LocalAssetRead({
        database: fixture.database,
        scopeId: fixture.scopeId,
        asset: fixture.asset,
      }),
    ).rejects.toMatchObject({ code: "snapshot-read" });
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

  it("retains losing CTF bodies with typed origin and preserves complete exact rows", async () => {
    const fixture = await fixtureFor("ctf");
    database = fixture.database;
    const selectable = proofRow(fixture.scopeId, CONDITIONAL_KEYSET, 5, "ctf", "selectable");
    const losing = verifiedLosingProofRow(fixture.scopeId, CONDITIONAL_KEYSET, 6);
    await fixture.database.custodyProofs.bulkPut([selectable, losing]);
    await fixture.database.custodyProofBackupAuthorities.bulkPut([
      authority(selectable),
      verifiedLosingAuthority(losing, "redeem:losing-6"),
    ]);
    await putConditionalKeyset(fixture.database, fixture.scopeId);
    await putCounter(fixture.database, fixture.scopeId, CONDITIONAL_KEYSET, 7);
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 9n,
      activeProofCount: 2,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);

    const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
      database: fixture.database,
      scopeId: fixture.scopeId,
      localAssetKey: desired.localAssetKey,
    });

    expect(snapshot.proofs).toHaveLength(2);
    expect(snapshot.proofs.map(({ proof }) => proof.secret)).toContain(proofSecret(losing));
    expect(snapshot.losingProofs).toHaveLength(1);
    expect(snapshot.losingProofs[0]).toMatchObject({
      proof: { proof: { secret: proofSecret(losing) } },
      origin: { kind: "local-operation", operationId: "redeem:losing-6" },
    });
    await expect(
      readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
        database: fixture.database,
        scopeId: fixture.scopeId,
        asset: fixture.asset,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ selectability: "selectable" }),
        expect.objectContaining({ selectability: "verified-losing" }),
      ]),
    );
    const local = await readBrowserEncryptedWalletBackupV2LocalAssetRead({
      database: fixture.database,
      scopeId: fixture.scopeId,
      asset: fixture.asset,
    });
    expect(local.activeProofs.map(({ selectability }) => selectability).sort()).toEqual([
      "selectable",
      "verified-losing",
    ]);
    expect(local.backupEligibleProofCount).toBe(2);

    await expect(
      prepareBrowserEncryptedWalletBackupV2AssetBundle({
        snapshot,
        keyHandle: await createEncryptedWalletBackupV2KeyHandle({
          seed: SEED,
          realm: "backup.example",
          runtime: { subtle: crypto.subtle },
        }),
        seed: SEED,
        runtime: { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto) },
      }),
    ).rejects.toThrow(/terminal seal store/);
  });

  it.each(["ordinary", "ctf"] as const)(
    "reads exact %s rows when an active proof has no desired row",
    async (kind) => {
      const fixture = await fixtureFor(kind);
      database = fixture.database;
      if (kind === "ctf") await putConditionalKeyset(fixture.database, fixture.scopeId);
      const proof = proofRow(
        fixture.scopeId,
        kind === "ctf" ? CONDITIONAL_KEYSET : REGULAR_KEYSET,
        5,
        kind === "ctf" ? "ctf" : "regular",
        "selectable",
      );
      await fixture.database.custodyProofs.put(proof);

      await expect(
        readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
          database: fixture.database,
          scopeId: fixture.scopeId,
          asset: fixture.asset,
        }),
      ).resolves.toEqual([expect.objectContaining({ proofId: proof.proofId })]);
    },
  );

  it.each(["ordinary", "ctf"] as const)(
    "reads exact %s rows when the desired count is stale at zero",
    async (kind) => {
      const fixture = await fixtureFor(kind);
      database = fixture.database;
      if (kind === "ctf") await putConditionalKeyset(fixture.database, fixture.scopeId);
      const proof = proofRow(
        fixture.scopeId,
        kind === "ctf" ? CONDITIONAL_KEYSET : REGULAR_KEYSET,
        6,
        kind === "ctf" ? "ctf" : "regular",
        "selectable",
      );
      await fixture.database.custodyProofs.put(proof);
      await fixture.database.encryptedWalletBackupV2DesiredAssets.put(
        createEncryptedWalletBackupV2DesiredAssetRow({
          scopeId: fixture.scopeId,
          asset: fixture.asset,
          custodyRevision: 1n,
          activeProofCount: 0,
        }),
      );

      await expect(
        readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
          database: fixture.database,
          scopeId: fixture.scopeId,
          asset: fixture.asset,
        }),
      ).resolves.toEqual([expect.objectContaining({ proofId: proof.proofId })]);
    },
  );

  it("reads a remote-sealed losing proof from terminal context after keyset eviction", async () => {
    const fixture = await committedCtfFixture(1);
    database = fixture.database;
    const rows = (await fixture.database.custodyProofs.toArray()).map(decodeBrowserCustodyProofRow);
    const losing = rows.find(({ selectability }) => selectability === "verified-losing");
    const sibling = rows.find(({ selectability }) => selectability === "selectable");
    if (losing === undefined || sibling === undefined) throw new Error("test proof is missing");
    await fixture.database.custodyProofBackupAuthorities.put(
      createBrowserRemoteProofBackupAuthorityRow({
        proof: losing,
        observedAtMs: 30,
        derivationLocator: {
          schemaVersion: 1,
          kind: "nut13",
          keysetId: CONDITIONAL_KEYSET,
          counter: 1,
        },
        restoreProofId: losing.proofId,
        restoreProofCommitment: "22".repeat(32),
      }),
    );
    await fixture.database.custodyProofs.delete([fixture.scopeId, sibling.proofId]);
    await fixture.database.custodyProofBackupAuthorities.delete([fixture.scopeId, sibling.proofId]);
    await fixture.database.custodyConditionalKeysets.clear();
    await fixture.database.walletCounterAssociations.clear();
    await fixture.database.walletCounterCursors.clear();
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId: fixture.scopeId,
        asset: {
          mintUrl: fixture.desired.mintUrl,
          unit: fixture.desired.unit,
          assetIdentity: fixture.desired.assetIdentity,
        },
        custodyRevision: BigInt(fixture.desired.custodyRevision) + 1n,
        activeProofCount: 1,
        terminalCtfContext: {
          conditionId: CONDITION_ID,
          outcomeLabel: OUTCOME,
          outcomeCollectionId: OUTCOME_ID,
          registeredAt: 0,
          finalExpiry: 100,
        },
      }),
    );

    const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
      database: fixture.database,
      scopeId: fixture.scopeId,
      localAssetKey: fixture.desired.localAssetKey,
    });
    expect(snapshot.proofs).toHaveLength(1);
    expect(snapshot.proofs[0]?.proof.secret).toBe(proofSecret(losing));
    expect(snapshot.losingProofs[0]?.origin).toEqual({ kind: "remote-seal" });
    expect(snapshot.counterHighWaterMarks).toEqual([]);
    await expect(
      readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
        database: fixture.database,
        scopeId: fixture.scopeId,
        asset: snapshot.asset,
      }),
    ).resolves.toEqual([expect.objectContaining({ proofId: losing.proofId })]);
  });

  it("rejects exact CTF reads when persisted keyset-free context is missing", async () => {
    const fixture = await committedCtfFixture(1);
    database = fixture.database;
    await fixture.database.custodyConditionalKeysets.clear();
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId: fixture.scopeId,
        asset: {
          mintUrl: fixture.desired.mintUrl,
          unit: fixture.desired.unit,
          assetIdentity: fixture.desired.assetIdentity,
        },
        custodyRevision: BigInt(fixture.desired.custodyRevision) + 1n,
        activeProofCount: fixture.desired.activeProofCount,
        terminalCtfContext: null,
      }),
    );

    await expect(
      readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
        database: fixture.database,
        scopeId: fixture.scopeId,
        asset: {
          mintUrl: fixture.desired.mintUrl,
          unit: fixture.desired.unit,
          assetIdentity: fixture.desired.assetIdentity,
        },
      }),
    ).rejects.toThrow(/exact local proof CTF context is missing/);
  });

  it("rejects exact CTF reads when persisted context is foreign", async () => {
    const fixture = await committedCtfFixture(1);
    database = fixture.database;
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...fixture.desired,
      terminalCtfContext: {
        conditionId: "cd".repeat(32),
        outcomeLabel: OUTCOME,
        outcomeCollectionId: OUTCOME_ID,
        registeredAt: 0,
        finalExpiry: 100,
      },
    });

    await expect(
      readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
        database: fixture.database,
        scopeId: fixture.scopeId,
        asset: {
          mintUrl: fixture.desired.mintUrl,
          unit: fixture.desired.unit,
          assetIdentity: fixture.desired.assetIdentity,
        },
      }),
    ).rejects.toThrow(/desired asset CTF context is foreign/);
  });

  it("issues SDK-authorized local seals for one and several losing proofs", async () => {
    for (const losingCount of [1, 2]) {
      const fixture = await committedCtfFixture(losingCount);
      database = fixture.database;
      const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
        database: fixture.database,
        scopeId: fixture.scopeId,
        localAssetKey: fixture.desired.localAssetKey,
      });
      const prepared = await prepareBrowserEncryptedWalletBackupV2AssetBundle({
        snapshot,
        keyHandle: await createEncryptedWalletBackupV2KeyHandle({
          seed: SEED,
          realm: "backup.example",
          runtime: { subtle: crypto.subtle },
        }),
        seed: SEED,
        terminalSealStore: fixture.terminalSealStore,
        runtime: { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto) },
      });
      const restored = await decryptEncryptedWalletBackupV2ProofSetBundle({
        keyHandle: await createEncryptedWalletBackupV2KeyHandle({
          seed: SEED,
          realm: "backup.example",
          runtime: { subtle: crypto.subtle },
        }),
        seed: SEED,
        expectedAsset: snapshot.asset,
        custodyRevision: BigInt(snapshot.desired.custodyRevision),
        runtime: { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto) },
        ...prepared,
      });
      expect(restored.proofs).toHaveLength(losingCount + 1);
      expect(restored.proofs.filter(({ terminalSeal }) => terminalSeal !== undefined)).toHaveLength(
        losingCount,
      );
      expect(restored.proofs.filter(({ terminalSeal }) => terminalSeal === undefined)).toHaveLength(
        1,
      );
      fixture.database.close();
      await fixture.database.delete();
      database = null;
    }
  });

  it("refuses missing, remote, and mismatched local terminal authority", async () => {
    const fixture = await committedCtfFixture(1);
    database = fixture.database;
    const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
      database: fixture.database,
      scopeId: fixture.scopeId,
      localAssetKey: fixture.desired.localAssetKey,
    });
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
      seed: SEED,
      realm: "backup.example",
      runtime: { subtle: crypto.subtle },
    });
    const prepare = (candidate: typeof snapshot) =>
      prepareBrowserEncryptedWalletBackupV2AssetBundle({
        snapshot: candidate,
        keyHandle,
        seed: SEED,
        terminalSealStore: fixture.terminalSealStore,
        runtime: { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto) },
      });
    const losing = snapshot.losingProofs[0]!;
    await expect(
      prepare({
        ...snapshot,
        losingProofs: [
          { ...losing, origin: { kind: "local-operation", operationId: "missing-operation" } },
        ],
      }),
    ).rejects.toThrow(/operation is missing/);
    await expect(
      prepare({
        ...snapshot,
        losingProofs: [{ ...losing, origin: { kind: "remote-seal" } }],
      }),
    ).rejects.toThrow(/remote terminal seal requires remote reuse authority/);
    await expect(
      prepare({
        ...snapshot,
        losingProofs: [{ ...losing, proofId: "00".repeat(32) }],
      }),
    ).rejects.toThrow(/losing proof binding is invalid/);
  });

  it("rejects a losing proof with an invalid terminal origin", async () => {
    const fixture = await fixtureFor("ctf");
    database = fixture.database;
    const losing = verifiedLosingProofRow(fixture.scopeId, CONDITIONAL_KEYSET, 6);
    const valid = verifiedLosingAuthority(losing, "redeem:losing-6");
    await fixture.database.custodyProofs.put(losing);
    await fixture.database.custodyProofBackupAuthorities.put({
      ...valid,
      terminalAuthority: { kind: "copied-seal" } as never,
    });
    await putConditionalKeyset(fixture.database, fixture.scopeId);
    await putCounter(fixture.database, fixture.scopeId, CONDITIONAL_KEYSET, 7);
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 9n,
      activeProofCount: 1,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);

    await expect(
      readBrowserEncryptedWalletBackupV2AssetSnapshot({
        database: fixture.database,
        scopeId: fixture.scopeId,
        localAssetKey: desired.localAssetKey,
      }),
    ).rejects.toThrow(/terminal authority/);
  });

  it("enforces the 512-proof bound across selectable, locked, and losing states", async () => {
    const fixture = await fixtureFor("ctf");
    database = fixture.database;
    const selectable = Array.from({ length: 510 }, (_value, index) =>
      proofRow(fixture.scopeId, CONDITIONAL_KEYSET, index + 1, "ctf", "selectable"),
    );
    const locked = proofRow(fixture.scopeId, CONDITIONAL_KEYSET, 511, "ctf", "locked");
    const losing = verifiedLosingProofRow(fixture.scopeId, CONDITIONAL_KEYSET, 512);
    const rows = [...selectable, locked, losing];
    await fixture.database.custodyProofs.bulkPut(rows);
    await fixture.database.custodyProofBackupAuthorities.bulkPut([
      ...selectable.map(authority),
      authority(locked),
      verifiedLosingAuthority(losing, "redeem:losing-512"),
    ]);
    await putConditionalKeyset(fixture.database, fixture.scopeId);
    await putCounter(fixture.database, fixture.scopeId, CONDITIONAL_KEYSET, 513);
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 9n,
      activeProofCount: 512,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(desired);

    const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
      database: fixture.database,
      scopeId: fixture.scopeId,
      localAssetKey: desired.localAssetKey,
    });
    expect(snapshot.proofs).toHaveLength(512);
    expect(snapshot.losingProofs).toHaveLength(1);

    const extra = proofRow(fixture.scopeId, CONDITIONAL_KEYSET, 513, "ctf", "selectable");
    await fixture.database.custodyProofs.put(extra);
    await fixture.database.custodyProofBackupAuthorities.put(authority(extra));
    await putCounter(fixture.database, fixture.scopeId, CONDITIONAL_KEYSET, 514);
    await expect(
      readBrowserEncryptedWalletBackupV2AssetSnapshot({
        database: fixture.database,
        scopeId: fixture.scopeId,
        localAssetKey: desired.localAssetKey,
      }),
    ).rejects.toThrow(/exceeds the limit/);
    await expect(
      readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
        database: fixture.database,
        scopeId: fixture.scopeId,
        asset: fixture.asset,
      }),
    ).rejects.toThrow(/exceeds the limit/);
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

async function committedCtfFixture(losingCount: number) {
  const scope = walletScopeForSeed(SEED);
  const database = new BitcasterDB(browserWalletDatabaseName(scope.scopeId));
  await database.delete();
  await database.open();
  const adapter = new BrowserDurableCustodyAdapter(database);
  const owner = await adapter.claimScope(scope, {
    incarnationId: `source-${losingCount}`,
    observedAtMs: 10,
    leaseExpiresAtMs: 10_000,
  });
  const locators = Array.from({ length: losingCount }, (_value, index) => ({
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: CONDITIONAL_KEYSET,
    counter: index + 1,
  }));
  const predecessors = locators.map((locator) =>
    createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: {
        id: CONDITIONAL_KEYSET,
        amount: 1 as never,
        secret: deriveDurableWalletProofSecret({
          seed: SEED,
          locator,
          proofKeysetId: CONDITIONAL_KEYSET,
          proofAmount: 1,
        }),
        C: PUBLIC_KEY,
      },
      asset: { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: OUTCOME },
      receivedAtMs: 1,
    }),
  );
  await database.custodyProofs.bulkPut(predecessors);
  await database.custodyProofBackupAuthorities.bulkPut(
    predecessors.map((row, index) =>
      createBrowserProofBackupAuthorityRow(row, 10, locators[index]!, `admission:${index}`),
    ),
  );
  await database.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    keysetId: CONDITIONAL_KEYSET,
    denominationPublicKeys: { "1": PUBLIC_KEY },
    inputFeePpk: 100,
    conditionId: CONDITION_ID,
    outcomeCollection: OUTCOME,
    outcomeCollectionId: OUTCOME_ID,
    registeredAtUnixSeconds: 0,
    finalExpiryUnixSeconds: 100,
    curve: "secp256k1",
  });
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: CONDITION_ID,
      outcomeCollectionId: OUTCOME_ID,
      outcomeLabel: OUTCOME,
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
  const operationId = `ctf-redeem-source-${losingCount}`;
  await commitBrowserCtfTerminalOperation({
    adapter,
    scope,
    owner,
    operationId,
    mintUrl: MINT,
    proofs: predecessors.map(proofFromRow),
    predecessorProofs: predecessors,
    publicKey: PUBLIC_KEY,
  });
  const siblingLocator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: CONDITIONAL_KEYSET,
    counter: losingCount + 1,
  };
  const sibling = createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: {
      id: CONDITIONAL_KEYSET,
      amount: 1 as never,
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator: siblingLocator,
        proofKeysetId: CONDITIONAL_KEYSET,
        proofAmount: 1,
      }),
      C: PUBLIC_KEY,
    },
    asset: { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: OUTCOME },
    receivedAtMs: 1,
  });
  await database.custodyProofs.put(sibling);
  await database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(sibling, 20, siblingLocator, "receive:sibling"),
  );
  await database.walletCounterAssociations.put({
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    keysetId: CONDITIONAL_KEYSET,
    recoveryComplete: true,
  });
  await database.walletCounterCursors.put({
    scopeId: scope.scopeId,
    keysetId: CONDITIONAL_KEYSET,
    next: losingCount + 2,
  });
  const currentDesired = await database.encryptedWalletBackupV2DesiredAssets.get([
    scope.scopeId,
    initialDesired.localAssetKey,
  ]);
  if (currentDesired === undefined) throw new Error("test desired asset is missing");
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: scope.scopeId,
    asset,
    custodyRevision: BigInt(currentDesired.custodyRevision) + 1n,
    activeProofCount: losingCount + 1,
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(desired);
  return {
    database,
    scopeId: scope.scopeId,
    desired,
    terminalSealStore: new BrowserEncryptedWalletBackupV2TerminalSealStore({
      database,
      scopeId: scope.scopeId,
    }),
  };
}

function walletScopeForSeed(
  seed: Uint8Array,
): Extract<DurableCustodyScope, { scopeKind: "wallet" }> {
  const walletId = deriveDurableCustodyWalletId(seed);
  return {
    scopeKind: "wallet",
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
  };
}

function proofFromRow(row: BrowserCustodyProofRow): Proof {
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

function verifiedLosingProofRow(
  scopeId: string,
  keysetId: string,
  counter: number,
): BrowserCustodyProofRow {
  const locked = proofRow(scopeId, keysetId, counter, "ctf", "locked");
  return {
    ...locked,
    revision: locked.revision + 1,
    selectability: "verified-losing" as const,
    reservationOperationId: null,
  } as BrowserCustodyProofRow;
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

function verifiedLosingAuthority(
  row: ReturnType<typeof verifiedLosingProofRow>,
  operationId: string,
) {
  const predecessor = {
    ...row,
    revision: row.revision - 1,
    selectability: "locked" as const,
    reservationOperationId: `lock:${operationId}`,
  };
  const current = createBrowserProofBackupAuthorityRow(
    predecessor,
    2,
    { schemaVersion: 1, kind: "nut13", keysetId: row.keysetId, counter: secretCounter(row) },
    `admission:${operationId}`,
  );
  return classifyBrowserProofBackupAuthorityVerifiedLosing(current, row, operationId, 3);
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

function proofSecret(row: Pick<BrowserCustodyProofRow, "proofBody">): string {
  return JSON.parse(new TextDecoder().decode(row.proofBody)).secret as string;
}

function secretCounter(row: Pick<BrowserCustodyProofRow, "proofBody">): number {
  return Number.parseInt(proofSecret(row).slice(0, 2), 16);
}
