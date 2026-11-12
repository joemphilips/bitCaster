import Dexie from "dexie";
import { pageActiveCtfRangePreparations } from "../stores/ctf-range-order-db";
import type { BitcasterDB } from "../stores/proof-db";
import { deleteSeedRestoreDatabase } from "../stores/seed-restore-db";
import {
  browserRecoveryIndexListsEveryLocalKeyset,
  type BrowserRecoveryIndexHandoff,
} from "./browserRecoveryIndex";
import { browserWalletDatabaseName } from "./browserWalletProfile";
import { withWalletProfileLock } from "./walletProfileLock";

const TEXT_KEY_MIN = "";
const TEXT_KEY_MAX = "￿";

export type BrowserSeedHandoffRefusalCode =
  | "active-wallet-work"
  | "backup-not-current"
  | "browser-lock-unavailable"
  | "seed-backup-unconfirmed";

export class BrowserSeedHandoffRefusal extends Error {
  constructor(
    readonly code: BrowserSeedHandoffRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserSeedHandoffRefusal";
  }
}

export interface BrowserSeedHandoffResult {
  /** The engine refused a growing write. A later restore of the old seed can be partial. */
  readonly backupPartial: boolean;
}

/**
 * Activate a new seed, then delete the old wallet database (ADR-034 recovery
 * index amendment, "Seed handoff"). The user restores the old wallet from its
 * written seed and the recovery index. The handoff waits while an operation
 * can still settle, or while the index of a local keyset is not acknowledged.
 */
export async function handoffBrowserSeed(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly isCurrentProfile: () => boolean;
  /** The user confirmed the written copy of the current seed. */
  readonly currentSeedBackupConfirmed: boolean;
  /** Read the recovery index again and upload the pending keysets. */
  readonly prepareRecoveryIndex: () => Promise<BrowserRecoveryIndexHandoff>;
  /** Check app-level unfinished orders after the asynchronous checks and before invalidation. */
  readonly assertNoPendingOrders: () => void;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly invalidateOldProfile: () => void;
  readonly activateNewProfile: () => Promise<void>;
  readonly restoreOldProfile: () => Promise<void>;
}): Promise<BrowserSeedHandoffResult> {
  requireCapturedDatabase(input);
  const lockManager = input.lockManager ?? globalThis.navigator?.locks;
  if (!lockManager) {
    throw new BrowserSeedHandoffRefusal(
      "browser-lock-unavailable",
      "This browser cannot safely lock the wallet profile",
    );
  }
  if (!input.currentSeedBackupConfirmed) {
    throw new BrowserSeedHandoffRefusal(
      "seed-backup-unconfirmed",
      "browser seed handoff requires a confirmed written seed",
    );
  }
  const index = await input.prepareRecoveryIndex();
  if (index.kind === "unavailable") {
    throw new BrowserSeedHandoffRefusal(
      "backup-not-current",
      "browser seed handoff waits for the recovery index",
    );
  }
  await withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCapturedDatabase(input);
      await requireNoPendingWalletWork(input.database, input.scopeId);
      // A keyset that an operation added after the acknowledgement is pending.
      if (
        index.kind === "acknowledged" &&
        !(await browserRecoveryIndexListsEveryLocalKeyset(
          input.database,
          input.scopeId,
          index.listed,
        ))
      ) {
        throw new BrowserSeedHandoffRefusal(
          "backup-not-current",
          "browser seed handoff has a keyset that the recovery index does not list",
        );
      }
      requireCapturedDatabase(input);
      input.assertNoPendingOrders();
      input.invalidateOldProfile();
      try {
        await input.activateNewProfile();
      } catch (error) {
        await input.restoreOldProfile();
        throw error;
      }

      // Persisting the new seed is the commit point. If cache cleanup then
      // fails, keep the new profile active and leave the old cache recoverable.
      try {
        // Delete the seed restore record first. A "generated" origin without
        // the wallet data would skip the restore of a later import of this
        // seed. A record without wallet data only repeats the mint scan.
        await deleteSeedRestoreDatabase(input.scopeId);
        input.database.close();
        await input.database.delete();
      } catch {
        // Do not roll back to the old profile after the new seed is durable.
      }
    },
    lockManager,
  );
  return { backupPartial: index.kind === "growing-write-refused" };
}

/**
 * An order or mint operation that can still settle, an uncertain settlement,
 * an unapplied exact refund, or an unfinished outgoing transfer, deposit, or
 * withdrawal keeps the old wallet database (ADR-034, "Seed handoff").
 */
async function requireNoPendingWalletWork(database: BitcasterDB, scopeId: string): Promise<void> {
  const [activeWork, preparedOperation, activeRanges, outgoingAuthority, pendingDeposit] =
    await Promise.all([
      database.custodyActiveWork
        .where("[scopeId+operationId]")
        .between([scopeId, TEXT_KEY_MIN], [scopeId, TEXT_KEY_MAX])
        .limit(1)
        .first(),
      database.proofOperations.where("state").equals("prepared").limit(1).first(),
      pageActiveCtfRangePreparations({ scopeId, limit: 1 }, database),
      database.outgoingCashuTransfers
        .where("[scopeId+localAuthorityState+transferId]")
        .between([scopeId, "nonterminal", TEXT_KEY_MIN], [scopeId, "nonterminal", TEXT_KEY_MAX])
        .limit(1)
        .first(),
      // An unfinished deposit has no signed proof yet. The seed restore cannot
      // recover it after the old database is deleted.
      database.mintQuotes
        .where("[scopeId+paymentMethod+recoveryState+lastRecoveryAttemptAtMs+quoteRecordId]")
        .between(
          [scopeId, "bolt11", "pending", Dexie.minKey, Dexie.minKey],
          [scopeId, "bolt11", "pending", Dexie.maxKey],
        )
        .limit(1)
        .first(),
    ]);
  if (
    activeWork !== undefined ||
    preparedOperation !== undefined ||
    activeRanges.preparations.length > 0 ||
    outgoingAuthority !== undefined ||
    pendingDeposit !== undefined
  ) {
    throw new BrowserSeedHandoffRefusal(
      "active-wallet-work",
      "browser seed handoff has unfinished wallet work",
    );
  }
  // A reserved or unverified proof can still settle.
  for (const selectability of ["locked", "retained-unverified"] as const) {
    const proof = await database.custodyProofs
      .where("[scopeId+selectability]")
      .equals([scopeId, selectability])
      .limit(1)
      .first();
    if (proof !== undefined) {
      throw new BrowserSeedHandoffRefusal(
        "active-wallet-work",
        "browser seed handoff has a reserved or unverified proof",
      );
    }
  }
}

function requireCapturedDatabase(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly isCurrentProfile: () => boolean;
}): void {
  if (
    input.database.name !== browserWalletDatabaseName(input.scopeId) ||
    !input.isCurrentProfile()
  ) {
    throw new Error("browser seed handoff profile is stale");
  }
}
