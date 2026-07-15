import { beforeEach, describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/curves/utils.js";
import { Amount } from "@cashu/cashu-ts";
import {
  addDurableWalletProofTransitionMetadata,
  createDurableWalletProofTransition,
} from "@bitcaster/client-sdk/durableWalletProofTransition";
import type { ActiveSwap } from "../activeSwaps";

const rows = new Map<string, Record<string, unknown>>();
const proofOperations = new Map<string, Record<string, unknown>>();
const custodyOperations = new Map<string, Record<string, unknown>>();
const nativeProofs = new Map<string, Record<string, unknown>>();
let storageOpenError: Error | null = null;
const KEYSET_ID = `00${"22".repeat(7)}`;
const PUBLIC_KEY = `02${"33".repeat(32)}`;
const VALID_SECP_POINT =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const EPHEMERAL_PUBKEY = bytesToHex(
  secp256k1.getPublicKey(new Uint8Array(32).fill(1), true),
);
const COUNTERPARTY_PUBKEY = bytesToHex(
  secp256k1.getPublicKey(new Uint8Array(32).fill(2), true),
);
const WALLET_ID = "aa".repeat(32);
const CUSTODY_SCOPE = {
  scopeKind: "wallet" as const,
  walletId: WALLET_ID,
  scopeId: `custody:wallet:${WALLET_ID}`,
};

function cloneSwapSessionRow(
  row: { adapterState?: ActiveSwap } & Record<string, unknown>,
): Record<string, unknown> {
  const clone = structuredClone(row) as Record<string, unknown> & {
    adapterState?: ActiveSwap;
  };
  const adaptorPoint = row.adapterState?.sellerState?.adaptorPoint;
  if (adaptorPoint && clone.adapterState?.sellerState) {
    clone.adapterState.sellerState.adaptorPoint = {
      secret: Uint8Array.from(adaptorPoint.secret),
      point: Uint8Array.from(adaptorPoint.point),
    };
  }
  return clone;
}

interface MockGuiCustodyUnitOfWork {
  plan: { result: unknown };
  snapshot: { session?: unknown };
  nextOperation?: { operationId: string };
  deleteProofs?: Array<{ secret: string }>;
  nextProofs?: Array<{ secret: string }>;
  nextSession?: { tradeId: string; active: number };
  activeSessionLimit?: number;
}

async function commitMockGuiCustodyUnitOfWork(
  input: MockGuiCustodyUnitOfWork,
): Promise<unknown> {
  if (
    input.activeSessionLimit !== undefined &&
    input.snapshot.session === undefined &&
    input.nextSession?.active === 1 &&
    [...rows.values()].filter((row) => row.active !== 0).length >=
      input.activeSessionLimit
  ) {
    throw new Error("Durable swap session capacity is exhausted");
  }
  if (input.nextOperation) {
    proofOperations.set(
      input.nextOperation.operationId,
      structuredClone(input.nextOperation) as Record<string, unknown>,
    );
  }
  for (const proof of input.deleteProofs ?? []) {
    nativeProofs.delete(proof.secret);
  }
  for (const proof of input.nextProofs ?? []) {
    nativeProofs.set(
      proof.secret,
      structuredClone(proof) as Record<string, unknown>,
    );
  }
  if (input.nextSession) {
    rows.set(
      input.nextSession.tradeId,
      cloneSwapSessionRow(
        input.nextSession as { adapterState?: ActiveSwap } & Record<
          string,
          unknown
        >,
      ),
    );
  }
  return input.plan.result;
}

vi.mock("../gui-custody-authority", () => {
  const transaction = () => ({
    getOperation: (operationId: string) =>
      structuredClone(custodyOperations.get(operationId) ?? null),
    putOperation: (record: Record<string, unknown>) => {
      const operationId = (record.operation as { operationId: string })
        .operationId;
      custodyOperations.set(operationId, structuredClone(record));
    },
    getSessionLink: () => null,
    putSessionLink: () => undefined,
    reserveExactInputs: () => undefined,
    transitionOperation: ({
      operationId,
      transition,
    }: {
      operationId: string;
      transition: { kind: string };
    }) => {
      const record = structuredClone(custodyOperations.get(operationId)!);
      const operation = record.operation as Record<string, unknown>;
      if (transition.kind === "transport-attempted") {
        operation.state = "transport-attempted";
      }
      custodyOperations.set(operationId, record);
    },
    stageVerifiedResult: ({
      operationId,
      ...result
    }: Record<string, string>) => {
      const record = structuredClone(custodyOperations.get(operationId)!);
      const operation = record.operation as Record<string, unknown>;
      operation.result = { state: "verified-staged", ...result };
      custodyOperations.set(operationId, record);
    },
    applyVerifiedResult: ({ operationId }: { operationId: string }) => {
      const record = structuredClone(custodyOperations.get(operationId)!);
      const operation = record.operation as Record<string, unknown>;
      operation.state = "reconciled";
      operation.result = {
        ...(operation.result as Record<string, unknown>),
        state: "applied",
      };
      custodyOperations.set(operationId, record);
    },
    putDelivery: () => undefined,
    rebuildActiveWorkIndex: () => undefined,
    getScopeState: () => ({}),
    putScopeState: () => undefined,
  });
  const store = {
    prepareTransaction: async (
      _input: unknown,
      apply: (value: ReturnType<typeof transaction>) => unknown,
    ) => {
      const value = transaction();
      return { result: apply(value), transaction: value, snapshot: {} };
    },
  };
  return {
    currentGuiWalletContext: () => ({
      walletId: WALLET_ID,
      scope: CUSTODY_SCOPE,
    }),
    guiWalletContextFromHeldLock: () => ({
      walletId: WALLET_ID,
      scope: CUSTODY_SCOPE,
    }),
    acquireGuiCustodyAuthority: async () => ({
      scope: CUSTODY_SCOPE,
      owner: { incarnationId: "tab-001", fencingEpoch: 1, observedAtMs: 1 },
      store,
    }),
    releaseGuiCustodyAuthority: async () => undefined,
    resolveGuiCustodyMintKeys: async (_mintUrl: string, keysetIds: string[]) =>
      new Map(
        keysetIds.map((id) => [
          id,
          { id, unit: "sat", keys: { "1": PUBLIC_KEY } },
        ]),
      ),
    withGuiCustodyProfileLock: async (
      action: (
        context: { walletId: string; scope: typeof CUSTODY_SCOPE },
        lock: unknown,
      ) => Promise<unknown>,
    ) => {
      if (!navigator.locks) {
        throw new Error("Browser custody locking is unavailable");
      }
      return navigator.locks.request(
        `bitcaster-custody:${WALLET_ID}`,
        { mode: "exclusive" },
        () => action({ walletId: WALLET_ID, scope: CUSTODY_SCOPE }, {}),
      );
    },
    withGuiCustodyProfileLockForWallet: async (
      expectedWalletId: string,
      action: (
        context: { walletId: string; scope: typeof CUSTODY_SCOPE },
        lock: unknown,
      ) => Promise<unknown>,
    ) => {
      if (expectedWalletId !== WALLET_ID) {
        throw new Error("GUI wallet changed while awaiting custody ownership");
      }
      if (!navigator.locks) {
        throw new Error("Browser custody locking is unavailable");
      }
      return navigator.locks.request(
        `bitcaster-custody:${WALLET_ID}`,
        { mode: "exclusive" },
        () => action({ walletId: WALLET_ID, scope: CUSTODY_SCOPE }, {}),
      );
    },
  };
});

vi.mock("../gui-wallet-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gui-wallet-lock")>();
  return {
    ...actual,
    walletIdFromHeldGuiWalletLock: () => WALLET_ID,
  };
});

