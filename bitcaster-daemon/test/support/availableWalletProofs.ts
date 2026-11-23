import { isDeepStrictEqual } from 'node:util'
import { profileDir } from '../../src/profile.ts'
import {
  readDaemonWalletProofFromDatabase,
  type StoredProofAsset,
  type StoredProofRecord,
} from '../../src/state.ts'
import { createDaemonStateSqliteSession } from '../../src/stateSqlite.ts'

/**
 * The available wallet rows of one mint and asset, in proof id order. A test
 * reads them to inspect the wallet table. This read does not use custody, so a
 * row counts even when custody does not hold its proof.
 */
export async function readAvailableWalletProofs(
  mintUrl: string,
  asset: StoredProofAsset,
): Promise<StoredProofRecord[]> {
  return createDaemonStateSqliteSession(profileDir()).read((database) =>
    (
      database
        .prepare(
          `SELECT proof_id AS proofId FROM target_wallet_proofs
           WHERE normalized_mint = ? AND state = 'available' ORDER BY proof_id`,
        )
        .all(mintUrl) as Array<{ proofId: string }>
    )
      .map(({ proofId }) => readDaemonWalletProofFromDatabase(database, proofId)!)
      .filter((record) => isDeepStrictEqual(record.asset, asset)),
  )
}
