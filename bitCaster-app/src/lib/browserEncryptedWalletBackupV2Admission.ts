import { isBlsKeyset, type Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  decodeEncryptedWalletBackupV2DesiredAssetRow,
  incrementEncryptedWalletBackupV2DesiredAssetRevision,
  sameEncryptedWalletBackupV2RemovalIntent,
} from "../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import {
  createBrowserRemoteProofBackupAuthorityRow,
  requireBrowserProofBackupAuthorityForProof,
  requireBrowserLiveProofBackupAuthorityTableRow,
  sameBrowserProofDerivationLocator,
  type BrowserProofBackupAuthorityRow,
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
  createEncryptedWalletBackupV2AssetIdentity,
  digestEncryptedWalletBackupV2BundleDescriptor,
  decodeEncryptedWalletBackupV2AssetIdentity,
  requireEncryptedWalletBackupV2CollectedHeadEvidence,
  requireEncryptedWalletBackupV2VerifiedProofSetSource,
  requireEncryptedWalletBackupV2VerifiedProofSet,
} from "@bitcaster/client-sdk";
import {
  classifyDurableCustodyActiveWork,
  decodeDurableCustodyRecord,
  deriveDurableCustodyArtifactFingerprint,
} from "@bitcaster/client-sdk/durableCustody";
import { serializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";

export interface BrowserEncryptedWalletBackupV2AdmissionInput {
  readonly seed: Uint8Array;
  readonly verified: EncryptedWalletBackupV2VerifiedProofSet;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly custodyRevision: bigint;
  readonly sourceOperationId: string;
  readonly collectedHeadEvidence?: import("@bitcaster/client-sdk").EncryptedWalletBackupV2CollectedHeadEvidence;
  readonly realm?: string;
  readonly enrollmentEpoch?: number;
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
  readonly collectedHeadEvidence?: import("@bitcaster/client-sdk").EncryptedWalletBackupV2CollectedHeadEvidence;
  readonly realm?: string;
  readonly enrollmentEpoch?: number;
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly isCurrentProfile: () => boolean;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly fault?: "before-commit" | "after-authority-before-cache";
  readonly setTargetedRecoveryAdmissionStage?: (
    stage: BrowserEncryptedWalletBackupV2AdmissionStage,
  ) => void;
}

export type BrowserEncryptedWalletBackupV2MixedAdmissionInput =
  BrowserEncryptedWalletBackupV2AdmissionInput;

export interface BrowserEncryptedWalletBackupV2AcceptedRemoteAdmissionInput extends Omit<
  BrowserEncryptedWalletBackupV2AdmissionInput,
  "collectedHeadEvidence" | "realm" | "enrollmentEpoch" | "wallet"
> {
  readonly collectedHeadEvidence: import("@bitcaster/client-sdk").EncryptedWalletBackupV2CollectedHeadEvidence;
  readonly realm: string;
  readonly enrollmentEpoch: number;
  readonly wallet?: CashuWallet;
}

/** Replace one local active set with one authenticated accepted-remote set. */
export async function admitBrowserEncryptedWalletBackupV2AcceptedRemoteAsset(
  input: BrowserEncryptedWalletBackupV2AcceptedRemoteAdmissionInput,
): Promise<void> {
  requireProductMsatUnit(input.asset.unit);
  requireCurrent(input);
  const verified = requireEncryptedWalletBackupV2VerifiedProofSet(input.verified);
  requireAdmissionHeadBinding(input, verified, true);
  requireAcceptedRemoteAssetBinding(input, verified);
  requireAdmissionAuthority(input, verified);
  if (browserWalletScope(input.seed).scopeId !== input.scopeId) {
    throw new Error("browser V2 accepted-remote scope is foreign");
  }
  const prepared = prepareAcceptedRemoteAdmission(input, verified);

  input.setTargetedRecoveryAdmissionStage?.("backup-admit-lock");
  await withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCurrent(input);
      const initial = await inspectAcceptedRemoteAdmission(input, prepared);
      if (initial.missingSelectable.length > 0) {
        let transactional: AcceptedRemoteAdmissionState | null = null;
        await admitBrowserReceivedProofsWithHeldProfileLock(
          {
            seed: input.seed,
            sourceOperationId: `${input.sourceOperationId}:accepted-remote`,
            mintUrl: input.asset.mintUrl,
            unit: "msat",
            wallet: requireAcceptedRemoteAdmissionWallet(input.wallet),
            proofs: initial.missingSelectable.map(({ stored }) => stored),
            derivationAuthority: null,
            proofLocators: new Map(
              initial.missingSelectable.map(({ entry }) => [entry.proof.secret, entry.locator]),
            ),
            ...proofConditionalAssets(initial.missingSelectable.map(({ entry }) => entry)),
            database: input.database,
          },
          {
            beforePersist: async () => {
              transactional = await inspectAcceptedRemoteAdmission(input, prepared);
              requireSameAcceptedRemoteAdmissionPlan(initial, transactional);
            },
            afterPersist: async () => {
              if (transactional === null) {
                throw new Error("browser V2 accepted-remote transaction preflight is missing");
              }
              await finishAcceptedRemoteAdmission(input, prepared, transactional);
            },
          },
        );
        return;
      }

      await new BrowserDurableCustodyAdapter(input.database).ensureScope(
        browserWalletScope(input.seed),
        prepared.observedAtMs,
      );
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
          input.database.custodyReservations,
          input.database.custodyOperations,
          input.database.custodyActiveWork,
          input.database.custodyScopes,
        ],
        async () => {
          const transactional = await inspectAcceptedRemoteAdmission(input, prepared);
          requireSameAcceptedRemoteAdmissionPlan(initial, transactional);
          await finishAcceptedRemoteAdmission(input, prepared, transactional);
        },
      );
    },
    input.lockManager,
  );
}

type AcceptedRemoteEntry = EncryptedWalletBackupV2VerifiedProofSet["proofs"][number];

interface PreparedAcceptedRemoteEntry {
  readonly entry: AcceptedRemoteEntry;
  readonly stored: StoredProof;
  readonly expectedProof: ReturnType<typeof decodeBrowserCustodyProofRow>;
  readonly sealedAuthority: BrowserProofBackupAuthorityRow | null;
}

interface PreparedAcceptedRemoteAdmission {
  readonly entries: readonly PreparedAcceptedRemoteEntry[];
  readonly desiredRow: ReturnType<typeof createEncryptedWalletBackupV2DesiredAssetRow> & {
    readonly syncState: "acknowledged";
  };
  readonly observedAtMs: number;
}

interface AcceptedRemoteAdmissionState {
  readonly desired: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow> | null;
  readonly localProofs: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[];
  readonly localAuthorities: readonly BrowserProofBackupAuthorityRow[];
  readonly missingSelectable: readonly PreparedAcceptedRemoteEntry[];
  readonly missingSealed: readonly PreparedAcceptedRemoteEntry[];
  readonly sealedPromotions: readonly {
    readonly proof: ReturnType<typeof decodeBrowserCustodyProofRow>;
    readonly authority: BrowserProofBackupAuthorityRow;
  }[];
}

