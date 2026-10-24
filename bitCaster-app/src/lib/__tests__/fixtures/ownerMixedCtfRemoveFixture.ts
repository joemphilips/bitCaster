import { BitcasterDB } from "../../../stores/proof-db";
import { decodeBrowserCustodyProofRow } from "../../../stores/durable-custody-types";
import { ownerCtfRemovalFixture, addLocalCompanion } from "./ownerCtfRemovalProofs";

/** One genuine Owner-backed loser and one committed, never-retained local loser. */
export async function createMixedCtfRemoveFixture() {
  const f = await ownerCtfRemovalFixture(1);
  try {
    const local = await addLocalCompanion(f);
    const localProof = decodeBrowserCustodyProofRow(
      await f.database.custodyProofs.get([f.scopeId, local.proofId]),
    );
    return {
      ...f,
      managedProof: f.proofs[0]!,
      localProof,
      managedTargets: f.input().targets,
      localTargets: [local],
      authorityStore: f.remote.store,
      input: (database: BitcasterDB = f.database, includeLocalTargets = true) => ({
        ...f.input(),
        database,
        ...(includeLocalTargets ? { localTargets: [local] } : {}),
        observedAtMs: 23_000,
      }),
    };
  } catch (error) {
    f.database.close();
    await f.database.delete();
    throw error;
  }
}
