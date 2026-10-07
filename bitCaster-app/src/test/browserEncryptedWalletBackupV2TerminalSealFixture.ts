import Dexie from "dexie";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  issueEncryptedWalletBackupV2TerminalSeal,
  type EncryptedWalletBackupV2ProofSetProof,
} from "@bitcaster/client-sdk";
import { browserWalletScope } from "../lib/browserCtfRangeOrderSource";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { BrowserEncryptedWalletBackupV2TerminalSealStore } from "../stores/browser-encrypted-wallet-backup-v2-terminal-seal-store";
import { createBrowserProofBackupAuthorityRow } from "../stores/browser-proof-backup-authority";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../stores/durable-custody-db";
import { BitcasterDB } from "../stores/proof-db";
import { commitBrowserCtfTerminalOperation } from "./browserEncryptedWalletBackupV2CommittedTerminalFixture";

/** Issue real seal authority in a temporary store, then remove its local custody state. */
export async function issueBrowserCtfTerminalSealFixture(input: {
  readonly seed: Uint8Array;
  readonly entry: EncryptedWalletBackupV2ProofSetProof;
  readonly publicKey: string;
  readonly keysetFinalExpiry?: number | null;
}) {
  const { entry } = input;
  if (entry.asset.kind !== "ctf") throw new Error("test seal requires a CTF asset");
  const scope = browserWalletScope(input.seed);
  const database = new BitcasterDB(browserWalletDatabaseName(scope.scopeId));
  if (await Dexie.exists(database.name))
    throw new Error("test seal issuance database already exists");
  try {
    const adapter = new BrowserDurableCustodyAdapter(database);
    const owner = await adapter.claimScope(scope, {
      incarnationId: "test-seal-issuance",
      observedAtMs: 10,
      leaseExpiresAtMs: 10_000,
    });
    const predecessor = createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: entry.mintUrl,
      unit: entry.unit,
      proof: entry.proof,
      asset: {
        kind: "conditional",
        conditionId: entry.asset.conditionId,
        outcomeCollection: entry.asset.outcomeLabel,
      },
      receivedAtMs: 1,
    });
    await database.custodyProofs.put(predecessor);
    await database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(predecessor, 2, entry.locator, "test-seal-admission"),
    );
    await database.custodyConditionalKeysets.put({
      schemaVersion: 1,
      scopeId: scope.scopeId,
      normalizedMint: entry.mintUrl,
      unit: entry.unit,
      keysetId: entry.proof.id,
      denominationPublicKeys: { "1": input.publicKey },
      inputFeePpk: 0,
      conditionId: entry.asset.conditionId,
      outcomeCollection: entry.asset.outcomeLabel,
      outcomeCollectionId: entry.asset.outcomeCollectionId,
      registeredAtUnixSeconds: entry.asset.registeredAt,
      finalExpiryUnixSeconds:
        input.keysetFinalExpiry === undefined ? entry.asset.finalExpiry : input.keysetFinalExpiry,
      curve: "secp256k1",
    });
    await database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId: scope.scopeId,
        asset: createEncryptedWalletBackupV2AssetIdentity(entry),
        custodyRevision: 1n,
        activeProofCount: 1,
      }),
    );
    const committed = await commitBrowserCtfTerminalOperation({
      adapter,
      database,
      scope,
      owner,
      operationId: "test-seal-operation",
      mintUrl: entry.mintUrl,
      proofs: [entry.proof],
      predecessorProofs: [predecessor],
      publicKey: input.publicKey,
    });
    const seal = await issueEncryptedWalletBackupV2TerminalSeal({
      seed: input.seed,
      proof: entry,
      operationId: committed.operationId,
      store: new BrowserEncryptedWalletBackupV2TerminalSealStore({
        database,
        scopeId: scope.scopeId,
      }),
    });
    if (seal.schemaVersion !== 2) throw new Error("test terminal seal is not authenticated");
    return seal;
  } finally {
    database.close();
    await database.delete();
  }
}
