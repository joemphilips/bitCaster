import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2CurrentHead,
  createEncryptedWalletBackupV2KeyHandle,
  digestEncryptedWalletBackupV2TerminalProofCommitment,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  prepareEncryptedWalletBackupV2TransportBundle,
} from "@bitcaster/client-sdk";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { deserializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { createBrowserRemoteProofBackupAuthorityRow } from "../../../stores/browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "../../../stores/durable-custody-db";
import { BitcasterDB } from "../../../stores/proof-db";
import { EncryptedWalletBackupV2DexieAuthorityStore } from "../../../stores/encrypted-wallet-backup-v2-db";
import { decodeBrowserCustodyProofRow } from "../../../stores/durable-custody-types";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { commitBrowserCtfTerminalOperation } from "../../../test/browserEncryptedWalletBackupV2CommittedTerminalFixture";
import type { BrowserCtfRemoveTarget } from "../../browserCtfRemoveCoordinator";
import {
  CONDITION,
  MINT,
  MINT_PUBLIC_KEY,
  OUTCOME,
  OUTCOME_ID,
  SEED,
  fixture,
  immediateLockManager,
} from "./browserCtfRedeemFixture";

const REALM = "backup.example";

/** Build one committed local-only loser beside one remotely backed loser. */
export async function createMixedCtfRemoveFixture() {
  const entry = await fixture({ amounts: [1, 1], seed: SEED, counterSource: "browser" });
  for (const [index, row] of entry.proofs.entries()) {
    await commitBrowserCtfTerminalOperation({
      adapter: entry.adapter,
      database: entry.database,
      scope: entry.scope,
      owner: { ...entry.owner, observedAtMs: 10 + index },
      operationId: `mixed-remove-losing-${index}`,
      mintUrl: MINT,
      proofs: [proofFromRow(row)],
      predecessorProofs: [row],
      publicKey: MINT_PUBLIC_KEY,
      classifiedAtMs: 20 + index,
    });
  }

  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const scopeId = entry.scope.scopeId;
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: CONDITION,
      outcomeLabel: OUTCOME,
      outcomeCollectionId: OUTCOME_ID,
      registeredAt: 0,
      finalExpiry: null,
    },
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount: 2,
    terminalCtfContext: {
      conditionId: CONDITION,
      outcomeLabel: OUTCOME,
      outcomeCollectionId: OUTCOME_ID,
      registeredAt: 0,
      finalExpiry: null,
    },
  });
  const bundle = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset,
    declaredAmount: 2n,
    custodyRevision: 1n,
    canonicalPayload: encodeCanonicalBackupCbor(["accepted predecessor"]),
    runtime: {
      subtle: crypto.subtle,
      getRandomValues: (target) => crypto.getRandomValues(target),
    },
  });
  const authorityStore = new EncryptedWalletBackupV2DexieAuthorityStore({
    database: entry.database,
    scopeId,
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
  });
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [bundle.descriptor],
  });
  const headEvidence = collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({
      head,
      bundles: [bundle.descriptor],
    }),
  );
  await authorityStore.acceptCompetingHead({
    collectedHeadEvidence: headEvidence,
    stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
  });

  const localProof = await readProof(entry.database, scopeId, entry.proofs[0]!.proofId);
  const managedProof = await readProof(entry.database, scopeId, entry.proofs[1]!.proofId);
  const locator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: managedProof.keysetId,
    counter: 19,
  };
  await entry.database.custodyProofBackupAuthorities.put(
    createBrowserRemoteProofBackupAuthorityRow({
      proof: managedProof,
      observedAtMs: 30,
      derivationLocator: locator,
      restoreProofId: managedProof.proofId,
      restoreProofCommitment: digestEncryptedWalletBackupV2TerminalProofCommitment({
        proofId: managedProof.proofId,
        mintUrl: managedProof.normalizedMint,
        unit: managedProof.unit,
        asset: {
          kind: "ctf",
          conditionId: CONDITION,
          outcomeLabel: OUTCOME,
          outcomeCollectionId: OUTCOME_ID,
          registeredAt: 0,
          finalExpiry: null,
        },
        proof: deserializeDurableCustodyProofArtifact(
          JSON.parse(new TextDecoder().decode(managedProof.proofBody)),
        ),
        locator,
      }),
    }),
  );
  await entry.database.encryptedWalletBackupV2DesiredAssets.put({
    ...desired,
    syncState: "acknowledged",
  });

  const target = (proof: typeof localProof): BrowserCtfRemoveTarget => ({
    proofId: proof.proofId,
    proofFingerprint: proof.proofFingerprint,
    proofRevision: proof.revision,
  });
  return {
    entry,
    database: entry.database,
    scopeId,
    asset,
    assetLocator: bundle.descriptor.assetLocator,
    desired,
    keyHandle,
    authorityStore,
    headEvidence,
    localProof,
    managedProof,
    localTargets: [target(localProof)],
    managedTargets: [target(managedProof)],
    input: (database: BitcasterDB = entry.database, includeLocalTargets = true) => ({
      database,
      scopeId,
      keyHandle,
      enrollmentEpoch: 1,
      asset,
      assetLocator: bundle.descriptor.assetLocator,
      targets: [target(managedProof)],
      ...(includeLocalTargets ? { localTargets: [target(localProof)] } : {}),
      observedAtMs: 40,
      lockManager: immediateLockManager,
      isCurrentProfile: () => true,
    }),
  };
}

function proofFromRow(row: Awaited<ReturnType<typeof createBrowserCustodyProofRow>>) {
  const proof = deserializeDurableCustodyProofArtifact(
    JSON.parse(new TextDecoder().decode(row.proofBody)),
  );
  return {
    id: proof.id,
    amount: Number(proof.amount),
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq === undefined ? {} : { dleq: structuredClone(proof.dleq) }),
  } as never;
}

async function readProof(database: BitcasterDB, scopeId: string, proofId: string) {
  const raw = await database.custodyProofs.get([scopeId, proofId]);
  if (raw === undefined) throw new Error("test mixed-removal proof is missing");
  return decodeBrowserCustodyProofRow(raw);
}
