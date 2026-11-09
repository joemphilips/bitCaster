import { describe, expect, it } from "vitest";
import { marketResolutionState } from "../marketResolution";

describe("marketResolutionState", () => {
  it.each([
    ["closed", undefined],
    ["closed", null],
    ["closed", ""],
    ["closed", "   "],
  ] as const)(
    "keeps a %s market with outcome %j awaiting resolution, not resolved",
    (state, outcome) => {
      expect(marketResolutionState(state, outcome)).toBe("awaitingResolution");
    },
  );

  it.each([
    ["closed", "Yes"],
    ["open", "No"],
    [null, "Team B"],
  ] as const)("resolves a %s market only when its outcome %j is known", (state, outcome) => {
    expect(marketResolutionState(state, outcome)).toBe("resolved");
  });

  it.each([
    ["open", undefined],
    [null, undefined],
    [undefined, null],
  ] as const)("keeps a %s market without an outcome open", (state, outcome) => {
    expect(marketResolutionState(state, outcome)).toBe("open");
  });

  it("refuses an engine state that the contract does not define", () => {
    expect(() => marketResolutionState("paused" as never, undefined)).toThrow();
  });
});
