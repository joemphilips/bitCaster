// @vitest-environment node
import "fake-indexeddb/auto";
import {
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import { prepareDurableCustodyProofImport } from "@bitcaster/client-sdk/durableCustodyProofImport";
import { afterEach, describe, expect, it } from "vitest";
import { commitBrowserCustodyProofImport } from "../browser-custody-proof-import";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
  type BrowserCustodyProofAsset,
} from "../durable-custody-db";
import { BitcasterDB } from "../proof-db";

const MINT = "https://mint.example";
const DERIVATION_KEYSET = `01${"33".repeat(32)}`;
const KEYSET = DERIVATION_KEYSET;
const PUBLIC_KEY = `02${"22".repeat(32)}`;

describe("browser custody proof import", () => {
  let database: BitcasterDB | null = null;

  afterEach(async () => {
    database?.close();
    if (database) await indexedDB.deleteDatabase(database.name);
    database = null;
  });

  it("commits the SDK import, proof, and backup authority together", async () => {
    const fixture = await createFixture();
    database = fixture.database;

    await commitBrowserCustodyProofImport(fixture);

    const stored = await fixture.adapter.readProof(fixture.scope.scopeId, fixture.proof.proofId);
    expect(stored?.proofFingerprint).toBe(fixture.proof.proofFingerprint);
    expect(
      await database.custodyProofBackupAuthorities.get([
        fixture.scope.scopeId,
        fixture.proof.proofId,
      ]),
    ).toMatchObject({ backupState: "local-only", proofRevision: 0 });
    expect(
      await database.custodyProofBackupAuthorities.get([
        fixture.scope.scopeId,
        fixture.proof.proofId,
      ]),
    ).toMatchObject({ derivationKeysetId: DERIVATION_KEYSET, derivationCounter: 7 });
    expect(
      await fixture.adapter.readOperation(
        fixture.scope,
        fixture.prepared.record.operation.operationId,
      ),
    ).toMatchObject({ operation: { state: "reconciled", result: { state: "applied" } } });
  });

  it("rolls back a fault before commit", async () => {
    const fixture = await createFixture();
    database = fixture.database;

    await expect(
      commitBrowserCustodyProofImport({ ...fixture, injectFault: "before-commit" }),
    ).rejects.toThrow("before commit");

    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.custodyOperations.count()).toBe(1);
    expect(
      await fixture.adapter.readOperation(
        fixture.scope,
        fixture.prepared.record.operation.operationId,
      ),
    ).toMatchObject({
      operation: { state: "dispatch-intent", result: { state: "verified-staged" } },
    });
  });

  it("accepts an explicit null derivation locator", async () => {
    const fixture = await createFixture(null);
    database = fixture.database;

    await commitBrowserCustodyProofImport(fixture);

    expect(
      await database.custodyProofBackupAuthorities.get([
        fixture.scope.scopeId,
        fixture.proof.proofId,
      ]),
    ).toMatchObject({ derivationKeysetId: null, derivationCounter: null });
  });

  it("retries the exact committed import after an unknown outcome", async () => {
    const fixture = await createFixture();
    database = fixture.database;

    await expect(
      commitBrowserCustodyProofImport({ ...fixture, injectFault: "after-commit" }),
    ).rejects.toThrow("after commit");
    await commitBrowserCustodyProofImport(fixture);

    expect(await database.custodyProofs.count()).toBe(1);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(1);
    expect(await database.custodyOperations.count()).toBe(1);
  });

  it("rejects a conflicting locator on a terminal import retry without mutation", async () => {
    const fixture = await createFixture();
    database = fixture.database;

    await expect(
      commitBrowserCustodyProofImport({ ...fixture, injectFault: "after-commit" }),
    ).rejects.toThrow("after commit");
    await expect(
      commitBrowserCustodyProofImport({
        ...fixture,
        proofs: fixture.proofs.map((staged) => ({
          ...staged,
          derivationLocator: { keysetId: DERIVATION_KEYSET, counter: 8 },
        })),
      }),
    ).rejects.toThrow("derivation locator conflicts");

    expect(await database.custodyProofs.count()).toBe(1);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(1);
    expect(
      await database.custodyProofBackupAuthorities.get([
        fixture.scope.scopeId,
        fixture.proof.proofId,
      ]),
    ).toMatchObject({ derivationKeysetId: DERIVATION_KEYSET, derivationCounter: 7 });
  });

  it("rejects substituted inventory classification on a terminal retry without mutation", async () => {
    const fixture = await createFixture(undefined, {
      unit: "msat",
      asset: { kind: "conditional", conditionId: "aa".repeat(32), outcomeCollection: "YES" },
    });
    database = fixture.database;
    await expect(
      commitBrowserCustodyProofImport({ ...fixture, injectFault: "after-commit" }),
    ).rejects.toThrow("after commit");

    const alternate = createBrowserCustodyProofRow({
      scopeId: fixture.scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: fixture.proofValue,
      asset: { kind: "conditional", conditionId: "bb".repeat(32), outcomeCollection: "NO" },
      receivedAtMs: 10,
    });
    await expect(
      commitBrowserCustodyProofImport({
        ...fixture,
        proofs: [{ proof: alternate, expectedRevision: null, derivationLocator: fixture.locator }],
      }),
    ).rejects.toThrow(/candidate authority/);
    expect(await database.custodyProofs.count()).toBe(1);
    expect(
      await database.custodyProofBackupAuthorities.get([
        fixture.scope.scopeId,
        fixture.proof.proofId,
      ]),
    ).toMatchObject({ derivationCounter: 7 });
  });

  it("rejects a same-id substituted proof body before apply and on a terminal retry", async () => {
    const fixture = await createFixture();
    database = fixture.database;
    const alternate = createBrowserCustodyProofRow({
      scopeId: fixture.scope.scopeId,
      normalizedMint: MINT,
      unit: "sat",
      proof: { ...fixture.proofValue, C: `02${"44".repeat(32)}` },
      asset: { kind: "regular" },
      receivedAtMs: 10,
    });

    const substituted = {
      ...fixture,
      proofs: [{ proof: alternate, expectedRevision: null, derivationLocator: fixture.locator }],
    };
    await expect(commitBrowserCustodyProofImport(substituted)).rejects.toThrow(
      /row artifact mismatch/,
    );
    expect(await database.custodyProofs.count()).toBe(0);
    await expect(
      commitBrowserCustodyProofImport({ ...fixture, injectFault: "after-commit" }),
    ).rejects.toThrow("after commit");
    await expect(commitBrowserCustodyProofImport(substituted)).rejects.toThrow(
      /row artifact mismatch/,
    );
    expect(await database.custodyProofs.count()).toBe(1);
    expect(
      await database.custodyProofBackupAuthorities.get([
        fixture.scope.scopeId,
        fixture.proof.proofId,
      ]),
    ).toMatchObject({ proofFingerprint: fixture.proof.proofFingerprint, derivationCounter: 7 });
  });
});

