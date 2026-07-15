import { beforeEach, describe, expect, it, vi } from "vitest";

type TestOperationRecord = Record<string, unknown> & {
  walletId: string;
  operationId: string;
  mintUrl: string;
  metadata: Record<string, unknown>;
  state: string;
};

const mocks = vi.hoisted(() => ({
  walletId: "a".repeat(64),
  lock: { walletId: "a".repeat(64) },
  lockHeld: false,
  getUnitProofs: vi.fn(),
  getUnitProofsUnderLock: vi.fn(),
  getProofOperationUnderLock: vi.fn(),
  markProofOperationCompleted: vi.fn(),
  markProofOperationFailed: vi.fn(),
  markProofOperationMintSubmitted: vi.fn(),
  prepareProofOperation: vi.fn(),
  createCapturedGuiWalletProofOperationStore: vi.fn(),
  externalPort: vi.fn(async (_name: string) => undefined),
  registerCondition: vi.fn(),
  getWalletForUnit: vi.fn(),
  restoreSignatures: [] as Array<{ id: string; amount: number; C_: string }>,
  persistedOperation: null as null | TestOperationRecord,
  createdOutputs: [] as Array<{
    blindedMessage: { amount: number; id: string; B_: string };
    blindingFactor: bigint;
    secret: Uint8Array;
    toProof: ReturnType<typeof vi.fn>;
  }>,
}));

async function withExpectedTestWalletLock<T>(
  expectedWalletId: string,
  action: () => Promise<T>,
): Promise<T> {
  if (expectedWalletId !== mocks.walletId) {
    throw new Error("GUI wallet changed while awaiting custody ownership");
  }
  return withTestWalletLock(action);
}

vi.mock("@/stores/proof-db", () => ({
  getUnitProofs: mocks.getUnitProofs,
  getUnitProofsUnderLock: mocks.getUnitProofsUnderLock,
  getProofOperationUnderLock: mocks.getProofOperationUnderLock,
}));

vi.mock("@/stores/gui-custody-authority", () => ({
  withGuiCustodyProfileLock: async (
    action: (
      context: {
        walletId: string;
        scope: { scopeKind: "wallet"; walletId: string };
      },
      lock: object,
    ) => Promise<unknown>,
  ) => {
    if (mocks.lockHeld) throw new Error("test lock is already held");
    mocks.lockHeld = true;
    try {
      return await action(
        {
          walletId: mocks.walletId,
          scope: { scopeKind: "wallet", walletId: mocks.walletId },
        },
        mocks.lock,
      );
    } finally {
      mocks.lockHeld = false;
    }
  },
  withGuiCustodyProfileLockForWallet: async (
    expectedWalletId: string,
    action: (
      context: {
        scope: { scopeKind: "wallet"; walletId: string };
        walletId: string;
      },
      lock: object,
    ) => Promise<unknown>,
  ) =>
    withExpectedTestWalletLock(expectedWalletId, () =>
      action(
        {
          walletId: expectedWalletId,
          scope: { scopeKind: "wallet", walletId: expectedWalletId },
        },
        mocks.lock,
      ),
    ),
}));

vi.mock("@/stores/gui-wallet-lock", () => ({
  walletIdFromHeldGuiWalletLock: (lock: object) => {
    if (!mocks.lockHeld || lock !== mocks.lock) {
      throw new Error("test expected the GUI wallet lock to be held");
    }
    return mocks.walletId;
  },
}));

vi.mock("@/stores/gui-wallet-proof-operation-store", () => ({
  createCapturedGuiWalletProofOperationStore: (...args: unknown[]) =>
    mocks.createCapturedGuiWalletProofOperationStore(...args),
}));

vi.mock("@/lib/cashu", () => ({
  getWalletForUnit: async (...args: unknown[]) => {
    await mocks.externalPort("getWalletForUnit");
    return mocks.getWalletForUnit(...args);
  },
}));

