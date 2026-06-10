import { spendRegularSatsAsToken } from "@/lib/cashu";
import {
  getParticipationScore,
  payParticipationScoreEcash,
  type ParticipationScoreResponse,
  type PayParticipationScoreEcashResponse,
} from "@/lib/markets";
import { getBalance } from "@/stores/wallet";
import { planParticipationScoreTopUp } from "@bitcaster/client-sdk/participationScore";

const SCORE_PAYMENT_ATTEMPTS = 3;

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
      payment: PayParticipationScoreEcashResponse;
      paymentId: string;
    };

export async function ensureParticipationScoreForNextMatch(input: {
  mintUrl: string;
  paymentId?: string;
}): Promise<ParticipationScorePreflightResult> {
  if (!input.mintUrl) {
    throw new Error("Select an active mint before paying engine Score.");
  }

  const score = await getParticipationScore();
  const plan = planParticipationScoreTopUp(score);
  if (plan.kind === "disabled") return { kind: "disabled", score };
  if (plan.kind === "sufficient") return { kind: "sufficient", score };

  const deficitSats = plan.deficitScore;
  const regularBalance = await getBalance(input.mintUrl, { baseAsset: "sat" });
  if (regularBalance < deficitSats) {
    return {
      kind: "needs-regular-top-up",
      score,
      requiredSats: deficitSats,
      balanceSats: regularBalance,
      deficitSats: deficitSats - regularBalance,
    };
  }

  const paymentId = input.paymentId ?? crypto.randomUUID();
  const token = await spendRegularSatsAsToken(deficitSats, input.mintUrl);
  const payment = await payParticipationScoreEcashWithRetry(
    deficitSats,
    token,
    paymentId,
  );
  return { kind: "paid", score, payment, paymentId };
}

async function payParticipationScoreEcashWithRetry(
  amountSats: number,
  token: string,
  paymentId: string,
): Promise<PayParticipationScoreEcashResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < SCORE_PAYMENT_ATTEMPTS; attempt += 1) {
    try {
      return await payParticipationScoreEcash(amountSats, token, paymentId);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to pay Engine Score.");
}