function requireAcceptedRemoteAssetBinding(
  input: BrowserEncryptedWalletBackupV2AcceptedRemoteAdmissionInput,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
): void {
  if (verified.proofs.length === 0) {
    throw new Error("browser V2 accepted-remote proof set is empty");
  }
  if (
    verified.proofs.some(
      (entry) =>
        entry.mintUrl !== input.asset.mintUrl ||
        entry.unit !== "msat" ||
        createEncryptedWalletBackupV2AssetIdentity({
          mintUrl: entry.mintUrl,
          unit: entry.unit,
          asset: entry.asset,
        }).assetIdentity !== input.asset.assetIdentity,
    ) ||
    verified.counterHighWaterMarks.some(
      (mark) => mark.mintUrl !== input.asset.mintUrl || mark.unit !== "msat",
    )
  ) {
    throw new Error("browser V2 accepted-remote asset is foreign");
  }
}

function prepareAcceptedRemoteAdmission(
  input: BrowserEncryptedWalletBackupV2AcceptedRemoteAdmissionInput,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
): PreparedAcceptedRemoteAdmission {
  const stored = storedProofs(input, verified);
  const sealedEntries = verified.proofs.filter(
    ({ selectionAuthority }) => selectionAuthority === "terminal-sealed-non-selectable",
  );
  const sealed =
    sealedEntries.length === 0
      ? null
      : prepareSealedAdmission(input, verified, sealedEntries, verified.proofs.length);
  const sealedById = new Map(
    sealed?.proofRows.map((proof, index) => [
      proof.proofId,
      { proof, authority: sealed.authorityRows[index]! },
    ]) ?? [],
  );
  const entries = verified.proofs.map((entry, index) => {
    const preparedSealed = sealedById.get(entry.proofId);
    const expectedProof =
      preparedSealed?.proof ??
      createBrowserCustodyProofRow({
        scopeId: input.scopeId,
        normalizedMint: input.asset.mintUrl,
        unit: "msat",
        proof: stored[index]!,
        asset: proofAssetForAcceptedRemoteEntry(entry),
        receivedAtMs: 0,
      });
    return {
      entry,
      stored: stored[index]!,
      expectedProof,
      sealedAuthority: preparedSealed?.authority ?? null,
    };
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: input.scopeId,
    asset: input.asset,
    custodyRevision: input.custodyRevision,
    activeProofCount: entries.length,
    terminalCtfContext: verifiedTerminalCtfContext(verified),
    removalIntent: null,
  });
  return {
    entries,
    desiredRow: { ...desired, syncState: "acknowledged" },
    observedAtMs: Math.max(
      0,
      ...verified.proofs.map(({ terminalSeal }) => terminalSeal?.classifiedAtMs ?? 0),
    ),
  };
}

function proofAssetForAcceptedRemoteEntry(entry: AcceptedRemoteEntry) {
  return entry.asset.kind === "ordinary"
    ? ({ kind: "regular" } as const)
    : ({
        kind: "conditional",
        conditionId: entry.asset.conditionId,
        outcomeCollection: entry.asset.outcomeLabel,
      } as const);
}

async function inspectAcceptedRemoteAdmission(
  input: BrowserEncryptedWalletBackupV2AcceptedRemoteAdmissionInput,
  prepared: PreparedAcceptedRemoteAdmission,
): Promise<AcceptedRemoteAdmissionState> {
  const first = input.verified.proofs[0]!.asset;
  const localProofs = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
    database: input.database,
    scopeId: input.scopeId,
    asset: input.asset,
    ...(first.kind === "ctf" ? { ctfRoute: first } : {}),
  });
  const incomingById = new Map(prepared.entries.map((entry) => [entry.entry.proofId, entry]));
  if (incomingById.size !== prepared.entries.length) {
    throw new Error("browser V2 accepted-remote proof set is duplicated");
  }
  if (localProofs.some((proof) => !incomingById.has(proof.proofId))) {
    throw new Error("browser V2 accepted-remote local active proof is absent remotely");
  }
  if (
    localProofs.some(
      (proof) =>
        proof.selectability === "locked" ||
        proof.selectability === "pending-removal" ||
        proof.reservationOperationId !== null,
    )
  ) {
    throw new Error("browser V2 accepted-remote local proof is locked or pending");
  }

  const incomingKeys = prepared.entries.map(
    ({ entry }) => [input.scopeId, entry.proofId] as [string, string],
  );
  const [rawIncomingProofs, rawAuthorities, reservations, rawDesired] = await Promise.all([
    input.database.custodyProofs.bulkGet(incomingKeys),
    input.database.custodyProofBackupAuthorities.bulkGet(incomingKeys),
    input.database.custodyReservations.bulkGet(incomingKeys),
    input.database.encryptedWalletBackupV2DesiredAssets.get([
      input.scopeId,
      prepared.desiredRow.localAssetKey,
    ]),
  ]);
  if (reservations.some((reservation) => reservation !== undefined)) {
    throw new Error("browser V2 accepted-remote local proof is reserved");
  }
  const localById = new Map(localProofs.map((proof) => [proof.proofId, proof]));
  const localAuthorities: BrowserProofBackupAuthorityRow[] = [];
  const missingSelectable: PreparedAcceptedRemoteEntry[] = [];
  const missingSealed: PreparedAcceptedRemoteEntry[] = [];
  const sealedPromotions: AcceptedRemoteAdmissionState["sealedPromotions"][number][] = [];

  for (const [index, incoming] of prepared.entries.entries()) {
    const rawProof = rawIncomingProofs[index];
    const local = localById.get(incoming.entry.proofId);
    if (rawProof !== undefined) {
      const collision = decodeBrowserCustodyProofRow(rawProof);
      if (collision.selectability === "spent") {
        throw new Error("browser V2 accepted-remote proof collides with spent history");
      }
      if (local === undefined) {
        throw new Error("browser V2 accepted-remote proof collides with another local asset");
      }
      if (!sameExactAcceptedRemoteProof(local, collision)) {
        throw new Error("browser V2 accepted-remote local proof changed during inspection");
      }
    } else if (local !== undefined) {
      throw new Error("browser V2 accepted-remote local proof body is missing");
    }

    if (local === undefined) {
      if (rawAuthorities[index] !== undefined) {
        requireBrowserLiveProofBackupAuthorityTableRow(rawAuthorities[index], incomingKeys[index]!);
        throw new Error("browser V2 accepted-remote authority has no proof body");
      }
      if (incoming.entry.selectionAuthority === "live-verified") {
        missingSelectable.push(incoming);
      } else {
        missingSealed.push(incoming);
      }
      continue;
    }

    if (!sameProofMaterial(local, incoming.expectedProof)) {
      throw new Error("browser V2 accepted-remote proof material conflicts");
    }
    const authority = requireBrowserProofBackupAuthorityForProof(
      requireBrowserLiveProofBackupAuthorityTableRow(rawAuthorities[index], incomingKeys[index]!),
      local,
    );
    if (!sameBrowserProofDerivationLocator(authority.derivationLocator, incoming.entry.locator)) {
      throw new Error("browser V2 accepted-remote derivation locator conflicts");
    }
    await requireAcceptedRemoteAuthorityWorkResolved(input.database, input.scopeId, authority);
    localAuthorities.push(authority);
    if (incoming.entry.selectionAuthority === "live-verified") {
      if (local.selectability !== "selectable" || authority.terminalAuthority !== null) {
        throw new Error("browser V2 accepted-remote cannot resurrect a terminal proof");
      }
      continue;
    }

    const seal = requireSeal(incoming.entry.terminalSeal);
    if (local.selectability === "verified-losing") {
      if (authority.terminalAuthority === null) {
        throw new Error("browser V2 accepted-remote terminal authority is missing");
      }
      if (
        authority.terminalAuthority.kind === "remote-seal" &&
        authority.backupRecordCommitment !== seal.proofCommitment
      ) {
        throw new Error("browser V2 accepted-remote terminal commitment conflicts");
      }
      continue;
    }
    if (local.selectability !== "selectable" || authority.terminalAuthority !== null) {
      throw new Error("browser V2 accepted-remote terminal promotion conflicts");
    }
    const promoted = decodeBrowserCustodyProofRow({
      ...local,
      revision: nextProofRevision(local.revision),
      selectability: "verified-losing",
      reservationOperationId: null,
    });
    sealedPromotions.push({
      proof: promoted,
      authority: createBrowserRemoteProofBackupAuthorityRow({
        proof: promoted,
        observedAtMs: Math.max(prepared.observedAtMs, promoted.receivedAtMs),
        derivationLocator: incoming.entry.locator,
        restoreProofId: incoming.entry.proofId,
        restoreProofCommitment: seal.proofCommitment,
      }),
    });
  }

  if (localAuthorities.length !== localProofs.length) {
    throw new Error("browser V2 accepted-remote local authority set is incomplete");
  }
  const desired =
    rawDesired === undefined ? null : decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
  if (desired !== null && desired.removalIntent !== null) {
    throw new Error("browser V2 accepted-remote removal intent is unresolved");
  }
  return {
    desired,
    localProofs,
    localAuthorities,
    missingSelectable,
    missingSealed,
    sealedPromotions,
  };
}

