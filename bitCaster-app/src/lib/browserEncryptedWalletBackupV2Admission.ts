import { isBlsKeyset, type Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  decodeEncryptedWalletBackupV2DesiredAssetRow,
} from "../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import {
  createBrowserRemoteProofBackupAuthorityRow,
  requireBrowserProofBackupAuthorityForProof,
} from "../stores/browser-proof-backup-authority";
import { BrowserWalletCounterDexieStore } from "../stores/browser-wallet-counter-db";
import {
  addProofs,
  storedProofFromCustodyRow,
  storedProofFromRow,
  type BitcasterDB,
  type StoredProof,
} from "../stores/proof-db";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../stores/durable-custody-db";
import { decodeBrowserCustodyProofRow } from "../stores/durable-custody-types";
import { readBrowserEncryptedWalletBackupV2ExactLocalProofRows } from "../stores/browser-encrypted-wallet-backup-v2-asset-source";
import { browserWalletScope } from "./browserCtfRangeOrderSource";
import { admitBrowserReceivedProofsWithHeldProfileLock } from "./browserCustodyProofReceive";
import { withWalletProfileLock } from "./walletProfileLock";
import { normalizeUrl } from "./url";
import type {
  EncryptedWalletBackupV2AssetIdentity,
  EncryptedWalletBackupV2TerminalSeal,
  EncryptedWalletBackupV2VerifiedProofSet,
} from "@bitcaster/client-sdk";
import {
  decodeEncryptedWalletBackupV2AssetIdentity,
  requireEncryptedWalletBackupV2VerifiedProofSet,
} from "@bitcaster/client-sdk";
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
  readonly setTargetedRecoveryAdmissionStage?: (
    stage: BrowserEncryptedWalletBackupV2AdmissionStage,
  ) => void;
}

export type BrowserEncryptedWalletBackupV2AdmissionStage =
  | "backup-admit-lock"
  | "backup-admit-authority"
  | "backup-admit-state"
  | "backup-admit-custody"
  | "backup-admit-counter"
  | "backup-admit-desired"
  | "backup-admit-desired-write"
  | "backup-admit-current-profile"
  | "backup-admit-transaction-commit"
  | "backup-admit-cache";

export interface BrowserEncryptedWalletBackupV2SealedAdmissionInput {
  readonly seed: Uint8Array;
  readonly verified: EncryptedWalletBackupV2VerifiedProofSet;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly custodyRevision: bigint;
  readonly sourceOperationId: string;
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly isCurrentProfile: () => boolean;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly fault?: "before-commit" | "after-authority-before-cache";
  readonly setTargetedRecoveryAdmissionStage?: (
    stage: BrowserEncryptedWalletBackupV2AdmissionStage,
  ) => void;
}

/** Admit one verified V2 asset under one profile lock, then repair the legacy cache. */
export async function admitBrowserEncryptedWalletBackupV2Asset(
  input: BrowserEncryptedWalletBackupV2AdmissionInput,
): Promise<void> {
  requireProductMsatUnit(input.asset.unit);
  requireCurrent(input);
  const verified = requireEncryptedWalletBackupV2VerifiedProofSet(input.verified);
  if (
    verified.proofs.some((proof) => proof.selectionAuthority === "terminal-sealed-non-selectable")
  ) {
    throw new Error("browser V2 sealed losing proof needs non-selectable admission");
  }
  if (
    verified.proofs.some(({ unit }) => unit !== "msat") ||
    verified.counterHighWaterMarks.some(({ unit }) => unit !== "msat")
  ) {
    throw new Error("browser V2 product admission proof unit requires msat");
  }
  requireAdmissionAuthority(input, verified);
  if (browserWalletScope(input.seed).scopeId !== input.scopeId)
    throw new Error("browser V2 restore scope is foreign");
  const proofs = storedProofs(input, verified);
  input.setTargetedRecoveryAdmissionStage?.("backup-admit-lock");
  await withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCurrent(input);
      input.setTargetedRecoveryAdmissionStage?.("backup-admit-authority");
      await commitAuthority(input, verified, proofs);
      if (input.fault === "after-authority-before-cache")
        throw new Error("browser V2 restore injected cache fault");
      requireCurrent(input);
      input.setTargetedRecoveryAdmissionStage?.("backup-admit-cache");
      await addProofs(proofs, input.database);
    },
    input.lockManager,
  );
}

