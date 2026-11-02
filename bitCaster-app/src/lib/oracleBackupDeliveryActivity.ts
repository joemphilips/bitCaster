import { useSyncExternalStore } from "react";

/**
 * Session facts about oracle backup delivery attempts in this browser tab.
 * The durable delivery state cannot tell a running attempt from a finished
 * one, so the creator page uses these facts to decide when "no relay has
 * saved this backup" is a settled result. Nothing here is persisted.
 */
interface Activity {
  running: number;
  /** The latest finished attempt could not prepare its backup stage. */
  preparationFailed: boolean;
}

const activities = new Map<string, Activity>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function activity(conditionId: string): Activity {
  let entry = activities.get(conditionId);
  if (!entry) {
    entry = { running: 0, preparationFailed: false };
    activities.set(conditionId, entry);
  }
  return entry;
}

/** Record one delivery attempt for its whole duration. */
export function trackOracleBackupDelivery<T extends { readonly failures: readonly string[] }>(
  conditionId: string,
  start: () => Promise<T>,
): Promise<T> {
  const entry = activity(conditionId);
  entry.running += 1;
  notify();
  let attempt: Promise<T>;
  try {
    attempt = start();
  } catch (error) {
    attempt = Promise.reject(error);
  }
  return attempt.then(
    (result) => {
      entry.running -= 1;
      entry.preparationFailed = result.failures.includes("preparation");
      notify();
      return result;
    },
    (error: unknown) => {
      // An attempt without a result did not prove that a stage exists.
      entry.running -= 1;
      entry.preparationFailed = true;
      notify();
      throw error;
    },
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface OracleBackupDeliveryActivity {
  readonly running: boolean;
  readonly preparationFailed: boolean;
}

export function useOracleBackupDeliveryActivity(conditionId: string): OracleBackupDeliveryActivity {
  const running = useSyncExternalStore(
    subscribe,
    () => (activities.get(conditionId)?.running ?? 0) > 0,
  );
  const preparationFailed = useSyncExternalStore(
    subscribe,
    () => activities.get(conditionId)?.preparationFailed ?? false,
  );
  return { running, preparationFailed };
}
