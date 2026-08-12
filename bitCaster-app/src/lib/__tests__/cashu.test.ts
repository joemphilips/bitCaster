import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
