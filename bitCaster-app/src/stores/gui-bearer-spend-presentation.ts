import { requireGuiBearerSpendDeliveryRow } from "./gui-bearer-spend-delivery";
import { withGuiCustodyProfileLockForWallet } from "./gui-custody-authority";
import { requireGuiWalletSendDeliveryPayloadRow } from "./gui-wallet-send-delivery";
import { db } from "./proof-db";

export class GuiBearerSpendTokenPresentationRevoked extends Error {
  constructor() {
    super("GUI bearer spend token presentation is no longer authorized");
    this.name = "GuiBearerSpendTokenPresentationRevoked";
  }
}

export async function readGuiBearerSpendTokenPresentable(
  walletId: string,
  operationId: string,
): Promise<boolean> {
  try {
    return (await readPresentableToken(walletId, operationId)) !== null;
  } catch {
    return false;
  }
}

export async function withGuiBearerSpendTokenPresentation(
  walletId: string,
  operationId: string,
  present: (token: string) => Promise<void>,
): Promise<void> {
  let presentationStarted = false;
  let presentationCompletion: Promise<void> | null = null;
  try {
    await withGuiCustodyProfileLockForWallet(walletId, async () => {
      const token = await readPresentableToken(walletId, operationId);
      if (token === null) {
        throw new GuiBearerSpendTokenPresentationRevoked();
      }
      presentationStarted = true;
      presentationCompletion = present(token);
    });
  } catch (error) {
    if (
      !presentationStarted &&
      !(error instanceof GuiBearerSpendTokenPresentationRevoked)
    ) {
      throw new GuiBearerSpendTokenPresentationRevoked();
    }
    throw error;
  }
  if (presentationCompletion === null) {
    throw new GuiBearerSpendTokenPresentationRevoked();
  }
  await presentationCompletion;
}

async function readPresentableToken(
  walletId: string,
  operationId: string,
): Promise<string | null> {
  return db.transaction(
    "r",
    db.bearerSpendDeliveries,
    db.walletSendDeliveryPayloads,
    async () => {
      const payloadHandle = `wallet-send:${operationId}`;
      const rawDelivery = await db.bearerSpendDeliveries
        .where("[walletId+payloadHandle]")
        .equals([walletId, payloadHandle])
        .first();
      if (!rawDelivery) return null;
      const delivery = requireGuiBearerSpendDeliveryRow(
        rawDelivery,
        walletId,
        undefined,
        rawDelivery.parentOperationId,
      );
      if (delivery.presentable !== 1) return null;
      const rawPayload = await db.walletSendDeliveryPayloads.get([
        walletId,
        operationId,
      ]);
      if (!rawPayload) return null;
      const payload = requireGuiWalletSendDeliveryPayloadRow(
        rawPayload,
        walletId,
        operationId,
        delivery.parentOperationId,
      );
      if (
        payload.tokenDigest !== delivery.record.tokenDigest ||
        payload.tokenByteLength !== delivery.record.tokenByteLength
      ) {
        throw new Error("GUI bearer spend presentation authority conflicts");
      }
      return payload.encodedToken;
    },
  );
}
