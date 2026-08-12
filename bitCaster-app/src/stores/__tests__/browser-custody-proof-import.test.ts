// @vitest-environment node
import "fake-indexeddb/auto";
import { deriveConditionalKeysetId } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
  prepareDurableCustodyProofImport,
} from "@bitcaster/client-sdk/durableCustodyProofImport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitBrowserCustodyProofImport } from "../browser-custody-proof-import";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
  type BrowserCustodyProofAsset,
} from "../durable-custody-db";
import type { BrowserCustodyConditionalKeysetAuthority } from "../durable-custody-types";
import { BitcasterDB } from "../proof-db";

const MINT = "https://mint.example";
const DERIVATION_KEYSET = `01${"33".repeat(32)}`;
const KEYSET = DERIVATION_KEYSET;
const PUBLIC_KEY = `02${"22".repeat(32)}`;
const CONDITION_ID = "aa".repeat(32);
const OUTCOME_COLLECTION = "YES";
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
});
const CONDITIONAL_KEYSET = deriveConditionalKeysetId({
  keys: { "1": PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 100,
  final_expiry: 100,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
});

const nut13 = (keysetId: string, counter: number) => ({
  schemaVersion: 1 as const,
  kind: "nut13" as const,
  keysetId,
  counter,
});

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
    ).toMatchObject({ derivationLocator: nut13(DERIVATION_KEYSET, 7) });
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
    ).toMatchObject({ derivationLocator: null });
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
          derivationLocator: nut13(DERIVATION_KEYSET, 8),
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
    ).toMatchObject({ derivationLocator: nut13(DERIVATION_KEYSET, 7) });
  });

  it("rejects a conditional proof when its exact keyset authority is missing", async () => {
    const fixture = await createFixture(undefined, {
      unit: "msat",
      asset: {
        kind: "conditional",
        conditionId: CONDITION_ID,
        outcomeCollection: OUTCOME_COLLECTION,
      },
    });
    database = fixture.database;
    await expect(
      commitBrowserCustodyProofImport({ ...fixture, injectFault: "after-commit" }),
    ).rejects.toThrow("conditional proof keyset authority is missing");
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyConditionalKeysets.count()).toBe(0);
  });

  it("rejects substituted inventory classification on a terminal retry without mutation", async () => {
    const fixture = await createFixture(nut13(CONDITIONAL_KEYSET, 7), {
      unit: "msat",
      keysetId: CONDITIONAL_KEYSET,
      asset: {
        kind: "conditional",
        conditionId: CONDITION_ID,
        outcomeCollection: OUTCOME_COLLECTION,
      },
      conditionalKeyset: conditionalKeysetAuthority(),
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
        proofs: [
          {
            proof: alternate,
            expectedRevision: null,
            derivationLocator: fixture.locator,
            conditionalKeyset: fixture.conditionalKeyset,
          },
        ],
      }),
    ).rejects.toThrow(/candidate authority/);
    expect(await database.custodyProofs.count()).toBe(1);
    expect(
      await database.custodyProofBackupAuthorities.get([
        fixture.scope.scopeId,
        fixture.proof.proofId,
      ]),
    ).toMatchObject({ derivationLocator: nut13(CONDITIONAL_KEYSET, 7) });
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
    ).toMatchObject({
      proofFingerprint: fixture.proof.proofFingerprint,
      derivationLocator: nut13(DERIVATION_KEYSET, 7),
    });
  });

  it("uses one conditional-keyset authority read for a bounded shared-keyset import", async () => {
    const fixture = await createConditionalFixture(
      DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
    );
    database = fixture.database;
    const proofBulkGet = vi.spyOn(fixture.database.custodyProofs, "bulkGet");
    const authorityBulkGet = vi.spyOn(fixture.database.custodyProofBackupAuthorities, "bulkGet");
    const keysetGet = vi.spyOn(fixture.database.custodyConditionalKeysets, "get");
    const keysetBulkGet = vi.spyOn(fixture.database.custodyConditionalKeysets, "bulkGet");
    const keysetBulkAdd = vi.spyOn(fixture.database.custodyConditionalKeysets, "bulkAdd");

    await commitBrowserCustodyProofImport(fixture);

    expect(
      nonEmptyBulkReads(proofBulkGet.mock.calls, DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX),
    ).toBe(2);
    expect(
      nonEmptyBulkReads(
        authorityBulkGet.mock.calls,
        DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
      ),
    ).toBe(2);
    expect(keysetGet).not.toHaveBeenCalled();
    expect(keysetBulkGet).toHaveBeenCalledTimes(1);
    expect(keysetBulkGet.mock.calls[0]![0]).toEqual([
      [fixture.scope.scopeId, MINT, "msat", CONDITIONAL_KEYSET],
    ]);
    expect(keysetBulkAdd).toHaveBeenCalledTimes(1);
    expect(await fixture.database.custodyProofs.count()).toBe(
      DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
    );
    expect(await fixture.database.custodyProofBackupAuthorities.count()).toBe(
      DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
    );
    expect(await fixture.database.custodyConditionalKeysets.count()).toBe(1);

    await commitBrowserCustodyProofImport(fixture);

    expect(await fixture.database.custodyProofs.count()).toBe(
      DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
    );
    expect(await fixture.database.custodyProofBackupAuthorities.count()).toBe(
      DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
    );
    expect(await fixture.database.custodyConditionalKeysets.count()).toBe(1);
  });

  it("rejects conflicting requested authority for proofs that share one keyset", async () => {
    const fixture = await createConditionalFixture(2);
    database = fixture.database;
    const conflicting = {
      ...conditionalKeysetAuthority(),
      finalExpiryUnixSeconds: 101,
    };

    await expect(
      commitBrowserCustodyProofImport({
        ...fixture,
        proofs: fixture.proofs.map((staged, index) =>
          index === 0 ? staged : { ...staged, conditionalKeyset: conflicting },
        ),
      }),
    ).rejects.toThrow("conditional keyset authority conflicts");

    expect(await fixture.database.custodyProofs.count()).toBe(0);
    expect(await fixture.database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await fixture.database.custodyConditionalKeysets.count()).toBe(0);
  });
});

