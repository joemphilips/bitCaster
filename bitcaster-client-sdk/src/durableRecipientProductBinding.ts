import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const PRODUCT_BINDING_DOMAIN = "bitcaster/durable-recipient-product/v1";
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;

export function participationScoreRecipientProductBinding(): string {
  return hashProductBinding(`${PRODUCT_BINDING_DOMAIN}\nparticipation-score`);
}

export function marketFundingRecipientProductBinding(input: {
  divisibility: number;
  fundAmm: boolean;
  creatorPubkey: string | null;
}): string {
  if (
    !Number.isSafeInteger(input.divisibility) ||
    input.divisibility < 2 ||
    input.divisibility > 2_147_483_647
  ) {
    throw new Error("Market funding product divisibility is invalid");
  }
  if (
    input.creatorPubkey !== null &&
    !/^[0-9a-f]{64}$/.test(input.creatorPubkey)
  ) {
    throw new Error("Market funding product creator is invalid");
  }
  if (input.fundAmm !== (input.creatorPubkey !== null)) {
    throw new Error("Market funding product AMM attribution is invalid");
  }
  return hashProductBinding(
    [
      PRODUCT_BINDING_DOMAIN,
      "market-funding",
      String(input.divisibility),
      input.fundAmm ? "1" : "0",
      input.creatorPubkey ?? "",
    ].join("\n"),
  );
}

export function requireDurableRecipientProductBinding(
  value: unknown,
): string {
  if (typeof value !== "string" || !LOWER_HEX_64.test(value)) {
    throw new Error("Durable recipient product binding is invalid");
  }
  return value;
}

function hashProductBinding(canonical: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}
