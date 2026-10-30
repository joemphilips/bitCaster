/**
 * Delays before the next initial sync read after an unknown result. A read is
 * unknown when it fails or when a selected relay did not connect. A slow relay
 * often connects on a later attempt. The list bounds the number of retries.
 */
export const RELAY_SYNC_RETRY_DELAYS_MS = [15_000, 60_000] as const;

/** One bounded retry schedule for the initial read of one sync identity. */
export function createRelaySyncRetry(delaysMs: readonly number[] = RELAY_SYNC_RETRY_DELAYS_MS) {
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    /** Schedule the next read. Do nothing when the retries are used. */
    schedule(read: () => void): void {
      clearTimeout(timer);
      const delayMs = delaysMs[attempt];
      attempt += 1;
      if (delayMs === undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        read();
      }, delayMs);
    },
    cancel(): void {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
