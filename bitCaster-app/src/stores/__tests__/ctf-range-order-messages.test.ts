// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeBrowserCtfRangeMessage,
  pageActiveBrowserCtfRangeMessages,
  recordBrowserCtfRangeMessage,
  resolveTerminalBrowserCtfRangeMessages,
} from "../ctf-range-order-messages";
import { BitcasterDB } from "../proof-db";

const databases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("durable browser range messages", () => {
  it("retains an exact message until the user acknowledges it", async () => {
    const database = createDatabase();
    const input = message(1, "recovery-pending", 10);
    await recordBrowserCtfRangeMessage(input, database);
    await recordBrowserCtfRangeMessage({ ...input, observedAtMs: 99 }, database);

    expect((await page(database)).messages).toMatchObject([input]);
    await acknowledgeBrowserCtfRangeMessage(
      {
        scopeId: input.scopeId,
        operationId: input.operationId,
        revision: input.revision,
        code: input.code,
        acknowledgedAtMs: 20,
      },
      database,
    );
    expect((await page(database)).messages).toEqual([]);
  });

  it("shows a new state revision after the previous message was acknowledged", async () => {
    const database = createDatabase();
    const first = message(1, "recovery-pending", 10);
    await recordBrowserCtfRangeMessage(first, database);
    await acknowledgeBrowserCtfRangeMessage({ ...first, acknowledgedAtMs: 11 }, database);
    await recordBrowserCtfRangeMessage(message(2, "recovery-pending", 12), database);

    expect((await page(database)).messages).toMatchObject([
      { operationId: first.operationId, revision: 2, code: "recovery-pending" },
    ]);
  });

  it("pages unresolved messages with an immutable exact cursor", async () => {
    const database = createDatabase();
    await recordBrowserCtfRangeMessage(message(1, "recovery-pending", 10), database);
    await recordBrowserCtfRangeMessage(message(2, "mint-source-uncertain", 11), database);

    const first = await pageActiveBrowserCtfRangeMessages(
      { scopeId: "scope-1", limit: 1 },
      database,
    );
    expect(first.messages).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await pageActiveBrowserCtfRangeMessages(
      { scopeId: "scope-1", limit: 1, after: first.nextCursor! },
      database,
    );
    expect(second.messages).toMatchObject([{ revision: 2 }]);
  });

  it("resolves only stale uncertainty of a terminal operation and keeps definitive outcomes", async () => {
    const database = createDatabase();
    // The order call timed out, so the wallet recorded an uncertain order and
    // pending recovery. Recovery later settled the same operation.
    await recordBrowserCtfRangeMessage(
      { ...message(3, "recovery-pending", 10), code: "order-submission-uncertain", kind: "order" },
      database,
    );
    await recordBrowserCtfRangeMessage(message(3, "recovery-pending", 10), database);
    await recordBrowserCtfRangeMessage(message(1, "mint-source-uncertain", 5), database);
    await recordBrowserCtfRangeMessage(
      { ...message(2, "recovery-pending", 7), code: "order-market-closed", kind: "order" },
      database,
    );
    await recordBrowserCtfRangeMessage(
      { ...message(1, "recovery-pending", 11), operationId: "operation-2" },
      database,
    );

    await resolveTerminalBrowserCtfRangeMessages(
      { scopeId: "scope-1", operationId: "operation-1", resolvedAtMs: 50 },
      database,
    );
    database.close();
    await database.open();

    expect(
      (await page(database)).messages.map(({ operationId, revision, code, kind }) => ({
        operationId,
        revision,
        code,
        kind,
      })),
    ).toEqual([
      { operationId: "operation-1", revision: 2, code: "order-market-closed", kind: "order" },
      { operationId: "operation-2", revision: 1, code: "recovery-pending", kind: "funds" },
    ]);
    const resolved = await database.ctfRangeMessages.get([
      "scope-1",
      "operation-1",
      3,
      "order-submission-uncertain",
    ]);
    expect(resolved).toMatchObject({ status: "acknowledged", acknowledgedAtMs: 50 });
  });

  it("retains alerts beyond the visible page after reopening", async () => {
    const database = createDatabase();
    for (let revision = 1; revision <= 10; revision++) {
      await recordBrowserCtfRangeMessage(message(revision, "recovery-pending", revision), database);
    }
    database.close();
    await database.open();
    const first = await page(database);
    expect(first.messages).toHaveLength(8);
    const next = await pageActiveBrowserCtfRangeMessages(
      { scopeId: "scope-1", limit: 8, after: first.nextCursor! },
      database,
    );
    expect(next.messages.map((item) => item.revision)).toEqual([9, 10]);
    expect([...first.messages, ...next.messages].every((item) => item.status === "active")).toBe(
      true,
    );
  });
});

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`range-message-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}

function message(
  revision: number,
  code:
    | "recovery-pending"
    | "mint-source-uncertain"
    | "order-submission-uncertain"
    | "order-market-closed",
  observedAtMs: number,
) {
  return {
    scopeId: "scope-1",
    operationId: "operation-1",
    revision,
    code,
    kind: "funds" as const,
    observedAtMs,
  };
}

function page(database: BitcasterDB) {
  return pageActiveBrowserCtfRangeMessages({ scopeId: "scope-1", limit: 8 }, database);
}