vi.mock("../gui-custody-unit-of-work", () => ({
  readGuiCustodyNativeSnapshot: async (
    operationId: string | null,
    tradeId: string,
    walletId: string,
    _database: unknown,
    locatedProofs: Array<{ secret: string }> = [],
  ) => {
    const proofSecrets = locatedProofs.map(({ secret }) => secret);
    return {
      walletId,
      operationId,
      operation:
        operationId === null ? undefined : proofOperations.get(operationId),
      proofSecrets,
      proofs: proofSecrets.flatMap((secret) => {
        const proof = nativeProofs.get(secret);
        return proof === undefined ? [] : [proof];
      }),
      tradeId,
      session: rows.get(tradeId),
    };
  },
  readGuiCustodyOperationSnapshot: async (
    operationId: string,
    walletId: string,
    additionalProofs: Array<{ secret: string }> = [],
    tradeId: string | null = null,
  ) => {
    const operation = proofOperations.get(operationId) as
      | { inputs?: Array<{ secret: string }> }
      | undefined;
    const proofSecrets = [
      ...(operation?.inputs?.map(({ secret }) => secret) ?? []),
      ...additionalProofs.map(({ secret }) => secret),
    ];
    return {
      walletId,
      operationId,
      operation,
      proofSecrets,
      proofs: proofSecrets.flatMap((secret) => {
        const proof = nativeProofs.get(secret);
        return proof === undefined ? [] : [proof];
      }),
      tradeId,
      session: tradeId === null ? undefined : rows.get(tradeId),
    };
  },
  prepareGuiCustodyUnitOfWork: async (input: MockGuiCustodyUnitOfWork) => input,
  commitGuiCustodyUnitOfWork: commitMockGuiCustodyUnitOfWork,
}));

