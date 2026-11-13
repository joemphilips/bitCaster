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
    // The recovery index runtime calls the engine at the page origin.
    location: dom.window.location,
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
import {
  activateBrowserWalletDatabase,
  BitcasterDB,
  db,
  type StoredProofRow,
} from "@/stores/proof-db";
import {
  recordGeneratedBrowserSeed,
  seedRestoreDatabase,
  type SeedRestoreDB,
} from "@/stores/seed-restore-db";
import { useActivityLogStore } from "@/stores/activity-log";
import { useToastStore } from "@/stores/toast";
import {
  FakeMint,
  MINT_URL,
  MNEMONIC,
  binaryMarket,
  blindedOutput,
  byKeysetAndAmount,
  cursor,
  installLockManager,
  position,
  regularHolding,
  regularKeyset,
  scopeId,
  selectableHoldings,
  type FakeKeyset,
} from "@/test/seedRestoreFakeMint";

// A browser that opens an existing recovery phrase must get back the market
// positions that the seed holds at the mint, not only the msat balance
// (ADR-039, amendment 2026-11-09). The seed, the engine recovery index and the
// mint are the only inputs: no Nostr identity and no local operation journal.
// The restore scans the listed, the regular and the hinted keysets, and never
// the market catalogue. Network I/O goes to a fake mint and a fake engine.

const GAP = 300;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

const mocks = vi.hoisted(() => ({
  passCompleted: [] as Array<() => void>,
  walletsByUnit: new Map<string, Promise<unknown>>(),
  signer: undefined as unknown,
  getAssets: vi.fn(),
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

// The hook asks for an index upload once at the end of each recovery pass.
vi.mock("@/lib/browserRecoveryIndex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/browserRecoveryIndex")>()),
  uploadBrowserRecoveryIndexAfterRecovery: vi.fn(() => {
    mocks.passCompleted.shift()?.();
  }),
}));

