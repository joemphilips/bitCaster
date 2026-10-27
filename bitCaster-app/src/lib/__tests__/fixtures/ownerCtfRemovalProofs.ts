import { deriveConditionalKeysetId } from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2KeyHandle,
  deriveEncryptedWalletBackupV2AssetLocator,
} from "@bitcaster/client-sdk";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { decodeEncryptedWalletBackupOwnerUploadGroup } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerUpload";
import {
  decryptEncryptedWalletBackupV2ProofSetBundle,
  digestEncryptedWalletBackupV2TerminalProofCommitment,
} from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { deriveEncryptedWalletBackupOwnerScope } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerScope";
import { deserializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { commitBrowserCtfTerminalOperation } from "@/test/browserEncryptedWalletBackupV2CommittedTerminalFixture";
import {
  createBrowserCustodyProofRow,
  BrowserDurableCustodyAdapter,
} from "@/stores/durable-custody-db";
import { decodeBrowserCustodyProofRow } from "@/stores/durable-custody-types";
import {
  createBrowserProofBackupAuthorityRow,
  createBrowserRemoteProofBackupAuthorityRow,
  requireBrowserProofBackupAuthorityForProof,
} from "@/stores/browser-proof-backup-authority";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "@/stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { BitcasterDB } from "@/stores/proof-db";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { BROWSER_D4_CONDITION } from "@/test/browserD4OracleFixture";
import { runBrowserEncryptedWalletBackupOwnerWorkerCycle } from "@/lib/browserEncryptedWalletBackupOwnerWorker";
import { createOwnerRemovalRemote } from "./ownerRemovalFixture";

const REALM = "backup.example";
const MINT = "https://mint.example";
const PUBLIC_KEY = `02${"22".repeat(32)}`;
const CONDITION_ID = BROWSER_D4_CONDITION;
const OUTCOME = "YES";
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME,
});
const KEYSET = deriveConditionalKeysetId({
  keys: { "1": PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 0,
  final_expiry: 2,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
});
export const removalSeed = new Uint8Array(64).fill(19);
const SEED = removalSeed;
export const removalOwnerA = {
  ...deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: "test",
    ownerSubject: "removal-owner-a",
  }),
  enrollmentEpoch: 1,
};
export const removalOwnerB = {
  ...deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: "test",
    ownerSubject: "removal-owner-b",
  }),
  enrollmentEpoch: 1,
};
export const removalLock = {
  request: (async (_name: string, _options: LockOptions, action: LockGrantedCallback<unknown>) =>
    action(null)) as LockManager["request"],
};

/**
 * Reuse the existing terminal proof boundary fixture; Owner CAS uses genuine SDK receipts.
 * `deferClassification` uploads selectable proofs first and returns `classify` so that a
 * test can commit the terminal classification after the first Owner backup.
 */
