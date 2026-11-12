import type { EncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk";

type FundedPlan = { readonly kind: "ready" | "insufficient" | "not-reducible" | "round-limit" };

type BrowserFundedAssetRecoveryDiagnostic = "local-plan" | "profile-or-lock";

/**
 * The local proof plan of one funded action. The recovery index holds no
 * proofs (ADR-051), so local custody is the only source: an insufficient
 * plan is an ordinary insufficient balance.
 */
export type BrowserFundedAssetRecoveryOutcome<TPlan extends FundedPlan> =
  | { readonly kind: "ready"; readonly plan: TPlan }
  | { readonly kind: "not-recoverable"; readonly plan: TPlan }
  | { readonly kind: "unavailable" }
  | { readonly kind: "persistent-error" };

export interface BrowserFundedAssetRecoveryInput<TPlan extends FundedPlan> {
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly loadPlan: () => Promise<TPlan>;
  readonly isCurrentProfile: () => boolean;
}

/** Classify the local proof plan of one exact funded action. */
export async function recoverBrowserFundedAsset<TPlan extends FundedPlan>(
  input: BrowserFundedAssetRecoveryInput<TPlan>,
): Promise<BrowserFundedAssetRecoveryOutcome<TPlan>> {
  let failureStage: BrowserFundedAssetRecoveryDiagnostic = "local-plan";
  try {
    if (input.asset.unit !== "msat") throw new Error("funded asset recovery requires msat");
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
        return { kind: "not-recoverable", plan };
      default:
        return assertNever(plan.kind);
    }
  } catch {
    console.warn(`funded-recovery-code=${failureStage}`);
    return { kind: "persistent-error" };
  }
}

function requireCurrent(
  input: Pick<BrowserFundedAssetRecoveryInput<FundedPlan>, "isCurrentProfile">,
): void {
  if (!input.isCurrentProfile()) throw new Error("browser funded recovery profile is stale");
}

function assertNever(value: never): never {
  throw new Error(`unexpected funded plan: ${String(value)}`);
}
