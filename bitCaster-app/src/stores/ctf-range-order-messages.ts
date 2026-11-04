import type { BrowserCtfRangeOrderErrorCode } from "@/lib/browserCtfRangeOrderCoordinator";
import { BROWSER_CTF_RANGE_ORDER_ERROR_CODES } from "@/lib/browserCtfRangeOrderCoordinator";
import { assertNever } from "@/lib/enumDiscipline";
import { db, type BitcasterDB, type BrowserCtfRangeMessageRow } from "./proof-db";

const ERROR_CODES = new Set<string>(BROWSER_CTF_RANGE_ORDER_ERROR_CODES);
const PAGE_LIMIT_MAX = 64;
const MINT_ERROR_DETAIL_LENGTH_MAX = 256;
// One operation has one message for each recorded revision and bounded code.
const OPERATION_MESSAGE_LIMIT = 1_024;

export interface BrowserCtfRangeMessageCursor {
  observedAtMs: number;
  operationId: string;
  revision: number;
  code: BrowserCtfRangeOrderErrorCode;
}

export type BrowserCtfRangeMessage = Omit<BrowserCtfRangeMessageRow, "code"> & {
  code: BrowserCtfRangeOrderErrorCode;
};

/**
 * Record one alert. An existing alert keeps its identity, status, and time.
 * A later observation can add its mint code or its manual-retry mark.
 */
export async function recordBrowserCtfRangeMessage(
  input: Omit<BrowserCtfRangeMessage, "status" | "acknowledgedAtMs">,
  database: BitcasterDB = db,
): Promise<BrowserCtfRangeMessage> {
  const message = decodeMessage({ ...input, status: "active", acknowledgedAtMs: null });
  return database.transaction("rw", database.ctfRangeMessages, async () => {
    const key = messageKey(message);
    const existing = await database.ctfRangeMessages.get(key);
    if (!existing) {
      await database.ctfRangeMessages.add(message);
      return message;
    }
    const current = decodeMessage(existing);
    const merged = decodeMessage({
      ...current,
      ...(message.mintError === undefined ? {} : { mintError: message.mintError }),
      ...(message.retryable === undefined ? {} : { retryable: message.retryable }),
    });
    if (
      sameMintError(merged.mintError, current.mintError) &&
      merged.retryable === current.retryable
    ) {
      return current;
    }
    await database.ctfRangeMessages.put(merged);
    return merged;
  });
}

/** Remove the manual-retry mark after the user asks for the retry. */
export async function clearBrowserCtfRangeMessageRetry(
  input: { scopeId: string; operationId: string },
  database: BitcasterDB = db,
): Promise<void> {
  await database.transaction("rw", database.ctfRangeMessages, async () => {
    const rows = await database.ctfRangeMessages
      .where("[scopeId+operationId+revision+code]")
      .between([input.scopeId, input.operationId], [input.scopeId, input.operationId, []])
      .limit(OPERATION_MESSAGE_LIMIT)
      .toArray();
    for (const row of rows) {
      const current = decodeMessage(row);
      if (current.retryable === undefined) continue;
      const { retryable: _retryable, ...cleared } = current;
      await database.ctfRangeMessages.put(decodeMessage(cleared));
    }
  });
}

export async function acknowledgeBrowserCtfRangeMessage(
  input: {
    scopeId: string;
    operationId: string;
    revision: number;
    code: BrowserCtfRangeOrderErrorCode;
    acknowledgedAtMs: number;
  },
  database: BitcasterDB = db,
): Promise<void> {
  await database.transaction("rw", database.ctfRangeMessages, async () => {
    const key: [string, string, number, string] = [
      input.scopeId,
      input.operationId,
      input.revision,
      decodeCode(input.code),
    ];
    const existing = await database.ctfRangeMessages.get(key);
    if (!existing) throw new Error("Browser range message is missing");
    const current = decodeMessage(existing);
    if (current.status === "acknowledged") return;
    await database.ctfRangeMessages.put(
      decodeMessage({
        ...current,
        status: "acknowledged",
        acknowledgedAtMs: nonnegativeInteger(input.acknowledgedAtMs, "acknowledged time"),
      }),
    );
  });
}

/**
 * Resolves the active messages of one terminal operation whose statement the
 * terminal journal contradicts. The caller must first read a terminal journal:
 * the wallet then settled or refunded every reserved input, so pending recovery
 * and an uncertain result no longer describe the operation. A message with a
 * definitive outcome stays until the user acknowledges it.
 */
export async function resolveTerminalBrowserCtfRangeMessages(
  input: { scopeId: string; operationId: string; resolvedAtMs: number },
  database: BitcasterDB = db,
): Promise<void> {
  const resolvedAtMs = nonnegativeInteger(input.resolvedAtMs, "resolved time");
  await database.transaction("rw", database.ctfRangeMessages, async () => {
    const rows = await database.ctfRangeMessages
      .where("[scopeId+operationId+revision+code]")
      // A shorter key sorts first and an array sorts after every revision.
      .between([input.scopeId, input.operationId], [input.scopeId, input.operationId, []])
      .limit(OPERATION_MESSAGE_LIMIT)
      .toArray();
    for (const row of rows) {
      const current = decodeMessage(row);
      if (current.status === "acknowledged" || !terminalJournalResolves(current.code)) continue;
      await database.ctfRangeMessages.put(
        decodeMessage({ ...current, status: "acknowledged", acknowledgedAtMs: resolvedAtMs }),
      );
    }
  });
}

