import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fixture,
  disposeFixtures,
  REGULAR_KEYSET,
  signedPayout,
  SEED,
} from "./fixtures/browserCtfRedeemFixture";

const mocks = vi.hoisted(() => ({ requireNewWritePermission: vi.fn() }));
vi.mock("../browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: mocks.requireNewWritePermission,
}));
beforeEach(() => {
  mocks.requireNewWritePermission.mockReset();
  mocks.requireNewWritePermission.mockResolvedValue(undefined);
});
afterEach(async () => {
  await disposeFixtures();
});

describe("browser CTF redeem atomic preparation", () => {
  it("rolls back the counter when the atomic preparation fails after its advance", async () => {
    const { counterStore, counters, database, bind } = await fixture();
    const advance = counterStore.compareAndAdvanceInCurrentTransaction.bind(counterStore);
    const failure = vi
      .spyOn(counterStore, "compareAndAdvanceInCurrentTransaction")
      .mockImplementationOnce(async (...args) => {
        await advance(...args);
        throw new Error("injected preparation failure");
      });
    await expect(bind()).rejects.toMatchObject({ category: "persisted-recovery" });
    expect((await counters.reserve(REGULAR_KEYSET.id, 0)).start).toBe(0);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.custodyReservations.count()).toBe(0);
    failure.mockRestore();
    await bind();
    expect((await counters.reserve(REGULAR_KEYSET.id, 0)).start).toBe(1);
  });

  it("rebuilds from a competing committed counter before binding", async () => {
    const { counterStore, counters, database, adapter, scope, bind } = await fixture();
    const read = counterStore.readSnapshotInContext.bind(counterStore);
    vi.spyOn(counterStore, "readSnapshotInContext").mockImplementationOnce(async (...args) => {
      const snapshot = await read(...args);
      await counters.reserve(REGULAR_KEYSET.id, 3);
      return snapshot;
    });
    const record = await bind();
    const payout = await signedPayout(adapter, scope, record.operation.operationId);
    expect(
      payout[0]!.secret ===
        deriveDurableWalletProofSecret({
          seed: SEED,
          locator: { schemaVersion: 1, kind: "nut13", keysetId: REGULAR_KEYSET.id, counter: 3 },
          proofKeysetId: REGULAR_KEYSET.id,
          proofAmount: 1,
        }),
    ).toBe(true);
    expect((await counters.reserve(REGULAR_KEYSET.id, 0)).start).toBe(4);
    expect(await database.custodyOperations.count()).toBe(1);
    expect(await database.custodyReservations.count()).toBe(1);
  });

  it("bounds repeated counter conflicts without reserving the input", async () => {
    const { counterStore, counters, database, bind } = await fixture();
    const read = counterStore.readSnapshotInContext.bind(counterStore);
    const reads = vi
      .spyOn(counterStore, "readSnapshotInContext")
      .mockImplementation(async (...args) => {
        const snapshot = await read(...args);
        await counters.reserve(REGULAR_KEYSET.id, 1);
        return snapshot;
      });
    await expect(bind()).rejects.toMatchObject({ category: "persisted-recovery" });
    expect(reads).toHaveBeenCalledTimes(3);
    expect((await counters.reserve(REGULAR_KEYSET.id, 0)).start).toBe(3);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.custodyReservations.count()).toBe(0);
  });

  it("keeps a committed winner after the commit reply is lost", async () => {
    const { adapter, counters, database, bind } = await fixture();
    const transact = adapter.transactAtomic.bind(adapter);
    vi.spyOn(adapter, "transactAtomic").mockImplementationOnce(async (...args) => {
      await transact(...args);
      throw new Error("lost commit reply");
    });
    await expect(bind()).rejects.toMatchObject({
      category: "persisted-recovery",
      operationRef: expect.any(String),
    });
    expect((await counters.reserve(REGULAR_KEYSET.id, 0)).start).toBe(1);
    expect(await database.custodyOperations.count()).toBe(1);
    await expect(bind()).rejects.toMatchObject({
      category: "persisted-recovery",
      operationRef: expect.any(String),
    });
    expect((await counters.reserve(REGULAR_KEYSET.id, 0)).start).toBe(1);
  });
});
