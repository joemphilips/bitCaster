// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import { reimportFixture } from "./fixtures/browserReimportFixture";
import { admitBrowserEncryptedWalletBackupV2Asset } from "../browserEncryptedWalletBackupV2Admission";
import { retireBrowserEncryptedWalletBackupV2ReimportJournals } from "../browserEncryptedWalletBackupV2ReimportCleanup";
import type { BitcasterDB } from "../../stores/proof-db";

let database: BitcasterDB | undefined;
afterEach(async () => {
  await database?.delete();
});

it.each([
  "none",
  "active work",
  "reservation",
  "retained authority",
  "foreign source",
  "foreign row",
  "foreign record",
  "unfinished record",
  "foreign scope",
  "terminal replay",
  "partial successors",
  "foreign material",
] as const)("retires a completed page only without unsafe references: %s", async (guard) => {
  const fixture = await reimportFixture(2);
  database = fixture.database;
  const sourceOperationId = `${fixture.sourceOperationId}:reimport:guard`;
  // A first admission retains its journal, so the test can exercise each cleanup fence.
  await admitBrowserEncryptedWalletBackupV2Asset({ ...fixture, sourceOperationId });
  const operation = (await database.custodyOperations.toArray())[0]!;
  const operationId = operation.operationId;
  const artifacts = await database.custodyArtifacts.count();
  const proofs = await database.custodyProofs.toArray();
  const byId = new Map(proofs.map((proof) => [proof.proofId, proof]));
  const admitted = fixture.verified.proofs.map(({ proofId }) => ({
    proof: byId.get(proofId)!,
    operationId,
  }));
  const retained = await database.custodyProofBackupAuthorities.toArray();
  switch (guard) {
    case "active work":
      await database.custodyActiveWork.put({
        scopeId: fixture.scopeId,
        operationId,
        nextAttemptAtMs: 0,
        estimatedBytes: 0,
      });
      break;
    case "reservation":
      await database.custodyReservations.put({
        scopeId: fixture.scopeId,
        proofId: proofs[0]!.proofId,
        operationId,
        reservationId: "held",
        inputPosition: 0,
      });
      break;
    case "retained authority": {
      const authority = retained[0]!;
      if (!("backupState" in authority)) throw new Error("missing live authority");
      await database.custodyProofBackupAuthorities.put({
        ...authority,
        proofId: "fe".repeat(32),
        backupState: "local-only",
        admissionOperationId: operationId,
        backupRecordId: null,
        backupRecordCommitment: null,
      });
      break;
    }
    case "foreign record": {
      const record = structuredClone(operation.record);
      record.operation.operationId = "foreign";
      await database.custodyOperations.put({ ...operation, record });
      break;
    }
    case "foreign row":
      await database.custodyOperations.put({ ...operation, revision: operation.revision + 1 });
      break;
    case "unfinished record": {
      const record = structuredClone(operation.record);
      record.operation.state = "dispatch-intent";
      record.operation.result.state = "verified-staged";
      record.operation.proofStorage.lineage.successorAdmission = null;
      await database.custodyOperations.put({
        ...operation,
        record,
        operationState: "dispatch-intent",
      });
      break;
    }
    case "foreign scope":
      admitted[0] = { ...admitted[0]!, proof: { ...admitted[0]!.proof, scopeId: "foreign" } };
      break;
    case "terminal replay": {
      const record = structuredClone(operation.record);
      record.operation.terminalReplayEvidenceRequired = true;
      await database.custodyOperations.put({ ...operation, record });
      break;
    }
    case "partial successors":
      admitted.pop();
      break;
    case "foreign material":
      admitted[0] = {
        ...admitted[0]!,
        proof: { ...admitted[0]!.proof, proofFingerprint: "00".repeat(32) },
      };
      break;
    case "none":
    case "foreign source":
      break;
  }
  const cleanup = database.transaction(
    "rw",
    [
      database.custodyOperations,
      database.custodyArtifacts,
      database.custodyActiveWork,
      database.custodyReservations,
      database.custodyProofBackupAuthorities,
    ],
    async () => {
      await retireBrowserEncryptedWalletBackupV2ReimportJournals({
        database: database!,
        scopeId: fixture.scopeId,
        sourceOperationId:
          guard === "foreign source" ? `${sourceOperationId}-foreign` : sourceOperationId,
        admitted,
      });
    },
  );
  if (guard === "terminal replay")
    await expect(cleanup).rejects.toThrow("custody terminal replay authority is invalid");
  else if (guard === "foreign record") await expect(cleanup).rejects.toThrow(/custody/);
  else await cleanup;
  expect(await database.custodyOperations.count()).toBe(guard === "none" ? 0 : 1);
  expect(await database.custodyArtifacts.count()).toBe(guard === "none" ? 0 : artifacts);
  expect(await database.custodyProofs.count()).toBe(2);
  expect(await database.proofs.count()).toBe(2);
});
