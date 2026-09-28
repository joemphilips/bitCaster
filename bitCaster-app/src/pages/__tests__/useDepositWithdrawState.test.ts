import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useDepositWithdrawState } from "../useDepositWithdrawState";
import { useWalletStore } from "@/stores/wallet";
import { useActivityLogStore } from "@/stores/activity-log";
import { usePaymentRequestInbox } from "@/stores/paymentRequestInbox";
import { useToastStore } from "@/stores/toast";
import {
  browserWalletScopeIdFromMnemonic,
  browserWalletIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "@/lib/browserWalletProfile";

// Mock cashu.ts — we don't want real mint calls
vi.mock("@/lib/cashu", () => ({
  encodeToken: vi.fn().mockReturnValue("cashuAtoken123"),
  sendProofs: vi.fn().mockResolvedValue({ keep: [], send: [{ secret: "s1", amount: 100 }] }),
  createMeltQuote: vi.fn(),
  meltProofs: vi.fn(),
}));

const executeBrowserBearerWithdrawal = vi.fn();
const resumeBrowserBearerWithdrawal = vi.fn();
const reclaimBrowserBearerWithdrawal = vi.fn();
const classifyBrowserBearerWithdrawal = vi.fn();
const browserBearerReclaimFeeDisclosure = vi.fn();

vi.mock("@/lib/browserBearerWithdrawal", () => ({
  executeBrowserBearerWithdrawal: (...args: unknown[]) => executeBrowserBearerWithdrawal(...args),
  resumeBrowserBearerWithdrawal: (...args: unknown[]) => resumeBrowserBearerWithdrawal(...args),
  reclaimBrowserBearerWithdrawal: (...args: unknown[]) => reclaimBrowserBearerWithdrawal(...args),
  classifyBrowserBearerWithdrawal: (...args: unknown[]) => classifyBrowserBearerWithdrawal(...args),
  browserBearerReclaimFeeDisclosure: (...args: unknown[]) =>
    browserBearerReclaimFeeDisclosure(...args),
}));

const createBrowserDurableBolt11MintQuote = vi.fn();
const subscribeActiveBrowserDurableBolt11MintQuote = vi.fn();
const hideBrowserDurableBolt11MintQuote = vi.fn();

vi.mock("@/lib/browserDurableBolt11MintQuote", () => ({
  createBrowserDurableBolt11MintQuote: (...args: unknown[]) =>
    createBrowserDurableBolt11MintQuote(...args),
  subscribeActiveBrowserDurableBolt11MintQuote: (...args: unknown[]) =>
    subscribeActiveBrowserDurableBolt11MintQuote(...args),
  hideBrowserDurableBolt11MintQuote: (...args: unknown[]) =>
    hideBrowserDurableBolt11MintQuote(...args),
}));

vi.mock("@/lib/walletOps", () => ({
  ingressReceiveCashuToken: vi.fn().mockResolvedValue({
    added: false,
    mintUrl: "http://localhost:8085",
    source: "paste",
    unit: "msat",
    amountSubunits: 0,
    baseAsset: "sat",
    proofs: [],
  }),
  userCreatePaymentRequest: vi.fn().mockReturnValue({
    encoded: "creq1test",
    id: "req1",
    request: {},
  }),
}));

// Mock proof-db
vi.mock("@/stores/proof-db", () => ({
  db: {
    proofs: {
      toArray: vi.fn().mockResolvedValue([]),
      where: vi.fn().mockReturnThis(),
      equals: vi.fn().mockReturnThis(),
    },
  },
  getCanonicalSelectableProofs: vi
    .fn()
    .mockResolvedValue([
      { secret: "s1", amount: 100, mintUrl: "http://localhost:8085", id: "id1", C: "C1" },
    ]),
  isCtfProof: vi.fn().mockReturnValue(false),
  addProofs: vi.fn().mockResolvedValue(undefined),
  removeProofs: vi.fn().mockResolvedValue(undefined),
}));

// Mock dexie-react-hooks — useLiveQuery returns balances keyed by mint URL
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: vi.fn().mockReturnValue({ "http://localhost:8085": 5000 }),
}));

