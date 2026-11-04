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
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});
import { renderHook } from "@testing-library/react";
import {
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/curves/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { toSeed } from "@/lib/bip39";
import {
  browserWalletIdFromMnemonic,
  browserWalletScopeIdFromMnemonic,
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

// A browser that opens an existing recovery phrase must get back the market
// positions that the seed holds at the mint, not only the msat balance. The
// mint and the seed are the only inputs here: no Nostr identity, no engine
// data, and no local operation journal. Network I/O goes to a fake mint.

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SEED = toSeed(MNEMONIC.split(/\s+/));
const MINT_URL = "https://mint.example";
const PROBE_WINDOW = 128;

interface FakeKeyset {
  readonly id: string;
  readonly active: boolean;
  readonly unit: string;
  readonly keys: Record<string, string>;
  readonly privateKeys: ReadonlyMap<number, Uint8Array>;
  readonly conditional?: {
    readonly conditionId: string;
    readonly outcomeCollection: string;
    readonly outcomeCollectionId: string;
    readonly registeredAt: number;
  };
}

let keySalt = 0;

function privateKeysFor(salt: number): Map<number, Uint8Array> {
  return new Map(
    [1, 2, 4, 8].map((amount) => [
      amount,
      Uint8Array.from({ length: 32 }, (_, index) => ((index + amount * 7 + salt * 31) % 250) + 1),
    ]),
  );
}

function publicKeys(privateKeys: ReadonlyMap<number, Uint8Array>): Record<string, string> {
  return Object.fromEntries(
    [...privateKeys].map(([amount, key]) => [
      String(amount),
      bytesToHex(secp256k1.getPublicKey(key, true)),
    ]),
  );
}

function regularKeyset(): FakeKeyset {
  const privateKeys = privateKeysFor(1);
  const keys = publicKeys(privateKeys);
  return {
    id: deriveKeysetId(keys, { unit: "msat", input_fee_ppk: 0, versionByte: 1 }),
    active: true,
    unit: "msat",
    keys,
    privateKeys,
  };
}

function conditionalKeyset(input: {
  conditionId: string;
  outcomeCollection: string;
  active: boolean;
  unit?: string;
}): FakeKeyset {
  keySalt += 1;
  const privateKeys = privateKeysFor(keySalt + 1);
  const keys = publicKeys(privateKeys);
  const unit = input.unit ?? "msat";
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId: input.conditionId,
    outcomeCollection: input.outcomeCollection,
  });
  return {
    id: deriveConditionalKeysetId({
      keys,
      unit,
      conditionId: input.conditionId,
      outcomeCollectionId,
    }),
    active: input.active,
    unit,
    keys,
    privateKeys,
    conditional: {
      conditionId: input.conditionId,
      outcomeCollection: input.outcomeCollection,
      outcomeCollectionId,
      registeredAt: 1_700_000_000 + keySalt,
    },
  };
}

/** The keysets of one binary market under the production one-vs-rest policy. */
function binaryMarket(conditionId: string, active = true) {
  return {
    yes: conditionalKeyset({ conditionId, outcomeCollection: "YES", active }),
    no: conditionalKeyset({ conditionId, outcomeCollection: "NO", active }),
  };
}

type ProofState = "UNSPENT" | "PENDING" | "SPENT";

interface SignedOutput {
  readonly keyset: FakeKeyset;
  readonly counter: number;
  readonly amount: number;
  readonly state: ProofState;
}

interface MintRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
}

/**
 * A fake mint at the HTTP boundary. It returns NUT-09 signatures only for the
 * deterministic outputs that it signed for this seed, and lists conditional
 * keysets only on the NUT-CTF endpoint, as the production mint does. The
 * engine (the app origin) answers 404, so no engine data is available.
 */
