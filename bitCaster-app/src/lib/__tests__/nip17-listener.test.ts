import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Nip17MessageCallback = (content: string, senderPubkey: string) => void;
type SubscribeNip17DMs = (
  privateKeyHex: string,
  publicKey: string,
  onMessage: Nip17MessageCallback,
  relays?: string[],
) => Promise<() => void>;

// Hoisted state so `vi.mock` factories (which are hoisted above imports)
// can close over live references.
const mocks = vi.hoisted(() => {
  const walletState: {
    mints: { url: string }[];
    mnemonic: string;
  } = {
    mints: [],
    mnemonic: "",
  };
  return {
    walletState,
    markReceivedSpy: vi.fn(),
    subscribeNip17DMs: vi.fn<SubscribeNip17DMs>(async () => () => {}),
    encodeToken: vi.fn(
      (proofs: unknown[], mintUrl: string, _unit?: string) =>
        `token:${mintUrl}:${(proofs as { amount: number }[]).reduce((s, p) => s + p.amount, 0)}`,
    ),
    ingressReceiveCashuToken: vi.fn(
      async (
        _token: string,
        _source: string,
        options?: { mintUrl?: string },
      ) => ({
        added: !walletState.mints.some((m) => m.url === options?.mintUrl),
        mintUrl: options?.mintUrl ?? "http://mint.example",
        source: "nip17",
        amountSats: 42,
        proofs: [{ secret: "rotated-1", amount: 42, id: "kid", C: "C" }],
      }),
    ),
  };
});

vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => mocks.walletState,
  },
}));

vi.mock("@/stores/paymentRequestInbox", () => ({
  usePaymentRequestInbox: {
    getState: () => ({ markReceived: mocks.markReceivedSpy }),
  },
}));

vi.mock("../cashu", () => ({
  encodeToken: mocks.encodeToken,
}));

vi.mock("../walletOps", () => ({
  ingressReceiveCashuToken: mocks.ingressReceiveCashuToken,
  parseInboundCashuUnit: (value: unknown) => {
    if (value === undefined) return "sat";
    if (value === "sat" || value === "msat" || value === "usd") return value;
    throw new Error("Unsupported Cashu token unit");
  },
}));

vi.mock("../nip17", () => ({
  deriveNostrKeyPair: vi.fn(() => ({
    privateKey: new Uint8Array(32),
    privateKeyHex: "00".repeat(32),
    publicKey: "11".repeat(32),
  })),
  subscribeNip17DMs: mocks.subscribeNip17DMs,
}));

import {
  __getNip17ListenerHandleForTests,
  __handleIncomingDMForTests,
  __resetProcessedEventsForTests,
  startNip17Listener,
  stopNip17Listener,
} from "../nip17-listener";

beforeEach(() => {
  stopNip17Listener();
  mocks.walletState.mints = [];
  mocks.walletState.mnemonic = "";
  // Reset all hoisted spies but preserve their identity so the mock is
  // still wired to the listener module's imports.
  mocks.markReceivedSpy.mockClear();
  mocks.encodeToken.mockClear();
  mocks.ingressReceiveCashuToken.mockClear();
  mocks.subscribeNip17DMs.mockReset();
  mocks.subscribeNip17DMs.mockResolvedValue(() => {});
  __resetProcessedEventsForTests();
});

afterEach(() => {
  stopNip17Listener();
});

