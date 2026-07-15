import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let eventHandler: ((event: unknown) => void) | undefined;
  const decrypt = vi.fn(() => {
    throw new Error("decrypted bearer material");
  });
  const disconnect = vi.fn();
  const stop = vi.fn();
  const subscribe = vi.fn(() => ({
    on: vi.fn((_name: string, handler: (event: unknown) => void) => {
      eventHandler = handler;
    }),
    stop,
  }));
  const ndk = {
    connect: vi.fn(async () => {}),
    pool: {
      relays: new Map([["wss://relay.example", { status: 100, disconnect }]]),
    },
    subscribe,
  };
  return {
    decrypt,
    disconnect,
    ndk,
    stop,
    eventHandler: () => eventHandler,
  };
});

vi.mock("../nostr", () => ({
  createExplicitRelayNdk: vi.fn(() => mocks.ndk),
  DEFAULT_RELAYS: ["wss://relay.example"],
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    nip44: {
      ...actual.nip44,
      v2: {
        ...actual.nip44.v2,
        decrypt: mocks.decrypt,
      },
    },
  };
});

import { subscribeNip17DMs } from "../nip17";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("subscribeNip17DMs", () => {
  it("logs a fixed category when decrypted content is malformed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unsubscribe = await subscribeNip17DMs(
      "01".repeat(32),
      "02".repeat(32),
      vi.fn(),
    );

    mocks.eventHandler()?.({
      id: "event-id",
      pubkey:
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      content: "encrypted-content",
    });

    expect(warn).toHaveBeenCalledWith("[nip17] DM unwrap failed, ignoring");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "decrypted bearer material",
    );

    unsubscribe();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