/** Whether a terminal journal makes the message false. */
function terminalJournalResolves(code: BrowserCtfRangeOrderErrorCode): boolean {
  switch (code) {
    case "recovery-pending":
    case "mint-source-uncertain":
    case "order-submission-uncertain":
      return true;
    case "source-preparation-pending":
    case "invalid-order-type":
    case "insufficient-funds":
    case "score-top-up-required":
    case "score-top-up-cancelled":
    case "asset-recovery-failed":
    case "source-preparation-failed":
    case "custody-commit-failed":
    case "capability-creation-failed":
    case "capability-validation-failed":
    case "order-attempt-ended":
    case "settlement-capability-invalid-request":
    case "settlement-capability-invalid-artifact":
    case "settlement-capability-policy-rejected":
    case "settlement-capability-score-required":
    case "settlement-capability-not-found":
    case "settlement-capability-conflict":
    case "settlement-capability-market-unavailable":
    case "settlement-capability-request-too-large":
    case "settlement-capability-admission-limited":
    case "settlement-capability-capacity-exhausted":
    case "settlement-capability-admission-unavailable":
    case "order-invalid-request":
    case "order-invalid-comment":
    case "order-market-not-found":
    case "order-capability-not-found":
    case "order-capability-route-mismatch":
    case "order-capability-not-current":
    case "order-processing-conflict":
    case "order-market-closed":
    case "order-submission-rejected":
      return false;
    default:
      return assertNever(code);
  }
}

export async function pageActiveBrowserCtfRangeMessages(
  input: {
    scopeId: string;
    limit: number;
    after?: BrowserCtfRangeMessageCursor;
  },
  database: BitcasterDB = db,
): Promise<{
  messages: BrowserCtfRangeMessage[];
  nextCursor: BrowserCtfRangeMessageCursor | null;
}> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > PAGE_LIMIT_MAX) {
    throw new Error("Browser range message page limit is invalid");
  }
  const lower: readonly unknown[] = input.after
    ? [
        input.scopeId,
        "active",
        input.after.observedAtMs,
        input.after.operationId,
        input.after.revision,
        input.after.code,
      ]
    : [input.scopeId, "active"];
  const upper: readonly unknown[] = [input.scopeId, "active", []];
  const rows = await database.ctfRangeMessages
    .where("[scopeId+status+observedAtMs+operationId+revision+code]")
    .between(lower, upper, input.after === undefined, true)
    .limit(input.limit + 1)
    .toArray();
  const messages = rows.slice(0, input.limit).map(decodeMessage);
  const last = messages.at(-1);
  return {
    messages,
    nextCursor:
      rows.length > input.limit && last
        ? {
            observedAtMs: last.observedAtMs,
            operationId: last.operationId,
            revision: last.revision,
            code: decodeCode(last.code),
          }
        : null,
  };
}

function decodeMessage(value: BrowserCtfRangeMessageRow): BrowserCtfRangeMessage {
  const status = value.status;
  if (status !== "active" && status !== "acknowledged") {
    throw new Error("Browser range message status is invalid");
  }
  const acknowledgedAtMs =
    value.acknowledgedAtMs === null
      ? null
      : nonnegativeInteger(value.acknowledgedAtMs, "acknowledged time");
  if ((status === "active") !== (acknowledgedAtMs === null)) {
    throw new Error("Browser range message acknowledgement is invalid");
  }
  if (value.kind !== "order" && value.kind !== "funds") {
    throw new Error("Browser range message kind is invalid");
  }
  if (value.retryable !== undefined && value.retryable !== true) {
    throw new Error("Browser range message retry mark is invalid");
  }
  return {
    scopeId: nonempty(value.scopeId, "scope id"),
    operationId: nonempty(value.operationId, "operation id"),
    revision: nonnegativeInteger(value.revision, "revision"),
    code: decodeCode(value.code),
    kind: value.kind,
    status,
    observedAtMs: nonnegativeInteger(value.observedAtMs, "observed time"),
    acknowledgedAtMs,
    ...(value.mintError === undefined ? {} : { mintError: decodeMintError(value.mintError) }),
    ...(value.retryable === undefined ? {} : { retryable: true as const }),
  };
}

function decodeMintError(value: unknown): { code: number; detail: string } {
  const candidate = value as { code?: unknown; detail?: unknown } | null;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !Number.isSafeInteger(candidate.code) ||
    (candidate.code as number) <= 0 ||
    typeof candidate.detail !== "string" ||
    candidate.detail.length > MINT_ERROR_DETAIL_LENGTH_MAX
  ) {
    throw new Error("Browser range message mint error is invalid");
  }
  return { code: candidate.code as number, detail: candidate.detail };
}

function sameMintError(
  left: { code: number; detail: string } | undefined,
  right: { code: number; detail: string } | undefined,
): boolean {
  return left?.code === right?.code && left?.detail === right?.detail;
}

function decodeCode(value: string): BrowserCtfRangeOrderErrorCode {
  if (!ERROR_CODES.has(value)) throw new Error("Browser range message code is invalid");
  return value as BrowserCtfRangeOrderErrorCode;
}

function messageKey(message: BrowserCtfRangeMessageRow): [string, string, number, string] {
  return [message.scopeId, message.operationId, message.revision, message.code];
}

function nonempty(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 16_384) {
    throw new Error(`Browser range message ${label} is invalid`);
  }
  return value;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Browser range message ${label} is invalid`);
  }
  return value;
}
