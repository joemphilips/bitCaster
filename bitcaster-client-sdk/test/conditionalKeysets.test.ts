import assert from "node:assert/strict";
import { test } from "node:test";
import { clearConditionalKeysetsCache, getConditionalKeysets } from "../src/conditionalKeysets.ts";

test("getConditionalKeysets caches transport responses by cache key", async () => {
  clearConditionalKeysetsCache("mint-cache-test");
  let calls = 0;
  const transport = {
    getConditionalKeysets: async () => {
      calls += 1;
      return [
        {
          id: `keyset-${calls}`,
          condition_id: "condition",
          outcome_collection: "YES",
          outcome_collection_id: "YES",
        },
      ];
    },
  };

  const first = await getConditionalKeysets({ transport, cacheKey: "mint-cache-test" });
  const second = await getConditionalKeysets({ transport, cacheKey: "mint-cache-test" });

  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  first[0].id = "mutated";
  const third = await getConditionalKeysets({ transport, cacheKey: "mint-cache-test" });
  assert.equal(third[0].id, "keyset-1");
});
