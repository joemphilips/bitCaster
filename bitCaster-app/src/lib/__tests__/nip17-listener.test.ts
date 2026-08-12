import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted state so `vi.mock` factories (which are hoisted above imports)
// can close over live references.
const mocks = vi.hoisted(() => {
  const walletState: {
    mints: { url: string }[];
  } = {
    mints: [],
  };
  return {
    walletState,
    pending: {} as Record<string, { id: string; mintUrl: string; createdAt: number }>,
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
        unit: "sat",
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
  subscribeNip17DMs: vi.fn(async () => () => {}),
}));

import { __handleIncomingDMForTests, __resetProcessedEventsForTests } from "../nip17-listener";

beforeEach(() => {
  mocks.walletState.mints = [];
  mocks.pending = {
    "req-1": { id: "req-1", mintUrl: "http://mint.example", createdAt: 1 },
    "req-2": { id: "req-2", mintUrl: "http://new.mint", createdAt: 1 },
    "req-sat": { id: "req-sat", mintUrl: "http://mint.example", createdAt: 1 },
    "req-msat": { id: "req-msat", mintUrl: "http://mint.example", createdAt: 1 },
    "req-invalid": { id: "req-invalid", mintUrl: "http://mint.example", createdAt: 1 },
    "req-3": { id: "req-3", mintUrl: "http://mint.example", createdAt: 1 },
  };
  // Reset all hoisted spies but preserve their identity so the mock is
  // still wired to the listener module's imports.
  mocks.addActivitySpy.mockClear();
  mocks.markReceivedSpy.mockClear();
  mocks.encodeToken.mockClear();
  mocks.ingressReceiveCashuToken.mockClear();
  __resetProcessedEventsForTests();
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
      unit: "sat",
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
      "token:http://mint.example:sat:42",
      "nip17",
      { mintUrl: "http://mint.example" },
    );
    expect(mocks.encodeToken).toHaveBeenCalledWith(payload.proofs, "http://mint.example", "sat");
    expect(mocks.markReceivedSpy).toHaveBeenCalledWith("req-1", 42_000, "sat");
  });

  it("accepts the exact mint admitted by the outstanding payment request", async () => {
    mocks.walletState.mints = [{ url: "http://other.mint" }];

    const payload = {
      id: "req-2",
      mint: "http://new.mint/",
      unit: "sat",
      proofs: [{ secret: "s2", amount: 10, id: "kid", C: "C" }],
    };
    await __handleIncomingDMForTests(JSON.stringify(payload));

    expect(mocks.ingressReceiveCashuToken).toHaveBeenCalledWith(
      "token:http://new.mint:sat:10",
      "nip17",
      { mintUrl: "http://new.mint" },
    );
    expect(mocks.markReceivedSpy).toHaveBeenCalledWith("req-2", 42_000, "sat");
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
    expect(mocks.markReceivedSpy).toHaveBeenCalledWith(`req-${unit}`, 42, baseAsset);
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
      unit: "sat",
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
        unit: "sat",
        proofs: [{ secret: "probe", amount: 1, id: "kid", C: "C" }],
      }),
    );
    await __handleIncomingDMForTests(
      JSON.stringify({
        id: "req-1",
        mint: "http://attacker.example",
        unit: "sat",
        proofs: [{ secret: "probe-2", amount: 1, id: "kid", C: "C" }],
      }),
    );

    expect(mocks.encodeToken).not.toHaveBeenCalled();
    expect(mocks.ingressReceiveCashuToken).not.toHaveBeenCalled();
    expect(mocks.markReceivedSpy).not.toHaveBeenCalled();
  });
});