// Mock nip17 — we don't want real Nostr calls
vi.mock("@/lib/nip17", () => ({
  deriveNostrKeyPair: vi.fn().mockReturnValue({
    privateKey: new Uint8Array(32),
    privateKeyHex: "0".repeat(64),
    publicKey: "1".repeat(64),
  }),
  getNostrNprofile: vi.fn().mockReturnValue("nprofile1test"),
  subscribeNip17DMs: vi.fn().mockReturnValue(() => {}),
}));

beforeEach(() => {
  classifyBrowserBearerWithdrawal.mockReset();
  classifyBrowserBearerWithdrawal.mockImplementation(({ transfer }) => Promise.resolve(transfer));
  browserBearerReclaimFeeDisclosure.mockReset();
  createBrowserDurableBolt11MintQuote.mockReset();
  createBrowserDurableBolt11MintQuote.mockResolvedValue(durableQuote());
  subscribeActiveBrowserDurableBolt11MintQuote.mockReset();
  subscribeActiveBrowserDurableBolt11MintQuote.mockResolvedValue(() => undefined);
  hideBrowserDurableBolt11MintQuote.mockReset();
  hideBrowserDurableBolt11MintQuote.mockResolvedValue(undefined);
  executeBrowserBearerWithdrawal.mockReset();
  executeBrowserBearerWithdrawal.mockResolvedValue(bearerTransfer());
  resumeBrowserBearerWithdrawal.mockReset();
  resumeBrowserBearerWithdrawal.mockResolvedValue(null);
  reclaimBrowserBearerWithdrawal.mockReset();
  useActivityLogStore.getState().clear();
  useWalletStore.setState({
    mnemonic:
      "test words here abandon abandon abandon abandon abandon abandon abandon abandon abandon",
    setupComplete: true,
    mints: [{ url: "http://localhost:8085", info: { name: "Test Mint" } }],
    activeMintUrl: "http://localhost:8085",
    mintConnectionStatuses: {},
  });
  setActiveBrowserWalletProfile(useWalletStore.getState().mnemonic);
  useToastStore.setState({ toasts: [] });
});