class FakeMint {
  readonly requests: MintRequest[] = [];
  /** A failing NUT-07 check stops each scan before admission. */
  failCheckstate = false;
  readonly #signatures = new Map<
    string,
    { id: string; amount: number; C_: string; dleq: { e: string; s: string } }
  >();
  readonly #states = new Map<string, ProofState>();

  constructor(
    readonly regular: FakeKeyset,
    readonly conditional: readonly FakeKeyset[],
  ) {}

  sign(output: SignedOutput): void {
    const data = OutputData.createSingleDeterministicData(
      0,
      SEED,
      output.counter,
      output.keyset.id,
    );
    const blindedMessage = pointFromHex(data.blindedMessage.B_);
    const privateKey = output.keyset.privateKeys.get(output.amount);
    if (privateKey === undefined) throw new Error("fake mint amount key is missing");
    const signature = createBlindSignature(blindedMessage, privateKey, output.keyset.id);
    const dleq = createDLEQProof(blindedMessage, privateKey);
    this.#signatures.set(data.blindedMessage.B_, {
      id: output.keyset.id,
      amount: output.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    });
    this.setState(output.keyset, output.counter, output.state);
  }

  setState(keyset: FakeKeyset, counter: number, state: ProofState): void {
    const data = OutputData.createSingleDeterministicData(0, SEED, counter, keyset.id);
    this.#states.set(hashToCurve(data.secret).toHex(true), state);
  }

  requestsTo(path: string): MintRequest[] {
    return this.requests.filter(({ url }) => url.origin === MINT_URL && url.pathname === path);
  }

  readonly fetch = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
    );
    const method = (
      init?.method ?? (request instanceof Request ? request.method : "GET")
    ).toUpperCase();
    const body = String(init?.body ?? "");
    this.requests.push({ method, url, headers: new Headers(init?.headers), body });
    if (url.origin !== MINT_URL) return json({ detail: "not found" }, 404);
    const allKeysets = [this.regular, ...this.conditional];
    const parsed = () => JSON.parse(body || "{}") as Record<string, unknown>;
    if (method === "GET" && url.pathname === "/v1/info") {
      return json({
        name: "fake mint",
        version: "cdk-mintd/0.18.2",
        nuts: {
          "4": { methods: [], disabled: false },
          "5": { methods: [], disabled: false },
          "7": { supported: true },
          "9": { supported: true },
          "12": { supported: true },
          CTF: { supported: true, condition_keyset_filter: true },
        },
      });
    }
    if (method === "GET" && url.pathname === "/v1/keysets") {
      const { keys: _keys, ...listed } = keysResponse(this.regular);
      return json({ keysets: [listed] });
    }
    if (method === "GET" && url.pathname === "/v1/keys") {
      return json({ keysets: [keysResponse(this.regular)] });
    }
    if (method === "GET" && url.pathname.startsWith("/v1/keys/")) {
      const keyset = allKeysets.find(({ id }) => id === url.pathname.slice("/v1/keys/".length));
      return keyset === undefined
        ? json({ detail: "unknown keyset", code: 12001 }, 400)
        : json({ keysets: [keysResponse(keyset)] });
    }
    if (method === "GET" && url.pathname === "/v1/conditional_keysets") {
      const conditionId = url.searchParams.get("condition_id");
      const keysets = this.conditional.filter(
        (keyset) => conditionId === null || keyset.conditional!.conditionId === conditionId,
      );
      return json({ keysets: keysets.map(descriptor), next_cursor: null });
    }
    if (method === "POST" && url.pathname === "/v1/restore") {
      const outputs = (parsed().outputs ?? []) as { B_: string }[];
      const matched = outputs.filter(({ B_ }) => this.#signatures.has(B_));
      return json({
        outputs: matched,
        signatures: matched.map(({ B_ }) => this.#signatures.get(B_)),
      });
    }
    if (method === "POST" && url.pathname === "/v1/checkstate" && this.failCheckstate) {
      return json({ detail: "unavailable" }, 503);
    }
    if (method === "POST" && url.pathname === "/v1/checkstate") {
      const Ys = (parsed().Ys ?? []) as string[];
      return json({
        states: Ys.map((Y) => ({ Y, state: this.#states.get(Y) ?? "UNSPENT", witness: null })),
      });
    }
    return json({ detail: "not found" }, 404);
  };
}

function keysResponse(keyset: FakeKeyset) {
  return {
    id: keyset.id,
    unit: keyset.unit,
    active: keyset.active,
    input_fee_ppk: 0,
    keys: keyset.keys,
  };
}

function descriptor(keyset: FakeKeyset) {
  return {
    id: keyset.id,
    unit: keyset.unit,
    active: keyset.active,
    input_fee_ppk: 0,
    condition_id: keyset.conditional!.conditionId,
    outcome_collection: keyset.conditional!.outcomeCollection,
    outcome_collection_id: keyset.conditional!.outcomeCollectionId,
    registered_at: keyset.conditional!.registeredAt,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
import { runBrowserSeedPositionRestorePass } from "@/lib/browserSeedPositionRestore";
import { advanceWalletKeysetCounterPastMint } from "@/lib/cashu";
import { useBrowserCtfRangeOrderRecovery } from "../useBrowserCtfRangeOrderRecovery";

/** Serializes each named lock in memory, as the Web Locks API does in one tab. */
function installLockManager(): void {
  const tails = new Map<string, Promise<unknown>>();
  const locks = {
    request: (name: string, _options: unknown, action: () => Promise<unknown>) => {
      const previous = tails.get(name) ?? Promise.resolve();
      const result = previous.then(action, action);
      tails.set(
        name,
        result.then(
          () => undefined,
          () => undefined,
        ),
      );
      return result;
    },
  };
  Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: locks });
}

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

function scopeId(): string {
  const value = browserWalletScopeIdFromMnemonic(MNEMONIC);
  if (value === null) throw new Error("test wallet scope is invalid");
  return value;
}

interface Holding {
  assetKind: string;
  conditionId: string | null;
  outcomeCollection: string | null;
  keysetId: string;
  amount: number;
}

function byKeysetAndAmount(left: Holding, right: Holding): number {
  return left.keysetId.localeCompare(right.keysetId) || left.amount - right.amount;
}

async function selectableHoldings(database = db): Promise<Holding[]> {
  return (await database.custodyProofs.toArray())
    .filter(({ selectability }) => selectability === "selectable")
    .map(({ assetKind, conditionId, outcomeCollection, keysetId, amount }) => ({
      assetKind,
      conditionId,
      outcomeCollection,
      keysetId,
      amount: Number(amount),
    }))
    .sort(byKeysetAndAmount);
}

function position(keyset: FakeKeyset, amount: number): Holding {
  return {
    assetKind: "conditional",
    conditionId: keyset.conditional!.conditionId,
    outcomeCollection: keyset.conditional!.outcomeCollection,
    keysetId: keyset.id,
    amount,
  };
}

async function associationComplete(keysetId: string): Promise<boolean | undefined> {
  return (await db.walletCounterAssociations.get([scopeId(), MINT_URL, "msat", keysetId]))
    ?.recoveryComplete;
}

async function restoreRow(keysetId: string) {
  return seedRestoreDatabase(scopeId()).keysets.get([scopeId(), MINT_URL, keysetId]);
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

describe("useBrowserCtfRangeOrderRecovery — a new browser opens an existing seed", () => {
  let seedRestore: SeedRestoreDB | null = null;

  beforeEach(() => {
    (useWalletStore.getState() as { mnemonic: string }).mnemonic = MNEMONIC;
    setActiveBrowserWalletProfile(MNEMONIC);
    activateBrowserWalletDatabase(scopeId());
    seedRestore = seedRestoreDatabase(scopeId());
    mocks.walletsByUnit.clear();
    mocks.passCompleted.length = 0;
    useActivityLogStore.setState({ items: [] });
    useToastStore.setState({ toasts: [] });
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
    expect(holdings).toContainEqual({
      assetKind: "regular",
      conditionId: null,
      outcomeCollection: null,
      keysetId: regular.id,
      amount: 8,
    });
    // The positions must come back as well. Only UNSPENT proofs are admitted.
    expect(holdings.filter(({ assetKind }) => assetKind === "conditional")).toEqual(
      [position(held.yes, 1), position(held.yes, 2), position(resolved.no, 4)].sort(
        byKeysetAndAmount,
      ),
    );
    expect((await seedRestore!.states.get([scopeId(), MINT_URL]))?.initialCompletedAtMs).not.toBe(
      null,
    );

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

  it("keeps a keyset with a PENDING proof incomplete and admits the proof when it settles", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "PENDING" });
    mint.sign({ keyset: market.yes, counter: 0, amount: 2, state: "UNSPENT" });
    mint.sign({ keyset: market.yes, counter: 1, amount: 4, state: "PENDING" });
    vi.stubGlobal("fetch", mint.fetch);

    await runStartupPass();

    expect(await selectableHoldings()).toEqual([position(market.yes, 2)]);
    // The counters moved past the signed outputs, but no keyset is complete.
    expect(await associationComplete(regular.id)).toBe(false);
    expect(await associationComplete(market.yes.id)).toBe(false);
    expect((await db.walletCounterCursors.get([scopeId(), market.yes.id]))?.next).toBe(2);
    expect((await restoreRow(market.yes.id))?.state).toBe("pending");

    // The other client's operation failed. The mint returns the proofs to UNSPENT.
    mint.setState(regular, 0, "UNSPENT");
    mint.setState(market.yes, 1, "UNSPENT");
    await seedRestore!.keysets.update([scopeId(), MINT_URL, market.yes.id], {
      nextAttemptAtMs: 0,
    });
    await runStartupPass();

    expect(await selectableHoldings()).toEqual(
      [
        {
          assetKind: "regular",
          conditionId: null,
          outcomeCollection: null,
          keysetId: regular.id,
          amount: 8,
        },
        position(market.yes, 2),
        position(market.yes, 4),
      ].sort(byKeysetAndAmount),
    );
    expect(await associationComplete(regular.id)).toBe(true);
    expect(await associationComplete(market.yes.id)).toBe(true);
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
    useActivityLogStore.setState({
      items: [
        {
          id: "trade:1",
          walletId: browserWalletIdFromMnemonic(MNEMONIC)!,
          type: "Buy",
          amountSubunits: 2,
          baseAsset: "sat",
          date: "2026-11-03T00:00:00.000Z",
          status: "completed",
          txId: null,
          lightningInvoice: null,
          marketId: `${"ab".repeat(32)}-YES`,
        },
      ],
    });

    await runStartupPass();

    expect(await selectableHoldings()).toEqual([position(hinted.yes, 2)]);
    // The accepted release 4 residual: no hint, and the probe window had no signature.
    expect((await restoreRow(unhinted.yes.id))?.state).toBe("no-signature");
  });

  it("probes a keyset with no signature again later", async () => {
    const regular = regularKeyset();
    const market = binaryMarket("ab".repeat(32));
    const mint = new FakeMint(regular, [market.yes, market.no]);
    vi.stubGlobal("fetch", mint.fetch);
    let nowMs = 1_000_000;
    const now = () => nowMs;

    await runBrowserSeedPositionRestorePass({
      scopeId: scopeId(),
      mnemonic: MNEMONIC,
      mintUrl: MINT_URL,
      now,
    });
    expect((await restoreRow(market.no.id))?.state).toBe("no-signature");

    // Another client with this seed bought NO after the first restore.
    mint.sign({ keyset: market.no, counter: 0, amount: 4, state: "UNSPENT" });
    nowMs += 30 * 60_000;
    await runBrowserSeedPositionRestorePass({
      scopeId: scopeId(),
      mnemonic: MNEMONIC,
      mintUrl: MINT_URL,
      now,
    });
    expect(await selectableHoldings()).toEqual([]);

    nowMs += 31 * 60_000;
    await runBrowserSeedPositionRestorePass({
      scopeId: scopeId(),
      mnemonic: MNEMONIC,
      mintUrl: MINT_URL,
      now,
    });
    expect(await selectableHoldings()).toEqual([position(market.no, 4)]);
    expect((await restoreRow(market.no.id))?.state).toBe("restored");
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

  it("re-syncs a keyset in use when another browser signed past the local cursor", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "SPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    // This browser restored the msat keyset earlier, so its cursor is 1.
    await runStartupPass();
    expect(await associationComplete(regular.id)).toBe(true);
    expect((await db.walletCounterCursors.get([scopeId(), regular.id]))?.next).toBe(1);

    // Another browser with the same seed signed counters 1 and 2.
    mint.sign({ keyset: regular, counter: 1, amount: 2, state: "SPENT" });
    mint.sign({ keyset: regular, counter: 2, amount: 4, state: "UNSPENT" });
    await runStartupPass();

    expect((await db.walletCounterCursors.get([scopeId(), regular.id]))?.next).toBe(3);
    expect(await selectableHoldings()).toEqual([
      {
        assetKind: "regular",
        conditionId: null,
        outcomeCollection: null,
        keysetId: regular.id,
        amount: 4,
      },
    ]);
    expect(useToastStore.getState().toasts.map(({ message }) => message)).toContain(
      "This wallet was used in another browser. Use one browser at a time.",
    );
    // A local diagnostic records the finding. Nothing waits for admission.
    expect(await seedRestore!.resync.get([scopeId(), MINT_URL, regular.id])).toMatchObject({
      findings: 1,
      lastHighestCounter: 2,
      pendingFromCounter: null,
    });
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
      keyset: {
        canonicalMintUrl: MINT_URL,
        id: regular.id,
        unit: "msat",
        keys: regular.keys,
        inputFeePpk: 0,
        finalExpiry: null,
        active: true,
      },
    });
    expect((await db.walletCounterCursors.get([scopeId(), regular.id]))?.next).toBe(3);
    expect(await selectableHoldings()).toEqual([]);
    expect(
      (await seedRestore!.resync.get([scopeId(), MINT_URL, regular.id]))?.pendingFromCounter,
    ).toBe(1);

    await runStartupPass();

    expect((await selectableHoldings()).map(({ amount }) => amount)).toEqual([2, 4]);
    expect(
      (await seedRestore!.resync.get([scopeId(), MINT_URL, regular.id]))?.pendingFromCounter,
    ).toBe(null);
  });

  it("advances the cursor and keeps found outputs for a later pass when admission fails", async () => {
    const regular = regularKeyset();
    const mint = new FakeMint(regular, []);
    mint.sign({ keyset: regular, counter: 0, amount: 8, state: "SPENT" });
    vi.stubGlobal("fetch", mint.fetch);
    await runStartupPass();
    mint.sign({ keyset: regular, counter: 1, amount: 4, state: "UNSPENT" });
    mint.failCheckstate = true;

    await runStartupPass();

    // The cursor moved past the signed output, so no local output reuses it.
    expect((await db.walletCounterCursors.get([scopeId(), regular.id]))?.next).toBe(2);
    expect(await selectableHoldings()).toEqual([]);
    expect(
      (await seedRestore!.resync.get([scopeId(), MINT_URL, regular.id]))?.pendingFromCounter,
    ).toBe(1);

    mint.failCheckstate = false;
    await runStartupPass();

    expect((await selectableHoldings()).map(({ amount }) => amount)).toEqual([4]);
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