async function createFixture(
  derivationLocator: ReturnType<typeof nut13> | null = nut13(DERIVATION_KEYSET, 7),
  options: {
    readonly unit?: "sat" | "msat";
    readonly asset?: BrowserCustodyProofAsset;
    readonly keysetId?: string;
    readonly conditionalKeyset?: BrowserCustodyConditionalKeysetAuthority;
  } = {},
) {
  const unit = options.unit ?? "sat";
  const asset = options.asset ?? { kind: "regular" };
  const keysetId = options.keysetId ?? KEYSET;
  const database = new BitcasterDB(`proof-import-${crypto.randomUUID()}`);
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(32).fill(7));
  const scope: DurableCustodyScope = {
    scopeKind: "wallet",
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
  };
  const proofValue = {
    id: keysetId,
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
        keysetId,
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
    conditionalKeyset: options.conditionalKeyset,
    proofs: [
      {
        proof,
        expectedRevision: null,
        derivationLocator,
        ...(options.conditionalKeyset === undefined
          ? {}
          : { conditionalKeyset: options.conditionalKeyset }),
      },
    ],
  };
}

async function createConditionalFixture(proofCount: number) {
  const database = new BitcasterDB(`conditional-proof-import-${crypto.randomUUID()}`);
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(32).fill(8));
  const scope: DurableCustodyScope = {
    scopeKind: "wallet",
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
  };
  const proofValues = Array.from({ length: proofCount }, (_, index) => ({
    id: CONDITIONAL_KEYSET,
    amount: 1 as never,
    secret: `conditional-proof-${index}`,
    C: PUBLIC_KEY,
  }));
  const proofs = proofValues.map((proofValue, index) => ({
    proof: createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: proofValue,
      asset: {
        kind: "conditional",
        conditionId: CONDITION_ID,
        outcomeCollection: OUTCOME_COLLECTION,
      },
      receivedAtMs: 10,
    }),
    expectedRevision: null,
    derivationLocator: nut13(CONDITIONAL_KEYSET, index),
    conditionalKeyset: conditionalKeysetAuthority(),
  }));
  const prepared = prepareDurableCustodyProofImport({
    scope,
    sourceOperationId: `receive:conditional:${proofCount}`,
    normalizedMint: MINT,
    unit: "msat",
    inventoryAccountId: null,
    keysets: [
      {
        keysetId: CONDITIONAL_KEYSET,
        unit: "msat",
        curve: "secp256k1",
        publicKeys: { "1": PUBLIC_KEY },
        keysetExpiryMs: null,
        requireDleq: false,
      },
    ],
    proofs: proofValues,
    inventoryAuthorityFingerprint: deriveDurableCustodyArtifactFingerprint({
      schemaVersion: 1,
      proofs: proofs.map(({ proof }) => ({
        proofId: proof.proofId,
        proofFingerprint: proof.proofFingerprint,
        assetKind: proof.assetKind,
        conditionId: proof.conditionId,
        outcomeCollection: proof.outcomeCollection,
        baseAsset: proof.baseAsset,
      })),
    }),
  });
  const adapter = new BrowserDurableCustodyAdapter(database);
  const owner = await adapter.claimScope(scope, {
    incarnationId: "browser-conditional-proof-import",
    observedAtMs: 10,
    leaseExpiresAtMs: 10_000,
  });
  return { database, adapter, scope, owner, prepared, proofs };
}

function nonEmptyBulkReads(calls: readonly unknown[][], expectedLength: number): number {
  return calls.filter((call) => Array.isArray(call[0]) && call[0].length === expectedLength).length;
}

function conditionalKeysetAuthority(): BrowserCustodyConditionalKeysetAuthority {
  return {
    schemaVersion: 1,
    normalizedMint: MINT,
    unit: "msat",
    keysetId: CONDITIONAL_KEYSET,
    denominationPublicKeys: { "1": PUBLIC_KEY },
    inputFeePpk: 100,
    conditionId: CONDITION_ID,
    outcomeCollection: OUTCOME_COLLECTION,
    outcomeCollectionId: OUTCOME_COLLECTION_ID,
    registeredAtUnixSeconds: 0,
    finalExpiryUnixSeconds: 100,
    curve: "secp256k1",
  };
}
