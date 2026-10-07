import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, getEncodedTokenV4, type Proof } from "@cashu/cashu-ts";
import { BitcasterDB } from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";

// This public testnet fixture is permanently spent. Never use an unspent
// bearer token as a source fixture.
const TESTNUT_V4_TOKEN =
  "cashuBo2F0gaJhaUgBiEp0uy_F7mFwhKNhYRBhc3hAMGE3ZDg3OWY4ZGY2OTRkY2RiMjc5NGQ0YzQ3ZDNhMjI4ODk3YzBiNWQ0MjhkMTFkYmJlZDQ5N2JjYTEzMGUyYmFjWCEC6E46HGmFL4V0zCB44J5iA4tFstICSsuTnj_4caoMXXSjYWEQYXN4QDM0OWJiZGQ1YjMyNjVlZWFjYTA0MGUyNGExZGQ0MmNlNTUxMDIzYmEyOTE4MzliZmM2Yjg0ZWRiMTdlZDExMDJhY1ghA-XD2T9-GXjmTgeXfVa1Xj-HuAVvnzVINliMHhhFqD3ao2FhEGFzeEA0ZDhmYzEzMTQzNmMyNzBkNDNjYmZjMmRkMjQ3MTlhZDM5Yjc2MzJmZGFiNTJhMWY0ODk0Y2U5MGNiYTU4NjgwYWNYIQIhQapBCpm5NWU0uwjNHqQBoVAFF2PxGmo1l9NpV20fs6NhYQJhc3hAYmRjNDg3NjQyN2Y2YWZjZjlmNjg1ODllNjIxNTg5ODkwNDQ3NWRjODU2OGZjOTYyOWYzZTcxODQzZjQ5ZTk4NWFjWCED4y_imdNoYT_5Uy8C8HH90nzU7DXWEG7xZLXlFsn_27VhbXgbaHR0cHM6Ly90ZXN0bnV0LmNhc2h1LnNwYWNlYXVjc2F0";

const TESTNUT_SAT_KEYSET = "01884a74bb2fc5ee6e5f958f89f9e4e6cf79241fbc9fd1012d6811b054a78beffe";

describe("extractMintUrlFromV4Token", () => {
  // P8 smoke regression — see commit message for context.
  //
  // Pasting a cashuB v4 token from a mint NOT yet in the user's store used
  // to throw "Couldn't map short keyset ID … to any known keysets of the
  // current Mint" because decodeToken's last-resort path fetched keysets from
  // the user's ACTIVE mint (e.g. bitcaster-staging) instead of the token's
  // issuing mint (e.g. testnut.cashu.space). The fix is a CBOR walker that
  // reads the v4 token's `m` field directly so we can target the right mint.
  //
  // These tests pin the extractor's behaviour directly so a future refactor
  // that drops or weakens the CBOR walk fails CI loudly rather than silently
  // re-introducing the bug (which only manifests against a real third-party
  // mint that the test environment can't easily simulate).
  it("returns the issuing mint URL from a real testnut v4 token", async () => {
    const { extractMintUrlFromV4Token } = await import("@/lib/cashu");
    expect(extractMintUrlFromV4Token(TESTNUT_V4_TOKEN)).toBe("https://testnut.cashu.space");
  });

  it("returns null for non-cashuB tokens (v3, junk, empty)", async () => {
    const { extractMintUrlFromV4Token } = await import("@/lib/cashu");
    expect(extractMintUrlFromV4Token("cashuAabcd")).toBeNull();
    expect(extractMintUrlFromV4Token("not-a-token")).toBeNull();
    expect(extractMintUrlFromV4Token("")).toBeNull();
  });

  it("returns null on CBOR garbage rather than throwing", async () => {
    const { extractMintUrlFromV4Token } = await import("@/lib/cashu");
    // valid base64 of garbage that is not a CBOR map
    expect(extractMintUrlFromV4Token("cashuBYWFhYQ")).toBeNull();
  });
});

it("rejects product sat minting before mint I/O", async () => {
  const { mintProofsForUnit } = await import("@/lib/cashu");
  await expect(mintProofsForUnit(1, {} as never, "https://mint.example", "sat")).rejects.toThrow(
    /requires msat/,
  );
});