async function requireAcceptedRemoteAuthorityWorkResolved(
  database: BitcasterDB,
  scopeId: string,
  authority: BrowserProofBackupAuthorityRow,
): Promise<void> {
  const operationIds = [
    ...(authority.admissionOperationId === null ? [] : [authority.admissionOperationId]),
    ...(authority.terminalAuthority?.kind === "local-operation"
      ? [authority.terminalAuthority.operationId]
      : []),
  ];
  for (const operationId of new Set(operationIds)) {
    const [operation, activeWork] = await Promise.all([
      database.custodyOperations.get([scopeId, operationId]),
      database.custodyActiveWork.get([scopeId, operationId]),
    ]);
    if (activeWork !== undefined) {
      throw new Error("browser V2 accepted-remote custody work is unfinished");
    }
    if (operation !== undefined) {
      const record = decodeDurableCustodyRecord(operation.record);
      if (
        record.scope.scopeId !== scopeId ||
        record.operation.operationId !== operationId ||
        classifyDurableCustodyActiveWork(record) !== "none"
      ) {
        throw new Error("browser V2 accepted-remote custody work is unfinished");
      }
    }
  }
}

function requireSameAcceptedRemoteAdmissionPlan(
  expected: AcceptedRemoteAdmissionState,
  actual: AcceptedRemoteAdmissionState,
): void {
  if (
    !sameAcceptedRemoteDesired(expected.desired, actual.desired) ||
    expected.localProofs.length !== actual.localProofs.length ||
    expected.localAuthorities.length !== actual.localAuthorities.length ||
    expected.localProofs.some(
      (proof, index) => !sameExactAcceptedRemoteProof(proof, actual.localProofs[index]!),
    ) ||
    expected.localAuthorities.some(
      (authority, index) =>
        JSON.stringify(authority) !== JSON.stringify(actual.localAuthorities[index]),
    ) ||
    acceptedRemoteEntryIds(expected.missingSelectable) !==
      acceptedRemoteEntryIds(actual.missingSelectable) ||
    acceptedRemoteEntryIds(expected.missingSealed) !== acceptedRemoteEntryIds(actual.missingSealed)
  ) {
    throw new Error("browser V2 accepted-remote local state changed before commit");
  }
}

function sameAcceptedRemoteDesired(
  left: AcceptedRemoteAdmissionState["desired"],
  right: AcceptedRemoteAdmissionState["desired"],
): boolean {
  return left === null || right === null
    ? left === right
    : JSON.stringify(left) === JSON.stringify(right);
}

function acceptedRemoteEntryIds(entries: readonly PreparedAcceptedRemoteEntry[]): string {
  return entries.map(({ entry }) => entry.proofId).join(",");
}

function sameExactAcceptedRemoteProof(
  left: ReturnType<typeof decodeBrowserCustodyProofRow>,
  right: ReturnType<typeof decodeBrowserCustodyProofRow>,
): boolean {
  return (
    sameProofMaterial(left, right) &&
    left.revision === right.revision &&
    left.selectability === right.selectability &&
    left.reservationOperationId === right.reservationOperationId &&
    left.receivedAtMs === right.receivedAtMs
  );
}

async function finishAcceptedRemoteAdmission(
  input: BrowserEncryptedWalletBackupV2AcceptedRemoteAdmissionInput,
  prepared: PreparedAcceptedRemoteAdmission,
  state: AcceptedRemoteAdmissionState,
): Promise<void> {
  input.setTargetedRecoveryAdmissionStage?.("backup-admit-custody");
  const sealedProofs = state.missingSealed.map(({ expectedProof }) => expectedProof);
  const sealedAuthorities = state.missingSealed.map(({ sealedAuthority }) => {
    if (sealedAuthority === null) {
      throw new Error("browser V2 accepted-remote sealed authority is missing");
    }
    return sealedAuthority;
  });
  await Promise.all([
    input.database.custodyProofs.bulkPut([
      ...sealedProofs,
      ...state.sealedPromotions.map(({ proof }) => proof),
    ]),
    input.database.custodyProofBackupAuthorities.bulkPut([
      ...sealedAuthorities,
      ...state.sealedPromotions.map(({ authority }) => authority),
    ]),
  ]);
  if (input.fault === "after-authority-before-cache") {
    throw new Error("browser V2 restore injected cache fault");
  }
  input.setTargetedRecoveryAdmissionStage?.("backup-admit-desired");
  input.setTargetedRecoveryAdmissionStage?.("backup-admit-desired-write");
  await input.database.encryptedWalletBackupV2DesiredAssets.put(prepared.desiredRow);
  input.setTargetedRecoveryAdmissionStage?.("backup-admit-counter");
  await restoreCountersInOwnedTransaction(input, input.verified);
  input.setTargetedRecoveryAdmissionStage?.("backup-admit-desired-write");
  await input.database.encryptedWalletBackupV2DesiredAssets.put(prepared.desiredRow);
  input.setTargetedRecoveryAdmissionStage?.("backup-admit-cache");
  const sealedIds = new Set(
    prepared.entries
      .filter(({ entry }) => entry.selectionAuthority === "terminal-sealed-non-selectable")
      .map(({ entry }) => entry.proofId),
  );
  const finalProofs = await input.database.custodyProofs.bulkGet(
    prepared.entries.map(({ entry }) => [input.scopeId, entry.proofId] as [string, string]),
  );
  const decoded = finalProofs.map((proof) => {
    if (proof === undefined) throw new Error("browser V2 accepted-remote proof is missing");
    return decodeBrowserCustodyProofRow(proof);
  });
  await removeMatchingStaleLegacyCacheRows(
    input.database,
    decoded.filter(({ proofId }) => sealedIds.has(proofId)),
  );
  await addProofs(
    prepared.entries
      .filter(({ entry }) => entry.selectionAuthority === "live-verified")
      .map(({ stored }) => stored),
    input.database,
  );
  requireCurrent(input);
  input.setTargetedRecoveryAdmissionStage?.("backup-admit-transaction-commit");
  if (input.fault === "before-commit") {
    throw new Error("browser V2 restore injected commit fault");
  }
}

