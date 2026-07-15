import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Amount,
  Mint as CashuMint,
  OutputData,
  Wallet as CashuWallet,
  type Proof,
  type SwapPreview,
} from "@cashu/cashu-ts";
import type { PrepareProofOperationInput as SwapPrepareProofOperationInput } from "@bitcaster/swap-protocol/atomicSwap";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  addDurableWalletProofTransitionMetadata,
  createDurableWalletProofTransition,
} from "@bitcaster/client-sdk/durableWalletProofTransition";
import type { DurableStorageAccountingState } from "@bitcaster/client-sdk/durableStorageAdmission";
import {
  BitcasterDB,
  currentGuiWalletId,
  db,
  prepareStoredProofForWrite,
  proofOperationPrimaryKey,
  type PrepareProofOperationInput,
} from "../proof-db";
import {
  completeGuiProofOperationWithSessionUnderLock,
  loadRecoverableGuiTradeOperationPage,
  prepareGuiProofOperationWithSessionUnderLock,
  resolveGuiProofOperationPreparation,
  persistGuiSwapSessionUnderLock,
  recordGuiRecoveredProofOperationOutputsUnderLock,
  recoverGuiDurableTradeSession as recoverGuiDurableTradeSessionUnlocked,
  withGuiSwapSessionOwnership,
  type GuiDurableRecoveryDatabase,
  type GuiDurableTradeRecoveryInput,
} from "../swap-session-db";
import type { ActiveSwap } from "../activeSwaps";
import { useActiveSwapsStore } from "../activeSwaps";
import { useWalletStore } from "../wallet";
import { localLockGuiProofOperationStore as createLocalLockGuiProofOperationStore } from "../gui-trade-proof-operation-store";
import {
  guiTradeRefundEvidenceUnderLock,
  prepareGuiTradeRefund,
  salvageGuiTradeRefund,
} from "../gui-trade-refund-recovery";
import { canonicalSecpPoint } from "../../test/cashu-proof-fixtures";
import { persistGuiPendingTrade } from "../pendingTrades";
import { getOrCreateAdmittedGuiPendingSwapIntents } from "../gui-pretrade-storage";
import { acquireGuiCustodyAuthority } from "../gui-custody-authority";
import {
  describePreparedGuiCustodyArtifactWriteSet,
  prepareGuiCustodyUnitOfWork,
  readGuiCustodyNativeSnapshot,
} from "../gui-custody-unit-of-work";
import {
  createGuiSwapSessionRecord,
  durableSessionFromActiveSwap,
} from "../gui-swap-session-record";

const KEYSET_ID = `00${"22".repeat(7)}`;
const PUBLIC_KEY = canonicalSecpPoint(1);
const MNEMONIC = `${"abandon ".repeat(11)}about`;
const OTHER_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

function operationInput(
  operationId: string,
  kind: PrepareProofOperationInput["kind"] = "swap-lock",
): PrepareProofOperationInput {
  return {
    operationId,
    kind,
    mintUrl: "https://mint.example",
    inputs: [
      {
        id: KEYSET_ID,
        amount: Amount.from(1),
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

function operationResult() {
  return {
    send: [],
    keep: [
      {
        id: KEYSET_ID,
        amount: Amount.from(1),
        secret: "55".repeat(32),
        C: canonicalSecpPoint(2),
      },
    ],
  };
}

function swap(): ActiveSwap {
  const ephemeralPrivkeyHex = "01".repeat(32);
  const ephemeralPubkeyHex = Array.from(
    secp256k1.getPublicKey(new Uint8Array(32).fill(1), true),
  )
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
  return {
    tradeId: "trade-dexie",
    orderId: "order-dexie",
    marketId: "condition-YES",
    mintUrl: "https://mint.example",
    ephemeralPrivkeyHex,
    ephemeralPubkeyHex,
    role: "seller",
    counterpartyPubkey: `03${"b".repeat(64)}`,
    sellerLocktime: 2_000_000_000,
    buyerLocktime: 1_999_999_900,
    outcomeFaceAmountSats: null,
    outcomeFaceAmountSubunits: null,
    quotePaymentSats: null,
    quotePaymentSubunits: null,
    baseAsset: "sat",
    divisibility: 10_000,
    settlementKind: "DirectSwap",
    sellerKeepOutcomeSetId: null,
    sellerLockOutcomeSetId: null,
    step: "awaiting-counterparty",
    messages: {},
    sellerState: {
      adaptorPoint: {
        secret: new Uint8Array(32).fill(1),
        point: secp256k1.getPublicKey(new Uint8Array(32).fill(1), true),
      },
    },
    buyerPreparation: null,
    buyerState: null,
    settlementCompleteDelivery: "not-ready",
    inFlightSteps: {},
    error: null,
    startedAt: 1,
  };
}

async function admitSwap(active: ActiveSwap): Promise<void> {
  await persistGuiPendingTrade({
    orderId: active.orderId!,
    marketId: active.marketId,
    clientOrderId: `client-${active.orderId}`,
    submittedAt: 1,
    baseAsset: active.baseAsset ?? "sat",
    divisibility: active.divisibility ?? 10_000,
    side: active.side ?? "Sell",
    tokenSide: active.tokenSide ?? "Outcome",
    priceSubunits: active.priceSubunits ?? 5_000,
    amountSubunits: active.amountSubunits ?? 10_000,
    timeInForce: active.timeInForce ?? "GTC",
  });
  await getOrCreateAdmittedGuiPendingSwapIntents([
    {
      tradeId: active.tradeId,
      orderId: active.orderId!,
      marketId: active.marketId,
      deadline: new Date(2_000_000_000_000).toISOString(),
      create: () => ({
        tradeId: active.tradeId,
        orderId: active.orderId!,
        marketId: active.marketId,
        pubkey: active.ephemeralPubkeyHex,
        privkey: active.ephemeralPrivkeyHex,
        deadline: new Date(2_000_000_000_000).toISOString(),
        submitted: false,
      }),
    },
  ]);
}

async function storedDurableStorageAccounting(): Promise<DurableStorageAccountingState> {
  const row = await db.durableStorageAccounting.toCollection().first();
  if (!row) throw new Error("Test durable storage accounting is missing");
  return structuredClone(row.state);
}

function tradeSessionCommitment(
  state: DurableStorageAccountingState,
  tradeId: string,
): string {
  const reservation = state.reservations.find(
    ({ reservationId }) => reservationId === tradeId,
  );
  const preTradeReservation = state.preTradeReservations.find(
    ({ reservationId }) => reservationId === tradeId,
  );
  const artifact = (
    reservation?.sharedArtifacts ?? preTradeReservation?.session?.artifacts
  )?.find(({ artifactRole }) => artifactRole === "trade-session");
  if (!artifact) throw new Error("Test trade-session commitment is missing");
  return artifact.sha256;
}

function installImmediateWebLocks(): void {
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
}

async function recoverGuiDurableTradeSession(
  tradeId: string,
  input: GuiDurableTradeRecoveryInput,
  database?: GuiDurableRecoveryDatabase,
) {
  return recoverGuiDurableTradeSessionUnlocked(
    tradeId,
    input,
    currentGuiWalletId(),
    database,
  );
}

async function recordGuiRecoveredProofOperationOutputs(
  tradeId: string,
  durableOperationId: string,
  resultProofs: Record<string, Proof[]>,
  _walletId?: string,
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

async function prepareGuiProofOperationWithSession(
  input: PrepareProofOperationInput,
  active: ActiveSwap,
) {
  const resolved = await resolveGuiProofOperationPreparation(input, active);
  return withGuiSwapSessionOwnership(active.tradeId, (lock) =>
    prepareGuiProofOperationWithSessionUnderLock(lock, input, active, resolved),
  );
}

async function completeGuiProofOperationWithSession(
  operationId: string,
  resultProofs: Record<string, Proof[]>,
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

const localLockGuiProofOperationStore = {
  prepareProofOperation: (input: SwapPrepareProofOperationInput) =>
    withBoundLocalLockStore(input.operationId, (store) =>
      store.prepareProofOperation(input),
    ),
  markProofOperationMintSubmitted: (operationId: string) =>
    withBoundLocalLockStore(operationId, (store) =>
      store.markProofOperationMintSubmitted(operationId),
    ),
  markProofOperationCompleted: (
    operationId: string,
    resultProofs: Record<string, Proof[]>,
  ) =>
    withBoundLocalLockStore(operationId, (store) =>
      store.markProofOperationCompleted(operationId, resultProofs),
    ),
};

async function withBoundLocalLockStore<T>(
  operationId: string,
  action: (
    store: ReturnType<typeof createLocalLockGuiProofOperationStore>,
  ) => Promise<T>,
): Promise<T> {
  const tradeId = operationId.split("/browser/")[0] ?? "";
  const active = useActiveSwapsStore.getState().byTradeId[tradeId];
  if (!active) throw new Error("Test proof operation has no active swap");
  return action(
    createLocalLockGuiProofOperationStore(currentGuiWalletId(), active),
  );
}

async function withWebLocks<T>(action: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(navigator, "locks");
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
    if (original) Object.defineProperty(navigator, "locks", original);
    else
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: undefined,
      });
  }
}

async function withSerializedWebLocks<T>(action: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(navigator, "locks");
  const tails = new Map<string, Promise<void>>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ) => {
        const previous = tails.get(name) ?? Promise.resolve();
        let release: () => void = () => undefined;
        const next = new Promise<void>((resolve) => {
          release = resolve;
        });
        tails.set(
          name,
          previous.then(() => next),
        );
        await previous;
        try {
          return await callback();
        } finally {
          release();
        }
      },
    },
  });
  try {
    return await action();
  } finally {
    if (original) Object.defineProperty(navigator, "locks", original);
    else
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: undefined,
      });
  }
}

