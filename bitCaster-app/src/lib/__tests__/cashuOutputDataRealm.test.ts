import { describe, expect, it } from "vitest";
import { Amount, OutputData } from "@cashu/cashu-ts";

describe("Cashu output bytes in the browser test realm", () => {
  it("uses real realm-local Uint8Array values for UTF-8 text", () => {
    const encoded = new TextEncoder().encode("Aé😀");
    expect(encoded instanceof Uint8Array).toBe(true);
    expect([...encoded]).toEqual([65, 195, 169, 240, 159, 152, 128]);
    expect([...new TextEncoder().encode()]).toEqual([]);
  });
  it("retains native encodeInto counts and partial code-point behavior", () => {
    const destination = new Uint8Array(5);
    expect(new TextEncoder().encodeInto("Aé😀", destination)).toEqual({ read: 2, written: 3 });
    expect([...destination]).toEqual([65, 195, 169, 0, 0]);
  });
  it("constructs explicit and deterministic Cashu outputs without weakening byte guards", () => {
    const id = `01${"ab".repeat(32)}`;
    expect(OutputData.createSingleData(1, id, "fixture", 3n).secret.length).toBeGreaterThan(0);
    expect(
      OutputData.createSingleDeterministicData(1, new Uint8Array(64).fill(7), 0, id).secret.length,
    ).toBeGreaterThan(0);
    expect(
      () => new OutputData({ id, amount: Amount.from(1), B_: "02" }, 3n, new Uint8Array()),
    ).toThrow(/non-empty Uint8Array/);
  });
});