/** Admit an SDK-verified sealed CTF bundle without contacting a mint. */
export async function admitBrowserEncryptedWalletBackupV2SealedAsset(
  input: BrowserEncryptedWalletBackupV2SealedAdmissionInput,
): Promise<void> {
  requireProductMsatUnit(input.asset.unit);
  requireCurrent(input);
  const verified = requireEncryptedWalletBackupV2VerifiedProofSet(input.verified);
  const prepared = prepareSealedAdmission(input, verified);
  input.setTargetedRecoveryAdmissionStage?.("backup-admit-lock");
  await withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCurrent(input);
      input.setTargetedRecoveryAdmissionStage?.("backup-admit-authority");
      await input.database.transaction(
        "rw",
        [
          input.database.custodyProofs,
          input.database.custodyProofBackupAuthorities,
          input.database.custodyConditionalKeysets,
          input.database.walletCounterAssociations,
          input.database.walletCounterCursors,
          input.database.encryptedWalletBackupV2DesiredAssets,
          input.database.proofs,
          input.database.custodyScopes,
        ],
        async () => {
          await new BrowserDurableCustodyAdapter(input.database).ensureScope(
            browserWalletScope(input.seed),
            prepared.observedAtMs,
          );
          input.setTargetedRecoveryAdmissionStage?.("backup-admit-state");
          const state = await inspectSealedAdmissionState(input, prepared);
          if (!state.idempotent) {
            input.setTargetedRecoveryAdmissionStage?.("backup-admit-custody");
            await input.database.custodyProofs.bulkPut(prepared.proofRows);
            await input.database.custodyProofBackupAuthorities.bulkPut(prepared.authorityRows);
            if (input.fault === "after-authority-before-cache") {
              throw new Error("browser V2 restore injected cache fault");
            }
            input.setTargetedRecoveryAdmissionStage?.("backup-admit-desired");
            input.setTargetedRecoveryAdmissionStage?.("backup-admit-desired-write");
            await input.database.encryptedWalletBackupV2DesiredAssets.put(prepared.desiredRow);
            input.setTargetedRecoveryAdmissionStage?.("backup-admit-counter");
            await restoreCountersInOwnedTransaction(input, verified);
            input.setTargetedRecoveryAdmissionStage?.("backup-admit-desired");
            input.setTargetedRecoveryAdmissionStage?.("backup-admit-desired-write");
            await input.database.encryptedWalletBackupV2DesiredAssets.put(prepared.desiredRow);
          }
          input.setTargetedRecoveryAdmissionStage?.("backup-admit-current-profile");
          requireCurrent(input);
          input.setTargetedRecoveryAdmissionStage?.("backup-admit-transaction-commit");
          if (input.fault === "before-commit") {
            throw new Error("browser V2 restore injected commit fault");
          }
          input.setTargetedRecoveryAdmissionStage?.("backup-admit-cache");
          await removeMatchingStaleLegacyCacheRows(input.database, prepared.proofRows);
          requireCurrent(input);
        },
      );
    },
    input.lockManager,
  );
}

interface PreparedSealedAdmission {
  readonly proofRows: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[];
  readonly authorityRows: readonly ReturnType<typeof requireBrowserProofBackupAuthorityForProof>[];
  readonly observedAtMs: number;
  readonly desiredRow: ReturnType<typeof createEncryptedWalletBackupV2DesiredAssetRow> & {
    readonly syncState: "acknowledged";
  };
}

