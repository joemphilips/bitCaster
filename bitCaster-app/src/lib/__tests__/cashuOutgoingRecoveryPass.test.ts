import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const wallet = { tokenPresentation: vi.fn() };
  const getWalletForMnemonicUnit = vi.fn(async () => wallet);
  const listDueMints = vi.fn(async () => ({
    mints: ["https://mint.due.example"],
    hasMore: true,
  }));
  const recoverDuePage = vi.fn(async (input: any) => {
    await input.walletForMint("https://mint.due.example", "sat");
    await input.walletForMint("https://mint.due.example", "sat");
    return {
      failed: 2,
      storedBytes: 1,
      transfers: [],
      nextCursor: null,
    };
  });
  return { wallet, getWalletForMnemonicUnit, listDueMints, recoverDuePage };
});

vi.mock("@/stores/wallet", () => ({
  getWalletForMnemonicUnit: mocks.getWalletForMnemonicUnit,
  useWalletStore: { getState: () => ({ mnemonic: "seed words" }) },
}));

vi.mock("@/lib/browserWalletProfile", () => ({
  activeBrowserWalletScopeId: () => "custody:wallet:test",
  browserWalletScopeIdFromMnemonic: () => "custody:wallet:test",
}));

vi.mock("@/lib/bip39", () => ({ toSeed: () => new Uint8Array(64) }));

vi.mock("@/lib/browserDurableOutgoingCashuTransfer", () => ({
  listBrowserDurableOutgoingCashuDueMints: mocks.listDueMints,
  recoverBrowserDurableOutgoingCashuDuePage: mocks.recoverDuePage,
}));

import { recoverBrowserDurableOutgoingCashuTransfersInPass } from "../cashu";

describe("outgoing Cashu startup recovery pass", () => {
  beforeEach(() => {
    mocks.getWalletForMnemonicUnit.mockClear();
    mocks.listDueMints.mockClear();
    mocks.recoverDuePage.mockClear();
    mocks.wallet.tokenPresentation.mockClear();
  });

  it("runs exact recovery with no cursor, no token presentation, and reports pending work", async () => {
    const result = await recoverBrowserDurableOutgoingCashuTransfersInPass({
      mintUrls: ["https://mint.due.example"],
      passCutoffMs: 10,
    });

    expect(mocks.listDueMints).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: "custody:wallet:test", dueBeforeMs: 10 }),
    );
    expect(mocks.recoverDuePage).toHaveBeenCalledWith(
      expect.objectContaining({
        mintUrl: "https://mint.due.example",
        dueBeforeMs: 10,
        cursor: null,
      }),
    );
    expect(mocks.getWalletForMnemonicUnit).toHaveBeenCalledOnce();
    expect(mocks.getWalletForMnemonicUnit).toHaveBeenCalledWith(
      "https://mint.due.example",
      "sat",
      "seed words",
    );
    expect(mocks.wallet.tokenPresentation).not.toHaveBeenCalled();
    expect(result).toEqual({ pending: 2, hasMore: true });
  });
});
