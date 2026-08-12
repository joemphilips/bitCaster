import type { BrowserCtfRangeOrderErrorCode } from "@/lib/browserCtfRangeOrderCoordinator";
import { BROWSER_CTF_RANGE_ORDER_ERROR_CODES } from "@/lib/browserCtfRangeOrderCoordinator";
import { db, type BitcasterDB, type BrowserCtfRangeMessageRow } from "./proof-db";

const ERROR_CODES = new Set<string>(BROWSER_CTF_RANGE_ORDER_ERROR_CODES);
const PAGE_LIMIT_MAX = 64;

export interface BrowserCtfRangeMessageCursor {
  observedAtMs: number;
  operationId: string;
  revision: number;
  code: BrowserCtfRangeOrderErrorCode;
}

export type BrowserCtfRangeMessage = Omit<BrowserCtfRangeMessageRow, "code"> & {
  code: BrowserCtfRangeOrderErrorCode;
};

export async function recordBrowserCtfRangeMessage(
  input: Omit<BrowserCtfRangeMessage, "status" | "acknowledgedAtMs">,
  database: BitcasterDB = db,
): Promise<BrowserCtfRangeMessage> {
  const message = decodeMessage({ ...input, status: "active", acknowledgedAtMs: null });
  return database.transaction("rw", database.ctfRangeMessages, async () => {
    const key = messageKey(message);
    const existing = await database.ctfRangeMessages.get(key);
    if (existing) return decodeMessage(existing);
    await database.ctfRangeMessages.add(message);
    return message;
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
  return {
    scopeId: nonempty(value.scopeId, "scope id"),
    operationId: nonempty(value.operationId, "operation id"),
    revision: nonnegativeInteger(value.revision, "revision"),
    code: decodeCode(value.code),
    kind: value.kind,
    status,
    observedAtMs: nonnegativeInteger(value.observedAtMs, "observed time"),
    acknowledgedAtMs,
  };
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