/** Admit one verified V2 asset under one profile lock, then repair the legacy cache. */
export async function admitBrowserEncryptedWalletBackupV2Asset(
  input: BrowserEncryptedWalletBackupV2AdmissionInput,
): Promise<void> {
  requireProductMsatUnit(input.asset.unit);
  requireCurrent(input);
  const verified = requireEncryptedWalletBackupV2VerifiedProofSet(input.verified);
  requireAdmissionHeadBinding(input, verified);
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
      await input.database.transaction(
        "rw",
        [input.database.custodyProofBackupAuthorities, input.database.proofs],
        async () => {
          await requireIncomingLiveAuthorities(input.database, input.scopeId, verified);
          await addProofs(proofs, input.database);
        },
      );
    },
    input.lockManager,
  );
}

/** Admit selectable and sealed CTF siblings in one canonical transaction. */
export async function admitBrowserEncryptedWalletBackupV2MixedAsset(
  input: BrowserEncryptedWalletBackupV2MixedAdmissionInput,
): Promise<void> {
  requireProductMsatUnit(input.asset.unit);
  requireCurrent(input);
  const verified = requireEncryptedWalletBackupV2VerifiedProofSet(input.verified);
  const selectableEntries = verified.proofs.filter(
    ({ selectionAuthority }) => selectionAuthority === "live-verified",
  );
  const sealedEntries = verified.proofs.filter(
    ({ selectionAuthority }) => selectionAuthority === "terminal-sealed-non-selectable",
  );
  if (selectableEntries.length === 0 || sealedEntries.length === 0) {
    throw new Error("browser V2 mixed admission requires both proof trust levels");
  }
  requireAdmissionHeadBinding(input, verified, sealedEntries.length > 0);
  if (
    verified.proofs.some(({ unit }) => unit !== "msat") ||
    verified.counterHighWaterMarks.some(({ unit }) => unit !== "msat")
  ) {
    throw new Error("browser V2 product admission proof unit requires msat");
  }
  requireAdmissionAuthority(input, verified);
  if (browserWalletScope(input.seed).scopeId !== input.scopeId) {
    throw new Error("browser V2 restore scope is foreign");
  }
  const selectableProofs = storedProofs(input, verified).filter(
    (_, index) => verified.proofs[index]!.selectionAuthority === "live-verified",
  );
  const sealed = prepareSealedAdmission(input, verified, sealedEntries, verified.proofs.length);
  requireMixedCtfContext(verified, sealed.desiredRow.terminalCtfContext);
  input.setTargetedRecoveryAdmissionStage?.("backup-admit-lock");
  await withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCurrent(input);
      input.setTargetedRecoveryAdmissionStage?.("backup-admit-authority");
      await commitMixedAuthority(input, verified, selectableEntries, selectableProofs, sealed);
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
  requireAdmissionHeadBinding(input, verified, true);
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
          input.database.custodyReservations,
          input.database.custodyOperations,
          input.database.custodyActiveWork,
          input.database.custodyScopes,
        ],
        async () => {
          const authorities = await requireIncomingLiveAuthorities(
            input.database,
            input.scopeId,
            verified,
          );
          await new BrowserDurableCustodyAdapter(input.database).ensureScope(
            browserWalletScope(input.seed),
            prepared.observedAtMs,
          );
          input.setTargetedRecoveryAdmissionStage?.("backup-admit-state");
          if (await reconcileSealedActiveProofs(input, prepared)) return;
          const state = await inspectSealedAdmissionState(input, prepared, authorities);
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

async function reconcileSealedActiveProofs(
  input: BrowserEncryptedWalletBackupV2SealedAdmissionInput,
  prepared: PreparedSealedAdmission,
  localRevisionOverride?: bigint,
): Promise<boolean> {
  const state = await loadSealedReconciliationState(input, prepared);
  if (state === null) return false;
  const unionRows = await applySealedReconciliationUnion(input, prepared, state);
  return persistSealedReconciliation(input, prepared, state, unionRows, localRevisionOverride);
}

interface SealedReconciliationState {
  readonly currentDesired: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>;
  readonly localRows: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[];
  readonly localById: ReadonlyMap<string, ReturnType<typeof decodeBrowserCustodyProofRow>>;
  readonly authorityById: ReadonlyMap<
    string,
    ReturnType<typeof requireBrowserProofBackupAuthorityForProof>
  >;
  readonly incomingAuthorityById: ReadonlyMap<
    string,
    ReturnType<typeof requireBrowserProofBackupAuthorityForProof>
  >;
  readonly changed: boolean;
}

async function loadSealedReconciliationState(
  input: BrowserEncryptedWalletBackupV2SealedAdmissionInput,
  prepared: PreparedSealedAdmission,
): Promise<SealedReconciliationState | null> {
  const first = input.verified.proofs[0]?.asset;
  if (first?.kind !== "ctf") return null;
  const localRows = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
    database: input.database,
    scopeId: input.scopeId,
    asset: input.asset,
    ctfRoute: first,
  });
  if (localRows.length === 0) return null;
  const desired = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    prepared.desiredRow.localAssetKey,
  ]);
  if (desired === undefined) return null;
  const currentDesired = decodeEncryptedWalletBackupV2DesiredAssetRow(desired);
  if (currentDesired.desiredAction !== "replace") {
    throw new Error("browser V2 restore desired removal authority conflicts");
  }
  if (currentDesired.removalIntent !== null) {
    throw new Error("browser V2 sealed admission desired authority conflicts: removal intent");
  }
  if (currentDesired.activeProofCount !== localRows.length) {
    throw new Error("browser V2 restore desired authority conflicts");
  }
  if (
    currentDesired.terminalCtfContext !== null &&
    !sameTerminalCtfContext(
      currentDesired.terminalCtfContext,
      prepared.desiredRow.terminalCtfContext,
    )
  ) {
    throw new Error("browser V2 restore desired CTF tuple conflicts");
  }
  const localAuthorities = await input.database.custodyProofBackupAuthorities.bulkGet(
    localRows.map(({ proofId }) => [input.scopeId, proofId] as [string, string]),
  );
  const authorityById = new Map<
    string,
    ReturnType<typeof requireBrowserProofBackupAuthorityForProof>
  >();
  for (const [index, row] of localRows.entries()) {
    const authorityRow = requireBrowserLiveProofBackupAuthorityTableRow(localAuthorities[index], [
      input.scopeId,
      row.proofId,
    ]);
    if (authorityRow === undefined) {
      throw new Error("browser V2 sealed admission authority is incomplete");
    }
    authorityById.set(row.proofId, requireBrowserProofBackupAuthorityForProof(authorityRow, row));
  }
  const localById = new Map(localRows.map((row) => [row.proofId, row]));
  if (
    localRows.some(
      ({ selectability }) => selectability !== "selectable" && selectability !== "verified-losing",
    )
  ) {
    throw new Error("browser V2 restore local custody conflicts: locked or pending proof");
  }
  for (const local of localRows) {
    if (local.selectability === "selectable") {
      await requireProofReconciliationFences(
        input.database,
        input.scopeId,
        local,
        authorityById.get(local.proofId),
      );
    }
  }
  let changed = false;
  for (const incoming of prepared.proofRows) {
    const local = localById.get(incoming.proofId);
    if (local === undefined) {
      changed = true;
      continue;
    }
    if (!sameProofMaterial(local, incoming)) {
      throw new Error("browser V2 restore proof material conflicts");
    }
    if (local.selectability === "selectable") changed = true;
    else if (local.selectability === "verified-losing") {
      if (local.reservationOperationId !== null)
        throw new Error("browser V2 restore losing proof is reserved");
    } else throw new Error("browser V2 restore proof is locked or pending removal");
  }
  return {
    currentDesired,
    localRows,
    localById,
    authorityById,
    incomingAuthorityById: new Map(prepared.authorityRows.map((row) => [row.proofId, row])),
    changed,
  };
}

