import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Amount,
  Mint as CashuMint,
  MintOperationError,
  type SerializedBlindedMessage,
  type Proof,
} from "@cashu/cashu-ts";

describe("cashu-ts mint error transport", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("preserves MintOperationError.code for fake 13015 responses", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          code: 13015,
          detail: "Oracle has not attested to this outcome collection",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }) as never;

    const mint = new CashuMint("http://mint.test");
    const output: SerializedBlindedMessage = {
      amount: Amount.from(1),
      id: "regular-keyset",
      B_: "02".padEnd(66, "0"),
    };
    const input = {
      amount: Amount.from(1),
      id: "conditional-keyset",
      secret: "conditional-secret",
      C: "02".padEnd(66, "1"),
    } as unknown as Proof;

    await expect(mint.redeemOutcome({ inputs: [input], outputs: [output] })).rejects.toMatchObject({
      name: "MintOperationError",
      code: 13015,
      status: 400,
      message: "Oracle has not attested to this outcome collection",
    });

    await expect(mint.redeemOutcome({ inputs: [input], outputs: [output] })).rejects.toBeInstanceOf(
      MintOperationError,
    );
  });
});
