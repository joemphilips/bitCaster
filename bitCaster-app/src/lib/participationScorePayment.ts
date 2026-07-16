import {
  getParticipationScore,
  getParticipationScorePayment,
  payParticipationScoreEcash,
  type ParticipationScoreResponse,
  type PayParticipationScoreEcashResponse,
} from "@/lib/markets";
import { assertNever } from "@/lib/enumDiscipline";
import { normalizeUrl } from "@/lib/url";
import { withGuiCustodyProfileLockForWallet } from "@/stores/gui-custody-authority";
import {
  advanceGuiOutgoingRecipientDeliveryOnce,
  getGuiOutgoingRecipientDelivery,
} from "@/stores/gui-outgoing-recipient-coordinator";
import type { GuiOutgoingRecipientDeliveryRow } from "@/stores/gui-outgoing-recipient-delivery";
import { sendGuiCashuToDurableRecipient } from "@/stores/gui-ordinary-wallet-operation";
import {
  currentGuiWalletId,
  getBoundedUnitProofsForAmountUnderLock,
} from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";
import type { DurableOutgoingRecipientDeliveryTransport } from "@bitcaster/client-sdk/durableOutgoingRecipientDelivery";
import type { DurableRecipientDeliveryRequest } from "@bitcaster/client-sdk/durableRecipientDelivery";
import { participationScoreRecipientProductBinding } from "@bitcaster/client-sdk/durableRecipientProductBinding";
import { readDurableRecipientSubmissionAuthority } from "@bitcaster/client-sdk/durableRecipientSubmission";
import { scorePaymentStatusToDeliveryEvidence } from "@bitcaster/client-sdk/engineClient";
import {
  deriveParticipationScorePaymentId,
  planParticipationScoreTopUp,
} from "@bitcaster/client-sdk/participationScore";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";

const SCORE_PAYMENT_ATTEMPTS = 3;

interface GuiParticipationScoreProduct {
  accountSubject: string;
  mintUrl: string;
  amountSats: number;
  productBinding: string;
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
  await useWalletStore.getState().ensureImplicitWallet();
  const score = await getParticipationScore();
  const plan = planParticipationScoreTopUp(score);
  if (plan.kind === "disabled") return { kind: "disabled", score };
  if (plan.kind === "sufficient") return { kind: "sufficient", score };

  const walletId = currentGuiWalletId();
  const mintUrl = normalizeUrl(input.mintUrl);
  const amountSats = plan.deficitScore;
  const paymentId =
    input.paymentId ??
    (await deriveParticipationScorePaymentId({
      walletScopeId: walletId,
      accountSubject: score.accountSubject,
      mintUrl,
      amountSats,
      balance: score.balance,
      purchasedTotal: score.purchasedTotal,
      consumedTotal: score.consumedTotal,
      penaltyTotal: score.penaltyTotal,
      matchDebitScore: score.matchDebitScore,
    }));
  const product = {
    accountSubject: score.accountSubject,
    mintUrl,
    amountSats,
    productBinding: participationScoreRecipientProductBinding(),
  } satisfies GuiParticipationScoreProduct;

  const existing = await getGuiOutgoingRecipientDelivery(walletId, paymentId);
  if (existing) {
    assertParticipationScoreProduct(
      product,
      participationScoreProductRequest(existing),
    );
  } else {
    const insufficient = await prepareParticipationScorePayment({
      walletId,
      paymentId,
      product,
    });
    if (insufficient !== null) {
      return {
        kind: "needs-regular-top-up",
        score,
        requiredSats: amountSats,
        balanceSats: insufficient,
        deficitSats: amountSats - insufficient,
      };
    }
  }

  for (let attempt = 0; attempt < SCORE_PAYMENT_ATTEMPTS; attempt += 1) {
    const result = await advanceGuiParticipationScoreDelivery(
      walletId,
      paymentId,
    );
    if (result.kind !== "credited") continue;
    if (result.row.delivery.kind !== "active") {
      throw new Error("Participation Score payment is not deliverable");
    }
    const state = result.row.delivery.record.delivery.state;
    if (state.kind !== "credited") {
      throw new Error("Participation Score payment credit is missing");
    }
    const payment = {
      paymentId,
      status: "credited",
      amountSats,
      creditedScore: Number(state.creditedAmount),
      creditedAt: new Date(state.creditedAtMs).toISOString(),
    } satisfies PayParticipationScoreEcashResponse;
    return { kind: "paid", score, payment, paymentId };
  }
  throw new Error(
    "Participation Score payment is pending and will retry automatically.",
  );
}

export async function advanceGuiParticipationScoreDelivery(
  walletId: string,
  paymentId: string,
): Promise<
  Awaited<ReturnType<typeof advanceGuiOutgoingRecipientDeliveryOnce>>
> {
  const row = await getGuiOutgoingRecipientDelivery(walletId, paymentId);
  if (!row) throw new Error("Participation Score payment is missing");
  const product = participationScoreProductRequest(row);
  await assertCurrentParticipationScoreAccount(product.accountSubject);
  return advanceGuiOutgoingRecipientDeliveryOnce({
    walletId,
    deliveryId: paymentId,
    transport: createGuiParticipationScorePaymentTransport(product),
  });
}

