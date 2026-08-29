import {
  BrowserParticipationScoreInsufficientBalanceError,
  executeBrowserParticipationScoreDelivery,
  reconcileBrowserParticipationScoreDeliveryIfPresent,
} from "@/lib/browserParticipationScoreDelivery";
import {
  claimBrowserParticipationScoreDeliveryPointer,
  clearBrowserParticipationScoreDeliveryPointer,
  readBrowserParticipationScoreDeliveryPointer,
} from "@/lib/browserParticipationScoreDeliveryPointer";
import { captureBrowserMintPersistenceContext } from "@/lib/cashu";
import { resolveCreatorPubkey } from "@/lib/identityOps";
import {
  getParticipationScore,
  type ParticipationScoreResponse,
} from "@/lib/markets";
import { useSettingsStore } from "@/stores/settings";
import { planParticipationScoreTopUp } from "@bitcaster/client-sdk/participationScore";

export interface ParticipationScorePaymentResult {
  paymentId: string;
  status: "credited";
  amountSats: number;
  creditedScore: number;
  creditedAt: string;
}

export type ParticipationScorePreflightResult =
  | {
      kind: "disabled" | "sufficient";
      score: ParticipationScoreResponse;
    }
  | {
      kind: "needs-regular-top-up";
      score: ParticipationScoreResponse;
      requiredSats: number;
      balanceSats: number;
      deficitSats: number;
    }
  | {
      kind: "paid";
      score: ParticipationScoreResponse;
      payment: ParticipationScorePaymentResult;
      paymentId: string;
    };

export async function ensureParticipationScoreForNextMatch(input: {
  mintUrl: string;
  paymentId?: string;
  requiredScore: number;
}): Promise<ParticipationScorePreflightResult> {
  if (!input.mintUrl) {
    throw new Error("Select an active mint before paying engine Score.");
  }
  const settings = useSettingsStore.getState();
  const accountSubject = resolveCreatorPubkey({
    nostrSignerMode: settings.nostrSignerMode,
    nsecSecret: settings.nsecSecret,
    nostrProfilePubkey: settings.nostrProfile?.pubkey,
  });
  if (!accountSubject) throw new Error("The active wallet identity is unavailable.");
  const context = captureBrowserMintPersistenceContext();
  const pointer = await readBrowserParticipationScoreDeliveryPointer({
    accountSubject,
    mintUrl: input.mintUrl,
    context,
  });
  let creditedPointer = null as typeof pointer;
  if (pointer !== null) {
    const current = await reconcileBrowserParticipationScoreDeliveryIfPresent({
      deliveryId: pointer.deliveryId,
      accountSubject,
      mintUrl: input.mintUrl,
    });
    if (current !== null && current.progress !== "credited") {
      throw new Error("Participation Score delivery is pending authoritative credit.");
    }
    if (current?.progress === "credited") {
      creditedPointer = pointer;
    }
  }
  const score = await getParticipationScore();
  if (creditedPointer !== null) {
    if (score.purchasedTotal <= creditedPointer.purchaseEpoch) {
      throw new Error("Participation Score credit is waiting for authoritative projection.");
    }
    await clearBrowserParticipationScoreDeliveryPointer({
      pointer: creditedPointer,
      accountSubject,
      mintUrl: input.mintUrl,
      context,
    });
  }
  const plan = planParticipationScoreTopUp(score, input.requiredScore);
  if (plan.kind === "disabled") return { kind: "disabled", score };
  if (plan.kind === "sufficient") return { kind: "sufficient", score };
  const candidatePaymentId = input.paymentId ?? crypto.randomUUID();
  const claimed = await claimBrowserParticipationScoreDeliveryPointer({
    deliveryId: candidatePaymentId,
    purchaseEpoch: score.purchasedTotal,
    accountSubject,
    mintUrl: input.mintUrl,
    context,
  });
  try {
    const delivery = await executeBrowserParticipationScoreDelivery({
      deliveryId: claimed.deliveryId,
      accountSubject,
      mintUrl: input.mintUrl,
      requestedAmount: String(plan.deficitScore),
    });
    if (delivery.progress !== "credited") {
      throw new Error("Participation Score delivery is pending authoritative credit.");
    }
    const result = delivery.delivery?.result;
    if (result === null || result === undefined || result.businessEventAt === undefined) {
      throw new Error("Participation Score delivery lacks authoritative credit evidence.");
    }
    return {
      kind: "paid",
      score,
      paymentId: delivery.transfer.transferId,
      payment: {
        paymentId: delivery.transfer.transferId,
        status: "credited",
        amountSats: Number(delivery.transfer.requestedAmount),
        creditedScore: Number(result.creditedAmount),
        creditedAt: result.businessEventAt,
      },
    };
  } catch (error) {
    if (error instanceof BrowserParticipationScoreInsufficientBalanceError) {
      return {
        kind: "needs-regular-top-up",
        score,
        requiredSats: plan.deficitScore,
        balanceSats: error.balanceSats,
        deficitSats: plan.deficitScore - error.balanceSats,
      };
    }
    throw error;
  }
}
