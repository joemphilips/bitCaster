const BROWSER_CTF_RANGE_RECOVERY_WAKE_EVENT = "bitcaster:ctf-range-recovery-wake";

export interface BrowserCtfRangeOrderRecoveryWake {
  readonly scopeId: string;
}

interface ActiveAttemptState {
  readonly operationIds: Set<string>;
  wakePending: boolean;
}

const activeAttempts = new Map<string, ActiveAttemptState>();

export function beginBrowserCtfRangeOrderAttempt(input: {
  readonly scopeId: string;
  readonly operationId: string;
}): void {
  const state = activeAttempts.get(input.scopeId) ?? {
    operationIds: new Set<string>(),
    wakePending: false,
  };
  state.operationIds.add(input.operationId);
  activeAttempts.set(input.scopeId, state);
}

export function hasActiveBrowserCtfRangeOrderAttempt(scopeId: string): boolean {
  return (activeAttempts.get(scopeId)?.operationIds.size ?? 0) > 0;
}

export function endBrowserCtfRangeOrderAttempt(input: {
  readonly scopeId: string;
  readonly operationId: string;
  readonly retainedRecoveryWork: boolean;
}): void {
  const state = activeAttempts.get(input.scopeId);
  if (state === undefined) return;

  state.operationIds.delete(input.operationId);
  state.wakePending ||= input.retainedRecoveryWork;
  if (state.operationIds.size > 0) return;

  activeAttempts.delete(input.scopeId);
  if (state.wakePending) publishBrowserCtfRangeRecoveryWake({ scopeId: input.scopeId });
}

export function publishBrowserCtfRangeRecoveryWake(wake: BrowserCtfRangeOrderRecoveryWake): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<BrowserCtfRangeOrderRecoveryWake>(BROWSER_CTF_RANGE_RECOVERY_WAKE_EVENT, {
      detail: wake,
    }),
  );
}

export function listenForBrowserCtfRangeRecoveryWake(
  scopeId: string,
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onWake = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (
      detail === null ||
      typeof detail !== "object" ||
      typeof (detail as { scopeId?: unknown }).scopeId !== "string"
    ) {
      return;
    }
    if ((detail as { scopeId: string }).scopeId !== scopeId) return;
    listener();
  };
  window.addEventListener(BROWSER_CTF_RANGE_RECOVERY_WAKE_EVENT, onWake);
  return () => window.removeEventListener(BROWSER_CTF_RANGE_RECOVERY_WAKE_EVENT, onWake);
}
