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
  byKeysetAndAmount,
  conditionalKeyset,
  installLockManager,
  position,
  regularHolding,
  regularKeyset,
  scopeId,
  selectableHoldings,
} from "@/test/seedRestoreFakeMint";

// A browser that opens an existing recovery phrase must get back the market
// positions that the seed holds at the mint, not only the msat balance. The
// mint and the seed are the only inputs here: no Nostr identity, no engine
// data, and no local operation journal. Network I/O goes to a fake mint.

const PROBE_WINDOW = 128;
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

// The hook calls this once at the end of each recovery pass.
vi.mock("@/lib/encryptedWalletBackupDriver", () => ({
  resumeBrowserEncryptedWalletBackupV2AfterRecovery: vi.fn(() => {
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
import {
  browserSeedPositionRestoreHintsSettled,
  retryBrowserSeedPositionRestore,
  runBrowserSeedPositionRestorePass,
} from "@/lib/browserSeedPositionRestore";
import { readSeedPositionRestoreStatus } from "@/hooks/useSeedPositionRestoreStatus";
import { useBrowserCtfRangeOrderRecovery } from "../useBrowserCtfRangeOrderRecovery";

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

/** One restore pass for the test mint at a controlled time. */
function restorePass(now: () => number) {
  return runBrowserSeedPositionRestorePass({
    scopeId: scopeId(),
    mnemonic: MNEMONIC,
    mintUrl: MINT_URL,
    now,
  });
}

/** Deletes the restore record of the seed, as a seed handoff or a wallet reset does. */
async function clearRestoreRecord(): Promise<void> {
  const database = seedRestoreDatabase(scopeId());
  for (const table of database.tables) await table.clear();
}

function catalogueEntry(conditionId: string) {
  return { conditionId, outcomes: ["YES", "NO"] };
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
    // The cap of full restore scans is browser-level storage.
    window.localStorage.clear();
    installLockManager();
  });

  afterEach(async () => {
    unmount?.();
    unmount = undefined;
    vi.unstubAllGlobals();
    for (const table of db.tables) await table.clear();
    if (seedRestore !== null) for (const table of seedRestore.tables) await table.clear();
  });

  it("restores held and resolved-market positions with only the seed and the mint", async () => {
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
    vi.stubGlobal("fetch", mint.fetch);

    await runStartupPass();

    const holdings = await selectableHoldings();
    // The msat balance comes back today.
    expect(holdings).toContainEqual(regularHolding(regular, 8));
    // The positions must come back as well. Only UNSPENT proofs are admitted.
    expect(holdings.filter(({ assetKind }) => assetKind === "conditional")).toEqual(
      [position(held.yes, 1), position(held.yes, 2), position(resolved.no, 4)].sort(
        byKeysetAndAmount,
      ),
    );
    expect((await restoreState())?.initialCompletedAtMs).not.toBe(null);

    // The mint receives no engine identity, Nostr key, or wallet id.
    const walletId = browserWalletIdFromMnemonic(MNEMONIC)!;
    const mintRequests = mint.requests.filter(({ url }) => url.origin === MINT_URL);
    expect(mintRequests.length).toBeGreaterThan(0);
    for (const request of mintRequests) {
      expect(request.headers.get("authorization")).toBeNull();
      expect(`${request.url.href}\n${request.body}`).not.toContain(walletId);
      expect(`${request.url.href}\n${request.body}`).not.toContain(scopeId());
    }
  });

  it("skips a foreign keyset listing without failing the pass", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    // Not bitCaster markets: a sat keyset and a nine-outcome condition.
    const satKeyset = conditionalKeyset({
      conditionId: "12".repeat(32),
      outcomeCollection: "YES",
      active: true,
      unit: "sat",
    });
    const wide = Array.from({ length: 9 }, (_, index) =>
      conditionalKeyset({
        conditionId: "34".repeat(32),
        outcomeCollection: `O${index}`,
        active: true,
      }),
    );
    const mint = new FakeMint(regular, [satKeyset, ...wide, market.yes, market.no]);
    mint.sign({ keyset: market.no, counter: 0, amount: 8, state: "UNSPENT" });
    mint.sign({ keyset: wide[0]!, counter: 0, amount: 8, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);

    await runStartupPass();

    expect(await selectableHoldings()).toEqual([position(market.no, 8)]);
    expect(await restoreRow(wide[0]!.id)).toBeUndefined();
    expect(
      (await seedRestore!.conditions.get([scopeId(), MINT_URL, "34".repeat(32)]))?.foreign,
    ).toBe(9);
  });

  it("finds a first signature after the probe window only when a hint names the market", async () => {
    const regular = regularKeyset();
    const hinted = binaryMarket("ab".repeat(32));
    const unhinted = binaryMarket("cd".repeat(32));
    const mint = new FakeMint(regular, [hinted.yes, hinted.no, unhinted.yes, unhinted.no]);
    // Many unfilled orders used the first counters, so the first fill came later.
    mint.sign({ keyset: hinted.yes, counter: PROBE_WINDOW + 20, amount: 2, state: "UNSPENT" });
    mint.sign({ keyset: unhinted.yes, counter: PROBE_WINDOW + 20, amount: 4, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    // The NIP-78 activity log of this wallet names the hinted market.
    useActivityLogStore.setState({ items: [activityHint(`${"ab".repeat(32)}-YES`)] });

    await runStartupPass();

    expect(await selectableHoldings()).toEqual([position(hinted.yes, 2)]);
    // The accepted release 4 residual: no hint, and the probe window had no signature.
    expect((await restoreRow(unhinted.yes.id))?.state).toBe("no-signature");
  });

  it("scans a probed market in full when a hint names it later", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.sign({ keyset: market.yes, counter: PROBE_WINDOW + 20, amount: 2, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    let nowMs = 1_000_000;
    const now = () => nowMs;

    await restorePass(now);
    expect((await restoreRow(market.yes.id))?.state).toBe("no-signature");

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
    mint.sign({ keyset: market.no, counter: PROBE_WINDOW + 5, amount: 4, state: "UNSPENT" });
    vi.stubGlobal("fetch", mint.fetch);
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
    // The hint arrived after the probe, so the listed market gets a full scan.
    expect(await selectableHoldings()).toEqual([position(market.no, 4)]);
  });

  it("keeps restoring while a condition listing fails and shows the error after repeated failures", async () => {
    const regular = regularKeyset();
    const listed = binaryMarket("ab".repeat(32));
    const failing = binaryMarket("cd".repeat(32));
    const mint = new FakeMint(regular, [listed.yes, listed.no, failing.yes, failing.no]);
    mint.sign({ keyset: failing.no, counter: 0, amount: 4, state: "UNSPENT" });
    mint.failConditionListing.add("cd".repeat(32));
    vi.stubGlobal("fetch", mint.fetch);
    let nowMs = 1_000_000;
    const now = () => nowMs;

    const first = await restorePass(now);

    expect(first.status).not.toBe("complete");
    expect(first.retryAtMs).not.toBeNull();
    expect((await restoreState())?.initialCompletedAtMs).toBeNull();
    expect(await readSeedPositionRestoreStatus(scopeId())).toEqual({
      kind: "restoring",
      scopeId: scopeId(),
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      nowMs += HOUR_MS;
      await restorePass(now);
    }
    expect(await readSeedPositionRestoreStatus(scopeId())).toEqual({
      kind: "failed",
      scopeId: scopeId(),
    });

    // Retry clears the failed listing at once.
    mint.failConditionListing.clear();
    await retryBrowserSeedPositionRestore(scopeId());
    nowMs += 1_000;
    expect((await restorePass(now)).status).toBe("complete");

    expect(await selectableHoldings()).toEqual([position(failing.no, 4)]);
    expect(await readSeedPositionRestoreStatus(scopeId())).toEqual({ kind: "idle" });
  });

  it("keeps restoring while a keyset scan fails", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.sign({ keyset: market.yes, counter: 0, amount: 2, state: "UNSPENT" });
    mint.failCheckstate = true;
    vi.stubGlobal("fetch", mint.fetch);
    let nowMs = 1_000_000;
    const now = () => nowMs;

    const first = await restorePass(now);

    expect(first.status).not.toBe("complete");
    expect((await restoreRow(market.yes.id))?.state).toBe("failed");
    expect((await restoreState())?.initialCompletedAtMs).toBeNull();

    mint.failCheckstate = false;
    nowMs += HOUR_MS;
    expect((await restorePass(now)).status).toBe("complete");
    expect(await selectableHoldings()).toEqual([position(market.yes, 2)]);
  });

  it("resumes an incomplete catalogue walk at the page that failed", async () => {
    const regular = regularKeyset();
    const first = binaryMarket("ab".repeat(32));
    const second = binaryMarket("cd".repeat(32));
    const mint = new FakeMint(regular, [first.yes, first.no, second.yes, second.no]);
    mint.catalogue = [catalogueEntry("ab".repeat(32)), catalogueEntry("cd".repeat(32))];
    mint.sign({ keyset: second.no, counter: 0, amount: 4, state: "UNSPENT" });
    // The read of the second page fails once.
    mint.cursorReadFailures = 1;
    vi.stubGlobal("fetch", mint.fetch);
    let nowMs = 1_000_000;
    const now = () => nowMs;

    expect((await restorePass(now)).status).not.toBe("complete");
    expect((await restoreState())?.catalogueCursor).not.toBeNull();

    // After the backoff, the next pass continues at the failed page.
    nowMs += HOUR_MS;
    expect((await restorePass(now)).status).toBe("complete");
    expect(await selectableHoldings()).toEqual([position(second.no, 4)]);
  });

  it("starts at most four full restore scans in a rolling day", async () => {
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
    expect(await readSeedPositionRestoreStatus(scopeId())).toEqual({
      kind: "restoring",
      scopeId: scopeId(),
    });

    nowMs = firstStart + DAY_MS;
    expect((await restorePass(now)).status).toBe("complete");
  });

  it("does not count a resumed scan or a Retry as a new start", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.failConditionListing.add("ab".repeat(32));
    vi.stubGlobal("fetch", mint.fetch);
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
    for (let start = 0; start < 3; start += 1) {
      await clearRestoreRecord();
      nowMs += 1_000;
      expect((await restorePass(now)).status).toBe("complete");
    }
    await clearRestoreRecord();
    nowMs += 1_000;
    expect((await restorePass(now)).status).toBe("waiting");
  });

  it("restarts the catalogue walk from its first page on Retry", async () => {
    const regular = regularKeyset();
    const first = binaryMarket("ab".repeat(32));
    const second = binaryMarket("cd".repeat(32));
    const mint = new FakeMint(regular, [first.yes, first.no, second.yes, second.no]);
    mint.catalogue = [catalogueEntry("ab".repeat(32)), catalogueEntry("cd".repeat(32))];
    mint.sign({ keyset: second.yes, counter: 0, amount: 8, state: "UNSPENT" });
    // The read of the second page fails once, and the engine then restarts.
    mint.cursorReadFailures = 1;
    vi.stubGlobal("fetch", mint.fetch);
    let nowMs = 1_000_000;
    const now = () => nowMs;
    await restorePass(now);
    mint.catalogueEpoch = 1;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      nowMs += HOUR_MS;
      await restorePass(now);
    }
    // The saved cursor is stale, so every pass fails.
    expect(await readSeedPositionRestoreStatus(scopeId())).toEqual({
      kind: "failed",
      scopeId: scopeId(),
    });

    await retryBrowserSeedPositionRestore(scopeId());
    nowMs += 1_000;

    expect((await restorePass(now)).status).toBe("complete");
    expect(await selectableHoldings()).toEqual([position(second.yes, 8)]);
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
    expect(mint.requests.filter(({ url }) => url.pathname === "/api/v1/markets/query")).toEqual([]);
  });

  it("restores positions into a wallet database of the deployed release 3 schema", async () => {
    // Release 3 writes schema version 21. The restore keeps its state in its own
    // database, so the wallet schema and its rows stay as the previous release wrote them.
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.sign({ keyset: market.yes, counter: 0, amount: 4, state: "UNSPENT" });
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
    expect(db.verno).toBe(21);

    await runStartupPass();

    expect(await selectableHoldings()).toContainEqual(position(market.yes, 4));
    expect(db.verno).toBe(21);
    expect(await db.proofs.get("legacy-secret")).toEqual(legacyRow);
    const reopened = new BitcasterDB(db.name);
    try {
      await reopened.open();
      expect(reopened.verno).toBe(21);
    } finally {
      reopened.close();
    }
  });
});