describe("useDepositWithdrawState", () => {
  const onDismiss = vi.fn();

  describe("initial state", () => {
    it("starts with chooser view for deposit mode", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      expect(result.current.mode).toBe("deposit");
      expect(result.current.currentView).toBe("chooser");
      expect(result.current.amountSats).toBe(0);
    });

    it("starts with chooser view for withdraw mode", () => {
      const { result } = renderHook(() => useDepositWithdrawState("withdraw", onDismiss));
      expect(result.current.mode).toBe("withdraw");
      expect(result.current.currentView).toBe("chooser");
    });

    it("populates mints from wallet store", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      expect(result.current.mints).toHaveLength(1);
      expect(result.current.mints[0].url).toBe("http://localhost:8085");
    });
  });

  describe("onSelectMethod", () => {
    it("navigates to deposit-lightning when selecting lightning in deposit mode", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onSelectMethod("lightning"));
      expect(result.current.currentView).toBe("deposit-lightning");
    });

    it("navigates to deposit-ecash when selecting ecash in deposit mode", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onSelectMethod("ecash"));
      expect(result.current.currentView).toBe("deposit-ecash");
    });

    it("navigates to send-ecash when selecting ecash in withdraw mode", () => {
      const { result } = renderHook(() => useDepositWithdrawState("withdraw", onDismiss));
      act(() => result.current.onSelectMethod("ecash"));
      expect(result.current.currentView).toBe("send-ecash");
    });

    it("navigates to pay-lightning when selecting lightning in withdraw mode", () => {
      const { result } = renderHook(() => useDepositWithdrawState("withdraw", onDismiss));
      act(() => result.current.onSelectMethod("lightning"));
      expect(result.current.currentView).toBe("pay-lightning");
    });
  });

  describe("onNumpadPress", () => {
    it("builds amount from digit presses", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onNumpadPress("1"));
      act(() => result.current.onNumpadPress("0"));
      act(() => result.current.onNumpadPress("0"));
      expect(result.current.amountSats).toBe(100);
    });

    it("removes last digit on backspace", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onNumpadPress("1"));
      act(() => result.current.onNumpadPress("2"));
      act(() => result.current.onNumpadPress("3"));
      act(() => result.current.onNumpadPress("backspace"));
      expect(result.current.amountSats).toBe(12);
    });

    it("stays at 0 when backspacing from 0", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onNumpadPress("backspace"));
      expect(result.current.amountSats).toBe(0);
    });

    it("backspace on single digit returns to 0", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onNumpadPress("5"));
      act(() => result.current.onNumpadPress("backspace"));
      expect(result.current.amountSats).toBe(0);
    });

    it("prevents leading zeros", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onNumpadPress("0"));
      expect(result.current.amountSats).toBe(0);
      act(() => result.current.onNumpadPress("0"));
      expect(result.current.amountSats).toBe(0);
    });

    it("accepts up to three fractional sat digits and ignores further digits", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      for (const key of ["1", ".", "0", "0", "1", "9"]) {
        act(() => result.current.onNumpadPress(key));
      }
      expect(result.current.amountSats).toBe(1.001);
    });

    it("accepts a leading decimal as zero point zero zero one sat", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      for (const key of [".", "0", "0", "1"]) {
        act(() => result.current.onNumpadPress(key));
      }
      expect(result.current.amountSats).toBe(0.001);
    });

    it("ignores a repeated decimal key", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      for (const key of ["1", ".", ".", "0"]) {
        act(() => result.current.onNumpadPress(key));
      }
      expect(result.current.amountSats).toBe(1);
    });

    it("does not expose an incomplete decimal as a sendable amount", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      for (const key of ["1", "."]) {
        act(() => result.current.onNumpadPress(key));
      }
      expect(result.current.amountSats).toBe(0);
    });
  });

  describe("onBack", () => {
    it("returns to chooser view", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onSelectMethod("lightning"));
      expect(result.current.currentView).toBe("deposit-lightning");
      act(() => result.current.onBack());
      expect(result.current.currentView).toBe("chooser");
    });

    it("returns from scanner to the previous view", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onSelectMethod("ecash"));
      expect(result.current.currentView).toBe("deposit-ecash");
      act(() => result.current.onScan());
      expect(result.current.currentView).toBe("scanner");
      act(() => result.current.onBack());
      expect(result.current.currentView).toBe("deposit-ecash");
    });

    it("returns from payment request to deposit-ecash", async () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onSelectMethod("ecash"));
      await act(async () => {
        await result.current.onRequest();
      });
      expect(result.current.currentView).toBe("payment-request-display");
      act(() => result.current.onBack());
      expect(result.current.currentView).toBe("deposit-ecash");
    });
  });

  describe("onClose", () => {
    it("calls onDismiss", async () => {
      const dismiss = vi.fn();
      const { result } = renderHook(() => useDepositWithdrawState("deposit", dismiss));
      act(() => result.current.onClose());
      await act(async () => Promise.resolve());
      expect(dismiss).toHaveBeenCalledOnce();
    });
  });

  describe("scan feature", () => {
    it("onScan navigates to scanner view", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onSelectMethod("ecash"));
      act(() => result.current.onScan());
      expect(result.current.currentView).toBe("scanner");
    });

    it("onScanQR navigates to scanner view", () => {
      const { result } = renderHook(() => useDepositWithdrawState("withdraw", onDismiss));
      act(() => result.current.onSelectMethod("lightning"));
      act(() => result.current.onScanQR());
      expect(result.current.currentView).toBe("scanner");
    });

    it("onScanResult with unknown data sets error", async () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onSelectMethod("ecash"));
      act(() => result.current.onScan());
      await act(async () => {
        await result.current.onScanResult("random-text");
      });
      expect(result.current.error).toMatch(/unrecognized/i);
    });

    it("routes the exact scanned Cashu token through durable ingress", async () => {
      const walletOps = await import("@/lib/walletOps");
      const ingress = vi.mocked(walletOps.ingressReceiveCashuToken);
      ingress.mockClear();
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));

      await act(async () => {
        await result.current.onScanResult("cashuB-animated-token");
      });

      expect(ingress).toHaveBeenCalledOnce();
      expect(ingress).toHaveBeenCalledWith("cashuB-animated-token", "scan");
    });
  });

  describe("request feature", () => {
    it.each([true, false])(
      "shows confirmed request receipt only for the active wallet: %s",
      async (sameWallet) => {
        const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
        await act(async () => {
          await result.current.onRequest();
        });
        expect(result.current.currentView).toBe("payment-request-display");
        expect(result.current.paymentRequestEncoded).toBeTruthy();
        expect(result.current.paymentRequestStatus).toBe("waiting");
        const scope = browserWalletScopeIdFromMnemonic(useWalletStore.getState().mnemonic)!;
        const receivedScope = sameWallet
          ? scope
          : browserWalletScopeIdFromMnemonic(
              "legal winner thank year wave sausage worth useful legal winner thank yellow",
            )!;
        usePaymentRequestInbox
          .getState()
          .registerPending("req1", "http://localhost:8085", receivedScope);
        act(() =>
          usePaymentRequestInbox.getState().markReceived("req1", 1_001, "sat", receivedScope),
        );
        expect(result.current.currentView).toBe(sameWallet ? "success" : "payment-request-display");
        expect(result.current.successAmountMsat).toBe(sameWallet ? 1_001 : 0);
        expect(onDismiss).not.toHaveBeenCalled();
        expect(usePaymentRequestInbox.getState().entries.req1 !== undefined).toBe(!sameWallet);
        usePaymentRequestInbox.getState().clear("req1");
      },
    );
  });

  describe("onMintChange", () => {
    it("updates selectedMintId for a registered mint", () => {
      useWalletStore.setState({
        mints: [
          { url: "http://localhost:8085", info: { name: "Test Mint" } },
          { url: "http://localhost:8086", info: { name: "Second Mint" } },
        ],
      });
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onMintChange("http://localhost:8086"));
      expect(result.current.selectedMintId).toBe("http://localhost:8086");
    });

    it("falls back to the active mint when the selected mint is no longer registered", () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onMintChange("unknown-mint"));
      expect(result.current.selectedMintId).toBe("http://localhost:8085");
    });
  });

  describe("onCreateInvoice — durable BOLT11 authority", () => {
    it("sets an invoice only after the coordinator commits it and suppresses rapid double-fire", async () => {
      let resolveQuote: (value: ReturnType<typeof durableQuote>) => void;
      createBrowserDurableBolt11MintQuote.mockImplementationOnce(
        () => new Promise((resolve) => (resolveQuote = resolve)),
      );
      const { result } = renderHook(() => useDepositWithdrawState("deposit", vi.fn()));
      act(() => result.current.onSelectMethod("lightning"));
      for (const key of ["1", "0", "0", "0"]) act(() => result.current.onNumpadPress(key));

      act(() => {
        result.current.onCreateInvoice();
        result.current.onCreateInvoice();
      });
      await act(async () => Promise.resolve());
      expect(result.current.bolt11).toBeNull();
      expect(createBrowserDurableBolt11MintQuote).toHaveBeenCalledOnce();
      expect(createBrowserDurableBolt11MintQuote).toHaveBeenCalledWith({
        amount: 1_000_000,
        mintUrl: "http://localhost:8085",
        unit: "msat",
      });

      await act(async () => resolveQuote!(durableQuote()));
      expect(result.current.bolt11).toBe("lnbc1durable");
      expect(subscribeActiveBrowserDurableBolt11MintQuote).toHaveBeenCalledOnce();
    });

    it("shows deposit success and activity only after the coordinator reports admitted PAID", async () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", vi.fn()));
      act(() => result.current.onSelectMethod("lightning"));
      act(() => result.current.onNumpadPress("1"));
      act(() => result.current.onNumpadPress("0"));
      await act(async () => result.current.onCreateInvoice());
      const onResult = subscribeActiveBrowserDurableBolt11MintQuote.mock.calls[0][0].onResult;

      expect(useActivityLogStore.getState().items).toHaveLength(0);
      act(() => onResult({ status: "PAID" }));
      expect(result.current.currentView).toBe("success");
      expect(useActivityLogStore.getState().items[0]).toMatchObject({
        type: "deposit",
        amountSubunits: 10_000,
        walletId: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    });

    it("hides the prior durable quote before one-click re-quote", async () => {
      const { result } = renderHook(() => useDepositWithdrawState("deposit", vi.fn()));
      act(() => result.current.onSelectMethod("lightning"));
      act(() => result.current.onNumpadPress("1"));
      await act(async () => result.current.onCreateInvoice());
      await act(async () => result.current.onRegenerateInvoice());

      expect(hideBrowserDurableBolt11MintQuote).toHaveBeenCalledWith("a".repeat(64));
      expect(createBrowserDurableBolt11MintQuote).toHaveBeenCalledTimes(2);
    });

    it("hides a quote that resolves after the user closes the deposit view", async () => {
      let resolveQuote: (value: ReturnType<typeof durableQuote>) => void;
      createBrowserDurableBolt11MintQuote.mockImplementationOnce(
        () => new Promise((resolve) => (resolveQuote = resolve)),
      );
      const { result } = renderHook(() => useDepositWithdrawState("deposit", vi.fn()));
      act(() => result.current.onSelectMethod("lightning"));
      act(() => result.current.onNumpadPress("1"));
      act(() => {
        void result.current.onCreateInvoice();
      });
      await act(async () => Promise.resolve());
      act(() => result.current.onClose());

      await act(async () => resolveQuote!(durableQuote()));
      expect(hideBrowserDurableBolt11MintQuote).toHaveBeenCalledWith("a".repeat(64));
      expect(subscribeActiveBrowserDurableBolt11MintQuote).not.toHaveBeenCalled();
      expect(result.current.bolt11).toBeNull();
    });
  });

  describe("onPaste — ecash from unknown mint", () => {
    it("routes durable redemption and storage through walletOps", async () => {
      const walletOps = await import("@/lib/walletOps");
      vi.mocked(walletOps.ingressReceiveCashuToken).mockResolvedValueOnce({
        added: true,
        mintUrl: "https://testnut.cashu.space",
        source: "paste",
        unit: "msat",
        amountSubunits: 50_000,
        baseAsset: "sat",
        proofs: [
          {
            secret: "s-new",
            amount: 50_000,
            id: "kid-B",
            C: "C",
            conditionId: "condition-1",
            outcomeCollection: "B",
            marketId: "condition-1-B",
          } as never,
        ],
      });
      // navigator.clipboard isn't in jsdom by default — install a stub.
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: vi.fn().mockResolvedValue("cashuB-token-from-unknown-mint") },
      });

      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onSelectMethod("ecash"));
      expect(result.current.currentView).toBe("deposit-ecash");

      await act(async () => {
        await result.current.onPaste();
      });

      expect(walletOps.ingressReceiveCashuToken).toHaveBeenCalledWith(
        "cashuB-token-from-unknown-mint",
        "paste",
      );
      expect(result.current.currentView).toBe("success");
      expect(result.current.successAmountMsat).toBe(50_000);
      expect(result.current.error).toBeNull();
      expect(useActivityLogStore.getState().items[0]).toMatchObject({
        amountSubunits: 50_000,
        walletId: expect.stringMatching(/^[0-9a-f]{64}$/),
        baseAsset: "sat",
      });
    });

    it.each(["paste", "scan"] as const)(
      "retains a completed %s receive under its captured wallet but suppresses stale presentation",
      async (source) => {
        const walletOps = await import("@/lib/walletOps");
        let finishIngress!: (value: never) => void;
        vi.mocked(walletOps.ingressReceiveCashuToken).mockImplementationOnce(
          () => new Promise((resolve) => (finishIngress = resolve)) as never,
        );
        const capturedWalletId = browserWalletIdFromMnemonic(useWalletStore.getState().mnemonic);
        const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
        act(() => result.current.onSelectMethod("ecash"));
        let paste!: Promise<void>;
        await act(async () => {
          if (source === "paste") {
            Object.defineProperty(navigator, "clipboard", {
              configurable: true,
              value: { readText: vi.fn().mockResolvedValue("cashuB-token") },
            });
            paste = result.current.onPaste() as unknown as Promise<void>;
          } else {
            paste = result.current.onScanResult("cashuB-token") as unknown as Promise<void>;
          }
          await Promise.resolve();
        });
        const newMnemonic =
          "legal winner thank year wave sausage worth useful legal winner thank yellow";
        act(() => useWalletStore.setState({ mnemonic: newMnemonic }));
        setActiveBrowserWalletProfile(newMnemonic);
        await act(async () => {
          finishIngress({
            added: true,
            mintUrl: "http://localhost:8085",
            source,
            unit: "msat",
            amountSubunits: 42_000,
            baseAsset: "sat",
            proofs: [],
          } as never);
          await paste;
        });

        expect(useActivityLogStore.getState().items).toEqual([
          expect.objectContaining({ walletId: capturedWalletId, amountSubunits: 42_000 }),
        ]);
        expect(
          useToastStore
            .getState()
            .toasts.some((toast) => toast.message.startsWith("Added new mint:")),
        ).toBe(false);
        expect(result.current.currentView).toBe("deposit-ecash");
        expect(result.current.isLoading).toBe(false);
      },
    );

    it("reports the durable receiver unit in the success state", async () => {
      const walletOps = await import("@/lib/walletOps");
      vi.mocked(walletOps.ingressReceiveCashuToken).mockResolvedValueOnce({
        added: false,
        mintUrl: "https://usd.mint",
        source: "paste",
        unit: "msat",
        amountSubunits: 23,
        baseAsset: "sat",
        proofs: [{ secret: "s-usd", amount: 23, id: "usd-kid", C: "C" } as never],
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: vi.fn().mockResolvedValue("cashuB-usd-token") },
      });

      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onSelectMethod("ecash"));
      await act(async () => {
        await result.current.onPaste();
      });

      expect(result.current.successBaseAsset).toBe("sat");
      expect(useActivityLogStore.getState().items[0]).toMatchObject({
        amountSubunits: 23,
        walletId: expect.stringMatching(/^[0-9a-f]{64}$/),
        baseAsset: "sat",
      });
    });

    it("surfaces walletOps receive errors to the red banner without swallowing", async () => {
      const walletOps = await import("@/lib/walletOps");
      vi.mocked(walletOps.ingressReceiveCashuToken).mockRejectedValueOnce(
        new Error("Token already spent"),
      );
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: vi.fn().mockResolvedValue("cashuB-spent") },
      });

      const { result } = renderHook(() => useDepositWithdrawState("deposit", onDismiss));
      act(() => result.current.onSelectMethod("ecash"));
      await act(async () => {
        await result.current.onPaste();
      });

      expect(result.current.error).toBe("Token already spent");
    });
  });

  describe("onLightningInputChange", () => {
    it("updates lightningInput for non-invoice text", async () => {
      const { result } = renderHook(() => useDepositWithdrawState("withdraw", onDismiss));
      await act(async () => {
        await result.current.onLightningInputChange("some-text");
      });
      expect(result.current.lightningInput).toBe("some-text");
    });

    it("auto-creates melt quote when bolt11 invoice is entered", async () => {
      const cashu = await import("@/lib/cashu");
      const mockQuote = {
        quote: "q1",
        amount: 1000,
        fee_reserve: 10,
        state: "UNPAID",
        expiry: 0,
        payment_preimage: null,
      };
      vi.mocked(cashu.createMeltQuote).mockResolvedValueOnce(mockQuote as never);

      const { result } = renderHook(() => useDepositWithdrawState("withdraw", onDismiss));
      // First navigate to pay-lightning view (bolt11 detection only fires from input change)
      act(() => result.current.onSelectMethod("lightning"));
      expect(result.current.currentView).toBe("pay-lightning");

      await act(async () => {
        await result.current.onLightningInputChange("lnbc100n1pexample");
      });
      expect(result.current.lightningInput).toBe("lnbc100n1pexample");
      expect(cashu.createMeltQuote).toHaveBeenCalledWith("lnbc100n1pexample", expect.any(String));
      expect(result.current.currentView).toBe("melt-confirm");
    });
  });

  describe("msat withdrawal with sats display", () => {
    it.each([
      ["50", 50_000],
      ["1.001", 1_001],
    ])("sends %s sats as exactly %s msat only after Send", async (input, amountMsat) => {
      const { result } = renderHook(() => useDepositWithdrawState("withdraw", onDismiss));
      act(() => result.current.onSelectMethod("ecash"));
      act(() => {
        for (const key of input) result.current.onNumpadPress(key);
      });

      await act(async () => {
        await result.current.onSendEcash();
      });

      expect(executeBrowserBearerWithdrawal).toHaveBeenCalledWith({
        amountMsat,
        mintUrl: "http://localhost:8085",
      });
      expect(result.current.ecashToken).toBe("cashuAtoken123");
      expect(result.current.currentView).toBe("token-display");
    });

    it.each([
      ["50000", 50],
      ["1001", 1.001],
    ])("resumes %s msat as %s sats without a new send", async (requestedAmount, amountSats) => {
      const transfer = { ...bearerTransfer(), requestedAmount };
      resumeBrowserBearerWithdrawal.mockResolvedValueOnce(transfer);
      classifyBrowserBearerWithdrawal.mockResolvedValueOnce({
        ...transfer,
        token: { ...transfer.token, unspentProofs: transfer.token.proofs },
      });
      const { result } = renderHook(() => useDepositWithdrawState("withdraw", onDismiss));
      act(() => result.current.onSelectMethod("ecash"));
      await act(async () => undefined);
      expect(result.current.ecashToken).toBe("cashuAtoken123");
      expect(result.current.amountSats).toBe(amountSats);
      expect(executeBrowserBearerWithdrawal).not.toHaveBeenCalled();
      expect(result.current.currentView).toBe("token-display");
      const pendingTransfer = result.current.bearerWithdrawal;
      act(() => result.current.onAcknowledgeEcashHandoff());
      expect(result.current.currentView).toBe("success");
      expect(result.current.successAmountMsat).toBe(Number(requestedAmount));
      expect(result.current.bearerWithdrawal).toBe(pendingTransfer);
      expect(result.current.ecashToken).toBe("cashuAtoken123");
      expect(reclaimBrowserBearerWithdrawal).not.toHaveBeenCalled();
    });

    it("does not present a stale resumed token after the mint changes", async () => {
      let resolveResume: (value: unknown) => void = () => undefined;
      resumeBrowserBearerWithdrawal.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
      );
      const { result } = renderHook(() => useDepositWithdrawState("withdraw", onDismiss));
      act(() => result.current.onSelectMethod("ecash"));
      act(() => result.current.onMintChange("https://other-mint.example"));
      await act(async () => {
        resolveResume(bearerTransfer());
      });
      expect(result.current.ecashToken).toBeNull();
    });

    it("never redisplays a partial token after explicit reclaim", async () => {
      const transfer = bearerTransfer();
      reclaimBrowserBearerWithdrawal.mockResolvedValueOnce({
        ...transfer,
        deliveryState: "bearer-partial",
        token: { ...transfer.token, unspentProofs: [] },
      });
      const { result } = renderHook(() => useDepositWithdrawState("withdraw", onDismiss));
      act(() => result.current.onSelectMethod("ecash"));
      await act(async () => undefined);
      await act(async () => {
        await result.current.onReclaimEcash();
      });
      expect(result.current.ecashToken).toBeNull();
      expect(result.current.currentView).toBe("send-ecash");
    });

    it.each(["paid", "unpaid", "error"] as const)(
      "shows melt success only for confirmed payment: %s",
      async (outcome) => {
        const proofDb = await import("@/stores/proof-db");
        const cashu = await import("@/lib/cashu");
        vi.mocked(cashu.createMeltQuote).mockResolvedValueOnce({
          quote: "q1",
          amount: 1000,
          fee_reserve: 10,
          state: "UNPAID",
          expiry: 0,
          payment_preimage: null,
        } as never);
        if (outcome === "error") {
          vi.mocked(cashu.meltProofs).mockRejectedValueOnce(
            new Error("Payment status unavailable"),
          );
        } else {
          vi.mocked(cashu.meltProofs).mockResolvedValueOnce({
            paid: outcome === "paid",
            change: [],
          } as never);
        }

        const { result } = renderHook(() => useDepositWithdrawState("withdraw", onDismiss));
        act(() => result.current.onSelectMethod("lightning"));
        await act(async () => {
          await result.current.onLightningInputChange("lnbc100n1pexample");
        });
        await act(async () => {
          await result.current.onConfirmMelt();
        });

        expect(proofDb.getCanonicalSelectableProofs).not.toHaveBeenCalled();
        expect(proofDb.addProofs).not.toHaveBeenCalled();
        expect(proofDb.removeProofs).not.toHaveBeenCalled();
        expect(result.current.currentView).toBe(outcome === "paid" ? "success" : "melt-confirm");
        expect(result.current.successAmountMsat).toBe(outcome === "paid" ? 1_000 : 0);
        expect(result.current.successBaseAsset).toBe("sat");
        expect(useActivityLogStore.getState().items).toEqual(
          outcome === "paid"
            ? [
                expect.objectContaining({
                  type: "withdrawal",
                  amountSubunits: 1_000,
                  walletId: expect.stringMatching(/^[0-9a-f]{64}$/),
                  baseAsset: "sat",
                }),
              ]
            : [],
        );
        expect(cashu.meltProofs).toHaveBeenCalledWith(expect.any(Object), "http://localhost:8085");
      },
    );
  });
});

function bearerTransfer(): {
  token: { encodedToken: string; unspentProofs: null; proofs: readonly unknown[] };
} & Record<string, unknown> {
  return {
    transferId: "bearer-withdrawal:test",
    walletScopeId: browserWalletScopeIdFromMnemonic(useWalletStore.getState().mnemonic),
    mintUrl: "http://localhost:8085",
    unit: "msat",
    requestedAmount: "50000",
    deliveryState: "delivery-pending",
    token: { encodedToken: "cashuAtoken123", unspentProofs: null, proofs: [] },
  };
}

function durableQuote() {
  return {
    invoiceRequest: "lnbc1durable",
    quote: {
      quoteRecordId: "a".repeat(64),
      expiryUnixSeconds: 123,
    },
  };
}
