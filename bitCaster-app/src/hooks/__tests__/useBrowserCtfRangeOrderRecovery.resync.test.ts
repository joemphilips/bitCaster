// @vitest-environment node
// Custody rows hold Uint8Array values. The jsdom environment replaces the
// global Uint8Array, so values read back from fake-indexeddb fail the
// custody row checks. Run in node and add only a jsdom document for React.
await vi.hoisted(async () => {
  const { indexedDB, IDBKeyRange } = await import("fake-indexeddb");
  // @ts-expect-error -- jsdom ships no type declarations in this workspace.
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://app.example/",
  });
  // Dexie reads these globals when it loads.
  Object.assign(dom.window, { indexedDB, IDBKeyRange });
  Object.assign(globalThis, {
    indexedDB,
    IDBKeyRange,
    window: dom.window,
    document: dom.window.document,
    // The recovery wake dispatches its event on the jsdom window.
    CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserWalletIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "@/lib/browserWalletProfile";
import { activateBrowserWalletDatabase, db } from "@/stores/proof-db";
import { BrowserWalletCounterDexieStore } from "@/stores/browser-wallet-counter-db";
import {
  recordGeneratedBrowserSeed,
  requestBrowserKeysetResync,
  seedRestoreDatabase,
  type SeedRestoreDB,
} from "@/stores/seed-restore-db";
import { useActivityLogStore } from "@/stores/activity-log";
import { useToastStore } from "@/stores/toast";
import {
  FakeMint,
  MINT_URL,
  MNEMONIC,
  activeKeyset,
  associationComplete,
  binaryMarket,
  blindedOutput,
  conditionalAsset,
  cursor,
  installLockManager,
  position,
  regularKeyset,
  scopeId,
  selectableHoldings,
} from "@/test/seedRestoreFakeMint";

// Another client with the same seed can sign outputs above this browser's
// cursors (ADR-033, amendment 2026-11-04). The browser re-syncs keysets in
// use, keeps a deferral marker for every counter-only advance, and admits the
// skipped outputs later. Network I/O goes to a fake mint.

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

const mocks = vi.hoisted(() => ({
  passCompleted: [] as Array<() => void>,
  walletsByUnit: new Map<string, Promise<unknown>>(),
}));

// Local journal stages of the same pass. A fresh browser profile has no journal.
vi.mock("@/lib/cashu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cashu")>()),
  recoverPendingTokenReceives: vi.fn(async () => ({ pending: 0, lastAttemptedOperationId: null })),
  recoverPendingWalletMints: vi.fn(async () => ({ pending: 0 })),
  recoverBrowserDurableOutgoingCashuTransfersInPass: vi.fn(async () => ({
    pending: 0,
    hasMore: false,
  })),
}));

// Engine-side order recovery needs a local order journal and an engine.
vi.mock("@/lib/browserCtfRangeOrderSubmission", () => ({
  recoverBrowserCtfRangeOrders: vi.fn(async () => ({ recovered: 0, pending: [] })),
}));

// The hook calls this once at the end of each recovery pass.
vi.mock("@/lib/encryptedWalletBackupDriver", () => ({
  resumeBrowserEncryptedWalletBackupV2AfterRecovery: vi.fn(() => {
    mocks.passCompleted.shift()?.();
  }),
}));

vi.mock("@/stores/wallet", () => {
  const store = {
    mnemonic: "",
    activeMintUrl: "https://mint.example",
    mints: [{ url: "https://mint.example", keysets: [] }],
    getWalletForUnit: async (url: string, unit: string) => {
      const key = `${url}\n${unit}`;
      let wallet = mocks.walletsByUnit.get(key);
      if (wallet === undefined) {
        wallet = (async () => {
          const { CashuMint: Mint, CashuWallet: Wallet } = await import("@cashu/cashu-ts");
          const { toSeed: seedFromWords } = await import("@/lib/bip39");
          const created = new Wallet(new Mint(url), {
            unit,
            bip39seed: seedFromWords(store.mnemonic.trim().split(/\s+/)),
          });
          await created.loadMint();
          return created;
        })();
        mocks.walletsByUnit.set(key, wallet);
      }
      return wallet;
    },
  };
  return {
    useWalletStore: { getState: () => store },
    getWalletForMnemonicUnit: async (_mnemonic: string, url: string, unit: string) =>
      store.getWalletForUnit(url, unit),
  };
});

