import {
  marketFundingStatusToDeliveryEvidence,
  type MarketFundingPaymentStatusResponse,
} from "@bitcaster/client-sdk/engineClient";
import type { DurableRecipientDeliveryRequest } from "@bitcaster/client-sdk/durableRecipientDelivery";
import type { DurableOutgoingRecipientDeliveryTransport } from "@bitcaster/client-sdk/durableOutgoingRecipientDelivery";
import { marketFundingRecipientProductBinding } from "@bitcaster/client-sdk/durableRecipientProductBinding";
import { readDurableRecipientSubmissionAuthority } from "@bitcaster/client-sdk/durableRecipientSubmission";
import {
  parseMarketBaseAsset,
  type CashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
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

export type GuiEcashDepositState =
  MarketFundingPaymentStatusResponse["state"];

export interface GuiEcashDepositProductRequest {
  conditionId: string;
  mintUrl: string;
  amountSubunits: number;
  unit: CashuProofUnit;
  divisibility: number;
  fundAmm: boolean;
  creatorPubkey: string | null;
  fundingIdentity: string;
}

export interface GuiEcashDepositSubmission {
  depositId: string;
  token: string;
  request: GuiEcashDepositProductRequest;
}

export interface GuiEcashDepositStatusRequest {
  depositId: string;
  request: GuiEcashDepositProductRequest;
}

export interface GuiEcashDepositSubmitter {
  currentFundingIdentity(): string;
  submit(input: GuiEcashDepositSubmission): Promise<{
    depositId: string;
    state: GuiEcashDepositState;
  }>;
}

export interface GuiEcashDepositStatusReader {
  getStatus(
    input: GuiEcashDepositStatusRequest,
  ): Promise<MarketFundingPaymentStatusResponse | null>;
}

export interface GuiEcashDepositRemote
  extends GuiEcashDepositSubmitter,
    GuiEcashDepositStatusReader {}

export type GuiLocalWalletPaymentResult =
  | { status: "completed"; depositId: string }
  | { status: "insufficient" }
  | {
      status: "pending";
      depositId: string;
      remoteState: GuiEcashDepositState;
    }
  | { status: "transport-ambiguous"; depositId: string; error: string };

export interface GuiLocalWalletPaymentInput {
  mintUrl: string;
  amountSubunits: number;
  baseAsset: string;
  unit: CashuProofUnit;
  request: {
    conditionId: string;
    divisibility: number;
    fundAmm: boolean;
    creatorPubkey: string | null;
    fundingIdentity: string;
  };
  remote: GuiEcashDepositRemote;
}

export type GuiEcashDepositRecoveryCursor = [
  nextAttemptAtMs: number,
  deliveryId: string,
];

export async function executeGuiLocalWalletPayment(
  input: GuiLocalWalletPaymentInput,
): Promise<GuiLocalWalletPaymentResult> {
  await useWalletStore.getState().ensureImplicitWallet();
  parseMarketBaseAsset(input.baseAsset);
  const walletId = currentGuiWalletId();
  const mintUrl = normalizeUrl(input.mintUrl);
  const proofs = await withGuiCustodyProfileLockForWallet(
    walletId,
    async (_context, lock) =>
      getBoundedUnitProofsForAmountUnderLock(lock, mintUrl, {
        unit: input.unit,
        minimumAmount: input.amountSubunits,
      }),
  );
  if (totalProofAmount(proofs) < input.amountSubunits) {
    return { status: "insufficient" };
  }
  const depositId = crypto.randomUUID();
  const productBinding = marketFundingRecipientProductBinding({
    divisibility: input.request.divisibility,
    fundAmm: input.request.fundAmm,
    creatorPubkey: input.request.creatorPubkey,
  });
  await sendGuiCashuToDurableRecipient({
    expectedWalletId: walletId,
    amount: input.amountSubunits,
    proofs,
    mintUrl,
    unit: input.unit,
    recipient: {
      deliveryId: depositId,
      accountSubject: input.request.fundingIdentity,
      recipientKind: "matching-engine",
      purpose: "market-funding",
      destinationId: input.request.conditionId,
      productBinding,
      mintUrl,
      unit: input.unit,
      requestedAmount: String(input.amountSubunits),
      creditPolicy: { kind: "net-of-receive-fee" },
    },
    adapter: {
      kind: "market-funding",
      divisibility: input.request.divisibility,
      fundAmm: input.request.fundAmm,
      creatorPubkey: input.request.creatorPubkey,
    },
  });
  return advanceGuiMarketFundingDelivery(walletId, depositId, input.remote);
}

export async function retryGuiEcashDeposit(
  depositId: string,
  remote: GuiEcashDepositRemote,
): Promise<GuiLocalWalletPaymentResult> {
  await useWalletStore.getState().ensureImplicitWallet();
  return advanceGuiMarketFundingDelivery(
    currentGuiWalletId(),
    depositId,
    remote,
  );
}

export async function observeGuiEcashDeposit(
  depositId: string,
  remote: GuiEcashDepositStatusReader,
): Promise<GuiLocalWalletPaymentResult | null> {
  await useWalletStore.getState().ensureImplicitWallet();
  const walletId = currentGuiWalletId();
  const row = await requireMarketFundingRow(walletId, depositId);
  const request = marketFundingProductRequest(row);
  const status = await remote.getStatus({ depositId, request });
  if (!status) return null;
  const evidence = marketFundingStatusToDeliveryEvidence(status);
  if (evidence.kind === "not-found") {
    return pendingResult(depositId, status.state);
  }
  const result = await advanceGuiOutgoingRecipientDeliveryOnce({
    walletId,
    deliveryId: depositId,
    transport: {
      readStatus: async () => evidence,
      submitExact: async () => {
        throw new Error("Observed market funding status regressed");
      },
    },
  });
  return result.kind === "credited"
    ? { status: "completed", depositId }
    : pendingResult(depositId, status.state);
}

export async function advanceGuiMarketFundingDelivery(
  walletId: string,
  depositId: string,
  remote: GuiEcashDepositRemote,
): Promise<GuiLocalWalletPaymentResult> {
  const row = await requireMarketFundingRow(walletId, depositId);
  const request = marketFundingProductRequest(row);
  if (remote.currentFundingIdentity() !== request.fundingIdentity) {
    throw new Error("Market funding identity changed during recovery");
  }
  try {
    const result = await advanceGuiOutgoingRecipientDeliveryOnce({
      walletId,
      deliveryId: depositId,
      transport: createGuiMarketFundingTransport(remote, request),
    });
    if (result.kind === "credited") {
      return { status: "completed", depositId };
    }
    return pendingResult(
      depositId,
      result.kind === "received" ? "paid" : "requested",
    );
  } catch {
    return {
      status: "transport-ambiguous",
      depositId,
      error: "Market funding payment is pending and will retry automatically.",
    };
  }
}

export function createGuiMarketFundingTransport(
  remote: GuiEcashDepositRemote,
  product: GuiEcashDepositProductRequest,
): DurableOutgoingRecipientDeliveryTransport {
  return {
    readStatus: async (request) => {
      assertProductMatchesDelivery(product, request);
      assertCurrentFundingIdentity(remote, product);
      const status = await remote.getStatus({
        depositId: request.deliveryId,
        request: product,
      });
      return status
        ? marketFundingStatusToDeliveryEvidence(status)
        : { kind: "not-found" as const };
    },
    submitExact: async (authority) => {
      const submission = readDurableRecipientSubmissionAuthority(authority);
      assertProductMatchesDelivery(product, submission.request);
      assertCurrentFundingIdentity(remote, product);
      const response = await remote.submit({
        depositId: submission.request.deliveryId,
        token: submission.encodedToken,
        request: product,
      });
      if (
        response.depositId !== submission.request.deliveryId ||
        (response.state !== "paid" && response.state !== "credited")
      ) {
        return { kind: "accepted" as const };
      }
      assertCurrentFundingIdentity(remote, product);
      const status = await remote.getStatus({
        depositId: submission.request.deliveryId,
        request: product,
      });
      if (!status) {
        throw new Error("Market funding status is unavailable after receipt");
      }
      return {
        kind: "evidence" as const,
        evidence: marketFundingStatusToDeliveryEvidence(status),
      };
    },
  };
}

function assertCurrentFundingIdentity(
  remote: GuiEcashDepositSubmitter,
  product: GuiEcashDepositProductRequest,
): void {
  if (remote.currentFundingIdentity() !== product.fundingIdentity) {
    throw new Error("Market funding identity changed during recovery");
  }
}

async function requireMarketFundingRow(
  walletId: string,
  depositId: string,
): Promise<GuiOutgoingRecipientDeliveryRow> {
  const row = await getGuiOutgoingRecipientDelivery(walletId, depositId);
  if (!row || row.adapter.kind !== "market-funding") {
    throw new Error("Market funding payment is missing");
  }
  return row;
}

function marketFundingProductRequest(
  row: GuiOutgoingRecipientDeliveryRow,
): GuiEcashDepositProductRequest {
  if (
    row.adapter.kind !== "market-funding" ||
    row.delivery.kind !== "active"
  ) {
    throw new Error("Market funding payment is not ready");
  }
  const request = row.delivery.record.delivery.request;
  if (
    request.recipientKind !== "matching-engine" ||
    request.purpose !== "market-funding" ||
    request.creditPolicy.kind !== "net-of-receive-fee" ||
    request.productBinding !== marketFundingRecipientProductBinding(row.adapter)
  ) {
    throw new Error("Market funding payment route is invalid");
  }
  return {
    conditionId: request.destinationId,
    mintUrl: request.mintUrl,
    amountSubunits: Number(request.requestedAmount),
    unit: requireCashuUnit(request.unit),
    divisibility: row.adapter.divisibility,
    fundAmm: row.adapter.fundAmm,
    creatorPubkey: row.adapter.creatorPubkey,
    fundingIdentity: request.accountSubject,
  };
}

function assertProductMatchesDelivery(
  product: GuiEcashDepositProductRequest,
  request: DurableRecipientDeliveryRequest,
): void {
  if (
    request.accountSubject !== product.fundingIdentity ||
    request.recipientKind !== "matching-engine" ||
    request.purpose !== "market-funding" ||
    request.destinationId !== product.conditionId ||
    request.productBinding !==
      marketFundingRecipientProductBinding(product) ||
    request.mintUrl !== product.mintUrl ||
    request.unit !== product.unit ||
    request.requestedAmount !== String(product.amountSubunits) ||
    request.creditPolicy.kind !== "net-of-receive-fee"
  ) {
    throw new Error("Market funding product binding conflicts");
  }
}

function requireCashuUnit(value: string): CashuProofUnit {
  if (value === "sat" || value === "msat" || value === "usd") return value;
  throw new Error("Market funding unit is invalid");
}

function totalProofAmount(
  proofs: readonly { amount: Parameters<typeof amountToNumber>[0] }[],
): number {
  return proofs.reduce(
    (total, proof) => total + amountToNumber(proof.amount),
    0,
  );
}

function pendingResult(
  depositId: string,
  remoteState: GuiEcashDepositState,
): GuiLocalWalletPaymentResult {
  return { status: "pending", depositId, remoteState };
}