it("receives a multi-proof conditional v4 token through real ingress and validation", async () => {
  vi.resetModules();
  const database = new BitcasterDB(`cashu-conditional-receive-${crypto.randomUUID()}`);
  const mint = "https://conditional-mint.example";
  const conditionId = "ab".repeat(32);
  const outcomeCollection = "YES";
  const keysetId = `01${"cd".repeat(32)}`;
  const sourceProofs = Array.from({ length: 5 }, (_, index) => {
    const byte = (index + 17).toString(16).padStart(2, "0");
    return {
      id: keysetId,
      amount: Amount.from(1),
      secret: `conditional-token-input-${index}`,
      C: `02${byte.repeat(32)}`,
      dleq: {
        e: (index + 33).toString(16).padStart(2, "0").repeat(32),
        s: (index + 49).toString(16).padStart(2, "0").repeat(32),
        r: (index + 65).toString(16).padStart(2, "0").repeat(32),
      },
    } as Proof;
  });
  const successors = sourceProofs.map((proof, index) => ({
    ...proof,
    secret: `conditional-token-output-${index}`,
  }));
  const token = getEncodedTokenV4({ mint, unit: "msat", proofs: sourceProofs });
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${mint}/v1/keysets`) {
      return new Response(JSON.stringify({ keysets: [] }), { status: 200 });
    }
    if (url === `${mint}/v1/conditional_keysets?limit=100`) {
      return new Response(
        JSON.stringify({
          next_cursor: null,
          keysets: [
            {
              id: keysetId,
              unit: "msat",
              active: true,
              condition_id: conditionId,
              registered_at: 0,
            },
          ],
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected conditional import fetch: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  const wallet = {
    getKeyset: vi.fn(() => ({
      conditional: { conditionId, outcomeCollection },
    })),
  };
  const walletModule = await import("@/stores/wallet");
  const addMintWithoutActivating = vi.fn().mockResolvedValue(undefined);
  walletModule.useWalletStore.setState({
    activeMintUrl: mint,
    mints: [],
    _addMintWithoutActivating: addMintWithoutActivating as never,
  });
  const receiveModule = await import("@/lib/browserDurableWalletReceive");
  const getWallet = vi
    .spyOn(walletModule, "getWalletForMnemonicUnit")
    .mockResolvedValue(wallet as never);
  const receive = vi
    .spyOn(receiveModule, "receiveBrowserDurableWalletToken")
    .mockResolvedValue(successors);
  const seed = new Uint8Array(64).fill(7);
  const context = {
    activeMintUrl: mint,
    database,
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    seed,
    scopeId: "wallet-conditional-import",
    requireCapturedProfile: () => undefined,
  };
  let restoreCapture: (() => void) | undefined;

  try {
    const { decodeTokenImportLocally } =
      await import("@bitcaster/client-sdk/tokenImportValidation");
    const shortKeysetId = keysetId.slice(0, 16);
    expect(decodeTokenImportLocally(token).proofs.map((proof) => proof.id)).toEqual(
      Array.from({ length: 5 }, () => shortKeysetId),
    );
    const cashu = await import("@/lib/cashu");
    const capture = vi
      .spyOn(cashu, "captureBrowserMintPersistenceContext")
      .mockReturnValue(context as never);
    restoreCapture = () => capture.mockRestore();
    const walletOps = await import("@/lib/walletOps");
    const received = await walletOps.ingressReceiveCashuToken(token, "paste");

    expect(capture).toHaveBeenCalledOnce();
    expect(addMintWithoutActivating).toHaveBeenCalledWith(mint);
    expect(getWallet).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${mint}/v1/keysets`,
      `${mint}/v1/conditional_keysets?limit=100`,
    ]);
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        token,
        mintUrl: mint,
        unit: "msat",
        asset: "conditional",
        conditionalInputProofs: sourceProofs.map((proof) =>
          expect.objectContaining({
            id: keysetId,
            secret: proof.secret,
            dleq: proof.dleq,
          }),
        ),
        ensureConditionalCounterReady: expect.any(Function),
        wallet,
        context,
      }),
    );
    expect(received.amountSubunits).toBe(5);
    expect(received.proofs).toHaveLength(5);
    expect(received.proofs.map(({ secret }) => secret)).toEqual(
      successors.map(({ secret }) => secret),
    );
  } finally {
    restoreCapture?.();
    receive.mockRestore();
    getWallet.mockRestore();
    globalThis.fetch = originalFetch;
    database.close();
    await database.delete();
  }
});

describe("decodeToken real v4 fixture", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    useWalletStore.setState({
      mints: [],
      activeMintUrl: "https://active.example",
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://testnut.cashu.space/v1/keysets") {
        return new Response(
          JSON.stringify({
            keysets: [
              {
                id: TESTNUT_SAT_KEYSET,
                unit: "sat",
                active: true,
                input_fee_ppk: 100,
                final_expiry: null,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("decodes a real testnut token by fetching keysets from the token mint", async () => {
    const { decodeToken } = await import("@/lib/cashu");

    const decoded = await decodeToken(TESTNUT_V4_TOKEN);

    expect(decoded.mint).toBe("https://testnut.cashu.space");
    expect(decoded.proofs).toHaveLength(4);
    expect(decoded.proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0)).toBe(50);
    expect([...new Set(decoded.proofs.map((proof) => proof.id))]).toEqual([TESTNUT_SAT_KEYSET]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
      "https://testnut.cashu.space/v1/keysets",
    );
  });

  it("refuses a sat receive before mint or wallet work", async () => {
    const { receiveAndStoreTokenRecoverably } = await import("@/lib/cashu");
    const walletModule = await import("@/stores/wallet");
    const wallet = vi.spyOn(walletModule, "getWalletForMnemonicUnit");

    await expect(
      receiveAndStoreTokenRecoverably(
        TESTNUT_V4_TOKEN,
        "https://testnut.cashu.space",
        "sat",
        "sat",
        "ordinary-sat",
      ),
    ).rejects.toThrow("Product wallet receive requires msat tokens");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wallet).not.toHaveBeenCalled();
  });
});