async function applySealedReconciliationUnion(
  input: BrowserEncryptedWalletBackupV2SealedAdmissionInput,
  prepared: PreparedSealedAdmission,
  state: SealedReconciliationState,
): Promise<readonly ReturnType<typeof decodeBrowserCustodyProofRow>[]> {
  const unionRows = [...state.localRows];
  for (const incoming of prepared.proofRows) {
    const local = state.localById.get(incoming.proofId);
    if (local === undefined) {
      unionRows.push(incoming);
      await input.database.custodyProofs.put(incoming);
      await input.database.custodyProofBackupAuthorities.put(
        state.incomingAuthorityById.get(incoming.proofId)!,
      );
      continue;
    }
    if (local.selectability !== "selectable") continue;
    const losing = decodeBrowserCustodyProofRow({
      ...local,
      revision: nextProofRevision(local.revision),
      selectability: "verified-losing",
      reservationOperationId: null,
    });
    unionRows[unionRows.findIndex(({ proofId }) => proofId === losing.proofId)] = losing;
    await input.database.custodyProofs.put(losing);
    await input.database.custodyProofBackupAuthorities.put(
      createBrowserRemoteProofBackupAuthorityRow({
        proof: losing,
        observedAtMs: Math.max(prepared.observedAtMs, local.receivedAtMs),
        derivationLocator: state.authorityById.get(local.proofId)!.derivationLocator,
        restoreProofId: incoming.proofId,
        restoreProofCommitment: requireSeal(
          input.verified.proofs.find(({ proofId }) => proofId === incoming.proofId)?.terminalSeal,
        ).proofCommitment,
      }),
    );
  }
  return unionRows;
}

async function persistSealedReconciliation(
  input: BrowserEncryptedWalletBackupV2SealedAdmissionInput,
  prepared: PreparedSealedAdmission,
  state: SealedReconciliationState,
  unionRows: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[],
  localRevisionOverride: bigint | undefined,
): Promise<boolean> {
  if (!state.changed) {
    await removeMatchingStaleLegacyCacheRows(
      input.database,
      unionRows.filter(({ selectability }) => selectability === "verified-losing"),
    );
    await addProofs(
      unionRows
        .filter(({ selectability }) => selectability === "selectable" || selectability === "locked")
        .map(storedProofFromCustodyRow),
      input.database,
    );
    return true;
  }
  if (state.currentDesired.terminalCtfContext === null) {
    await input.database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId: input.scopeId,
        asset: input.asset,
        custodyRevision: BigInt(state.currentDesired.custodyRevision),
        activeProofCount: state.currentDesired.activeProofCount,
        terminalCtfContext: prepared.desiredRow.terminalCtfContext,
        removalIntent: null,
      }),
    );
  }
  await restoreCountersInOwnedTransaction(input, input.verified);
  const latestDesiredRaw = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    prepared.desiredRow.localAssetKey,
  ]);
  if (latestDesiredRaw === undefined)
    throw new Error("browser V2 restore desired authority is missing");
  const latestDesired = decodeEncryptedWalletBackupV2DesiredAssetRow(latestDesiredRaw);
  if (latestDesired.removalIntent !== null) {
    throw new Error("browser V2 sealed admission desired authority conflicts: removal intent");
  }
  const latestRevision = BigInt(latestDesired.custodyRevision);
  if (localRevisionOverride !== undefined && latestRevision < localRevisionOverride) {
    throw new Error("browser V2 restore desired authority conflicts");
  }
  const localRevision =
    localRevisionOverride === undefined || latestRevision > localRevisionOverride
      ? latestRevision
      : localRevisionOverride;
  const nextRevision = incrementEncryptedWalletBackupV2DesiredAssetRevision(
    localRevision > input.custodyRevision ? localRevision : input.custodyRevision,
  );
  await input.database.encryptedWalletBackupV2DesiredAssets.put(
    createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: input.scopeId,
      asset: input.asset,
      custodyRevision: nextRevision,
      activeProofCount: unionRows.length,
      terminalCtfContext: prepared.desiredRow.terminalCtfContext,
      removalIntent: null,
    }),
  );
  if (input.fault === "after-authority-before-cache") {
    throw new Error("browser V2 restore injected cache fault");
  }
  await removeMatchingStaleLegacyCacheRows(
    input.database,
    unionRows.filter(({ selectability }) => selectability === "verified-losing"),
  );
  await addProofs(
    unionRows
      .filter(({ selectability }) => selectability === "selectable" || selectability === "locked")
      .map(storedProofFromCustodyRow),
    input.database,
  );
  requireCurrent(input);
  if (input.fault === "before-commit") {
    throw new Error("browser V2 restore injected commit fault");
  }
  return true;
}