vi.mock("@/lib/markets", () => ({
  MintError: class MintError extends Error {
    constructor(
      public readonly code: number,
      public readonly detail: string,
    ) {
      super(detail);
      this.name = "MintError";
    }
  },
  registerCondition: async (...args: unknown[]) => {
    await mocks.externalPort("registerCondition");
    return mocks.registerCondition(...args);
  },
  requiredMarketCreationOutcomeCollections: (outcomes: readonly string[]) => {
    const universe = [
      ...new Set(outcomes.map((outcome) => outcome.trim())),
    ].filter(Boolean);
    const collections = new Set<string>();
    for (const outcome of universe) {
      collections.add(outcome);
      const complement = universe.filter((candidate) => candidate !== outcome);
      if (complement.length > 0) collections.add(complement.join("|"));
    }
    return [...collections];
  },
}));

vi.mock("@cashu/cashu-ts", () => {
  class Mint {
    constructor(public readonly mintUrl: string) {}

    async getKeys(keysetId = "regular-keyset") {
      await mocks.externalPort("CashuMint.getKeys");
      return {
        keysets: [
          {
            id: keysetId,
            unit: "sat",
            active: true,
            input_fee_ppk: 0,
            keys: { "1": "k1", "2": "k2", "4": "k4", "5": "k5" },
          },
        ],
      };
    }

    async restore() {
      await mocks.externalPort("CashuMint.restore");
      return { signatures: mocks.restoreSignatures };
    }
  }

  class OutputData {
    toProof: ReturnType<typeof vi.fn>;

    constructor(
      public readonly blindedMessage: {
        amount: number;
        id: string;
        B_: string;
      },
      public readonly blindingFactor: bigint,
      public readonly secret: Uint8Array,
    ) {
      const index = mocks.createdOutputs.length;
      this.toProof = vi.fn((signature: { amount: number; id: string }) => ({
        id: signature.id,
        amount: signature.amount,
        C: `C-${index}`,
        secret: new TextDecoder().decode(secret),
      }));
      mocks.createdOutputs.push(this);
    }

    static createRandomData(_amount: number, keyset: { id?: string }) {
      const keysetId = keyset.id ?? "regular-keyset";
      return [1, 4].map((amount, index) => ({
        blindedMessage: {
          amount,
          id: keysetId,
          B_: `B_${index}`,
        },
        blindingFactor: BigInt(index + 1),
        secret: new TextEncoder().encode(`change-secret-${index}`),
        toProof: vi.fn((signature: { amount: number; id: string }) => ({
          id: signature.id,
          amount: signature.amount,
          C: `C-${index}`,
          secret: `change-secret-${index}`,
        })),
      }));
    }
  }

  return {
    Amount: { from: (value: number) => value },
    CheckStateEnum: { SPENT: "SPENT", UNSPENT: "UNSPENT" },
    Mint,
    OutputData,
  };
});

const {
  recoverGuiConditionRegistrationOperation,
  registerConditionWithFee,
  registrationFeeForPolicy,
} = await import("../marketRegistrationFee");
const { MintError } = await import("@/lib/markets");

async function withTestWalletLock<T>(action: () => Promise<T>): Promise<T> {
  if (mocks.lockHeld) throw new Error("test lock is already held");
  mocks.lockHeld = true;
  try {
    return await action();
  } finally {
    mocks.lockHeld = false;
  }
}

function requirePersistedTestOperation(
  operationId: string,
): TestOperationRecord {
  if (mocks.persistedOperation?.operationId !== operationId) {
    throw new Error("test proof operation is missing");
  }
  return mocks.persistedOperation;
}

