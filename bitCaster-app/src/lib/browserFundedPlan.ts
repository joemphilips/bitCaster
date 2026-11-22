import type { EncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk";

type FundedPlan = { readonly kind: "ready" | "insufficient" | "not-reducible" | "round-limit" };

type BrowserFundedPlanDiagnostic = "local-plan" | "profile-or-lock";

/**
 * The class of the local proof plan of one funded action. The recovery index
 * holds no proofs (ADR-051), so local custody is the only source: an
 * insufficient plan is an ordinary insufficient balance, and a plan that the
 * input or round limits refuse stays `limited`.
 */
export type BrowserFundedPlanOutcome<TPlan extends FundedPlan> =
  | { readonly kind: "ready"; readonly plan: TPlan }
  | { readonly kind: "limited"; readonly plan: TPlan }
  | { readonly kind: "unavailable" }
  | { readonly kind: "persistent-error" };

export interface BrowserFundedPlanInput<TPlan extends FundedPlan> {
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly loadPlan: () => Promise<TPlan>;
  readonly isCurrentProfile: () => boolean;
}

/** Classify the local proof plan of one exact funded action. */
export async function classifyBrowserFundedPlan<TPlan extends FundedPlan>(
  input: BrowserFundedPlanInput<TPlan>,
): Promise<BrowserFundedPlanOutcome<TPlan>> {
  let failureStage: BrowserFundedPlanDiagnostic = "local-plan";
  try {
    if (input.asset.unit !== "msat") throw new Error("funded plan requires msat");
    failureStage = "profile-or-lock";
    requireCurrent(input);
    failureStage = "local-plan";
    const plan = await input.loadPlan();
    failureStage = "profile-or-lock";
    requireCurrent(input);
    switch (plan.kind) {
      case "ready":
        return { kind: "ready", plan };
      case "insufficient":
        return { kind: "unavailable" };
      case "not-reducible":
      case "round-limit":
        return { kind: "limited", plan };
      default:
        return assertNever(plan.kind);
    }
  } catch {
    console.warn(`funded-plan-code=${failureStage}`);
    return { kind: "persistent-error" };
  }
}

function requireCurrent(input: Pick<BrowserFundedPlanInput<FundedPlan>, "isCurrentProfile">): void {
  if (!input.isCurrentProfile()) throw new Error("browser funded plan profile is stale");
}

function assertNever(value: never): never {
  throw new Error(`unexpected funded plan: ${String(value)}`);
}
