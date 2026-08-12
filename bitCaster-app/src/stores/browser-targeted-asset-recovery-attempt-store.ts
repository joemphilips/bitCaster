import {
  decodeTargetedAssetRecoveryAttemptKey,
  type TargetedAssetRecoveryAttemptKey,
  type TargetedAssetRecoveryCompletedOutcome,
} from "@bitcaster/client-sdk/targetedAssetRecovery";
import { decodeDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import type { BrowserTargetedAssetRecoveryAttemptRow, BitcasterDB } from "./proof-db";

export const BROWSER_TARGETED_ASSET_RECOVERY_ATTEMPTS_MAX_PER_SCOPE = 256;

export interface BrowserTargetedAssetRecoveryAttemptStoreProfile {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  /** This timestamp affects retention only. It is not recovery authority. */
  readonly completedAtUnixMilliseconds: () => number;
}

/** Dexie adapter for completed exact automatic recovery attempts. */
export class BrowserTargetedAssetRecoveryAttemptStore {
  readonly #database: BitcasterDB;
  readonly #scopeId: string;
  readonly #completedAtUnixMilliseconds: () => number;

  constructor(profile: BrowserTargetedAssetRecoveryAttemptStoreProfile) {
    this.#database = profile.database;
    this.#scopeId = decodeDurableCustodyScopeId(profile.scopeId);
    this.#completedAtUnixMilliseconds = profile.completedAtUnixMilliseconds;
    if (this.#database.name !== browserWalletDatabaseName(this.#scopeId)) {
      throw new Error("targeted asset recovery attempt database is foreign");
    }
  }

  async readCompletedAttempt(
    key: TargetedAssetRecoveryAttemptKey,
  ): Promise<TargetedAssetRecoveryCompletedOutcome | null> {
    const decoded = this.#requireScope(key);
    const row = await this.#database.targetedAssetRecoveryAttempts.get(tuple(decoded));
    return row === undefined ? null : decodeBrowserTargetedAssetRecoveryAttemptRow(row).outcome;
  }

  async recordCompletedAttempt(
    key: TargetedAssetRecoveryAttemptKey,
    outcome: TargetedAssetRecoveryCompletedOutcome,
  ): Promise<void> {
    const decoded = this.#requireScope(key);
    const completedAtUnixMilliseconds = requireCompletedAt(this.#completedAtUnixMilliseconds());
    const row = decodeBrowserTargetedAssetRecoveryAttemptRow({
      ...decoded,
      outcome: requireOutcome(outcome),
      completedAtUnixMilliseconds,
    });
    await this.#database.transaction(
      "rw",
      this.#database.targetedAssetRecoveryAttempts,
      async () => {
        const existing = await this.#database.targetedAssetRecoveryAttempts.get(tuple(decoded));
        if (existing !== undefined) {
          decodeBrowserTargetedAssetRecoveryAttemptRow(existing);
          return;
        }
        await this.#database.targetedAssetRecoveryAttempts.add(row);
        const rows = await this.#database.targetedAssetRecoveryAttempts
          .where("scopeId")
          .equals(this.#scopeId)
          .toArray();
        const evicted = rows
          .map(decodeBrowserTargetedAssetRecoveryAttemptRow)
          .sort(compareRows)
          .slice(
            0,
            Math.max(0, rows.length - BROWSER_TARGETED_ASSET_RECOVERY_ATTEMPTS_MAX_PER_SCOPE),
          );
        await Promise.all(
          evicted.map((item) => this.#database.targetedAssetRecoveryAttempts.delete(tuple(item))),
        );
      },
    );
  }

  #requireScope(key: TargetedAssetRecoveryAttemptKey): TargetedAssetRecoveryAttemptKey {
    const decoded = decodeTargetedAssetRecoveryAttemptKey(key);
    if (decoded.scopeId !== this.#scopeId) {
      throw new Error("targeted asset recovery attempt scope is foreign");
    }
    return decoded;
  }
}

export function decodeBrowserTargetedAssetRecoveryAttemptRow(
  value: unknown,
): BrowserTargetedAssetRecoveryAttemptRow {
  if (!isRecord(value) || !exactKeys(value, rowFields)) {
    throw new Error("targeted asset recovery attempt row is invalid");
  }
  return {
    ...decodeTargetedAssetRecoveryAttemptKey({
      scopeId: value.scopeId,
      assetLocator: value.assetLocator,
      backupHeadVersion: value.backupHeadVersion,
      monitoringFactVersion: value.monitoringFactVersion,
    }),
    outcome: requireOutcome(value.outcome),
    completedAtUnixMilliseconds: requireCompletedAt(value.completedAtUnixMilliseconds),
  };
}

function tuple(key: TargetedAssetRecoveryAttemptKey): [string, string, number, string] {
  return [key.scopeId, key.assetLocator, key.backupHeadVersion, key.monitoringFactVersion];
}

function compareRows(
  left: BrowserTargetedAssetRecoveryAttemptRow,
  right: BrowserTargetedAssetRecoveryAttemptRow,
): number {
  return (
    left.completedAtUnixMilliseconds - right.completedAtUnixMilliseconds ||
    compareOrdinal(left.assetLocator, right.assetLocator) ||
    left.backupHeadVersion - right.backupHeadVersion ||
    compareOrdinal(left.monitoringFactVersion, right.monitoringFactVersion)
  );
}

function requireOutcome(value: unknown): TargetedAssetRecoveryCompletedOutcome {
  if (value === "restored-mint" || value === "unavailable" || value === "persistent-error") {
    return value;
  }
  throw new Error("targeted asset recovery attempt outcome is invalid");
}

function requireCompletedAt(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("targeted asset recovery attempt completion time is invalid");
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value).sort(compareOrdinal);
  const expected = [...fields].sort(compareOrdinal);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const rowFields = [
  "scopeId",
  "assetLocator",
  "backupHeadVersion",
  "monitoringFactVersion",
  "outcome",
  "completedAtUnixMilliseconds",
] as const;
