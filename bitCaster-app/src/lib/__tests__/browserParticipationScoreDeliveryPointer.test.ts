// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimBrowserParticipationScoreDeliveryPointer,
  clearBrowserParticipationScoreDeliveryPointer,
  readBrowserParticipationScoreDeliveryPointer,
} from "../browserParticipationScoreDeliveryPointer";
import { BitcasterDB } from "../../stores/proof-db";

const databases: BitcasterDB[] = [];
const seed = new Uint8Array(64).fill(3);
const input = {
  accountSubject: "subject-1",
  mintUrl: "https://mint.example",
  purchaseEpoch: 0,
};

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("Participation Score delivery pointer", () => {
  it("serializes concurrent claims to one current delivery id", async () => {
    const database = createDatabase();
    const context = contextFor(database, serialLockManager());
    const [first, second] = await Promise.all([
      claimBrowserParticipationScoreDeliveryPointer({
        ...input,
        deliveryId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
        context,
      }),
      claimBrowserParticipationScoreDeliveryPointer({
        ...input,
        deliveryId: "4ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
        context,
      }),
    ]);

    expect(first.deliveryId).toBe(second.deliveryId);
    expect(await database.participationScoreDeliveryPointers.count()).toBe(1);
  });

  it("requires a profile fence and clears only the exact current pointer", async () => {
    const database = createDatabase();
    const context = contextFor(database);
    const pointer = await claimBrowserParticipationScoreDeliveryPointer({
      ...input,
      deliveryId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
      context,
    });
    await expect(
      clearBrowserParticipationScoreDeliveryPointer({
        ...input,
        pointer: { ...pointer, revision: 1 },
        context,
      }),
    ).rejects.toThrow(/conflicts/);
    await clearBrowserParticipationScoreDeliveryPointer({ ...input, pointer, context });
    await expect(
      readBrowserParticipationScoreDeliveryPointer({ ...input, context }),
    ).resolves.toBeNull();

    const fenced = contextFor(database, undefined, () => {
      throw new Error("profile changed");
    });
    await expect(
      readBrowserParticipationScoreDeliveryPointer({ ...input, context: fenced }),
    ).rejects.toThrow(/profile changed/);
  });

  it("rolls back a pointer claim when the wallet profile changes during the transaction", async () => {
    const database = createDatabase();
    let checks = 0;
    const context = contextFor(database, undefined, () => {
      checks += 1;
      if (checks === 3) throw new Error("profile changed");
    });

    await expect(
      claimBrowserParticipationScoreDeliveryPointer({
        ...input,
        deliveryId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
        context,
      }),
    ).rejects.toThrow(/profile changed/);
    expect(await database.participationScoreDeliveryPointers.count()).toBe(0);
  });
});

function createDatabase() {
  const database = new BitcasterDB(`participation-score-pointer-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}

function contextFor(
  database: BitcasterDB,
  lockManager: Pick<LockManager, "request"> | undefined = immediateLockManager(),
  requireCapturedProfile: () => void = () => {},
) {
  return { seed, database, lockManager, requireCapturedProfile };
}

function immediateLockManager(): Pick<LockManager, "request"> {
  return { request: async (_name, _options, action) => action(null as never) } as Pick<
    LockManager,
    "request"
  >;
}

function serialLockManager(): Pick<LockManager, "request"> {
  let tail = Promise.resolve();
  return {
    request: async (_name, _options, action) => {
      const prior = tail;
      let release: () => void = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        return await action(null as never);
      } finally {
        release();
      }
    },
  } as Pick<LockManager, "request">;
}