function prepareSealedAdmission(
  input: BrowserEncryptedWalletBackupV2SealedAdmissionInput,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
): PreparedSealedAdmission {
  const asset = decodeEncryptedWalletBackupV2AssetIdentity(input.asset);
  if (!asset.assetIdentity.startsWith("ctf:")) {
    throw new Error("browser V2 sealed admission requires a CTF asset");
  }
  if (verified.proofs.length === 0) {
    throw new Error("browser V2 sealed admission proof set is empty");
  }
  if (
    verified.proofs.some(
      (entry) =>
        entry.mintUrl !== asset.mintUrl ||
        entry.unit !== "msat" ||
        entry.asset.kind !== "ctf" ||
        entry.selectionAuthority !== "terminal-sealed-non-selectable" ||
        entry.terminalSeal === undefined,
    )
  ) {
    throw new Error("browser V2 sealed admission proof is not sealed CTF");
  }
  const first = verified.proofs[0]!;
  if (first.asset.kind !== "ctf") {
    throw new Error("browser V2 sealed admission CTF asset is missing");
  }
  const context = terminalCtfContext(first.asset);
  if (`ctf:${context.conditionId}:${context.outcomeCollectionId}` !== asset.assetIdentity) {
    throw new Error("browser V2 sealed admission asset is foreign");
  }
  for (const entry of verified.proofs) {
    if (
      entry.asset.kind !== "ctf" ||
      !sameTerminalCtfContext(context, terminalCtfContext(entry.asset))
    ) {
      throw new Error("browser V2 sealed admission CTF tuple conflicts");
    }
    requireSeal(entry.terminalSeal);
    if (entry.proofId.length === 0) {
      throw new Error("browser V2 sealed admission proof id is invalid");
    }
  }
  if (
    verified.counterHighWaterMarks.some(
      (mark) => mark.mintUrl !== asset.mintUrl || mark.unit !== "msat",
    )
  ) {
    throw new Error("browser V2 sealed admission counter is foreign");
  }
  if (browserWalletScope(input.seed).scopeId !== input.scopeId) {
    throw new Error("browser V2 restore scope is foreign");
  }
  const receivedAtMs = Math.max(
    ...verified.proofs.map((entry) => requireSeal(entry.terminalSeal).classifiedAtMs),
  );
  const proofRows = verified.proofs.map((entry) => {
    const proof = createBrowserCustodyProofRow({
      scopeId: input.scopeId,
      normalizedMint: asset.mintUrl,
      unit: "msat",
      proof: entry.proof,
      asset: {
        kind: "conditional",
        conditionId: context.conditionId,
        outcomeCollection: context.outcomeLabel,
      },
      receivedAtMs,
    });
    return decodeBrowserCustodyProofRow({
      ...proof,
      selectability: "verified-losing",
      reservationOperationId: null,
    });
  });
  const observedAtMs = receivedAtMs;
  const authorityRows = proofRows.map((proof, index) => {
    const entry = verified.proofs[index]!;
    const seal = requireSeal(entry.terminalSeal);
    return createBrowserRemoteProofBackupAuthorityRow({
      proof,
      observedAtMs,
      derivationLocator: entry.locator,
      restoreProofId: entry.proofId,
      restoreProofCommitment: seal.proofCommitment,
    });
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: input.scopeId,
    asset,
    custodyRevision: input.custodyRevision,
    activeProofCount: proofRows.length,
    terminalCtfContext: context,
  });
  return {
    proofRows,
    authorityRows,
    observedAtMs,
    desiredRow: { ...desired, syncState: "acknowledged" },
  };
}

