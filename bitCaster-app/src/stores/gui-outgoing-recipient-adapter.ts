import type { DurableRecipientDeliveryIntent } from "@bitcaster/client-sdk/durableWalletSendDeliveryPreparation";
import {
  marketFundingRecipientProductBinding,
  participationScoreRecipientProductBinding,
} from "@bitcaster/client-sdk/durableRecipientProductBinding";

export type GuiOutgoingRecipientAdapter =
  | { kind: "participation-score" }
  | {
      kind: "market-funding";
      divisibility: number;
      fundAmm: boolean;
      creatorPubkey: string | null;
    };

export function requireGuiOutgoingRecipientAdapter(
  value: unknown,
): GuiOutgoingRecipientAdapter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GUI outgoing recipient adapter is invalid");
  }
  const adapter = value as Record<string, unknown>;
  if (
    adapter.kind === "participation-score" &&
    Object.keys(adapter).length === 1
  ) {
    return { kind: adapter.kind };
  }
  if (
    adapter.kind === "market-funding" &&
    Object.keys(adapter).length === 4 &&
    Number.isSafeInteger(adapter.divisibility) &&
    (adapter.divisibility as number) >= 2 &&
    (adapter.divisibility as number) <= 2_147_483_647 &&
    typeof adapter.fundAmm === "boolean" &&
    (adapter.creatorPubkey === null ||
      (typeof adapter.creatorPubkey === "string" &&
        /^[0-9a-f]{64}$/.test(adapter.creatorPubkey))) &&
    adapter.fundAmm === (adapter.creatorPubkey !== null)
  ) {
    return {
      kind: adapter.kind,
      divisibility: adapter.divisibility as number,
      fundAmm: adapter.fundAmm,
      creatorPubkey: adapter.creatorPubkey as string | null,
    };
  }
  throw new Error("GUI outgoing recipient adapter is invalid");
}

export function assertGuiOutgoingRecipientAdapterMatchesDelivery(
  adapter: GuiOutgoingRecipientAdapter,
  request: DurableRecipientDeliveryIntent,
): void {
  const valid =
    adapter.kind === "participation-score"
      ? request.recipientKind === "matching-engine" &&
        request.purpose === "participation-score" &&
        request.destinationId === "participation-score" &&
        request.unit === "sat" &&
        request.creditPolicy.kind === "exact-amount" &&
        request.productBinding === participationScoreRecipientProductBinding()
      : request.recipientKind === "matching-engine" &&
        request.purpose === "market-funding" &&
        request.creditPolicy.kind === "net-of-receive-fee" &&
        request.productBinding ===
          marketFundingRecipientProductBinding(adapter);
  if (!valid) {
    throw new Error("GUI outgoing recipient adapter conflicts with delivery");
  }
}