// The asset-monitoring hint needs a Nostr signer and an authenticated engine read.
vi.mock("@/lib/nostr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/nostr")>()),
  getNdk: () => ({ signer: mocks.signer }),
}));
vi.mock("@/lib/markets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/markets")>()),
  createAuthenticatedBrowserEngineClient: () => ({
    getAssetMonitoringAssets: mocks.getAssets,
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
import { walletRecoveryEmptyIsTerminal } from "@bitcaster/client-sdk/walletRecoveryStatus";
import { publishBrowserCtfRangeRecoveryWake } from "@/lib/browserCtfRangeOrderRecoveryWake";
import { activeBrowserRecoveryIndex } from "@/lib/browserRecoveryIndex";
import {
  browserSeedPositionRestoreHintsSettled,
  retryBrowserSeedPositionRestore,
  runBrowserSeedPositionRestorePass,
} from "@/lib/browserSeedPositionRestore";
import { seedRestoreResultIsPartial, seedRestoreResultIsRetryable } from "@/stores/seed-restore-db";
import { durableWalletRecoveryStatus } from "@/test/walletRecoveryStatusFixture";
import { useBrowserCtfRangeOrderRecovery } from "../useBrowserCtfRangeOrderRecovery";
import { useBrowserRecoveryIndex } from "../useBrowserRecoveryIndex";

// The pass derives and verifies real NUT-13 outputs. Under CPU load it can
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

async function restoreRow(keysetId: string) {
  return seedRestoreDatabase(scopeId()).keysets.get([scopeId(), MINT_URL, keysetId]);
}

async function restoreState() {
  return seedRestoreDatabase(scopeId()).states.get([scopeId(), MINT_URL]);
}

let unmount: (() => void) | undefined;
let closeIndex: (() => void) | undefined;

/**
 * Opens the wallet as the app does: the recovery index runtime reads the
 * index (ADR-033 "wallet open"), and the recovery coordinator runs a pass.
 * Returns after the first pass, with the wallet still open.
 */
async function openWallet(): Promise<void> {
  const firstPass = nextPassCompleted();
  ({ unmount } = renderHook(() => {
    useBrowserRecoveryIndex(MNEMONIC);
    useBrowserCtfRangeOrderRecovery({
      nostrSignerReady: true,
      walletMnemonic: MNEMONIC,
      walletMintUrls: MINT_URL,
    });
  }));
  await firstPass;
}

/** Opens the wallet, runs the first recovery pass, and closes the wallet. */
async function runStartupPass(): Promise<void> {
  await openWallet();
  closeWallet();
}

function closeWallet(): void {
  unmount?.();
  unmount = undefined;
}

/** Only the recovery index runtime, for passes that a test runs at a controlled time. */
async function openIndexOnly(): Promise<void> {
  ({ unmount: closeIndex } = renderHook(() => useBrowserRecoveryIndex(MNEMONIC)));
  await activeBrowserRecoveryIndex(scopeId())!.lastRead();
}

/** Runs the next recovery pass of the open wallet: a wake, as any later event or timer does. */
async function nextPass(): Promise<void> {
  const pass = nextPassCompleted();
  publishBrowserCtfRangeRecoveryWake({ scopeId: scopeId() });
  await pass;
}

/** One restore pass for the test mint at a controlled time. */
function restorePass(now: () => number, counterBudget?: number) {
  return runBrowserSeedPositionRestorePass({
    scopeId: scopeId(),
    mnemonic: MNEMONIC,
    mintUrl: MINT_URL,
    now,
    ...(counterBudget === undefined ? {} : { counterBudget }),
  });
}

async function restoreResult() {
  const state = (await restoreState())!;
  const keysets = await seedRestoreDatabase(scopeId())
    .keysets.where("[scopeId+mintUrl]")
    .equals([scopeId(), MINT_URL])
    .toArray();
  return {
    partial: seedRestoreResultIsPartial(state, keysets),
    retryable: seedRestoreResultIsRetryable(state, keysets),
  };
}

async function recoveryStatus() {
  return durableWalletRecoveryStatus({ scopeId: scopeId(), mintUrls: [MINT_URL] });
}

/** Whether an empty holdings read of the current status would show as final. */
async function emptyIsFinal(): Promise<boolean> {
  const status = await recoveryStatus();
  if (status.kind !== "completed") return false;
  return walletRecoveryEmptyIsTerminal(status, {
    kind: "ok",
    tag: status.tag,
    afterPassSeq: status.passSeq,
    value: [],
  });
}

/** Every restore request that would walk the catalogue or the whole mint listing. */
function expectNoCatalogueWalk(mint: FakeMint): void {
  expect(mint.catalogueRequests().map(({ url }) => url.href)).toEqual([]);
}

function expectNotScanned(mint: FakeMint, ...keysets: FakeKeyset[]): void {
  for (const keyset of keysets) expect(mint.scanned(keyset), keyset.id).toBe(false);
}

/** Deletes the restore record of the seed, as a seed handoff or a wallet reset does. */
async function clearRestoreRecord(): Promise<void> {
  const database = seedRestoreDatabase(scopeId());
  for (const table of database.tables) await table.clear();
}

function activityHint(marketId: string) {
  return {
    id: `trade:${marketId}`,
    walletId: browserWalletIdFromMnemonic(MNEMONIC)!,
    type: "Buy" as const,
    amountSubunits: 2,
    baseAsset: "sat" as const,
    date: "2026-11-03T00:00:00.000Z",
    status: "completed" as const,
    txId: null,
    lightningInvoice: null,
    marketId,
  };
}

describe("useBrowserCtfRangeOrderRecovery — a new browser opens an existing seed", () => {
  let seedRestore: SeedRestoreDB | null = null;

  beforeEach(() => {
    (useWalletStore.getState() as { mnemonic: string }).mnemonic = MNEMONIC;
    setActiveBrowserWalletProfile(MNEMONIC);
    activateBrowserWalletDatabase(scopeId());
    seedRestore = seedRestoreDatabase(scopeId());
    mocks.walletsByUnit.clear();
    mocks.passCompleted.length = 0;
    mocks.signer = undefined;
    mocks.getAssets.mockReset();
    useActivityLogStore.setState({ items: [] });
    useToastStore.setState({ toasts: [] });
    // The cap of restore starts is browser-level storage.
    window.localStorage.clear();
    installLockManager();
  });

  afterEach(async () => {
    closeWallet();
    closeIndex?.();
    closeIndex = undefined;
    vi.unstubAllGlobals();
    for (const table of db.tables) await table.clear();
    if (seedRestore !== null) for (const table of seedRestore.tables) await table.clear();
  });

  it("restores the listed held and resolved-market positions with only the seed, the index and the mint", async () => {
    const regular = regularKeyset();
    const held = binaryMarket("ab".repeat(32));
    const resolved = binaryMarket("cd".repeat(32), false);
    const untouched = binaryMarket("ef".repeat(32));
    const mint = new FakeMint(regular, [
      held.yes,
      held.no,
      resolved.yes,
      resolved.no,
      untouched.yes,
      untouched.no,
    ]);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "UNSPENT" });
    mint.sign({ keyset: held.yes, counter: 0, amount: 2, state: "UNSPENT" });
    mint.sign({ keyset: held.yes, counter: 1, amount: 4, state: "SPENT" });
    mint.sign({ keyset: held.yes, counter: 2, amount: 1, state: "UNSPENT" });
    mint.sign({ keyset: resolved.no, counter: 0, amount: 4, state: "UNSPENT" });
    // The engine holds the index that the old browser wrote.
    await mint.listInIndex([regular, held.yes, held.no, resolved.no]);
    vi.stubGlobal("fetch", mint.fetch);

    await runStartupPass();

    const holdings = await selectableHoldings();
    expect(holdings).toContainEqual(regularHolding(regular, 8));
    // Only UNSPENT proofs are admitted.
    expect(holdings.filter(({ assetKind }) => assetKind === "conditional")).toEqual(
      [position(held.yes, 1), position(held.yes, 2), position(resolved.no, 4)].sort(
        byKeysetAndAmount,
      ),
    );
    expect((await restoreState())?.initialCompletedAtMs).not.toBe(null);
    expect(await restoreResult()).toEqual({ partial: false, retryable: false });
    expect(await recoveryStatus()).toMatchObject({ kind: "completed", coverage: "full" });
    // Only the listed and regular keysets: no market that the index does not list.
    expectNoCatalogueWalk(mint);
    expectNotScanned(mint, untouched.yes, untouched.no, resolved.yes);
    expect(
      mint.requests.some(({ url }) => url.searchParams.get("condition_id") === "ef".repeat(32)),
    ).toBe(false);

    // The mint receives no engine identity, Nostr key, or wallet id.
    const walletId = browserWalletIdFromMnemonic(MNEMONIC)!;
    const mintRequests = mint.requests.filter(({ url }) => url.origin === MINT_URL);
    expect(mintRequests.length).toBeGreaterThan(0);
    for (const request of mintRequests) {
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("x-recovery-index-key")).toBeNull();
      expect(`${request.url.href}\n${request.body}`).not.toContain(walletId);
      expect(`${request.url.href}\n${request.body}`).not.toContain(scopeId());
    }
  });

  it("moves each cursor 150 counters past the last signed output, and leaves no cursor for an empty regular keyset", async () => {
    const regular = regularKeyset();
    const used = binaryMarket("ab".repeat(32));
    const empty = binaryMarket("cd".repeat(32));
    const mint = new FakeMint(regular, [used.yes, used.no, empty.yes, empty.no]);
    mint.sign({ keyset: used.yes, counter: 7, amount: 2, state: "SPENT" });
    await mint.listInIndex([used.yes, used.no]);
    vi.stubGlobal("fetch", mint.fetch);
    useActivityLogStore.setState({ items: [activityHint(`${"cd".repeat(32)}-YES`)] });

    await runStartupPass();

    // ADR-051: the cursor is the last signed counter plus 150, or 149 with no
    // signed counter. The next output uses the cursor plus 1.
    expect(await cursor(used.yes.id)).toBe(7 + 151);
    expect(await cursor(used.no.id)).toBe(150);
    // An empty regular or hinted keyset holds no output of the seed: no
    // cursor, and no index entry.
    expect(await cursor(regular.id)).toBeUndefined();
    expect(await cursor(empty.yes.id)).toBeUndefined();
  });

  it("scans each regular keyset once, with the cursor rule of the restore", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 4, amount: 8, state: "UNSPENT" });
    await mint.listInIndex([regular]);
    vi.stubGlobal("fetch", mint.fetch);

    await runStartupPass();

    expect(await selectableHoldings()).toEqual([regularHolding(regular, 8)]);
    expect(await cursor(regular.id)).toBe(4 + 151);
    // One scan from counter 0: the regular counter recovery does not scan it again.
    const first = blindedOutput(regular, 0);
    expect(mint.restoredOutputs().filter((outputs) => outputs.includes(first))).toHaveLength(1);
  });

  it("never walks the catalogue, with an index, without one, or while the engine is down", async () => {
    for (const index of ["listed", "absent", "unreachable"] as const) {
      const regular = regularKeyset();
      const listed = binaryMarket("ab".repeat(32));
      const other = binaryMarket("cd".repeat(32));
      const mint = new FakeMint(regular, [listed.yes, listed.no, other.yes, other.no]);
      // A catalogue exists, but the restore must not read it.
      mint.catalogue = [
        { conditionId: "ab".repeat(32), outcomes: ["YES", "NO"] },
        { conditionId: "cd".repeat(32), outcomes: ["YES", "NO"] },
      ];
      mint.sign({ keyset: other.yes, counter: 0, amount: 4, state: "UNSPENT" });
      if (index === "listed") await mint.listInIndex([listed.yes]);
      mint.indexUnreachable = index === "unreachable";
      vi.stubGlobal("fetch", mint.fetch);

      await runStartupPass();

      expect((await restoreState())?.initialCompletedAtMs, index).not.toBeNull();
      expectNoCatalogueWalk(mint);
      expectNotScanned(mint, other.yes, other.no);
      // The position in the market that nothing names stays at the mint.
      expect(await selectableHoldings(), index).toEqual([]);
      await clearRestoreRecord();
      for (const table of db.tables) await table.clear();
      window.localStorage.clear();
      mocks.walletsByUnit.clear();
    }
  });

  it("with no index, shows the restored result as partial and never as final zero holdings", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);

    await runStartupPass();

    // The regular keysets restore without an index.
    expect(await selectableHoldings()).toEqual([regularHolding(regular, 8)]);
    expect((await restoreState())?.index).toBe("absent");
    expect(await restoreResult()).toEqual({ partial: true, retryable: false });
    expect(await recoveryStatus()).toMatchObject({ kind: "completed", coverage: "limited" });
    expect(await emptyIsFinal()).toBe(false);
  });

  it("while the engine is down, restores the rest, and Retry reads the index and scans its keysets", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.sign({ keyset: market.yes, counter: 3, amount: 4, state: "UNSPENT" });
    await mint.listInIndex([market.yes]);
    mint.indexUnreachable = true;
    vi.stubGlobal("fetch", mint.fetch);

    await openWallet();

    expect((await restoreState())?.index).toBe("unavailable");
    expect(await restoreResult()).toEqual({ partial: true, retryable: true });
    expect(await emptyIsFinal()).toBe(false);
    expect(await selectableHoldings()).toEqual([]);
    const indexReads = mint.index.count("GET");

    // A later pass reads nothing: the browser never reads the index on a timer.
    await nextPass();
    expect(mint.index.count("GET")).toBe(indexReads);

    mint.indexUnreachable = false;
    await retryBrowserSeedPositionRestore(scopeId());
    await nextPass();

    expect(mint.index.count("GET")).toBeGreaterThan(indexReads);
    expect((await restoreState())?.index).toBe("listed");
    expect(await selectableHoldings()).toEqual([position(market.yes, 4)]);
    expect(await restoreResult()).toEqual({ partial: false, retryable: false });
  });

  it("scans a listed keyset with no local cursor after an index read, also in a browser that generated the seed", async () => {
    const regular = regularKeyset();
    const local = binaryMarket("ab".repeat(32));
    const elsewhere = binaryMarket("cd".repeat(32));
    const mint = new FakeMint(regular, [local.yes, local.no, elsewhere.yes, elsewhere.no]);
    // Another browser of the seed traded a new market and listed its keyset.
    mint.sign({ keyset: elsewhere.no, counter: 0, amount: 2, state: "UNSPENT" });
    mint.sign({ keyset: local.yes, counter: 9, amount: 8, state: "UNSPENT" });
    await mint.listInIndex([local.yes, elsewhere.no]);
    vi.stubGlobal("fetch", mint.fetch);
    await recordGeneratedBrowserSeed(scopeId());
    // This browser already uses `local.yes`.
    await db.walletCounterCursors.put({ scopeId: scopeId(), keysetId: local.yes.id, next: 5 });
    await db.walletCounterAssociations.put({
      scopeId: scopeId(),
      normalizedMint: MINT_URL,
      unit: "msat",
      keysetId: local.yes.id,
      recoveryComplete: true,
    });

    await openWallet();
    // The read recorded the scan and woke the coordinator.
    await nextPass();

    expect(await selectableHoldings()).toEqual([position(elsewhere.no, 2)]);
    // An index read never starts a scan of a keyset that the browser already uses.
    expectNotScanned(mint, local.yes);
    expect(await cursor(local.yes.id)).toBe(5);
    expectNoCatalogueWalk(mint);
  });

  it("surfaces unverifiable and implausible keysets without stopping the restore", async () => {
    const regular = regularKeyset();
    const good = binaryMarket("ab".repeat(32));
    const unknown = binaryMarket("cd".repeat(32));
    const hostile = binaryMarket("ef".repeat(32));
    // The mint does not list `unknown` at all.
    const mint = new FakeMint(regular, [good.yes, good.no, hostile.yes, hostile.no]);
    mint.sign({ keyset: good.yes, counter: 0, amount: 2, state: "UNSPENT" });
    mint.sign({ keyset: hostile.yes, counter: 0, amount: 4, state: "UNSPENT" });
    // The index lists two keysets that the restore must refuse.
    await mint.listInIndex([unknown.yes, hostile.yes, good.yes]);
    // The NUT-07 answer for the hostile keyset is not a known state.
    mint.unknownStateKeysets.add(hostile.yes.id);
    vi.stubGlobal("fetch", mint.fetch);

    await runStartupPass();

    expect(await selectableHoldings()).toEqual([position(good.yes, 2)]);
    expect(await restoreRow(unknown.yes.id)).toMatchObject({ state: "unverifiable" });
    expect(await restoreRow(hostile.yes.id)).toMatchObject({
      state: "implausible",
      refusal: "proof-state",
    });
    expect((await restoreState())?.initialCompletedAtMs).not.toBeNull();
    expect(await restoreResult()).toEqual({ partial: true, retryable: true });
    expect(await emptyIsFinal()).toBe(false);
  });

  it("scans a hinted market from counter 0 with the gap rule, and never a market that nothing names", async () => {
    const regular = regularKeyset();
    const hinted = binaryMarket("ab".repeat(32));
    const unhinted = binaryMarket("cd".repeat(32));
    const mint = new FakeMint(regular, [hinted.yes, hinted.no, unhinted.yes, unhinted.no]);
    // Many unfilled orders used the first counters, so the first fill came later.
    mint.sign({ keyset: hinted.yes, counter: GAP - 1, amount: 2, state: "UNSPENT" });
    mint.sign({ keyset: unhinted.yes, counter: 0, amount: 4, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    // The NIP-78 activity log of this wallet names the hinted market.
    useActivityLogStore.setState({ items: [activityHint(`${"ab".repeat(32)}-YES`)] });

    await runStartupPass();

    expect(await selectableHoldings()).toEqual([position(hinted.yes, 2)]);
    expectNotScanned(mint, unhinted.yes, unhinted.no);
    expectNoCatalogueWalk(mint);
  });

  it("scans the market of a hint that arrives after the restore completed", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.sign({ keyset: market.yes, counter: 20, amount: 2, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    await openIndexOnly();
    let nowMs = 1_000_000;
    const now = () => nowMs;

    expect((await restorePass(now)).status).toBe("complete");
    expect(await selectableHoldings()).toEqual([]);

    // The relays deliver the activity log after the first pass.
    useActivityLogStore.setState({ items: [activityHint(`${"ab".repeat(32)}-YES`)] });
    nowMs += 1_000;
    await restorePass(now);

    expect(await selectableHoldings()).toEqual([position(market.yes, 2)]);
  });

  it("settles the asset-monitoring hints only after a read with a signer", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.sign({ keyset: market.no, counter: 5, amount: 4, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    await openIndexOnly();
    mocks.getAssets.mockResolvedValue({
      assets: [
        {
          asset: { kind: "conditional", canonicalMintUrl: MINT_URL, conditionId: "ab".repeat(32) },
        },
      ],
      nextCursor: null,
    });
    let nowMs = 1_000_000;
    const now = () => nowMs;

    // No signer: the earlier report cannot be read, so the first report waits.
    expect((await restorePass(now)).hintsSettled).toBe(false);
    expect(await browserSeedPositionRestoreHintsSettled(scopeId())).toBe(false);
    expect(mocks.getAssets).not.toHaveBeenCalled();

    // A failed read does not settle the hints either.
    mocks.signer = { pubkey: "signer" };
    mocks.getAssets.mockRejectedValueOnce(new Error("unavailable"));
    nowMs += 1_000;
    expect((await restorePass(now)).hintsSettled).toBe(false);
    expect(await browserSeedPositionRestoreHintsSettled(scopeId())).toBe(false);

    nowMs += 1_000;
    expect((await restorePass(now)).hintsSettled).toBe(true);
    expect(await browserSeedPositionRestoreHintsSettled(scopeId())).toBe(true);
    expect(await selectableHoldings()).toEqual([position(market.no, 4)]);
  });

  it("keeps restoring while a hinted market listing fails and shows the error after repeated failures", async () => {
    const regular = regularKeyset();
    const listed = binaryMarket("ab".repeat(32));
    const failing = binaryMarket("cd".repeat(32));
    const mint = new FakeMint(regular, [listed.yes, listed.no, failing.yes, failing.no]);
    mint.sign({ keyset: listed.yes, counter: 0, amount: 2, state: "UNSPENT" });
    mint.sign({ keyset: failing.no, counter: 0, amount: 4, state: "UNSPENT" });
    mint.failConditionListing.add("cd".repeat(32));
    await mint.listInIndex([listed.yes]);
    vi.stubGlobal("fetch", mint.fetch);
    await openIndexOnly();
    useActivityLogStore.setState({ items: [activityHint(`${"cd".repeat(32)}-NO`)] });
    let nowMs = 1_000_000;
    const now = () => nowMs;

    const first = await restorePass(now);

    expect(first.status).not.toBe("complete");
    expect(first.retryAtMs).not.toBeNull();
    expect(await selectableHoldings()).toEqual([position(listed.yes, 2)]);
    expect((await restoreState())?.initialCompletedAtMs).toBeNull();
    expect(await recoveryStatus()).toMatchObject({ kind: "pending" });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      nowMs += HOUR_MS;
      await restorePass(now);
    }
    expect(await recoveryStatus()).toMatchObject({
      kind: "unavailable",
      reason: "recovery-failed",
    });

    // Retry clears the failed listing at once.
    mint.failConditionListing.clear();
    await retryBrowserSeedPositionRestore(scopeId());
    nowMs += 1_000;
    expect((await restorePass(now)).status).toBe("complete");

    expect(await selectableHoldings()).toEqual(
      [position(listed.yes, 2), position(failing.no, 4)].sort(byKeysetAndAmount),
    );
    expect(await recoveryStatus()).toMatchObject({ kind: "completed", coverage: "full" });
  });

  it("keeps the restore position while a keyset scan fails", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.sign({ keyset: market.yes, counter: 0, amount: 2, state: "UNSPENT" });
    mint.failCheckstate = true;
    await mint.listInIndex([market.yes]);
    vi.stubGlobal("fetch", mint.fetch);
    await openIndexOnly();
    let nowMs = 1_000_000;
    const now = () => nowMs;

    const first = await restorePass(now);

    expect(first.status).not.toBe("complete");
    expect(await restoreRow(market.yes.id)).toMatchObject({ state: "queued", failures: 1 });
    expect((await restoreState())?.initialCompletedAtMs).toBeNull();

    mint.failCheckstate = false;
    nowMs += HOUR_MS;
    expect((await restorePass(now)).status).toBe("complete");
    expect(await selectableHoldings()).toEqual([position(market.yes, 2)]);
  });

  it("stops at the counter budget of its start, shows a partial result, and Retry continues with a new budget", async () => {
    const regular = regularKeyset();
    const first = binaryMarket("ab".repeat(32));
    const second = binaryMarket("cd".repeat(32));
    const mint = new FakeMint(regular, [first.yes, first.no, second.yes, second.no]);
    mint.sign({ keyset: second.yes, counter: 1, amount: 8, state: "UNSPENT" });
    await mint.listInIndex([first.yes, second.yes]);
    vi.stubGlobal("fetch", mint.fetch);
    await openIndexOnly();
    let nowMs = 1_000_000;
    const now = () => nowMs;

    // The budget holds the empty scan of the first keyset only.
    expect((await restorePass(now, GAP)).status).toBe("complete");

    expect(await restoreState()).toMatchObject({
      budgetStopped: true,
      countersUsed: GAP,
      initialCompletedAtMs: null,
    });
    expect(await restoreResult()).toEqual({ partial: true, retryable: true });
    expect(await emptyIsFinal()).toBe(false);
    // A later pass does not continue a stopped restore.
    const restores = mint.requestsTo("/v1/restore").length;
    nowMs += 1_000;
    await restorePass(now, GAP);
    expect(mint.requestsTo("/v1/restore")).toHaveLength(restores);

    // The new budget holds the rest: the second listed keyset and the regular keyset.
    await retryBrowserSeedPositionRestore(scopeId());
    nowMs += 1_000;
    await restorePass(now, 3 * GAP);

    expect(await selectableHoldings()).toEqual([position(second.yes, 8)]);
    expect(await restoreState()).toMatchObject({ budgetStopped: false });
    expect((await restoreState())?.initialCompletedAtMs).not.toBeNull();
  });

  it("sends no restore request in a later pass once the restore completed", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.sign({ keyset: market.yes, counter: 0, amount: 2, state: "UNSPENT" });
    await mint.listInIndex([market.yes]);
    vi.stubGlobal("fetch", mint.fetch);
    await openWallet();
    const restores = mint.requestsTo("/v1/restore").length;
    const reads = mint.index.count("GET");
    expect(restores).toBeGreaterThan(0);

    // A pass that a timer or another event runs scans nothing again.
    await nextPass();
    await nextPass();

    expect(mint.requestsTo("/v1/restore")).toHaveLength(restores);
    expect(mint.index.count("GET")).toBe(reads);
    expectNoCatalogueWalk(mint);
  });

  it("starts at most four restores in a rolling day", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    vi.stubGlobal("fetch", mint.fetch);
    const firstStart = 1_000_000;
    let nowMs = firstStart;
    const now = () => nowMs;
    for (let start = 0; start < 4; start += 1) {
      // A seed handoff or a wallet reset deletes the restore record of the seed.
      await clearRestoreRecord();
      expect((await restorePass(now)).status).toBe("complete");
      nowMs += HOUR_MS;
    }
    await clearRestoreRecord();
    const requests = mint.requests.length;

    const capped = await restorePass(now);

    // The fifth start waits for a free slot. It sends no request to the mint.
    expect(capped.status).toBe("waiting");
    expect(capped.retryAtMs).toBe(firstStart + DAY_MS);
    expect(mint.requests).toHaveLength(requests);
    // A denied start leaves no restore record, so the next pass claims again.
    expect(await restoreState()).toBeUndefined();
    expect(
      await durableWalletRecoveryStatus({
        scopeId: scopeId(),
        mintUrls: [MINT_URL],
        seedRestore: capped,
      }),
    ).toMatchObject({
      kind: "pending",
      reason: "start-limit",
      retryAtMs: firstStart + DAY_MS,
    });

    nowMs = firstStart + DAY_MS;
    expect((await restorePass(now)).status).toBe("complete");
  });

  it("uses one start when two passes begin the same restore", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    vi.stubGlobal("fetch", mint.fetch);
    const now = () => 1_000_000;

    // Two tabs open the same seed at once.
    await Promise.all([restorePass(now), restorePass(now)]);

    expect(JSON.parse(window.localStorage.getItem("bitcaster.seed-restore-starts")!)).toHaveLength(
      1,
    );
  });

  it("does not let a second tab scan while the start cap is reached", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    vi.stubGlobal("fetch", mint.fetch);
    const nowMs = 1_000_000 + DAY_MS;
    const starts = [0, 1, 2, 3].map((start) => nowMs - HOUR_MS + start);
    window.localStorage.setItem("bitcaster.seed-restore-starts", JSON.stringify(starts));

    // Two tabs open the same seed at once. The first start is denied, and
    // its state row must not let the second tab resume a scan.
    const passes = await Promise.all([restorePass(() => nowMs), restorePass(() => nowMs)]);

    expect(passes.map(({ status }) => status)).toEqual(["waiting", "waiting"]);
    expect(mint.requests).toHaveLength(0);
    expect(await restoreState()).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem("bitcaster.seed-restore-starts")!)).toEqual(
      starts,
    );
  });

  it("uses no start when the first state row cannot be written", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    vi.stubGlobal("fetch", mint.fetch);
    const states = seedRestoreDatabase(scopeId()).states;
    const put = vi.spyOn(states, "put").mockRejectedValueOnce(new Error("quota exceeded"));

    await expect(restorePass(() => 1_000_000)).rejects.toThrow("quota exceeded");

    expect(await restoreState()).toBeUndefined();
    expect(window.localStorage.getItem("bitcaster.seed-restore-starts") ?? "[]").toBe("[]");
    put.mockRestore();
    expect((await restorePass(() => 1_000_000)).status).toBe("complete");
  });

  it("does not count a resumed scan or a Retry as a new start", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.failConditionListing.add("ab".repeat(32));
    vi.stubGlobal("fetch", mint.fetch);
    useActivityLogStore.setState({ items: [activityHint(`${"ab".repeat(32)}-YES`)] });
    let nowMs = 1_000_000;
    const now = () => nowMs;
    // One start, then resumed passes and a Retry while the listing fails.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await restorePass(now)).status).not.toBe("complete");
      nowMs += HOUR_MS;
    }
    await retryBrowserSeedPositionRestore(scopeId());
    mint.failConditionListing.clear();
    expect((await restorePass(now)).status).toBe("complete");

    // Three more starts fit in the same day. A fifth start does not.
    useActivityLogStore.setState({ items: [] });
    for (let start = 0; start < 3; start += 1) {
      await clearRestoreRecord();
      nowMs += 1_000;
      expect((await restorePass(now)).status).toBe("complete");
    }
    await clearRestoreRecord();
    nowMs += 1_000;
    expect((await restorePass(now)).status).toBe("waiting");
  });

  it("does not scan the mint for a seed that this browser generated", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    vi.stubGlobal("fetch", mint.fetch);
    await recordGeneratedBrowserSeed(scopeId());

    await runStartupPass();

    expect(mint.requestsTo("/v1/conditional_keysets")).toEqual([]);
    expect(mint.requestsTo("/v1/keys/" + market.yes.id)).toEqual([]);
    expectNoCatalogueWalk(mint);
  });

  it("restores positions without a change to the wallet database schema", async () => {
    // Release 5b writes schema version 22. The restore keeps its state in its own
    // database, so the wallet schema and its rows stay as the release wrote them.
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.sign({ keyset: market.yes, counter: 0, amount: 4, state: "UNSPENT" });
    await mint.listInIndex([market.yes]);
    vi.stubGlobal("fetch", mint.fetch);
    const legacyRow: StoredProofRow = {
      secret: "legacy-secret",
      id: regular.id,
      amount: 1,
      C: `02${"11".repeat(32)}`,
      mintUrl: MINT_URL,
      unit: "msat",
      baseAsset: "sat",
      receivedAt: 1,
    } as StoredProofRow;
    await db.proofs.put(legacyRow);
    expect(db.verno).toBe(22);

    await runStartupPass();

    expect(await selectableHoldings()).toContainEqual(position(market.yes, 4));
    expect(db.verno).toBe(22);
    expect(await db.proofs.get("legacy-secret")).toEqual(legacyRow);
    const reopened = new BitcasterDB(db.name);
    try {
      await reopened.open();
      expect(reopened.verno).toBe(22);
    } finally {
      reopened.close();
    }
  });
});
