import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProofUnit } from "../src/proofUnit.ts";

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
