import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckStateEnum, type Proof } from "@cashu/cashu-ts";
import { diagnoseProofStates } from "../proofDiagnostics";

describe("proof diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs state counts and keyset ids without proof secrets", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const proofs = [
      proof("keyset-a", "secret-one"),
      proof("keyset-a", "secret-two"),
      proof("keyset-b", "secret-three"),
    ];
    const wallet = {
      checkProofsStates: vi.fn(async () => [
        { Y: "y1", state: CheckStateEnum.UNSPENT, witness: null },
        { Y: "y2", state: CheckStateEnum.SPENT, witness: null },
        { Y: "y3", state: CheckStateEnum.UNSPENT, witness: null },
      ]),
    };

    const summary = await diagnoseProofStates({
      label: "test",
      mintUrl: "https://mint.example",
      proofs,
      wallet,
      extra: { order: "order-1" },
    });

    expect(summary?.stateCounts).toEqual({ UNSPENT: 2, SPENT: 1 });
    expect(summary?.keysetIds).toEqual(["keyset-a", "keyset-b"]);
    expect(wallet.checkProofsStates).toHaveBeenCalledWith([
      { id: "keyset-a", secret: "secret-one" },
      { id: "keyset-a", secret: "secret-two" },
      { id: "keyset-b", secret: "secret-three" },
    ]);
    const serializedLog = JSON.stringify(info.mock.calls);
    expect(serializedLog).not.toContain("secret-one");
    expect(serializedLog).not.toContain("secret-two");
    expect(serializedLog).not.toContain("secret-three");
  });
});

function proof(id: string, secret: string): Proof {
  return {
    id,
    secret,
    amount: 1,
    C: "02".padEnd(66, "0"),
  } as unknown as Proof;
}
