import { beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, getEncodedToken, type Token } from "@cashu/cashu-ts";
import { useSettingsStore } from "@/stores/settings";
import { useWalletStore } from "@/stores/wallet";
import * as cashu from "@/lib/cashu";
import {
  getKnownMints,
  getRelayUrlValidationError,
  decodeWalletIngressToken,
  ingressReceiveCashuToken,
  ingressRegisterMint,
  normalizeRelayUrl,
  refreshMintInfoWithoutActivating,
  userAddAndSelectMint,
  userAddRelay,
  userCreatePaymentRequest,
  userRemoveMint,
  userRemoveRelay,
  userSwitchActiveMint,
} from "../walletOps";

const { mockResolveTokenImportKeysets } = vi.hoisted(() => ({
  mockResolveTokenImportKeysets: vi.fn(),
}));

vi.mock("@/lib/cashu", () => ({
  receiveAndStoreTokenRecoverably: vi.fn(),
}));

vi.mock("@/lib/tokenImportKeysetResolver", () => ({
  resolveTokenImportKeysets: mockResolveTokenImportKeysets,
}));

vi.mock("@/lib/nip17", () => ({
  deriveNostrKeyPair: vi.fn().mockReturnValue({
    privateKey: new Uint8Array(32),
    privateKeyHex: "0".repeat(64),
    publicKey: "1".repeat(64),
  }),
  getNostrNprofile: vi.fn().mockReturnValue("nprofile1test"),
}));

const VALID_KEYSET_ID = "0011223344556677";

function decodedProof() {
  return {
    id: VALID_KEYSET_ID,
    amount: Amount.from(1),
    secret: "decoded-secret",
    C: `02${"ab".repeat(32)}`,
  };
}

function encodedToken(mint: string, unit: string, proofs = [decodedProof()]): string {
  return getEncodedToken({ mint, unit, proofs } as Token);
}

