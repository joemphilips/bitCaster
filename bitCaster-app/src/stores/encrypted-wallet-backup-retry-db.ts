import {
  ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX,
  planEncryptedWalletBackupRetry,
} from "@bitcaster/client-sdk/encryptedWalletBackupRetrySchedule";
import type { BitcasterDB, EncryptedWalletBackupDexieRetrySchedulerRow } from "./proof-db";

export async function readEncryptedWalletBackupRetryScheduler(
  database: BitcasterDB,
  input: Readonly<{ scopeId: string; realm: string; walletId: string }>,
): Promise<EncryptedWalletBackupDexieRetrySchedulerRow | null> {
  const row = await database.encryptedWalletBackupRetrySchedulers.get([
    input.scopeId,
    input.realm,
    input.walletId,
  ]);
  if (row === undefined) return null;
  return validateRetrySchedulerRow(row, input);
}

export async function clearEncryptedWalletBackupRetryScheduler(
  database: BitcasterDB,
  input: Readonly<{ scopeId: string; realm: string; walletId: string; attemptId: string }>,
): Promise<void> {
  validateRetrySchedulerIdentity(input);
  await database.transaction("rw", database.encryptedWalletBackupRetrySchedulers, async () => {
    const current = await database.encryptedWalletBackupRetrySchedulers.get([
      input.scopeId,
      input.realm,
      input.walletId,
    ]);
    if (current?.attemptId === input.attemptId) {
      await database.encryptedWalletBackupRetrySchedulers.delete([
        input.scopeId,
        input.realm,
        input.walletId,
      ]);
    }
  });
}

export async function scheduleEncryptedWalletBackupRetry(
  database: BitcasterDB,
  input: Readonly<{
    scopeId: string;
    realm: string;
    walletId: string;
    attemptId: string;
    minimumDelayMilliseconds: number;
  }>,
): Promise<EncryptedWalletBackupDexieRetrySchedulerRow> {
  validateRetrySchedulerIdentity(input);
  if (!/^[0-9a-f]{32}$/.test(input.attemptId)) {
    throw new Error("encrypted wallet backup retry scheduler attempt is invalid");
  }
  return database.transaction("rw", database.encryptedWalletBackupRetrySchedulers, async () => {
    const current = await database.encryptedWalletBackupRetrySchedulers.get([
      input.scopeId,
      input.realm,
      input.walletId,
    ]);
    const now = Date.now();
    const prior =
      current?.attemptId === input.attemptId ? validateRetrySchedulerRow(current, input) : null;
    if (prior !== null && prior.retryNotBeforeUnixMilliseconds > now) return prior;
    const schedule = planEncryptedWalletBackupRetry({
      realm: input.realm,
      walletId: input.walletId,
      attemptId: input.attemptId,
      currentStreak: prior?.retryStreak ?? 0,
      minimumDelayMilliseconds: Math.max(
        input.minimumDelayMilliseconds,
        prior === null ? 1 : Math.max(1, prior.retryNotBeforeUnixMilliseconds - now),
      ),
    });
    const row = validateRetrySchedulerRow(
      {
        scopeId: input.scopeId,
        realm: input.realm,
        walletId: input.walletId,
        attemptId: input.attemptId,
        retryStreak: schedule.streak,
        retryNotBeforeUnixMilliseconds: Math.max(
          now + schedule.delayMilliseconds,
          prior?.retryNotBeforeUnixMilliseconds ?? 0,
        ),
      },
      input,
    );
    await database.encryptedWalletBackupRetrySchedulers.put(row);
    return row;
  });
}

function validateRetrySchedulerRow(
  row: EncryptedWalletBackupDexieRetrySchedulerRow,
  identity: Readonly<{ scopeId: string; realm: string; walletId: string }>,
): EncryptedWalletBackupDexieRetrySchedulerRow {
  if (
    typeof row !== "object" ||
    row === null ||
    Object.keys(row).length !== 6 ||
    Object.keys(row).some(
      (key) =>
        key !== "scopeId" &&
        key !== "realm" &&
        key !== "walletId" &&
        key !== "attemptId" &&
        key !== "retryStreak" &&
        key !== "retryNotBeforeUnixMilliseconds",
    )
  ) {
    throw new Error("encrypted wallet backup retry scheduler row is invalid");
  }
  validateRetrySchedulerIdentity(row);
  if (
    row.scopeId !== identity.scopeId ||
    row.realm !== identity.realm ||
    row.walletId !== identity.walletId ||
    !/^[0-9a-f]{32}$/.test(row.attemptId) ||
    !Number.isSafeInteger(row.retryStreak) ||
    row.retryStreak < 0 ||
    row.retryStreak > ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX ||
    !Number.isSafeInteger(row.retryNotBeforeUnixMilliseconds) ||
    row.retryNotBeforeUnixMilliseconds < 0
  ) {
    throw new Error("encrypted wallet backup retry scheduler row is invalid");
  }
  return Object.freeze({ ...row });
}

function validateRetrySchedulerIdentity(
  input: Readonly<{
    scopeId: string;
    realm: string;
    walletId: string;
  }>,
): void {
  if (
    !/^[^\s]{1,128}$/.test(input.scopeId) ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(input.realm) ||
    !/^[0-9a-f]{64}$/.test(input.walletId)
  ) {
    throw new Error("encrypted wallet backup retry scheduler identity is invalid");
  }
}