vi.mock("../gui-durable-storage-custody-unit-of-work", () => ({
  commitGuiDurableStorageCustodyUnitOfWork: async (input: {
    prepared: MockGuiCustodyUnitOfWork;
  }) => commitMockGuiCustodyUnitOfWork(input.prepared),
}));

vi.mock("../proof-db", () => ({
  currentGuiWalletId: () => WALLET_ID,
  locateStoredProofs: (
    proofs: Array<Record<string, unknown>>,
    mintUrl: string,
    unit: string,
  ) => proofs.map((proof) => ({ ...proof, mintUrl, unit })),
  normalizeStoredProofForStorage: (
    proof: Record<string, unknown>,
    walletId = WALLET_ID,
  ) => ({ ...proof, walletId }),
  prepareStoredProofForWrite: (
    proof: Record<string, unknown>,
    now = Date.now(),
    walletId = WALLET_ID,
  ) => ({ ...proof, walletId, receivedAt: now }),
  requireProofOperationRecord: (
    row: Record<string, unknown>,
    walletId: string,
    operationId: string,
  ) => {
    if (row.walletId !== walletId || row.operationId !== operationId) {
      throw new Error("Proof operation belongs to another wallet scope");
    }
    return structuredClone(row);
  },
  ensureDurableSwapStorage: async () => {
    if (storageOpenError) {
      throw new Error(
        `Durable swap storage is unavailable: ${storageOpenError.message}`,
      );
    }
  },
  db: {
    open: async () => {
      if (storageOpenError) throw storageOpenError;
    },
    transaction: async (...args: unknown[]) => {
      return (args.at(-1) as () => Promise<unknown>)();
    },
    swapSessions: {
      get: async (tradeId: string) => rows.get(tradeId),
      put: async (row: { tradeId: string }) => {
        rows.set(row.tradeId, row as Record<string, unknown>);
      },
      toArray: async () => Array.from(rows.values()),
      where: () => ({
        equals: (value: number | [string, number]) => ({
          limit: (limit: number) => ({
            toArray: async () => {
              const [walletId, active] = Array.isArray(value)
                ? value
                : [WALLET_ID, value];
              return [...rows.values()]
                .filter(
                  (row) => row.walletId === walletId && row.active === active,
                )
                .slice(0, limit);
            },
          }),
        }),
      }),
      delete: async (tradeId: string) => {
        rows.delete(tradeId);
      },
    },
    proofOperations: {
      get: async (operationId: string) => proofOperations.get(operationId),
      where: (field: string) => ({
        equals: (value: string | [string, string]) => {
          const matches = (operation: Record<string, unknown>) => {
            if (field === "[walletId+durableOperationId]") {
              return (
                Array.isArray(value) &&
                operation.walletId === value[0] &&
                operation.durableOperationId === value[1]
              );
            }
            if (field === "[walletId+durableTradeId]") {
              return (
                Array.isArray(value) &&
                operation.walletId === value[0] &&
                operation.durableTradeId === value[1]
              );
            }
            return operation[field] === value;
          };
          return {
            first: async () =>
              Array.from(proofOperations.values()).find(matches),
            toArray: async () =>
              Array.from(proofOperations.values()).filter(matches),
          };
        },
      }),
      put: async (row: { operationId: string }) => {
        proofOperations.set(row.operationId, row as Record<string, unknown>);
      },
      toArray: async () => Array.from(proofOperations.values()),
    },
  },
}));

import {
  MAX_ACTIVE_GUI_SWAP_SESSIONS,
  loadRecoverableGuiSwapSessions,
  prepareGuiProofOperationWithSessionUnderLock,
  resolveGuiProofOperationPreparation,
  completeGuiProofOperationWithSessionUnderLock,
  recoverGuiDurableTradeSession as recoverGuiDurableTradeSessionUnlocked,
  recordGuiRecoveredProofOperationOutputsUnderLock,
  persistGuiSwapSessionUnderLock,
  withGuiSwapSessionOwnership,
  type GuiDurableTradeRecoveryInput,
} from "../swap-session-db";

function swap(overrides: Partial<ActiveSwap> = {}): ActiveSwap {
  const ephemeralPrivkeyHex = "01".repeat(32);
  return {
    tradeId: "trade-001",
    orderId: "order-001",
    marketId: "condition-YES",
    ephemeralPrivkeyHex,
    ephemeralPubkeyHex: EPHEMERAL_PUBKEY,
    role: "seller",
    counterpartyPubkey: COUNTERPARTY_PUBKEY,
    sellerLocktime: 120,
    buyerLocktime: 100,
    outcomeFaceAmountSats: null,
    outcomeFaceAmountSubunits: null,
    quotePaymentSats: null,
    baseAsset: "sat",
    divisibility: 10_000,
    quotePaymentSubunits: null,
    settlementKind: "DirectSwap",
    sellerKeepOutcomeSetId: null,
    sellerLockOutcomeSetId: null,
    step: "awaiting-counterparty",
    messages: {},
    sellerState: null,
    buyerPreparation: null,
    buyerState: null,
    settlementCompleteDelivery: "not-ready",
    inFlightSteps: {},
    error: null,
    startedAt: 1,
    ...overrides,
    mintUrl:
      overrides.mintUrl === undefined
        ? "https://mint.example"
        : overrides.mintUrl,
  };
}

