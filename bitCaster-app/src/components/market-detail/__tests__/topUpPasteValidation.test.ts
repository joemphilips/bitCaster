import type { Token } from "@cashu/cashu-ts";
import { describe, expect, it, vi } from "vitest";
import {
  TOP_UP_ECASH_MAX_BYTES,
  validateTopUpEcashToken,
  type DecodeCashuToken,
} from "../topUpPasteValidation";

function token(overrides: Partial<Token> = {}): Token {
  return {
    mint: "https://mint.example",
    unit: "msat",
    proofs: [{ id: "keyset-msat", amount: 15_000, secret: "s", C: "c" }],
    ...overrides,
  } as Token;
}

describe("validateTopUpEcashToken", () => {
  it("rejects tokens over the 100KB paste limit before decoding", async () => {
    const decodeCashuToken = vi.fn<DecodeCashuToken>();

    const result = await validateTopUpEcashToken("x".repeat(TOP_UP_ECASH_MAX_BYTES + 1), {
      activeMintUrl: "https://mint.example",
      baseAsset: "sat",
      deficit: 1,
      decodeCashuToken,
    });

    expect(result).toMatchObject({ ok: false, code: "too_large" });
    expect(decodeCashuToken).not.toHaveBeenCalled();
  });

  it("returns a decode error for invalid Cashu tokens", async () => {
    const result = await validateTopUpEcashToken("not-cashu", {
      activeMintUrl: "https://mint.example",
      baseAsset: "sat",
      deficit: 1,
      decodeCashuToken: vi.fn<DecodeCashuToken>().mockRejectedValue(new Error("invalid")),
    });

    expect(result).toEqual({ ok: false, code: "decode_failed" });
  });

  it("rejects tokens from a non-active mint", async () => {
    const result = await validateTopUpEcashToken("cashuB-token", {
      activeMintUrl: "https://mint.example",
      baseAsset: "sat",
      deficit: 1,
      decodeCashuToken: vi
        .fn<DecodeCashuToken>()
        .mockResolvedValue(token({ mint: "https://other.example/" })),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "mint_mismatch",
      values: { mintUrl: "https://other.example" },
    });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["unknown", "btc"],
  ])("rejects %s token unit metadata", async (_label, unit) => {
    const result = await validateTopUpEcashToken("cashuB-token", {
      activeMintUrl: "https://mint.example",
      baseAsset: "sat",
      deficit: 1,
      decodeCashuToken: vi
        .fn<DecodeCashuToken>()
        .mockResolvedValue(token({ unit: unit as Token["unit"] })),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "unit_invalid",
      values: { tokenUnit: unit ? unit : "missing" },
    });
  });

  it("rejects unsupported token units for sat markets", async () => {
    const result = await validateTopUpEcashToken("cashuB-token", {
      activeMintUrl: "https://mint.example",
      baseAsset: "sat",
      deficit: 1,
      decodeCashuToken: vi.fn<DecodeCashuToken>().mockResolvedValue(token({ unit: "usd" })),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "unit_invalid",
      values: { tokenUnit: "usd" },
    });
  });

  it("rejects tokens that do not cover the deficit", async () => {
    const result = await validateTopUpEcashToken("cashuB-token", {
      activeMintUrl: "https://mint.example",
      baseAsset: "sat",
      deficit: 1_500,
      decodeCashuToken: vi.fn<DecodeCashuToken>().mockResolvedValue(
        token({
          unit: "msat",
          proofs: [{ id: "keyset-msat", amount: 1_000 as never, secret: "s", C: "c" }],
        }),
      ),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "amount_too_low",
      values: { covered: "1 sats", needed: "1.5 sats" },
    });
  });

  it("accepts msat tokens that cover a sat-market deficit", async () => {
    const result = await validateTopUpEcashToken("cashuB-token", {
      activeMintUrl: "https://mint.example/",
      baseAsset: "sat",
      deficit: 10_000,
      decodeCashuToken: vi.fn<DecodeCashuToken>().mockResolvedValue(
        token({
          mint: "https://mint.example",
          unit: "msat",
          proofs: [{ id: "keyset-msat", amount: 10_000 as never, secret: "s", C: "c" }],
        }),
      ),
    });

    expect(result).toMatchObject({
      ok: true,
      mintUrl: "https://mint.example",
      unit: "msat",
      baseAsset: "sat",
      tokenAmountSubunits: 10_000,
    });
  });

  it("converts sat-unit proof amounts to sat-market subunits for coverage", async () => {
    const result = await validateTopUpEcashToken("cashuB-token", {
      activeMintUrl: "https://mint.example",
      baseAsset: "sat",
      deficit: 10_000,
      decodeCashuToken: vi.fn<DecodeCashuToken>().mockResolvedValue(
        token({
          unit: "sat",
          proofs: [{ id: "keyset-sat", amount: 10 as never, secret: "s", C: "c" }],
        }),
      ),
    });

    expect(result).toMatchObject({ ok: true, tokenAmountSubunits: 10_000 });
  });
});