async function inspectSealedAdmissionState(
  input: BrowserEncryptedWalletBackupV2SealedAdmissionInput,
  prepared: PreparedSealedAdmission,
): Promise<{ readonly idempotent: boolean }> {
  const expectedById = new Map(prepared.proofRows.map((proof) => [proof.proofId, proof]));
  const existingById = new Map<string, ReturnType<typeof decodeBrowserCustodyProofRow>>();
  for (const proof of prepared.proofRows) {
    const existing = await input.database.custodyProofs.get([input.scopeId, proof.proofId]);
    if (existing !== undefined)
      existingById.set(proof.proofId, decodeBrowserCustodyProofRow(existing));
  }
  const context = prepared.desiredRow.terminalCtfContext;
  if (context === null) throw new Error("browser V2 sealed admission CTF context is missing");
  const assetQuery = input.database.custodyProofs
    .where("[scopeId+normalizedMint+unit+conditionId+outcomeCollection+selectability]" as never)
    .between(
      [
        input.scopeId,
        prepared.desiredRow.mintUrl,
        prepared.desiredRow.unit,
        context.conditionId,
        context.outcomeLabel,
        "",
      ],
      [
        input.scopeId,
        prepared.desiredRow.mintUrl,
        prepared.desiredRow.unit,
        context.conditionId,
        context.outcomeLabel,
        "\uffff",
      ],
      true,
      true,
    );
  const [rawAssetRows, assetRowCount] = await Promise.all([
    assetQuery.limit(512).toArray(),
    assetQuery.count(),
  ]);
  if (assetRowCount > 512) {
    throw new Error("browser V2 sealed admission proof count exceeds the limit");
  }
  const assetRows = rawAssetRows.map(decodeBrowserCustodyProofRow);
  for (const proof of assetRows) {
    if (!expectedById.has(proof.proofId)) {
      throw new Error("browser V2 sealed admission local custody conflicts");
    }
    existingById.set(proof.proofId, proof);
  }
  for (const [proofId, proof] of existingById) {
    const expected = expectedById.get(proofId);
    if (!expected || !sameCanonicalProof(proof, expected)) {
      throw new Error("browser V2 sealed admission local custody conflicts");
    }
  }
  const desiredRaw = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    prepared.desiredRow.localAssetKey,
  ]);
  const desired =
    desiredRaw === undefined ? null : decodeEncryptedWalletBackupV2DesiredAssetRow(desiredRaw);
  if (desired !== null && !sameDesiredRow(desired, prepared.desiredRow)) {
    throw new Error("browser V2 sealed admission desired authority conflicts");
  }
  const authorities = await input.database.custodyProofBackupAuthorities.bulkGet(
    prepared.proofRows.map((proof) => [input.scopeId, proof.proofId]),
  );
  let authorityCount = 0;
  for (const [index, raw] of authorities.entries()) {
    if (raw === undefined) continue;
    const proof = existingById.get(prepared.proofRows[index]!.proofId);
    if (!proof) throw new Error("browser V2 sealed admission authority has no proof");
    const authority = requireBrowserProofBackupAuthorityForProof(raw, proof);
    if (!sameRemoteAuthority(authority, prepared.authorityRows[index]!)) {
      throw new Error("browser V2 sealed admission authority conflicts");
    }
    authorityCount += 1;
  }
  if (authorityCount !== 0 && authorityCount !== prepared.proofRows.length) {
    throw new Error("browser V2 sealed admission authority is incomplete");
  }
  if (assetRows.length === 0 && authorityCount !== 0) {
    throw new Error("browser V2 sealed admission authority has no proof");
  }
  const countersRestored = await sealedCountersRestored(input);
  const complete =
    desired !== null &&
    assetRows.length === prepared.proofRows.length &&
    existingById.size === prepared.proofRows.length &&
    authorityCount === prepared.proofRows.length &&
    countersRestored;
  const hasPartialState =
    desired !== null || assetRows.length !== 0 || existingById.size !== 0 || authorityCount !== 0;
  if (hasPartialState && !complete) {
    throw new Error("browser V2 sealed admission state is incomplete");
  }
  return {
    idempotent: complete,
  };
}

async function sealedCountersRestored(
  input: BrowserEncryptedWalletBackupV2SealedAdmissionInput,
): Promise<boolean> {
  for (const mark of input.verified.counterHighWaterMarks) {
    const [association, cursor] = await Promise.all([
      input.database.walletCounterAssociations.get([
        input.scopeId,
        mark.mintUrl,
        mark.unit,
        mark.keysetId,
      ]),
      input.database.walletCounterCursors.get([input.scopeId, mark.keysetId]),
    ]);
    if (association?.recoveryComplete !== true) return false;
    if (mark.nextCounter > 0 && (cursor === undefined || cursor.next < mark.nextCounter)) {
      return false;
    }
  }
  return true;
}