function persistedAdaptorPoint() {
  const secret = new Uint8Array(32).fill(1);
  return { secret, point: secp256k1.getPublicKey(secret, true) };
}

function lockedSatTags(): string[][] {
  return [
    ["locktime", "100"],
    ["pubkeys", COUNTERPARTY_PUBKEY],
    ["n_sigs", "2"],
    ["refund", EPHEMERAL_PUBKEY],
  ];
}

function lockedSatSecret(
  tags: string[][] = lockedSatTags(),
  bodyOverrides: Record<string, unknown> = {},
  kind = "P2PK",
): string {
  return JSON.stringify([
    kind,
    {
      nonce: "55".repeat(32),
      data: EPHEMERAL_PUBKEY,
      tags,
      ...bodyOverrides,
    },
  ]);
}

function lockedSatProof(overrides: Record<string, unknown> = {}) {
  return {
    id: KEYSET_ID,
    amount: Amount.from(1),
    secret: lockedSatSecret(),
    C: VALID_SECP_POINT,
    ...overrides,
  };
}

function replaceLockedSatTag(key: string, ...values: string[]): string[][] {
  return lockedSatTags().map((tag) =>
    tag[0] === key ? [key, ...values] : tag,
  );
}

function buyerState(
  proof: Record<string, unknown>,
): NonNullable<ActiveSwap["buyerState"]> {
  return {
    ownPreSigsHex: [],
    lockedSatProofs: [proof as never],
    lockedProofsCipher: "locked-proof-cipher",
    sellerPreSigsHex: [],
  };
}

function operationSwap(): ActiveSwap {
  return swap({
    sellerState: { adaptorPoint: persistedAdaptorPoint() },
  });
}

async function persistGuiSwapSession(
  active: ActiveSwap,
  mintUrl: string,
): Promise<void> {
  await withGuiSwapSessionOwnership(active.tradeId, (lock) =>
    persistGuiSwapSessionUnderLock(lock, active, mintUrl),
  );
}

async function prepareGuiProofOperationWithSession(
  input: ReturnType<typeof proofOperationInput>,
  active: ActiveSwap,
) {
  const resolved = await resolveGuiProofOperationPreparation(input, active);
  return withGuiSwapSessionOwnership(active.tradeId, (lock) =>
    prepareGuiProofOperationWithSessionUnderLock(lock, input, active, resolved),
  );
}

async function completeGuiProofOperationWithSession(
  operationId: string,
  resultProofs: ReturnType<typeof proofOperationResult>,
  active: ActiveSwap,
  mintUrl: string,
) {
  return withGuiSwapSessionOwnership(active.tradeId, (lock) =>
    completeGuiProofOperationWithSessionUnderLock(
      lock,
      operationId,
      resultProofs,
      active,
      mintUrl,
    ),
  );
}

async function recoverGuiDurableTradeSession(
  tradeId: string,
  input: GuiDurableTradeRecoveryInput,
) {
  return recoverGuiDurableTradeSessionUnlocked(tradeId, input, WALLET_ID);
}

async function recordGuiRecoveredProofOperationOutputs(
  tradeId: string,
  durableOperationId: string,
  resultProofs: ReturnType<typeof proofOperationResult>,
): Promise<void> {
  return withGuiSwapSessionOwnership(tradeId, (lock) =>
    recordGuiRecoveredProofOperationOutputsUnderLock(
      lock,
      tradeId,
      durableOperationId,
      resultProofs,
    ),
  );
}

function proofOperationInput(operationId: string) {
  return {
    operationId,
    kind: "swap-lock" as const,
    mintUrl: "https://mint.example",
    inputs: [
      {
        id: KEYSET_ID,
        amount: 1 as never,
        secret: "11".repeat(32),
        C: PUBLIC_KEY,
      },
    ],
    outputs: {
      send: [],
      keep: [
        {
          blindedMessage: {
            amount: 1,
            id: KEYSET_ID,
            B_: PUBLIC_KEY,
          },
          blindingFactor: "44".repeat(32),
          secret: "55".repeat(32),
        },
      ],
    },
    metadata: addDurableWalletProofTransitionMetadata(
      { unit: "sat" },
      createDurableWalletProofTransition({
        inputSource: "wallet",
        plannedOutputLabels: ["send", "keep"],
        resultGroups: {
          send: { kind: "operation" },
          keep: { kind: "wallet", asset: "regular", reservedBy: null },
        },
      }),
    ),
  };
}

