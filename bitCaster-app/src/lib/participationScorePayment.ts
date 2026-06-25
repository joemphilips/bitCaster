import { encodeToken, getWalletForUnit } from "@/lib/cashu";
import { normalizeUrl } from "@/lib/url";
import {
  getParticipationScore,
  payParticipationScoreEcash,
  type ParticipationScoreResponse,
  type PayParticipationScoreEcashResponse,
} from "@/lib/markets";
import { addProofs, getUnitProofs, removeProofs } from "@/stores/proof-db";
import type { StoredProof } from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
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
  const satProofs = await getSatKeysetProofs(input.mintUrl);
  const regularBalance = satProofs.reduce(
    (sum, proof) => sum + amountToNumber(proof.amount),
    0,
  );
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
  const token = await spendParticipationScoreSatsAsToken(
    deficitSats,
    input.mintUrl,
    satProofs,
  );
  const payment = await payParticipationScoreEcashWithRetry(
    deficitSats,
    token,
    paymentId,
  );
  return { kind: "paid", score, payment, paymentId };
}

async function spendParticipationScoreSatsAsToken(
  amountSats: number,
  mintUrl: string,
  proofs: StoredProof[],
): Promise<string> {
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new Error("Amount must be a positive integer number of sats.");
  }

  const wallet = await getWalletForUnit(mintUrl, "sat");
  const { keep, send } = await wallet.send(amountSats, proofs);
  await removeProofs(proofs.map((proof) => proof.secret));
  if (keep.length > 0) {
    await addProofs(
      keep.map((proof) => ({
        ...proof,
        mintUrl,
        baseAsset: "sat",
        unit: "sat",
      })),
    );
  }
  return encodeToken(send, mintUrl);
}

async function getSatKeysetProofs(mintUrl: string) {
  const normalizedMintUrl = normalizeUrl(mintUrl);
  const proofs = await getUnitProofs(mintUrl, { unit: "sat" });
  const satKeysetIds = new Set(
    useWalletStore
      .getState()
      .mints.find((mint) => normalizeUrl(mint.url) === normalizedMintUrl)
      ?.keysets?.filter((keyset) => keyset.unit === "sat")
      .map((keyset) => keyset.id) ?? [],
  );
  if (satKeysetIds.size === 0) return [];
  return proofs.filter((proof) => proof.id != null && satKeysetIds.has(proof.id));
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
