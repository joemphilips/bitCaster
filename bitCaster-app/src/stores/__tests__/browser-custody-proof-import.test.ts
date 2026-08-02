// @vitest-environment node
import "fake-indexeddb/auto";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import { prepareDurableCustodyProofImport } from "@bitcaster/client-sdk/durableCustodyProofImport";
import { afterEach, describe, expect, it } from "vitest";
import { commitBrowserCustodyProofImport } from "../browser-custody-proof-import";
import { BrowserDurableCustodyAdapter, createBrowserCustodyProofRow } from "../durable-custody-db";
import { BitcasterDB } from "../proof-db";

const MINT = "https://mint.example";
const KEYSET = `00${"11".repeat(7)}`;
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
});

async function createFixture() {
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
  const prepared = prepareDurableCustodyProofImport({
    scope,
    sourceOperationId: "receive:one",
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
    proofs: [proofValue],
  });
  const proof = createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "sat",
    proof: proofValue,
    asset: { kind: "regular" },
    receivedAtMs: 10,
  });
  const adapter = new BrowserDurableCustodyAdapter(database);
  const owner = await adapter.claimScope(scope, {
    incarnationId: "browser-proof-import",
    observedAtMs: 10,
    leaseExpiresAtMs: 10_000,
  });
  return { database, adapter, scope, owner, prepared, proof, proofs: [proof] };
}
