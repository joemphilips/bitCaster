// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { RedeemWallet } from "@bitcaster/client-sdk/ctfRedeem";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import rawProducerResponse from "../../../../bitcaster-client-sdk/test/fixtures/d4/condition-info.json?raw";
import registered from "../../../../bitcaster-client-sdk/test/fixtures/d4/registered-authority.json";
import { createBrowserConditionOracleEvidenceResolver } from "../browserConditionOracleEvidence";

function fixture() {
  const info = JSON.parse(rawProducerResponse);
  const fetchRegistration = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ conditionId: registered.conditionId, registeredAuthority: registered }),
        ),
    );
  const getCondition = vi.fn().mockImplementation(async () => structuredClone(info));
  const wallet = { mint: { getCtfCondition: getCondition } } as unknown as RedeemWallet;
  const binding = {
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: "11".repeat(32) }),
    normalizedMint: registered.normalizedMint,
    conditionId: registered.conditionId,
    unit: "sat",
    canonicalParentCollectionId: null,
  };
  return {
    info,
    fetchRegistration,
    getCondition,
    wallet,
    binding,
    resolve: createBrowserConditionOracleEvidenceResolver(fetchRegistration),
  };
}

describe("Browser intended oracle evidence adapter", () => {
  it("verifies the actual sat producer response and reuses only matching cached evidence", async () => {
    const entry = fixture();
    const first = await entry.resolve(entry);
    expect(first.evidence.status).toBe("verified");
    expect(first.resolvedOutcome).toBe("YES");
    expect(entry.getCondition.mock.calls.map((call) => call[2].include_oracle_sigs)).toEqual([
      false,
      true,
    ]);
    const signal = entry.getCondition.mock.calls[0]![2].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(entry.fetchRegistration.mock.calls[0]![1]!.signal).toBe(signal);
    await expect(entry.resolve(entry)).resolves.toMatchObject({ evidence: { status: "verified" } });
    expect(entry.getCondition.mock.calls.map((call) => call[2].include_oracle_sigs)).toEqual([
      false,
      true,
      false,
    ]);

    entry.info.threshold = 2;
    await expect(entry.resolve(entry)).resolves.toMatchObject({
      evidence: { status: "unverified", reason: "invalid" },
    });
    entry.info.threshold = 1;
    await expect(entry.resolve(entry)).resolves.toMatchObject({ evidence: { status: "verified" } });
    expect(entry.getCondition.mock.calls.map((call) => call[2].include_oracle_sigs)).toEqual([
      false,
      true,
      false,
      false,
      false,
      true,
    ]);
  });

  it.each(["pending", "omitted"])(
    "uses verified engine evidence for %s mint attestation",
    async (status) => {
      const entry = fixture();
      const witness = { oracle_sigs: entry.info.attestation.oracle_sigs };
      entry.fetchRegistration.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              conditionId: registered.conditionId,
              registeredAuthority: registered,
              attestedOutcome: "YES",
              oracleWitness: witness,
            }),
          ),
      );
      entry.info.attestation = status === "pending" ? { status: "pending" } : undefined;
      await expect(entry.resolve(entry)).resolves.toMatchObject({
        evidence: { status: "verified", canonicalOracleWitness: expect.any(String) },
        resolvedOutcome: "YES",
      });
      expect(entry.getCondition).toHaveBeenCalledOnce();
      expect(entry.fetchRegistration).toHaveBeenCalledOnce();
    },
  );

  it("does not relabel a sat producer response as verified msat evidence", async () => {
    const entry = fixture();
    await expect(
      entry.resolve({ ...entry, binding: { ...entry.binding, unit: "msat" } }),
    ).resolves.toMatchObject({
      evidence: { status: "unverified", reason: "invalid" },
    });
    expect(entry.getCondition).toHaveBeenCalledOnce();
  });

  it.each(["mint", "registration", "signature"])(
    "returns a warning when %s evidence is unavailable",
    async (step) => {
      const entry = fixture();
      if (step === "mint") entry.getCondition.mockRejectedValue(new Error("private upstream text"));
      if (step === "registration")
        entry.fetchRegistration.mockRejectedValue(new Error("private upstream text"));
      if (step === "signature") {
        entry.getCondition.mockImplementation(async (_condition, _request, query) => {
          if (query.include_oracle_sigs) throw new Error("private upstream text");
          return entry.info;
        });
      }
      const result = await entry.resolve(entry);
      expect(result.evidence).toEqual({
        status: "unverified",
        reason: "unavailable",
        warning:
          "The mint reports this outcome, but we have not verified evidence from the intended oracle.",
      });
      expect(JSON.stringify(result)).not.toContain("private upstream text");
    },
  );

  it("rejects a changed result and foreign oracle without treating them as losing authority", async () => {
    const entry = fixture();
    await expect(entry.resolve(entry)).resolves.toMatchObject({ evidence: { status: "verified" } });
    entry.info.attestation.winning_outcome = "NO";
    await expect(entry.resolve(entry)).resolves.toMatchObject({
      evidence: { status: "unverified" },
      resolvedOutcome: "NO",
    });
    entry.info.attestation.winning_outcome = "YES";
    entry.info.attestation.oracle_sigs[0].oracle_pubkey = "22".repeat(32);
    await expect(entry.resolve(entry)).resolves.toMatchObject({
      evidence: { status: "unverified", reason: "invalid" },
    });
  });

  it("bounds the intended registration response before JSON parsing", async () => {
    const entry = fixture();
    entry.fetchRegistration.mockResolvedValue(
      new Response("{}", { headers: { "content-length": "65537" } }),
    );
    await expect(entry.resolve(entry)).resolves.toMatchObject({
      evidence: { status: "unverified", reason: "unavailable" },
    });
    expect(entry.getCondition).toHaveBeenCalledOnce();
  });
});
