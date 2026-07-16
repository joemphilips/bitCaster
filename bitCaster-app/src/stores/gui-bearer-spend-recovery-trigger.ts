export const GUI_BEARER_SPEND_RECOVERY_REQUEST_EVENT =
  "bitcaster:wallet-bearer-recovery-request" as const;

export function notifyGuiBearerSpendRecoveryRequested(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(GUI_BEARER_SPEND_RECOVERY_REQUEST_EVENT));
}
