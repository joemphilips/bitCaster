// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { deriveConditionalKeysetId, type Proof } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserWalletDatabaseName } from "../../lib/browserWalletProfile";
import { commitBrowserCtfTerminalOperation } from "../../test/browserEncryptedWalletBackupV2CommittedTerminalFixture";
import { BrowserEncryptedWalletBackupV2TerminalSealStore } from "../browser-encrypted-wallet-backup-v2-terminal-seal-store";
import { BrowserDurableCustodyAdapter, createBrowserCustodyProofRow } from "../durable-custody-db";
import {
  createBrowserProofBackupAuthorityRow,
  requireBrowserLiveProofBackupAuthorityTableRow,
} from "../browser-proof-backup-authority";
import { BitcasterDB } from "../proof-db";

const MINT = "https://mint.example";
const PUBLIC_KEY = `02${"22".repeat(32)}`;
const CONDITION_ID = "aa".repeat(32);
const OUTCOME_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: "YES",
});
const KEYSET = deriveConditionalKeysetId({
  keys: { "1": PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 0,
  final_expiry: 2,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_ID,
});
const databases: BitcasterDB[] = [];

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe("browser V2 terminal seal store", () => {
  it("requires one stable classification time for all terminal inputs", async () => {
    const fixture = await terminalFixture(17, 2);
    const store = new BrowserEncryptedWalletBackupV2TerminalSealStore({
      database: fixture.database,
      scopeId: fixture.scope.scopeId,
    });
    const callback = vi.fn(({ record, exactRejection, classifiedAtMs }) => {
      expect(Dexie.currentTransaction).toBeDefined();
      expect(record.operation.operationId).toBe(fixture.operationId);
      expect(exactRejection.fingerprint).toBe(fixture.rejection.fingerprint);
      expect(classifiedAtMs).toBe(20);
      return "issued";
    });

    await expect(store.withCommittedTerminalRejection(fixture.operationId, callback)).resolves.toBe(
      "issued",
    );
    expect(callback).toHaveBeenCalledOnce();

    const secondAuthorityRow = await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scope.scopeId,
      fixture.proofIds[1]!,
    ]);
    if (!secondAuthorityRow) throw new Error("test second authority is missing");
    const secondAuthority = requireBrowserLiveProofBackupAuthorityTableRow(secondAuthorityRow, [
      fixture.scope.scopeId,
      fixture.proofIds[1]!,
    ]);
    if (!secondAuthority) throw new Error("test second live authority is missing");
    await fixture.database.custodyProofBackupAuthorities.put({
      ...secondAuthority,
      updatedAtMs: 21,
      recordUpdatedAtUnixSeconds: 0,
    });
    const rejected = vi.fn(() => "unexpected");
    await expect(
      store.withCommittedTerminalRejection(fixture.operationId, rejected),
    ).rejects.toThrow("classification time is unstable");
    expect(rejected).not.toHaveBeenCalled();
  });

  it("fails closed when the committed rejection artifact is missing", async () => {
    const fixture = await terminalFixture(19);
    await fixture.database.custodyArtifacts.delete([
      fixture.scope.scopeId,
      fixture.operationId,
      fixture.rejectionReferenceArtifactId,
    ]);
    const store = new BrowserEncryptedWalletBackupV2TerminalSealStore({
      database: fixture.database,
      scopeId: fixture.scope.scopeId,
    });
    await expect(
      store.withCommittedTerminalRejection(fixture.operationId, () => true),
    ).rejects.toThrow(/referenced artifact is missing/);
  });

  it("fails closed when the exact input is not bound to the terminal operation", async () => {
    const fixture = await terminalFixture(20);
    const authorityRow = await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scope.scopeId,
      fixture.proofId,
    ]);
    if (!authorityRow) throw new Error("test authority is missing");
    const authority = requireBrowserLiveProofBackupAuthorityTableRow(authorityRow, [
      fixture.scope.scopeId,
      fixture.proofId,
    ]);
    if (!authority) throw new Error("test live authority is missing");
    await fixture.database.custodyProofBackupAuthorities.put({
      ...authority,
      terminalOperationId: "foreign-terminal-operation",
    });
    const store = new BrowserEncryptedWalletBackupV2TerminalSealStore({
      database: fixture.database,
      scopeId: fixture.scope.scopeId,
    });
    await expect(
      store.withCommittedTerminalRejection(fixture.operationId, () => true),
    ).rejects.toThrow(/terminal (?:input proof )?authority is invalid/);
  });

  it("rejects a non-wallet scope and a foreign wallet database", async () => {
    const scope = walletScope(21);
    const database = new BitcasterDB(browserWalletDatabaseName(scope.scopeId));
    databases.push(database);
    expect(
      () =>
        new BrowserEncryptedWalletBackupV2TerminalSealStore({
          database,
          scopeId: deriveDurableCustodyScopeId({
            scopeKind: "condition-inventory",
            conditionId: "aa".repeat(32),
            inventoryAccountId: "account",
            normalizedMint: MINT,
            unit: "msat",
          }),
        }),
    ).toThrow(/requires a wallet scope/);

    const foreignScope = walletScope(22);
    expect(
      () =>
        new BrowserEncryptedWalletBackupV2TerminalSealStore({
          database,
          scopeId: foreignScope.scopeId,
        }),
    ).toThrow(/database is foreign/);
  });
});

