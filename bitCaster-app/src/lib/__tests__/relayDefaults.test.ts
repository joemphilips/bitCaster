import { afterEach, describe, expect, it, vi } from "vitest";

describe("relay defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the local relay by default in non-production builds", async () => {
    vi.resetModules();

    const module = await import("../relayDefaults");

    expect(module.DEFAULT_NOSTR_RELAYS).toEqual(["ws://localhost:7777"]);
    expect(module.defaultRelayConfigs()).toEqual([
      { url: "ws://localhost:7777", connectionStatus: "disconnected" },
    ]);
  });

  it("lets VITE_NOSTR_RELAYS replace built-in defaults", async () => {
    vi.stubEnv("VITE_NOSTR_RELAYS", "ws://localhost:7778, ws://localhost:7779");
    vi.resetModules();

    const module = await import("../relayDefaults");

    expect(module.DEFAULT_NOSTR_RELAYS).toEqual([
      "ws://localhost:7778",
      "ws://localhost:7779",
    ]);
  });

  it("requires an allowlisted origin for configured remote relays", async () => {
    vi.stubEnv(
      "VITE_NOSTR_RELAYS",
      "wss://relay.app.example,wss://relay.other.example",
    );
    vi.stubEnv("VITE_NOSTR_ALLOWED_RELAY_ORIGINS", "wss://relay.app.example");
    vi.resetModules();

    const module = await import("../relayDefaults");

    expect(module.DEFAULT_NOSTR_RELAYS).toEqual(["wss://relay.app.example"]);
    expect(module.isAllowedNostrRelayUrl("wss://relay.app.example")).toBe(true);
    expect(module.isAllowedNostrRelayUrl("wss://relay.other.example")).toBe(false);
  });

  it("drops configured remote relays when no app-owned origin allowlist exists", async () => {
    vi.stubEnv("VITE_NOSTR_RELAYS", "wss://relay.app.example");
    vi.resetModules();

    const module = await import("../relayDefaults");

    expect(module.DEFAULT_NOSTR_RELAYS).toEqual([]);
    expect(module.isAllowedNostrRelayUrl("wss://relay.app.example")).toBe(false);
  });

  it("defaults production builds to the curated public relay set (ADR-028)", async () => {
    vi.resetModules();

    const module = await import("../relayDefaults");

    expect(module.PRODUCTION_NOSTR_RELAYS).toEqual(module.KNOWN_PUBLIC_NOSTR_RELAYS);
  });

  it("removes old public defaults from persisted settings and backfills the local default", async () => {
    vi.resetModules();

    const module = await import("../relayDefaults");

    expect(
      module.removeRetiredPublicDefaultRelays([
        { url: "wss://relay.damus.io", connectionStatus: "disconnected" },
        { url: "wss://relay.user.example", connectionStatus: "disconnected" },
      ]),
    ).toEqual([
      { url: "ws://localhost:7777", connectionStatus: "disconnected" },
    ]);
  });

  it("drops explicitly configured known public relays", async () => {
    vi.stubEnv(
      "VITE_NOSTR_RELAYS",
      "wss://relay.damus.io,wss://purplepag.es,wss://relay.nostr.band",
    );
    vi.resetModules();

    const module = await import("../relayDefaults");

    expect(module.DEFAULT_NOSTR_RELAYS).toEqual([]);
    expect(
      module.removeRetiredPublicDefaultRelays([
        { url: "wss://relay.damus.io", connectionStatus: "disconnected" },
        { url: "wss://purplepag.es", connectionStatus: "disconnected" },
        { url: "wss://relay.nostr.band", connectionStatus: "disconnected" },
      ]),
    ).toEqual([]);
  });

  it("drops known public relays even when a path or query is present", async () => {
    vi.stubEnv(
      "VITE_NOSTR_RELAYS",
      "wss://relay.damus.io/some-path?x=1,wss://relay.app.example",
    );
    vi.stubEnv(
      "VITE_NOSTR_ALLOWED_RELAY_ORIGINS",
      "wss://relay.damus.io,wss://relay.app.example",
    );
    vi.resetModules();

    const module = await import("../relayDefaults");

    expect(module.DEFAULT_NOSTR_RELAYS).toEqual(["wss://relay.app.example"]);
    expect(module.isAllowedNostrRelayUrl("wss://relay.damus.io/some-path?x=1")).toBe(false);
  });
});
