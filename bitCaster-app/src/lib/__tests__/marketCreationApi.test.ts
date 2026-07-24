import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerCondition,
  requiredMarketCreationOutcomeCollections,
  createMarket,
  MintError,
} from "../markets";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchSuccess(body: unknown) {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function mockFetchError(status: number, body: { code: number; detail: string }) {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
}

function mockFetchErrorNoBody(status: number) {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response("not json", { status }));
}

const conditionParams = { tags: [["description", "test"]], announcementHex: "abc123" };

describe("registerCondition", () => {
  it("returns condition_id on success", async () => {
    mockFetchSuccess({ condition_id: "cond-123", keysets: {} });
    const result = await registerCondition(conditionParams);
    expect(result.condition_id).toBe("cond-123");
  });

  it("throws MintError with CDK code 13011 on oracle announcement verification failure", async () => {
    mockFetchError(400, { code: 13011, detail: "Oracle announcement verification failed" });
    await expect(registerCondition(conditionParams)).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError);
      expect(e.code).toBe(13011);
      expect(e.detail).toBe("Oracle announcement verification failed");
      // message includes [Mint] prefix for UI display
      expect(e.message).toBe("[Mint] Oracle announcement verification failed");
      return true;
    });
  });

  it("throws MintError with CDK code 13020 on invalid condition ID", async () => {
    mockFetchError(400, { code: 13020, detail: "Invalid condition ID" });
    await expect(registerCondition(conditionParams)).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError);
      expect(e.code).toBe(13020);
      return true;
    });
  });

  it("throws MintError with CDK code 13027 on oracle threshold not met", async () => {
    mockFetchError(400, { code: 13027, detail: "Oracle threshold not met" });
    await expect(registerCondition(conditionParams)).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError);
      expect(e.code).toBe(13027);
      return true;
    });
  });

  it("throws MintError with CDK code 13028 on condition already exists", async () => {
    mockFetchError(409, { code: 13028, detail: "Condition already exists" });
    await expect(registerCondition(conditionParams)).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError);
      expect(e.code).toBe(13028);
      return true;
    });
  });

  it("throws MintError with code 0 and fallback message when body is not JSON", async () => {
    mockFetchErrorNoBody(500);
    await expect(registerCondition(conditionParams)).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError);
      expect(e.code).toBe(0);
      expect(e.detail).toBe("not json");
      return true;
    });
  });

  it("propagates network errors", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(registerCondition(conditionParams)).rejects.toThrow("Failed to fetch");
  });
  it("sends collateral and requested outcome collections when provided", async () => {
    mockFetchSuccess({ condition_id: "cond-123", keysets: { Yes: "ks1", No: "ks2" }, change: [] });
    const stringifyingAmount = {
      toNumber: () => 2,
      toJSON: () => "2",
    };
    const fee = [{ amount: stringifyingAmount, secret: "fee-secret", C: "fee-C" }] as any;
    const outputs = [{ amount: stringifyingAmount, id: "regular-keyset", B_: "B_" }] as any;
    await registerCondition({
      ...conditionParams,
      collateral: "sat",
      outcomeCollections: ["Yes", "No"],
      fee,
      outputs,
    });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(call[1]?.body as string);
    expect(body).toEqual({
      tags: conditionParams.tags,
      announcements: [conditionParams.announcementHex],
      collateral: "sat",
      outcome_collections: ["Yes", "No"],
      fee: [{ amount: 2, secret: "fee-secret", C: "fee-C" }],
      outputs: [{ amount: 2, id: "regular-keyset", B_: "B_" }],
    });
    expect(typeof body.fee[0].amount).toBe("number");
    expect(typeof body.outputs[0].amount).toBe("number");
  });
});

describe("requiredMarketCreationOutcomeCollections", () => {
  it("requests singleton and complement collections for n-outcome markets", () => {
    expect(requiredMarketCreationOutcomeCollections(["Alice", "Bob", "Carol"])).toEqual([
      "Alice",
      "Bob|Carol",
      "Bob",
      "Alice|Carol",
      "Carol",
      "Alice|Bob",
    ]);
  });

  it("deduplicates binary market collections", () => {
    expect(requiredMarketCreationOutcomeCollections(["Yes", "No"])).toEqual(["Yes", "No"]);
  });
});