async function createFixture(
  derivationLocator: { keysetId: string; counter: number } | null = {
    keysetId: DERIVATION_KEYSET,
    counter: 7,
  },
  options: {
    readonly unit?: "sat" | "msat";
    readonly asset?: BrowserCustodyProofAsset;
  } = {},
) {
  const unit = options.unit ?? "sat";
  const asset = options.asset ?? { kind: "regular" };
  const database = new BitcasterDB(`proof-import-${crypto.randomUUID()}`);
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(32).fill(7));
  const scope: DurableCustodyScope = {
    scopeKind: "wallet",
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
  };
  const proofValue = {
    id: KEYSET,
    amount: 1 as never,
    secret: "proof-secret",
    C: PUBLIC_KEY,
  };
  const proof = createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit,
    proof: proofValue,
    asset,
    receivedAtMs: 10,
  });
  const prepared = prepareDurableCustodyProofImport({
    scope,
    sourceOperationId: "receive:one",
    normalizedMint: MINT,
    unit,
    inventoryAccountId: null,
    keysets: [
      {
        keysetId: KEYSET,
        unit,
        curve: "secp256k1",
        publicKeys: { "1": PUBLIC_KEY },
        keysetExpiryMs: null,
        requireDleq: false,
      },
    ],
    proofs: [proofValue],
    inventoryAuthorityFingerprint: deriveDurableCustodyArtifactFingerprint({
      schemaVersion: 1,
      proofs: [
        {
          proofId: proof.proofId,
          proofFingerprint: proof.proofFingerprint,
          assetKind: proof.assetKind,
          conditionId: proof.conditionId,
          outcomeCollection: proof.outcomeCollection,
          baseAsset: "sat",
        },
      ],
    }),
  });
  const adapter = new BrowserDurableCustodyAdapter(database);
  const owner = await adapter.claimScope(scope, {
    incarnationId: "browser-proof-import",
    observedAtMs: 10,
    leaseExpiresAtMs: 10_000,
  });
  return {
    database,
    adapter,
    scope,
    owner,
    prepared,
    proof,
    proofValue,
    locator: derivationLocator,
    proofs: [{ proof, expectedRevision: null, derivationLocator }],
  };
}
