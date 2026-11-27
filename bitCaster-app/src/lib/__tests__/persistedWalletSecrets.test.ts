import { describe, expect, it } from "vitest";
import { readPersistedWalletSecrets, WALLET_STORAGE_KEY } from "../persistedWalletSecrets";

const SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";

function storage(values: Record<string, unknown>): Pick<Storage, "getItem"> {
  return {
    getItem: (key) => (key in values ? JSON.stringify(values[key]) : null),
  };
}

describe("readPersistedWalletSecrets", () => {
  it("uses the storage name of the wallet store", () => {
    expect(WALLET_STORAGE_KEY).toBe("bitcaster-wallet");
  });

  it("reads only the recovery phrase that the app persisted", () => {
    const secrets = readPersistedWalletSecrets(
      storage({
        "bitcaster-wallet": { state: { mnemonic: SEED, setupComplete: true }, version: 0 },
        "bitcaster-settings": { state: { nostrSignerMode: "nsec", nsecSecret: NSEC }, version: 0 },
      }),
    );
    expect(secrets).toEqual({ seedWords: SEED.split(" ") });
  });

  it("returns nothing when the browser has no wallet", () => {
    expect(readPersistedWalletSecrets(storage({}))).toEqual({ seedWords: null });
    expect(
      readPersistedWalletSecrets(
        storage({ "bitcaster-wallet": { state: { mnemonic: "  " }, version: 0 } }),
      ),
    ).toEqual({ seedWords: null });
  });

  it("returns nothing for a value that is not the persisted store shape", () => {
    const broken: Pick<Storage, "getItem"> = {
      getItem: (key) => (key === "bitcaster-wallet" ? "{not json" : "[]"),
    };
    expect(readPersistedWalletSecrets(broken)).toEqual({ seedWords: null });
    expect(
      readPersistedWalletSecrets(storage({ "bitcaster-wallet": { state: { mnemonic: 12 } } })),
    ).toEqual({ seedWords: null });
  });
});