export function createGuiParticipationScorePaymentTransport(
  product: GuiParticipationScoreProduct,
): DurableOutgoingRecipientDeliveryTransport {
  return {
    readStatus: async (request: DurableRecipientDeliveryRequest) => {
      assertParticipationScoreDelivery(product, request);
      await assertCurrentParticipationScoreAccount(product.accountSubject);
      const status = await getParticipationScorePayment(request.deliveryId);
      return status
        ? scorePaymentStatusToDeliveryEvidence(status)
        : { kind: "not-found" as const };
    },
    submitExact: async (authority) => {
      const submission = readDurableRecipientSubmissionAuthority(authority);
      assertParticipationScoreDelivery(product, submission.request);
      await assertCurrentParticipationScoreAccount(product.accountSubject);
      const response = await payParticipationScoreEcash(
        product.accountSubject,
        product.amountSats,
        submission.encodedToken,
        submission.request.deliveryId,
      );
      switch (response.status) {
        case "pending":
          return { kind: "accepted" as const };
        case "credited":
          break;
        default:
          return assertNever(response.status);
      }
      const status = await getParticipationScorePayment(
        submission.request.deliveryId,
      );
      if (!status) {
        throw new Error("Participation Score status is unavailable after credit");
      }
      return {
        kind: "evidence" as const,
        evidence: scorePaymentStatusToDeliveryEvidence(status),
      };
    },
  };
}

async function prepareParticipationScorePayment(input: {
  walletId: string;
  paymentId: string;
  product: GuiParticipationScoreProduct;
}): Promise<number | null> {
  const proofs = await withGuiCustodyProfileLockForWallet(
    input.walletId,
    async (_context, lock) =>
      getBoundedUnitProofsForAmountUnderLock(lock, input.product.mintUrl, {
        unit: "sat",
        minimumAmount: input.product.amountSats,
      }),
  );
  const balanceSats = proofs.reduce(
    (sum, proof) => sum + amountToNumber(proof.amount),
    0,
  );
  if (balanceSats < input.product.amountSats) return balanceSats;
  try {
    await sendGuiCashuToDurableRecipient({
      expectedWalletId: input.walletId,
      amount: input.product.amountSats,
      proofs,
      mintUrl: input.product.mintUrl,
      unit: "sat",
      recipient: {
        deliveryId: input.paymentId,
        accountSubject: input.product.accountSubject,
        recipientKind: "matching-engine",
        purpose: "participation-score",
        destinationId: "participation-score",
        productBinding: input.product.productBinding,
        mintUrl: input.product.mintUrl,
        unit: "sat",
        requestedAmount: String(input.product.amountSats),
        creditPolicy: { kind: "exact-amount" },
      },
      adapter: { kind: "participation-score" },
    });
  } catch (error) {
    const raced = await getGuiOutgoingRecipientDelivery(
      input.walletId,
      input.paymentId,
    );
    if (!raced) throw error;
    assertParticipationScoreProduct(
      input.product,
      participationScoreProductRequest(raced),
    );
  }
  return null;
}

function participationScoreProductRequest(
  row: GuiOutgoingRecipientDeliveryRow,
): GuiParticipationScoreProduct {
  if (row.adapter.kind !== "participation-score") {
    throw new Error("Participation Score payment adapter is invalid");
  }
  const request =
    row.delivery.kind === "prepared"
      ? row.delivery.recipient
      : row.delivery.record.delivery.request;
  if (
    request.recipientKind !== "matching-engine" ||
    request.purpose !== "participation-score" ||
    request.destinationId !== "participation-score" ||
    request.productBinding !== participationScoreRecipientProductBinding() ||
    request.unit !== "sat" ||
    request.creditPolicy.kind !== "exact-amount"
  ) {
    throw new Error("Participation Score payment route is invalid");
  }
  const amountSats = Number(request.requestedAmount);
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new Error("Participation Score payment amount is invalid");
  }
  return {
    accountSubject: request.accountSubject,
    mintUrl: request.mintUrl,
    amountSats,
    productBinding: request.productBinding,
  };
}

function assertParticipationScoreDelivery(
  product: GuiParticipationScoreProduct,
  request: DurableRecipientDeliveryRequest,
): void {
  if (
    request.accountSubject !== product.accountSubject ||
    request.recipientKind !== "matching-engine" ||
    request.purpose !== "participation-score" ||
    request.destinationId !== "participation-score" ||
    request.productBinding !== product.productBinding ||
    request.mintUrl !== product.mintUrl ||
    request.unit !== "sat" ||
    request.requestedAmount !== String(product.amountSats) ||
    request.creditPolicy.kind !== "exact-amount"
  ) {
    throw new Error("Participation Score payment delivery is invalid");
  }
}

function assertParticipationScoreProduct(
  expected: GuiParticipationScoreProduct,
  actual: GuiParticipationScoreProduct,
): void {
  if (
    expected.accountSubject !== actual.accountSubject ||
    expected.mintUrl !== actual.mintUrl ||
    expected.amountSats !== actual.amountSats ||
    expected.productBinding !== actual.productBinding
  ) {
    throw new Error("Participation Score payment conflicts");
  }
}

async function assertCurrentParticipationScoreAccount(
  expectedAccountSubject: string,
): Promise<void> {
  const current = await getParticipationScore();
  if (current.accountSubject !== expectedAccountSubject) {
    throw new Error("Participation Score account changed during recovery");
  }
}