async function removeMatchingStaleLegacyCacheRows(
  database: BitcasterDB,
  proofs: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[],
): Promise<void> {
  const rows = await database.proofs.bulkGet(
    proofs.map((proof) => storedProofFromCustodyRow(proof).secret),
  );
  const secrets = rows.flatMap((row, index) => {
    if (row === undefined) return [];
    const proof = storedProofFromRow(row);
    const expected = proofs[index]!;
    const expectedStored = storedProofFromCustodyRow(expected);
    if (
      proof.mintUrl !== expected.normalizedMint ||
      proof.unit !== expected.unit ||
      proof.conditionId !== expected.conditionId ||
      proof.outcomeCollection !== expected.outcomeCollection ||
      (proof.baseAsset !== undefined && proof.baseAsset !== expectedStored.baseAsset) ||
      (proof.marketId !== undefined &&
        proof.marketId !== `${expected.conditionId}-${expected.outcomeCollection}`)
    ) {
      throw new Error("browser V2 sealed admission legacy cache conflicts");
    }
    if (
      deriveDurableCustodyArtifactFingerprint(serializeDurableCustodyProofArtifact(proof)) !==
      expected.proofFingerprint
    ) {
      throw new Error("browser V2 sealed admission legacy cache proof conflicts");
    }
    if (
      (typeof proof.reservedBy === "string" && proof.reservedBy.length > 0) ||
      proof.terminalOperationId !== undefined
    ) {
      return [];
    }
    return [row.secret];
  });
  if (secrets.length > 0) await database.proofs.bulkDelete(secrets);
}

function sameCanonicalProof(
  left: ReturnType<typeof decodeBrowserCustodyProofRow>,
  right: ReturnType<typeof decodeBrowserCustodyProofRow>,
): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.normalizedMint === right.normalizedMint &&
    left.unit === right.unit &&
    left.proofId === right.proofId &&
    left.proofFingerprint === right.proofFingerprint &&
    left.keysetId === right.keysetId &&
    left.amount === right.amount &&
    left.assetKind === right.assetKind &&
    left.conditionId === right.conditionId &&
    left.outcomeCollection === right.outcomeCollection &&
    left.selectability === right.selectability &&
    left.reservationOperationId === right.reservationOperationId &&
    left.revision === right.revision &&
    left.receivedAtMs === right.receivedAtMs &&
    left.curve === right.curve &&
    left.dleqPresence === right.dleqPresence
  );
}

function sameDesiredRow(
  left: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>,
  right: ReturnType<typeof createEncryptedWalletBackupV2DesiredAssetRow> & {
    readonly syncState: "acknowledged";
  },
): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.localAssetKey === right.localAssetKey &&
    left.mintUrl === right.mintUrl &&
    left.unit === right.unit &&
    left.assetIdentity === right.assetIdentity &&
    left.custodyRevision === right.custodyRevision &&
    left.activeProofCount === right.activeProofCount &&
    left.desiredAction === right.desiredAction &&
    left.syncState === right.syncState &&
    sameTerminalCtfContext(left.terminalCtfContext, right.terminalCtfContext)
  );
}

function sameRemoteAuthority(
  left: ReturnType<typeof requireBrowserProofBackupAuthorityForProof>,
  right: ReturnType<typeof requireBrowserProofBackupAuthorityForProof>,
): boolean {
  if (left.backupState !== "remote-backed" || right.backupState !== "remote-backed") return false;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.scopeId === right.scopeId &&
    left.proofId === right.proofId &&
    left.proofFingerprint === right.proofFingerprint &&
    left.proofRevision === right.proofRevision &&
    left.proofState === right.proofState &&
    left.terminalOperationId === right.terminalOperationId &&
    left.admissionOperationId === right.admissionOperationId &&
    left.backupState === right.backupState &&
    left.backupRecordId === right.backupRecordId &&
    left.backupRecordCommitment === right.backupRecordCommitment &&
    left.recordCreatedAtUnixSeconds === right.recordCreatedAtUnixSeconds &&
    left.recordUpdatedAtUnixSeconds === right.recordUpdatedAtUnixSeconds &&
    left.updatedAtMs === right.updatedAtMs &&
    left.derivationLocator !== null &&
    right.derivationLocator !== null &&
    JSON.stringify(left.derivationLocator) === JSON.stringify(right.derivationLocator) &&
    JSON.stringify(left.terminalAuthority) === JSON.stringify(right.terminalAuthority)
  );
}

