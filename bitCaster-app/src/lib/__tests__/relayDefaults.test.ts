import { afterEach, describe, expect, it, vi } from "vitest";

describe("relay selection", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses an explicit local development default only for missing configuration", async () => {
    vi.resetModules();
    const module = await import("../relayDefaults");
    expect(module.DEFAULT_NOSTR_RELAYS).toEqual(["ws://localhost:7777"]);
    expect(module.effectiveRelayUrls(undefined)).toEqual(["ws://localhost:7777"]);
    expect(module.defaultRelayConfigs()).toEqual([
      { url: "ws://localhost:7777", connectionStatus: "disconnected" },
    ]);
  });

  it("uses the curated public defaults in production", async () => {
    vi.stubEnv("PROD", true);
    vi.resetModules();
    const module = await import("../relayDefaults");
    expect(module.DEFAULT_NOSTR_RELAYS).toEqual([...module.KNOWN_PUBLIC_NOSTR_RELAYS]);
    expect(module.DEFAULT_NOSTR_RELAYS).toHaveLength(7);
  });

  it("lets an environment list replace all defaults with custom and public relays", async () => {
    vi.stubEnv("VITE_NOSTR_RELAYS", " wss://custom.example/Path?Key=A, wss://nos.lol/");
    vi.resetModules();
    const module = await import("../relayDefaults");
    expect(module.DEFAULT_NOSTR_RELAYS).toEqual([
      "wss://custom.example/Path?Key=A",
      "wss://nos.lol",
    ]);
  });

  it("keeps explicit empty environment and settings selections empty", async () => {
    vi.stubEnv("VITE_NOSTR_RELAYS", "");
    vi.resetModules();
    const module = await import("../relayDefaults");
    expect(module.DEFAULT_NOSTR_RELAYS).toEqual([]);
    expect(module.effectiveRelayUrls(undefined)).toEqual([]);
    expect(module.effectiveRelayUrls([])).toEqual([]);
    expect(module.normalizeRelayConfigs([])).toEqual([]);
  });

  it("keeps valid saved custom/public URLs and exact path/query distinctions", async () => {
    vi.resetModules();
    const module = await import("../relayDefaults");
    expect(
      module.effectiveRelayUrls([
        { url: "wss://nos.lol/" },
        { url: "wss://NOS.LOL" },
        { url: "wss://custom.example/Path?Key=A" },
        { url: "wss://custom.example/path?Key=A" },
        { url: "https://invalid.example" },
      ]),
    ).toEqual([
      "wss://nos.lol",
      "wss://custom.example/Path?Key=A",
      "wss://custom.example/path?Key=A",
    ]);
    expect(module.effectiveRelayUrls([{ url: "ws://remote.example" }])).toEqual([]);
  });

  it("preserves removal and public relay re-add through the real settings store", async () => {
    vi.resetModules();
    const { useSettingsStore } = await import("@/stores/settings");
    useSettingsStore.setState({ relays: [] });
    useSettingsStore.getState().addRelay("wss://custom.example/Path?Key=A");
    useSettingsStore.getState().addRelay("wss://nos.lol");
    expect(useSettingsStore.getState().relays.map(({ url }) => url)).toEqual([
      "wss://custom.example/Path?Key=A",
      "wss://nos.lol",
    ]);
    useSettingsStore.getState().removeRelay("wss://nos.lol");
    expect(useSettingsStore.getState().relays.map(({ url }) => url)).toEqual([
      "wss://custom.example/Path?Key=A",
    ]);
    useSettingsStore.getState().removeRelay("wss://custom.example/Path?Key=A");
    expect(useSettingsStore.getState().relays).toEqual([]);
    useSettingsStore.getState().addRelay("wss://nos.lol");
    expect(useSettingsStore.getState().relays.map(({ url }) => url)).toEqual(["wss://nos.lol"]);
  });

  it("preserves explicit saved opt-out on settings reload", async () => {
    vi.resetModules();
    localStorage.setItem(
      "bitcaster-settings",
      JSON.stringify({ state: { relays: [] }, version: 0 }),
    );
    const { useSettingsStore } = await import("@/stores/settings");
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().relays).toEqual([]);
    const { effectiveRelayUrls } = await import("../relayDefaults");
    expect(effectiveRelayUrls(useSettingsStore.getState().relays)).toEqual([]);
  });
});
