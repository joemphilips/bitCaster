import Dexie from "dexie";
import { decodeDurableWalletProofDerivationLocator } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { seedCounterGapWarning } from "@bitcaster/client-sdk/recoveryIndexRestore";
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
  | "backup-partial"
  | "browser-lock-unavailable"
  | "counter-gap"
  | "seed-backup-unconfirmed";

export class BrowserSeedHandoffRefusal extends Error {
  constructor(
    readonly code: BrowserSeedHandoffRefusalCode,
    message: string,
    /** For `counter-gap`: the CLI gap that passes the longest run of unused counters. */
    readonly cliGapLimit: number | null = null,
  ) {
    super(message);
    this.name = "BrowserSeedHandoffRefusal";
  }
}

/**
 * The longest run of unused counters before a later signed output, over the
 * local keysets of this browser (ADR-034 recovery index amendment, "Seed
 * handoff"). A GUI restore stops after 300 unused counters, so it would miss
 * the later output. The signed outputs are the NUT-13 counters of the proofs
 * that this browser holds or held. A counter that the browser does not know
 * can only lengthen a run, so the check can warn too often but not too rarely.
 * A live proof without a NUT-13 locator, for example melt change, has an
 * unknown counter below the cursor: the run can end there.
 */
export async function browserSeedHandoffCounterGap(
  database: BitcasterDB,
  scopeId: string,
): Promise<{ readonly longestRun: number; readonly cliGapLimit: number } | null> {
  const cursors = new Map(
    (await database.walletCounterCursors.where("scopeId").equals(scopeId).toArray()).map(
      ({ keysetId, next }) => [keysetId, next],
    ),
  );
  const local = new Set(cursors.keys());
  const signed = new Map<string, number[]>();
  const located = new Set<string>();
  const authorities = await database.custodyProofBackupAuthorities
    .where("[scopeId+proofId]")
    .between([scopeId, Dexie.minKey], [scopeId, Dexie.maxKey], true, true)
    .toArray();
  for (const row of authorities) {
    // A removal marker holds no locator.
    const derivationLocator = (row as { readonly derivationLocator?: unknown }).derivationLocator;
    if (derivationLocator === undefined || derivationLocator === null) continue;
    let locator;
    try {
      locator = decodeDurableWalletProofDerivationLocator(derivationLocator);
    } catch {
      continue;
    }
    if (locator.kind !== "nut13" || !local.has(locator.keysetId)) continue;
    located.add(row.proofId);
    const counters = signed.get(locator.keysetId) ?? [];
    counters.push(locator.counter);
    signed.set(locator.keysetId, counters);
  }
  // The keysets that hold a live proof whose counter is not recorded.
  const unknown = new Set<string>();
  const proofs = await database.custodyProofs
    .where("[scopeId+selectability]")
    .between([scopeId, Dexie.minKey], [scopeId, Dexie.maxKey], true, true)
    .toArray();
  for (const proof of proofs) {
    if (proof.selectability === "spent" || located.has(proof.proofId)) continue;
    if (local.has(proof.keysetId)) unknown.add(proof.keysetId);
  }
  let worst: { readonly longestRun: number; readonly cliGapLimit: number } | null = null;
  for (const keysetId of local) {
    const counters = [...(signed.get(keysetId) ?? [])];
    // The latest place of an unknown signed output: the counter below the cursor.
    const cursor = cursors.get(keysetId);
    if (unknown.has(keysetId) && cursor !== undefined && cursor > 0) counters.push(cursor - 1);
    const warning = seedCounterGapWarning(counters);
    if (warning !== null && (worst === null || warning.longestRun > worst.longestRun)) {
      worst = warning;
    }
  }
  return worst;
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
  /**
   * The user saw that the backup of the current wallet is incomplete and
   * replaces the wallet anyway. Without it, a refused growing write stops the
   * handoff before the commit point.
   */
  readonly acceptPartialBackup: boolean;
  /**
   * The user saw that a GUI restore of the current wallet can miss funds after
   * a long run of unused counters, and replaces the wallet anyway.
   */
  readonly acceptCounterGap: boolean;
  /** Read the recovery index again and upload the pending keysets. */
  readonly prepareRecoveryIndex: () => Promise<BrowserRecoveryIndexHandoff>;
  /** Check app-level unfinished orders after the asynchronous checks and before invalidation. */
  readonly assertNoPendingOrders: () => void;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly invalidateOldProfile: () => void;
  readonly activateNewProfile: () => Promise<void>;
  readonly restoreOldProfile: () => Promise<void>;
}): Promise<void> {
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
  if (index.kind === "growing-write-refused" && !input.acceptPartialBackup) {
    throw new BrowserSeedHandoffRefusal(
      "backup-partial",
      "browser seed handoff needs the user to accept a partial backup",
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
      // The warning comes before the commit point. The handoff stays permitted.
      const gap = input.acceptCounterGap
        ? null
        : await browserSeedHandoffCounterGap(input.database, input.scopeId);
      if (gap !== null) {
        throw new BrowserSeedHandoffRefusal(
          "counter-gap",
          "browser seed handoff needs the user to accept a long run of unused counters",
          gap.cliGapLimit,
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