async function terminalFixture(seedByte: number, inputCount = 1) {
  const scope = walletScope(seedByte);
  const database = new BitcasterDB(browserWalletDatabaseName(scope.scopeId));
  databases.push(database);
  const adapter = new BrowserDurableCustodyAdapter(database);
  const owner = await adapter.claimScope(scope, {
    incarnationId: `browser-${seedByte}`,
    observedAtMs: 10,
    leaseExpiresAtMs: 10_000,
  });
  const requestedOperationId = `ctf-redeem-terminal-${seedByte}`;
  const inputs = Array.from({ length: inputCount }, (_, index) =>
    proof(`terminal-proof-${seedByte}-${index}`),
  );
  const predecessors = inputs.map((input) =>
    createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: input,
      asset: { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: "YES" },
      receivedAtMs: 1,
    }),
  );
  await database.custodyProofs.bulkPut(predecessors);
  await database.custodyProofBackupAuthorities.bulkPut(
    predecessors.map((predecessor, index) =>
      createBrowserProofBackupAuthorityRow(predecessor, 10, null, `admission-${seedByte}-${index}`),
    ),
  );
  await database.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId: scope.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    keysetId: KEYSET,
    denominationPublicKeys: { "1": PUBLIC_KEY },
    inputFeePpk: 0,
    conditionId: CONDITION_ID,
    outcomeCollection: "YES",
    outcomeCollectionId: OUTCOME_ID,
    registeredAtUnixSeconds: 1,
    finalExpiryUnixSeconds: 2,
    curve: "secp256k1",
  });
  const committed = await commitBrowserCtfTerminalOperation({
    adapter,
    scope,
    owner,
    operationId: requestedOperationId,
    mintUrl: MINT,
    proofs: inputs,
    predecessorProofs: predecessors,
    publicKey: PUBLIC_KEY,
  });
  return {
    database,
    scope,
    operationId: committed.operationId,
    proofId: predecessors[0]!.proofId,
    proofIds: predecessors.map(({ proofId }) => proofId),
    rejection: committed.rejection,
    rejectionReferenceArtifactId: committed.rejectionReferenceArtifactId,
  };
}

function proof(secret: string): Proof {
  return { id: KEYSET, amount: 1 as never, secret, C: PUBLIC_KEY };
}

function walletScope(seedByte: number): Extract<DurableCustodyScope, { scopeKind: "wallet" }> {
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(32).fill(seedByte));
  return {
    scopeKind: "wallet",
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
  };
}
