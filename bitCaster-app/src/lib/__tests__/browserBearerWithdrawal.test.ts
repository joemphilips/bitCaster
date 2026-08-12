import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  classify: vi.fn(),
  prepareReceive: vi.fn(),
  bindReceive: vi.fn(),
  receive: vi.fn(),
  read: vi.fn(),
  prepareReclaim: vi.fn(),
  completeReclaim: vi.fn(),
  capture: vi.fn(),
  execute: vi.fn(),
  wallet: { checkProofsStates: vi.fn(), getKeyset: vi.fn() },
}));

vi.mock("@bitcaster/client-sdk/durableOutgoingCashuTransfer", async (importOriginal) => ({
  ...(await importOriginal()),
  prepareDurableOutgoingCashuReclaim: mocks.prepareReclaim,
  completeDurableOutgoingCashuReclaim: mocks.completeReclaim,
}));

vi.mock("@/lib/cashu", () => ({
  captureBrowserMintPersistenceContext: mocks.capture,
  getWalletForUnit: vi.fn(async () => mocks.wallet),
  restoreExactMintOutputs: vi.fn(),
}));
vi.mock("@/lib/browserDurableOutgoingCashuTransfer", () => ({
  classifyBrowserDurableOutgoingBearerTransfer: mocks.classify,
  browserOutgoingCashuTransferRow: vi.fn((scopeId, transfer) => ({ scopeId, transfer })),
  executeBrowserDurableOutgoingCashuTransfer: mocks.execute,
  findBrowserDurableOutgoingBearerTransfer: vi.fn(),
  readBrowserDurableOutgoingCashuTransfer: mocks.read,
}));
vi.mock("@/lib/browserDurableWalletReceive", () => ({
  abortPreparedBrowserDurableWalletReceive: vi.fn(),
  bindPreparedBrowserDurableWalletReceiveOperation: mocks.bindReceive,
  prepareBrowserDurableWalletReceiveOperation: mocks.prepareReceive,
  receiveBrowserDurableWalletToken: mocks.receive,
}));
vi.mock("@/stores/proof-db", () => ({ getBoundedCanonicalSatProofs: vi.fn() }));
vi.mock("@/stores/wallet", () => ({ useWalletStore: { getState: () => ({ mints: [] }) } }));

import {
  executeBrowserBearerWithdrawal,
  reclaimBrowserBearerWithdrawal,
} from "../browserBearerWithdrawal";

