import { describe, expect, it } from "vitest";
import { deriveDurableCustodyWalletId } from "@bitcaster/client-sdk/durableCustody";
import { toSeed } from "../bip39";
import { browserWalletIdFromMnemonic } from "../browserWalletProfile";

describe("browserWalletIdFromMnemonic", () => {
  it("uses the canonical durable-custody wallet ID derivation", () => {
    const mnemonic =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    expect(browserWalletIdFromMnemonic(mnemonic)).toBe(
      deriveDurableCustodyWalletId(toSeed(mnemonic.split(" "))),
    );
  });
});
