import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenImportKeysetRequest } from "@bitcaster/client-sdk/tokenImportValidation";
import { resolveTokenImportKeysets } from "@/lib/tokenImportKeysetResolver";

const REGULAR_ID = "0011223344556677";
const CONDITIONAL_ID = "00ffeeddccbbaa99";

function request(
  encodedKeysetIds: readonly string[],
  overrides: Partial<TokenImportKeysetRequest> = {},
): TokenImportKeysetRequest {
  return {
    canonicalMintUrl: "https://mint.example",
    encodedKeysetIds,
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 10_000,
    maxCandidates: 8,
    ...overrides,
  };
}

function response(keysets: unknown[]) {
  return new Response(JSON.stringify({ keysets }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveTokenImportKeysets", () => {
  it("returns requested inactive regular and conditional keysets without active-only filtering", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = String(input);
      return url.endsWith("/v1/conditional_keysets")
        ? response([
            { id: CONDITIONAL_ID, unit: "msat", active: false },
            { id: "00aaaaaaaaaaaaaa", unit: "msat", active: true },
          ])
        : response([
            { id: REGULAR_ID, unit: "sat", active: false },
            { id: "00bbbbbbbbbbbbbb", unit: "sat", active: true },
          ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveTokenImportKeysets(request([REGULAR_ID, CONDITIONAL_ID]));

    expect(result.regularKeysets).toEqual([{ keysetId: REGULAR_ID, unit: "sat", active: false }]);
    expect(result.conditionalKeysets).toEqual([
      { keysetId: CONDITIONAL_ID, unit: "msat", active: false },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://mint.example/v1/keysets",
      "https://mint.example/v1/conditional_keysets",
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });

  it("resolves a modern encoded keyset prefix to its full registry id", async () => {
    const prefix = "1122334455667788";
    const fullId = `${prefix}${"aa".repeat(24)}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) =>
        String(input).endsWith("/v1/conditional_keysets")
          ? response([])
          : response([{ id: fullId, unit: "sat", active: true }]),
      ),
    );

    const result = await resolveTokenImportKeysets(request([prefix]));

    expect(result.regularKeysets).toEqual([{ keysetId: fullId, unit: "sat", active: true }]);
  });

  it("enforces the combined regular and conditional candidate bound", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) =>
        String(input).endsWith("/v1/conditional_keysets")
          ? response([{ id: CONDITIONAL_ID, unit: "msat", active: true }])
          : response([{ id: REGULAR_ID, unit: "sat", active: true }]),
      ),
    );

    await expect(
      resolveTokenImportKeysets(
        request([REGULAR_ID, CONDITIONAL_ID], {
          maxCandidates: 1,
        }),
      ),
    ).rejects.toThrow("Mint keyset lookup exceeded the candidate bound");
  });

  it("rejects an oversized response before reading its body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            headers: { "Content-Length": String(1_048_577) },
          }),
      ),
    );

    await expect(resolveTokenImportKeysets(request([REGULAR_ID]))).rejects.toThrow(
      "Mint keyset response byte limit exceeded",
    );
  });

  it("rejects an already-aborted or expired request before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveTokenImportKeysets(request([REGULAR_ID], { signal: controller.signal })),
    ).rejects.toThrow("Mint keyset lookup deadline elapsed");
    await expect(
      resolveTokenImportKeysets(request([REGULAR_ID], { deadlineMs: Date.now() - 1 })),
    ).rejects.toThrow("Mint keyset lookup deadline elapsed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
