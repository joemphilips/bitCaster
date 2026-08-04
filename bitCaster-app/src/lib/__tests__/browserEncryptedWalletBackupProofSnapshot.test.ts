// @vitest-environment node
import "fake-indexeddb/auto";
import {
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { prepareDurableCustodyProofImport } from "@bitcaster/client-sdk/durableCustodyProofImport";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { createEncryptedWalletBackupKeyHandle } from "@bitcaster/client-sdk/encryptedWalletBackup";
import {
  ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
  issueEncryptedWalletBackupFrozenSnapshotControl,
} from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotAuthority";
import { decodeEncryptedWalletBackupFrozenSnapshot } from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotPersistence";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBrowserEncryptedWalletBackupProofSnapshot } from "../browserEncryptedWalletBackupProofSnapshot";
import { commitBrowserCustodyProofImport } from "../../stores/browser-custody-proof-import";
import { BrowserEncryptedWalletBackupProofSnapshotDexieStore } from "../../stores/browser-encrypted-wallet-backup-proof-snapshot-dexie-store";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../../stores/durable-custody-db";
import { BitcasterDB } from "../../stores/proof-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";

const KEYSET = `01${"33".repeat(32)}`;
const PUBLIC_KEY = `02${"22".repeat(32)}`;
const MINT = "https://mint.example";
const REALM = "browser-snapshot-test";
const SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
let database: BitcasterDB | null = null;

afterEach(async () => {
  database?.close();
  if (database) await database.delete();
  database = null;
});

describe("browser encrypted wallet backup proof snapshot", () => {
  it("seals two bounded source pages and rebuilds a fresh namespace after interruption", async () => {
    const fixture = await eligibleProofInventory(65);
    database = fixture.database;
    const cancelled = new AbortController();
    const original =
      BrowserEncryptedWalletBackupProofSnapshotDexieStore.prototype
        .listEligibleCommittedProofSnapshotPage;
    let sourcePages = 0;
    const pageRead = vi
      .spyOn(
        BrowserEncryptedWalletBackupProofSnapshotDexieStore.prototype,
        "listEligibleCommittedProofSnapshotPage",
      )
      .mockImplementation(async function (
        this: BrowserEncryptedWalletBackupProofSnapshotDexieStore,
        cursor,
      ) {
        const page = await original.call(this, cursor);
        sourcePages += 1;
        if (sourcePages === 2) cancelled.abort(new Error("test interruption"));
        return page;
      });
    const committedRead = vi.spyOn(
      BrowserEncryptedWalletBackupProofSnapshotDexieStore.prototype,
      "withCommittedProofSnapshot",
    );

    await expect(
      buildBrowserEncryptedWalletBackupProofSnapshot(
        snapshotInput(fixture, "interrupted", cancelled.signal),
      ),
    ).rejects.toThrow("test interruption");
    pageRead.mockRestore();
    expect(committedRead).not.toHaveBeenCalled();
    const interrupted = await readSnapshot(
      fixture.database,
      fixture.keyHandle.vaultId,
      "interrupted",
    );
    expect(interrupted.state).toBe("populating");
    expect(interrupted.recordCount).toBe(64);

    const sealed = await buildBrowserEncryptedWalletBackupProofSnapshot(
      snapshotInput(fixture, "fresh", new AbortController().signal),
    );

    expect(sealed.state).toBe("sealed");
    expect(sealed.recordCount).toBe(65);
    expect(
      (await readSnapshot(fixture.database, fixture.keyHandle.vaultId, "fresh")).recordCount,
    ).toBe(65);
    expect(await freshPinnedProofIds(fixture.database, "fresh")).toEqual(fixture.proofIds);
  });

  it("continues after an empty eligible page that advances over reserved authority", async () => {
    const fixture = await eligibleProofInventory(65);
    database = fixture.database;
    await Promise.all(
      fixture.proofIds
        .slice(0, 64)
        .map((proofId, inputPosition) =>
          reserveProofAuthority(fixture.database, fixture.scopeId, proofId, inputPosition),
        ),
    );

    const sealed = await buildBrowserEncryptedWalletBackupProofSnapshot(
      snapshotInput(fixture, "reserved-skip", new AbortController().signal),
    );

    expect(sealed.state).toBe("sealed");
    expect(sealed.recordCount).toBe(1);
    expect(await freshPinnedProofIds(fixture.database, "reserved-skip")).toEqual(
      fixture.proofIds.slice(64),
    );
  });
});

async function eligibleProofInventory(count: number) {
  const walletId = deriveDurableCustodyWalletId(SEED);
  const scope = {
    scopeKind: "wallet" as const,
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
  };
  const fixtureDatabase = new BitcasterDB(browserWalletDatabaseName(scope.scopeId));
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: REALM,
    runtime: { subtle: crypto.subtle, getRandomValues: (target) => crypto.getRandomValues(target) },
  });
  const candidates = Array.from({ length: count }, (_, index) =>
    proofCandidate(scope.scopeId, index + 1),
  );
  const adapter = new BrowserDurableCustodyAdapter(fixtureDatabase);
  const owner = await adapter.claimScope(scope, {
    incarnationId: "browser-snapshot-test",
    observedAtMs: 1_000,
    leaseExpiresAtMs: 10_000,
  });
  await commitBrowserCustodyProofImport({
    scope,
    owner,
    database: fixtureDatabase,
    prepared: prepareImport(scope, candidates),
    proofs: candidates.map(({ row, locator }) => ({
      proof: row,
      expectedRevision: null,
      derivationLocator: locator,
    })),
  });
  return {
    database: fixtureDatabase,
    scopeId: scope.scopeId,
    keyHandle,
    proofIds: candidates.map(({ row }) => row.proofId).sort(),
  };
}