export async function ownerCtfRemovalFixture(
  count = 2,
  restored = false,
  options: { readonly deferClassification?: boolean } = {},
) {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  try {
    const scope = { scopeKind: "wallet" as const, walletId: keyHandle.walletId, scopeId };
    const adapter = new BrowserDurableCustodyAdapter(database);
    const custodyOwner = await adapter.claimScope(scope, {
      incarnationId: "owner-removal-fixture",
      observedAtMs: 1000,
      leaseExpiresAtMs: 10000,
    });
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: MINT,
      unit: "msat",
      asset: {
        kind: "ctf",
        conditionId: CONDITION_ID,
        outcomeLabel: OUTCOME,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        registeredAt: 1,
        finalExpiry: 2,
      },
    });
    let proofs = Array.from({ length: count }, (_, i) =>
      decodeBrowserCustodyProofRow({
        ...createBrowserCustodyProofRow({
          scopeId,
          normalizedMint: MINT,
          unit: "msat",
          proof: {
            id: KEYSET,
            amount: 1 as never,
            secret: deriveDurableWalletProofSecret({
              seed: SEED,
              locator: { schemaVersion: 1, kind: "nut13", keysetId: KEYSET, counter: i },
              proofKeysetId: KEYSET,
              proofAmount: 1,
            }),
            C: PUBLIC_KEY,
          },
          asset: { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: OUTCOME },
          receivedAtMs: 1000,
        }),
      }),
    );
    await database.custodyProofs.bulkPut(proofs);
    await database.custodyProofBackupAuthorities.bulkPut(
      proofs.map((proof, i) =>
        createBrowserProofBackupAuthorityRow(proof, 1000, null, `admission-local-${i}`),
      ),
    );
    await database.custodyConditionalKeysets.put({
      schemaVersion: 1,
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: KEYSET,
      denominationPublicKeys: { "1": PUBLIC_KEY },
      inputFeePpk: 0,
      conditionId: CONDITION_ID,
      outcomeCollection: OUTCOME,
      outcomeCollectionId: OUTCOME_COLLECTION_ID,
      registeredAtUnixSeconds: 1,
      finalExpiryUnixSeconds: 2,
      curve: "secp256k1",
    });
    const proofIds = proofs.map(({ proofId }) => proofId);
    const classify = async (indexes: readonly number[]) => {
      for (const i of indexes) {
        const proof = decodeBrowserCustodyProofRow(
          await database.custodyProofs.get([scopeId, proofIds[i]!]),
        );
        await commitBrowserCtfTerminalOperation({
          adapter,
          database,
          scope,
          owner: { ...custodyOwner, observedAtMs: 1500 + i * 100 },
          operationId: `ctf-owner-removal-${i}`,
          mintUrl: MINT,
          proofs: [
            deserializeDurableCustodyProofArtifact(
              JSON.parse(new TextDecoder().decode(proof.proofBody)),
            ) as never,
          ],
          predecessorProofs: [proof],
          publicKey: PUBLIC_KEY,
          classifiedAtMs: 2000 + i * 100,
        });
      }
    };
    if (options.deferClassification !== true) await classify(proofIds.map((_id, i) => i));
    proofs = (
      await database.custodyProofs.bulkGet(proofs.map((proof) => [scopeId, proof.proofId]))
    ).map(decodeBrowserCustodyProofRow);
    for (const [i, proof] of proofs.entries()) {
      const authority = requireBrowserProofBackupAuthorityForProof(
        await database.custodyProofBackupAuthorities.get([scopeId, proof.proofId]),
        proof,
      );
      await database.custodyProofBackupAuthorities.put({
        ...authority,
        derivationLocator: terminalLocator(proof, i),
      });
    }
    await database.walletCounterAssociations.put({
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: KEYSET,
      recoveryComplete: true,
    });
    await database.walletCounterCursors.put({ scopeId, keysetId: KEYSET, next: count });
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId,
      asset,
      custodyRevision: 1n,
      activeProofCount: count,
      terminalCtfContext: {
        conditionId: CONDITION_ID,
        outcomeLabel: OUTCOME,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        registeredAt: 1,
        finalExpiry: 2,
      },
    });
    await database.encryptedWalletBackupV2DesiredAssets.put(desired);
    const owner = removalOwnerA;
    const remote = await createOwnerRemovalRemote({
      database,
      scopeId,
      keyHandle,
      owner,
      enrollmentEpoch: 1,
    });
    const signal = new AbortController().signal;
    const actualWorker = runBrowserEncryptedWalletBackupOwnerWorkerCycle;
    const cycle = () =>
      actualWorker({
        database,
        scopeId,
        keyHandle,
        owner,
        enrollmentEpoch: 1,
        seed: SEED,
        remote: remote.remote,
        runtime: crypto,
        signal,
        isCurrentProfile: () => true,
      });
    const initial = await cycle();
    if (initial.kind !== "committed") throw new Error("fixture Owner backup did not commit");
    if (options.deferClassification !== true)
      await adoptInitialOwnerSeals({
        database,
        scopeId,
        keyHandle,
        asset,
        proofs,
        remote,
        restored,
      });
    proofs = (
      await database.custodyProofs.bulkGet(proofs.map((proof) => [scopeId, proof.proofId]))
    ).map(decodeBrowserCustodyProofRow);
    const assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
      keyHandle,
      mintUrl: MINT,
      unit: "msat",
      assetIdentity: asset.assetIdentity,
    });
    return {
      database,
      scopeId,
      keyHandle,
      asset,
      desired,
      proofs,
      owner,
      remote,
      cycle,
      classify,
      assetLocator,
      input: (selected = proofs) => ({
        database,
        scopeId,
        keyHandle,
        ownerScopeId: owner.ownerScopeId,
        enrollmentEpoch: 1,
        asset,
        assetLocator,
        targets: selected.map((p) => ({
          proofId: p.proofId,
          proofFingerprint: p.proofFingerprint,
          proofRevision: p.revision,
        })),
        loadCurrentOwnerReachabilityEvidence: remote.loadCurrentOwnerReachabilityEvidence,
        observedAtMs: 2500,
        lockManager: removalLock,
        isCurrentProfile: () => true,
      }),
      final: () => ({
        database,
        scopeId,
        keyHandle,
        ownerScopeId: owner.ownerScopeId,
        enrollmentEpoch: 1,
        localAssetKey: desired.localAssetKey,
        assetLocator,
        lockManager: removalLock,
        isCurrentProfile: () => true,
      }),
    };
  } catch (error) {
    database.close();
    await database.delete();
    throw error;
  }
}