describe("nip17-listener", () => {
  it("normalizes payload mint URL and stores proofs under the canonical value", async () => {
    mocks.walletState.mints = [{ url: "http://mint.example" }];
    mocks.ingressReceiveCashuToken.mockResolvedValueOnce({
      added: false,
      mintUrl: "http://mint.example",
      source: "nip17",
      amountSats: 42,
      proofs: [
        {
          secret: "rotated-1",
          amount: 42,
          id: "kid-B",
          C: "C",
          conditionId: "condition-1",
          outcomeCollection: "B",
          marketId: "condition-1-B",
        } as never,
      ],
    });

    const payload = {
      id: "req-1",
      mint: "http://mint.example/", // trailing slash — would fail exact-match
      unit: "sat",
      proofs: [{ secret: "s1", amount: 42, id: "kid", C: "C" }],
    };
    await __handleIncomingDMForTests(JSON.stringify(payload));

    expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledWith(
      "token:http://mint.example:42",
      "nip17",
      {
        mintUrl: "http://mint.example",
      },
    );
    expect(mocks.encodeToken).toHaveBeenCalledWith(
      payload.proofs,
      "http://mint.example",
      "sat",
    );
    expect(mocks.markReceivedSpy).toHaveBeenCalledWith("req-1", 42);
  });

  it("preserves an authenticated non-sat payload unit during token ingress", async () => {
    const payload = {
      id: "req-usd",
      mint: "http://mint.example/",
      unit: "usd",
      proofs: [{ secret: "usd-secret", amount: 5, id: "kid", C: "C" }],
    };

    await __handleIncomingDMForTests(JSON.stringify(payload));

    expect(mocks.encodeToken).toHaveBeenCalledWith(
      payload.proofs,
      "http://mint.example",
      "usd",
    );
    expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledWith(
      "token:http://mint.example:5",
      "nip17",
      { mintUrl: "http://mint.example" },
    );
  });

  it("defaults a legacy payload with no unit to sat", async () => {
    const payload = {
      id: "req-legacy",
      mint: "http://mint.example",
      proofs: [{ secret: "legacy-secret", amount: 5, id: "kid", C: "C" }],
    };

    await __handleIncomingDMForTests(JSON.stringify(payload));

    expect(mocks.encodeToken).toHaveBeenCalledWith(
      payload.proofs,
      "http://mint.example",
      "sat",
    );
  });

  it("rejects an explicitly unsupported payload unit without reflecting it in logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await __handleIncomingDMForTests(
      JSON.stringify({
        id: "req-unsupported",
        mint: "http://mint.example",
        unit: "private-bearer-unit",
        proofs: [
          { secret: "unsupported-secret", amount: 5, id: "kid", C: "C" },
        ],
      }),
    );

    expect(mocks.encodeToken).not.toHaveBeenCalled();
    expect(mocks.ingressReceiveCashuToken).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[nip17-listener] payment payload redemption failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "private-bearer-unit",
    );
    warn.mockRestore();
  });

  it("auto-adds the mint when the payer uses a previously unconfigured one", async () => {
    mocks.walletState.mints = [{ url: "http://other.mint" }];

    const payload = {
      id: "req-2",
      mint: "http://new.mint/",
      unit: "sat",
      proofs: [{ secret: "s2", amount: 10, id: "kid", C: "C" }],
    };
    await __handleIncomingDMForTests(JSON.stringify(payload));

    expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledWith(
      "token:http://new.mint:10",
      "nip17",
      {
        mintUrl: "http://new.mint",
      },
    );
    expect(mocks.markReceivedSpy).toHaveBeenCalledWith("req-2", 42);
  });

  it("dedups repeated DMs carrying the same payment payload", async () => {
    mocks.walletState.mints = [{ url: "http://mint.example" }];

    const payload = {
      id: "req-3",
      mint: "http://mint.example",
      unit: "sat",
      proofs: [{ secret: "s3", amount: 5, id: "kid", C: "C" }],
    };
    const body = JSON.stringify(payload);
    await __handleIncomingDMForTests(body);
    await __handleIncomingDMForTests(body);

    expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledTimes(1);
    expect(mocks.markReceivedSpy).toHaveBeenCalledTimes(1);
  });

  it("does not suppress a retry when durable token preparation fails", async () => {
    const payload = JSON.stringify({
      id: "req-retry",
      mint: "http://mint.example",
      unit: "sat",
      proofs: [{ secret: "retry-secret", amount: 5, id: "kid", C: "C" }],
    });
    mocks.ingressReceiveCashuToken
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce({
        added: false,
        mintUrl: "http://mint.example",
        source: "nip17",
        amountSats: 5,
        proofs: [],
      });

    await __handleIncomingDMForTests(payload);
    await __handleIncomingDMForTests(payload);

    expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledTimes(2);
    expect(mocks.markReceivedSpy).toHaveBeenCalledWith("req-retry", 5);
  });

  it("logs a stable category without exposing a mint or dependency error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.ingressReceiveCashuToken.mockRejectedValueOnce(
      new Error("upstream response leaked bearer material"),
    );

    await __handleIncomingDMForTests(
      JSON.stringify({
        id: "req-redacted-error",
        mint: "http://mint.example",
        proofs: [{ secret: "redacted-secret", amount: 5, id: "kid", C: "C" }],
      }),
    );

    expect(warn).toHaveBeenCalledWith(
      "[nip17-listener] payment payload redemption failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("bearer material");
    warn.mockRestore();
  });

  it("keeps the newest listener when subscription starts resolve in reverse order", async () => {
    const first = deferred<() => void>();
    const second = deferred<() => void>();
    const unsubscribeFirst = vi.fn();
    const unsubscribeSecond = vi.fn();
    mocks.subscribeNip17DMs
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    mocks.walletState.mnemonic = "wallet-one";
    const firstStart = startNip17Listener("wallet-one", ["wss://one.example"]);
    const firstCallback = mocks.subscribeNip17DMs.mock.calls[0]![2];
    mocks.walletState.mnemonic = "wallet-two";
    const secondStart = startNip17Listener("wallet-two", ["wss://two.example"]);
    const secondCallback = mocks.subscribeNip17DMs.mock.calls[1]![2];

    second.resolve(unsubscribeSecond);
    await secondStart;
    first.resolve(unsubscribeFirst);
    await firstStart;

    expect(__getNip17ListenerHandleForTests()).toMatchObject({
      mnemonic: "wallet-two",
      relayKey: "wss://two.example",
    });
    expect(unsubscribeFirst).toHaveBeenCalledOnce();
    expect(unsubscribeSecond).not.toHaveBeenCalled();

    const content = JSON.stringify({
      id: "req-generation",
      mint: "http://mint.example",
      proofs: [{ secret: "generation-secret", amount: 5, id: "kid", C: "C" }],
    });
    firstCallback(content, "sender-one");
    secondCallback(content, "sender-two");
    await vi.waitFor(() => {
      expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects a callback after the active wallet changes before restart", async () => {
    mocks.walletState.mnemonic = "wallet-one";
    await startNip17Listener("wallet-one", ["wss://one.example"]);
    const callback = mocks.subscribeNip17DMs.mock.calls[0]![2];
    mocks.walletState.mnemonic = "wallet-two";

    callback(
      JSON.stringify({
        id: "req-wallet-fence",
        mint: "http://mint.example",
        proofs: [
          { secret: "wallet-fence-secret", amount: 5, id: "kid", C: "C" },
        ],
      }),
      "sender-one",
    );
    await Promise.resolve();

    expect(mocks.ingressReceiveCashuToken).not.toHaveBeenCalled();
  });

  it("cleans up malformed mint processing so the same payment can retry", async () => {
    const payment = {
      id: "req-malformed-mint",
      proofs: [
        { secret: "malformed-mint-secret", amount: 5, id: "kid", C: "C" },
      ],
    };

    await __handleIncomingDMForTests(JSON.stringify({ ...payment, mint: 42 }));
    await __handleIncomingDMForTests(
      JSON.stringify({ ...payment, mint: "http://mint.example" }),
    );

    expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledOnce();
    expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledWith(
      "token:http://mint.example:5",
      "nip17",
      { mintUrl: "http://mint.example" },
    );
  });

  it("silently ignores non-JSON content", async () => {
    await __handleIncomingDMForTests("hello world");
    expect(mocks.ingressReceiveCashuToken).not.toHaveBeenCalled();
    expect(mocks.markReceivedSpy).not.toHaveBeenCalled();
  });

  it("silently ignores JSON without proofs+mint", async () => {
    await __handleIncomingDMForTests(
      JSON.stringify({ id: "x", message: "hi" }),
    );
    expect(mocks.ingressReceiveCashuToken).not.toHaveBeenCalled();
    expect(mocks.markReceivedSpy).not.toHaveBeenCalled();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
