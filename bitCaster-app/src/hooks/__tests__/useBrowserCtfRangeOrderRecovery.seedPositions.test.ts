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
  browserWalletScopeIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "@/lib/browserWalletProfile";
import { activateBrowserWalletDatabase, db, type BitcasterDB } from "@/stores/proof-db";

// A browser that opens an existing recovery phrase must get back the market
// positions that the seed holds at the mint, not only the msat balance. The
// mint and the seed are the only inputs here: no Nostr identity, no engine
// data, and no local operation journal. Network I/O goes to a fake mint.

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SEED = toSeed(MNEMONIC.split(/\s+/));
const MINT_URL = "https://mint.example";

interface FakeKeyset {
  readonly id: string;
  readonly active: boolean;
  readonly keys: Record<string, string>;
  readonly privateKeys: ReadonlyMap<number, Uint8Array>;
  readonly conditional?: {
    readonly conditionId: string;
    readonly outcomeCollection: string;
    readonly outcomeCollectionId: string;
    readonly registeredAt: number;
  };
}

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
    keys,
    privateKeys,
  };
}

function conditionalKeyset(input: {
  salt: number;
  conditionId: string;
  outcomeCollection: string;
  active: boolean;
}): FakeKeyset {
  const privateKeys = privateKeysFor(input.salt);
  const keys = publicKeys(privateKeys);
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId: input.conditionId,
    outcomeCollection: input.outcomeCollection,
  });
  return {
    id: deriveConditionalKeysetId({
      keys,
      unit: "msat",
      conditionId: input.conditionId,
      outcomeCollectionId,
    }),
    active: input.active,
    keys,
    privateKeys,
    conditional: {
      conditionId: input.conditionId,
      outcomeCollection: input.outcomeCollection,
      outcomeCollectionId,
      registeredAt: 1_700_000_000 + input.salt,
    },
  };
}

type ProofState = "UNSPENT" | "SPENT";

interface SignedOutput {
  readonly keyset: FakeKeyset;
  readonly counter: number;
  readonly amount: number;
  readonly state: ProofState;
}

/**
 * A fake mint at the HTTP boundary. It returns NUT-09 signatures only for the
 * deterministic outputs that it signed for this seed, and lists conditional
 * keysets only on the NUT-CTF endpoint, as the production mint does.
 */
function createFakeMint(input: {
  readonly regular: FakeKeyset;
  readonly conditional: readonly FakeKeyset[];
  readonly signed: readonly SignedOutput[];
}) {
  const allKeysets = [input.regular, ...input.conditional];
  const signaturesByBlindedSecret = new Map<
    string,
    { id: string; amount: number; C_: string; dleq: { e: string; s: string } }
  >();
  const stateByY = new Map<string, ProofState>();
  for (const output of input.signed) {
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
    signaturesByBlindedSecret.set(data.blindedMessage.B_, {
      id: output.keyset.id,
      amount: output.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    });
    stateByY.set(hashToCurve(data.secret).toHex(true), output.state);
  }

  const keysResponse = (keyset: FakeKeyset) => ({
    id: keyset.id,
    unit: "msat",
    active: keyset.active,
    input_fee_ppk: 0,
    keys: keyset.keys,
  });
  const descriptor = (keyset: FakeKeyset) => ({
    id: keyset.id,
    unit: "msat",
    active: keyset.active,
    input_fee_ppk: 0,
    condition_id: keyset.conditional!.conditionId,
    outcome_collection: keyset.conditional!.outcomeCollection,
    outcome_collection_id: keyset.conditional!.outcomeCollectionId,
    registered_at: keyset.conditional!.registeredAt,
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  return async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
    );
    if (url.origin !== MINT_URL) return json({ detail: "not found" }, 404);
    const method = (
      init?.method ?? (request instanceof Request ? request.method : "GET")
    ).toUpperCase();
    const body = () => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
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
      const { keys: _keys, ...listed } = keysResponse(input.regular);
      return json({ keysets: [listed] });
    }
    if (method === "GET" && url.pathname === "/v1/keys") {
      return json({ keysets: [keysResponse(input.regular)] });
    }
    if (method === "GET" && url.pathname.startsWith("/v1/keys/")) {
      const keyset = allKeysets.find(({ id }) => id === url.pathname.slice("/v1/keys/".length));
      return keyset === undefined
        ? json({ detail: "unknown keyset", code: 12001 }, 400)
        : json({ keysets: [keysResponse(keyset)] });
    }
    if (method === "GET" && url.pathname === "/v1/conditional_keysets") {
      const conditionId = url.searchParams.get("condition_id");
      const active = url.searchParams.get("active");
      const keysets = input.conditional.filter(
        (keyset) =>
          (conditionId === null || keyset.conditional!.conditionId === conditionId) &&
          (active === null || String(keyset.active) === active),
      );
      return json({ keysets: keysets.map(descriptor), next_cursor: null });
    }
    if (method === "POST" && url.pathname === "/v1/restore") {
      const outputs = (body().outputs ?? []) as { B_: string }[];
      const matched = outputs.filter(({ B_ }) => signaturesByBlindedSecret.has(B_));
      return json({
        outputs: matched,
        signatures: matched.map(({ B_ }) => signaturesByBlindedSecret.get(B_)),
      });
    }
    if (method === "POST" && url.pathname === "/v1/checkstate") {
      const Ys = (body().Ys ?? []) as string[];
      return json({
        states: Ys.map((Y) => ({ Y, state: stateByY.get(Y) ?? "UNSPENT", witness: null })),
      });
    }
    return json({ detail: "not found" }, 404);
  };
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