describe("GUI durable recovery Dexie transaction", () => {
  beforeEach(async () => {
    installImmediateWebLocks();
    useWalletStore.setState({ mnemonic: MNEMONIC });
    useActiveSwapsStore.setState({ byTradeId: {} });
    vi.spyOn(CashuMint.prototype, "getKeys").mockResolvedValue({
      keysets: [{ id: KEYSET_ID, unit: "sat", keys: { "1": PUBLIC_KEY } }],
    });
    db.close();
    await db.delete();
    await db.open();
    await db.proofs.put(
      prepareStoredProofForWrite(
        {
          ...operationInput("seed").inputs[0]!,
          mintUrl: "https://mint.example",
          unit: "sat",
          reservedBy: "trade-dexie",
        },
        1,
        currentGuiWalletId(),
      ),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete (navigator as { locks?: LockManager }).locks;
    db.close();
    await db.delete();
  });

  it("globally discovers a trade operation whose session link was lost", async () => {
    const operationId = "trade-dexie/browser/orphan-lock";
    const active = swap();
    await admitSwap(active);
    await prepareGuiProofOperationWithSession(
      operationInput(operationId),
      active,
    );
    await db.swapSessions.delete("trade-dexie");

    await expect(
      loadRecoverableGuiTradeOperationPage(currentGuiWalletId()),
    ).resolves.toEqual({
      tradeIds: ["trade-dexie"],
      nextCursor: null,
    });

    const result = await recoverGuiDurableTradeSession("trade-dexie", {
      mint: {
        inspect: async () => ({ kind: "pending-or-mixed" }),
        restoreExactPersistedOutputs: async () => undefined,
        resumeExactPreparedOperation: async () => undefined,
      },
      transport: {
        joinTrade: async () => undefined,
        sendCipher: async () => undefined,
      },
      clock: { nowMs: () => 1 },
      hashCiphertext: async () => "0".repeat(64),
    });

    expect(result?.orphans).toEqual([
      expect.objectContaining({
        kind: "failed-closed",
        reason: "missing-session",
      }),
    ]);
    expect((await storedProofOperation(operationId))?.state).toBe("prepared");
  });

  it("rolls back the first operation when reservation binding cannot commit", async () => {
    const active = swap();
    const operationId = `${active.tradeId}/browser/first-binding-fault`;
    await admitSwap(active);
    vi.spyOn(db.durableStorageAccounting, "put").mockRejectedValue(
      new DOMException("injected quota failure", "QuotaExceededError"),
    );

    await expect(
      prepareGuiProofOperationWithSession(operationInput(operationId), active),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });

    expect(await storedProofOperation(operationId)).toBeUndefined();
    expect(await db.swapSessions.get(active.tradeId)).toBeUndefined();
    expect(await db.custodyOperations.count()).toBe(0);
    expect(await db.custodySessionLinks.count()).toBe(0);
    expect(await db.custodyProofReservations.count()).toBe(0);
    expect((await db.swapIntents.get(active.tradeId))?.tradeId).toBe(
      active.tradeId,
    );
    const accounting = await db.durableStorageAccounting.toCollection().first();
    expect(accounting?.state.preTradeReservations).toHaveLength(1);
    expect(accounting?.state.reservations).toHaveLength(0);
  });

  it("co-commits terminal session retirement with its storage accounting", async () => {
    const active = swap();
    await admitSwap(active);
    await withGuiSwapSessionOwnership(active.tradeId, (lock) =>
      persistGuiSwapSessionUnderLock(lock, active, "https://mint.example"),
    );
    const before = await storedDurableStorageAccounting();

    await withGuiSwapSessionOwnership(active.tradeId, (lock) =>
      persistGuiSwapSessionUnderLock(
        lock,
        { ...active, step: "completed" },
        "https://mint.example",
      ),
    );

    const terminal = await db.swapSessions.get(active.tradeId);
    const after = await storedDurableStorageAccounting();
    expect(terminal).toMatchObject({
      active: 0,
      adapterState: { step: "completed" },
    });
    expect(after.revision).toBe(before.revision + 1);
    expect(tradeSessionCommitment(after, active.tradeId)).not.toBe(
      tradeSessionCommitment(before, active.tradeId),
    );
  });

  it("rolls back terminal session retirement when accounting cannot commit", async () => {
    const active = swap();
    await admitSwap(active);
    await withGuiSwapSessionOwnership(active.tradeId, (lock) =>
      persistGuiSwapSessionUnderLock(lock, active, "https://mint.example"),
    );
    const beforeSession = await db.swapSessions.get(active.tradeId);
    const beforeAccounting = await storedDurableStorageAccounting();
    vi.spyOn(db.durableStorageAccounting, "put").mockRejectedValue(
      new DOMException("injected quota failure", "QuotaExceededError"),
    );

    await expect(
      withGuiSwapSessionOwnership(active.tradeId, (lock) =>
        persistGuiSwapSessionUnderLock(
          lock,
          { ...active, step: "completed" },
          "https://mint.example",
        ),
      ),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });

    expect(await db.swapSessions.get(active.tradeId)).toEqual(beforeSession);
    expect(await storedDurableStorageAccounting()).toEqual(beforeAccounting);
  });

  it("rejects a same-key proof-operation post-image substitution", async () => {
    const active = swap();
    const operationId = `${active.tradeId}/browser/substituted-first-binding`;
    await admitSwap(active);
    const put = db.proofOperations.put.bind(db.proofOperations);
    vi.spyOn(db.proofOperations, "put").mockImplementation((row) =>
      put({ ...row, updatedAt: row.updatedAt + 1 }),
    );

    await expect(
      prepareGuiProofOperationWithSession(operationInput(operationId), active),
    ).rejects.toThrow("prepared write set");

    expect(await storedProofOperation(operationId)).toBeUndefined();
    expect(await db.swapSessions.get(active.tradeId)).toBeUndefined();
    expect(await db.custodyOperations.count()).toBe(0);
    expect((await db.swapIntents.get(active.tradeId))?.tradeId).toBe(
      active.tradeId,
    );
  });

  it("freezes every prepared physical artifact capability", async () => {
    const active = swap();
    await withGuiSwapSessionOwnership(active.tradeId, async (lock) => {
      const authority = await acquireGuiCustodyAuthority(lock);
      const walletId = currentGuiWalletId();
      const snapshot = await readGuiCustodyNativeSnapshot(
        null,
        active.tradeId,
        walletId,
      );
      const plan = await authority.store.prepareTransaction(
        { scope: authority.scope, owner: authority.owner, operationIds: [] },
        () => undefined,
      );
      const session = durableSessionFromActiveSwap(
        active,
        "https://mint.example",
      );
      if (!session) throw new Error("test durable session is incomplete");
      const prepared = await prepareGuiCustodyUnitOfWork({
        authority,
        plan,
        snapshot,
        nextSession: createGuiSwapSessionRecord(
          active,
          session,
          walletId,
          undefined,
        ),
      });
      const writeSet = describePreparedGuiCustodyArtifactWriteSet(prepared);
      const artifact = writeSet.postImageArtifacts[0] as {
        encodedJson: string;
      };

      expect(Object.isFrozen(artifact)).toBe(true);
      expect(() => {
        artifact.encodedJson = "substituted";
      }).toThrow(TypeError);
    });
  });

  it("rejects two completed operations that claim the same result proof", async () => {
    const active = swap();
    await admitSwap(active);
    const firstId = `${active.tradeId}/browser/result-producer-one`;
    await prepareGuiProofOperationWithSession(operationInput(firstId), active);
    await completeGuiProofOperationWithSession(
      firstId,
      operationResult(),
      active,
      "https://mint.example",
    );

    const secondId = `${active.tradeId}/browser/result-producer-two`;
    const second = operationInput(secondId);
    second.inputs[0]!.secret = "66".repeat(32);
    second.inputs[0]!.C = canonicalSecpPoint(4);
    await db.proofs.put(
      prepareStoredProofForWrite(
        {
          ...second.inputs[0]!,
          mintUrl: second.mintUrl,
          unit: "sat",
        },
        1,
        currentGuiWalletId(),
      ),
    );
    await prepareGuiProofOperationWithSession(second, active);

    await expect(
      completeGuiProofOperationWithSession(
        secondId,
        operationResult(),
        active,
        second.mintUrl,
      ),
    ).rejects.toThrow("produced by multiple operations");

    expect((await storedProofOperation(secondId))?.state).toBe("prepared");
    expect(await storedRow(second.inputs[0]!.secret)).toBeDefined();
  });

  it("accepts a proof produced by one operation as the next operation input", async () => {
    const active = swap();
    await admitSwap(active);
    const producerId = `${active.tradeId}/browser/producer`;
    await prepareGuiProofOperationWithSession(
      operationInput(producerId),
      active,
    );
    await completeGuiProofOperationWithSession(
      producerId,
      operationResult(),
      active,
      "https://mint.example",
    );

    const consumerId = `${active.tradeId}/browser/consumer`;
    const consumer = operationInput(consumerId);
    consumer.inputs = structuredClone(operationResult().keep);
    consumer.outputs.keep![0]!.secret = "77".repeat(32);
    await prepareGuiProofOperationWithSession(consumer, active);
    expect((await storedRow("55".repeat(32)))?.reservedBy).toBe(consumerId);

    await completeGuiProofOperationWithSession(
      consumerId,
      {
        send: [],
        keep: [
          {
            id: KEYSET_ID,
            amount: Amount.from(1),
            secret: "77".repeat(32),
            C: canonicalSecpPoint(3),
          },
        ],
      },
      active,
      consumer.mintUrl,
    );

    expect(await storedRow("55".repeat(32))).toBeUndefined();
    expect(await storedRow("77".repeat(32))).toBeDefined();
    expect((await storedProofOperation(consumerId))?.state).toBe("completed");
  });

  it("does not hold the profile lock while mint authority is unresolved", async () => {
    await withSerializedWebLocks(async () => {
      let announceStarted!: () => void;
      let resolveKeys!: (
        value: Awaited<ReturnType<CashuMint["getKeys"]>>,
      ) => void;
      const started = new Promise<void>((resolve) => {
        announceStarted = resolve;
      });
      const unresolved = new Promise<Awaited<ReturnType<CashuMint["getKeys"]>>>(
        (resolve) => {
          resolveKeys = resolve;
        },
      );
      vi.mocked(CashuMint.prototype.getKeys).mockImplementation(async () => {
        announceStarted();
        return unresolved;
      });
      const active = swap();
      await admitSwap(active);
      useActiveSwapsStore.setState({
        byTradeId: { [active.tradeId]: active },
      });
      const store = createLocalLockGuiProofOperationStore(
        currentGuiWalletId(),
        active,
      );
      const input = operationInput(`${active.tradeId}/browser/unresolved-mint`);
      input.metadata = { unit: "sat" };
      const pending = store.prepareProofOperation(
        input as SwapPrepareProofOperationInput,
      );
      await started;

      const other = {
        ...swap(),
        tradeId: "trade-other",
        orderId: "order-other",
      };
      await admitSwap(other);
      let otherCommitted = false;
      let announceOtherLock!: () => void;
      const otherLockEntered = new Promise<boolean>((resolve) => {
        announceOtherLock = () => resolve(true);
      });
      const otherWrite = withGuiSwapSessionOwnership(
        other.tradeId,
        async (lock) => {
          announceOtherLock();
          return persistGuiSwapSessionUnderLock(
            lock,
            other,
            "https://mint.example",
          );
        },
      ).then(() => {
        otherCommitted = true;
      });
      const enteredBeforeMintResolved = await Promise.race([
        otherLockEntered,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);

      resolveKeys({
        keysets: [{ id: KEYSET_ID, unit: "sat", keys: { "1": PUBLIC_KEY } }],
      });
      await Promise.all([pending, otherWrite]);
      expect(enteredBeforeMintResolved).toBe(true);
      expect(otherCommitted).toBe(true);
    });
  });

  it("rejects a late mint-authority response after its session changed", async () => {
    await withSerializedWebLocks(async () => {
      const active = swap();
      await admitSwap(active);
      useActiveSwapsStore.setState({
        byTradeId: { [active.tradeId]: active },
      });
      await withGuiSwapSessionOwnership(active.tradeId, (lock) =>
        persistGuiSwapSessionUnderLock(lock, active, "https://mint.example"),
      );
      let announceStarted!: () => void;
      let resolveKeys!: (
        value: Awaited<ReturnType<CashuMint["getKeys"]>>,
      ) => void;
      const started = new Promise<void>((resolve) => {
        announceStarted = resolve;
      });
      vi.mocked(CashuMint.prototype.getKeys).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveKeys = resolve;
            announceStarted();
          }),
      );
      const store = createLocalLockGuiProofOperationStore(
        currentGuiWalletId(),
        active,
      );
      const operationId = `${active.tradeId}/browser/stale-mint`;
      const input = operationInput(operationId);
      input.metadata = { unit: "sat" };
      const pending = store.prepareProofOperation(
        input as SwapPrepareProofOperationInput,
      );
      await started;

      await withGuiSwapSessionOwnership(active.tradeId, (lock) =>
        persistGuiSwapSessionUnderLock(
          lock,
          {
            ...active,
            sellerState: {
              ...active.sellerState!,
              adaptorPointCipher: "newly-journaled-cipher",
            },
          },
          "https://mint.example",
        ),
      );
      resolveKeys({
        keysets: [{ id: KEYSET_ID, unit: "sat", keys: { "1": PUBLIC_KEY } }],
      });

      await expect(pending).rejects.toThrow(
        "Cannot erase or replace durable swap state",
      );
      expect(await storedProofOperation(operationId)).toBeUndefined();
    });
  });

  it("prepares and salvages the exact expired refund without selecting fresh proofs", async () => {
    const lockedOperationId = "trade-dexie/browser/seller-lock";
    const lockedSecret = "66".repeat(32);
    const locktime = Math.floor(Date.now() / 1_000) - 1;
    const refundSwap: ActiveSwap = {
      ...swap(),
      sellerLocktime: locktime,
      buyerLocktime: locktime - 1,
    };
    await admitSwap(refundSwap);
    const lockedInput = operationInput(lockedOperationId);
    lockedInput.kind = "conditional-keyset-swap";
    lockedInput.outputs = {
      lock: [
        {
          blindedMessage: {
            amount: 1,
            id: KEYSET_ID,
            B_: PUBLIC_KEY,
          },
          blindingFactor: "44".repeat(32),
          secret: lockedSecret,
        },
      ],
      change: [],
    };
    lockedInput.metadata = addDurableWalletProofTransitionMetadata(
      {
        unit: "sat",
        conditionId: "condition",
        outcomeByKeyset: {
          [KEYSET_ID]: {
            conditionId: "condition",
            outcomeCollection: "YES",
            marketId: "condition-YES",
          },
        },
      },
      createDurableWalletProofTransition({
        inputSource: "wallet",
        plannedOutputLabels: ["lock", "change"],
        resultGroups: {
          lock: { kind: "operation" },
          change: {
            kind: "wallet",
            asset: "conditional",
            reservedBy: null,
          },
        },
      }),
    );
    await prepareGuiProofOperationWithSession(lockedInput, refundSwap);
    const boundAccounting = await db.durableStorageAccounting
      .toCollection()
      .first();
    expect(boundAccounting?.state.preTradeReservations).toHaveLength(0);
    expect(boundAccounting?.state.reservations).toHaveLength(1);
    expect(await db.swapIntents.get(refundSwap.tradeId)).toBeUndefined();
    const lockedProof: Proof = {
      id: KEYSET_ID,
      amount: Amount.from(1),
      secret: lockedSecret,
      C: canonicalSecpPoint(2),
    };
    await completeGuiProofOperationWithSession(
      lockedOperationId,
      { lock: [lockedProof], change: [] },
      refundSwap,
      "https://mint.example",
    );
    const awaitingRefund = {
      ...refundSwap,
      step: "awaiting-refund" as const,
    };
    await withGuiSwapSessionOwnership(awaitingRefund.tradeId, (lock) =>
      persistGuiSwapSessionUnderLock(
        lock,
        awaitingRefund,
        "https://mint.example",
      ),
    );

    const refundSecretBytes = new Uint8Array(32).fill(0x77);
    const refundSecret = "77".repeat(32);
    const refundOutput = new OutputData(
      {
        amount: Amount.from(1),
        id: KEYSET_ID,
        B_: PUBLIC_KEY,
      },
      BigInt(`0x${"55".repeat(32)}`),
      refundSecretBytes,
    );
    const preview: SwapPreview = {
      amount: Amount.from(1),
      fees: Amount.from(0),
      keysetId: KEYSET_ID,
      inputs: [lockedProof],
      sendOutputs: [],
      keepOutputs: [refundOutput],
      unselectedProofs: [],
    };
    vi.spyOn(CashuWallet.prototype, "loadMint").mockResolvedValue(undefined);
    const prepare = vi
      .spyOn(CashuWallet.prototype, "prepareSwapToReceive")
      .mockResolvedValue(preview);
    vi.spyOn(CashuWallet.prototype, "checkProofsStates").mockResolvedValue([
      { Y: PUBLIC_KEY, state: "UNSPENT", witness: null },
    ]);
    const complete = vi
      .spyOn(CashuWallet.prototype, "completeSwap")
      .mockResolvedValue({
        keep: [
          {
            id: KEYSET_ID,
            amount: Amount.from(1),
            secret: refundSecret,
            C: canonicalSecpPoint(3),
          },
        ],
        send: [],
      });

    const prepared = await prepareGuiTradeRefund(
      awaitingRefund,
      awaitingRefund.sellerLocktime! * 1_000,
      currentGuiWalletId(),
    );
    expect(prepared.kind).toBe("ready");
    if (prepared.kind === "ready") {
      await withGuiSwapSessionOwnership(
        awaitingRefund.tradeId,
        async (lock) => {
          await expect(
            guiTradeRefundEvidenceUnderLock(
              lock,
              awaitingRefund,
              prepared.operation,
            ),
          ).resolves.toMatchObject({
            tradeId: awaitingRefund.tradeId,
            privateKeyHex: awaitingRefund.ephemeralPrivkeyHex,
            proofOperation: prepared.operation,
          });
        },
      );
      await expect(
        salvageGuiTradeRefund(
          awaitingRefund,
          prepared.operation,
          currentGuiWalletId(),
        ),
      ).resolves.toEqual({
        refund: [expect.objectContaining({ secret: refundSecret })],
      });
    }

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: [expect.objectContaining({ secret: lockedSecret })],
        keepOutputs: [expect.objectContaining({ secret: refundSecretBytes })],
      }),
      awaitingRefund.ephemeralPrivkeyHex,
    );
    const refundOperation = await storedProofOperation(
      `${awaitingRefund.tradeId}/browser/expired-refund`,
    );
    expect(refundOperation).toMatchObject({
      kind: "swap-refund",
      state: "mint-submitted",
      inputs: [expect.objectContaining({ secret: lockedSecret })],
      durableTradeRecovery: {
        tradeId: awaitingRefund.tradeId,
        stage: "refund",
        state: "mint-submitted",
      },
      metadata: { enableCtf: true },
    });
  });

  it("rolls back both rows when the session half of reconciliation fails", async () => {
    const nativeOperationId = "trade-dexie/browser/seller-lock";
    const active = swap();
    await admitSwap(active);
    await prepareGuiProofOperationWithSession(
      operationInput(nativeOperationId),
      active,
    );
    const custodyOperationId = (await storedProofOperation(nativeOperationId))
      ?.custodyOperationId;
    expect(custodyOperationId).toBeDefined();
    const sessionPut = vi
      .spyOn(db.swapSessions, "put")
      .mockImplementation((() => {
        throw new Error("injected session write failure");
      }) as never);
    try {
      const result = await withWebLocks(() =>
        recoverGuiDurableTradeSession("trade-dexie", {
          mint: {
            inspect: async () => ({ kind: "prepared-spent-restorable" }),
            restoreExactPersistedOutputs: async (operation) =>
              recordGuiRecoveredProofOperationOutputs(
                "trade-dexie",
                operation.operationId,
                operationResult(),
              ),
            resumeExactPreparedOperation: async () => undefined,
          },
          transport: {
            joinTrade: async () => undefined,
            sendCipher: async () => undefined,
          },
          clock: { nowMs: () => 1 },
          hashCiphertext: async () => "0".repeat(64),
        }),
      );
      expect(result?.sessions).toEqual([
        expect.objectContaining({ kind: "failed-closed" }),
      ]);
    } finally {
      sessionPut.mockRestore();
    }

    expect((await storedProofOperation(nativeOperationId))?.state).toBe(
      "prepared",
    );
    expect(
      (await storedProofOperation(nativeOperationId))?.resultProofs,
    ).toEqual(operationResult());
    expect(
      (await db.swapSessions.get("trade-dexie"))?.session.proofOperations[0]
        ?.state,
    ).toBe("prepared");
    expect(
      (await db.custodyOperations.get(custodyOperationId!))?.record.operation
        .state,
    ).toBe("dispatch-intent");
  });

  it("binds the local-lock policy and uses the persisted mint after wallet retargeting", async () => {
    const currentSwap = swap();
    await admitSwap(currentSwap);
    useActiveSwapsStore.setState({
      byTradeId: { [currentSwap.tradeId]: currentSwap },
    });
    const operationId = "trade-dexie/browser/buyer-lock";
    const input = operationInput(operationId);
    input.metadata = { unit: "sat" };

    await localLockGuiProofOperationStore.prepareProofOperation(
      input as SwapPrepareProofOperationInput,
    );
    expect((await storedProofOperation(operationId))?.metadata).toMatchObject({
      durableWalletProofTransition: {
        inputSource: "wallet",
        resultGroups: {
          send: { kind: "operation" },
          keep: { kind: "wallet", asset: "regular", reservedBy: null },
        },
      },
    });
    useWalletStore.setState({ activeMintUrl: "https://other-mint.example" });

    await localLockGuiProofOperationStore.markProofOperationMintSubmitted(
      operationId,
    );

    expect((await storedProofOperation(operationId))?.state).toBe(
      "mint-submitted",
    );
  });

  it("co-commits exact proof replacement with operation and session reconciliation", async () => {
    const operationId = "trade-dexie/browser/seller-lock";
    const active = swap();
    await admitSwap(active);
    await prepareGuiProofOperationWithSession(
      operationInput(operationId),
      active,
    );
    const freshProof = {
      id: KEYSET_ID,
      amount: Amount.from(1),
      secret: "55".repeat(32),
      C: canonicalSecpPoint(2),
      mintUrl: "https://mint.example",
      unit: "sat" as const,
      baseAsset: "sat",
    };

    await completeGuiProofOperationWithSession(
      operationId,
      { send: [], keep: [freshProof] },
      active,
      "https://mint.example",
    );

    expect(await storedRow("11".repeat(32))).toBeUndefined();
    expect(await storedRow("55".repeat(32))).toMatchObject({ unit: "sat" });
    expect((await storedRow("55".repeat(32)))?.reservedBy).toBeUndefined();
    expect((await storedProofOperation(operationId))?.state).toBe("completed");
    expect(
      (await db.swapSessions.get("trade-dexie"))?.session.proofOperations[0]
        ?.state,
    ).toBe("reconciled");
    expect(await db.custodyProofReservations.count()).toBe(0);
  });

  it("rejects prepare when the wallet changes during mint-key resolution", async () => {
    const originalWalletId = currentGuiWalletId();
    let releaseKeys: (() => void) | undefined;
    const keysReleased = new Promise<void>((resolve) => {
      releaseKeys = resolve;
    });
    let observeKeys: (() => void) | undefined;
    const keysRequested = new Promise<void>((resolve) => {
      observeKeys = resolve;
    });
    vi.mocked(CashuMint.prototype.getKeys).mockImplementation(async () => {
      observeKeys?.();
      await keysReleased;
      return {
        keysets: [{ id: KEYSET_ID, unit: "sat", keys: { "1": PUBLIC_KEY } }],
      };
    });
    const operationId = "trade-dexie/browser/pinned-prepare";

    const active = swap();
    const input = operationInput(operationId);
    input.metadata = { unit: "sat" };
    const pending = createLocalLockGuiProofOperationStore(
      originalWalletId,
      active,
    ).prepareProofOperation(input as SwapPrepareProofOperationInput);
    await keysRequested;
    useWalletStore.setState({ mnemonic: OTHER_MNEMONIC });
    const otherWalletId = currentGuiWalletId();
    releaseKeys?.();
    await expect(pending).rejects.toThrow(
      "GUI wallet changed while awaiting custody ownership",
    );

    expect(otherWalletId).not.toBe(originalWalletId);
    expect(
      await storedProofOperation(operationId, originalWalletId),
    ).toBeUndefined();
    expect(await db.swapSessions.get("trade-dexie")).toBeUndefined();
    expect((await storedRow("11".repeat(32)))?.walletId).toBe(originalWalletId);
    expect(await db.custodyScopes.count()).toBe(0);
    expect(
      await db.proofOperations.where("walletId").equals(otherWalletId).count(),
    ).toBe(0);
  });

  it("rejects recovery commit when the active seed changes", async () => {
    const operationId = "trade-dexie/browser/pinned-recovery";
    const active = swap();
    await admitSwap(active);
    await prepareGuiProofOperationWithSession(
      operationInput(operationId),
      active,
    );
    const originalWalletId = currentGuiWalletId();

    const result = await withWebLocks(() =>
      recoverGuiDurableTradeSession("trade-dexie", {
        mint: {
          inspect: async () => ({ kind: "prepared-spent-restorable" }),
          restoreExactPersistedOutputs: async (operation) => {
            await recordGuiRecoveredProofOperationOutputs(
              "trade-dexie",
              operation.operationId,
              operationResult(),
              originalWalletId,
            );
            useWalletStore.setState({ mnemonic: OTHER_MNEMONIC });
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

    expect(result?.sessions).toEqual([
      expect.objectContaining({
        kind: "failed-closed",
        reason: "session-cas-conflict",
      }),
    ]);
    expect(
      (await storedProofOperation(operationId, originalWalletId))?.walletId,
    ).toBe(originalWalletId);
    expect(
      (await storedProofOperation(operationId, originalWalletId))?.state,
    ).toBe("prepared");
    expect((await db.swapSessions.get("trade-dexie"))?.walletId).toBe(
      originalWalletId,
    );
    expect(
      (await db.swapSessions.get("trade-dexie"))?.session.proofOperations[0]
        ?.state,
    ).toBe("prepared");
    expect(await storedRow("55".repeat(32))).toBeUndefined();
  });

  it("does not enter a wallet lock after the active seed changes while waiting", async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    let releaseLock: (() => void) | undefined;
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let observeRequest: (() => void) | undefined;
    const lockRequested = new Promise<void>((resolve) => {
      observeRequest = resolve;
    });
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (
          _name: string,
          _options: LockOptions,
          callback: () => Promise<unknown>,
        ) => {
          observeRequest?.();
          await lockReleased;
          return callback();
        },
      },
    });
    let entered = false;
    try {
      const pending = withGuiSwapSessionOwnership("trade-dexie", async () => {
        entered = true;
      });
      await lockRequested;
      useWalletStore.setState({ mnemonic: OTHER_MNEMONIC });
      releaseLock?.();
      await expect(pending).rejects.toThrow(
        "GUI wallet changed while awaiting custody ownership",
      );
      expect(entered).toBe(false);
      expect(await db.swapSessions.count()).toBe(0);
      expect(await db.proofOperations.count()).toBe(0);
    } finally {
      if (originalLocks) {
        Object.defineProperty(navigator, "locks", originalLocks);
      } else {
        Object.defineProperty(navigator, "locks", {
          configurable: true,
          value: undefined,
        });
      }
    }
  });

  it("rejects a session write when the seed changes under the held lock", async () => {
    const originalWalletId = currentGuiWalletId();
    const active = swap();
    await admitSwap(active);

    await expect(
      withGuiSwapSessionOwnership(active.tradeId, async (lock) => {
        useWalletStore.setState({ mnemonic: OTHER_MNEMONIC });
        await persistGuiSwapSessionUnderLock(
          lock,
          active,
          "https://mint.example",
        );
      }),
    ).rejects.toThrow("wallet ownership changed");

    expect(await db.swapSessions.get(active.tradeId)).toBeUndefined();
    expect((await db.swapIntents.get(active.tradeId))?.walletId).toBe(
      originalWalletId,
    );
  });

  it("keeps a proof-operation adapter pinned to its captured swap and wallet", async () => {
    const originalWalletId = currentGuiWalletId();
    const active = swap();
    useActiveSwapsStore.setState({
      byTradeId: { [active.tradeId]: active },
    });
    const operationId = `${active.tradeId}/browser/buyer-lock`;
    const input = operationInput(operationId);
    input.metadata = { unit: "sat" };

    const store = createLocalLockGuiProofOperationStore(
      originalWalletId,
      active,
    );
    useWalletStore.setState({ mnemonic: OTHER_MNEMONIC });
    useActiveSwapsStore.setState({ byTradeId: {} });
    await expect(
      store.prepareProofOperation(input as SwapPrepareProofOperationInput),
    ).rejects.toThrow("GUI wallet changed while awaiting custody ownership");
    expect(
      await storedProofOperation(operationId, originalWalletId),
    ).toBeUndefined();
    expect(await db.swapSessions.get(active.tradeId)).toBeUndefined();
  });

  it("acquires each required proof-operation lock once", async () => {
    const acquired: string[] = [];
    const held = new Set<string>();
    const active = swap();
    await admitSwap(active);
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async <T>(
          name: string,
          _options: LockOptions,
          callback: () => Promise<T>,
        ) => {
          if (held.has(name)) throw new Error("non-reentrant lock reacquired");
          held.add(name);
          acquired.push(name);
          try {
            return await callback();
          } finally {
            held.delete(name);
          }
        },
      },
    });
    useActiveSwapsStore.setState({
      byTradeId: { [active.tradeId]: active },
    });
    const operationId = `${active.tradeId}/browser/non-reentrant-lock`;
    const input = operationInput(operationId);
    input.metadata = { unit: "sat" };

    await createLocalLockGuiProofOperationStore(
      currentGuiWalletId(),
      active,
    ).prepareProofOperation(input as SwapPrepareProofOperationInput);

    expect(acquired).toEqual([
      `bitcaster-custody:${currentGuiWalletId()}`,
      "bitcaster-origin-storage-admission",
    ]);
  });

  it("keeps the same native operation id independent across wallets", async () => {
    const originalWalletId = currentGuiWalletId();
    const active = swap();
    await admitSwap(active);
    useWalletStore.setState({ mnemonic: OTHER_MNEMONIC });
    const otherWalletId = currentGuiWalletId();
    const input = operationInput("trade-dexie/browser/colliding-operation");
    const now = Date.now();
    await db.proofOperations.put({
      walletId: otherWalletId,
      operationId: input.operationId,
      kind: input.kind,
      state: "prepared",
      mintUrl: input.mintUrl,
      inputs: structuredClone(input.inputs),
      outputs: structuredClone(input.outputs),
      metadata: structuredClone(input.metadata ?? {}),
      lastError: null,
      custodyOperationId: "foreign-wallet-custody-operation",
      createdAt: now,
      updatedAt: now,
    });
    useWalletStore.setState({ mnemonic: MNEMONIC });
    expect(currentGuiWalletId()).toBe(originalWalletId);

    await expect(
      prepareGuiProofOperationWithSession(input, active),
    ).resolves.toMatchObject({ walletId: originalWalletId });
    expect(
      (await storedProofOperation(input.operationId, otherWalletId))?.walletId,
    ).toBe(otherWalletId);
    expect(
      (await storedProofOperation(input.operationId, originalWalletId))
        ?.walletId,
    ).toBe(originalWalletId);
    expect(await db.proofOperations.count()).toBe(2);
  });

  it("retains and releases exact cashu-ts unselected proofs across restart", async () => {
    const currentSwap = swap();
    await admitSwap(currentSwap);
    useActiveSwapsStore.setState({
      byTradeId: { [currentSwap.tradeId]: currentSwap },
    });
    const operationId = "trade-dexie/browser/lock-with-passthrough";
    const input = operationInput(operationId);
    const passthrough = {
      id: KEYSET_ID,
      amount: Amount.from(2),
      secret: "66".repeat(32),
      C: canonicalSecpPoint(4),
    };
    input.metadata = {
      unit: "sat",
      unselectedProofs: [{ ...passthrough, amount: 2 as never }],
    };
    await db.proofs.put(
      prepareStoredProofForWrite(
        {
          ...passthrough,
          mintUrl: input.mintUrl,
          unit: "sat",
          baseAsset: "sat",
          reservedBy: currentSwap.tradeId,
        },
        1,
        currentGuiWalletId(),
      ),
    );

    await localLockGuiProofOperationStore.prepareProofOperation(
      input as SwapPrepareProofOperationInput,
    );
    expect((await storedRow(passthrough.secret))?.reservedBy).toBe(operationId);

    db.close();
    await db.open();
    await localLockGuiProofOperationStore.markProofOperationCompleted(
      operationId,
      {
        ...operationResult(),
        keep: [...operationResult().keep, passthrough],
      },
    );

    expect(await storedRow(input.inputs[0]!.secret)).toBeUndefined();
    expect((await storedRow(passthrough.secret))?.reservedBy).toBeUndefined();
    expect(await storedRow("55".repeat(32))).toBeDefined();
  });

  it("accepts counterparty claim inputs without reserving a nonexistent local proof", async () => {
    const operationId = "trade-dexie/browser/seller-claim";
    const active = swap();
    await admitSwap(active);
    const input = operationInput(operationId, "swap-claim");
    input.inputs[0]!.secret = "66".repeat(32);
    input.outputs = { keep: input.outputs.keep };
    input.outputs.keep![0]!.secret = "77".repeat(32);
    input.metadata = addDurableWalletProofTransitionMetadata(
      { unit: "sat" },
      createDurableWalletProofTransition({
        inputSource: "external",
        plannedOutputLabels: ["keep"],
        resultGroups: {
          keep: { kind: "wallet", asset: "regular", reservedBy: null },
        },
      }),
    );
    const freshProof = {
      id: KEYSET_ID,
      amount: Amount.from(1),
      secret: "77".repeat(32),
      C: canonicalSecpPoint(3),
    };

    await prepareGuiProofOperationWithSession(input, active);
    expect(await storedRow(input.inputs[0]!.secret)).toBeUndefined();
    await completeGuiProofOperationWithSession(
      operationId,
      { keep: [freshProof] },
      active,
      input.mintUrl,
    );

    expect(await storedRow(freshProof.secret)).toMatchObject({
      mintUrl: input.mintUrl,
      unit: "sat",
      baseAsset: "sat",
    });
    expect((await storedProofOperation(operationId))?.state).toBe("completed");
  });

  it("atomically retains only spendable conditional change from a local lock", async () => {
    const operationId = "trade-dexie/browser/seller-conditional-lock";
    const active = swap();
    await admitSwap(active);
    const input = operationInput(operationId);
    input.kind = "conditional-keyset-swap";
    input.outputs = {
      lock: input.outputs.keep,
      change: input.outputs.keep.map((output) => ({
        ...output,
        secret: "88".repeat(32),
      })),
    };
    input.metadata = addDurableWalletProofTransitionMetadata(
      {
        unit: "sat",
        conditionId: "condition",
        outcomeByKeyset: {
          [KEYSET_ID]: {
            conditionId: "condition",
            outcomeCollection: "YES",
            marketId: "condition-YES",
          },
        },
      },
      createDurableWalletProofTransition({
        inputSource: "wallet",
        plannedOutputLabels: ["lock", "change"],
        resultGroups: {
          lock: { kind: "operation" },
          change: {
            kind: "wallet",
            asset: "conditional",
            reservedBy: null,
          },
        },
      }),
    );
    const locked = {
      id: KEYSET_ID,
      amount: Amount.from(1),
      secret: "55".repeat(32),
      C: canonicalSecpPoint(5),
    };
    const change = {
      id: KEYSET_ID,
      amount: Amount.from(1),
      secret: "88".repeat(32),
      C: canonicalSecpPoint(4),
    };

    await prepareGuiProofOperationWithSession(input, active);
    await completeGuiProofOperationWithSession(
      operationId,
      { lock: [locked], change: [change] },
      active,
      input.mintUrl,
    );

    expect(await storedRow(input.inputs[0]!.secret)).toBeUndefined();
    expect(await storedRow(locked.secret)).toBeUndefined();
    expect(await storedRow(change.secret)).toMatchObject({
      conditionId: "condition",
      outcomeCollection: "YES",
      marketId: "condition-YES",
      unit: "sat",
    });
  });

  it("serializes two reopened-tab recoveries and reconciles the exact retained operation once", async () => {
    const nativeOperationId = "trade-dexie/browser/seller-lock";
    const active = swap();
    await admitSwap(active);
    await prepareGuiProofOperationWithSession(
      operationInput(nativeOperationId),
      active,
    );

    // Simulate the persisted view a new browser context sees after a reload.
    db.close();
    await db.open();

    let releaseRestore: (() => void) | undefined;
    const restoreReleased = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let observeRestore: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      observeRestore = resolve;
    });
    const durableOperationId = (await storedProofOperation(nativeOperationId))
      ?.durableOperationId;
    expect(durableOperationId).toBeDefined();
    const inspectedOperationIds: string[] = [];
    const restoredOperationIds: string[] = [];
    const restoreExactPersistedOutputs = vi.fn(
      async (operation: { operationId: string }) => {
        restoredOperationIds.push(operation.operationId);
        await recordGuiRecoveredProofOperationOutputs(
          "trade-dexie",
          operation.operationId,
          operationResult(),
        );
        observeRestore?.();
        await restoreReleased;
      },
    );
    const ports = {
      mint: {
        inspect: async (operation: { operationId: string }) => {
          inspectedOperationIds.push(operation.operationId);
          return { kind: "prepared-spent-restorable" as const };
        },
        restoreExactPersistedOutputs,
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
    };

    const recoveries = await withSerializedWebLocks(async () => {
      const secondTabDb = new BitcasterDB();
      await secondTabDb.open();
      const firstTab = recoverGuiDurableTradeSession("trade-dexie", ports);
      await restoreStarted;
      const secondTab = recoverGuiDurableTradeSession(
        "trade-dexie",
        ports,
        secondTabDb,
      );
      try {
        releaseRestore?.();
        return await Promise.all([firstTab, secondTab]);
      } finally {
        secondTabDb.close();
      }
    });

    expect(recoveries).toEqual([
      expect.objectContaining({
        sessions: [expect.objectContaining({ kind: "ready" })],
      }),
      expect.objectContaining({
        sessions: [expect.objectContaining({ kind: "ready" })],
      }),
    ]);
    expect(inspectedOperationIds).toEqual([durableOperationId]);
    expect(restoredOperationIds).toEqual([durableOperationId]);
    expect(restoreExactPersistedOutputs).toHaveBeenCalledTimes(1);
    expect((await storedProofOperation(nativeOperationId))?.state).toBe(
      "completed",
    );
    expect(
      (await db.swapSessions.get("trade-dexie"))?.session.proofOperations[0]
        ?.state,
    ).toBe("reconciled");
    const custodyOperationId = (await storedProofOperation(nativeOperationId))
      ?.custodyOperationId;
    expect(
      (await db.custodyOperations.get(custodyOperationId!))?.record.operation
        .result.state,
    ).toBe("applied");
  });
});

async function storedRow(secret: string) {
  return (await db.proofs.toArray()).find((proof) => proof.secret === secret);
}

async function storedProofOperation(
  operationId: string,
  walletId = currentGuiWalletId(),
) {
  return db.proofOperations.get(
    proofOperationPrimaryKey(walletId, operationId),
  );
}
