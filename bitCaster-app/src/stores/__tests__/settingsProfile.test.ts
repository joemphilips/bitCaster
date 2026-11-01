import { afterEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "../settings";

const profile = {
  pubkey: "01".repeat(32),
  displayName: "Alice",
  avatar: "",
  nip05: "alice@example.test",
  nip05verified: true,
  bio: "A public description",
};

afterEach(() => {
  useSettingsStore.getState().setProfile(null, "idle");
  localStorage.removeItem("bitcaster-settings");
});

describe("Nostr profile verification claims", () => {
  it("does not treat a caller's metadata claim as verified identity", () => {
    useSettingsStore.getState().setProfile(profile, "found");

    expect(useSettingsStore.getState().nostrProfile).toEqual({
      ...profile,
      nip05verified: false,
    });
  });

  it("removes a historical false verification badge on reload without losing profile fields", async () => {
    localStorage.setItem(
      "bitcaster-settings",
      JSON.stringify({
        version: 0,
        state: { nostrProfile: profile, nostrProfileFetchStatus: "found" },
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().nostrProfile).toEqual({
      ...profile,
      nip05verified: false,
    });
    expect(useSettingsStore.getState().nostrProfileFetchStatus).toBe("found");
  });
});

describe("saved relay selection", () => {
  it("drops a retired default relay on reload and keeps the other saved relays", async () => {
    localStorage.setItem(
      "bitcaster-settings",
      JSON.stringify({
        version: 0,
        state: {
          relays: [
            { url: "wss://relay.damus.io", connectionStatus: "disconnected" },
            { url: "wss://relay.nostr.band", connectionStatus: "disconnected" },
            { url: "wss://custom.example", connectionStatus: "disconnected" },
          ],
        },
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().relays.map(({ url }) => url)).toEqual([
      "wss://relay.damus.io",
      "wss://custom.example",
    ]);
  });
});
