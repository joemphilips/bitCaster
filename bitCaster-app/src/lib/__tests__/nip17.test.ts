import { describe, expect, it, vi } from "vitest";
import { mnemonicToSeedSync } from "@scure/bip39";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { NDKRelayStatus, type NDKEvent } from "@nostr-dev-kit/ndk";
import { useSettingsStore } from "@/stores/settings";

vi.mock("../nostr", () => ({
  DEFAULT_RELAYS: ["wss://relay.example"],
  createExplicitRelayNdk: vi.fn(() => {
    throw new Error("Relay I/O is not permitted in this unit test");
  }),
}));

import { decodeNprofile, deriveNostrKeyPair, getNostrNprofile, subscribeNip17DMs } from "../nip17";
import { createExplicitRelayNdk } from "../nostr";

describe("payment request receive identity", () => {
  it("keeps an explicit empty relay hint empty", () => {
    const pubkey = "11".repeat(32);
    expect(decodeNprofile(getNostrNprofile(pubkey, [])).relays).toEqual([]);
  });

  it("returns immediately without NDK construction, connection, or timers on empty selection", async () => {
    vi.mocked(createExplicitRelayNdk).mockClear();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const unsubscribe = await subscribeNip17DMs("00".repeat(32), "11".repeat(32), vi.fn(), []);
      unsubscribe();
      expect(createExplicitRelayNdk).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });
  it("matches the existing BIP-39 receive key independently of the login signer", () => {
    const mnemonic =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const savedSigner = useSettingsStore.getState().nsecSecret;
    try {
      useSettingsStore.setState({ nsecSecret: "1".repeat(64) });
      const first = deriveNostrKeyPair(mnemonic);
      useSettingsStore.setState({ nsecSecret: "2".repeat(64) });
      const second = deriveNostrKeyPair(mnemonic);
      expect(first.publicKey).toBe(getPublicKey(mnemonicToSeedSync(mnemonic).slice(0, 32)));
      expect(second.publicKey).toBe(first.publicKey);
      const profile = decodeNprofile(getNostrNprofile(first.publicKey, ["wss://relay.example"]));
      expect(profile.pubkey).toBe(first.publicKey);
      expect(profile.relays).toEqual(["wss://relay.example"]);
    } finally {
      useSettingsStore.setState({ nsecSecret: savedSigner });
    }
  });
});

describe("encrypted message diagnostics", () => {
  it.each(["seal", "rumor"])("does not log malformed %s plaintext", async (layer) => {
    const receiver = deriveNostrKeyPair(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const senderKey = hexToBytes("12".repeat(32));
    const senderPublicKey = getPublicKey(senderKey);
    const conversationKey = nip44.v2.utils.getConversationKey(senderKey, receiver.publicKey);
    const canary = "PRIVATE_DM";
    const malformed = `${canary}: not JSON`;
    const seal = finalizeEvent(
      {
        kind: 13,
        content: nip44.v2.encrypt(malformed, conversationKey),
        tags: [],
        created_at: 1,
      },
      senderKey,
    );
    const content = nip44.v2.encrypt(
      layer === "seal" ? malformed : JSON.stringify(seal),
      conversationKey,
    );
    let deliver: ((event: NDKEvent) => void) | undefined;
    const stop = vi.fn();
    const ndk = {
      connect: vi.fn().mockResolvedValue(undefined),
      pool: { relays: new Map([["test", { status: NDKRelayStatus.CONNECTED }]]) },
      subscribe: vi.fn(() => ({
        on: (_event: string, callback: (event: NDKEvent) => void) => {
          deliver = callback;
        },
        stop,
      })),
      explicitRelayUrls: ["wss://relay.example"],
    };
    vi.mocked(createExplicitRelayNdk).mockReturnValueOnce(
      ndk as unknown as ReturnType<typeof createExplicitRelayNdk>,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onMessage = vi.fn();
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = await subscribeNip17DMs(receiver.privateKeyHex, receiver.publicKey, onMessage, [
        "wss://relay.example",
      ]);
      expect(deliver).toBeDefined();
      deliver!({ id: layer, pubkey: senderPublicKey, content } as NDKEvent);
      expect(onMessage).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls).includes(canary)).toBe(false);
      expect(warn).toHaveBeenCalledExactlyOnceWith("[nip17] DM_UNWRAP_FAILED");
    } finally {
      unsubscribe?.();
      warn.mockRestore();
    }
    expect(stop).toHaveBeenCalledOnce();
  });
});