async function requireProofReconciliationFences(
  database: BitcasterDB,
  scopeId: string,
  proof: ReturnType<typeof decodeBrowserCustodyProofRow>,
  authority: ReturnType<typeof requireBrowserProofBackupAuthorityForProof> | undefined,
): Promise<void> {
  if (proof.selectability !== "selectable" || proof.reservationOperationId !== null) {
    throw new Error("browser V2 restore proof is locked or reserved");
  }
  const reservation = await database.custodyReservations.get([scopeId, proof.proofId]);
  if (reservation !== undefined) throw new Error("browser V2 restore proof reservation conflicts");
  const admissionOperationId = authority?.admissionOperationId;
  if (admissionOperationId === null || admissionOperationId === undefined) return;
  const [operationRow, activeWork] = await Promise.all([
    database.custodyOperations.get([scopeId, admissionOperationId]),
    database.custodyActiveWork.get([scopeId, admissionOperationId]),
  ]);
  if (activeWork !== undefined) {
    throw new Error("browser V2 restore local custody conflicts: unfinished custody work");
  }
  if (operationRow === undefined) return;
  if (operationRow.scopeId !== scopeId || operationRow.operationId !== admissionOperationId) {
    throw new Error("browser V2 restore local custody conflicts: creator operation is foreign");
  }
  const record = decodeDurableCustodyRecord(operationRow.record);
  if (
    record.scope.scopeId !== scopeId ||
    record.operation.operationId !== admissionOperationId ||
    operationRow.revision !== record.revision ||
    operationRow.operationState !== record.operation.state ||
    operationRow.nextAttemptAtMs !== record.operation.retry.nextAttemptAtMs ||
    !record.operation.proofStorage.lineage.successorProofIds.includes(proof.proofId) ||
    (record.operation.proofStorage.lineage.successorAdmission !== null &&
      !record.operation.proofStorage.lineage.successorAdmission.proofRows.some(
        ({ proofId }) => proofId === proof.proofId,
      ))
  ) {
    throw new Error("browser V2 restore local custody conflicts: creator operation is foreign");
  }
  if (classifyDurableCustodyActiveWork(record) !== "none") {
    throw new Error("browser V2 restore local custody conflicts: unfinished custody work");
  }
}

function sameProofMaterial(
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
    left.curve === right.curve &&
    left.dleqPresence === right.dleqPresence &&
    left.proofBody.length === right.proofBody.length &&
    left.proofBody.every((byte, index) => byte === right.proofBody[index])
  );
}

function nextProofRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error("browser V2 proof revision exceeds safe integer");
  }
  return value + 1;
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
  entries: EncryptedWalletBackupV2VerifiedProofSet["proofs"] = verified.proofs,
  activeProofCount = entries.length,
): PreparedSealedAdmission {
  const asset = decodeEncryptedWalletBackupV2AssetIdentity(input.asset);
  if (!asset.assetIdentity.startsWith("ctf:")) {
    throw new Error("browser V2 sealed admission requires a CTF asset");
  }
  if (entries.length === 0) {
    throw new Error("browser V2 sealed admission proof set is empty");
  }
  if (
    entries.some(
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
  const first = entries[0]!;
  if (first.asset.kind !== "ctf") {
    throw new Error("browser V2 sealed admission CTF asset is missing");
  }
  const context = terminalCtfContext(first.asset);
  if (`ctf:${context.conditionId}:${context.outcomeCollectionId}` !== asset.assetIdentity) {
    throw new Error("browser V2 sealed admission asset is foreign");
  }
  for (const entry of entries) {
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
    ...entries.map((entry) => requireSeal(entry.terminalSeal).classifiedAtMs),
  );
  const proofRows = entries.map((entry) => {
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
    const entry = entries[index]!;
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
    activeProofCount,
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
  authorities: readonly ReturnType<typeof requireBrowserLiveProofBackupAuthorityTableRow>[],
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
  if (desired !== null) {
    if (desired.removalIntent !== null || !sameDesiredRow(desired, prepared.desiredRow)) {
      throw new Error("browser V2 sealed admission desired authority conflicts");
    }
  }
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
  right: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow>,
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
    sameEncryptedWalletBackupV2RemovalIntent(left.removalIntent, right.removalIntent) &&
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
  input: Pick<BrowserEncryptedWalletBackupV2AdmissionInput, "asset"> & {
    readonly wallet?: CashuWallet;
  },
  verified: EncryptedWalletBackupV2VerifiedProofSet,
): void {
  if (verified.counterHighWaterMarks.some(({ keysetId }) => isBlsKeyset(keysetId))) {
    throw new Error("browser V2 restore BLS keyset is unsupported");
  }
  if (
    verified.proofs.some(({ selectionAuthority }) => selectionAuthority === "live-verified") &&
    input.wallet === undefined
  ) {
    throw new Error("browser V2 restore wallet is required for live proofs");
  }
  if (
    input.wallet !== undefined &&
    normalizeUrl(input.wallet.mint.mintUrl) !== normalizeUrl(input.asset.mintUrl)
  ) {
    throw new Error("browser V2 restore mint is foreign");
  }
}

function requireAcceptedRemoteAdmissionWallet(wallet: CashuWallet | undefined): CashuWallet {
  if (wallet === undefined) {
    throw new Error("browser V2 restore wallet is required for live proofs");
  }
  return wallet;
}

function requireAdmissionHeadBinding(
  input: Pick<
    | BrowserEncryptedWalletBackupV2AdmissionInput
    | BrowserEncryptedWalletBackupV2SealedAdmissionInput,
    "seed" | "custodyRevision" | "collectedHeadEvidence" | "realm" | "enrollmentEpoch"
  >,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
  requireEvidence = false,
): void {
  if (input.collectedHeadEvidence === undefined) {
    if (requireEvidence) {
      throw new Error("browser V2 restore current head evidence is required");
    }
    return;
  }
  if (input.realm === undefined || input.enrollmentEpoch === undefined) {
    throw new Error("browser V2 restore current head scope is incomplete");
  }
  const collected = requireEncryptedWalletBackupV2CollectedHeadEvidence(
    input.collectedHeadEvidence,
  );
  const source = requireEncryptedWalletBackupV2VerifiedProofSetSource(verified);
  const scope = browserWalletScope(input.seed);
  if (
    collected.head.walletId !== scope.walletId ||
    collected.head.realm !== input.realm ||
    collected.head.enrollmentEpoch !== input.enrollmentEpoch ||
    source.custodyRevision !== input.custodyRevision ||
    collected.bundles.filter(
      (bundle) =>
        bundle.bundleId === source.bundleId &&
        bundle.assetLocator === source.assetLocator &&
        bundle.custodyRevision === source.custodyRevision &&
        digestEncryptedWalletBackupV2BundleDescriptor(bundle) === source.descriptorDigest,
    ).length !== 1
  ) {
    throw new Error("browser V2 restore proof source is not the exact current descriptor");
  }
}

async function requireIncomingLiveAuthorities(
  database: BitcasterDB,
  scopeId: string,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
): Promise<readonly ReturnType<typeof requireBrowserLiveProofBackupAuthorityTableRow>[]> {
  const keys = verified.proofs.map(({ proofId }) => [scopeId, proofId] as [string, string]);
  const rows = await database.custodyProofBackupAuthorities.bulkGet(keys);
  return rows.map((row, index) =>
    requireBrowserLiveProofBackupAuthorityTableRow(row, keys[index]!),
  );
}

async function commitMixedAuthority(
  input: BrowserEncryptedWalletBackupV2MixedAdmissionInput,
  verified: EncryptedWalletBackupV2VerifiedProofSet,
  selectableEntries: readonly EncryptedWalletBackupV2VerifiedProofSet["proofs"][number][],
  selectableProofs: readonly StoredProof[],
  sealed: PreparedSealedAdmission,
): Promise<void> {
  requireCurrent(input);
  const first = verified.proofs[0]?.asset;
  if (first?.kind !== "ctf") throw new Error("browser V2 mixed admission CTF asset is missing");
  const classification = await classifyMixedAdmissionState(input, sealed, first);
  const hadExistingLocal = classification.kind === "active";
  const sourceOperationId =
    classification.kind === "evicted"
      ? `${input.sourceOperationId}:reimport:${localReimportId(input)}`
      : input.sourceOperationId;
  const initialDesiredRaw = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    sealed.desiredRow.localAssetKey,
  ]);
  const initialDesiredRevision =
    classification.kind !== "active" || initialDesiredRaw === undefined
      ? undefined
      : BigInt(decodeEncryptedWalletBackupV2DesiredAssetRow(initialDesiredRaw).custodyRevision);
  const localById = new Map(classification.localRows.map((row) => [row.proofId, row]));
  const liveCandidates = selectableEntries.map((entry, index) => ({
    entry,
    stored: selectableProofs[index]!,
  }));
  const liveToAdmit = [] as typeof liveCandidates;
  for (const candidate of liveCandidates) {
    const local = localById.get(candidate.entry.proofId);
    if (local === undefined) {
      liveToAdmit.push(candidate);
      continue;
    }
    const expected = decodeBrowserCustodyProofRow(
      createBrowserCustodyProofRow({
        scopeId: input.scopeId,
        normalizedMint: input.asset.mintUrl,
        unit: "msat",
        proof: candidate.stored,
        asset: {
          kind: "conditional",
          conditionId:
            candidate.entry.asset.kind === "ctf" ? candidate.entry.asset.conditionId : "",
          outcomeCollection:
            candidate.entry.asset.kind === "ctf" ? candidate.entry.asset.outcomeLabel : "",
        },
        receivedAtMs: local.receivedAtMs,
      }),
    );
    if (!sameProofMaterial(local, expected)) {
      throw new Error("browser V2 mixed admission live proof material conflicts");
    }
    if (local.selectability !== "selectable" && local.selectability !== "verified-losing") {
      throw new Error("browser V2 mixed admission live proof is locked or pending");
    }
    const authorityRow = await input.database.custodyProofBackupAuthorities.get([
      input.scopeId,
      local.proofId,
    ]);
    const authority = requireBrowserProofBackupAuthorityForProof(
      requireBrowserLiveProofBackupAuthorityTableRow(authorityRow, [input.scopeId, local.proofId]),
      local,
    );
    if (
      authority.derivationLocator === null ||
      JSON.stringify(authority.derivationLocator) !== JSON.stringify(candidate.entry.locator)
    ) {
      throw new Error("browser V2 mixed admission live authority conflicts");
    }
  }
  const reconcile = async () => {
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-state");
    await requireLiveDesiredSuccessor();
    if (!(await reconcileSealedActiveProofs(input, sealed, initialDesiredRevision))) {
      throw new Error("browser V2 mixed admission local reconciliation is incomplete");
    }
  };
  const recheckClassification = async () => {
    const current = await classifyMixedAdmissionState(input, sealed, first);
    if (
      current.kind !== classification.kind ||
      (classification.desired !== null &&
        (current.desired === null || !sameDesiredRow(current.desired, classification.desired)))
    ) {
      throw new Error("browser V2 mixed admission desired authority conflicts");
    }
    if (current.kind === "evicted") {
      await input.database.encryptedWalletBackupV2DesiredAssets.delete([
        input.scopeId,
        sealed.desiredRow.localAssetKey,
      ]);
    }
  };
  const requireLiveDesiredSuccessor = async () => {
    if (classification.kind !== "active" || classification.desired === null) return;
    if (liveToAdmit.length === 0) return;
    const expected = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: input.scopeId,
      asset: input.asset,
      custodyRevision: incrementEncryptedWalletBackupV2DesiredAssetRevision(
        BigInt(classification.desired.custodyRevision),
      ),
      activeProofCount: classification.desired.activeProofCount + liveToAdmit.length,
      terminalCtfContext: sealed.desiredRow.terminalCtfContext,
      removalIntent: null,
    });
    const raw = await input.database.encryptedWalletBackupV2DesiredAssets.get([
      input.scopeId,
      sealed.desiredRow.localAssetKey,
    ]);
    if (
      raw === undefined ||
      !sameDesiredRow(decodeEncryptedWalletBackupV2DesiredAssetRow(raw), expected)
    ) {
      throw new Error("browser V2 mixed admission desired successor conflicts");
    }
  };
  const persistFreshMixed = async () => {
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-authority");
    await input.database.custodyProofs.bulkPut(sealed.proofRows);
    await input.database.custodyProofBackupAuthorities.bulkPut(sealed.authorityRows);
    if (input.fault === "after-authority-before-cache") {
      throw new Error("browser V2 restore injected cache fault");
    }
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-counter");
    await restoreCountersInOwnedTransaction(input, verified);
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-desired-write");
    await input.database.encryptedWalletBackupV2DesiredAssets.put(sealed.desiredRow);
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-cache");
    await removeMatchingStaleLegacyCacheRows(input.database, sealed.proofRows);
    await addProofs([...selectableProofs], input.database);
    requireCurrent(input);
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-transaction-commit");
    if (input.fault === "before-commit") {
      throw new Error("browser V2 restore injected commit fault");
    }
  };
  if (liveToAdmit.length > 0) {
    const liveEntries = liveToAdmit.map(({ entry }) => entry);
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-custody");
    await admitBrowserReceivedProofsWithHeldProfileLock(
      {
        seed: input.seed,
        sourceOperationId,
        mintUrl: input.asset.mintUrl,
        unit: "msat",
        wallet: input.wallet,
        proofs: liveToAdmit.map(({ stored }) => stored),
        derivationAuthority: null,
        proofLocators: new Map(liveToAdmit.map(({ entry }) => [entry.proof.secret, entry.locator])),
        ...proofConditionalAssets(liveEntries),
        database: input.database,
      },
      {
        beforePersist: async () => {
          await requireIncomingLiveAuthorities(input.database, input.scopeId, verified);
          await recheckClassification();
        },
        afterPersist: hadExistingLocal ? reconcile : persistFreshMixed,
        legacyProofCache: {
          spentSecrets: [],
          freshProofs: liveToAdmit.map(({ stored }) => stored),
        },
      },
    );
    return;
  }
  input.setTargetedRecoveryAdmissionStage?.("backup-admit-authority");
  await new BrowserDurableCustodyAdapter(input.database).ensureScope(
    browserWalletScope(input.seed),
    sealed.observedAtMs,
  );
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
      input.database.custodyReservations,
      input.database.custodyOperations,
      input.database.custodyActiveWork,
      input.database.custodyScopes,
    ],
    async () => {
      await recheckClassification();
      await reconcile();
    },
  );
}

type MixedAdmissionStateKind = "fresh" | "evicted" | "active";

interface MixedAdmissionState {
  readonly kind: MixedAdmissionStateKind;
  readonly localRows: Awaited<
    ReturnType<typeof readBrowserEncryptedWalletBackupV2ExactLocalProofRows>
  >;
  readonly desired: ReturnType<typeof decodeEncryptedWalletBackupV2DesiredAssetRow> | null;
}

