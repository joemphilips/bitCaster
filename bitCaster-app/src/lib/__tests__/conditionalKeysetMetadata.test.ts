import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Proof } from "@cashu/cashu-ts";
import {
  resolveConditionalProofMetadata,
  storedConditionalProofsFromMintMetadata,
} from "../conditionalKeysetMetadata";

describe("conditional keyset metadata", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("stamps stored proofs from the mint keyset registry, not caller labels", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        keysets: [
          keyset("keyset-A", "condition-1", "A"),
          keyset("keyset-C", "condition-1", "C"),
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const stored = await storedConditionalProofsFromMintMetadata({
      mintUrl: "https://mint.example/",
      proofs: [proof("keyset-A", "a"), proof("keyset-C", "c")],
      expectedConditionId: "condition-1",
      reservedBy: "reservation-1",
      baseAsset: "usd",
    });

    expect(stored.map((row) => row.outcomeCollection)).toEqual(["A", "C"]);
    expect(stored.map((row) => row.marketId)).toEqual([
      "condition-1-A",
      "condition-1-C",
    ]);
    expect(stored.every((row) => row.reservedBy === "reservation-1")).toBe(
      true,
    );
    expect(stored.every((row) => row.baseAsset === "usd")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://mint.example/v1/conditional_keysets",
    );
  });

  it("fails closed when a proof keyset belongs to a different condition", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          keysets: [keyset("keyset-B", "condition-2", "B")],
        }),
      }),
    );

    await expect(
      resolveConditionalProofMetadata(
        "https://other-mint.example",
        proof("keyset-B", "b"),
        "condition-1",
      ),
    ).rejects.toThrow(
      "Conditional keyset keyset-B belongs to condition condition-2, expected condition-1",
    );
  });

  it("fails closed when a proof keyset is not registered by the mint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          keysets: [keyset("keyset-A", "condition-1", "A")],
        }),
      }),
    );

    await expect(
      resolveConditionalProofMetadata(
        "https://unknown-keyset.example",
        proof("keyset-Z", "z"),
        "condition-1",
      ),
    ).rejects.toThrow(
      "Conditional keyset keyset-Z is not known by the mint",
    );
  });
});

function keyset(id: string, conditionId: string, outcomeCollection: string) {
  return {
    id,
    condition_id: conditionId,
    outcome_collection: outcomeCollection,
    outcome_collection_id: outcomeCollection,
  };
}

function proof(id: string, secret: string): Proof {
  return {
    id,
    amount: 100,
    secret,
    C: `02${secret}`.padEnd(66, "0"),
  } as unknown as Proof;
}
