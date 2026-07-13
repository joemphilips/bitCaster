export type EncryptedWalletBackupCasState =
  | "sealed"
  | "cas-uncertain"
  | "retry-cas"
  | "retry-exhausted"
  | "reconcile-before-retry"
  | "acknowledged"
  | "fork-rejected";

/** Dependency-neutral persisted CAS policy shared by every decoder. */
export const ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX = 3 as const;
export const ENCRYPTED_WALLET_BACKUP_CAS_PAYLOAD_MAX_BYTES = 196_608 as const;
export const ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX = 32 as const;

export type EncryptedWalletBackupAggregateLifecycle =
  | "active"
  | "abort-uncertain"
  | "cas-journaled"
  | "fork-cleanup-uncertain"
  | "abandoned"
  | "complete";

/** Rejects persisted histories that the CAS state machine cannot produce. */
export function validateEncryptedWalletBackupCasState(input: {
  state: EncryptedWalletBackupCasState;
  casAttempts: number;
  retryStreak: number;
  retryNotBeforeUnixMilliseconds: number | null;
}): void {
  if (
    !Number.isSafeInteger(input.retryStreak) ||
    input.retryStreak < 0 ||
    input.retryStreak > ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX
  ) {
    throw new Error("backup CAS retry streak is invalid");
  }
  const hasRetryBoundary = input.retryNotBeforeUnixMilliseconds !== null;
  let valid = false;
  switch (input.state) {
    case "sealed":
      valid = input.casAttempts === 0 && !hasRetryBoundary;
      break;
    case "cas-uncertain":
      valid =
        input.casAttempts >= 1 &&
        input.casAttempts <= ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX &&
        !hasRetryBoundary;
      break;
    case "retry-cas":
      valid =
        input.casAttempts >= 1 &&
        input.casAttempts < ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX &&
        !hasRetryBoundary;
      break;
    case "retry-exhausted":
      valid =
        input.casAttempts >= 1 &&
        input.casAttempts <= ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX &&
        input.retryStreak >= 1 &&
        hasRetryBoundary;
      break;
    case "reconcile-before-retry":
      valid =
        input.casAttempts >= 1 &&
        input.casAttempts <= ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX &&
        input.retryStreak >= 1 &&
        !hasRetryBoundary;
      break;
    case "acknowledged":
      valid =
        input.casAttempts >= 1 &&
        input.casAttempts <= ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX &&
        input.retryStreak === 0 &&
        !hasRetryBoundary;
      break;
    case "fork-rejected":
      valid =
        input.casAttempts >= 1 &&
        input.casAttempts <= ENCRYPTED_WALLET_BACKUP_CAS_ATTEMPT_MAX &&
        !hasRetryBoundary;
      break;
    default:
      return assertNever(input.state);
  }
  if (!valid) throw new Error("backup CAS state and attempt count are invalid");
}

/** Exhaustive relation between the upload aggregate and its linked CAS row. */
export function validateEncryptedWalletBackupAggregateCasLifecycle(input: {
  lifecycle: EncryptedWalletBackupAggregateLifecycle;
  state: EncryptedWalletBackupCasState;
}): void {
  let valid = false;
  switch (input.lifecycle) {
    case "active":
    case "abort-uncertain":
      valid = false;
      break;
    case "cas-journaled":
      valid =
        input.state === "sealed" ||
        input.state === "cas-uncertain" ||
        input.state === "retry-cas" ||
        input.state === "retry-exhausted" ||
        input.state === "reconcile-before-retry";
      break;
    case "fork-cleanup-uncertain":
    case "abandoned":
      valid = input.state === "fork-rejected";
      break;
    case "complete":
      valid = input.state === "acknowledged" || input.state === "fork-rejected";
      break;
    default:
      return assertNever(input.lifecycle);
  }
  if (!valid) {
    throw new Error("backup aggregate and CAS lifecycles are inconsistent");
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported backup CAS state: ${String(value)}`);
}