function byKeysetAndAmount(
  left: { keysetId: string; amount: number },
  right: { keysetId: string; amount: number },
): number {
  return left.keysetId.localeCompare(right.keysetId) || left.amount - right.amount;
}

/** Resolves when the hook finishes its next recovery pass. The timeout only detects a hang. */
function nextPassCompleted(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("recovery pass did not complete")), 20_000);
    mocks.passCompleted.push(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe("useBrowserCtfRangeOrderRecovery — a new browser opens an existing seed", () => {
  let database: BitcasterDB | null = null;
  let unmount: (() => void) | undefined;

  beforeEach(() => {
    const scopeId = browserWalletScopeIdFromMnemonic(MNEMONIC);
    if (scopeId === null) throw new Error("test wallet scope is invalid");
    (useWalletStore.getState() as { mnemonic: string }).mnemonic = MNEMONIC;
    setActiveBrowserWalletProfile(MNEMONIC);
    activateBrowserWalletDatabase(scopeId);
    database = db;
    mocks.walletsByUnit.clear();
    mocks.passCompleted.length = 0;
    installLockManager();
  });

  afterEach(async () => {
    unmount?.();
    unmount = undefined;
    vi.unstubAllGlobals();
    const active = database;
    database = null;
    if (active !== null) for (const table of active.tables) await table.clear();
  });

  it("restores held and resolved-market positions with only the seed and the mint", async () => {
    const regular = regularKeyset();
    const heldCondition = "ab".repeat(32);
    const resolvedCondition = "cd".repeat(32);
    const untouchedCondition = "ef".repeat(32);
    const held = conditionalKeyset({
      salt: 2,
      conditionId: heldCondition,
      outcomeCollection: "YES",
      active: true,
    });
    const resolved = conditionalKeyset({
      salt: 3,
      conditionId: resolvedCondition,
      outcomeCollection: "NO",
      active: false,
    });
    const untouched = conditionalKeyset({
      salt: 4,
      conditionId: untouchedCondition,
      outcomeCollection: "YES",
      active: true,
    });
    vi.stubGlobal(
      "fetch",
      createFakeMint({
        regular,
        conditional: [held, resolved, untouched],
        signed: [
          { keyset: regular, counter: 0, amount: 8, state: "UNSPENT" },
          { keyset: held, counter: 0, amount: 2, state: "UNSPENT" },
          { keyset: held, counter: 1, amount: 4, state: "SPENT" },
          { keyset: held, counter: 2, amount: 1, state: "UNSPENT" },
          { keyset: resolved, counter: 0, amount: 4, state: "UNSPENT" },
        ],
      }),
    );

    const firstPass = nextPassCompleted();
    ({ unmount } = renderHook(() =>
      useBrowserCtfRangeOrderRecovery({
        nostrSignerReady: true,
        walletMnemonic: MNEMONIC,
        walletMintUrls: MINT_URL,
      }),
    ));
    await firstPass;

    const custody = (await database!.custodyProofs.toArray()).filter(
      ({ selectability }) => selectability === "selectable",
    );
    const holdings = custody
      .map(({ assetKind, conditionId, outcomeCollection, keysetId, amount }) => ({
        assetKind,
        conditionId,
        outcomeCollection,
        keysetId,
        amount: Number(amount),
      }))
      .sort(byKeysetAndAmount);

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
      [
        {
          assetKind: "conditional",
          conditionId: heldCondition,
          outcomeCollection: "YES",
          keysetId: held.id,
          amount: 1,
        },
        {
          assetKind: "conditional",
          conditionId: heldCondition,
          outcomeCollection: "YES",
          keysetId: held.id,
          amount: 2,
        },
        {
          assetKind: "conditional",
          conditionId: resolvedCondition,
          outcomeCollection: "NO",
          keysetId: resolved.id,
          amount: 4,
        },
      ].sort(byKeysetAndAmount),
    );
  });
});