async function classifyMixedAdmissionState(
  input: BrowserEncryptedWalletBackupV2MixedAdmissionInput,
  sealed: PreparedSealedAdmission,
  ctfRoute: Extract<
    EncryptedWalletBackupV2VerifiedProofSet["proofs"][number]["asset"],
    { readonly kind: "ctf" }
  >,
): Promise<MixedAdmissionState> {
  const localRows = await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
    database: input.database,
    scopeId: input.scopeId,
    asset: input.asset,
    ctfRoute,
  });
  const rawDesired = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    sealed.desiredRow.localAssetKey,
  ]);
  if (rawDesired === undefined) {
    if (localRows.length === 0) return { kind: "fresh", localRows, desired: null };
    throw new Error("browser V2 restore local custody is untracked");
  }
  const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
  if (desired.removalIntent !== null || desired.desiredAction !== "replace") {
    throw new Error("browser V2 restore desired removal intent is active");
  }
  if (localRows.length === 0) {
    if (desired.syncState === "acknowledged" && sameDesiredRow(desired, sealed.desiredRow)) {
      return { kind: "evicted", localRows, desired };
    }
    throw new Error("browser V2 restore desired authority conflicts");
  }
  if (desired.activeProofCount !== localRows.length) {
    throw new Error("browser V2 restore desired authority conflicts");
  }
  if (
    desired.terminalCtfContext !== null &&
    !sameTerminalCtfContext(desired.terminalCtfContext, sealed.desiredRow.terminalCtfContext)
  ) {
    throw new Error("browser V2 restore desired CTF tuple conflicts");
  }
  return { kind: "active", localRows, desired };
}

function requireMixedCtfContext(
  verified: EncryptedWalletBackupV2VerifiedProofSet,
  expected: ReturnType<typeof terminalCtfContext> | null,
): void {
  const actual = verifiedTerminalCtfContext(verified);
  if (expected === null || actual === null || !sameTerminalCtfContext(expected, actual)) {
    throw new Error("browser V2 mixed admission CTF tuple conflicts");
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
  const beforePersist = async () => {
    await requireIncomingLiveAuthorities(input.database, input.scopeId, verified);
    if (start.kind === "evicted") {
      const desired = desiredRow(input, proofs.length, verifiedTerminalCtfContext(verified));
      await input.database.encryptedWalletBackupV2DesiredAssets.delete([
        input.scopeId,
        desired.localAssetKey,
      ]);
    }
  };
  const afterPersist = async () => {
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-counter");
    await restoreCountersInOwnedTransaction(input, verified);
    input.setTargetedRecoveryAdmissionStage?.("backup-admit-desired");
    const desired = desiredRow(input, proofs.length, verifiedTerminalCtfContext(verified));
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
        ...proofConditionalAssets(selected.map(({ verified: proof }) => proof)),
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
      await beforePersist();
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
  expectedDesired = desiredRow(input, verified.proofs.length, verifiedTerminalCtfContext(verified)),
): Promise<{
  readonly kind: "absent" | "evicted" | "idempotent" | "merge";
  readonly proofIdsToAdmit: ReadonlySet<string>;
}> {
  await requireIncomingLiveAuthorities(input.database, input.scopeId, verified);
  const desired = expectedDesired;
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
  if (row.removalIntent !== null) {
    throw new Error("browser V2 restore desired removal intent is active");
  }
  const currentAuthorityConflicts =
    row.custodyRevision !== desired.custodyRevision ||
    row.activeProofCount !== verified.proofs.length ||
    row.syncState !== "acknowledged" ||
    !sameOptionalTerminalCtfContext(row.terminalCtfContext, desired.terminalCtfContext);
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
    !sameOptionalTerminalCtfContext(row.terminalCtfContext, desired.terminalCtfContext) ||
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
  return rows.every((row) => {
    const entry = verified.proofs.find(({ proofId }) => proofId === row.proofId);
    return (
      entry !== undefined &&
      expected.get(row.proofId) === row.proofFingerprint &&
      row.selectability === expectedSelectability(entry.selectionAuthority) &&
      row.reservationOperationId === null
    );
  });
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
    rows.every((row) => {
      const entry = verified.proofs.find(({ proofId }) => proofId === row.proofId);
      return (
        entry !== undefined &&
        expected.get(row.proofId) === row.proofFingerprint &&
        row.selectability === expectedSelectability(entry.selectionAuthority) &&
        row.reservationOperationId === null
      );
    })
  );
}

function expectedSelectability(
  authority: EncryptedWalletBackupV2VerifiedProofSet["proofs"][number]["selectionAuthority"],
): "selectable" | "verified-losing" {
  return authority === "live-verified" ? "selectable" : "verified-losing";
}

function proofConditionalAssets(
  entries: readonly EncryptedWalletBackupV2VerifiedProofSet["proofs"][number][],
):
  | {
      readonly proofConditionalAssets: ReadonlyMap<
        string,
        Omit<
          Extract<
            EncryptedWalletBackupV2VerifiedProofSet["proofs"][number]["asset"],
            { readonly kind: "ctf" }
          >,
          "kind"
        >
      >;
    }
  | Record<string, never> {
  if (entries.every(({ asset }) => asset.kind === "ordinary")) return {};
  if (entries.some(({ asset }) => asset.kind !== "ctf")) {
    throw new Error("browser V2 restored proof asset types conflict");
  }
  return {
    proofConditionalAssets: new Map(
      entries.map((entry) => {
        if (entry.asset.kind !== "ctf") {
          throw new Error("browser V2 restored proof asset types conflict");
        }
        const { kind: _kind, ...asset } = entry.asset;
        return [entry.proof.secret, asset];
      }),
    ),
  };
}

function sameOptionalTerminalCtfContext(
  left: ReturnType<typeof terminalCtfContext> | null,
  right: ReturnType<typeof terminalCtfContext> | null,
): boolean {
  return left === null || right === null ? left === right : sameTerminalCtfContext(left, right);
}

function verifiedTerminalCtfContext(
  verified: EncryptedWalletBackupV2VerifiedProofSet,
): ReturnType<typeof terminalCtfContext> | null {
  const asset = verified.proofs[0]?.asset;
  if (asset === undefined || asset.kind === "ordinary") {
    if (verified.proofs.some((entry) => entry.asset.kind !== "ordinary")) {
      throw new Error("browser V2 restored proof asset types conflict");
    }
    return null;
  }
  const context = terminalCtfContext(asset);
  if (
    verified.proofs.some(
      (entry) =>
        entry.asset.kind !== "ctf" ||
        !sameTerminalCtfContext(context, terminalCtfContext(entry.asset)),
    )
  ) {
    throw new Error("browser V2 restored proof CTF tuple conflicts");
  }
  return context;
}

function desiredRow(
  input: BrowserEncryptedWalletBackupV2AdmissionInput,
  proofCount: number,
  ctfContext: ReturnType<typeof terminalCtfContext> | null = null,
) {
  return createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: input.scopeId,
    asset: input.asset,
    custodyRevision: input.custodyRevision,
    activeProofCount: proofCount,
    terminalCtfContext: ctfContext,
  });
}

function storedProofs(
  input: Pick<BrowserEncryptedWalletBackupV2AdmissionInput, "asset">,
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