function proofOperationResult() {
  return {
    send: [],
    keep: [
      {
        id: KEYSET_ID,
        amount: Amount.from(1),
        secret: "55".repeat(32),
        C: PUBLIC_KEY,
      },
    ],
  };
}

beforeEach(() => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async <T>(
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ) => callback(),
    },
  });
  rows.clear();
  proofOperations.clear();
  custodyOperations.clear();
  nativeProofs.clear();
  const input = proofOperationInput("seed");
  nativeProofs.set(input.inputs[0]!.secret, {
    ...input.inputs[0],
    walletId: WALLET_ID,
    mintUrl: input.mintUrl,
    unit: "sat",
  });
  storageOpenError = null;
});

async function withWebLocks<T>(action: () => Promise<T>): Promise<T> {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ) => callback(),
    },
  });
  try {
    return await action();
  } finally {
    if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
    else
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: undefined,
      });
  }
}

describe("GUI durable swap session repository", () => {
  it("persists and hydrates a protocol-bound GUI session", async () => {
    const active = swap();
    await persistGuiSwapSession(active, "https://mint.example");

    await expect(loadRecoverableGuiSwapSessions()).resolves.toEqual([active]);
  });

  it("retains an engine-terminal session for exact refund recovery", async () => {
    const retained = swap({
      step: "awaiting-refund",
      error: "Settlement ended before both parties confirmed.",
    });
    await persistGuiSwapSession(retained, "https://mint.example");

    await expect(loadRecoverableGuiSwapSessions()).resolves.toEqual([retained]);
  });

  it("serializes repeated writes through a monotonic session revision", async () => {
    await persistGuiSwapSession(swap(), "https://mint.example");
    await persistGuiSwapSession(
      swap({ step: "driving" }),
      "https://mint.example",
    );

    const row = rows.get("trade-001") as { session: { revision: number } };
    expect(row.session.revision).toBe(1);
  });

  it("never rewrites a completed durable session as failed", async () => {
    await persistGuiSwapSession(
      swap({
        step: "completed",
        settlementCompleteDelivery: "delivered",
      }),
      "https://mint.example",
    );

    await expect(
      persistGuiSwapSession(
        swap({
          step: "Failed",
          settlementCompleteDelivery: "delivered",
        }),
        "https://mint.example",
      ),
    ).rejects.toThrow(/regress durable swap state/);
  });

  it("rejects a stale write that would erase durable seller material", async () => {
    await persistGuiSwapSession(
      swap({
        sellerState: {
          adaptorPoint: persistedAdaptorPoint(),
          adaptorPointCipher: "adaptor-cipher",
          lockedProofsCipher: "seller-cipher",
        },
      }),
      "https://mint.example",
    );
    const before = JSON.stringify(rows.get("trade-001"));

    await expect(
      persistGuiSwapSession(swap(), "https://mint.example"),
    ).rejects.toThrow(/durable swap state/);
    expect(JSON.stringify(rows.get("trade-001"))).toBe(before);
  });

  it.each([
    ["role", { role: "buyer" as const }],
    ["protocol key", { ephemeralPrivkeyHex: "02".repeat(32) }],
    ["counterparty", { counterpartyPubkey: `02${"c".repeat(64)}` }],
    ["seller locktime", { sellerLocktime: 121 }],
    ["buyer locktime", { buyerLocktime: 99 }],
    ["market", { marketId: "other-condition-NO" }],
  ])(
    "rejects a write that changes its immutable %s binding",
    async (_name, mutation) => {
      await persistGuiSwapSession(swap(), "https://mint.example");

      await expect(
        persistGuiSwapSession(swap(mutation), "https://mint.example"),
      ).rejects.toThrow(/immutable durable swap binding/);
    },
  );

  it("pins a settlement amount after its first durable value", async () => {
    await persistGuiSwapSession(
      swap({ quotePaymentSats: 1 }),
      "https://mint.example",
    );

    await expect(
      persistGuiSwapSession(
        swap({ quotePaymentSats: 2 }),
        "https://mint.example",
      ),
    ).rejects.toThrow(/immutable durable swap binding/);
  });

  it("rejects an existing malformed row instead of overwriting it", async () => {
    rows.set("trade-001", {
      walletId: WALLET_ID,
      tradeId: "trade-001",
      active: 7,
      session: {},
      adapterState: swap(),
      updatedAt: 1,
    });

    await expect(
      persistGuiSwapSession(swap(), "https://mint.example"),
    ).rejects.toThrow(/existing durable swap row is invalid/);
  });

  it("accepts an exact durable buyer locked-proof artifact", async () => {
    await expect(
      persistGuiSwapSession(
        swap({
          role: "buyer",
          buyerState: buyerState(lockedSatProof()),
        }),
        "https://mint.example",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects malformed durable buyer locked-proof artifacts", async () => {
    const mutations = [
      lockedSatProof({ extra: true }),
      lockedSatProof({ amount: 0 }),
      lockedSatProof({ id: `02${"22".repeat(7)}` }),
      lockedSatProof({ C: `02${"ff".repeat(32)}` }),
      lockedSatProof({ p2pk_e: `02${"ff".repeat(32)}` }),
      lockedSatProof({
        dleq: { e: "11".repeat(32), s: "not-hex" },
      }),
      lockedSatProof({ witness: JSON.stringify({ signatures: ["short"] }) }),
    ];

    for (const [index, proof] of mutations.entries()) {
      await expect(
        persistGuiSwapSession(
          swap({
            tradeId: `trade-malformed-${index}`,
            role: "buyer",
            buyerState: buyerState(proof),
          }),
          "https://mint.example",
        ),
      ).rejects.toThrow(/durable swap adapter state is invalid/);
    }
  });

  it("rejects buyer proofs that conflict with the exact swap lock", async () => {
    const mutations = [
      lockedSatProof({
        secret: lockedSatSecret(lockedSatTags(), {}, "HTLC"),
      }),
      lockedSatProof({
        secret: lockedSatSecret(
          replaceLockedSatTag("pubkeys", EPHEMERAL_PUBKEY),
          { data: COUNTERPARTY_PUBKEY },
        ),
      }),
      lockedSatProof({
        secret: lockedSatSecret(replaceLockedSatTag("n_sigs", "1")),
      }),
      lockedSatProof({
        secret: lockedSatSecret(replaceLockedSatTag("locktime", "99")),
      }),
      lockedSatProof({
        secret: lockedSatSecret(
          replaceLockedSatTag("refund", COUNTERPARTY_PUBKEY),
        ),
      }),
      lockedSatProof({
        secret: lockedSatSecret([...lockedSatTags(), ["sigflag", "SIG_ALL"]]),
      }),
      lockedSatProof({
        secret: lockedSatSecret([...lockedSatTags(), ["custom", "value"]]),
      }),
      lockedSatProof({
        witness: JSON.stringify({ signatures: ["44".repeat(64)] }),
      }),
      lockedSatProof({ p2pk_e: VALID_SECP_POINT }),
    ];

    for (const [index, proof] of mutations.entries()) {
      await expect(
        persistGuiSwapSession(
          swap({
            tradeId: `trade-lock-conflict-${index}`,
            role: "buyer",
            buyerState: buyerState(proof),
          }),
          "https://mint.example",
        ),
      ).rejects.toThrow(/durable swap adapter state is invalid/);
    }
  });

  it("rejects empty or seller-owned buyer locked-proof state", async () => {
    const emptyBuyerState = {
      ...buyerState(lockedSatProof()),
      lockedSatProofs: [],
    };
    await expect(
      persistGuiSwapSession(
        swap({ role: "buyer", buyerState: emptyBuyerState }),
        "https://mint.example",
      ),
    ).rejects.toThrow(/durable swap adapter state is invalid/);
    await expect(
      persistGuiSwapSession(
        swap({ buyerState: buyerState(lockedSatProof()) }),
        "https://mint.example",
      ),
    ).rejects.toThrow(/durable swap adapter state is invalid/);
  });

  it("rejects a row whose physical trade key disagrees with its persisted payload", async () => {
    await persistGuiSwapSession(swap(), "https://mint.example");
    const row = rows.get("trade-001") as { tradeId: string };
    row.tradeId = "trade-physical-mismatch";

    await expect(loadRecoverableGuiSwapSessions()).rejects.toThrow(
      /active durable swap row is invalid/,
    );
  });

  it.each([" SAT ", "btc"])(
    "rejects noncanonical or unknown durable swap base asset %s",
    async (baseAsset) => {
      await persistGuiSwapSession(swap(), "https://mint.example");
      const row = rows.get("trade-001") as { adapterState: ActiveSwap };
      row.adapterState = { ...row.adapterState, baseAsset };

      await expect(loadRecoverableGuiSwapSessions()).rejects.toThrow(
        /active durable swap row is invalid/,
      );
    },
  );

  it.each([0, -1])(
    "rejects nonpositive durable swap divisibility %s",
    async (divisibility) => {
      await persistGuiSwapSession(swap(), "https://mint.example");
      const row = rows.get("trade-001") as { adapterState: ActiveSwap };
      row.adapterState = { ...row.adapterState, divisibility };

      await expect(loadRecoverableGuiSwapSessions()).rejects.toThrow(
        /active durable swap row is invalid/,
      );
    },
  );

  it("refuses a row whose GUI payload no longer matches its persisted protocol binding", async () => {
    await persistGuiSwapSession(swap(), "https://mint.example");
    const row = rows.get("trade-001") as {
      adapterState: ActiveSwap;
    };
    row.adapterState = {
      ...row.adapterState,
      counterpartyPubkey: `02${"c".repeat(64)}`,
    };

    await expect(loadRecoverableGuiSwapSessions()).rejects.toThrow(
      /active durable swap row is invalid/,
    );
  });

  it("pins recovery and later writes to the original mint transport", async () => {
    await persistGuiSwapSession(swap(), "https://mint.example");
    const row = rows.get("trade-001") as { adapterState: ActiveSwap };
    row.adapterState = {
      ...row.adapterState,
      mintUrl: "https://other-mint.example",
    };

    await expect(loadRecoverableGuiSwapSessions()).rejects.toThrow(
      /active durable swap row is invalid/,
    );
    await expect(
      persistGuiSwapSession(
        swap({ mintUrl: "https://other-mint.example" }),
        "https://other-mint.example",
      ),
    ).rejects.toThrow(/invalid durable swap session/);
  });

  it("refuses a row whose private key no longer matches its protocol public key", async () => {
    await persistGuiSwapSession(swap(), "https://mint.example");
    const row = rows.get("trade-001") as { adapterState: ActiveSwap };
    row.adapterState = {
      ...row.adapterState,
      ephemeralPrivkeyHex: "02".repeat(32),
    };

    await expect(loadRecoverableGuiSwapSessions()).rejects.toThrow(
      /active durable swap row is invalid/,
    );
  });

  it("fails closed when adapter ciphertext differs from the SDK journal", async () => {
    await persistGuiSwapSession(
      swap({
        sellerState: {
          adaptorPoint: persistedAdaptorPoint(),
          adaptorPointCipher: "adaptor-cipher",
          lockedProofsCipher: "seller-cipher",
        },
      }),
      "https://mint.example",
    );
    const row = rows.get("trade-001") as { adapterState: ActiveSwap };
    row.adapterState = {
      ...row.adapterState,
      sellerState: {
        ...row.adapterState.sellerState!,
        lockedProofsCipher: "unjournaled-cipher",
      },
    };

    await expect(loadRecoverableGuiSwapSessions()).rejects.toThrow(
      /active durable swap row is invalid/,
    );
  });

  it("retires but retains a successful terminal session for purge review", async () => {
    await persistGuiSwapSession(
      swap({ step: "completed" }),
      "https://mint.example",
    );
    await expect(loadRecoverableGuiSwapSessions()).resolves.toEqual([]);
    expect(rows.get("trade-001")).toMatchObject({ active: 0 });
  });

  it("removes a refunded failure from the active recovery index", async () => {
    await persistGuiSwapSession(
      swap({ step: "Failed", error: "expired refund recovered" }),
      "https://mint.example",
    );

    await expect(loadRecoverableGuiSwapSessions()).resolves.toEqual([]);
    expect(rows.get("trade-001")).toMatchObject({
      active: 0,
      adapterState: {
        step: "Failed",
        error: "expired refund recovered",
      },
    });
  });

  it("fails closed when Web Locks are unavailable", async () => {
    delete (navigator as { locks?: LockManager }).locks;

    await expect(
      withGuiSwapSessionOwnership("trade-001", async () => "owned"),
    ).rejects.toThrow("Browser custody locking is unavailable");
  });

  it("uses an exclusive wallet-profile Web Lock before durable recovery work", async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    const request = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        action: () => Promise<string>,
      ) => action(),
    );
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    try {
      await expect(
        withGuiSwapSessionOwnership("trade-001", async () => "owned"),
      ).resolves.toBe("owned");
      expect(request).toHaveBeenCalledWith(
        `bitcaster-custody:${WALLET_ID}`,
        { mode: "exclusive" },
        expect.any(Function),
      );
    } finally {
      if (originalLocks)
        Object.defineProperty(navigator, "locks", originalLocks);
      else
        Object.defineProperty(navigator, "locks", {
          configurable: true,
          value: undefined,
        });
    }
  });

  it("co-commits the prepared proof operation and durable swap session", async () => {
    await prepareGuiProofOperationWithSession(
      proofOperationInput("trade-001/browser/buyer-lock"),
      operationSwap(),
    );

    const operation = proofOperations.get("trade-001/browser/buyer-lock") as {
      durableOperationId?: string;
      durableTradeRecovery?: { operationKey: string; state: string };
    };
    const session = (
      rows.get("trade-001") as {
        session: {
          stage: string;
          proofOperations: Array<{ operationKey: string; state: string }>;
        };
      }
    ).session;

    expect(operation.durableTradeRecovery).toMatchObject({
      operationKey: "trade-001/browser/buyer-lock",
      state: "prepared",
    });
    expect(operation.durableOperationId).toBe(
      "trade-recovery:trade-001:seller:proof-reservation:trade-001%2Fbrowser%2Fbuyer-lock",
    );
    expect(session.stage).toBe("proof-reserved");
    expect(session.proofOperations).toMatchObject([
      {
        operationKey: "trade-001/browser/buyer-lock",
        state: "prepared",
      },
    ]);
  });

  it("co-commits completed proof outputs and the durable swap session", async () => {
    await prepareGuiProofOperationWithSession(
      proofOperationInput("trade-001/browser/buyer-lock"),
      operationSwap(),
    );
    await completeGuiProofOperationWithSession(
      "trade-001/browser/buyer-lock",
      proofOperationResult(),
      operationSwap(),
      "https://mint.example",
    );

    expect(proofOperations.get("trade-001/browser/buyer-lock")?.state).toBe(
      "completed",
    );
    const session = (
      rows.get("trade-001") as {
        session: { stage: string; proofOperations: Array<{ state: string }> };
      }
    ).session;
    expect(session.stage).toBe("reconciliation-complete");
    expect(session.proofOperations[0]?.state).toBe("reconciled");
  });

  it("reconciles a persisted GUI proof operation through the SDK coordinator", async () => {
    await prepareGuiProofOperationWithSession(
      proofOperationInput("trade-001/browser/buyer-lock"),
      operationSwap(),
    );
    const restored: string[] = [];
    const result = await withWebLocks(() =>
      recoverGuiDurableTradeSession("trade-001", {
        mint: {
          inspect: async () => ({ kind: "prepared-spent-restorable" }),
          restoreExactPersistedOutputs: async (operation) => {
            restored.push(operation.operationId);
            await recordGuiRecoveredProofOperationOutputs(
              "trade-001",
              operation.operationId,
              proofOperationResult(),
            );
          },
          resumeExactPreparedOperation: async () => {
            throw new Error("spent operation must restore, not resume");
          },
        },
        transport: {
          joinTrade: async () => undefined,
          sendCipher: async () => undefined,
        },
        clock: { nowMs: () => 1 },
        hashCiphertext: async () => "0".repeat(64),
      }),
    );

    expect(restored).toEqual([
      "trade-recovery:trade-001:seller:proof-reservation:trade-001%2Fbrowser%2Fbuyer-lock",
    ]);
    expect(result?.sessions).toEqual([
      expect.objectContaining({ kind: "ready", tradeId: "trade-001" }),
    ]);
    expect(proofOperations.get("trade-001/browser/buyer-lock")).toMatchObject({
      state: "completed",
      durableTradeRecovery: { state: "reconciled" },
    });
    expect(
      (
        rows.get("trade-001") as {
          session: { proofOperations: Array<{ state: string }> };
        }
      ).session.proofOperations,
    ).toEqual([expect.objectContaining({ state: "reconciled" })]);
  });

  it("retains only byte-identical exact recovered outputs", async () => {
    await prepareGuiProofOperationWithSession(
      proofOperationInput("trade-001/browser/buyer-lock"),
      operationSwap(),
    );
    const durableOperationId = (
      proofOperations.get("trade-001/browser/buyer-lock") as {
        durableOperationId: string;
      }
    ).durableOperationId;
    const outputs = proofOperationResult();
    await recordGuiRecoveredProofOperationOutputs(
      "trade-001",
      durableOperationId,
      outputs,
    );
    await expect(
      recordGuiRecoveredProofOperationOutputs("trade-001", durableOperationId, {
        send: [],
        keep: [{ id: "unexpected" } as never],
      }),
    ).rejects.toThrow(/conflicting recovered outputs/);
  });

  it("fails closed instead of evicting a live durable session at capacity", async () => {
    for (let i = 0; i < MAX_ACTIVE_GUI_SWAP_SESSIONS; i += 1) {
      const tradeId = `trade-${i}`;
      rows.set(tradeId, {
        tradeId,
        active: 1,
        session: {},
        adapterState: swap({ tradeId }),
        updatedAt: i,
      });
    }

    await expect(
      persistGuiSwapSession(
        swap({ tradeId: "trade-overflow" }),
        "https://mint.example",
      ),
    ).rejects.toThrow(/capacity is exhausted/);
    expect(rows).toHaveLength(MAX_ACTIVE_GUI_SWAP_SESSIONS);
  });

  it("fails before creating a proof operation when durable storage is unavailable", async () => {
    storageOpenError = new Error("IndexedDB open blocked");

    await expect(
      prepareGuiProofOperationWithSession(
        proofOperationInput("trade-001/browser/buyer-lock"),
        swap(),
      ),
    ).rejects.toThrow(/Durable swap storage is unavailable/);
    expect(proofOperations).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });
});