describe("walletOps facade", () => {
  let addMint: ReturnType<typeof vi.fn>;
  let addMintWithoutActivating: ReturnType<typeof vi.fn>;
  let removeMint: ReturnType<typeof vi.fn>;
  let setActiveMint: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);
    addMint = vi.fn().mockResolvedValue(undefined);
    addMintWithoutActivating = vi.fn().mockResolvedValue(undefined);
    removeMint = vi.fn();
    setActiveMint = vi.fn();
    vi.mocked(cashu.receiveAndStoreTokenRecoverably).mockReset();
    vi.mocked(cashu.receiveAndStoreTokenRecoverably).mockResolvedValue([
      { secret: "s1", amount: 21, id: "kid", C: "C1" },
      { secret: "s2", amount: 34, id: "kid", C: "C2" },
    ] as never);
    mockResolveTokenImportKeysets.mockReset();
    mockResolveTokenImportKeysets.mockResolvedValue({
      freshness: "fresh",
      regularKeysets: [{ keysetId: VALID_KEYSET_ID, unit: "msat", active: true }],
      conditionalKeysets: [],
    });
    useWalletStore.setState({
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      mints: [{ url: "https://active.mint", info: { name: "Active" } }],
      activeMintUrl: "https://active.mint",
      _addMint: addMint as never,
      _addMintWithoutActivating: addMintWithoutActivating as never,
      _removeMint: removeMint as never,
      _setActiveMint: setActiveMint as never,
    });
    useSettingsStore.setState({
      relays: [{ url: "ws://localhost:7777", connectionStatus: "disconnected" }],
      addRelay: vi.fn(),
      removeRelay: vi.fn(),
    });
  });

  it("routes explicit user mint actions through the activating store path", async () => {
    await userAddAndSelectMint("https://new.mint/");
    userSwitchActiveMint("https://new.mint/");
    userRemoveMint("https://old.mint/");

    expect(addMint).toHaveBeenCalledWith("https://new.mint/");
    expect(setActiveMint).toHaveBeenCalledWith("https://new.mint/");
    expect(removeMint).toHaveBeenCalledWith("https://old.mint");
    expect(addMintWithoutActivating).not.toHaveBeenCalled();
  });

  it("refreshes mint info without changing the active mint", async () => {
    await refreshMintInfoWithoutActivating("https://active.mint/");

    expect(addMintWithoutActivating).toHaveBeenCalledWith("https://active.mint/");
    expect(addMint).not.toHaveBeenCalled();
    expect(setActiveMint).not.toHaveBeenCalled();
  });

  it("registers unknown ingress mints without changing the active mint", async () => {
    const result = await ingressRegisterMint("https://unknown.mint/", "paste");

    expect(result).toEqual({
      added: true,
      mintUrl: "https://unknown.mint",
      source: "paste",
    });
    expect(addMintWithoutActivating).toHaveBeenCalledWith("https://unknown.mint");
    expect(addMint).not.toHaveBeenCalled();
    expect(setActiveMint).not.toHaveBeenCalled();
  });

  it("redeems ingress tokens under the issuing mint and reports the received amount", async () => {
    const token = encodedToken("https://unknown.mint/", "msat");

    const result = await ingressReceiveCashuToken(token, "scan");

    expect(cashu.receiveAndStoreTokenRecoverably).toHaveBeenCalledWith(
      token,
      "https://unknown.mint",
      "sat",
      "msat",
      "ctf-collateral-msat",
    );
    expect(addMintWithoutActivating).toHaveBeenCalledWith("https://unknown.mint");
    expect(result).toMatchObject({
      added: true,
      amountSubunits: 55,
      baseAsset: "sat",
      unit: "msat",
      mintUrl: "https://unknown.mint",
      source: "scan",
    });
  });

  it("keeps msat proof amounts in sat-market subunits", async () => {
    mockResolveTokenImportKeysets.mockResolvedValueOnce({
      freshness: "fresh",
      regularKeysets: [{ keysetId: VALID_KEYSET_ID, unit: "msat", active: true }],
      conditionalKeysets: [],
    });
    const token = encodedToken("https://msat.mint/", "msat");

    const result = await ingressReceiveCashuToken(token, "paste");

    expect(result).toMatchObject({
      amountSubunits: 55,
      baseAsset: "sat",
      unit: "msat",
    });
  });

  it("returns conditional metadata persisted by the durable receiver", async () => {
    mockResolveTokenImportKeysets.mockResolvedValueOnce({
      freshness: "fresh",
      regularKeysets: [],
      conditionalKeysets: [{ keysetId: VALID_KEYSET_ID, unit: "msat", active: true }],
    });
    const token = encodedToken("https://conditional.mint/", "msat");
    vi.mocked(cashu.receiveAndStoreTokenRecoverably).mockResolvedValueOnce([
      {
        secret: "s1",
        amount: 21,
        id: "kid",
        C: "C1",
        conditionId: "condition-1",
        outcomeCollection: "B",
        marketId: "condition-1-B",
      },
      {
        secret: "s2",
        amount: 34,
        id: "kid",
        C: "C2",
        conditionId: "condition-1",
        outcomeCollection: "B",
        marketId: "condition-1-B",
      },
    ] as never);

    const result = await ingressReceiveCashuToken(token, "paste");

    expect(cashu.receiveAndStoreTokenRecoverably).toHaveBeenCalledWith(
      token,
      "https://conditional.mint",
      "sat",
      "msat",
      "ctf-position-msat",
    );

    expect(result.proofs).toEqual([
      expect.objectContaining({
        secret: "s1",
        conditionId: "condition-1",
        outcomeCollection: "B",
        marketId: "condition-1-B",
      }),
      expect.objectContaining({
        secret: "s2",
        conditionId: "condition-1",
        outcomeCollection: "B",
        marketId: "condition-1-B",
      }),
    ]);
  });

  it("rejects sat tokens before mint resolution or mutation", async () => {
    const token = encodedToken("https://sat.mint/", "sat");

    await expect(ingressReceiveCashuToken(token, "paste")).rejects.toThrow(
      "product-wallet token imports require msat",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockResolveTokenImportKeysets).not.toHaveBeenCalled();
    expect(addMintWithoutActivating).not.toHaveBeenCalled();
    expect(cashu.receiveAndStoreTokenRecoverably).not.toHaveBeenCalled();
  });

  it("does not re-register known ingress mints", async () => {
    const token = encodedToken("https://active.mint/", "msat");

    const result = await ingressReceiveCashuToken(token, "nip17", {
      mintUrl: "https://active.mint/",
    });

    expect(result.added).toBe(false);
    expect(addMintWithoutActivating).not.toHaveBeenCalled();
    expect(cashu.receiveAndStoreTokenRecoverably).toHaveBeenCalledWith(
      token,
      "https://active.mint",
      "sat",
      "msat",
      "ctf-collateral-msat",
    );
  });

  it("rejects decoded tokens whose unit is not supported", async () => {
    const token = encodedToken("https://active.mint/", "btc");

    await expect(ingressReceiveCashuToken(token, "paste")).rejects.toThrow(
      /missing or unsupported unit metadata/,
    );
    expect(mockResolveTokenImportKeysets).not.toHaveBeenCalled();
    expect(cashu.receiveAndStoreTokenRecoverably).not.toHaveBeenCalled();
  });

  it("rejects more than 128 proofs before mint keyset resolution", async () => {
    const token = encodedToken(
      "https://active.mint/",
      "msat",
      Array.from({ length: 129 }, (_, index) => ({
        id: VALID_KEYSET_ID,
        amount: Amount.from(1),
        secret: `proof-${index}`,
        C: `02${"ab".repeat(32)}`,
      })),
    );

    await expect(ingressReceiveCashuToken(token, "paste")).rejects.toThrow(
      "decoded token exceeds 128 proofs",
    );

    expect(mockResolveTokenImportKeysets).not.toHaveBeenCalled();
    expect(cashu.receiveAndStoreTokenRecoverably).not.toHaveBeenCalled();
  });

  it("decodes ingress tokens locally without mint network access", async () => {
    const token = encodedToken("https://local.mint/", "msat");

    const decoded = await decodeWalletIngressToken(token);

    expect(decoded.mint).toBe("https://local.mint/");
    expect(decoded.unit).toBe("msat");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps read-only mint snapshots detached from store mutation", () => {
    const known = getKnownMints();
    known.push({ url: "https://local-only.mint" });

    expect(useWalletStore.getState().mints).toHaveLength(1);
  });

  it("routes relay mutations through the settings store", () => {
    const store = useSettingsStore.getState();
    userAddRelay("ws://localhost:7778/");
    userRemoveRelay("ws://localhost:7778");

    expect(store.addRelay).toHaveBeenCalledWith("ws://localhost:7778");
    expect(store.removeRelay).toHaveBeenCalledWith("ws://localhost:7778");
  });

  it("keeps relay URL validation in the facade", () => {
    expect(normalizeRelayUrl(" ws://localhost:7778/ ")).toBe("ws://localhost:7778");
    expect(getRelayUrlValidationError("https://relay.example")).toBe(
      "Relay URL must start with wss:// or local ws://",
    );
    expect(getRelayUrlValidationError("wss://relay.example")).toBe(
      "Relay URL must be the configured bitCaster relay or a local relay.",
    );
    expect(getRelayUrlValidationError("wss://relay.damus.io")).toBe(
      "Public Nostr relays are not supported. Use a bitCaster-owned relay.",
    );
    expect(() => userAddRelay("https://relay.example")).toThrow(
      "Relay URL must start with wss:// or local ws://",
    );
    expect(() => userAddRelay("wss://nos.lol")).toThrow(
      "Public Nostr relays are not supported. Use a bitCaster-owned relay.",
    );
  });

  it("creates NIP-17 payment requests with relays and a stable request id", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("abcdef12-3456-7890-abcd-ef1234567890");
    const nip17 = await import("@/lib/nip17");

    const result = userCreatePaymentRequest("https://active.mint/");

    expect(result.id).toBe("abcdef12");
    expect(result.request.unit).toBe("msat");
    expect(result.encoded).toMatch(/^creq/);
    expect(nip17.getNostrNprofile).toHaveBeenCalledWith("1".repeat(64), ["ws://localhost:7777"]);
  });

  it("fails payment request creation when the wallet has no mnemonic", () => {
    useWalletStore.setState({ mnemonic: "" });

    expect(() => userCreatePaymentRequest("https://active.mint")).toThrow("Wallet not set up");
  });
});