function proofCandidate(scopeId: string, counter: number) {
  const locator = { schemaVersion: 1 as const, kind: "nut13" as const, keysetId: KEYSET, counter };
  const proof = {
    id: KEYSET,
    amount: 1 as never,
    secret: deriveDurableWalletProofSecret({
      seed: SEED,
      locator,
      proofKeysetId: KEYSET,
      proofAmount: 1,
    }),
    C: PUBLIC_KEY,
    dleq: { e: "22".repeat(32), s: "33".repeat(32), r: "44".repeat(32) },
  };
  return {
    locator,
    proof,
    row: createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: MINT,
      unit: "sat",
      proof,
      asset: { kind: "regular" },
      receivedAtMs: 1_000,
    }),
  };
}

function prepareImport(
  scope: Parameters<typeof prepareDurableCustodyProofImport>[0]["scope"],
  candidates: readonly ReturnType<typeof proofCandidate>[],
) {
  return prepareDurableCustodyProofImport({
    scope,
    sourceOperationId: "receive:browser-snapshot",
    normalizedMint: MINT,
    unit: "sat",
    inventoryAccountId: null,
    keysets: [
      {
        keysetId: KEYSET,
        unit: "sat",
        curve: "secp256k1",
        publicKeys: { "1": PUBLIC_KEY },
        keysetExpiryMs: null,
        requireDleq: false,
      },
    ],
    proofs: candidates.map(({ proof }) => proof),
    inventoryAuthorityFingerprint: deriveDurableCustodyArtifactFingerprint({
      schemaVersion: 1,
      proofs: candidates.map(({ row }) => ({
        proofId: row.proofId,
        proofFingerprint: row.proofFingerprint,
        assetKind: "regular",
        conditionId: null,
        outcomeCollection: null,
        baseAsset: "sat",
      })),
    }),
  });
}

function snapshotInput(
  fixture: Awaited<ReturnType<typeof eligibleProofInventory>>,
  snapshotId: string,
  signal: AbortSignal,
) {
  return {
    database: fixture.database,
    scopeId: fixture.scopeId,
    seed: SEED,
    keyHandle: fixture.keyHandle,
    control: issueEncryptedWalletBackupFrozenSnapshotControl(
      {},
      {
        realm: fixture.keyHandle.realm,
        vaultId: fixture.keyHandle.vaultId,
        enrollmentEpoch: 1,
        parentGeneration: null,
        parentManifestDigest: null,
        parentReferenceSetDigest: ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
        generation: 1,
        snapshotNonce: "22".repeat(16),
        snapshotId,
        snapshotRevision: 1,
      },
    ),
    snapshotId,
    snapshotRevision: 1,
    effectiveNowUnixSeconds: 1,
    signal,
    lockManager: {
      request: async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => unknown,
      ): Promise<unknown> => callback({} as Lock),
    } as unknown as LockManager,
  };
}

async function readSnapshot(database: BitcasterDB, vaultId: string, snapshotId: string) {
  const row = await database.encryptedWalletBackupSnapshotControls
    .where("[realm+vaultId+snapshotId+snapshotRevision]")
    .equals([REALM, vaultId, snapshotId, 1])
    .first();
  if (!row) throw new Error("snapshot control is absent");
  return decodeEncryptedWalletBackupFrozenSnapshot(row.canonical);
}

async function reserveProofAuthority(
  database: BitcasterDB,
  scopeId: string,
  proofId: string,
  inputPosition: number,
): Promise<void> {
  const [proof, authority] = await Promise.all([
    database.custodyProofs.get([scopeId, proofId]),
    database.custodyProofBackupAuthorities.get([scopeId, proofId]),
  ]);
  if (!proof || !authority) throw new Error("proof authority is absent");
  await database.transaction(
    "rw",
    [database.custodyProofs, database.custodyProofBackupAuthorities, database.custodyReservations],
    async () => {
      await database.custodyProofs.put({
        ...proof,
        selectability: "locked",
        reservationOperationId: "reserved-operation",
      });
      await database.custodyProofBackupAuthorities.put({ ...authority, proofState: "locked" });
      await database.custodyReservations.put({
        scopeId,
        proofId,
        operationId: "reserved-operation",
        reservationId: `reservation-${inputPosition}`,
        inputPosition,
      });
    },
  );
}

async function freshPinnedProofIds(database: BitcasterDB, snapshotId: string): Promise<string[]> {
  return (await database.encryptedWalletBackupSnapshotPins.toArray())
    .filter((row) => row.snapshotId === snapshotId)
    .map((row) => row.recordId)
    .sort();
}