/** Bind each classified proof to the genuine terminal seal of the first Owner upload. */
async function adoptInitialOwnerSeals(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>;
  readonly asset: ReturnType<typeof createEncryptedWalletBackupV2AssetIdentity>;
  readonly proofs: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[];
  readonly remote: Awaited<ReturnType<typeof createOwnerRemovalRemote>>;
  readonly restored: boolean;
}) {
  const { database, scopeId, keyHandle, asset, remote, restored } = input;
  const initialRequest = remote.remote.mutateHead.mock.calls[0]![0];
  const group = decodeEncryptedWalletBackupOwnerUploadGroup({
    bytes: initialRequest.canonicalUploadGroup,
    expectedContext: remote.context,
    expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
  });
  const descriptor = group.mutationEvidence.envelope.mutation.addedBundle;
  if (descriptor === null) throw new Error("fixture initial Owner descriptor missing");
  const decrypted = await decryptEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    expectedAsset: asset,
    custodyRevision: 1n,
    runtime: crypto,
    descriptor,
    objects: group.objects,
  });
  for (const proof of input.proofs) {
    const entry = decrypted.proofs.find((row) => row.proofId === proof.proofId);
    if (entry?.terminalSeal === undefined) throw new Error("fixture genuine Owner seal missing");
    const previous = requireBrowserProofBackupAuthorityForProof(
      await database.custodyProofBackupAuthorities.get([scopeId, proof.proofId]),
      proof,
    );
    const restoredProof = restored
      ? decodeBrowserCustodyProofRow({ ...proof, revision: 0 })
      : proof;
    const authority = createBrowserRemoteProofBackupAuthorityRow({
      proof: restoredProof,
      observedAtMs: 2400,
      derivationLocator: entry.locator,
      restoreProofId: proof.proofId,
      restoreProofCommitment: digestEncryptedWalletBackupV2TerminalProofCommitment({
        proofId: proof.proofId,
        mintUrl: MINT,
        unit: "msat",
        asset: entry.asset,
        proof: entry.proof,
        locator: entry.locator,
      }),
      terminalSeal: entry.terminalSeal,
    });
    await database.custodyProofs.put(restoredProof);
    await database.custodyProofBackupAuthorities.put(
      restored
        ? authority
        : {
            ...authority,
            terminalOperationId: previous.terminalOperationId,
            terminalAuthority: previous.terminalAuthority,
          },
    );
  }
}

function terminalLocator(proof: ReturnType<typeof decodeBrowserCustodyProofRow>, counter: number) {
  return {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: proof.keysetId,
    counter,
  };
}

export async function addLocalCompanion(
  f: Awaited<ReturnType<typeof ownerCtfRemovalFixture>>,
  suffix = "one",
) {
  const managed = f.proofs[0]!;
  const proof = deserializeDurableCustodyProofArtifact(
    JSON.parse(new TextDecoder().decode(managed.proofBody)),
  );
  const local = createBrowserCustodyProofRow({
    scopeId: f.scopeId,
    normalizedMint: managed.normalizedMint,
    unit: "msat",
    proof: { ...proof, secret: `genuine-local-companion-${suffix}` } as never,
    asset: {
      kind: "conditional",
      conditionId: managed.conditionId!,
      outcomeCollection: managed.outcomeCollection!,
    },
    receivedAtMs: 20_000,
  });
  await f.database.custodyProofs.put(local);
  await f.database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(local, 20_000, null, `local-${suffix}`),
  );
  const adapter = new BrowserDurableCustodyAdapter(f.database);
  const scope = {
    scopeKind: "wallet" as const,
    walletId: f.keyHandle.walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: f.keyHandle.walletId }),
  };
  const owner = await adapter.claimScope(scope, {
    incarnationId: `local-companion-${suffix}`,
    observedAtMs: 20_000,
    leaseExpiresAtMs: 30_000,
  });
  await commitBrowserCtfTerminalOperation({
    adapter,
    database: f.database,
    scope,
    owner: { ...owner, observedAtMs: 21_000 },
    operationId: `local-companion-${suffix}`,
    mintUrl: managed.normalizedMint,
    proofs: [{ ...proof, secret: `genuine-local-companion-${suffix}` } as never],
    predecessorProofs: [local],
    publicKey: proof.C,
    classifiedAtMs: 22_000,
  });
  const row = decodeBrowserCustodyProofRow(
    await f.database.custodyProofs.get([f.scopeId, local.proofId]),
  );
  return {
    proofId: row.proofId,
    proofFingerprint: row.proofFingerprint,
    proofRevision: row.revision,
  };
}
