import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted state so `vi.mock` factories (which are hoisted above imports)
// can close over live references.
const mocks = vi.hoisted(() => {
  const walletState: {
    mints: { url: string }[];
    mnemonic: string;
  } = {
    mints: [],
    mnemonic: "wallet-a",
  };
  const subscribers: Array<{
    deliver: (content: string) => void;
    unsubscribe: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    walletState,
    activeScope: "scope:wallet-a" as string | null,
    subscribers,
    subscribeNip17DMs: vi.fn(),
    pending: {} as Record<
      string,
      { id: string; mintUrl: string; walletScopeId: string; createdAt: number }
    >,
    addActivitySpy: vi.fn(),
    markReceivedSpy: vi.fn(),
    encodeToken: vi.fn(
      (proofs: unknown[], mintUrl: string, unit: string) =>
        `token:${mintUrl}:${unit}:${(proofs as { amount: number }[]).reduce((s, p) => s + p.amount, 0)}`,
    ),
    ingressReceiveCashuToken: vi.fn(
      async (_token: string, _source: string, options?: { mintUrl?: string }) => ({
        added: !walletState.mints.some((m) => m.url === options?.mintUrl),
        mintUrl: options?.mintUrl ?? "http://mint.example",
        source: "nip17",
        amountSubunits: 42_000,
        baseAsset: "sat",
        unit: "msat",
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

vi.mock("../browserWalletProfile", () => ({
  browserWalletScopeIdFromMnemonic: (mnemonic: string) => (mnemonic ? `scope:${mnemonic}` : null),
  activeBrowserWalletScopeId: () => mocks.activeScope,
}));

vi.mock("@/stores/activity-log", () => ({
  useActivityLogStore: {
    getState: () => ({ addActivity: mocks.addActivitySpy }),
  },
}));

vi.mock("@/stores/paymentRequestInbox", () => ({
  usePaymentRequestInbox: {
    getState: () => ({ pending: mocks.pending, markReceived: mocks.markReceivedSpy }),
  },
}));

vi.mock("../cashu", () => ({
  encodeToken: mocks.encodeToken,
}));

vi.mock("../walletOps", () => ({
  ingressReceiveCashuToken: mocks.ingressReceiveCashuToken,
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

function pending(id: string, mintUrl: string, walletScopeId = "scope:wallet-a") {
  return { id, mintUrl, walletScopeId, createdAt: 1 };
}

function payload(id: string, mint: string, secret: string, unit = "msat") {
  return JSON.stringify({
    id,
    mint,
    unit,
    proofs: [{ secret, amount: 42, id: "kid", C: "C" }],
  });
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: resolve! };
}

beforeEach(() => {
  mocks.walletState.mints = [];
  mocks.walletState.mnemonic = "wallet-a";
  mocks.activeScope = "scope:wallet-a";
  mocks.pending = {
    "req-1": pending("req-1", "http://mint.example"),
    "req-2": pending("req-2", "http://new.mint"),
    "req-msat": pending("req-msat", "http://mint.example"),
    "req-invalid": pending("req-invalid", "http://mint.example"),
    "req-3": pending("req-3", "http://mint.example"),
  };
  // Reset all hoisted spies but preserve their identity so the mock is
  // still wired to the listener module's imports.
  mocks.addActivitySpy.mockClear();
  mocks.markReceivedSpy.mockClear();
  mocks.encodeToken.mockClear();
  mocks.ingressReceiveCashuToken.mockClear();
  mocks.subscribers.length = 0;
  mocks.subscribeNip17DMs.mockReset();
  mocks.subscribeNip17DMs.mockImplementation(
    (_privateKeyHex: string, _publicKey: string, onMessage: (content: string) => void) => {
      const unsubscribe = vi.fn();
      mocks.subscribers.push({ deliver: onMessage, unsubscribe });
      return Promise.resolve(unsubscribe);
    },
  );
  __resetProcessedEventsForTests();
});

afterEach(() => {
  stopNip17Listener();
});

describe("nip17-listener", () => {
  it("normalizes the payload mint URL before durable wallet ingress", async () => {
    mocks.walletState.mints = [{ url: "http://mint.example" }];
    mocks.ingressReceiveCashuToken.mockResolvedValueOnce({
      added: false,
      mintUrl: "http://mint.example",
      source: "nip17",
      amountSubunits: 42_000,
      baseAsset: "sat",
      unit: "msat",
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
      unit: "msat",
      proofs: [{ secret: "s1", amount: 42, id: "kid", C: "C" }],
    };
    await __handleIncomingDMForTests(JSON.stringify(payload));

    expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledWith(
      "token:http://mint.example:msat:42",
      "nip17",
      { mintUrl: "http://mint.example" },
    );
    expect(mocks.encodeToken).toHaveBeenCalledWith(payload.proofs, "http://mint.example", "msat");
    expect(mocks.markReceivedSpy).toHaveBeenCalledWith("req-1", 42_000, "sat", "scope:wallet-a");
  });

  it("accepts the exact mint admitted by the outstanding payment request", async () => {
    mocks.walletState.mints = [{ url: "http://other.mint" }];

    const payload = {
      id: "req-2",
      mint: "http://new.mint/",
      unit: "msat",
      proofs: [{ secret: "s2", amount: 10, id: "kid", C: "C" }],
    };
    await __handleIncomingDMForTests(JSON.stringify(payload));

    expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledWith(
      "token:http://new.mint:msat:10",
      "nip17",
      { mintUrl: "http://new.mint" },
    );
    expect(mocks.markReceivedSpy).toHaveBeenCalledWith("req-2", 42_000, "sat", "scope:wallet-a");
  });

  it("preserves the msat payload unit through durable ingress", async () => {
    const unit = "msat";
    const baseAsset = "sat";
    mocks.ingressReceiveCashuToken.mockResolvedValueOnce({
      added: false,
      mintUrl: "http://mint.example",
      source: "nip17",
      amountSubunits: 42,
      baseAsset,
      unit,
      proofs: [{ secret: "rotated-1", amount: 42, id: "kid", C: "C" }],
    });
    const payload = {
      id: `req-${unit}`,
      mint: "http://mint.example",
      unit,
      proofs: [{ secret: `s-${unit}`, amount: 42, id: "kid", C: "C" }],
    };

    await __handleIncomingDMForTests(JSON.stringify(payload));

    expect(mocks.encodeToken).toHaveBeenCalledWith(payload.proofs, "http://mint.example", unit);
    expect(mocks.markReceivedSpy).toHaveBeenCalledWith(
      `req-${unit}`,
      42,
      baseAsset,
      "scope:wallet-a",
    );
  });

  it("rejects payloads with unsupported proof units before ingress", async () => {
    await __handleIncomingDMForTests(
      JSON.stringify({
        id: "req-invalid",
        mint: "http://mint.example",
        unit: "btc",
        proofs: [{ secret: "invalid", amount: 1, id: "kid", C: "C" }],
      }),
    );

    expect(mocks.encodeToken).not.toHaveBeenCalled();
    expect(mocks.ingressReceiveCashuToken).not.toHaveBeenCalled();
    expect(mocks.markReceivedSpy).not.toHaveBeenCalled();
  });

  it("dedups repeated DMs carrying the same payment payload", async () => {
    mocks.walletState.mints = [{ url: "http://mint.example" }];

    const payload = {
      id: "req-3",
      mint: "http://mint.example",
      unit: "msat",
      proofs: [{ secret: "s3", amount: 5, id: "kid", C: "C" }],
    };
    const body = JSON.stringify(payload);
    await __handleIncomingDMForTests(body);
    await __handleIncomingDMForTests(body);

    expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledTimes(1);
    expect(mocks.markReceivedSpy).toHaveBeenCalledTimes(1);
  });

  it("silently ignores non-JSON content", async () => {
    await __handleIncomingDMForTests("hello world");
    expect(mocks.ingressReceiveCashuToken).not.toHaveBeenCalled();
    expect(mocks.markReceivedSpy).not.toHaveBeenCalled();
  });

  it("silently ignores JSON without proofs+mint", async () => {
    await __handleIncomingDMForTests(JSON.stringify({ id: "x", message: "hi" }));
    expect(mocks.ingressReceiveCashuToken).not.toHaveBeenCalled();
    expect(mocks.markReceivedSpy).not.toHaveBeenCalled();
  });

  it("rejects unsolicited or wrong-mint DMs before wallet ingress", async () => {
    await __handleIncomingDMForTests(
      JSON.stringify({
        id: "unknown-request",
        mint: "http://attacker.example",
        unit: "msat",
        proofs: [{ secret: "probe", amount: 1, id: "kid", C: "C" }],
      }),
    );
    await __handleIncomingDMForTests(
      JSON.stringify({
        id: "req-1",
        mint: "http://attacker.example",
        unit: "msat",
        proofs: [{ secret: "probe-2", amount: 1, id: "kid", C: "C" }],
      }),
    );

    expect(mocks.encodeToken).not.toHaveBeenCalled();
    expect(mocks.ingressReceiveCashuToken).not.toHaveBeenCalled();
    expect(mocks.markReceivedSpy).not.toHaveBeenCalled();
  });

  it("keeps the newest listener when subscription starts finish in reverse order", async () => {
    const firstSubscription = deferred<() => void>();
    const secondSubscription = deferred<() => void>();
    mocks.subscribeNip17DMs
      .mockImplementationOnce(() => firstSubscription.promise)
      .mockImplementationOnce(() => secondSubscription.promise);

    const startingA = startNip17Listener("wallet-a", ["wss://relay.example"]);
    mocks.walletState.mnemonic = "wallet-b";
    mocks.activeScope = "scope:wallet-b";
    const startingB = startNip17Listener("wallet-b", ["wss://relay.example"]);
    const unsubscribeB = vi.fn();
    secondSubscription.resolve(unsubscribeB);
    await startingB;
    const unsubscribeA = vi.fn();
    firstSubscription.resolve(unsubscribeA);
    await startingA;

    expect(__getNip17ListenerHandleForTests()?.mnemonic).toBe("wallet-b");
    expect(unsubscribeA).toHaveBeenCalledOnce();
    expect(unsubscribeB).not.toHaveBeenCalled();
  });

  it("shares a same-key subscription start while the first subscription is pending", async () => {
    const subscription = deferred<() => void>();
    mocks.subscribeNip17DMs.mockReturnValueOnce(subscription.promise);

    const first = startNip17Listener("wallet-a", ["wss://relay.example"]);
    const second = startNip17Listener("wallet-a", ["wss://relay.example"]);

    expect(mocks.subscribeNip17DMs).toHaveBeenCalledOnce();
    subscription.resolve(vi.fn());
    await Promise.all([first, second]);
  });

  it("unsubscribes and fences a start that completes after stop", async () => {
    const subscription = deferred<() => void>();
    mocks.subscribeNip17DMs.mockReturnValueOnce(subscription.promise);
    const starting = startNip17Listener("wallet-a", ["wss://relay.example"]);

    stopNip17Listener();
    const unsubscribe = vi.fn();
    subscription.resolve(unsubscribe);
    await starting;

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(__getNip17ListenerHandleForTests()).toBeNull();
  });

  it("ignores a delivery from the old listener after switching wallet profiles", async () => {
    await startNip17Listener("wallet-a", ["wss://relay.example"]);
    const oldListener = mocks.subscribers[0]!;
    mocks.pending["req-a"] = pending("req-a", "http://mint.example", "scope:wallet-a");

    mocks.walletState.mnemonic = "wallet-b";
    mocks.activeScope = "scope:wallet-b";
    await startNip17Listener("wallet-b", ["wss://relay.example"]);
    oldListener.deliver(payload("req-a", "http://mint.example", "old-wallet-proof"));
    await Promise.resolve();

    expect(mocks.ingressReceiveCashuToken).not.toHaveBeenCalled();
    expect(mocks.addActivitySpy).not.toHaveBeenCalled();
    expect(mocks.markReceivedSpy).not.toHaveBeenCalled();
  });

  it("does not update activity or the inbox when a receive completes after profile exit", async () => {
    const completion = deferred<{
      added: boolean;
      mintUrl: string;
      source: string;
      amountSubunits: number;
      baseAsset: "sat";
      unit: "msat";
      proofs: { secret: string; amount: number; id: string; C: string }[];
    }>();
    const ingressSettled = deferred<void>();
    mocks.ingressReceiveCashuToken.mockImplementationOnce(async () => {
      const result = await completion.promise;
      ingressSettled.resolve();
      return result;
    });
    await startNip17Listener("wallet-a", ["wss://relay.example"]);
    const receiving = __handleIncomingDMForTests(
      payload("req-1", "http://mint.example", "old-wallet-proof"),
    );
    await vi.waitFor(() => expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledOnce());

    mocks.walletState.mnemonic = "wallet-b";
    mocks.activeScope = "scope:wallet-b";
    stopNip17Listener();
    completion.resolve({
      added: false,
      mintUrl: "http://mint.example",
      source: "nip17",
      amountSubunits: 42,
      baseAsset: "sat",
      unit: "msat",
      proofs: [{ secret: "old-wallet-proof", amount: 42, id: "kid", C: "C" }],
    });
    await receiving;
    await ingressSettled.promise;

    expect(mocks.addActivitySpy).not.toHaveBeenCalled();
    expect(mocks.markReceivedSpy).not.toHaveBeenCalled();
  });

  it("requires the pending request wallet scope to match the listener scope", async () => {
    mocks.walletState.mnemonic = "wallet-b";
    mocks.activeScope = "scope:wallet-b";
    mocks.pending["req-a"] = pending("req-a", "http://mint.example", "scope:wallet-a");
    await startNip17Listener("wallet-b", ["wss://relay.example"]);
    mocks.subscribers[0]!.deliver(payload("req-a", "http://mint.example", "other-wallet-proof"));
    await Promise.resolve();

    expect(mocks.ingressReceiveCashuToken).not.toHaveBeenCalled();
    expect(mocks.markReceivedSpy).not.toHaveBeenCalled();
  });
});
