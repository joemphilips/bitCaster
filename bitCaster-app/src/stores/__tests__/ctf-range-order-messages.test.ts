// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeBrowserCtfRangeMessage,
  pageActiveBrowserCtfRangeMessages,
  recordBrowserCtfRangeMessage,
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
});

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`range-message-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}

function message(
  revision: number,
  code: "recovery-pending" | "mint-source-uncertain",
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
