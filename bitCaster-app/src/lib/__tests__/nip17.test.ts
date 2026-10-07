import { describe, expect, it, vi } from "vitest";
import { mnemonicToSeedSync } from "@scure/bip39";
import { getPublicKey } from "nostr-tools/pure";
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
