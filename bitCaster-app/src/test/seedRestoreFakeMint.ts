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
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { toSeed } from "@/lib/bip39";
import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import { db } from "@/stores/proof-db";

// A fake mint at the HTTP boundary for the seed restore tests (ADR-039,
// amendment 2026-11-04). It signs deterministic NUT-13 outputs of one seed and
// lists conditional keysets only on the NUT-CTF endpoint, as the production
// mint does. Requests to another origin (the engine) answer 404.

export const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
export const SEED = toSeed(MNEMONIC.split(/\s+/));
export const MINT_URL = "https://mint.example";

export interface FakeKeyset {
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

export function regularKeyset(): FakeKeyset {
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

export function conditionalKeyset(input: {
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
export function binaryMarket(conditionId: string, active = true) {
  return {
    yes: conditionalKeyset({ conditionId, outcomeCollection: "YES", active }),
    no: conditionalKeyset({ conditionId, outcomeCollection: "NO", active }),
  };
}

export type ProofState = "UNSPENT" | "PENDING" | "SPENT";

interface SignedOutput {
  readonly keyset: FakeKeyset;
  readonly counter: number;
  readonly amount: number;
  readonly state: ProofState;
}

export interface MintRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
}

/** The blinded message of one NUT-13 counter. It does not depend on the amount. */
export function blindedOutput(keyset: FakeKeyset, counter: number): string {
  return OutputData.createSingleDeterministicData(0, SEED, counter, keyset.id).blindedMessage.B_;
}

const ECHO_REQUESTS_MAX = 60;

export class FakeMint {
  readonly requests: MintRequest[] = [];
  /** A failing NUT-07 check stops each scan before admission. */
  failCheckstate = false;
  /** A failing NUT-09 restore stops every probe and scan. */
  failRestore = false;
  /** A hostile mint reports every queried output as signed. */
  echoRestore = false;
  /** Conditions whose filtered keyset listing fails. */
  readonly failConditionListing = new Set<string>();
  /** The public engine catalogue at the app origin. Null answers 404. */
  catalogue: readonly { conditionId: string; outcomes: readonly string[] }[] | null = null;
  /** The next catalogue reads that fail with 503. */
  catalogueFailures = 0;
  /** The next catalogue reads with a cursor that fail with 503. */
  cursorReadFailures = 0;
  /** A restarted engine issues new cursors and rejects the old ones. */
  catalogueEpoch = 0;
  readonly #signatures = new Map<
    string,
    { id: string; amount: number; C_: string; dleq: { e: string; s: string } }
  >();
  readonly #states = new Map<string, ProofState>();
  #echoes = 0;

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

  /** The blinded messages of each NUT-09 request, in request order. */
  restoredOutputs(): string[][] {
    return this.requestsTo("/v1/restore").map(({ body }) =>
      ((JSON.parse(body) as { outputs: { B_: string }[] }).outputs ?? []).map(({ B_ }) => B_),
    );
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
    if (url.origin !== MINT_URL) return this.#engine(url);
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
      if (conditionId !== null && this.failConditionListing.has(conditionId)) {
        return json({ detail: "unavailable" }, 503);
      }
      const keysets = this.conditional.filter(
        (keyset) => conditionId === null || keyset.conditional!.conditionId === conditionId,
      );
      return json({ keysets: keysets.map(descriptor), next_cursor: null });
    }
    if (method === "POST" && url.pathname === "/v1/restore" && this.failRestore) {
      return json({ detail: "unavailable" }, 503);
    }
    if (method === "POST" && url.pathname === "/v1/restore" && this.echoRestore) {
      // A test bound: an unbounded client scan fails here instead of running forever.
      this.#echoes += 1;
      if (this.#echoes > ECHO_REQUESTS_MAX) return json({ detail: "echo bound" }, 503);
      const outputs = (parsed().outputs ?? []) as { B_: string; id: string }[];
      // Zero-amount signatures with a valid point are enough to echo each output.
      return json({
        outputs,
        signatures: outputs.map(({ id, B_ }) => ({ id, amount: 0, C_: B_ })),
      });
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

  // The app origin serves the public market catalogue. It has no other route here.
  #engine(url: URL): Response {
    if (url.pathname !== "/api/v1/markets/query" || this.catalogue === null) {
      return json({ detail: "not found" }, 404);
    }
    if (this.catalogueFailures > 0) {
      this.catalogueFailures -= 1;
      return json({ detail: "unavailable" }, 503);
    }
    const requested = url.searchParams.get("cursor");
    if (requested !== null && this.cursorReadFailures > 0) {
      this.cursorReadFailures -= 1;
      return json({ detail: "unavailable" }, 503);
    }
    const prefix = `e${this.catalogueEpoch}-page-`;
    if (requested !== null && !requested.startsWith(prefix)) {
      return json({ detail: "invalid or stale cursor" }, 400);
    }
    // One market for each page, newest first, so a walk has several pages.
    const index = requested === null ? 0 : Number(requested.slice(prefix.length));
    const market = this.catalogue[index];
    return json({
      markets: market === undefined ? [] : [{ ...market, outcomes: [...market.outcomes] }],
      nextCursor: index + 1 < this.catalogue.length ? `${prefix}${index + 1}` : null,
      lastSuccessfulRefreshAt: "2026-11-04T00:00:00Z",
    });
  }
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

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The selection keyset of a fake keyset, as an order preparation names it. */
export function activeKeyset(keyset: FakeKeyset) {
  return {
    canonicalMintUrl: MINT_URL,
    id: keyset.id,
    unit: "msat" as const,
    keys: keyset.keys,
    inputFeePpk: 0,
    finalExpiry: null,
    active: true as const,
    ...(keyset.conditional === undefined ? {} : keyset.conditional),
  };
}

/** The condition binding of a conditional fake keyset. */
export function conditionalAsset(keyset: FakeKeyset) {
  return {
    conditionId: keyset.conditional!.conditionId,
    outcomeCollection: keyset.conditional!.outcomeCollection,
  };
}

export function scopeId(): string {
  const value = browserWalletScopeIdFromMnemonic(MNEMONIC);
  if (value === null) throw new Error("test wallet scope is invalid");
  return value;
}

export interface Holding {
  assetKind: string;
  conditionId: string | null;
  outcomeCollection: string | null;
  keysetId: string;
  amount: number;
}

export function byKeysetAndAmount(left: Holding, right: Holding): number {
  return left.keysetId.localeCompare(right.keysetId) || left.amount - right.amount;
}

export async function selectableHoldings(database = db): Promise<Holding[]> {
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

export function position(keyset: FakeKeyset, amount: number): Holding {
  return {
    assetKind: "conditional",
    conditionId: keyset.conditional!.conditionId,
    outcomeCollection: keyset.conditional!.outcomeCollection,
    keysetId: keyset.id,
    amount,
  };
}

export function regularHolding(keyset: FakeKeyset, amount: number): Holding {
  return {
    assetKind: "regular",
    conditionId: null,
    outcomeCollection: null,
    keysetId: keyset.id,
    amount,
  };
}

export async function associationComplete(keysetId: string): Promise<boolean | undefined> {
  return (await db.walletCounterAssociations.get([scopeId(), MINT_URL, "msat", keysetId]))
    ?.recoveryComplete;
}

export async function cursor(keysetId: string): Promise<number | undefined> {
  return (await db.walletCounterCursors.get([scopeId(), keysetId]))?.next;
}

/** Serializes each named lock in memory, as the Web Locks API does in one tab. */
export function installLockManager(): void {
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
