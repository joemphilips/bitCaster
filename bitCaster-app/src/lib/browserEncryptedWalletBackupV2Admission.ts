import type { Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  decodeEncryptedWalletBackupV2DesiredAssetRow,
} from "../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { BrowserWalletCounterDexieStore } from "../stores/browser-wallet-counter-db";
import { addProofs, type BitcasterDB, type StoredProof } from "../stores/proof-db";
import { readBrowserEncryptedWalletBackupV2ExactLocalProofRows } from "../stores/browser-encrypted-wallet-backup-v2-asset-source";
import { browserWalletScope } from "./browserCtfRangeOrderSource";
import { admitBrowserReceivedProofs } from "./browserCustodyProofReceive";
import { withWalletProfileLock } from "./walletProfileLock";
import type {
  EncryptedWalletBackupV2AssetIdentity,
  EncryptedWalletBackupV2VerifiedProofSet,
} from "@bitcaster/client-sdk";
import { requireEncryptedWalletBackupV2VerifiedProofSet } from "@bitcaster/client-sdk";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import { serializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";

export interface BrowserEncryptedWalletBackupV2AdmissionInput {
  readonly seed: Uint8Array;
  readonly verified: EncryptedWalletBackupV2VerifiedProofSet;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly custodyRevision: bigint;
  readonly sourceOperationId: string;
  readonly wallet: CashuWallet;
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly isCurrentProfile: () => boolean;
  readonly lockManager?: Pick<LockManager, "request">;
  /** Entropy for a bounded local-only reimport operation after cache eviction. */
  readonly randomId?: () => string;
  readonly fault?: "before-commit" | "after-authority-before-cache";
}

/** Admit one verified V2 asset under one profile lock, then repair the legacy cache. */
export async function admitBrowserEncryptedWalletBackupV2Asset(
  input: BrowserEncryptedWalletBackupV2AdmissionInput,
): Promise<void> {
  requireCurrent(input);
  const verified = requireEncryptedWalletBackupV2VerifiedProofSet(input.verified);
  if (browserWalletScope(input.seed).scopeId !== input.scopeId)
    throw new Error("browser V2 restore scope is foreign");
  const proofs = storedProofs(input, verified);
  await withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCurrent(input);
      await commitAuthority(input, verified, proofs);
      if (input.fault === "after-authority-before-cache")
        throw new Error("browser V2 restore injected cache fault");
      requireCurrent(input);
      await addProofs(proofs, input.database);
    },
    input.lockManager,
  );
}

async function commitAuthority(
  input: BrowserEncryptedWalletBackupV2AdmissionInput,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
  proofs: StoredProof[],
): Promise<void> {
  await input.database.transaction("rw", input.database.tables, async () => {
    requireCurrent(input);
    const start = await startingState(input, verified);
    if (start === "idempotent") return;
    const sourceOperationId =
      start === "evicted"
        ? `${input.sourceOperationId}:reimport:${localReimportId(input)}`
        : input.sourceOperationId;
    if (start === "evicted") {
      const desired = desiredRow(input, proofs.length);
      await input.database.encryptedWalletBackupV2DesiredAssets.delete([
        input.scopeId,
        desired.localAssetKey,
      ]);
    }
    await admitBrowserReceivedProofs({
      seed: input.seed,
      sourceOperationId,
      mintUrl: input.asset.mintUrl,
      unit: input.asset.unit as "sat" | "msat",
      wallet: input.wallet,
      proofs,
      derivationAuthority: null,
      proofLocators: new Map(verified.proofs.map(({ proof, locator }) => [proof.secret, locator])),
      database: input.database,
      lockManager: immediateLock,
    });
    await restoreCounters(input, verified);
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: input.scopeId,
      asset: input.asset,
      custodyRevision: input.custodyRevision,
      activeProofCount: proofs.length,
    });
    await input.database.encryptedWalletBackupV2DesiredAssets.put({
      ...desired,
      syncState: "acknowledged",
    });
    requireCurrent(input);
    if (input.fault === "before-commit")
      throw new Error("browser V2 restore injected commit fault");
  });
}

function localReimportId(input: BrowserEncryptedWalletBackupV2AdmissionInput): string {
  const value = input.randomId?.() ?? crypto.randomUUID();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(value)) {
    throw new Error("browser V2 restore reimport operation id is invalid");
  }
  return value;
}

async function restoreCounters(
  input: BrowserEncryptedWalletBackupV2AdmissionInput,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
): Promise<void> {
  const counters = new BrowserWalletCounterDexieStore({
    database: input.database,
    scopeId: input.scopeId,
    isCurrentProfile: input.isCurrentProfile,
  });
  for (const mark of verified.counterHighWaterMarks) {
    await counters.restoreInContext(
      { mintUrl: mark.mintUrl, unit: mark.unit },
      mark.keysetId,
      mark.nextCounter,
      false,
      () => undefined,
    );
  }
}

async function startingState(
  input: BrowserEncryptedWalletBackupV2AdmissionInput,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
): Promise<"absent" | "evicted" | "idempotent"> {
  const desired = desiredRow(input, verified.proofs.length);
  const raw = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    desired.localAssetKey,
  ]);
  const proofs = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
    database: input.database,
    scopeId: input.scopeId,
    asset: input.asset,
  });
  if (raw === undefined) {
    if (proofs.length === 0) return "absent";
    throw new Error("browser V2 restore local custody is untracked");
  }
  const row = decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
  if (
    row.custodyRevision !== desired.custodyRevision ||
    row.activeProofCount !== verified.proofs.length ||
    row.syncState !== "acknowledged"
  )
    throw new Error("browser V2 restore desired authority conflicts");
  if (proofs.length === 0) return "evicted";
  if (sameProofSet(proofs, verified)) return "idempotent";
  throw new Error("browser V2 restore local custody is partial");
}

function sameProofSet(
  rows: Awaited<ReturnType<typeof readBrowserEncryptedWalletBackupV2ExactLocalProofRows>>,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
): boolean {
  if (rows.length !== verified.proofs.length) return false;
  const expected = new Map(
    verified.proofs.map(({ proof, proofId }) => [
      proofId,
      deriveDurableCustodyArtifactFingerprint(serializeDurableCustodyProofArtifact(proof)),
    ]),
  );
  if (expected.size !== verified.proofs.length) return false;
  return rows.every((row) => expected.get(row.proofId) === row.proofFingerprint);
}

function desiredRow(input: BrowserEncryptedWalletBackupV2AdmissionInput, proofCount: number) {
  return createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: input.scopeId,
    asset: input.asset,
    custodyRevision: input.custodyRevision,
    activeProofCount: proofCount,
  });
}

function storedProofs(
  input: BrowserEncryptedWalletBackupV2AdmissionInput,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
): StoredProof[] {
  return verified.proofs.map(({ proof, asset }) => ({
    ...proof,
    mintUrl: input.asset.mintUrl,
    baseAsset: "sat",
    unit: input.asset.unit as "sat" | "msat",
    ...(asset.kind === "ctf"
      ? { conditionId: asset.conditionId, outcomeCollection: asset.outcomeLabel }
      : {}),
  }));
}

function requireCurrent(input: BrowserEncryptedWalletBackupV2AdmissionInput): void {
  if (!input.isCurrentProfile()) throw new Error("browser V2 restore profile is stale");
}

const immediateLock = {
  request: async <T>(
    _name: string,
    options: LockOptions | LockGrantedCallback<T>,
    callback?: LockGrantedCallback<T>,
  ) => (typeof options === "function" ? options(null) : callback!(null)),
} as Pick<LockManager, "request">;
