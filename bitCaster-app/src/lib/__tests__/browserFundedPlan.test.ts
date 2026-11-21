// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk";
import { classifyBrowserFundedPlan } from "../browserFundedPlan";

const asset = createEncryptedWalletBackupV2AssetIdentity({
  mintUrl: "https://mint.example",
  unit: "msat",
  asset: { kind: "ordinary" },
});

type Plan = { readonly kind: "ready" | "insufficient" | "not-reducible" | "round-limit" };

function input(loadPlan: () => Promise<Plan>, isCurrentProfile = () => true) {
  return { asset, loadPlan, isCurrentProfile };
}

// The recovery index holds no proofs (ADR-051), so the local plan is the only
// source of a funded action.
describe("classifyBrowserFundedPlan", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("returns a ready local plan", async () => {
    await expect(
      classifyBrowserFundedPlan(input(async () => ({ kind: "ready" }))),
    ).resolves.toEqual({ kind: "ready", plan: { kind: "ready" } });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("reports an insufficient local plan as an ordinary shortfall", async () => {
    await expect(
      classifyBrowserFundedPlan(input(async () => ({ kind: "insufficient" }))),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(["not-reducible", "round-limit"] as const)(
    "classifies a %s plan as limited",
    async (kind) => {
      await expect(classifyBrowserFundedPlan(input(async () => ({ kind })))).resolves.toEqual({
        kind: "limited",
        plan: { kind },
      });
    },
  );

  it("rejects a sat product asset before loading the local plan", async () => {
    const loadPlan = vi.fn(async (): Promise<Plan> => ({ kind: "ready" }));

    await expect(
      classifyBrowserFundedPlan({ ...input(loadPlan), asset: { ...asset, unit: "sat" } }),
    ).resolves.toEqual({ kind: "persistent-error" });
    expect(loadPlan).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("funded-plan-code=local-plan");
  });

  it("fails closed when the profile changes while the plan loads", async () => {
    let current = true;
    const loadPlan = async (): Promise<Plan> => {
      current = false;
      return { kind: "ready" };
    };

    await expect(classifyBrowserFundedPlan(input(loadPlan, () => current))).resolves.toEqual({
      kind: "persistent-error",
    });
    expect(console.warn).toHaveBeenCalledWith("funded-plan-code=profile-or-lock");
  });

  it("labels a failed local plan", async () => {
    await expect(
      classifyBrowserFundedPlan(
        input(async () => {
          throw new Error("local custody read failed");
        }),
      ),
    ).resolves.toEqual({ kind: "persistent-error" });
    expect(console.warn).toHaveBeenCalledWith("funded-plan-code=local-plan");
  });
});