describe("registerConditionWithFee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lockHeld = false;
    mocks.createdOutputs = [];
    mocks.persistedOperation = null;
    mocks.externalPort.mockImplementation(async () => undefined);
    mocks.getUnitProofs.mockResolvedValue([
      {
        id: "regular-keyset",
        amount: 8,
        secret: "fee-proof-secret",
        C: "fee-proof-C",
      },
    ]);
    mocks.getUnitProofsUnderLock.mockResolvedValue([
      {
        id: "regular-keyset",
        amount: 8,
        secret: "fee-proof-secret",
        C: "fee-proof-C",
      },
    ]);
    mocks.getProofOperationUnderLock.mockResolvedValue(null);
    mocks.prepareProofOperation.mockResolvedValue(undefined);
    mocks.markProofOperationCompleted.mockResolvedValue(undefined);
    mocks.markProofOperationFailed.mockResolvedValue(undefined);
    mocks.markProofOperationMintSubmitted.mockResolvedValue(undefined);
    mocks.createCapturedGuiWalletProofOperationStore.mockImplementation(
      (walletId: string) => ({
        getProofOperation: (operationId: string) =>
          withExpectedTestWalletLock(walletId, async () => {
            const configured =
              await mocks.getProofOperationUnderLock(operationId);
            if (configured !== null && configured !== undefined)
              return configured;
            return mocks.persistedOperation?.operationId === operationId
              ? structuredClone(mocks.persistedOperation)
              : null;
          }),
        prepareProofOperation: (
          input: Record<string, unknown> & {
            operationId: string;
            mintUrl: string;
            metadata: Record<string, unknown>;
          },
        ) =>
          withExpectedTestWalletLock(walletId, async () => {
            await mocks.prepareProofOperation(input);
            mocks.persistedOperation = {
              walletId,
              ...structuredClone(input),
              metadata: structuredClone(input.metadata),
              state: "prepared",
              lastError: null,
              createdAt: 1,
              updatedAt: 1,
            } as TestOperationRecord;
            return structuredClone(mocks.persistedOperation);
          }),
        markProofOperationMintSubmitted: (operationId: string) =>
          withExpectedTestWalletLock(walletId, async () => {
            await mocks.markProofOperationMintSubmitted(operationId);
            const current = requirePersistedTestOperation(operationId);
            mocks.persistedOperation = {
              ...current,
              state: "mint-submitted",
              updatedAt: 2,
            };
            return structuredClone(mocks.persistedOperation);
          }),
        markProofOperationCompleted: (
          operationId: string,
          resultProofs: Record<string, unknown>,
        ) =>
          withExpectedTestWalletLock(walletId, async () => {
            await mocks.markProofOperationCompleted(operationId, resultProofs);
            const current = requirePersistedTestOperation(operationId);
            mocks.persistedOperation = {
              ...current,
              state: "completed",
              resultProofs: structuredClone(resultProofs),
              updatedAt: 3,
            };
            return structuredClone(mocks.persistedOperation);
          }),
        markProofOperationFailed: (
          operationId: string,
          message: string,
          failureCode?: number,
        ) =>
          withExpectedTestWalletLock(walletId, async () => {
            await mocks.markProofOperationFailed(
              operationId,
              message,
              failureCode,
            );
            const current = requirePersistedTestOperation(operationId);
            mocks.persistedOperation = {
              ...current,
              state: "Failed",
              lastError: message,
              failureCode,
              updatedAt: 3,
            };
            return structuredClone(mocks.persistedOperation);
          }),
      }),
    );
    mocks.restoreSignatures = [];
    mocks.getWalletForUnit.mockResolvedValue({
      mint: {
        getKeys: async () => {
          await mocks.externalPort("wallet.mint.getKeys");
          return {
            keysets: [
              {
                id: "regular-keyset",
                unit: "sat",
                active: true,
                input_fee_ppk: 0,
                keys: { "1": "k1", "2": "k2", "4": "k4", "5": "k5" },
              },
            ],
          };
        },
      },
    });
  });

  it("charges one-vs-rest registration fees for every generated collection", () => {
    expect(
      registrationFeeForPolicy(
        ["A", "B", "C"],
        {
          defaultKeysetCreation: "one-vs-rest",
          registrationFees: [
            {
              unit: "msat",
              registrationFeeBase: 10000,
              registrationFeePerKeyset: 10000,
            },
          ],
        },
        "msat",
      ),
    ).toBe(70000);
  });

  it("accepts fewer registration-fee change signatures than prepared blank outputs", async () => {
    mocks.registerCondition.mockResolvedValue({
      condition_id: "cond-1",
      keysets: { Yes: "ks-yes", No: "ks-no" },
      change: [{ id: "regular-keyset", amount: 5, C_: "blind-sig" }],
    });

    const result = await registerConditionWithFee({
      mintUrl: "https://mint.example.test",
      requiredFeeSubunits: 3,
      request: {
        tags: [["title", "Fee change"]],
        announcementHex: "announcement",
        collateral: "sat",
      },
    });

    expect(result.condition_id).toBe("cond-1");
    expect(
      mocks.registerCondition.mock.calls[0][0].outputs.map(
        (output: { amount: number }) => output.amount,
      ),
    ).toEqual([0, 0]);
    expect(mocks.prepareProofOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          durableWalletProofTransition: expect.objectContaining({
            resultCardinality: { change: "prefix" },
          }),
        }),
      }),
    );
    const convertedOutputs = mocks.createdOutputs.filter(
      (output) => output.toProof.mock.calls.length > 0,
    );
    expect(convertedOutputs).toHaveLength(1);
    expect(convertedOutputs[0].toProof).toHaveBeenCalledWith(
      { id: "regular-keyset", amount: 5, C_: "blind-sig" },
      expect.objectContaining({ id: "regular-keyset" }),
    );
    expect(mocks.markProofOperationMintSubmitted).toHaveBeenCalledWith(
      expect.stringMatching(/^ctf-condition-registration:/),
    );
    expect(mocks.markProofOperationCompleted).toHaveBeenCalledWith(
      expect.stringMatching(/^ctf-condition-registration:/),
      { change: [expect.objectContaining({ amount: 5 })] },
    );
  });

  it("pays a USD registration fee for USD market collateral", async () => {
    mocks.getUnitProofsUnderLock.mockResolvedValueOnce([
      {
        id: "usd-keyset",
        amount: 8,
        secret: "usd-fee-proof-secret",
        C: "usd-fee-proof-C",
      },
    ]);
    mocks.getWalletForUnit.mockResolvedValue({
      mint: {
        getKeys: async () => ({
          keysets: [
            {
              id: "usd-keyset",
              unit: "usd",
              active: true,
              input_fee_ppk: 0,
              keys: { "1": "k1", "2": "k2", "4": "k4", "5": "k5" },
            },
          ],
        }),
      },
    });
    mocks.registerCondition.mockResolvedValue({
      condition_id: "cond-usd",
      keysets: { Yes: "ks-yes", No: "ks-no" },
      change: [{ id: "usd-keyset", amount: 5, C_: "blind-sig" }],
    });

    const result = await registerConditionWithFee({
      mintUrl: "https://mint.example.test",
      requiredFeeSubunits: 3,
      request: {
        tags: [["title", "USD Fee"]],
        announcementHex: "announcement",
        collateral: "usd",
      },
    });

    expect(result.condition_id).toBe("cond-usd");
    expect(mocks.getUnitProofsUnderLock).toHaveBeenCalledWith(
      mocks.lock,
      "https://mint.example.test",
      { unit: "usd" },
    );
    expect(mocks.getWalletForUnit).toHaveBeenCalledWith(
      "https://mint.example.test",
      "usd",
      { expectedWalletId: mocks.walletId },
    );
    expect(mocks.registerCondition).toHaveBeenCalledWith(
      expect.objectContaining({
        collateral: "usd",
        fee: [expect.objectContaining({ secret: "usd-fee-proof-secret" })],
      }),
    );
  });

  it("preserves msat collateral unit for fee proofs and change outputs", async () => {
    mocks.getUnitProofsUnderLock.mockResolvedValueOnce([
      {
        id: "sat-keyset",
        amount: 8,
        secret: "sat-fee-proof-secret",
        C: "sat-fee-proof-C",
      },
      {
        id: "msat-keyset",
        amount: 8,
        secret: "msat-fee-proof-secret",
        C: "msat-fee-proof-C",
      },
    ]);
    mocks.getWalletForUnit.mockResolvedValue({
      mint: {
        getKeys: async () => ({
          keysets: [
            {
              id: "sat-keyset",
              unit: "sat",
              active: true,
              input_fee_ppk: 0,
              keys: { "1": "k1", "2": "k2", "4": "k4", "5": "k5" },
            },
            {
              id: "msat-keyset",
              unit: "msat",
              active: true,
              input_fee_ppk: 0,
              keys: { "1": "k1", "2": "k2", "4": "k4", "5": "k5" },
            },
          ],
        }),
      },
    });
    mocks.registerCondition.mockResolvedValue({
      condition_id: "cond-msat",
      keysets: { Yes: "ks-yes", No: "ks-no" },
      change: [{ id: "msat-keyset", amount: 5, C_: "blind-sig" }],
    });

    const result = await registerConditionWithFee({
      mintUrl: "https://mint.example.test",
      requiredFeeSubunits: 3,
      request: {
        tags: [["title", "msat Fee"]],
        announcementHex: "announcement",
        collateral: "msat",
      },
    });

    expect(result.condition_id).toBe("cond-msat");
    expect(mocks.getUnitProofsUnderLock).toHaveBeenCalledWith(
      mocks.lock,
      "https://mint.example.test",
      { unit: "msat" },
    );
    expect(mocks.getWalletForUnit).toHaveBeenCalledWith(
      "https://mint.example.test",
      "msat",
      { expectedWalletId: mocks.walletId },
    );
    expect(mocks.registerCondition).toHaveBeenCalledWith(
      expect.objectContaining({
        collateral: "msat",
        fee: [expect.objectContaining({ secret: "msat-fee-proof-secret" })],
        outputs: [
          expect.objectContaining({ id: "msat-keyset" }),
          expect.objectContaining({ id: "msat-keyset" }),
        ],
      }),
    );
  });

  it("fails closed when no regular USD keyset is available for USD fee change", async () => {
    mocks.getWalletForUnit.mockResolvedValueOnce({
      mint: {
        getKeys: async () => ({
          keysets: [
            {
              id: "sat-keyset",
              unit: "sat",
              active: true,
              input_fee_ppk: 0,
              keys: { "1": "k1", "2": "k2", "4": "k4", "5": "k5" },
            },
          ],
        }),
      },
    });

    await expect(
      registerConditionWithFee({
        mintUrl: "https://mint.example.test",
        requiredFeeSubunits: 3,
        request: {
          tags: [["title", "Missing USD"]],
          announcementHex: "announcement",
          collateral: "usd",
        },
      }),
    ).rejects.toThrow("Mint did not return a regular usd keyset");

    expect(mocks.registerCondition).not.toHaveBeenCalled();
  });

  it("rejects more registration-fee change signatures than prepared outputs", async () => {
    mocks.registerCondition.mockResolvedValue({
      condition_id: "cond-1",
      keysets: { Yes: "ks-yes", No: "ks-no" },
      change: [
        { id: "regular-keyset", amount: 1, C_: "sig-1" },
        { id: "regular-keyset", amount: 2, C_: "sig-2" },
        { id: "regular-keyset", amount: 2, C_: "sig-3" },
      ],
    });

    await expect(
      registerConditionWithFee({
        mintUrl: "https://mint.example.test",
        requiredFeeSubunits: 3,
        request: {
          tags: [["title", "Fee change"]],
          announcementHex: "announcement",
          collateral: "sat",
        },
      }),
    ).rejects.toThrow(
      "Mint returned 3 registration-fee change signatures, but only 2 change outputs were prepared",
    );
    expect(mocks.markProofOperationCompleted).not.toHaveBeenCalled();
  });

  it("journals mint submission before the call and atomically fails exact fee rejection", async () => {
    mocks.registerCondition.mockRejectedValue(
      new MintError(13044, "registration fee rejected"),
    );

    await expect(
      registerConditionWithFee({
        mintUrl: "https://mint.example.test",
        requiredFeeSubunits: 3,
        request: {
          tags: [["title", "Rejected fee"]],
          announcementHex: "announcement",
          collateral: "sat",
        },
      }),
    ).rejects.toThrow("Registration fee was missing or insufficient.");

    expect(mocks.markProofOperationMintSubmitted).toHaveBeenCalledTimes(1);
    expect(
      mocks.markProofOperationMintSubmitted.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.registerCondition.mock.invocationCallOrder[0]!);
    expect(mocks.markProofOperationFailed).toHaveBeenCalledWith(
      expect.stringMatching(/^ctf-condition-registration:/),
      "Condition registration fee was rejected by the mint.",
      13044,
    );
    expect(
      mocks.createCapturedGuiWalletProofOperationStore,
    ).toHaveBeenCalledWith(mocks.walletId);
    expect(mocks.lockHeld).toBe(false);
  });

  it("keeps the same-wallet Web Lock available at every registration external port", async () => {
    const visitedPorts: string[] = [];
    mocks.externalPort.mockImplementation(async (name: string) => {
      await withTestWalletLock(async () => {
        visitedPorts.push(name);
      });
    });
    mocks.registerCondition.mockResolvedValue({
      condition_id: "cond-unlocked",
      keysets: { Yes: "ks-yes", No: "ks-no" },
      change: [{ id: "regular-keyset", amount: 5, C_: "blind-sig" }],
    });

    await registerConditionWithFee({
      mintUrl: "https://mint.example.test/",
      requiredFeeSubunits: 3,
      request: {
        tags: [["title", "External lock boundary"]],
        announcementHex: "announcement",
        collateral: "sat",
      },
    });

    expect(visitedPorts).toEqual([
      "getWalletForUnit",
      "wallet.mint.getKeys",
      "registerCondition",
      "CashuMint.getKeys",
    ]);
  });

  it("fails before journaling or dispatch when the seed changes after keyset resolution", async () => {
    const originalWalletId = mocks.walletId;
    mocks.externalPort.mockImplementation(async (name: string) => {
      await withTestWalletLock(async () => undefined);
      if (name === "wallet.mint.getKeys") {
        mocks.walletId = "b".repeat(64);
      }
    });

    try {
      await expect(
        registerConditionWithFee({
          mintUrl: "https://mint.example.test",
          requiredFeeSubunits: 3,
          request: {
            tags: [["title", "Seed switch"]],
            announcementHex: "announcement",
            collateral: "sat",
          },
        }),
      ).rejects.toThrow("GUI wallet changed while awaiting custody ownership");

      expect(mocks.getUnitProofsUnderLock).not.toHaveBeenCalled();
      expect(mocks.prepareProofOperation).not.toHaveBeenCalled();
      expect(mocks.markProofOperationMintSubmitted).not.toHaveBeenCalled();
      expect(mocks.registerCondition).not.toHaveBeenCalled();
      expect(mocks.persistedOperation).toBeNull();
    } finally {
      mocks.walletId = originalWalletId;
    }
  });

  it("keeps the same-wallet Web Lock available during recovery checks and restore", async () => {
    const entry = await captureSubmittedOperation();
    const visitedPorts: string[] = [];
    mocks.externalPort.mockClear();
    mocks.externalPort.mockImplementation(async (name: string) => {
      await withTestWalletLock(async () => {
        visitedPorts.push(name);
      });
    });
    mocks.restoreSignatures = [
      { id: "regular-keyset", amount: 5, C_: "restored-change" },
    ];
    mocks.getWalletForUnit.mockResolvedValue({
      mint: { getKeys: async () => ({ keysets: [] }) },
      checkProofsStates: async () => {
        await mocks.externalPort("wallet.checkProofsStates");
        return [{ state: "SPENT" }];
      },
    });
    mocks.registerCondition.mockReset().mockResolvedValue({
      condition_id: "cond-restored",
      keysets: { Yes: "ks-yes", No: "ks-no" },
      change: [],
    });

    await recoverGuiConditionRegistrationOperation(entry as never);

    expect(visitedPorts).toEqual([
      "getWalletForUnit",
      "wallet.checkProofsStates",
      "CashuMint.restore",
      "CashuMint.getKeys",
      "registerCondition",
    ]);
    expect(mocks.markProofOperationCompleted).toHaveBeenCalledOnce();
  });

  it("recovers the exact persisted request without selecting fresh proofs", async () => {
    const entry = await captureSubmittedOperation();
    const checkProofsStates = vi.fn(async () => [{ state: "UNSPENT" }]);
    mocks.getWalletForUnit.mockResolvedValue({
      mint: { getKeys: async () => ({ keysets: [] }) },
      checkProofsStates,
    });
    mocks.getUnitProofsUnderLock.mockClear();
    mocks.prepareProofOperation.mockClear();
    mocks.markProofOperationMintSubmitted.mockClear();
    mocks.registerCondition.mockReset().mockResolvedValue({
      condition_id: "cond-recovered",
      keysets: { Yes: "ks-yes", No: "ks-no" },
      change: [],
    });

    mocks.persistedOperation = structuredClone(entry);
    await recoverGuiConditionRegistrationOperation(entry as never);

    expect(mocks.getUnitProofsUnderLock).not.toHaveBeenCalled();
    expect(mocks.prepareProofOperation).not.toHaveBeenCalled();
    expect(checkProofsStates).toHaveBeenCalledWith([
      { id: "regular-keyset", secret: "fee-proof-secret" },
    ]);
    expect(mocks.registerCondition).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: [["title", "Recovery"]],
        collateral: "sat",
        fee: [expect.objectContaining({ secret: "fee-proof-secret" })],
      }),
    );
  });

  it("rejects corrupted persisted mint, unit, fee, request, and operation identity", async () => {
    const entry = await captureSubmittedOperation();
    const corruptions = [
      { ...entry, mintUrl: `${entry.mintUrl}/` },
      { ...entry, metadata: { ...entry.metadata, unit: "usd" } },
      {
        ...entry,
        metadata: {
          ...entry.metadata,
          requiredFeeSubunits: 4,
        },
      },
      {
        ...entry,
        metadata: {
          ...entry.metadata,
          request: {
            ...(entry.metadata.request as object),
            announcementHex: "foreign-announcement",
          },
        },
      },
      { ...entry, operationId: "ctf-condition-registration:foreign" },
    ];
    mocks.getWalletForUnit.mockClear();
    mocks.registerCondition.mockClear();

    for (const corrupted of corruptions) {
      await expect(
        recoverGuiConditionRegistrationOperation(corrupted as never),
      ).rejects.toThrow();
    }

    expect(mocks.getWalletForUnit).not.toHaveBeenCalled();
    expect(mocks.registerCondition).not.toHaveBeenCalled();
  });

  it("does not attribute spent inputs to an operation with no durable dispatch", async () => {
    const entry = await captureSubmittedOperation();
    entry.state = "prepared";
    mocks.persistedOperation = structuredClone(entry);
    mocks.getWalletForUnit.mockResolvedValue({
      mint: { getKeys: async () => ({ keysets: [] }) },
      checkProofsStates: async () => [{ state: "SPENT" }],
    });
    mocks.markProofOperationCompleted.mockClear();
    mocks.registerCondition.mockClear();

    await expect(
      recoverGuiConditionRegistrationOperation(entry as never),
    ).rejects.toThrow(
      "Condition registration inputs changed before durable dispatch.",
    );

    expect(mocks.markProofOperationCompleted).not.toHaveBeenCalled();
    expect(mocks.registerCondition).not.toHaveBeenCalled();
  });

  async function captureSubmittedOperation() {
    mocks.registerCondition.mockRejectedValueOnce(
      new Error("simulated transport failure"),
    );
    await expect(
      registerConditionWithFee({
        mintUrl: "https://mint.example.test/",
        requiredFeeSubunits: 3,
        request: {
          tags: [["title", "Recovery"]],
          announcementHex: "announcement",
          collateral: "sat",
        },
      }),
    ).rejects.toThrow("simulated transport failure");
    return structuredClone(mocks.persistedOperation!);
  }
});