const createMarketParams = {
  title: "Test Market",
  description: "Test description",
  outcomes: [
    { name: "Yes", probability: 50 },
    { name: "No", probability: 50 },
  ],
  liquiditySats: 10000,
  baseAsset: "sat" as const,
  divisibility: 100,
  categoryTags: ["crypto"],
};

// createMarket calls generateNip98Header which requires an NDK signer.
// Mock the nostr module so tests don't need a real signer.
vi.mock("@/lib/nostr", () => ({
  getNdk: () => ({
    signer: {
      sign: vi.fn(),
    },
  }),
}));

// Mock NDKEvent so NIP-98 header generation doesn't hit real crypto
vi.mock("@nostr-dev-kit/ndk", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@nostr-dev-kit/ndk")>();
  return {
    ...mod,
    NDKEvent: class MockNDKEvent {
      kind = 0;
      created_at = 0;
      content = "";
      tags: string[][] = [];
      async sign() {
        /* no-op */
      }
      rawEvent() {
        return {
          kind: this.kind,
          created_at: this.created_at,
          content: this.content,
          tags: this.tags,
          id: "mock",
          pubkey: "mock",
          sig: "mock",
        };
      }
    },
  };
});

describe("createMarket", () => {
  it("returns response on success", async () => {
    const body = {
      conditionId: "cond-123",
      marketsCreated: ["cond-123-Yes", "cond-123-No"],
      thumbnailUrl: null,
    };
    mockFetchSuccess(body);
    const result = await createMarket("cond-123", createMarketParams);
    expect(result.conditionId).toBe("cond-123");
    expect(result.marketsCreated).toEqual(["cond-123-Yes", "cond-123-No"]);
  });

  it("sends metadata as multipart form data", async () => {
    mockFetchSuccess({ conditionId: "cond-123", marketsCreated: [], thumbnailUrl: null });
    await createMarket("cond-123", createMarketParams);

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call[0]).toContain("/api/v1/markets/cond-123");
    expect(call[1]?.method).toBe("POST");
    // Body is pre-serialized so the NIP-98 `payload` tag can bind to the
    // exact bytes; Content-Type carries the multipart boundary fetch would
    // otherwise generate.
    expect(call[1]?.body).toBeInstanceOf(ArrayBuffer);
    const headers = call[1]?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(headers.Authorization).toMatch(/^Nostr /);
  });

  it("binds the NIP-98 token to the request body via SHA-256 payload tag", async () => {
    mockFetchSuccess({ conditionId: "cond-123", marketsCreated: [], thumbnailUrl: null });
    await createMarket("cond-123", createMarketParams);

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = call[1]?.headers as Record<string, string>;
    const body = call[1]?.body as ArrayBuffer;

    // Decode the NIP-98 token; mocked NDKEvent passes through the tags array.
    const token = headers.Authorization.replace(/^Nostr /, "");
    const event = JSON.parse(atob(token)) as { tags: string[][] };
    const payloadTag = event.tags.find((t) => t[0] === "payload");
    expect(payloadTag).toBeDefined();
    expect(payloadTag![1]).toMatch(/^[0-9a-f]{64}$/);

    // The tag value MUST equal SHA-256 of the bytes shipped to the server.
    const expectedDigest = await crypto.subtle.digest("SHA-256", body);
    const expectedHex = Array.from(new Uint8Array(expectedDigest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(payloadTag![1]).toBe(expectedHex);
  });

  it("throws on validation error (400)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("At least 2 outcomes required", { status: 400 }),
    );
    await expect(createMarket("cond-123", createMarketParams)).rejects.toThrow(
      /Failed to create market/,
    );
  });

  it("throws on conflict (409)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("Market already exists", { status: 409 }),
    );
    await expect(createMarket("cond-123", createMarketParams)).rejects.toThrow(
      /Failed to create market/,
    );
  });
});