import { useWalletStore } from "@/stores/wallet";
import {
  resyncBrowserKeysetsInUse,
  retryBrowserSeedPositionRestore,
} from "@/lib/browserSeedPositionRestore";
import {
  WalletKeysetCounterPendingError,
  advanceWalletKeysetCounterPastMint,
  ensureWalletKeysetCounterReady,
} from "@/lib/cashu";
import { durableWalletRecoveryStatus } from "@/test/walletRecoveryStatusFixture";
import { useBrowserCtfRangeOrderRecovery } from "../useBrowserCtfRangeOrderRecovery";

// The passes derive and verify real NUT-13 outputs. Under CPU load they can
// exceed the 5 s default test timeout. These bounds only detect a hang.
const PASS_TIMEOUT_MS = 50_000;
vi.setConfig({ testTimeout: 90_000 });

/** Resolves when the hook finishes its next recovery pass. */
function nextPassCompleted(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("recovery pass did not complete")),
      PASS_TIMEOUT_MS,
    );
    mocks.passCompleted.push(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

let unmount: (() => void) | undefined;

/** One page load: the hook runs its first recovery pass. */
async function runStartupPass(): Promise<void> {
  const firstPass = nextPassCompleted();
  ({ unmount } = renderHook(() =>
    useBrowserCtfRangeOrderRecovery({
      nostrSignerReady: true,
      walletMnemonic: MNEMONIC,
      walletMintUrls: MINT_URL,
    }),
  ));
  await firstPass;
  unmount();
  unmount = undefined;
}

/** Moves the wall clock. Only `Date` is fake, so timers and IndexedDB still run. */
function advanceClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

function counters() {
  return new BrowserWalletCounterDexieStore({
    database: db,
    scopeId: scopeId(),
    isCurrentProfile: () => true,
  });
}

/** A keyset that a completed recovery scan checked, with its cursor at `next`. */
async function usedKeyset(keysetId: string, next: number): Promise<void> {
  await counters().restoreInContext(
    { mintUrl: MINT_URL, unit: "msat" },
    keysetId,
    next,
    false,
    () => undefined,
  );
}

async function resyncRow(keysetId: string) {
  return seedRestoreDatabase(scopeId()).resync.get([scopeId(), MINT_URL, keysetId]);
}

async function amounts(): Promise<number[]> {
  return (await selectableHoldings()).map(({ amount }) => amount).sort((a, b) => a - b);
}

function resync(now: number) {
  return resyncBrowserKeysetsInUse({
    scopeId: scopeId(),
    mnemonic: MNEMONIC,
    mintUrl: MINT_URL,
    now: () => now,
  });
}

function expectNoIdentity(mint: FakeMint): void {
  const walletId = browserWalletIdFromMnemonic(MNEMONIC)!;
  const mintRequests = mint.requests.filter(({ url }) => url.origin === MINT_URL);
  expect(mintRequests.length).toBeGreaterThan(0);
  for (const request of mintRequests) {
    expect(request.headers.get("authorization")).toBeNull();
    expect(`${request.url.href}\n${request.body}`).not.toContain(walletId);
    expect(`${request.url.href}\n${request.body}`).not.toContain(scopeId());
  }
}

describe("useBrowserCtfRangeOrderRecovery — keysets that another client used", () => {
  let seedRestore: SeedRestoreDB | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    (useWalletStore.getState() as { mnemonic: string }).mnemonic = MNEMONIC;
    setActiveBrowserWalletProfile(MNEMONIC);
    activateBrowserWalletDatabase(scopeId());
    seedRestore = seedRestoreDatabase(scopeId());
    mocks.walletsByUnit.clear();
    mocks.passCompleted.length = 0;
    useActivityLogStore.setState({ items: [] });
    useToastStore.setState({ toasts: [] });
    // The cap of full restore scans is browser-level storage.
    window.localStorage.clear();
    installLockManager();
  });

  afterEach(async () => {
    unmount?.();
    unmount = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const table of db.tables) await table.clear();
    if (seedRestore !== null) for (const table of seedRestore.tables) await table.clear();
  });

  it("re-syncs a keyset in use after evidence that another browser signed past the cursor", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    // This browser restored the msat keyset earlier, so its cursor is 1.
    await runStartupPass();
    expect(await associationComplete(regular.id)).toBe(true);
    expect(await cursor(regular.id)).toBe(1);

    // Another browser with the same seed signed counters 1 and 2. A mint
    // refusal is the evidence.
    mint.sign({ keyset: regular, counter: 1, amount: 2, state: "SPENT" });
    mint.sign({ keyset: regular, counter: 2, amount: 4, state: "UNSPENT" });
    await requestBrowserKeysetResync({ scopeId: scopeId(), mintUrl: MINT_URL });
    await runStartupPass();

    expect(await cursor(regular.id)).toBe(3);
    expect(await amounts()).toEqual([4, 8]);
    expect(useToastStore.getState().toasts.map(({ message }) => message)).toContain(
      "This wallet was used in another browser. Use one browser at a time.",
    );
    // A local diagnostic records the finding. Nothing waits for admission.
    expect(await resyncRow(regular.id)).toMatchObject({
      findings: 1,
      lastHighestCounter: 2,
      pendingFromCounter: null,
    });
  });

  it("probes keysets in use only after evidence that another client used the seed", async () => {
    // The re-sync also runs for a seed that this browser generated.
    await recordGeneratedBrowserSeed(scopeId());
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    // An empty scan of NO left a counter association without a cursor.
    await usedKeyset(market.no.id, 0);
    await runStartupPass();
    const probes = mint.restoredOutputs().length;

    // Another browser signed counter 1. No reload, even days later, probes.
    mint.sign({ keyset: regular, counter: 1, amount: 2, state: "UNSPENT" });
    advanceClock(3 * DAY_MS);
    await runStartupPass();
    expect(mint.restoredOutputs()).toHaveLength(probes);
    expect(await amounts()).toEqual([8]);

    // A mint refusal is evidence that another client used the seed.
    await requestBrowserKeysetResync({ scopeId: scopeId(), mintUrl: MINT_URL });
    await runStartupPass();
    expect(await amounts()).toEqual([2, 8]);
    expect(useToastStore.getState().toasts.map(({ message }) => message)).toContain(
      "This wallet was used in another browser. Use one browser at a time.",
    );
    // A keyset without a cursor holds no output of this browser.
    expect(mint.restoredOutputs().slice(probes).flat()).not.toContain(blindedOutput(market.no, 0));
    expectNoIdentity(mint);
  });

  it("makes no scan on a timer after the restore completes", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.catalogue = [{ conditionId: "ab".repeat(32), outcomes: ["YES", "NO"] }];
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    await runStartupPass();
    expect(
      (await seedRestore!.states.get([scopeId(), MINT_URL]))?.initialCompletedAtMs,
    ).not.toBeNull();
    const requests = mint.requests.length;

    // A week later, with no evidence, a reload sends no probe, no keyset
    // listing, and no catalogue read.
    advanceClock(8 * DAY_MS);
    await runStartupPass();

    const later = mint.requests.slice(requests).map(({ url }) => url.pathname);
    expect(later).not.toContain("/v1/restore");
    expect(later).not.toContain("/v1/conditional_keysets");
    expect(later).not.toContain("/api/v1/markets/query");
  });
  it("admits outputs that a counter-only advance skipped in the next pass", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "SPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    await runStartupPass();
    // The mint refused a reused output while an order coordinator held the
    // custody scope. F13 moved the cursor past the signed outputs, without admission.
    mint.sign({ keyset: regular, counter: 1, amount: 2, state: "UNSPENT" });
    mint.sign({ keyset: regular, counter: 2, amount: 4, state: "UNSPENT" });
    await advanceWalletKeysetCounterPastMint({
      scopeId: scopeId(),
      mintUrl: MINT_URL,
      unit: "msat",
      keyset: activeKeyset(regular),
    });
    expect(await cursor(regular.id)).toBe(3);
    expect(await selectableHoldings()).toEqual([]);
    expect((await resyncRow(regular.id))?.pendingFromCounter).toBe(1);

    await runStartupPass();

    expect(await amounts()).toEqual([2, 4]);
    expect((await resyncRow(regular.id))?.pendingFromCounter).toBe(null);
  });

  it("keeps the refused plan's outputs for a later pass after an output reuse refusal", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "SPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    await runStartupPass();
    // An order planned change outputs at counters 1 and 2 and reserved them.
    // Another browser had signed both, so the mint refused the request.
    await counters().advanceToAtLeastInContext(
      { mintUrl: MINT_URL, unit: "msat" },
      regular.id,
      3,
      false,
    );
    mint.sign({ keyset: regular, counter: 1, amount: 2, state: "UNSPENT" });
    mint.sign({ keyset: regular, counter: 2, amount: 4, state: "UNSPENT" });

    await advanceWalletKeysetCounterPastMint({
      scopeId: scopeId(),
      mintUrl: MINT_URL,
      unit: "msat",
      keyset: activeKeyset(regular),
      plannedFromCounter: 1,
    });
    // Nothing is signed above the cursor, but the refused outputs below it are.
    expect(await cursor(regular.id)).toBe(3);
    expect((await resyncRow(regular.id))?.pendingFromCounter).toBe(1);

    await runStartupPass();

    expect(await amounts()).toEqual([2, 4]);
  });

  it("admits a deferred conditional keyset that has no local descriptor", async () => {
    // This browser generated the seed, so no restore listing holds the keyset.
    await recordGeneratedBrowserSeed(scopeId());
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    vi.stubGlobal("fetch", mint.fetch);
    // A buy found no YES output, then reserved YES counters 0 and 1. Another
    // browser had signed them.
    await usedKeyset(market.yes.id, 2);
    mint.sign({ keyset: market.yes, counter: 0, amount: 2, state: "UNSPENT" });
    mint.sign({ keyset: market.yes, counter: 1, amount: 4, state: "UNSPENT" });
    await advanceWalletKeysetCounterPastMint({
      scopeId: scopeId(),
      mintUrl: MINT_URL,
      unit: "msat",
      keyset: activeKeyset(market.yes),
      conditionalAsset: conditionalAsset(market.yes),
      plannedFromCounter: 0,
    });
    expect(await resyncRow(market.yes.id)).toMatchObject({
      pendingFromCounter: 0,
      condition: conditionalAsset(market.yes),
    });

    await runStartupPass();

    expect(await selectableHoldings()).toEqual([position(market.yes, 2), position(market.yes, 4)]);
    expect((await resyncRow(market.yes.id))?.pendingFromCounter).toBe(null);
  });

  it("backs off a deferral that it cannot admit and shows a persistent notice", async () => {
    await recordGeneratedBrowserSeed(scopeId());
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    await runStartupPass();
    await usedKeyset(market.yes.id, 1);
    mint.sign({ keyset: market.yes, counter: 0, amount: 2, state: "UNSPENT" });
    await advanceWalletKeysetCounterPastMint({
      scopeId: scopeId(),
      mintUrl: MINT_URL,
      unit: "msat",
      keyset: activeKeyset(market.yes),
      conditionalAsset: conditionalAsset(market.yes),
      plannedFromCounter: 0,
    });
    // The mint cannot list the market now, so the keyset authority is unknown.
    mint.failConditionListing.add("ab".repeat(32));
    const start = Date.now();

    const first = await resync(start);
    expect(first.retryAtMs).toBeGreaterThan(start);
    expect(await resyncRow(market.yes.id)).toMatchObject({ pendingFromCounter: 0, failures: 1 });

    // Within the backoff, a pass makes no mint request for the deferral.
    const requests = mint.requests.length;
    await resync(start + 1_000);
    expect(mint.requests).toHaveLength(requests);

    // Later passes retry only the deferral. They probe no other keyset again.
    const probes = mint.restoredOutputs().length;
    await resync(start + HOUR_MS);
    await resync(start + 2 * HOUR_MS);
    expect(mint.restoredOutputs()).toHaveLength(probes);
    expect((await resyncRow(market.yes.id))?.failures).toBe(3);
    expect(
      await durableWalletRecoveryStatus({ scopeId: scopeId(), mintUrls: [MINT_URL] }),
    ).toMatchObject({
      kind: "unavailable",
      reason: "recovery-failed",
    });

    // Retry clears the backoff, and the deferral is admitted.
    mint.failConditionListing.clear();
    await retryBrowserSeedPositionRestore(scopeId());
    await resync(start + 2 * HOUR_MS + 1_000);
    expect(await selectableHoldings()).toContainEqual(position(market.yes, 2));
    expect(
      await durableWalletRecoveryStatus({ scopeId: scopeId(), mintUrls: [MINT_URL] }),
    ).toMatchObject({ kind: "completed" });
  });

  it("advances the cursor and keeps found outputs for a later pass when admission fails", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    await runStartupPass();
    mint.sign({ keyset: regular, counter: 1, amount: 4, state: "UNSPENT" });
    mint.failCheckstate = true;
    await requestBrowserKeysetResync({ scopeId: scopeId(), mintUrl: MINT_URL });

    await runStartupPass();

    // The cursor moved past the signed output, so no local output reuses it.
    expect(await cursor(regular.id)).toBe(2);
    expect(await amounts()).toEqual([8]);
    expect((await resyncRow(regular.id))?.pendingFromCounter).toBe(1);

    mint.failCheckstate = false;
    advanceClock(HOUR_MS);
    await runStartupPass();

    expect(await amounts()).toEqual([4, 8]);
  });

  it("backs off a keyset with a PENDING proof and scans it again from the pending counter", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "UNSPENT" });
    mint.sign({ keyset: regular, counter: 1, amount: 2, state: "PENDING" });
    mint.sign({ keyset: regular, counter: 2, amount: 4, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);

    await runStartupPass();

    expect(await amounts()).toEqual([4, 8]);
    expect(await associationComplete(regular.id)).toBe(false);
    expect(await cursor(regular.id)).toBe(3);
    expect((await resyncRow(regular.id))?.pendingFromCounter).toBe(1);

    // A reload within the backoff sends no restore request.
    const probes = mint.restoredOutputs().length;
    advanceClock(1_000);
    await runStartupPass();
    expect(mint.restoredOutputs()).toHaveLength(probes);

    // The other client's operation failed, so the proof is UNSPENT again.
    mint.setState(regular, 1, "UNSPENT");
    advanceClock(HOUR_MS);
    await runStartupPass();

    const rescan = mint.restoredOutputs().slice(probes);
    expect(rescan[0]).toContain(blindedOutput(regular, 1));
    expect(rescan.flat()).not.toContain(blindedOutput(regular, 0));
    expect(await amounts()).toEqual([2, 4, 8]);
    expect(await associationComplete(regular.id)).toBe(true);
    expect((await resyncRow(regular.id))?.pendingFromCounter).toBe(null);
  });

  it("admits a PENDING position when it settles", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.sign({ keyset: market.yes, counter: 0, amount: 2, state: "UNSPENT" });
    mint.sign({ keyset: market.yes, counter: 1, amount: 4, state: "PENDING" });
    vi.stubGlobal("fetch", mint.fetch);

    await runStartupPass();

    expect(await selectableHoldings()).toEqual([position(market.yes, 2)]);
    expect(await associationComplete(market.yes.id)).toBe(false);
    expect(await cursor(market.yes.id)).toBe(2);
    expect(await resyncRow(market.yes.id)).toMatchObject({
      pendingFromCounter: 1,
      condition: conditionalAsset(market.yes),
    });

    mint.setState(market.yes, 1, "UNSPENT");
    advanceClock(HOUR_MS);
    await runStartupPass();

    expect(await selectableHoldings()).toEqual([position(market.yes, 2), position(market.yes, 4)]);
    expect(await associationComplete(market.yes.id)).toBe(true);
  });

  it("names a PENDING keyset when an order waits for it", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "PENDING" });
    vi.stubGlobal("fetch", mint.fetch);
    await runStartupPass();

    await expect(
      ensureWalletKeysetCounterReady({
        scopeId: scopeId(),
        mintUrl: MINT_URL,
        unit: "msat",
        keyset: activeKeyset(regular),
      }),
    ).rejects.toBeInstanceOf(WalletKeysetCounterPendingError);
  });
  it("waits with a deferral scan while an operation of this browser is in flight", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    await runStartupPass();
    // A refused order planned counters 1 and 2. Another browser had signed 1.
    await counters().advanceToAtLeastInContext(
      { mintUrl: MINT_URL, unit: "msat" },
      regular.id,
      3,
      false,
    );
    mint.sign({ keyset: regular, counter: 1, amount: 2, state: "UNSPENT" });
    await advanceWalletKeysetCounterPastMint({
      scopeId: scopeId(),
      mintUrl: MINT_URL,
      unit: "msat",
      keyset: activeKeyset(regular),
      plannedFromCounter: 1,
    });
    // Another operation of this browser has not finished. A scan from the
    // marker could admit its outputs before the operation records them.
    await db.custodyActiveWork.put({
      scopeId: scopeId(),
      operationId: "in-flight-order",
      nextAttemptAtMs: 0,
    } as never);
    const start = Date.now();
    const scans = mint.restoredOutputs().length;

    const waiting = await resync(start);

    expect(mint.restoredOutputs().slice(scans).flat()).not.toContain(blindedOutput(regular, 1));
    expect(await amounts()).toEqual([8]);
    // The wait is not an admission failure.
    expect(await resyncRow(regular.id)).toMatchObject({ pendingFromCounter: 1, failures: 0 });
    expect(waiting.retryAtMs).toBeGreaterThan(start);

    await db.custodyActiveWork.clear();
    await resync(waiting.retryAtMs!);

    expect(await amounts()).toEqual([2, 8]);
    expect((await resyncRow(regular.id))?.pendingFromCounter).toBe(null);
  });

  it("postpones a deferral scan when an operation starts during the scan", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    await runStartupPass();
    await counters().advanceToAtLeastInContext(
      { mintUrl: MINT_URL, unit: "msat" },
      regular.id,
      3,
      false,
    );
    mint.sign({ keyset: regular, counter: 1, amount: 2, state: "UNSPENT" });
    await advanceWalletKeysetCounterPastMint({
      scopeId: scopeId(),
      mintUrl: MINT_URL,
      unit: "msat",
      keyset: activeKeyset(regular),
      plannedFromCounter: 1,
    });
    // The guard before the scan sees no work. A buy then starts while the
    // scan runs, before the scan admits its outputs.
    mint.onCheckstate = async () => {
      await db.custodyActiveWork.put({
        scopeId: scopeId(),
        operationId: "buy-during-scan",
        nextAttemptAtMs: 0,
      } as never);
    };
    const start = Date.now();

    const waiting = await resync(start);

    expect(await amounts()).toEqual([8]);
    // The wait is not an admission failure.
    expect(await resyncRow(regular.id)).toMatchObject({ pendingFromCounter: 1, failures: 0 });
    expect(waiting.retryAtMs).toBeGreaterThan(start);

    await db.custodyActiveWork.clear();
    await resync(waiting.retryAtMs!);

    expect(await amounts()).toEqual([2, 8]);
  });

  it("waits for the probe backoff before it probes again on evidence", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    await runStartupPass();
    await requestBrowserKeysetResync({ scopeId: scopeId(), mintUrl: MINT_URL });
    mint.failRestore = true;
    const start = Date.now();

    const result = await resync(start);

    const schedule = await seedRestore!.resyncSchedules.get([scopeId(), MINT_URL]);
    expect(schedule?.probeFailures).toBe(1);
    // The evidence waits for the probe backoff, so the hook does not run every second.
    expect(result.retryAtMs).toBe(schedule?.nextProbeAtMs);
    expect(result.retryAtMs).toBeGreaterThan(start + 10_000);
  });

  it("keeps the condition of a keyset that an order checks", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    vi.stubGlobal("fetch", mint.fetch);

    await ensureWalletKeysetCounterReady({
      scopeId: scopeId(),
      mintUrl: MINT_URL,
      unit: "msat",
      keyset: activeKeyset(market.yes),
      conditionalAsset: conditionalAsset(market.yes),
    });

    // A later deferral of this keyset finds its authority without the mint listing.
    expect(await resyncRow(market.yes.id)).toMatchObject({
      condition: conditionalAsset(market.yes),
    });
  });

  it("bounds the counter scan when the mint reports every output as signed", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    await runStartupPass();
    expect(await cursor(regular.id)).toBe(1);
    mint.echoRestore = true;
    const requests = mint.requestsTo("/v1/restore").length;

    await advanceWalletKeysetCounterPastMint({
      scopeId: scopeId(),
      mintUrl: MINT_URL,
      unit: "msat",
      keyset: activeKeyset(regular),
    });

    // One scan asks about 3,000 counters in requests of 100, then stops.
    expect(mint.requestsTo("/v1/restore").length - requests).toBe(30);
    expect(await cursor(regular.id)).toBe(3_001);
    expect((await resyncRow(regular.id))?.pendingFromCounter).toBe(1);
  });
});