function terminalCtfContext(
  asset: Extract<
    EncryptedWalletBackupV2VerifiedProofSet["proofs"][number]["asset"],
    { kind: "ctf" }
  >,
) {
  return {
    conditionId: asset.conditionId,
    outcomeLabel: asset.outcomeLabel,
    outcomeCollectionId: asset.outcomeCollectionId,
    registeredAt: asset.registeredAt,
    finalExpiry: asset.finalExpiry,
  } as const;
}

function sameTerminalCtfContext(
  left: ReturnType<typeof terminalCtfContext> | null,
  right: ReturnType<typeof terminalCtfContext> | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.conditionId === right.conditionId &&
    left.outcomeLabel === right.outcomeLabel &&
    left.outcomeCollectionId === right.outcomeCollectionId &&
    left.registeredAt === right.registeredAt &&
    left.finalExpiry === right.finalExpiry
  );
}

function requireSeal(
  value: EncryptedWalletBackupV2TerminalSeal | undefined,
): EncryptedWalletBackupV2TerminalSeal {
  if (value === undefined) throw new Error("browser V2 sealed admission terminal seal is missing");
  return value;
}

function requireProductMsatUnit(unit: unknown): asserts unit is "msat" {
  if (unit !== "msat") throw new Error("browser V2 product admission requires msat");
}

function requireAdmissionAuthority(
  input: BrowserEncryptedWalletBackupV2AdmissionInput,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
): void {
  if (normalizeUrl(input.wallet.mint.mintUrl) !== normalizeUrl(input.asset.mintUrl)) {
    throw new Error("browser V2 restore mint is foreign");
  }
  if (verified.counterHighWaterMarks.some(({ keysetId }) => isBlsKeyset(keysetId))) {
    throw new Error("browser V2 restore BLS keyset is unsupported");
  }
}

async function commitAuthority(
  input: BrowserEncryptedWalletBackupV2AdmissionInput,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
  proofs: StoredProof[],
): Promise<void> {
  requireCurrent(input);
  input.setTargetedRecoveryAdmissionStage?.("backup-admit-state");
  const start = await startingState(input, verified);
  if (start.kind === "idempotent") return;
  const sourceOperationId =
    start.kind === "evicted"
      ? `${input.sourceOperationId}:reimport:${localReimportId(input)}`
      : input.sourceOperationId;
  const selected = verified.proofs.flatMap((proof, index) =>
    start.proofIdsToAdmit.has(proof.proofId) ? [{ verified: proof, stored: proofs[index]! }] : [],
  );
  const beforePersist =
    start.kind === "evicted"
      ? async () => {
          const desired = desiredRow(input, proofs.length);
          await input.database.encryptedWalletBackupV2DesiredAssets.delete([
            input.scopeId,
            desired.localAssetKey,
          ]);
        }
      : undefined;
  const afterPersist = async () => {
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-counter");
    await restoreCountersInOwnedTransaction(input, verified);
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-desired");
    const desired = desiredRow(input, proofs.length);
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-desired-write");
    await input.database.encryptedWalletBackupV2DesiredAssets.put({
      ...desired,
      syncState: "acknowledged",
    });
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-current-profile");
    requireCurrent(input);
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-transaction-commit");
    if (input.fault === "before-commit")
      throw new Error("browser V2 restore injected commit fault");
  };
  if (selected.length !== 0) {
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-custody");
    await admitBrowserReceivedProofsWithHeldProfileLock(
      {
        seed: input.seed,
        sourceOperationId,
        mintUrl: input.asset.mintUrl,
        unit: input.asset.unit as "sat" | "msat",
        wallet: input.wallet,
        proofs: selected.map(({ stored }) => stored),
        derivationAuthority: null,
        proofLocators: new Map(
          selected.map(({ verified: proof }) => [proof.proof.secret, proof.locator]),
        ),
        database: input.database,
      },
      {
        beforePersist,
        afterPersist,
      },
    );
    return;
  }
  await input.database.transaction(
    "rw",
    [
      input.database.walletCounterAssociations,
      input.database.walletCounterCursors,
      input.database.custodyProofs,
      input.database.custodyProofBackupAuthorities,
      input.database.custodyConditionalKeysets,
      input.database.encryptedWalletBackupV2DesiredAssets,
    ],
    async () => {
      await beforePersist?.();
      await afterPersist();
      if (input.fault === "before-commit")
        throw new Error("browser V2 restore injected commit fault");
    },
  );
}

