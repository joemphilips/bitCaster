import {
  advanceGuiMarketFundingDelivery,
  type GuiEcashDepositRemote,
  type GuiEcashDepositRecoveryCursor,
} from "./guiMarketFundingPayment";
import { advanceGuiParticipationScoreDelivery } from "./participationScorePayment";
import {
  deferGuiOutgoingRecipientDelivery,
  getNextGuiOutgoingRecipientAttemptAt,
  listDueGuiOutgoingRecipientDeliveries,
} from "@/stores/gui-outgoing-recipient-coordinator";
import type { GuiOutgoingRecipientDeliveryRow } from "@/stores/gui-outgoing-recipient-delivery";
import { currentGuiWalletId } from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";

export interface GuiOutgoingPaymentRecoveryResult {
  remaining: GuiOutgoingRecipientDeliveryRow[];
  hasMore: boolean;
  nextCursor: GuiEcashDepositRecoveryCursor | null;
  nextAttemptAt: number | null;
  blocked: Array<{ deliveryId: string; error: string }>;
}

export async function reconcileGuiOutgoingPayments(input: {
  marketFundingRemote: GuiEcashDepositRemote;
  cursor?: GuiEcashDepositRecoveryCursor | null;
}): Promise<GuiOutgoingPaymentRecoveryResult> {
  await useWalletStore.getState().ensureImplicitWallet();
  const walletId = currentGuiWalletId();
  const page = await listDueGuiOutgoingRecipientDeliveries({
    walletId,
    cursor: input.cursor ?? null,
  });
  const remaining: GuiOutgoingRecipientDeliveryRow[] = [];
  const blocked: Array<{ deliveryId: string; error: string }> = [];
  for (const row of page.records) {
    try {
      const completed = await recoverOne(
        walletId,
        row,
        input.marketFundingRemote,
      );
      if (!completed) remaining.push(row);
    } catch {
      await deferGuiOutgoingRecipientDelivery({
        walletId,
        deliveryId: row.deliveryId,
      });
      remaining.push(row);
      blocked.push({
        deliveryId: row.deliveryId,
        error: "Outgoing payment recovery is temporarily blocked",
      });
    }
  }
  return {
    remaining,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    nextAttemptAt: await getNextGuiOutgoingRecipientAttemptAt(walletId),
    blocked,
  };
}

async function recoverOne(
  walletId: string,
  row: GuiOutgoingRecipientDeliveryRow,
  marketFundingRemote: GuiEcashDepositRemote,
): Promise<boolean> {
  if (row.adapter.kind === "market-funding") {
    const result = await advanceGuiMarketFundingDelivery(
      walletId,
      row.deliveryId,
      marketFundingRemote,
    );
    return result.status === "completed";
  }
  const result = await advanceGuiParticipationScoreDelivery(
    walletId,
    row.deliveryId,
  );
  if (result.kind === "preparing") {
    await deferGuiOutgoingRecipientDelivery({
      walletId,
      deliveryId: row.deliveryId,
    });
    return false;
  }
  return result.kind === "credited";
}