describe("browser bearer withdrawal reclaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capture.mockReturnValue({
      scopeId: "scope",
      mnemonic: "test mnemonic",
      database: {} as never,
      seed: new Uint8Array(32),
      activeMintUrl: "https://mint.example",
      requireCapturedProfile: vi.fn(),
    });
    mocks.wallet.getKeyset.mockReturnValue({ id: `01${"11".repeat(32)}` });
    mocks.prepareReclaim.mockImplementation(({ transfer, reclaimId, walletReceiveOperation }) => ({
      ...transfer,
      deliveryState: "reclaim-prepared",
      reclaim: {
        reclaimId,
        proofs: transfer.token.unspentProofs,
        walletReceiveOperation,
      },
    }));
    mocks.completeReclaim.mockImplementation(({ transfer }) => ({
      ...transfer,
      deliveryState: "reclaimed",
    }));
  });

  it("marks all SPENT terminal without preparing or receiving", async () => {
    mocks.wallet.checkProofsStates.mockResolvedValue(states("SPENT", "SPENT"));
    mocks.classify.mockResolvedValue({ ...transfer(), deliveryState: "bearer-spent" });
    await expect(
      reclaimBrowserBearerWithdrawal({ transfer: transfer() as never }),
    ).resolves.toMatchObject({
      deliveryState: "bearer-spent",
    });
    expect(mocks.prepareReceive).not.toHaveBeenCalled();
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it("passes bearer withdrawal through the required funded preflight seam", async () => {
    mocks.execute.mockResolvedValue({ transferId: "withdrawal" });

    await executeBrowserBearerWithdrawal({ amount: 1, mintUrl: "https://mint.example" });

    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ preflightFundedAsset: expect.any(Function) }),
    );
  });

  it.each(["PENDING", "UNKNOWN", "MALFORMED"])(
    "retains authority for %s evidence without receiving",
    async (kind) => {
      mocks.wallet.checkProofsStates.mockResolvedValue(
        kind === "PENDING" ? states("PENDING", "SPENT") : [],
      );
      mocks.classify.mockResolvedValue({
        ...transfer(),
        token: { ...transfer().token, unspentProofs: null },
      });
      await reclaimBrowserBearerWithdrawal({ transfer: transfer() as never });
      expect(mocks.prepareReceive).not.toHaveBeenCalled();
      expect(mocks.receive).not.toHaveBeenCalled();
    },
  );

  it("keeps complete authority after a transport-indeterminate classification", async () => {
    mocks.wallet.checkProofsStates.mockRejectedValueOnce(new Error("transport failed"));
    await expect(reclaimBrowserBearerWithdrawal({ transfer: transfer() as never })).rejects.toThrow(
      "transport failed",
    );
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it("journals an all-UNSPENT reclaim before it executes the exact receive operation", async () => {
    const current = transfer();
    const unspent = current.token.proofs;
    mocks.wallet.checkProofsStates.mockResolvedValue(states("UNSPENT"));
    mocks.classify.mockResolvedValue({
      ...current,
      token: { ...current.token, unspentProofs: unspent },
    });
    const operation = { operationId: "bearer-reclaim:1", preview: { fees: "1" } };
    mocks.prepareReceive.mockResolvedValue(operation);
    await expect(
      reclaimBrowserBearerWithdrawal({ transfer: current as never }),
    ).resolves.toMatchObject({ deliveryState: "reclaim-prepared" });
    expect(mocks.prepareReclaim).toHaveBeenCalledWith(
      expect.objectContaining({ walletReceiveOperation: operation }),
    );
    expect(mocks.bindReceive).toHaveBeenCalledWith(expect.objectContaining({ operation }));
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it("reclaims only the exact unspent subset after a mixed result", async () => {
    const current = transferWithTwoProofs();
    const unspent = [current.token.proofs[1]];
    mocks.wallet.checkProofsStates.mockResolvedValue(states("SPENT", "UNSPENT"));
    mocks.classify.mockResolvedValue({
      ...current,
      deliveryState: "bearer-partial",
      token: { ...current.token, unspentProofs: unspent },
    });
    mocks.prepareReceive.mockResolvedValue({ operationId: "bearer-reclaim:partial" });
    await reclaimBrowserBearerWithdrawal({ transfer: current as never });

    expect(mocks.receive).not.toHaveBeenCalled();
    expect(mocks.prepareReclaim).toHaveBeenCalledWith(
      expect.objectContaining({
        transfer: expect.objectContaining({ deliveryState: "bearer-partial" }),
      }),
    );
  });

  it("reuses the persisted reclaim receive operation without NUT-07", async () => {
    const prepared = reclaimPreparedTransfer();
    mocks.prepareReceive.mockResolvedValue(prepared.reclaim!.walletReceiveOperation);
    mocks.receive.mockResolvedValue([{ id: `01${"11".repeat(32)}`, secret: "new", C: "C-new" }]);
    mocks.read.mockResolvedValue({ ...prepared, deliveryState: "reclaimed" });
    await reclaimBrowserBearerWithdrawal({ transfer: prepared as never });
    expect(mocks.wallet.checkProofsStates).not.toHaveBeenCalled();
    expect(mocks.receive).toHaveBeenCalledWith(expect.objectContaining({ skipBind: true }));
  });
});

function states(...state: string[]) {
  return state.map((value, index) => ({ Y: `Y-${index}`, state: value }));
}

function transfer(): Record<string, any> {
  return {
    transferId: "withdrawal",
    mintUrl: "https://mint.example",
    unit: "sat",
    deliveryState: "delivery-pending",
    token: {
      encodedToken: "cashuB-original",
      proofs: [
        {
          id: `01${"11".repeat(32)}`,
          amount: "1",
          secret: "one",
          C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
          dleq: null,
        },
      ],
      unspentProofs: null,
    },
  };
}

function transferWithTwoProofs(): Record<string, any> {
  const current = transfer();
  return {
    ...current,
    token: {
      ...current.token,
      proofs: [
        ...current.token.proofs,
        {
          ...current.token.proofs[0],
          secret: "two",
          C: "02c6047f9441ed7d6d3045406e95c07cd85aecd1cbdc9c778e4b8cef3ca7abac09",
        },
      ],
    },
  };
}

function reclaimPreparedTransfer(): Record<string, any> {
  return {
    ...transfer(),
    deliveryState: "reclaim-prepared",
    reclaim: {
      reclaimId: "reclaim",
      proofs: [
        {
          id: `01${"11".repeat(32)}`,
          amount: "1",
          secret: "one",
          C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
          dleq: null,
        },
      ],
      walletReceiveOperation: { operationId: "reclaim" },
    },
  };
}
