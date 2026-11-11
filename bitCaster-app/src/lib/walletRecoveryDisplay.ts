import {
  sameWalletRecoveryTag,
  walletRecoveryEmptyIsTerminal,
  type WalletRecoveryHoldingsRead,
  type WalletRecoveryStatus,
  type WalletRecoveryUnavailableReason,
} from "@bitcaster/client-sdk/walletRecoveryStatus";

/**
 * How the browser shows the wallet recovery status and its holdings reads
 * (issue #161). One status row shows this display above the holdings. The
 * SDK rule decides when an empty holdings list is final.
 */

/** The text group of a pending recovery. */
export type WalletRecoveryPendingText = "restoring" | "waitingForMint" | "resumesAt";

/** What the user can do about an unavailable recovery or holdings read. */
export type WalletRecoveryAction =
  /** Reset the backoff and wake the recovery. */
  | "retry"
  /** Reload the page. */
  | "reload"
  /** Reload the page, or restore the wallet from its seed in Settings. */
  | "reload-or-restore"
  /** Show nothing: the visitor has no wallet, and the page shows its wallet setup. */
  | "none";

export type WalletRecoveryDisplay =
  | { readonly state: "complete" }
  | { readonly state: "checking" }
  | {
      readonly state: "pending";
      readonly text: WalletRecoveryPendingText;
      /** The resume time of a `resumesAt` text, else null. */
      readonly retryAtMs: number | null;
    }
  | {
      readonly state: "unavailable";
      /** `custody-unavailable`: a holdings read of the local wallet failed. */
      readonly reason: WalletRecoveryUnavailableReason | "custody-unavailable";
      readonly action: WalletRecoveryAction;
      readonly scopeId: string | null;
    };

/**
 * The display of one surface. The order is the SDK precedence: an
 * unavailable status, then a failed holdings read, then checking, then
 * pending. A completed recovery is still checking until each holdings read
 * of the surface has the current tag.
 */
export function walletRecoveryDisplay(input: {
  readonly status: WalletRecoveryStatus;
  /** A wallet exists in this browser, so a missing wallet profile is an error. */
  readonly profileExpected: boolean;
  /** The holdings reads that this surface shows. */
  readonly reads?: readonly WalletRecoveryHoldingsRead<unknown>[];
}): WalletRecoveryDisplay {
  const { status, profileExpected, reads = [] } = input;
  const scopeId = status.tag?.activation.scopeId ?? null;
  if (status.kind === "unavailable") {
    return {
      state: "unavailable",
      reason: status.reason,
      action: unavailableAction(status.reason, profileExpected),
      scopeId,
    };
  }
  if (reads.some((read) => read.kind === "failed")) {
    return { state: "unavailable", reason: "custody-unavailable", action: "reload", scopeId };
  }
  switch (status.kind) {
    case "checking":
      return { state: "checking" };
    case "pending":
      return pendingDisplay(status.reason, status.retryAtMs);
    case "completed":
      // A read of an earlier pass of this tag keeps its rows. Only an empty
      // state waits for a read after the pass.
      return reads.every(
        (read) => read.kind === "ok" && sameWalletRecoveryTag(read.tag, status.tag),
      )
        ? { state: "complete" }
        : { state: "checking" };
    default:
      throw new Error(
        `unknown wallet recovery status: ${JSON.stringify((status as { kind: unknown }).kind)}`,
      );
  }
}

function unavailableAction(
  reason: WalletRecoveryUnavailableReason,
  profileExpected: boolean,
): WalletRecoveryAction {
  switch (reason) {
    case "recovery-failed":
      return "retry";
    case "read-failed":
      return "reload";
    case "profile-unavailable":
      return profileExpected ? "reload-or-restore" : "none";
    default:
      throw new Error(`unknown wallet recovery unavailable reason: ${JSON.stringify(reason)}`);
  }
}

function pendingDisplay(
  reason: Extract<WalletRecoveryStatus, { kind: "pending" }>["reason"],
  retryAtMs: number | null,
): WalletRecoveryDisplay {
  switch (reason) {
    case "operation":
    case "scan-continues":
    case "probe-due":
      return { state: "pending", text: "restoring", retryAtMs: null };
    case "proof-pending":
      return { state: "pending", text: "waitingForMint", retryAtMs: null };
    case "start-limit":
    case "backoff":
      // Without a known time, the wait shows as a restore in progress.
      return retryAtMs === null
        ? { state: "pending", text: "restoring", retryAtMs: null }
        : { state: "pending", text: "resumesAt", retryAtMs };
    default:
      throw new Error(`unknown wallet recovery pending reason: ${JSON.stringify(reason)}`);
  }
}

/**
 * True when the holdings and their totals are not known yet. A visitor
 * without a wallet has no holdings to wait for.
 */
export function walletRecoveryHoldingsUnknown(display: WalletRecoveryDisplay): boolean {
  if (display.state === "complete") return false;
  return !(display.state === "unavailable" && display.action === "none");
}

/**
 * True only when an empty list of shown rows is final. The rows are a part
 * of the read (one tab) or the read value itself. A projection is shown with
 * a read that is not `ok`, so it is never final.
 */
export function walletRecoveryRowsEmptyIsTerminal<T>(
  status: WalletRecoveryStatus,
  read: WalletRecoveryHoldingsRead<T>,
  rows: readonly unknown[],
): boolean {
  if (rows.length > 0) return false;
  return walletRecoveryEmptyIsTerminal(status, read.kind === "ok" ? { ...read, value: [] } : read);
}
