// @vitest-environment node
import "fake-indexeddb/auto";
import { Amount, type Proof } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindBrowserCtfRedeemTerminalProofs } from "../browser-ctf-terminal-binding";
import { createBrowserProofBackupAuthorityRow } from "../browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "../durable-custody-db";
import { addProofs, BitcasterDB, prepareProofOperation, type StoredProof } from "../proof-db";

const MINT = "https://mint.example";
const KEYSET = `01${"11".repeat(32)}`;
const CONDITION_ID = "aa".repeat(32);
const databases: BitcasterDB[] = [];

describe("browser CTF terminal binding", () => {
  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.delete()));
  });

  it("binds retained proof bodies with bounded custody reads and exact replay", async () => {
    const database = createDatabase();
    const scopeId = walletScopeId();
    const proofs = [proof("secret-a"), proof("secret-b")];
    const operationId = "ctf-redeem-terminal-a";
    await addProofs(proofs, database);
    await addCustodyProofs(database, scopeId, proofs);
    const prepared = await prepareProofOperation(
      {
        operationId,
        kind: "ctf-redeem",
        mintUrl: MINT,
        inputs: proofs,
        outputs: { regular: [] },
      },
      database,
    );
    const operation = {
      ...prepared,
      state: "Failed" as const,
      lastError: "oracle did not attest",
      failureCode: 13015,
      updatedAt: Date.now(),
    };
    await database.proofOperations.put(operation);
    const custodyBulkGet = vi.spyOn(database.custodyProofs, "bulkGet");
    const authorityBulkGet = vi.spyOn(database.custodyProofBackupAuthorities, "bulkGet");
    const custodyToArray = vi.spyOn(database.custodyProofs, "toArray");

    await bindBrowserCtfRedeemTerminalProofs({
      operationId,
      mintUrl: MINT,
      scopeId,
      unit: "msat",
      proofs,
      database,
    });

    expect(custodyBulkGet).toHaveBeenCalledOnce();
    expect(authorityBulkGet).toHaveBeenCalledOnce();
    expect(custodyToArray).not.toHaveBeenCalled();
    expect(
      (await database.proofs.toArray()).map(({ terminalOperationId }) => terminalOperationId),
    ).toEqual([operationId, operationId]);

    const custodyRows = await database.custodyProofs.toArray();
    expect(custodyRows.every((row) => row.proofBody.byteLength > 0)).toBe(true);
    const authorities = await database.custodyProofBackupAuthorities.toArray();
    expect(authorities).toHaveLength(2);
    expect(authorities.every((row) => row.terminalOperationId === operationId)).toBe(true);
    expect(
      authorities.every(
        (row) => row.recordUpdatedAtUnixSeconds === Math.floor(operation.updatedAt / 1_000),
      ),
    ).toBe(true);

    await bindBrowserCtfRedeemTerminalProofs({
      operationId,
      mintUrl: MINT,
      scopeId,
      unit: "msat",
      proofs,
      database,
    });
    expect(
      (await database.custodyProofBackupAuthorities.toArray()).every(
        (row) => row.recordUpdatedAtUnixSeconds === Math.floor(operation.updatedAt / 1_000),
      ),
    ).toBe(true);
  });
});

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`browser-ctf-terminal-binding-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}

async function addCustodyProofs(
  database: BitcasterDB,
  scopeId: string,
  proofs: readonly Proof[],
): Promise<void> {
  for (const item of proofs) {
    const custody = createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: item,
      asset: { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: "A" },
      receivedAtMs: 1,
    });
    await database.custodyProofs.put(custody);
    await database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(custody, 2, null, "admission-a"),
    );
  }
}

function proof(secret: string): StoredProof {
  return {
    id: KEYSET,
    amount: Amount.from(1),
    secret,
    C: `02${"33".repeat(32)}`,
    mintUrl: MINT,
    baseAsset: "sat",
    unit: "msat",
    conditionId: CONDITION_ID,
    outcomeCollection: "A",
  };
}

function walletScopeId(): string {
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(32).fill(7));
  return deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId });
}
