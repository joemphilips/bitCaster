import { describe, it, expect } from "vitest";
import { isAttestationResolved, normalizeMintdStatus } from "../mintdIngress";

describe("normalizeMintdStatus (ingress boundary)", () => {
  it("passes through canonical lowercase values", () => {
    expect(normalizeMintdStatus("pending")).toBe("pending");
    expect(normalizeMintdStatus("attested")).toBe("attested");
    expect(normalizeMintdStatus("expired")).toBe("expired");
    expect(normalizeMintdStatus("violation")).toBe("violation");
  });

  it("maps null to 'pending' — fresh market with no attestation yet", () => {
    expect(normalizeMintdStatus(null)).toBe("pending");
  });

  it("maps undefined to 'pending'", () => {
    expect(normalizeMintdStatus(undefined)).toBe("pending");
  });

  it("lowercases mixed-case input (defensive against producer drift)", () => {
    expect(normalizeMintdStatus("Attested")).toBe("attested");
    expect(normalizeMintdStatus("PENDING")).toBe("pending");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeMintdStatus("  attested  ")).toBe("attested");
  });

  it("throws on unknown values so producer-side regressions surface loudly", () => {
    expect(() => normalizeMintdStatus("settled")).toThrow(/unknown mintd attestation status/);
    expect(() => normalizeMintdStatus(42)).toThrow(/unknown mintd attestation status/);
  });
});

describe("isAttestationResolved (total mapping over normalised status)", () => {
  it("treats 'pending' as unresolved", () => {
    expect(isAttestationResolved("pending")).toBe(false);
  });

  it("treats 'attested' as resolved", () => {
    expect(isAttestationResolved("attested")).toBe(true);
  });

  it("treats 'expired' as resolved (deadline passed without an attestation)", () => {
    expect(isAttestationResolved("expired")).toBe(true);
  });

  it("treats 'violation' as resolved (CET-violation reported)", () => {
    expect(isAttestationResolved("violation")).toBe(true);
  });
});
