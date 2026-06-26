import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLosingLegError,
  ORACLE_NOT_ATTESTED_OUTCOME_CODE,
} from "../src/ctfRedeem.ts";

test("isLosingLegError recognizes the mint oracle-not-attested error code", () => {
  assert.equal(isLosingLegError({ code: ORACLE_NOT_ATTESTED_OUTCOME_CODE }), true);
  assert.equal(isLosingLegError({ code: 13014 }), false);
  assert.equal(isLosingLegError(new Error("oracle not attested outcome")), false);
  assert.equal(isLosingLegError(null), false);
});