function localReimportId(input: BrowserEncryptedWalletBackupV2AdmissionInput): string {
  const value = input.randomId?.() ?? crypto.randomUUID();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(value)) {
    throw new Error("browser V2 restore reimport operation id is invalid");
  }
  return value;
}

async function restoreCountersInOwnedTransaction(
  input: Pick<
    | BrowserEncryptedWalletBackupV2AdmissionInput
    | BrowserEncryptedWalletBackupV2SealedAdmissionInput,
    "database" | "scopeId" | "isCurrentProfile"
  >,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
): Promise<void> {
  const counters = new BrowserWalletCounterDexieStore({
    database: input.database,
    scopeId: input.scopeId,
    isCurrentProfile: input.isCurrentProfile,
  });
  for (const mark of verified.counterHighWaterMarks) {
    await counters.restoreInOwnedTransaction(
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
): Promise<{
  readonly kind: "absent" | "evicted" | "idempotent" | "merge";
  readonly proofIdsToAdmit: ReadonlySet<string>;
}> {
  const desired = desiredRow(input, verified.proofs.length);
  const allProofIds = new Set(verified.proofs.map(({ proofId }) => proofId));
  const raw = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    desired.localAssetKey,
  ]);
  const ctfRoute = verified.proofs[0]?.asset;
  const proofs = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
    database: input.database,
    scopeId: input.scopeId,
    asset: input.asset,
    ...(ctfRoute?.kind === "ctf" ? { ctfRoute } : {}),
  });
  if (raw === undefined) {
    if (proofs.length === 0) return { kind: "absent", proofIdsToAdmit: allProofIds };
    throw new Error("browser V2 restore local custody is untracked");
  }
  const row = decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
  const currentAuthorityConflicts =
    row.custodyRevision !== desired.custodyRevision ||
    row.activeProofCount !== verified.proofs.length ||
    row.syncState !== "acknowledged";
  if (!currentAuthorityConflicts) {
    if (proofs.length === 0) return { kind: "evicted", proofIdsToAdmit: allProofIds };
    if (sameProofSet(proofs, verified)) {
      return { kind: "idempotent", proofIdsToAdmit: new Set() };
    }
    throw new Error("browser V2 restore local custody is partial");
  }
  if (
    row.desiredAction !== "replace" ||
    row.syncState !== "acknowledged" ||
    row.activeProofCount !== proofs.length ||
    input.custodyRevision <= BigInt(row.custodyRevision) ||
    !isProofSubset(proofs, verified)
  ) {
    throw new Error("browser V2 restore desired authority conflicts");
  }
  const localProofIds = new Set(proofs.map(({ proofId }) => proofId));
  return {
    kind: "merge",
    proofIdsToAdmit: new Set([...allProofIds].filter((proofId) => !localProofIds.has(proofId))),
  };
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

function isProofSubset(
  rows: Awaited<ReturnType<typeof readBrowserEncryptedWalletBackupV2ExactLocalProofRows>>,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
): boolean {
  const expected = new Map(
    verified.proofs.map(({ proof, proofId }) => [
      proofId,
      deriveDurableCustodyArtifactFingerprint(serializeDurableCustodyProofArtifact(proof)),
    ]),
  );
  return (
    expected.size === verified.proofs.length &&
    rows.every((row) => expected.get(row.proofId) === row.proofFingerprint)
  );
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
  return verified.proofs.map(({ proof, asset }) => {
    if (isBlsKeyset(proof.id)) throw new Error("browser V2 restore BLS keyset is unsupported");
    return {
      ...proof,
      mintUrl: input.asset.mintUrl,
      baseAsset: "sat",
      unit: input.asset.unit as "sat" | "msat",
      ...(asset.kind === "ctf"
        ? { conditionId: asset.conditionId, outcomeCollection: asset.outcomeLabel }
        : {}),
    };
  });
}

function requireCurrent(input: { readonly isCurrentProfile: () => boolean }): void {
  if (!input.isCurrentProfile()) throw new Error("browser V2 restore profile is stale");
}
