import { Amount, deriveKeysetId, Keyset, type Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  verifyEncryptedWalletBackupV2RestoredProofSet,
} from "@bitcaster/client-sdk";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { BitcasterDB } from "../../../stores/proof-db";
import { browserWalletScope } from "../../browserCtfRangeOrderSource";
import { browserWalletDatabaseName } from "../../browserWalletProfile";
const SEED = new Uint8Array(64).fill(39);
const KEYSET_ID = deriveKeysetId(
  { 1: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" },
  { unit: "msat", versionByte: 1 },
);
export async function reimportFixture(count = 1) {
  const scopeId = browserWalletScope(SEED).scopeId;
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  return {
    seed: SEED,
    database,
    scopeId,
    verified: await verifiedProof(count),
    asset: createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: "https://mint.example",
      unit: "msat",
      asset: { kind: "ordinary" },
    }),
    custodyRevision: 1n,
    sourceOperationId: "backup-v2-restore:test",
    wallet: restoreWallet(),
    isCurrentProfile: () => true,
    lockManager: {
      request: async <T>(
        _name: string,
        options: LockOptions | LockGrantedCallback<T>,
        callback?: LockGrantedCallback<T>,
      ) => (typeof options === "function" ? options(null) : callback!(null)),
    },
  };
}
export async function evictReimportProofs(database: BitcasterDB) {
  await database.transaction(
    "rw",
    [database.custodyProofs, database.custodyProofBackupAuthorities, database.proofs],
    async () => {
      await database.custodyProofs.clear();
      await database.custodyProofBackupAuthorities.clear();
      await database.proofs.clear();
    },
  );
}
async function verifiedProof(count: number) {
  const entries = Array.from({ length: count }, (_, counter) => {
    const locator = {
      schemaVersion: 1 as const,
      kind: "nut13" as const,
      keysetId: KEYSET_ID,
      counter,
    };
    const proof = {
      id: KEYSET_ID,
      amount: Amount.from(1),
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator,
        proofKeysetId: KEYSET_ID,
        proofAmount: 1,
      }),
      C: `02${"33".repeat(32)}`,
    };
    return {
      mintUrl: "https://mint.example",
      unit: "msat" as const,
      asset: { kind: "ordinary" as const },
      proof,
      locator,
      proofId: "11".repeat(32),
    };
  });
  return verifyEncryptedWalletBackupV2RestoredProofSet({
    seed: SEED,
    expectedAsset: createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: "https://mint.example",
      unit: "msat",
      asset: { kind: "ordinary" },
    }),
    unverified: {
      proofs: entries,
      counterHighWaterMarks: [
        { mintUrl: "https://mint.example", unit: "msat", keysetId: KEYSET_ID, nextCounter: count },
      ],
    },
    port: {
      async resolveKeyset({ mintUrl, unit, keysetId }) {
        return { mintUrl, unit, keysetId, keyset: {}, requireDleq: true, verify: () => true };
      },
      verifyProofs: () => undefined,
      checkProofStates: async ({ proofs }) =>
        proofs.map(({ proofId }) => ({ proofId, state: "UNSPENT" })),
    },
  });
}

function restoreWallet(): CashuWallet {
  const keyset = new Keyset(KEYSET_ID, "msat", true, 0);
  keyset.keys = { 1: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" };
  return {
    mint: { mintUrl: "https://mint.example" },
    getKeyset: () => keyset,
  } as unknown as CashuWallet;
}
