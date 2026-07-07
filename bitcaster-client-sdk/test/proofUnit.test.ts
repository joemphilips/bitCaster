import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProofUnit } from "../src/proofUnit.ts";
import { clearConditionalKeysetsCache } from "../src/conditionalKeysets.ts";

test("resolveProofUnit resolves conditional keyset units when regular metadata is absent", async () => {
  const unit = await resolveProofUnit(
    { getKeySets: async () => ({ keysets: [{ id: "regular-usd", unit: "usd" }] }) },
    [{ id: "ctf-usd-yes" }],
    {
      conditionalKeysets: [
        {
          id: "ctf-usd-yes",
          unit: "usd",
          condition_id: "condition",
          outcome_collection: "YES",
          outcome_collection_id: "YES",
        },
      ],
    },
  );

  assert.equal(unit, "usd");
});

test("resolveProofUnit fails closed for unknown or mixed proof units", async () => {
  await assert.rejects(
    () => resolveProofUnit(
      { getKeySets: async () => ({ keysets: [{ id: "regular-usd", unit: "usd" }] }) },
      [{ id: "missing" }],
    ),
    /Mint did not return unit metadata/,
  );

  await assert.rejects(
    () => resolveProofUnit(
      { getKeySets: async () => ({ keysets: [{ id: "a", unit: "sat" }, { id: "b", unit: "usd" }] }) },
      [{ id: "a" }, { id: "b" }],
    ),
    /mixed units: sat, usd/,
  );
});

test("resolveProofUnit refreshes stale conditional keyset cache before failing", async () => {
  clearConditionalKeysetsCache("proof-unit-stale-cache-test");
  let calls = 0;
  const transport = {
    getConditionalKeysets: async () => {
      calls += 1;
      return calls === 1
        ? [
            {
              id: "older-ctf",
              unit: "sat",
              condition_id: "older-condition",
              outcome_collection: "YES",
              outcome_collection_id: "YES",
            },
          ]
        : [
            {
              id: "new-ctf",
              unit: "sat",
              condition_id: "new-condition",
              outcome_collection: "YES",
              outcome_collection_id: "YES",
            },
          ];
    },
  };

  await assert.rejects(
    () => resolveProofUnit(
      { getKeySets: async () => ({ keysets: [] }) },
      [{ id: "not-present" }],
      {
        conditionalKeysetTransport: transport,
        cacheKey: "proof-unit-stale-cache-test",
      },
    ),
    /Mint did not return unit metadata/,
  );

  const unit = await resolveProofUnit(
    { getKeySets: async () => ({ keysets: [] }) },
    [{ id: "new-ctf" }],
    {
      conditionalKeysetTransport: transport,
      cacheKey: "proof-unit-stale-cache-test",
    },
  );

  assert.equal(unit, "sat");
  assert.equal(calls, 2);
});
